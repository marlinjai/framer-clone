import 'server-only';

// src/server/commerce/order/createOrder.ts
//
// The b6 server-authoritative order WRITE: a cart payload becomes an order in ONE
// prisma.$transaction. The cart itself is client-side selection state (Track C);
// this module owns the ONE write seam where the server, not the client, is the
// sole author of money and stock.
//
// What happens inside the single transaction, in order:
//   1. sequential idempotency pre-check (re-read by the order request_id),
//   2. resolve each line's unit price via b5 resolvePrice (integer cents),
//   3. snapshot each line (variant title/sku, unit price, quantity) and compute
//      the FULL tax treatment (applied class, resolved rate, tax_amount cents,
//      treatment discriminator) per the order-level German tax model,
//   4. compute the SERVER-side integer-cents subtotal/tax/total (any client-sent
//      total is IGNORED),
//   5. insert the order + its line items,
//   6. reserve each line's stock by calling the INNER b3 reserve(tx, ...) so a
//      short-stock on ANY line rolls back the WHOLE order atomically (zero
//      reservations, zero order).
//
// Consumer contracts honored exactly (b3 + b5 reviews):
//
//   b3: we call the INNER reserve(tx, ...) (NOT reserveWithRetry, which opens its
//   OWN transaction and would not roll back with the order). A short-stock returns
//   { ok:false } from reserve; we throw an OrderShortageError to abort THIS
//   transaction so every prior line's reservation rolls back. The inner reserve
//   re-throws a DuplicateRequestError sentinel (name-tagged) out of the
//   transaction on a request_id UNIQUE (P2002) race; we replicate b3's recovery at
//   the ORDER level: roll back, then re-read and return the prior committed order
//   in a FRESH transaction keyed on the order's request_id (the naive
//   in-transaction re-read fails with Postgres 25P02).
//
//   b5: each line snapshots the FULL resolved tax treatment, not a bare rate, so a
//   reprint reproduces the legal invoice with ZERO recomputation. Money stays
//   integer cents and the b5 non-negative floor is asserted at the boundary
//   (mirrored by the b6 migration's CHECK constraints).
//
// Errors surface, never swallowed: a missing price, a non-positive quantity, or
// any non-idempotency error propagates (the transaction rolls back). A short-stock
// is the explicit { ok:false, shortages } contract, never a silent success.

import { Prisma, type PrismaClient } from '@prisma/client';

import { reserve, RESERVE_ISOLATION_LEVEL, type Shortage } from '../inventory/reserve';
import { pricingRepository } from '../repository/pricing';
import { orderRepository } from '../repository/order';
import { COMMERCE_SCHEMA } from '../withTenant';
import type { CreateOrderLineItemInput } from '../repository/types';

// CM-09 EXPAND imports — the NEW Kysely createOrder path lives ALONGSIDE the
// Prisma one below (parallel-change / expand-contract). It consumes the NEW
// Kysely pricing (CM-06) + the NEW INNER Kysely reserve (CM-08) + the NEW Kysely
// order repo (this spec); the old Prisma `createOrder` + `resolvePriorOrder` +
// `isOrderRequestIdConflict` stay byte-for-byte intact so the orders route keeps
// compiling. The pure tax functions, `validateCart`, `OrderShortageError`, and
// `isReserveDuplicate` are SHARED verbatim (DB-free), never duplicated.
import type { Kysely } from 'kysely';
import { reserveKysely } from '../inventory/reserve';
import { pricingRepositoryKysely } from '../repository/pricing';
import { orderRepositoryKysely } from '../repository/order';
import type { CommerceDB } from '../db-types';

// German VAT default rates in integer BASIS POINTS (1900 = 19.00%, 700 = 7.00%,
// 0 = zero-rated). b5 owns only the catalog-side tax_class CLASSIFICATION, not a
// rate (the bought tax engine is E8), so v1 maps a class to one of these defaults;
// a caller may override per line with an explicit taxRate.
export const STANDARD_RATE_BPS = 1900;
export const REDUCED_RATE_BPS = 700;
export const ZERO_RATE_BPS = 0;
// 100% in basis points: the upper bound on any tax rate. Mirrors the b6 migration's
// CHECK (tax_rate <= 10000) on order_line_item; an explicit rate above this is a
// programming error, surfaced loudly at the boundary (never persisted).
export const MAX_RATE_BPS = 10000;

