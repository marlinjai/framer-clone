// src/server/catalog/repository/shared.ts
//
// The pieces every catalogue repository module uses: handles (unique per
// company among live rows, 020 guarantee 6), the generated SKU, the folded
// search text (src/lib/books/searchKey.ts, the fold the Books pickers match
// with), the base price of a variant (its EUR price without a price list or a
// quantity band, 004's price graph with 020's compare-at) and a variant's
// figures as the table and the panel show them (price, compare-at, available
// stock through the SKU bridge of repository/storefront.ts).

import { randomBytes, randomUUID } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';

import { foldKey } from '@/lib/books/searchKey';
import { CATALOG_CURRENCY } from '@/lib/catalog/types';

import type { CommerceDB } from '../../commerce/db-types';
import { CatalogError, notFound } from '../errors';
import type { CatalogScope } from '../scope';

export type Db = Kysely<CommerceDB> | Transaction<CommerceDB>;

/** The longest handle (020's CHECK allows 120; a suffix needs room). */
const HANDLE_BASE_MAX = 100;

/** The URL handle a title suggests: folded, letters and digits, words joined by hyphens. */
export function handleFrom(title: string): string {
  const base = foldKey(title)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, HANDLE_BASE_MAX)
    .replace(/-+$/g, '');
  return base === '' ? 'item' : base;
}

export const HANDLE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * A handle free among the company's live products (or collections): `base`, else
 * `base-2`, `base-3` and so on. Read inside the caller's transaction; the unique
 * index stays the authority (a concurrent create surfaces as DUPLICATE_HANDLE).
 */
