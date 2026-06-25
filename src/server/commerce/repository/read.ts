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
 * COMMERCE_SCHEMA on the connection BEFORE any query runs) and delegates to the
 * tx-first `commerceReadRepository`. READS ONLY: no write / reserve / checkout.
 */
export function getCommerceServerRepository(
  prisma: PrismaClient = getPrismaClient(),
): CommerceServerRepository {
  return {
    listProducts: (query) =>
      withTenant(prisma, COMMERCE_SCHEMA, (tx) =>
        commerceReadRepository.listProducts(tx, query),
      ),
    getProductByHandle: (handle) =>
      withTenant(prisma, COMMERCE_SCHEMA, (tx) =>
        commerceReadRepository.getProductByHandle(tx, handle),
      ),
    listVariants: (productId) =>
      withTenant(prisma, COMMERCE_SCHEMA, (tx) =>
        commerceReadRepository.listVariants(tx, productId),
      ),
    getPrices: (variantId) =>
      withTenant(prisma, COMMERCE_SCHEMA, (tx) =>
        commerceReadRepository.getPrices(tx, variantId),
      ),
    getAvailability: (variantId, locationId) =>
      withTenant(prisma, COMMERCE_SCHEMA, (tx) =>
        commerceReadRepository.getAvailability(tx, variantId, locationId),
      ),
  };
}