// The legal notices set on the order when VAT is suppressed. ASCII-safe text (no
// em-dashes / en-dashes per the repo convention).
export const REVERSE_CHARGE_NOTICE =
  'Steuerschuldnerschaft des Leistungsempfaengers (Reverse-Charge-Verfahren, Section 13b UStG).';
export const KLEINUNTERNEHMER_NOTICE =
  'Gemaess Section 19 UStG wird keine Umsatzsteuer ausgewiesen (Kleinunternehmer).';

/** One cart line: the client's SELECTION intent. The server authors the rest. */
export interface CartLine {
  /** The inventory item to reserve stock against (b3). */
  inventoryItemId: string;
  /** The variant whose price is resolved via b5 resolvePrice. */
  variantId: string;
  quantity: number;
  /** Optional explicit fulfillment location; b3 resolves the default when omitted. */
  locationId?: string;
  /** Price lists to consider during resolution (b5). */
  priceListIds?: string[];
  // --- snapshot overrides (fall back to the variant row when omitted) ---
  variantTitle?: string | null;
  variantSku?: string | null;
  /** Applied catalog tax class; falls back to the variant/product tax_class. */
  taxClass?: string | null;
  /** Explicit tax rate in basis points; overrides the class-derived default. */
  taxRate?: number;
  // --- loose variant carrier (none | datatable | owned, NEVER medusa) ---
  variantRef?: string | null;
  variantRefSource?: 'none' | 'datatable' | 'owned';
}

/** The cart payload createOrder consumes. clientTotal is accepted but IGNORED. */
export interface Cart {
  /** The ORDER-level idempotency key (UNIQUE on order.request_id). */
  requestId: string;
  /** ISO-4217 alpha-3 currency, uppercase (matches the b5 currency CHECK). */
  currency: string;
  lines: CartLine[];
  taxRegion: string;
  vatId?: string | null;
  customerType?: 'b2c' | 'b2b';
  reverseCharge?: boolean;
  netOrGross?: 'net' | 'gross';
  kleinunternehmer?: boolean;
  /**
   * A client-sent total. ACCEPTED so the API shape is forgiving, but DELIBERATELY
   * IGNORED: the server computes the authoritative total from resolved prices.
   */
  clientTotal?: number;
  /** Injectable clock for deterministic price-window evaluation in tests. */
  now?: Date;
}

export type CreateOrderResult =
  | { ok: true; orderId: string }
  | { ok: false; shortages: Shortage[] };

/**
 * Thrown to abort the order transaction when a line short-stocks. Carries the
 * shortages so the outer createOrder can roll back and return the explicit
 * { ok:false, shortages } contract. Never escapes this module.
 */
export class OrderShortageError extends Error {
  readonly shortages: Shortage[];
  constructor(shortages: Shortage[]) {
    super('order short-stocked; transaction rolled back');
    this.name = 'OrderShortageError';
    this.shortages = shortages;
  }
}

function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`createOrder: ${label} must be a positive integer, got ${value}`);
  }
}

function assertNonNegativeIntCents(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `createOrder: ${label} must be a non-negative integer number of cents, got ${value}`,
    );
  }
}

/** The resolved tax treatment for one line (b5 TAX-04 full snapshot). */
export interface LineTax {
  net: number;
  tax: number;
  gross: number;
  rate: number;
  treatment: CreateOrderLineItemInput['taxTreatment'];
}

/**
 * Compute one line's net/tax/gross in integer cents plus the snapshotted rate and
 * treatment discriminator. VAT suppression (reverse_charge / kleinunternehmer)
 * forces a zero tax_amount and the matching treatment; kleinunternehmer takes
 * precedence (a small-business seller never charges VAT, regardless of the B2B
 * reverse-charge mechanism). Otherwise the rate is the explicit per-line rate, or
 * the class-derived default. All arithmetic is integer (Math.round), so no float
 * can enter the totals.
 */
