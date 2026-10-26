import 'server-only';

// src/server/commerce/repository/storefront.ts
//
// The Kysely reads behind the anonymous storefront REST routes (CM-10):
// GET /api/commerce/products, GET /api/commerce/products/[handle],
// GET /api/commerce/inventory, and the variant -> inventory resolution plus the
// total read-back of POST /api/commerce/orders.
//
// Every function takes the per-request SCOPED handle first
// (`commerceTenantDb(resolveTenantGroupForSite(site))`): each bare table name on
// it resolves to `tg_<id>.<table>`, so these reads can only ever see the tenant
// group the storefront HOST resolved to. There is no schema string and no
// search_path anywhere here.
//
// Shape: the routes return the b7 REST DTOs (src/lib/commerce/dto.ts: options
// with values, variants with their (option, value) matrix and each variant's
// resolved integer-cents price). That is a different family from the seam DTOs
// the SSR read repo (read.ts) returns, so this module builds the b7 graph
// itself and hands it to the pure `toProductDTO` mapper. Prices come from the
// Kysely b5 resolver (`pricingRepository.resolvePrice`), integer cents.
//
// Soft deletes: every catalog read filters `deleted_at IS NULL` (products,
// options, values, variants, inventory items), matching the live storefront.

import type { Kysely } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';

import type { CommerceDB } from '../db-types';
import { pricingRepository } from './pricing';
import { visibleProductConditions, type CatalogueView } from './read';
import { toProductDTO, type ProductDTO, type ProductGraph } from '@/lib/commerce/dto';

/**
 * The product graph SELECT for the b7 DTO: the product plus its live options
 * (with live values) and its live variants (with their option matrix). The
 * caller adds the WHERE, ORDER BY and LIMIT.
 */
function selectStorefrontProductGraph(db: Kysely<CommerceDB>) {
  return db.selectFrom('product').select((eb) => [
    'product.id as id',
    'product.handle as handle',
    'product.title as title',
    'product.description as description',
    jsonArrayFrom(
      eb
        .selectFrom('product_option')
        .select((optionEb) => [
          'product_option.id as id',
          'product_option.title as title',
          jsonArrayFrom(
            optionEb
              .selectFrom('product_option_value')
              .select(['product_option_value.id as id', 'product_option_value.value as value'])
              .whereRef('product_option_value.option_id', '=', 'product_option.id')
              .where('product_option_value.deleted_at', 'is', null)
              .orderBy('product_option_value.id'),
          ).as('values'),
        ])
        .whereRef('product_option.product_id', '=', 'product.id')
        .where('product_option.deleted_at', 'is', null)
        .orderBy('product_option.id'),
    ).as('options'),
    jsonArrayFrom(
      eb
        .selectFrom('product_variant')
        .select((variantEb) => [
          'product_variant.id as id',
          'product_variant.title as title',
          'product_variant.sku as sku',
          'product_variant.barcode as barcode',
          jsonArrayFrom(
            variantEb
              .selectFrom('product_variant_option')
              .select([
                'product_variant_option.option_id as optionId',
                'product_variant_option.option_value_id as optionValueId',
              ])
              .whereRef('product_variant_option.variant_id', '=', 'product_variant.id')
              .orderBy('product_variant_option.option_id'),
          ).as('options'),
        ])
        .whereRef('product_variant.product_id', '=', 'product.id')
        .where('product_variant.deleted_at', 'is', null)
        .orderBy('product_variant.id'),
    ).as('variants'),
  ]);
}

/** Resolve every variant's price (integer cents, or null) and map to the DTO. */
async function toPricedProductDTO(
  db: Kysely<CommerceDB>,
  graph: ProductGraph,
  currency: string,
): Promise<ProductDTO> {
  const priceByVariant = new Map<string, number | null>();
  for (const variant of graph.variants) {
    priceByVariant.set(
      variant.id,
      await pricingRepository.resolvePrice(db, variant.id, { currency }),
    );
  }
  return toProductDTO(graph, priceByVariant);
}

export interface StorefrontProductPage {
  products: ProductDTO[];
  /** The last returned product id when another page exists, else undefined. */
  nextCursor?: string;
}

/**
 * One page of live products, ordered by id. `cursor` is the id of the last
 * product of the previous page (exclusive), so the next page starts strictly
 * after it. Takes `limit + 1` rows to learn whether another page exists without
 * a count query; the extra row is dropped and the last returned id becomes the
 * next cursor.
 */
