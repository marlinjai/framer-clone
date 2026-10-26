// src/server/catalog/repository/stock.ts
//
// Setting a variant's stock from the catalogue (the table's inline stock cell
// and the panel's variant table). Stock is never written directly: it goes
// through the engine's ledger (src/server/commerce/inventory/reserve.ts), as
// one `adjust` movement for the difference, so every change is recorded and the
// oversell guards of 001, 002 and 006 keep holding.
//
// What "set to N" means: N units AVAILABLE (stocked minus reserved), summed over
// every location of the variant's inventory item, which is what the table
// shows. The difference is booked at the default fulfillment location.
//
// In one READ COMMITTED transaction (the isolation the ledger is proven
// against): the variant must track stock and have a SKU (the ledger is keyed by
// SKU, the bridge of repository/storefront.ts); its inventory item is created
// when the SKU has none yet; the tenant group's default fulfillment location is
// created when there is none ("Main stock", registered for the engine's one
// workspace, which the checkout needs as well); its level there is created at
// zero when missing and locked, so two edits at once apply one after the other;
// then the adjust. Lowering below what open orders have reserved is refused
// (STOCK_BELOW_RESERVED), never forced.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { ProductDetail } from '@/lib/catalog/types';

import { applyInventoryEffect, DEFAULT_WORKSPACE_ID, InventoryShortageError, reserveTransaction } from '../../commerce/inventory/reserve';
import { CatalogError, invalid, withDbErrors } from '../errors';
import type { CatalogScope } from '../scope';
import { getProduct } from './products';
import type { Db } from './shared';
import { liveVariant, touchProduct } from './shared';

/** The most units one variant may hold available (an INTEGER column). */
export const MAX_STOCK = 1_000_000_000;

const stockInput = z.number().int('whole units').min(0, 'not negative').max(MAX_STOCK);

/** The default fulfillment location of the tenant group, created on first use. */
async function defaultLocation(trx: Db): Promise<string> {
  const existing = await trx
    .selectFrom('fulfillment_location_default')
    .select('location_id')
    .where('workspace_id', '=', DEFAULT_WORKSPACE_ID)
    .executeTakeFirst();
  if (existing) return existing.location_id;
  const id = randomUUID();
  const now = new Date();
  await trx.insertInto('stock_location').values({ id, name: 'Main stock', updated_at: now }).execute();
  await trx
    .insertInto('fulfillment_location_default')
    .values({ workspace_id: DEFAULT_WORKSPACE_ID, location_id: id, updated_at: now })
    .onConflict((oc) => oc.column('workspace_id').doNothing())
    .execute();
  // A concurrent first edit may have registered its own location first: use the registered one.
  const registered = await trx
    .selectFrom('fulfillment_location_default')
    .select('location_id')
    .where('workspace_id', '=', DEFAULT_WORKSPACE_ID)
    .executeTakeFirstOrThrow();
  if (registered.location_id !== id) await trx.deleteFrom('stock_location').where('id', '=', id).execute();
  return registered.location_id;
}

/** Set one variant's available stock to `available` units (see the file header). */
export async function setVariantStock(scope: CatalogScope, productId: string, variantId: string, available: number): Promise<ProductDetail> {
  const parsed = stockInput.safeParse(available);
  if (!parsed.success) throw invalid(parsed.error.issues.map((i) => ({ ...i, path: ['available'] })));
  const target = parsed.data;
  await withDbErrors(() =>
    reserveTransaction(scope.db, async (trx) => {
      const variant = await liveVariant(trx, scope, productId, variantId);
      if (!variant.manage_inventory) {
        throw new CatalogError('STOCK_NOT_TRACKED', 'this variant does not track stock; turn tracking on first', { field: 'stock' });
      }
      if (!variant.sku) {
        throw new CatalogError('SKU_REQUIRED', 'give the variant a SKU first: stock is kept per SKU', { field: 'sku' });
      }
      const now = new Date();
      let item = await trx
        .selectFrom('inventory_item')
        .select('id')
        .where('sku', '=', variant.sku)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!item) {
        item = { id: randomUUID() };
        await trx.insertInto('inventory_item').values({ id: item.id, sku: variant.sku, title: variant.title, updated_at: now }).execute();
      }
      const locationId = await defaultLocation(trx);
      await trx
        .insertInto('inventory_level')
        .values({ id: randomUUID(), inventory_item_id: item.id, location_id: locationId, updated_at: now })
        .onConflict((oc) => oc.columns(['inventory_item_id', 'location_id']).doNothing())
        .execute();
      // Lock every level of the item, in id order, so a concurrent edit waits and then sees this one.
      const levels = await trx
        .selectFrom('inventory_level')
        .select(['id', 'available_quantity'])
        .where('inventory_item_id', '=', item.id)
        .orderBy('id')
        .forUpdate()
        .execute();
      const current = levels.reduce((sum, l) => sum + Number(l.available_quantity), 0);
      const delta = target - current;
      if (delta === 0) return;
      try {
        await applyInventoryEffect(trx, scope.tgId, {
          type: 'adjust',
          inventoryItemId: item.id,
          locationId,
          delta,
          requestId: `catalog-stock:${randomUUID()}`,
          refType: 'catalog_variant',
          refId: variantId,
        });
      } catch (err) {
        if (err instanceof InventoryShortageError) {
          throw new CatalogError(
            'STOCK_BELOW_RESERVED',
            'open orders have reserved more units than this at the main location; the stock cannot go this low',
            { field: 'stock' },
            { cause: err },
          );
        }
        throw err;
      }
      await touchProduct(trx, scope, productId);
    }),
  );
  return getProduct(scope, productId);
}