export function computeLineTax(
  base: number,
  opts: {
    taxClass?: string | null;
    explicitRate?: number;
    netOrGross: 'net' | 'gross';
    reverseCharge: boolean;
    kleinunternehmer: boolean;
  },
): LineTax {
  if (opts.kleinunternehmer) {
    return { net: base, tax: 0, gross: base, rate: 0, treatment: 'kleinunternehmer' };
  }
  if (opts.reverseCharge) {
    return { net: base, tax: 0, gross: base, rate: 0, treatment: 'reverse_charge' };
  }

  const rate = resolveLineRate(opts.taxClass, opts.explicitRate);
  if (rate === ZERO_RATE_BPS) {
    return { net: base, tax: 0, gross: base, rate: 0, treatment: 'zero' };
  }

  // Derive the treatment discriminator from the RESOLVED rate, not from taxClass
  // alone: an explicit per-line rate override (e.g. 700 with a null taxClass) must
  // snapshot a CONSISTENT (rate, treatment) pair so a per-Steuersatz reprint buckets
  // it correctly. The reduced-rate bps maps to 'reduced', anything else 'standard'
  // (the zero case is already returned above).
  const treatment = treatmentForRate(rate);
  if (opts.netOrGross === 'gross') {
    // base is gross (tax-inclusive): extract the tax from within.
    const tax = Math.round((base * rate) / (10000 + rate));
    return { net: base - tax, tax, gross: base, rate, treatment };
  }
  // base is net: add the tax on top.
  const tax = Math.round((base * rate) / 10000);
  return { net: base, tax, gross: base + tax, rate, treatment };
}

/** Map an applied tax class to its default rate, or honor an explicit override. */
export function resolveLineRate(taxClass: string | null | undefined, explicitRate?: number): number {
  if (explicitRate != null) {
    assertNonNegativeIntCents(explicitRate, 'taxRate');
    // Reject an explicit rate above the basis-points ceiling (mirrors the b6
    // migration's CHECK (tax_rate <= 10000)); a rate over 100% is a bug, not data.
    if (explicitRate > MAX_RATE_BPS) {
      throw new Error(
        `createOrder: taxRate must be <= ${MAX_RATE_BPS} basis points, got ${explicitRate}`,
      );
    }
    return explicitRate;
  }
  if (taxClass === 'reduced') return REDUCED_RATE_BPS;
  if (taxClass === 'zero') return ZERO_RATE_BPS;
  return STANDARD_RATE_BPS;
}

/**
 * Map a RESOLVED non-zero rate (basis points) to its treatment discriminator. The
 * reduced-rate bps is 'reduced', everything else 'standard'. (A zero rate is the
 * 'zero' treatment, handled by the caller before this is reached.) Deriving the
 * treatment from the rate (not from taxClass) keeps the snapshotted (rate,
 * treatment) pair consistent even when an explicit per-line rate overrides the
 * class-derived default.
 */
function treatmentForRate(rate: number): CreateOrderLineItemInput['taxTreatment'] {
  if (rate === ZERO_RATE_BPS) return 'zero';
  if (rate === REDUCED_RATE_BPS) return 'reduced';
  return 'standard';
}

/** True iff the error is the b3 inner-reserve concurrent-duplicate sentinel. */
export function isReserveDuplicate(error: unknown): boolean {
  // DuplicateRequestError is not exported from reserve.ts (it never escapes the
  // module by design), so we match its name tag, which it sets explicitly.
  return error instanceof Error && error.name === 'DuplicateRequestError';
}

/** True iff the error is a UNIQUE(request_id) violation on the order row itself. */
export function isOrderRequestIdConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = error.meta?.target;
  if (typeof target === 'string') return target.includes('request_id');
  if (Array.isArray(target)) return target.some((t) => t === 'request_id' || t === 'requestId');
  return false;
}