export async function listStorefrontProducts(
  db: Kysely<CommerceDB>,
  view: CatalogueView,
  args: { limit: number; cursor?: string; currency: string },
): Promise<StorefrontProductPage> {
  let query = selectStorefrontProductGraph(db)
    .where((eb) => eb.and(visibleProductConditions(eb, view)))
    .orderBy('product.id')
    .limit(args.limit + 1);
  if (args.cursor) {
    query = query.where('product.id', '>', args.cursor);
  }
  const rows: ProductGraph[] = await query.execute();

  const hasMore = rows.length > args.limit;
  const page = hasMore ? rows.slice(0, args.limit) : rows;

  const products: ProductDTO[] = [];
  for (const row of page) {
    products.push(await toPricedProductDTO(db, row, args.currency));
  }
  const nextCursor = hasMore ? page[page.length - 1]?.id : undefined;
  return { products, ...(nextCursor ? { nextCursor } : {}) };
}

/**
 * The live product with this handle, or null. `handle` is unique only among
 * live rows (a partial-unique index), so this is a first-live-match lookup.
 */
export async function getStorefrontProductByHandle(
  db: Kysely<CommerceDB>,
  view: CatalogueView,
  handle: string,
  currency: string,
): Promise<ProductDTO | null> {
  const row: ProductGraph | undefined = await selectStorefrontProductGraph(db)
    .where('product.handle', '=', handle)
    .where((eb) => eb.and(visibleProductConditions(eb, view)))
    .executeTakeFirst();
  if (!row) return null;
  return toPricedProductDTO(db, row, currency);
}

/**
 * The GENERATED `available_quantity` (= stocked - reserved) for one
 * (inventory item, location) pair, or null when no level row exists for it.
 * ADVISORY only: never permission to sell (the guarded reserve is the authority).
 */
export async function readInventoryAvailable(
  db: Kysely<CommerceDB>,
  inventoryItemId: string,
  locationId: string,
): Promise<number | null> {
  const row = await db
    .selectFrom('inventory_level')
    .select('available_quantity')
    .where('inventory_item_id', '=', inventoryItemId)
    .where('location_id', '=', locationId)
    .executeTakeFirst();
  return row ? Number(row.available_quantity) : null;
}

/**
 * A cart line names a variant that does not exist (or is soft-deleted) in THIS
 * tenant group: a client-side problem (a stale cart, or another shop's id), not
 * a server fault. The orders route answers it with 422 `unknown_variant`.
 */
export class UnknownVariantError extends Error {
  readonly code = 'UNKNOWN_VARIANT';
  constructor(readonly variantId: string) {
    super(`unknown variant ${variantId}`);
    this.name = 'UnknownVariantError';
  }
}

/** A client order line after the server resolved its inventory identity. */
export interface ResolvedOrderLine {
  variantId: string;
  inventoryItemId: string;
  quantity: number;
}

/**
 * Resolve each client { variantId, quantity } to the inventory item the server
 * reserves against. The SKU is the v1 bridge between the catalog variant and the
 * inventory ledger (there is no FK, by design). A variant unknown to THIS tenant
 * group throws UnknownVariantError (the client's problem, a 422). A known
 * variant with no SKU or no live inventory item is a catalog misconfiguration
 * and throws a plain Error (a server fault, a logged 500), never a silent
 * zero-stock success.
 */
export async function resolveOrderLines(
  db: Kysely<CommerceDB>,
  view: CatalogueView,
  lines: ReadonlyArray<{ variantId: string; quantity: number }>,
): Promise<ResolvedOrderLine[]> {
  const resolved: ResolvedOrderLine[] = [];
  for (const line of lines) {
    // Only a live variant of a product this site shows (the company's, published, unarchived, not hidden).
    const variant = await db
      .selectFrom('product_variant')
      .innerJoin('product', (join) =>
        join
          .onRef('product.id', '=', 'product_variant.product_id')
          .onRef('product.tenant_id', '=', 'product_variant.tenant_id'),
      )
      .select(['product_variant.id as id', 'product_variant.sku as sku'])
      .where('product_variant.id', '=', line.variantId)
      .where('product_variant.deleted_at', 'is', null)
      .where((eb) => eb.and(visibleProductConditions(eb, view)))
      .executeTakeFirst();
    if (!variant) {
      throw new UnknownVariantError(line.variantId);
    }
    if (!variant.sku) {
      throw new Error(`variant ${line.variantId} has no sku; cannot resolve inventory`);
    }
    const item = await db
      .selectFrom('inventory_item')
      .select('id')
      .where('sku', '=', variant.sku)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!item) {
      throw new Error(`no inventory item for variant ${line.variantId} (sku ${variant.sku})`);
    }
    resolved.push({
      variantId: line.variantId,
      inventoryItemId: item.id,
      quantity: line.quantity,
    });
  }
  return resolved;
}

/**
 * The server-authoritative total (integer cents) and currency of a committed
 * order, or null when no such order exists in this tenant group.
 */
export async function readOrderTotal(
  db: Kysely<CommerceDB>,
  orderId: string,
): Promise<{ totalCents: number; currency: string } | null> {
  const row = await db
    .selectFrom('order')
    .select(['total', 'currency_code'])
    .where('id', '=', orderId)
    .executeTakeFirst();
  return row ? { totalCents: row.total, currency: row.currency_code } : null;
}
