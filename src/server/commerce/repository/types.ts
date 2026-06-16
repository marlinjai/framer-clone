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

import type { Prisma } from '@prisma/client';

/**
 * Catalog reads/writes (products, variants, options): owned by b4.
 * Representative seam method; b4 widens this interface.
 */
export interface CatalogRepository {
  /** Count catalog entries visible in the current tenant schema. */
  count(tx: Prisma.TransactionClient): Promise<number>;
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