/**
 * cart -> order in ONE prisma.$transaction. Returns { ok:true, orderId } on
 * success, or the explicit { ok:false, shortages } when any line short-stocks
 * (the whole order, and every reservation, rolls back). Idempotent on the order's
 * request_id: a duplicate returns the prior order.
 */
export async function createOrder(prisma: PrismaClient, cart: Cart): Promise<CreateOrderResult> {
  validateCart(cart);

  try {
    return await runOrderTransaction(prisma, cart);
  } catch (error) {
    if (error instanceof OrderShortageError) {
      // The transaction already rolled back (the throw aborted it); surface the
      // explicit shortage contract, never a silent success.
      return { ok: false, shortages: error.shortages };
    }
    if (isReserveDuplicate(error) || isOrderRequestIdConflict(error)) {
      // A CONCURRENT duplicate request_id lost the UNIQUE race (either on the
      // order row or on a per-line reservation). The losing transaction rolled
      // back; the winner has committed (Postgres blocks the loser's conflicting
      // insert until the winner commits). Re-read the winner in a FRESH
      // transaction (the aborted one cannot be queried, Postgres 25P02).
      return resolvePriorOrder(prisma, cart.requestId);
    }
    throw error;
  }
}

/** Open the ONE READ COMMITTED transaction (the isolation b3's proof needs). */
function runOrderTransaction(prisma: PrismaClient, cart: Cart): Promise<CreateOrderResult> {
  return prisma.$transaction(
    async (tx) => {
      // Pin the tenant schema FIRST on this connection (the withTenant seam), so
      // every query below sees the commerce schema.
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${COMMERCE_SCHEMA}"`);

      // (1) Sequential idempotency: a prior order with this request_id wins.
      const prior = await orderRepository.findByRequestId(tx, cart.requestId);
      if (prior) return { ok: true, orderId: prior.id };

      const reverseCharge = cart.reverseCharge ?? false;
      const kleinunternehmer = cart.kleinunternehmer ?? false;
      const netOrGross = cart.netOrGross ?? 'net';

      // (2) + (3): resolve prices, snapshot, and compute the per-line tax. Reads
      // only; no writes yet, so the totals are known before the order row exists.
      const lines: CreateOrderLineItemInput[] = [];
      let subtotal = 0;
      let taxAmount = 0;
      let total = 0;

      for (const line of cart.lines) {
        const unitPrice = await pricingRepository.resolvePrice(tx, line.variantId, {
          currency: cart.currency,
          priceListIds: line.priceListIds ?? [],
          quantity: line.quantity,
          now: cart.now,
        });
        if (unitPrice == null) {
          // No applicable price is an error, not a shortage: surface loudly.
          throw new Error(
            `createOrder: no price resolved for variant ${line.variantId} in ${cart.currency}`,
          );
        }
        assertNonNegativeIntCents(unitPrice, 'resolved unit price');

        // Snapshot the variant title/sku/tax_class from the catalog row unless the
        // cart overrides them (the snapshot is what a reprint reads, not the live row).
        const variant = await tx.productVariant.findUnique({
          where: { id: line.variantId },
          select: { title: true, sku: true, taxClass: true, product: { select: { taxClass: true } } },
        });
        const taxClass =
          line.taxClass ?? variant?.taxClass ?? variant?.product?.taxClass ?? null;

        const base = unitPrice * line.quantity;
        assertNonNegativeIntCents(base, 'line base amount');

        const lineTax = computeLineTax(base, {
          taxClass,
          explicitRate: line.taxRate,
          netOrGross,
          reverseCharge,
          kleinunternehmer,
        });

        lines.push({
          orderId: '', // filled after the order row is created
          variantTitle: line.variantTitle ?? variant?.title ?? null,
          variantSku: line.variantSku ?? variant?.sku ?? null,
          unitPrice,
          quantity: line.quantity,
          subtotal: lineTax.net,
          taxClass,
          taxRate: lineTax.rate,
          taxAmount: lineTax.tax,
          taxTreatment: lineTax.treatment,
          variantRef: line.variantRef ?? null,
          variantRefSource: line.variantRefSource ?? 'none',
        });

        subtotal += lineTax.net;
        taxAmount += lineTax.tax;
        total += lineTax.gross;
      }

      // (4) server-computed totals (any cart.clientTotal is ignored entirely).
      assertNonNegativeIntCents(subtotal, 'order subtotal');
      assertNonNegativeIntCents(taxAmount, 'order tax amount');
      assertNonNegativeIntCents(total, 'order total');

      const taxNote = kleinunternehmer
        ? KLEINUNTERNEHMER_NOTICE
        : reverseCharge
          ? REVERSE_CHARGE_NOTICE
          : null;

      // (5) insert the order, then its snapshot line items.
      const orderNumber = await orderRepository.nextOrderNumber(tx);
      const order = await orderRepository.insertOrder(tx, {
        orderNumber,
        requestId: cart.requestId,
        status: 'confirmed',
        currency: cart.currency,
        taxRegion: cart.taxRegion,
        vatId: cart.vatId ?? null,
        customerType: cart.customerType ?? 'b2c',
        reverseCharge,
        netOrGross,
        kleinunternehmer,
        taxNote,
        subtotal,
        taxAmount,
        total,
      });

      // (6) insert each line, then reserve its stock via the INNER b3 reserve so a
      // short-stock on ANY line aborts (and rolls back) the WHOLE transaction.
      for (let i = 0; i < lines.length; i += 1) {
        const lineItem = await orderRepository.insertLineItem(tx, {
          ...lines[i],
          orderId: order.id,
        });

        const cartLine = cart.lines[i];
        const result = await reserve(tx, {
          inventoryItemId: cartLine.inventoryItemId,
          locationId: cartLine.locationId,
          needed: cartLine.quantity,
          // Per-line request_id derived from the order key: stable across retries
          // (so a re-run is idempotent) and unique per line within the order.
          requestId: `${cart.requestId}:${i}`,
          refType: 'order_line',
          refId: lineItem.id,
        });

        if (!result.ok) {
          // Abort the transaction: throwing rolls back the order, every line, and
          // every prior reservation atomically (zero reservations on a shortage).
          throw new OrderShortageError(result.shortages);
        }
      }

      return { ok: true, orderId: order.id };
    },
    { isolationLevel: RESERVE_ISOLATION_LEVEL },
  );
}

