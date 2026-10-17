import 'server-only';

// src/server/commerce/repository/read.ts
//
// The READ-ONLY, RSC-callable commerce repository: the catalog READ surface the
// publish hydrator and the storefront consume. `getCommerceServerRepository(db)`
// returns an object implementing the `CommerceServerRepository` contract declared
// (type-only) in src/lib/renderer/publish/hydrateBindings.ts, so the SSR render
// layer can bake catalog reads in Node.
//
// READS ONLY by design. There is intentionally NO write / reserve / checkout
// method here: the server stays authoritative for money and stock. Every method
// is a pure read mapped INTO the client-facing DTOs (src/lib/commerce/types.ts);
// no database row type leaks past this boundary.
//
// Tenant scoping: every method takes the per-request scoped handle
// `commerceTenantDb(tgId)`, whose table identifiers tenant-db's `withSchema`
// already rewrote to `tg_<id>.<table>`. Isolation is baked into that handle, so
// there is no schema string and no search_path anywhere here.
//
// Mapping parity: the row->DTO mapping mirrors InMemoryCommerceDataSource (the
// contract reference double) field-for-field, including the conditional spreads
// for optional fields (omitted when null) and the variant taxClass fallback
// (variant.tax_class else product.tax_class), so the SSR-baked output matches
// the client storefront.
//
// Soft-deletes: catalog rows soft-delete via `deleted_at`; every read filters
// `deleted_at IS NULL` so a soft-deleted product / option / variant is invisible
// to the published site (matching the live storefront).
//
// `available_quantity` is read DIRECTLY: it is the GENERATED (stocked - reserved)
// column, so `getAvailability` SUMs it in SQL rather than recomputing in JS. It
// is NEVER written here.

import type { ExpressionBuilder, Kysely } from 'kysely';
import { jsonArrayFrom, jsonObjectFrom } from 'kysely/helpers/postgres';
import type { CommerceDB } from '../db-types';

import {
  ALL_LOCATIONS,
  type AvailabilityDTO,
  type CommerceQuery,
  type PriceDTO,
  type ProductDTO,
  type ProductOptionDTO,
  type ProductPage,
  type ProductVariantDTO,
  type VariantOptionCoordinate,
} from '@/lib/commerce/types';
// Type-only: the exact contract the publish hydrator expects. Imported (not
// re-declared) so this repo is structurally pinned to the hydrator's shape.
import type { CommerceServerRepository } from '@/lib/renderer/publish/hydrateBindings';

/**
 * Escape the LIKE/ILIKE metacharacters (`\`, `%`, `_`) in a user-supplied filter
 * value so an `eq`/`ne`/`contains` clause matches the literal text, not a
 * wildcard pattern. Postgres treats backslash as the default LIKE escape char.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Build the product WHERE expression: always `deleted_at IS NULL`, plus one
 * ANDed, case-insensitive clause per filter (multiple clauses AND together).
 * Case-insensitivity uses ILIKE on the escaped value, mirroring the in-memory
 * lowercase-both comparison: `eq` -> exact ILIKE, `ne` -> NOT ILIKE,
 * `contains` -> `%value%` ILIKE.
 */
function buildProductConditions(
  eb: ExpressionBuilder<CommerceDB, 'product'>,
  query?: CommerceQuery,
) {
  const conditions = [eb('product.deleted_at', 'is', null)];
  for (const clause of query?.filter ?? []) {
    const column = clause.field === 'handle' ? 'product.handle' : 'product.title';
    const escaped = escapeLike(clause.value);
    switch (clause.op) {
      case 'eq':
        conditions.push(eb(column, 'ilike', escaped));
        break;
      case 'ne':
        conditions.push(eb(column, 'not ilike', escaped));
        break;
      case 'contains':
        conditions.push(eb(column, 'ilike', `%${escaped}%`));
        break;
    }
  }
  return eb.and(conditions);
}

/**
 * The product graph SELECT in ONE query via `jsonArrayFrom`: live
 * (`deleted_at IS NULL`) options with their live values, plus the ids of live
 * variants. The caller adds the WHERE (filter or handle), ORDER BY, and LIMIT.
 */