export async function freeHandle(
  db: Db,
  scope: CatalogScope,
  table: 'product' | 'collection',
  base: string,
  excludeId?: string,
): Promise<string> {
  const pattern = `${base.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows =
    table === 'product'
      ? await db
          .selectFrom('product')
          .select(['id', 'handle'])
          .where('tenant_id', '=', scope.tenantId)
          .where('deleted_at', 'is', null)
          .where('handle', 'like', pattern)
          .execute()
      : await db
          .selectFrom('collection')
          .select(['id', 'handle'])
          .where('tenant_id', '=', scope.tenantId)
          .where('archived_at', 'is', null)
          .where('handle', 'like', pattern)
          .execute();
  const taken = new Set(rows.filter((r) => r.id !== excludeId).map((r) => r.handle));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * A SKU for a new physical variant, so its stock can be tracked from the first
 * edit (the stock ledger is keyed by SKU, unique per tenant group): the
 * product's handle in capitals, shortened, with six random hex digits that keep
 * two companies of one organisation apart.
 */
export function generatedSku(handle: string): string {
  return `${handle.slice(0, 24).replace(/-+$/g, '').toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

/** The folded text a product is found by: title, type, tags and description. */
export function productSearchText(p: { title: string; productType: string | null; tags: readonly string[]; description: string | null }): string {
  return foldKey([p.title, p.productType ?? '', p.tags.join(' '), p.description ?? ''].join(' '));
}

/** Lock the company's live product and answer its kind and handle, or NOT_FOUND (another company's id reads the same). */
export async function lockProduct(trx: Transaction<CommerceDB>, scope: CatalogScope, productId: string) {
  const row = await trx
    .selectFrom('product')
    .select(['id', 'kind', 'handle', 'title', 'archived_at'])
    .where('tenant_id', '=', scope.tenantId)
    .where('id', '=', productId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw notFound('product', productId);
  return row;
}

/** Mark the product changed (the table's "updated" sort follows every edit of its graph). */
export async function touchProduct(trx: Db, scope: CatalogScope, productId: string): Promise<void> {
  await trx
    .updateTable('product')
    .set({ updated_at: new Date() })
    .where('tenant_id', '=', scope.tenantId)
    .where('id', '=', productId)
    .execute();
}

/** The live variant of the company's product, or NOT_FOUND. */
export async function liveVariant(db: Db, scope: CatalogScope, productId: string, variantId: string) {
  const row = await db
    .selectFrom('product_variant')
    .select(['id', 'sku', 'title', 'manage_inventory', 'allow_backorder'])
    .where('tenant_id', '=', scope.tenantId)
    .where('product_id', '=', productId)
    .where('id', '=', variantId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!row) throw notFound('variant', variantId);
  return row;
}

/** Insert a variant with its price set (and its base price when given). */
export async function insertVariant(
  trx: Db,
  scope: CatalogScope,
  args: {
    productId: string;
    title: string | null;
    sku: string | null;
    manageInventory: boolean;
    allowBackorder: boolean;
    price: number | null;
    compareAt: number | null;
    createdAt?: Date;
  },
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await trx
    .insertInto('product_variant')
    .values({
      id,
      tenant_id: scope.tenantId,
      product_id: args.productId,
      title: args.title,
      sku: args.sku,
      manage_inventory: args.manageInventory,
      allow_backorder: args.allowBackorder,
      created_at: args.createdAt ?? now,
      updated_at: now,
    })
    .execute();
  const priceSetId = randomUUID();
  await trx
    .insertInto('price_set')
    .values({ id: priceSetId, tenant_id: scope.tenantId, variant_id: id, updated_at: now })
    .execute();
  if (args.price !== null) {
    await trx
      .insertInto('price')
      .values({
        id: randomUUID(),
        tenant_id: scope.tenantId,
        price_set_id: priceSetId,
        currency_code: CATALOG_CURRENCY,
        amount: args.price,
        compare_at_amount: args.compareAt,
        updated_at: now,
      })
      .execute();
  }
  return id;
}

/**
 * Set a variant's base price and compare-at price (cents; null removes the
 * price). A compare-at price needs a price; the price set is created when the
 * variant has none (a variant moved in by 020 always has one).
 */
export async function setBasePrice(
  trx: Db,
  scope: CatalogScope,
  variantId: string,
  price: number | null,
  compareAt: number | null,
): Promise<void> {
  if (price === null && compareAt !== null) {
    throw new CatalogError('INVALID_INPUT', 'INVALID_INPUT: compareAt', {
      issues: [{ path: 'compareAt', message: 'set a price before a compare-at price' }],
    });
  }
  const now = new Date();
  let set = await trx
    .selectFrom('price_set')
    .select('id')
    .where('tenant_id', '=', scope.tenantId)
    .where('variant_id', '=', variantId)
    .executeTakeFirst();
  if (!set) {
    set = { id: randomUUID() };
    await trx.insertInto('price_set').values({ id: set.id, tenant_id: scope.tenantId, variant_id: variantId, updated_at: now }).execute();
  }
  const base = await trx
    .selectFrom('price')
    .select('id')
    .where('tenant_id', '=', scope.tenantId)
    .where('price_set_id', '=', set.id)
    .where('currency_code', '=', CATALOG_CURRENCY)
    .where('price_list_id', 'is', null)
    .where('min_quantity', 'is', null)
    .where('max_quantity', 'is', null)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  if (price === null) {
    if (base.length > 0) {
      await trx.deleteFrom('price').where('tenant_id', '=', scope.tenantId).where('id', 'in', base.map((b) => b.id)).execute();
    }
    return;
  }
  const [first, ...extra] = base;
  if (first) {
    await trx
      .updateTable('price')
      .set({ amount: price, compare_at_amount: compareAt, updated_at: now })
      .where('tenant_id', '=', scope.tenantId)
      .where('id', '=', first.id)
      .execute();
    // One base price per variant: an older duplicate would make the shop's lowest-price rule disagree with the table.
    if (extra.length > 0) {
      await trx.deleteFrom('price').where('tenant_id', '=', scope.tenantId).where('id', 'in', extra.map((b) => b.id)).execute();
    }
  } else {
    await trx
      .insertInto('price')
      .values({
        id: randomUUID(),
        tenant_id: scope.tenantId,
        price_set_id: set.id,
        currency_code: CATALOG_CURRENCY,
        amount: price,
        compare_at_amount: compareAt,
        updated_at: now,
      })
      .execute();
  }
}

export interface VariantFigures {
  price: number | null;
  compareAt: number | null;
  stock: number | null;
}

/**
 * Price, compare-at and available stock of these variants. Stock is the sum of
 * `available_quantity` (stocked minus reserved) over every location of the
 * inventory item with the variant's SKU; null for a variant whose stock is not
 * tracked; 0 for a tracked one with no SKU or nothing stocked yet.
 */
export async function variantFigures(
  db: Db,
  scope: CatalogScope,
  variants: ReadonlyArray<{ id: string; sku: string | null; manage_inventory: boolean }>,
): Promise<Map<string, VariantFigures>> {
  const out = new Map<string, VariantFigures>();
  if (variants.length === 0) return out;
  const prices = await db
    .selectFrom('price')
    .innerJoin('price_set', (j) => j.onRef('price_set.id', '=', 'price.price_set_id').onRef('price_set.tenant_id', '=', 'price.tenant_id'))
    .select(['price_set.variant_id as variant_id', 'price.amount as amount', 'price.compare_at_amount as compare_at'])
    .where('price.tenant_id', '=', scope.tenantId)
    .where('price_set.variant_id', 'in', variants.map((v) => v.id))
    .where('price.currency_code', '=', CATALOG_CURRENCY)
    .where('price.price_list_id', 'is', null)
    .where('price.min_quantity', 'is', null)
    .where('price.max_quantity', 'is', null)
    .orderBy('price.created_at')
    .orderBy('price.id')
    .execute();
  const priceOf = new Map<string, { amount: number; compareAt: number | null }>();
  for (const p of prices) if (p.variant_id && !priceOf.has(p.variant_id)) priceOf.set(p.variant_id, { amount: p.amount, compareAt: p.compare_at });

  const skus = variants.filter((v) => v.manage_inventory && v.sku).map((v) => v.sku as string);
  const stockOf = new Map<string, number>();
  if (skus.length > 0) {
    const rows = await db
      .selectFrom('inventory_item')
      .leftJoin('inventory_level', 'inventory_level.inventory_item_id', 'inventory_item.id')
      .select((eb) => ['inventory_item.sku as sku', eb.fn.sum<string | number | null>('inventory_level.available_quantity').as('available')])
      .where('inventory_item.sku', 'in', skus)
      .where('inventory_item.deleted_at', 'is', null)
      .groupBy('inventory_item.sku')
      .execute();
    for (const r of rows) stockOf.set(r.sku, Number(r.available ?? 0));
  }
  for (const v of variants) {
    const p = priceOf.get(v.id);
    out.set(v.id, {
      price: p?.amount ?? null,
      compareAt: p?.compareAt ?? null,
      stock: v.manage_inventory ? (v.sku ? (stockOf.get(v.sku) ?? 0) : 0) : null,
    });
  }
  return out;
}

/** An ISO string of a timestamp column (postgres.js answers a Date; a string passes through). */
export function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