/**
 * Re-read the prior committed order for `requestId` in a FRESH transaction and
 * return it as the idempotent success (mirrors the sequential pre-check's return).
 * If it is somehow absent, surface loudly (never a silent 500).
 */
async function resolvePriorOrder(
  prisma: PrismaClient,
  requestId: string,
): Promise<CreateOrderResult> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${COMMERCE_SCHEMA}"`);
      const prior = await orderRepository.findByRequestId(tx, requestId);
      if (!prior) {
        throw new Error(
          `createOrder: request_id ${requestId} hit a UNIQUE violation but no prior order was found`,
        );
      }
      return { ok: true, orderId: prior.id };
    },
    { isolationLevel: RESERVE_ISOLATION_LEVEL },
  );
}

/** Boundary validation: a malformed cart is a programming error, surfaced loudly. */
export function validateCart(cart: Cart): void {
  if (!cart.requestId) throw new Error('createOrder: cart.requestId is required');
  if (!cart.currency) throw new Error('createOrder: cart.currency is required');
  if (!cart.taxRegion) throw new Error('createOrder: cart.taxRegion is required');
  if (!Array.isArray(cart.lines) || cart.lines.length === 0) {
    throw new Error('createOrder: cart must have at least one line');
  }
  // Reverse-charge precondition: the Section 13b reverse-charge mechanism only
  // applies to a B2B sale to a VAT-registered recipient. reverseCharge is a bare
  // client boolean that SUPPRESSES VAT and emits the 13b notice, so without this
  // gate a {customerType:'b2c', reverseCharge:true} cart would silently yield a
  // zero-VAT B2C invoice (illegal). REJECT loudly unless the recipient is B2B with
  // a non-empty VAT id. (VIES / format validation of the vatId stays deferred to
  // E8; only the b2b + non-empty-vatId precondition is enforced now.)
  if (cart.reverseCharge) {
    if (cart.customerType !== 'b2b') {
      throw new Error(
        'createOrder: reverseCharge requires customerType "b2b" (a B2C reverse-charge invoice is illegal)',
      );
    }
    if (!cart.vatId || cart.vatId.trim() === '') {
      throw new Error(
        'createOrder: reverseCharge requires a non-empty vatId (the recipient must be VAT-registered)',
      );
    }
  }
  for (const line of cart.lines) {
    if (!line.inventoryItemId) throw new Error('createOrder: line.inventoryItemId is required');
    if (!line.variantId) throw new Error('createOrder: line.variantId is required');
    assertPositiveInt(line.quantity, 'line.quantity');
  }
}