function selectProductGraph(db: Kysely<CommerceDB>) {
  return db.selectFrom('product').select((eb) => [
    'product.id as id',
    'product.handle as handle',
    'product.title as title',
    'product.description as description',
    'product.tax_class as tax_class',
    jsonArrayFrom(
      eb
        .selectFrom('product_option')
        .select((innerEb) => [
          'product_option.id as id',
          'product_option.product_id as product_id',
          'product_option.title as title',
          jsonArrayFrom(
            innerEb
              .selectFrom('product_option_value')
              .select([
                'product_option_value.id as id',
                'product_option_value.option_id as option_id',
                'product_option_value.value as value',
              ])
              .whereRef('product_option_value.option_id', '=', 'product_option.id')
              .where('product_option_value.deleted_at', 'is', null),
          ).as('values'),
        ])
        .whereRef('product_option.product_id', '=', 'product.id')
        .where('product_option.deleted_at', 'is', null),
    ).as('options'),
    jsonArrayFrom(
      eb
        .selectFrom('product_variant')
        .select('product_variant.id as id')
        .whereRef('product_variant.product_id', '=', 'product.id')
        .where('product_variant.deleted_at', 'is', null),
    ).as('variants'),
  ]);
}

/** The row shape `selectProductGraph` yields (json columns parsed by the driver). */
type ProductGraphRow = {
  id: string;
  handle: string;
  title: string;
  description: string | null;
  tax_class: string | null;
  options: Array<{
    id: string;
    product_id: string;
    title: string;
    values: Array<{ id: string; option_id: string; value: string }>;
  }>;
  variants: Array<{ id: string }>;
};

function mapProductGraph(row: ProductGraphRow): ProductDTO {
  return {
    id: row.id,
    handle: row.handle,
    title: row.title,
    description: row.description,
    ...(row.tax_class !== null ? { taxClass: row.tax_class } : {}),
    options: row.options.map(
      (option): ProductOptionDTO => ({
        id: option.id,
        productId: option.product_id,
        title: option.title,
        values: option.values.map((value) => ({
          id: value.id,
          optionId: value.option_id,
          label: value.value,
        })),
      }),
    ),
    variantIds: row.variants.map((variant) => variant.id),
  };
}

/** The row shape the `listVariants` graph yields. */
type VariantGraphRow = {
  id: string;
  product_id: string;
  title: string | null;
  sku: string | null;
  barcode: string | null;
  tax_class: string | null;
  product: { tax_class: string | null } | null;
  options: Array<{
    option_id: string;
    option_value_id: string;
    option_value: { id: string; value: string } | null;
  }>;
};

function mapVariantGraph(row: VariantGraphRow): ProductVariantDTO {
  // Resolved catalog-side tax classification: the variant's own class, else the
  // product's, else unset (resolution to a rate is a downstream engine's job).
  const resolvedTaxClass = row.tax_class ?? row.product?.tax_class ?? null;
  const optionValues: VariantOptionCoordinate[] = row.options.map((option) => ({
    optionId: option.option_id,
    valueId: option.option_value_id,
    label: option.option_value?.value ?? '',
  }));
  return {
    id: row.id,
    productId: row.product_id,
    title: row.title,
    ...(row.sku !== null ? { sku: row.sku } : {}),
    ...(row.barcode !== null ? { barcode: row.barcode } : {}),
    ...(resolvedTaxClass !== null ? { taxClass: resolvedTaxClass } : {}),
    optionValues,
  };
}

function mapPriceRow(
  price: { amount: number; currency_code: string; min_quantity: number | null; max_quantity: number | null },
  variantId: string,
  taxClass: string | null,
): PriceDTO {
  return {
    variantId,
    // amount is a DB Int (integer minor units). Returned unchanged: never coerced
    // to a float.
    amountCents: price.amount,
    currency: price.currency_code,
    ...(taxClass !== null ? { taxClass } : {}),
    ...(price.min_quantity !== null ? { minQuantity: price.min_quantity } : {}),
    ...(price.max_quantity !== null ? { maxQuantity: price.max_quantity } : {}),
  };
}

