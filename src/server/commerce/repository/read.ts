import 'server-only';

// src/server/commerce/repository/read.ts
//
// The READ-ONLY, RSC-callable commerce repository. Today the commerce module
// only has WRITE / transaction-bound repos (catalog.ts, pricing.ts, order.ts);
// this file adds the missing READ surface the publish hydrator already expects.
// `getCommerceServerRepository()` returns an object implementing the
// `CommerceServerRepository` contract declared (type-only) in
// src/lib/renderer/publish/hydrateBindings.ts, so the SSR render layer can bake
// catalog reads in Node at build time.
//
// READS ONLY by design. There is intentionally NO write / reserve / checkout
// method here: the server stays authoritative for money and stock. Every method
// is a pure read mapped INTO the client-facing DTOs (src/lib/commerce/types.ts);
// no `@prisma/client` row type ever leaks past this boundary.
//
// Tenant scoping: every public method runs its reads inside a `withTenant` block
// so the search_path is pinned to COMMERCE_SCHEMA on the connection BEFORE any
// query touches a table, exactly like the write repos. The query logic lives in
// the tx-first `commerceReadRepository` (the same tx-first shape catalog.ts /
// pricing.ts use), so it is unit-testable with a programmable fake tx; the
// public `getCommerceServerRepository()` just wraps each tx-first method in
// `withTenant`.
//
// Mapping parity: the row->DTO mapping mirrors InMemoryCommerceDataSource (the
// contract reference double) field-for-field, including the conditional spreads
// for optional fields and the variant taxClass fallback (variant.taxClass else
// product.taxClass), so the SSR-baked output matches the client storefront.
//
// Soft-deletes: catalog rows soft-delete via `deletedAt`; every read filters
// `deletedAt: null` so a soft-deleted product / option / variant is invisible to
// the published site (matching the live storefront).

import type { Prisma, Price, PrismaClient } from '@prisma/client';

// CM-07 EXPAND imports — the Kysely read path lives ALONGSIDE the Prisma path.
import type { ExpressionBuilder, Kysely } from 'kysely';
import { jsonArrayFrom, jsonObjectFrom } from 'kysely/helpers/postgres';
import type { CommerceDB } from '../db-types';