// =============================================================================
// CM-09 EXPAND — the NEW Kysely cart -> order WRITE, ADDED ALONGSIDE the Prisma
// `createOrder` above (parallel-change / expand-contract). Everything below is
// ADDITIVE: the old `createOrder`/`runOrderTransaction`/`resolvePriorOrder`/
// `isOrderRequestIdConflict` and the pure tax/validation helpers are untouched,
// so the orders route (CM-10) keeps compiling on the Prisma path and the verify
// gate stays green. This Kysely path is "dark" until CM-10 flips the route to it;
// CM-13 deletes the Prisma path and renames `createOrderKysely` -> `createOrder`.
//
// It mirrors the Prisma transaction STEP-FOR-STEP, but:
//   - opens a Kysely transaction at READ COMMITTED (the only isolation the b3
//     guarded decrement is proven against) with NO `SET LOCAL search_path`: the
//     scoped `trx` is already schema-qualified (it inherits `withSchema` from
//     `commerceTenantDb(tgId)`), so structured queries resolve to `tg_<id>` and
//     the only raw fragment (the order_number_seq read) qualifies via
//     `tenantSchema(tgId)` inside the repo;
//   - resolves each line's price through the NEW Kysely pricing (CM-06) and
//     reserves through the NEW INNER `reserveKysely(trx, tgId, ...)` (CM-08) — NOT
//     the *WithRetry entrypoint — so a shortage on ANY line throws and rolls back
//     the WHOLE order (zero reservations, zero order);
//   - re-detects the order-level UNIQUE(request_id) race on the postgres.js
//     SQLSTATE `23505` + `constraint_name` (the Prisma error classes are gone on
//     this path), via `isOrderRequestIdConflictPg`.
//
// Money stays server-authoritative integer cents (any cart.clientTotal ignored);
// the accounting identity total = subtotal + tax_amount holds structurally (each
// line's gross == net + tax in computeLineTax, and the order sums net->subtotal,
// tax->tax_amount, gross->total), so the DB `order_total_sum_check` never trips on
// a real order.
// =============================================================================

/**
 * True iff `error` is a postgres.js unique-violation (SQLSTATE 23505) on the
 * order's UNIQUE(request_id) index (`order_request_id_key`). kysely-postgres-js
 * rethrows the raw postgres.js `PostgresError`, which carries `.code` ('23505')
 * and `.constraint_name` (the violated index). Matching the EXACT constraint name
 * is load-bearing: a miss would treat a duplicate order as a fresh failure (a
 * CRITICAL risk per the plan), and ANY OTHER 23505 (e.g. the order_number unique,
 * a real bug) MUST propagate unchanged — it is never swallowed. (Lives alongside
 * the Prisma `isOrderRequestIdConflict`; that one is untouched.)
 */
export function isOrderRequestIdConflictPg(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; constraint_name?: unknown };
  if (e.code !== '23505') return false;
  const name = e.constraint_name;
  if (typeof name !== 'string') return false;
  return name === 'order_request_id_key' || name.includes('request_id');
}

