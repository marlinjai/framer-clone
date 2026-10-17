import 'server-only';

// src/server/commerce/repository/types.ts
//
// Transport-agnostic repository contracts for the commerce data layer. These
// are the seam between the HTTP layer and Postgres: a route handler resolves the
// company's tenant group, takes the scoped Kysely handle `commerceTenantDb(tgId)`
// (../db.ts) and hands it to a repository. The repository knows ONLY that handle
// and domain data; it has no idea whether the caller is a REST route, a seed
// script or a test. Every method takes `db: Kysely<CommerceDB>` first.
//
// Isolation is baked into the handle: tenant-db's `withSchema` rewrites every
// structured table reference to `tg_<hex32>.<table>`, so a repository cannot name
// another company's schema. A raw `sql` fragment must qualify tenant tables with
// `tenantSchemaRef(tgId)` (CI guard G3, `pnpm lint:guards`).
//
// Atomicity: a caller that needs several writes to commit together (an order and
// its reservations) opens ONE `db.transaction()` and passes the transaction
// handle in; repositories never open an out-of-band transaction of their own
// (setVariantOptions opens one only to make its clear-then-insert atomic).

import type { Kysely, Selectable } from 'kysely';
import type {
  CommerceDB,
  CustomerType,
  NetOrGross,
  OrderLineItemTable,
  OrderStatus,
  OrderTable,
  PriceSetTable,
  PriceTable,
  ProductOptionTable,
  ProductOptionValueTable,
  ProductStatus,
  ProductTable,
  ProductVariantTable,
  TaxTreatment,
  VariantRefSource,
} from '../db-types';

/** Create-a-product input. status defaults to 'draft' when omitted. */
export interface CreateProductInput {
  title: string;
  handle: string;
  description?: string | null;
  status?: ProductStatus;
}

/** Add-an-option input (an option belongs to a product, e.g. "Color"). */
export interface AddOptionInput {
  productId: string;
  title: string;
}

/** Add-an-option-value input (a value belongs to an option, e.g. "Red"). */
export interface AddOptionValueInput {
  optionId: string;
  value: string;
}

/** Add-a-variant input. The option_signature is computed by the DB trigger. */
export interface AddVariantInput {
  productId: string;
  title?: string | null;
  sku?: string | null;
  barcode?: string | null;
}

/**
 * One (option, option_value) assignment for a variant. The composite FK rejects
 * an optionValueId that does not belong to optionId, so a wrong pairing throws.
 */
export interface VariantOptionAssignment {
  optionId: string;
  optionValueId: string;
}

/** Create-a-price-set input. variantId attaches the set to a variant (one per variant). */
export interface CreatePriceSetInput {
  variantId?: string | null;
}

/**
 * Add-a-price input. amount is integer minor units (cents): an Int, NEVER a
 * float. priceListId NULL means the base price; min/max quantity scope the price
 * to a quantity band (NULL = unbounded on that side).
 */
export interface AddPriceInput {
  priceSetId: string;
  currency: string;
  /** Integer minor units (cents). Must be an integer; floats are rejected. */
  amount: number;
  priceListId?: string | null;
  minQuantity?: number | null;
  maxQuantity?: number | null;
}

/**
 * Options for resolvePrice. currency is required; priceListIds names the price
 * lists the caller wants considered (an active list within its window wins over
 * the base price); quantity defaults to 1; `now` is injectable for deterministic
 * window evaluation in tests (defaults to the current time).
 */
export interface ResolvePriceOptions {
  currency: string;
  priceListIds?: string[];
  quantity?: number;
  now?: Date;
}

/**
 * The order row to INSERT. All monetary fields are integer cents and are
 * SERVER-COMPUTED by createOrder (never client-trusted); the repository is a thin
 * data-access seam that does no money math. order_number is allocated via
 * nextOrderNumber; request_id is the order-level idempotency key.
 */
export interface CreateOrderRowInput {
  orderNumber: string;
  requestId: string;
  status?: OrderStatus;
  currency: string;
  taxRegion: string;
  vatId?: string | null;
  customerType: CustomerType;
  reverseCharge: boolean;
  netOrGross: NetOrGross;
  kleinunternehmer: boolean;
  taxNote?: string | null;
  subtotal: number;
  taxAmount: number;
  total: number;
}

/**
 * One order line to INSERT: the SNAPSHOT of the variant at creation (title/sku,
 * resolved unit_price cents, quantity) plus the FULL tax treatment snapshot
 * (applied tax_class, resolved rate in basis points, tax_amount cents, treatment
 * discriminator) and the loose variant carrier (none | datatable | owned).
 */