import {
  ALL_LOCATIONS,
  type AvailabilityDTO,
  type CommerceFilterClause,
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

import { getPrismaClient } from '@/server/db';
import { COMMERCE_SCHEMA, withTenant } from '../withTenant';

// --- Prisma payload types (internal; never returned) -----------------------
// These describe the shape each query loads so the mappers are typed without an
// `any`. They are confined to this module; the public surface is DTOs only.

type ProductWithGraph = Prisma.ProductGetPayload<{
  include: {
    options: { include: { values: true } };
    variants: { select: { id: true } };
  };
}>;

type VariantWithGraph = Prisma.ProductVariantGetPayload<{
  include: {
    product: { select: { taxClass: true } };
    options: { include: { optionValue: { select: { id: true; value: true } } } };
  };
}>;

// --- include / where / orderBy builders ------------------------------------

const PRODUCT_INCLUDE = {
  options: {
    where: { deletedAt: null },
    include: { values: { where: { deletedAt: null } } },
  },
  variants: { where: { deletedAt: null }, select: { id: true } },
} satisfies Prisma.ProductInclude;

const VARIANT_INCLUDE = {
  product: { select: { taxClass: true } },
  options: { include: { optionValue: { select: { id: true, value: true } } } },
} satisfies Prisma.ProductVariantInclude;

/** Map one CommerceQuery filter clause to a Prisma StringFilter. Case-insensitive
 *  to mirror InMemoryCommerceDataSource's lowercase-both comparison. */
function opFilter(clause: CommerceFilterClause): Prisma.StringFilter {
  switch (clause.op) {
    case 'eq':
      return { equals: clause.value, mode: 'insensitive' };
    case 'ne':
      return { not: clause.value, mode: 'insensitive' };
    case 'contains':
      return { contains: clause.value, mode: 'insensitive' };
    default:
      return {};
  }
}

/** Build the product WHERE: always `deletedAt: null`, plus one ANDed clause per
 *  filter (multiple clauses AND together, matching the in-memory sequential
 *  filter application). */
function buildProductWhere(query?: CommerceQuery): Prisma.ProductWhereInput {
  const clauses: Prisma.ProductWhereInput[] = (query?.filter ?? []).map((clause) => {
    const filter = opFilter(clause);
    return clause.field === 'handle' ? { handle: filter } : { title: filter };
  });
  return {
    deletedAt: null,
    ...(clauses.length > 0 ? { AND: clauses } : {}),
  };
}

/** Build the product ORDER BY from the query sort clauses (in declared order). */
function buildProductOrderBy(
  query?: CommerceQuery,
): Prisma.ProductOrderByWithRelationInput[] {
  return (query?.sort ?? []).map((sort) =>
    sort.field === 'handle' ? { handle: sort.direction } : { title: sort.direction },
  );
}

// --- row -> DTO mappers (mirror InMemoryCommerceDataSource) -----------------

function mapOption(option: ProductWithGraph['options'][number]): ProductOptionDTO {
  return {
    id: option.id,
    productId: option.productId,
    title: option.title,
    values: option.values.map((value) => ({
      id: value.id,
      optionId: value.optionId,
      label: value.value,
    })),
  };
}

function mapProduct(product: ProductWithGraph): ProductDTO {
  return {
    id: product.id,
    handle: product.handle,
    title: product.title,
    description: product.description,
    ...(product.taxClass !== null ? { taxClass: product.taxClass } : {}),
    options: product.options.map(mapOption),
    variantIds: product.variants.map((variant) => variant.id),
  };
}

function mapVariant(variant: VariantWithGraph): ProductVariantDTO {
  // Resolved catalog-side tax classification: the variant's own class, else the
  // product's, else unset (resolution to a rate is a downstream engine's job).
  const resolvedTaxClass = variant.taxClass ?? variant.product?.taxClass ?? null;
  const optionValues: VariantOptionCoordinate[] = variant.options.map((vo) => ({
    optionId: vo.optionId,
    valueId: vo.optionValueId,
    label: vo.optionValue?.value ?? '',
  }));
  return {
    id: variant.id,
    productId: variant.productId,
    title: variant.title,
    ...(variant.sku !== null ? { sku: variant.sku } : {}),
    ...(variant.barcode !== null ? { barcode: variant.barcode } : {}),
    ...(resolvedTaxClass !== null ? { taxClass: resolvedTaxClass } : {}),
    optionValues,
  };
}

function mapPrice(price: Price, variantId: string, taxClass: string | null): PriceDTO {
  return {
    variantId,
    // amount is a DB Int (integer minor units). Returned unchanged: never coerced
    // to a float.
    amountCents: price.amount,
    currency: price.currencyCode,
    ...(taxClass !== null ? { taxClass } : {}),
    ...(price.minQuantity !== null ? { minQuantity: price.minQuantity } : {}),
    ...(price.maxQuantity !== null ? { maxQuantity: price.maxQuantity } : {}),
  };
}

// --- the tx-first read repository (unit-testable with a fake tx) ------------

/**
 * The read surface over a transaction client. Every method takes `tx` first (the
 * tx-first rule the write repos follow), is a PURE READ, and returns the
 * client-facing DTOs. `getCommerceServerRepository()` wraps each method in
 * `withTenant`; tests drive these directly with a programmable fake tx.
 */
export interface CommerceReadRepository {
  listProducts(tx: Prisma.TransactionClient, query?: CommerceQuery): Promise<ProductPage>;
  getProductByHandle(
    tx: Prisma.TransactionClient,
    handle: string,
  ): Promise<ProductDTO | null>;
  listVariants(
    tx: Prisma.TransactionClient,
    productId: string,
  ): Promise<ProductVariantDTO[]>;
  getPrices(tx: Prisma.TransactionClient, variantId: string): Promise<PriceDTO[]>;
  getAvailability(
    tx: Prisma.TransactionClient,
    variantId: string,
    locationId?: string,
  ): Promise<AvailabilityDTO>;
}

export const commerceReadRepository: CommerceReadRepository = {
  async listProducts(tx, query) {
    const where = buildProductWhere(query);
    const orderBy = buildProductOrderBy(query);

    // total is the count matching the filter, IGNORING the limit.
    const total = await tx.product.count({ where });

    const rows = await tx.product.findMany({
      where,
      ...(orderBy.length > 0 ? { orderBy } : {}),
      // limit caps the returned page; a negative limit floors at 0 (in-memory parity).
      ...(typeof query?.limit === 'number'
        ? { take: Math.max(0, query.limit) }
        : {}),
      include: PRODUCT_INCLUDE,
    });

    return { products: rows.map(mapProduct), total };
  },

  async getProductByHandle(tx, handle) {
    // handle is partial-unique (UNIQUE WHERE deleted_at IS NULL), not a Prisma
    // @@unique, so findFirst (not findUnique) with the live filter is correct.
    const row = await tx.product.findFirst({
      where: { handle, deletedAt: null },
      include: PRODUCT_INCLUDE,
    });
    return row ? mapProduct(row) : null;
  },

  async listVariants(tx, productId) {
    const rows = await tx.productVariant.findMany({
      where: { productId, deletedAt: null },
      include: VARIANT_INCLUDE,
    });
    return rows.map(mapVariant);
  },

  async getPrices(tx, variantId) {
    // The variant (and its product) supply the resolved catalog tax classification
    // folded onto each price row, mirroring the in-memory double.
    const variant = await tx.productVariant.findUnique({
      where: { id: variantId },
      select: { taxClass: true, product: { select: { taxClass: true } } },
    });
    const resolvedTaxClass = variant?.taxClass ?? variant?.product?.taxClass ?? null;

    // variant -> price_set -> price. A variant with no price_set has no prices.
    const prices = await tx.price.findMany({
      where: { priceSet: { variantId } },
    });
    return prices.map((price) => mapPrice(price, variantId, resolvedTaxClass));
  },

  async getAvailability(tx, variantId, locationId) {
    // A missing (or soft-deleted) variant is an error, never a silent zero-stock
    // success. The hydrator's documented per-slot swallow turns this throw into an
    // empty slot, never a failed build.
    const variant = await tx.productVariant.findUnique({
      where: { id: variantId },
      select: { id: true, sku: true, deletedAt: true },
    });
    if (!variant || variant.deletedAt !== null) {
      throw new Error(`getAvailability: no variant with id "${variantId}"`);
    }

    const reportedLocationId = locationId === undefined ? ALL_LOCATIONS : locationId;

    // Variant -> inventory linkage is by SKU: the inventory ledger (b2) keys an
    // inventory_item on `sku`, and there is intentionally NO variant_id relation on
    // inventory_item (the order path passes inventoryItemId explicitly). A variant
    // with no SKU, or whose SKU has no live inventory_item, holds no tracked stock:
    // advisory availability is 0 (display-only, never permission to sell).
    if (!variant.sku) {
      return { variantId, locationId: reportedLocationId, availableQuantity: 0, stale: false };
    }

    const item = await tx.inventoryItem.findFirst({
      where: { sku: variant.sku, deletedAt: null },
      select: { id: true },
    });
    if (!item) {
      return { variantId, locationId: reportedLocationId, availableQuantity: 0, stale: false };
    }

    const levels = await tx.inventoryLevel.findMany({
      where: {
        inventoryItemId: item.id,
        // No locationId -> aggregate across EVERY location; otherwise one location.
        ...(locationId !== undefined ? { locationId } : {}),
      },
      select: { stockedQuantity: true, reservedQuantity: true },
    });

    // available_quantity is the GENERATED (stocked - reserved) column in Track B.
    // It is INTENTIONALLY absent from the Prisma model (Prisma cannot represent a
    // generated column; see the schema drift guard), so we compute the identical
    // value from the two source columns. Aggregated across locations when no
    // locationId is given; a specific location with no level row legitimately holds
    // zero stock. ADVISORY only.
    const availableQuantity = levels.reduce(
      (sum, level) => sum + (level.stockedQuantity - level.reservedQuantity),
      0,
    );

    return { variantId, locationId: reportedLocationId, availableQuantity, stale: false };
  },
};

// --- the RSC-callable, tenant-scoped public repository ----------------------

/**
 * Build the read-only, Prisma-backed commerce repository the publish hydrator
 * consumes. Each method opens a `withTenant` block (search_path pinned to
 * `schema` on the connection BEFORE any query runs) and delegates to the
 * tx-first `commerceReadRepository`. READS ONLY: no write / reserve / checkout.
 *
 * `schema` defaults to `COMMERCE_SCHEMA` so existing single-tenant callers are
 * unchanged. The render path (MT-13) derives the schema from the resolved site
 * (`resolveCommerceSchemaForSite`) and threads it here, so each published site's
 * commerce reads run under the schema mapped to ITS tenant rather than a pinned
 * constant. This explicit param is the SEAM the per-tenant commerce schema
 * registry (MT-18) fills; the registry/provisioning is intentionally NOT built
 * here.
 */
export function getCommerceServerRepository(
  prisma: PrismaClient = getPrismaClient(),
  schema: string = COMMERCE_SCHEMA,
): CommerceServerRepository {
  return {
    listProducts: (query) =>
      withTenant(prisma, schema, (tx) =>
        commerceReadRepository.listProducts(tx, query),
      ),
    getProductByHandle: (handle) =>
      withTenant(prisma, schema, (tx) =>
        commerceReadRepository.getProductByHandle(tx, handle),
      ),
    listVariants: (productId) =>
      withTenant(prisma, schema, (tx) =>
        commerceReadRepository.listVariants(tx, productId),
      ),
    getPrices: (variantId) =>
      withTenant(prisma, schema, (tx) =>
        commerceReadRepository.getPrices(tx, variantId),
      ),
    getAvailability: (variantId, locationId) =>
      withTenant(prisma, schema, (tx) =>
        commerceReadRepository.getAvailability(tx, variantId, locationId),
      ),
  };
}

// =============================================================================
// CM-07 EXPAND — the Kysely READ repository (NEW), added ALONGSIDE the Prisma
// `commerceReadRepository` + `getCommerceServerRepository` above. The two paths
// COEXIST through CM-12 (plan §10): the old Prisma path keeps every current
// caller — the SSR render path (`src/app/(site)/[...slug]/page.tsx`), the publish
// hydrator, the existing `read.test.ts` — compiling and serving the demo, while
// this Kysely path is "dark": wired by no caller until CM-10 flips the render
// path/routes to `getCommerceServerRepositoryDb`; CM-13 then deletes the Prisma
// path and renames the suffixed symbols to canonical. So NOTHING below changes a
// single existing signature: this is a pure ADDITION (expand-contract).
//
// Each method takes a `db: Kysely<CommerceDB>` first — the per-request scoped
// handle (`commerceTenantDb(tgId)`), whose every bare table identifier is already
// rewritten to `tg_<id>.<table>` by `withSchema`. So there is no `tx`-first rule,
// no `withTenant`, and no schema string: isolation is baked into the handle.
//
// READS ONLY, exactly like the Prisma path: pure reads mapped INTO the
// client-facing DTOs. The row->DTO mappers below reproduce the Prisma mappers'
// conditional spreads (optional fields omitted when null) and the variant
// taxClass fallback (variant.taxClass else product.taxClass) field-for-field, so
// the Kysely-baked output matches `InMemoryCommerceDataSource` exactly.
//
// `available_quantity` is read DIRECTLY: it is the GENERATED (stocked - reserved)
// column (CM-05 types it `Generated<>`), so `getAvailability` SUMs it in SQL
// rather than recomputing stocked-reserved in JS. It is NEVER written here.
// =============================================================================

/**
 * Escape the LIKE/ILIKE metacharacters (`\`, `%`, `_`) in a user-supplied filter
 * value so an `eq`/`ne`/`contains` clause matches the literal text, not a
 * wildcard pattern. Postgres treats backslash as the default LIKE escape char.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Build the product WHERE expression for the Kysely path: always
 * `deleted_at IS NULL`, plus one ANDed, case-insensitive clause per filter
 * (multiple clauses AND together). Case-insensitivity uses ILIKE on the escaped
 * value, mirroring the Prisma `mode: 'insensitive'` path and the in-memory
 * lowercase-both comparison: `eq` -> exact ILIKE, `ne` -> NOT ILIKE, `contains`
 * -> `%value%` ILIKE.
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
 * The product graph SELECT reproducing `PRODUCT_INCLUDE` in ONE query via
 * `jsonArrayFrom`: live (`deleted_at IS NULL`) options with their live values,
 * plus the ids of live variants. The caller adds the WHERE (filter or handle),
 * ORDER BY, and LIMIT.
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

/** The row shape the Kysely `listVariants` graph yields. */
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
 * The Kysely mirror of {@link CommerceReadRepository}, generic over the scoped
 * `Kysely<CommerceDB>` handle instead of a Prisma `tx`. Co-located here (NOT in
 * `repository/types.ts`) so this spec never touches the file CM-09 edits. Each
 * method is a PURE READ returning the client-facing DTOs.
 */
export interface CommerceReadRepositoryKysely {
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

export const commerceReadRepositoryKysely: CommerceReadRepositoryKysely = {
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

// --- the RSC-callable, tenant-scoped public repository (Kysely, NEW) ---------

/**
 * Build the read-only commerce repository the publish hydrator consumes, over a
 * Kysely handle. Unlike the Prisma `getCommerceServerRepository`, this receives
 * an ALREADY-scoped handle (`commerceTenantDb(tg)` / `tenantDb(getCommerceBase(),
 * tg)`): tenant isolation is baked into `db` by `withSchema`, so there is no
 * `withTenant` wrapping and no schema string. Each returned method delegates to
 * `commerceReadRepositoryKysely` with that `db`. READS ONLY.
 *
 * Carries a temporary `Db` suffix so it coexists with the Prisma
 * `getCommerceServerRepository` through CM-12. CM-10 flips the render path/routes
 * to this factory; CM-13 deletes the Prisma path and renames this to canonical.
 */
export function getCommerceServerRepositoryDb(
  db: Kysely<CommerceDB>,
): CommerceServerRepository {
  return {
    listProducts: (query) => commerceReadRepositoryKysely.listProducts(db, query),
    getProductByHandle: (handle) =>
      commerceReadRepositoryKysely.getProductByHandle(db, handle),
    listVariants: (productId) => commerceReadRepositoryKysely.listVariants(db, productId),
    getPrices: (variantId) => commerceReadRepositoryKysely.getPrices(db, variantId),
    getAvailability: (variantId, locationId) =>
      commerceReadRepositoryKysely.getAvailability(db, variantId, locationId),
  };
}