/**
 * cart -> order in ONE Kysely transaction on the scoped `db` (NEW path). Mirrors
 * {@link createOrder}: returns { ok:true, orderId } on success, the explicit
 * { ok:false, shortages } when any line short-stocks (the whole order rolls back),
 * and is idempotent on the order's request_id (a duplicate returns the prior
 * order). `tgId` is threaded through for the per-tenant order_number_seq read and
 * the inner reserve's raw guarded UPDATE.
 */
export async function createOrderKysely(
  db: Kysely<CommerceDB>,
  tgId: string,
  cart: Cart,
): Promise<CreateOrderResult> {
  validateCart(cart);

  try {
    return await runOrderTransactionKysely(db, tgId, cart);
  } catch (error) {
    if (error instanceof OrderShortageError) {
      // The transaction already rolled back (the throw aborted it); surface the
      // explicit shortage contract, never a silent success.
      return { ok: false, shortages: error.shortages };
    }
    if (isReserveDuplicate(error) || isOrderRequestIdConflictPg(error)) {
      // A CONCURRENT duplicate request_id lost the UNIQUE race (on the order row,
      // or on a per-line reservation via the inner reserve's name-tagged
      // DuplicateRequestError). The loser rolled back; the winner committed. Re-read
      // the winner in a FRESH transaction (the aborted one cannot be queried).
      return resolvePriorOrderKysely(db, cart.requestId);
    }
    throw error;
  }
}

