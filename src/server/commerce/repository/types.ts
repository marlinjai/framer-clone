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
  Product,
  ProductOption,
  ProductOptionValue,
  ProductStatus,
  ProductVariant,
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

/**
 * Price + tax resolution (money in integer minor units): owned by b5.
 * Representative seam method; b5 widens this interface.
 */
export interface PricingRepository {
  /** Resolve the unit price for a SKU, in integer minor units (e.g. cents). */
  resolveUnitPriceMinor(tx: Prisma.TransactionClient, sku: string): Promise<number>;
}

/**
 * Order capture (minimal orders + line items): owned by b6.
 * Representative seam method; b6 widens this interface.
 */
export interface OrderRepository {
  /** Allocate the next monotonic order number within the current tenant schema. */
  nextOrderNumber(tx: Prisma.TransactionClient): Promise<string>;
}