/**
 * The read surface over the scoped `Kysely<CommerceDB>` handle. Each method is a
 * PURE READ returning the client-facing DTOs.
 */
export interface CommerceReadRepository {
  listProducts(db: Kysely<CommerceDB>, query?: CommerceQuery): Promise<ProductPage>;
  getProductByHandle(db: Kysely<CommerceDB>, handle: string): Promise<ProductDTO | null>;
  listVariants(db: Kysely<CommerceDB>, productId: string): Promise<ProductVariantDTO[]>;
  getPrices(db: Kysely<CommerceDB>, variantId: string): Promise<PriceDTO[]>;
  getAvailability(
    db: Kysely<CommerceDB>,
    variantId: string,
    locationId?: string,
  ): Promise<AvailabilityDTO>;
}

export const commerceReadRepository: CommerceReadRepository = {
  async listProducts(db, query) {
    // total is the count matching the filter, IGNORING the limit.
    const countRow = await db
      .selectFrom('product')
      .select((eb) => eb.fn.countAll().as('count'))
      .where((eb) => buildProductConditions(eb, query))
      .executeTakeFirstOrThrow();
    const total = Number(countRow.count);

    let listQuery = selectProductGraph(db).where((eb) => buildProductConditions(eb, query));
    for (const sort of query?.sort ?? []) {
      listQuery = listQuery.orderBy(
        sort.field === 'handle' ? 'product.handle' : 'product.title',
        sort.direction,
      );
    }
    // limit caps the returned page; a negative limit floors at 0 (in-memory parity).
    if (typeof query?.limit === 'number') {
      listQuery = listQuery.limit(Math.max(0, query.limit));
    }

    const rows = await listQuery.execute();
    return { products: rows.map(mapProductGraph), total };
  },

  async getProductByHandle(db, handle) {
    // handle is partial-unique (UNIQUE WHERE deleted_at IS NULL), so the FIRST
    // live match is correct (findFirst semantics, not findUnique).
    const row = await selectProductGraph(db)
      .where('product.handle', '=', handle)
      .where('product.deleted_at', 'is', null)
      .executeTakeFirst();
    return row ? mapProductGraph(row) : null;
  },

  async listVariants(db, productId) {
    const rows = await db
      .selectFrom('product_variant')
      .select((eb) => [
        'product_variant.id as id',
        'product_variant.product_id as product_id',
        'product_variant.title as title',
        'product_variant.sku as sku',
        'product_variant.barcode as barcode',
        'product_variant.tax_class as tax_class',
        jsonObjectFrom(
          eb
            .selectFrom('product')
            .select('product.tax_class as tax_class')
            .whereRef('product.id', '=', 'product_variant.product_id'),
        ).as('product'),
        jsonArrayFrom(
          eb
            .selectFrom('product_variant_option')
            .select((innerEb) => [
              'product_variant_option.option_id as option_id',
              'product_variant_option.option_value_id as option_value_id',
              jsonObjectFrom(
                innerEb
                  .selectFrom('product_option_value')
                  .select([
                    'product_option_value.id as id',
                    'product_option_value.value as value',
                  ])
                  .whereRef(
                    'product_option_value.id',
                    '=',
                    'product_variant_option.option_value_id',
                  ),
              ).as('option_value'),
            ])
            .whereRef('product_variant_option.variant_id', '=', 'product_variant.id'),
        ).as('options'),
      ])
      .where('product_variant.product_id', '=', productId)
      .where('product_variant.deleted_at', 'is', null)
      .execute();
    return rows.map(mapVariantGraph);
  },

  async getPrices(db, variantId) {
    // The variant (and its product) supply the resolved catalog tax classification
    // folded onto each price row, mirroring the in-memory double.
    const variant = await db
      .selectFrom('product_variant')
      .leftJoin('product', 'product.id', 'product_variant.product_id')
      .select([
        'product_variant.tax_class as variant_tax_class',
        'product.tax_class as product_tax_class',
      ])
      .where('product_variant.id', '=', variantId)
      .executeTakeFirst();
    const resolvedTaxClass = variant?.variant_tax_class ?? variant?.product_tax_class ?? null;

    // variant -> price_set -> price. A variant with no price_set has no prices.
    const prices = await db
      .selectFrom('price')
      .innerJoin('price_set', 'price_set.id', 'price.price_set_id')
      .where('price_set.variant_id', '=', variantId)
      .select([
        'price.amount as amount',
        'price.currency_code as currency_code',
        'price.min_quantity as min_quantity',
        'price.max_quantity as max_quantity',
      ])
      .execute();
    return prices.map((price) => mapPriceRow(price, variantId, resolvedTaxClass));
  },

  async getAvailability(db, variantId, locationId) {
    // A missing (or soft-deleted) variant is an error, never a silent zero-stock
    // success. The hydrator's documented per-slot swallow turns this throw into an
    // empty slot, never a failed build.
    const variant = await db
      .selectFrom('product_variant')
      .select(['product_variant.id as id', 'product_variant.sku as sku', 'product_variant.deleted_at as deleted_at'])
      .where('product_variant.id', '=', variantId)
      .executeTakeFirst();
    if (!variant || variant.deleted_at !== null) {
      throw new Error(`getAvailability: no variant with id "${variantId}"`);
    }

    const reportedLocationId = locationId === undefined ? ALL_LOCATIONS : locationId;

    // Variant -> inventory linkage is by SKU (the inventory ledger keys an
    // inventory_item on `sku`; there is intentionally NO variant_id relation). A
    // variant with no SKU, or whose SKU has no live inventory_item, holds no
    // tracked stock: advisory availability is 0 (display-only, never permission to
    // sell).
    if (!variant.sku) {
      return { variantId, locationId: reportedLocationId, availableQuantity: 0, stale: false };
    }

    const item = await db
      .selectFrom('inventory_item')
      .select('inventory_item.id as id')
      .where('inventory_item.sku', '=', variant.sku)
      .where('inventory_item.deleted_at', 'is', null)
      .executeTakeFirst();
    if (!item) {
      return { variantId, locationId: reportedLocationId, availableQuantity: 0, stale: false };
    }

    // Read the GENERATED `available_quantity` column DIRECTLY and SUM it in SQL —
    // no stocked-reserved recompute in JS. No locationId -> aggregate across EVERY
    // location; otherwise one location (a specific location with no level row
    // legitimately sums to zero). ADVISORY only.
    let levelQuery = db
      .selectFrom('inventory_level')
      .select((eb) => eb.fn.sum('inventory_level.available_quantity').as('available'))
      .where('inventory_level.inventory_item_id', '=', item.id);
    if (locationId !== undefined) {
      levelQuery = levelQuery.where('inventory_level.location_id', '=', locationId);
    }
    const aggregate = await levelQuery.executeTakeFirst();
    const availableQuantity = Number(aggregate?.available ?? 0);

    return { variantId, locationId: reportedLocationId, availableQuantity, stale: false };
  },
};

// --- the RSC-callable, tenant-scoped public repository -----------------------

/**
 * Build the read-only commerce repository the publish hydrator consumes. It
 * receives an ALREADY-scoped handle (`commerceTenantDb(tg)`, or
 * `tenantDb(getCommerceBase(), tg)`): tenant isolation is baked into `db` by
 * `withSchema`, so there is no schema string here. Each returned method
 * delegates to `commerceReadRepository` with that `db`. READS ONLY.
 */
export function getCommerceServerRepository(
  db: Kysely<CommerceDB>,
): CommerceServerRepository {
  return {
    listProducts: (query) => commerceReadRepository.listProducts(db, query),
    getProductByHandle: (handle) =>
      commerceReadRepository.getProductByHandle(db, handle),
    listVariants: (productId) => commerceReadRepository.listVariants(db, productId),
    getPrices: (variantId) => commerceReadRepository.getPrices(db, variantId),
    getAvailability: (variantId, locationId) =>
      commerceReadRepository.getAvailability(db, variantId, locationId),
  };
}