/** Open the ONE READ COMMITTED Kysely transaction (the isolation b3 proves). */
function runOrderTransactionKysely(
  db: Kysely<CommerceDB>,
  tgId: string,
  cart: Cart,
): Promise<CreateOrderResult> {
  return db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (trx) => {
      // NO `SET LOCAL search_path`: `trx` is already schema-qualified (it inherits
      // withSchema from commerceTenantDb(tgId)).

      // (1) Sequential idempotency: a prior order with this request_id wins.
      const prior = await orderRepositoryKysely.findByRequestId(trx, cart.requestId);
      if (prior) return { ok: true, orderId: prior.id };

      const reverseCharge = cart.reverseCharge ?? false;
      const kleinunternehmer = cart.kleinunternehmer ?? false;
      const netOrGross = cart.netOrGross ?? 'net';

      // (2) + (3): resolve prices, snapshot the variant, compute per-line tax.
      // Reads only; no writes yet, so the totals are known before the order exists.
      const lines: CreateOrderLineItemInput[] = [];
      let subtotal = 0;
      let taxAmount = 0;
      let total = 0;

      for (const line of cart.lines) {
        const unitPrice = await pricingRepositoryKysely.resolvePrice(trx, line.variantId, {
          currency: cart.currency,
          priceListIds: line.priceListIds ?? [],
          quantity: line.quantity,
          now: cart.now,
        });
        if (unitPrice == null) {
          // No applicable price is an error, not a shortage: surface loudly.
          throw new Error(
            `createOrderKysely: no price resolved for variant ${line.variantId} in ${cart.currency}`,
          );
        }
        assertNonNegativeIntCents(unitPrice, 'resolved unit price');

        // Snapshot the variant title/sku/tax_class via an INLINE tx read (variant
        // row + product.tax_class fallback). This is a transaction-scoped read, NOT
        // routed through the CM-07 read repo. No deleted_at filter: the snapshot is
        // what a reprint reads, mirroring the Prisma findUnique exactly.
        const variant = await trx
          .selectFrom('product_variant')
          .leftJoin('product', 'product.id', 'product_variant.product_id')
          .select([
            'product_variant.title as title',
            'product_variant.sku as sku',
            'product_variant.tax_class as variantTaxClass',
            'product.tax_class as productTaxClass',
          ])
          .where('product_variant.id', '=', line.variantId)
          .executeTakeFirst();
        const taxClass =
          line.taxClass ?? variant?.variantTaxClass ?? variant?.productTaxClass ?? null;

        const base = unitPrice * line.quantity;
        assertNonNegativeIntCents(base, 'line base amount');

        const lineTax = computeLineTax(base, {
          taxClass,
          explicitRate: line.taxRate,
          netOrGross,
          reverseCharge,
          kleinunternehmer,
        });

        lines.push({
          orderId: '', // filled after the order row is created
          variantTitle: line.variantTitle ?? variant?.title ?? null,
          variantSku: line.variantSku ?? variant?.sku ?? null,
          unitPrice,
          quantity: line.quantity,
          subtotal: lineTax.net,
          taxClass,
          taxRate: lineTax.rate,
          taxAmount: lineTax.tax,
          taxTreatment: lineTax.treatment,
          variantRef: line.variantRef ?? null,
          variantRefSource: line.variantRefSource ?? 'none',
        });

        subtotal += lineTax.net;
        taxAmount += lineTax.tax;
        total += lineTax.gross;
      }

      // (4) server-computed totals (any cart.clientTotal is ignored entirely).
      assertNonNegativeIntCents(subtotal, 'order subtotal');
      assertNonNegativeIntCents(taxAmount, 'order tax amount');
      assertNonNegativeIntCents(total, 'order total');

      const taxNote = kleinunternehmer
        ? KLEINUNTERNEHMER_NOTICE
        : reverseCharge
          ? REVERSE_CHARGE_NOTICE
          : null;

      // (5) insert the order, then its snapshot line items.
      const orderNumber = await orderRepositoryKysely.nextOrderNumber(trx, tgId);
      const order = await orderRepositoryKysely.insertOrder(trx, {
        orderNumber,
        requestId: cart.requestId,
        status: 'confirmed',
        currency: cart.currency,
        taxRegion: cart.taxRegion,
        vatId: cart.vatId ?? null,
        customerType: cart.customerType ?? 'b2c',
        reverseCharge,
        netOrGross,
        kleinunternehmer,
        taxNote,
        subtotal,
        taxAmount,
        total,
      });

      // (6) insert each line, then reserve its stock via the INNER Kysely reserve
      // so a short-stock on ANY line aborts (and rolls back) the WHOLE transaction.
      // A backorder line (manage_inventory=true, allow_backorder=true) returns ok
      // even at negative availability, so it does NOT roll the order back.
      for (let i = 0; i < lines.length; i += 1) {
        const lineItem = await orderRepositoryKysely.insertLineItem(trx, {
          ...lines[i],
          orderId: order.id,
        });

        const cartLine = cart.lines[i];
        const result = await reserveKysely(trx, tgId, {
          inventoryItemId: cartLine.inventoryItemId,
          variantId: cartLine.variantId,
          locationId: cartLine.locationId,
          needed: cartLine.quantity,
          // Per-line request_id derived from the order key: stable across retries
          // (so a re-run is idempotent) and unique per line within the order.
          requestId: `${cart.requestId}:${i}`,
          refType: 'order_line',
          refId: lineItem.id,
        });

        if (!result.ok) {
          // Abort: throwing rolls back the order, every line, and every prior
          // reservation atomically (zero reservations on a shortage).
          throw new OrderShortageError(result.shortages);
        }
      }

      return { ok: true, orderId: order.id };
    });
}

/**
 * Re-read the prior committed order for `requestId` in a FRESH READ COMMITTED
 * Kysely transaction (NO `SET LOCAL`) and return it as the idempotent success.
 * If it is somehow absent, surface loudly (never a silent 500). Mirrors the Prisma
 * {@link resolvePriorOrder}.
 */
function resolvePriorOrderKysely(
  db: Kysely<CommerceDB>,
  requestId: string,
): Promise<CreateOrderResult> {
  return db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (trx) => {
      const prior = await orderRepositoryKysely.findByRequestId(trx, requestId);
      if (!prior) {
        throw new Error(
          `createOrderKysely: request_id ${requestId} hit a UNIQUE violation but no prior order was found`,
        );
      }
      return { ok: true, orderId: prior.id };
    });
}