export interface CreateOrderLineItemInput {
  orderId: string;
  variantTitle?: string | null;
  variantSku?: string | null;
  unitPrice: number;
  quantity: number;
  subtotal: number;
  taxClass?: string | null;
  taxRate: number;
  taxAmount: number;
  taxTreatment: TaxTreatment;
  variantRef?: string | null;
  variantRefSource: VariantRefSource;
}

/** RETURNING / SELECT projections the repositories return (CommerceDB rows). */
export type CatalogProductRow = Selectable<ProductTable>;
export type CatalogOptionRow = Selectable<ProductOptionTable>;
export type CatalogOptionValueRow = Selectable<ProductOptionValueTable>;
export type CatalogVariantRow = Selectable<ProductVariantTable>;
export type PricingPriceSetRow = Selectable<PriceSetTable>;
export type PricingPriceRow = Selectable<PriceTable>;
export type OrderRow = Selectable<OrderTable>;
export type OrderLineItemRow = Selectable<OrderLineItemTable>;

/**
 * Catalog writes (products, options, values, variants and the variant/option
 * matrix). The composite FK and the option_signature triggers in the tenant
 * schema stay authoritative; nothing is re-checked in JS.
 */
export interface CatalogRepository {
  /** Count catalog entries (products) visible in the scoped tenant schema. */
  count(db: Kysely<CommerceDB>): Promise<number>;

  /** Create a product (status defaults to 'draft' at the DB when omitted). */
  createProduct(db: Kysely<CommerceDB>, input: CreateProductInput): Promise<CatalogProductRow>;

  /** Add an option (e.g. "Color") to a product. */
  addOption(db: Kysely<CommerceDB>, input: AddOptionInput): Promise<CatalogOptionRow>;

  /** Add a value (e.g. "Red") to an option. */
  addOptionValue(
    db: Kysely<CommerceDB>,
    input: AddOptionValueInput,
  ): Promise<CatalogOptionValueRow>;

  /** Add a variant to a product (its option_signature starts NULL, trigger-set). */
  addVariant(db: Kysely<CommerceDB>, input: AddVariantInput): Promise<CatalogVariantRow>;

  /**
   * Replace a variant's option assignments (the matrix). The composite FK rejects
   * a wrong (option, value) pairing; the option_signature partial-UNIQUE rejects a
   * combination already owned by another live variant. Both surface as throws and
   * roll back the wrapping transaction.
   */
  setVariantOptions(
    db: Kysely<CommerceDB>,
    variantId: string,
    assignments: VariantOptionAssignment[],
  ): Promise<void>;
}

/**
 * Price resolution and price writes, money in integer minor units (cents).
 * resolvePrice is a pure read that returns the stored Int unchanged.
 */
export interface PricingRepository {
  /** Create a price_set (optionally attached to a variant). */
  createPriceSet(db: Kysely<CommerceDB>, input: CreatePriceSetInput): Promise<PricingPriceSetRow>;

  /** Add a price (integer cents) to a price_set, optionally on a price_list. */
  addPrice(db: Kysely<CommerceDB>, input: AddPriceInput): Promise<PricingPriceRow>;

  /**
   * Resolve the unit price for a variant in integer minor units (cents), or null
   * when no price applies. A price-list price (active, in its window, matching the
   * quantity band, named in priceListIds) wins over the base price; within a tier
   * the LOWEST integer amount wins. No float math.
   */
  resolvePrice(
    db: Kysely<CommerceDB>,
    variantId: string,
    options: ResolvePriceOptions,
  ): Promise<number | null>;
}

/**
 * Order capture data access (order + line items + the request_id idempotency
 * re-read). The atomic cart to order orchestration (price resolution, tax math,
 * stock reservation, rollback) lives in ../order/createOrder.ts, not here.
 */
export interface OrderRepository {
  /** Allocate the next monotonic order number within the tenant's schema. */
  nextOrderNumber(db: Kysely<CommerceDB>, tgId: string): Promise<string>;

  /** Insert the order row (all monetary fields server-computed by the caller). */
  insertOrder(db: Kysely<CommerceDB>, input: CreateOrderRowInput): Promise<OrderRow>;

  /** Insert one snapshot line item belonging to an order. */
  insertLineItem(db: Kysely<CommerceDB>, input: CreateOrderLineItemInput): Promise<OrderLineItemRow>;

  /** Re-read an order by its request_id (the idempotency key), or undefined. */
  findByRequestId(db: Kysely<CommerceDB>, requestId: string): Promise<OrderRow | undefined>;
}
