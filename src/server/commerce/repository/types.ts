import 'server-only';

// src/server/commerce/repository/types.ts
//
// Transport-agnostic repository interfaces for the four commerce concerns.
// These are the seam between the HTTP/WebSocket layer and Postgres: a route
// handler or a realtime consumer opens a `withTenant` block and hands the tx
// client to a repository. The repository knows ONLY about the transaction
// client and domain data; it has no idea whether the caller is a REST route,
// a WebSocket frame, or a background job. That is what "transport-agnostic"
// means here, and it is enforced structurally: every method's first parameter
// is `tx: Prisma.TransactionClient`. There is no PrismaClient, no Request, no
// socket anywhere in this file.
//
// Why `tx` and not a bare PrismaClient: stock movements and money MUST be
// written and read on the same connection inside the same transaction that
// `withTenant` opened (so the pinned search_path applies and so reservation /
// ledger writes are atomic). Passing the tx makes that non-negotiable: a
// repository physically cannot start its own out-of-band transaction.
//
// NO domain tables exist yet. b2 (inventory ledger), b4 (catalog), b5 (pricing
// + tax), and b6 (minimal orders) add the Prisma models AND flesh out these
// interfaces with the real method sets and row shapes. What lands here is the
// CONTRACT every later spec must honour: one representative method per concern,
// each taking the tx first, so the shape is fixed before the tables exist.
// Later specs widen these interfaces; they do not change the `tx`-first rule.

import type {
  Prisma,
  Price,
  PriceSet,
  Product,
  ProductOption,
  ProductOptionValue,
  ProductStatus,
  ProductVariant,
  Order,
  OrderLineItem,
  CustomerType,
  NetOrGross,
  OrderStatus,
  TaxTreatment,
  VariantRefSource,
} from '@prisma/client';

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

/**
 * Catalog reads/writes (products, variants, options): owned by b4. Widens the b1
 * representative seam (count) with the catalog write surface. Every method takes
 * the transaction client first (the b1 tx-first rule): the repository never opens
 * its own transaction and never touches a bare PrismaClient.
 */
export interface CatalogRepository {
  /** Count catalog entries (products) visible in the current tenant schema. */
  count(tx: Prisma.TransactionClient): Promise<number>;

  /** Create a product. */
  createProduct(tx: Prisma.TransactionClient, input: CreateProductInput): Promise<Product>;

  /** Add an option (e.g. "Color") to a product. */
  addOption(tx: Prisma.TransactionClient, input: AddOptionInput): Promise<ProductOption>;

  /** Add a value (e.g. "Red") to an option. */
  addOptionValue(
    tx: Prisma.TransactionClient,
    input: AddOptionValueInput,
  ): Promise<ProductOptionValue>;

  /** Add a variant to a product (its option_signature starts NULL). */
  addVariant(tx: Prisma.TransactionClient, input: AddVariantInput): Promise<ProductVariant>;

  /**
   * Replace a variant's option assignments (the matrix), then recompute its
   * option_signature. A wrong (option, value) pairing is rejected by the
   * composite FK; an option combination already owned by another live variant
   * is rejected by the option_signature partial-UNIQUE. Both surface as throws.
   */
  setVariantOptions(
    tx: Prisma.TransactionClient,
    variantId: string,
    assignments: VariantOptionAssignment[],
  ): Promise<void>;
}

/**
 * Inventory ledger (append-only stock movements + on-hand views): owned by b2.
 * b3 adds the guarded reservation path on top. Representative seam method;
 * b2 widens this interface.
 */
export interface InventoryRepository {
  /** Current on-hand quantity for a SKU, derived from the stock_movement ledger. */
  onHand(tx: Prisma.TransactionClient, sku: string): Promise<number>;
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
 * Price resolution (money in integer minor units): owned by b5. Widens the b1
 * representative seam with the real pricing surface. Every method takes the
 * transaction client first (the b1 tx-first rule); resolvePrice is a PURE READ
 * over tx (no React, Node-evaluable) that returns integer cents unchanged, doing
 * no float math. The catalog-side tax_class lives on Product/ProductVariant
 * (b5), read directly off those rows; the bought tax-engine resolution is E8.
 */
export interface PricingRepository {
  /** Create a price_set (optionally attached to a variant). */
  createPriceSet(tx: Prisma.TransactionClient, input: CreatePriceSetInput): Promise<PriceSet>;

  /** Add a price (integer cents) to a price_set, optionally on a price_list. */
  addPrice(tx: Prisma.TransactionClient, input: AddPriceInput): Promise<Price>;

  /**
   * Resolve the unit price for a variant in integer minor units (cents), or null
   * when no price applies. A price-list price (from an active list named in
   * priceListIds, within its window, and matching the quantity band) wins over
   * the base price; among a tier the lowest amount wins. The returned value is
   * the stored Int amount unchanged: no float math is performed.
   */
  resolvePrice(
    tx: Prisma.TransactionClient,
    variantId: string,
    options: ResolvePriceOptions,
  ): Promise<number | null>;
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

/**
 * Order capture (minimal orders + line items): owned by b6. Widens the b1
 * representative seam (nextOrderNumber) with the order/line INSERT surface and
 * the request_id idempotency re-read. Every method takes the transaction client
 * first (the b1 tx-first rule): the repository never opens its own transaction
 * and never touches a bare PrismaClient. The atomic cart -> order orchestration
 * (price resolution, tax math, stock reservation, rollback) lives in createOrder,
 * NOT here: this is the data-access seam only.
 */
export interface OrderRepository {
  /** Allocate the next monotonic order number within the current tenant schema. */
  nextOrderNumber(tx: Prisma.TransactionClient): Promise<string>;

  /** Insert the order row (all monetary fields server-computed by the caller). */
  insertOrder(tx: Prisma.TransactionClient, input: CreateOrderRowInput): Promise<Order>;

  /** Insert one snapshot line item belonging to an order. */
  insertLineItem(
    tx: Prisma.TransactionClient,
    input: CreateOrderLineItemInput,
  ): Promise<OrderLineItem>;

  /**
   * Re-read an order by its request_id (the idempotency key), or null. Used both
   * for the sequential idempotency pre-check and for the fresh-transaction
   * recovery after a concurrent UNIQUE(request_id) race.
   */
  findByRequestId(
    tx: Prisma.TransactionClient,
    requestId: string,
  ): Promise<Order | null>;
}
