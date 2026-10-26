import 'server-only';

// src/server/commerce/order/createOrder.ts
//
// The server-authoritative order WRITE: a cart payload becomes an order in ONE
// READ COMMITTED Kysely transaction on the company's scoped handle
// (`commerceTenantDb(tgId)`). The cart itself is client-side selection state;
// this module owns the ONE write seam where the server, not the client, is the
// sole author of money and stock.
//
// What happens inside the single transaction, in order:
//   1. sequential idempotency pre-check (re-read by the order request_id),
//   2. resolve each line's unit price via pricingRepository.resolvePrice
//      (integer cents),
//   3. snapshot each line (variant title/sku, unit price, quantity) and compute
//      the FULL tax treatment (applied class, resolved rate, tax_amount cents,
//      treatment discriminator) per the order-level German tax model,
//   4. compute the SERVER-side integer-cents subtotal/tax/total (any client-sent
//      total is IGNORED),
//   5. insert the order + its line items (the order number comes from the
//      company's own `order_number_seq`),
//   6. reserve each line's stock by calling the INNER reserve(trx, tgId, ...) so
//      a short-stock on ANY line rolls back the WHOLE order atomically (zero
//      reservations, zero order).
//
// Consumer contracts honored exactly:
//
//   reserve: we call the INNER reserve(trx, ...) (NOT reserveWithRetry, which
//   opens its OWN transaction and would not roll back with the order). A
//   short-stock returns { ok:false } from reserve; we throw an OrderShortageError
//   to abort THIS transaction so every prior line's reservation rolls back. The
//   inner reserve re-throws a DuplicateRequestError sentinel (name-tagged) out of
//   the transaction on a request_id UNIQUE (SQLSTATE 23505) race; we replicate
//   its recovery at the ORDER level: roll back, then re-read and return the prior
//   committed order in a FRESH transaction keyed on the order's request_id (the
//   naive in-transaction re-read fails with Postgres 25P02).
//
//   pricing / tax: each line snapshots the FULL resolved tax treatment, not a
//   bare rate, so a reprint reproduces the legal invoice with ZERO recomputation.
//   Money stays integer cents and the non-negative floor is asserted at the
//   boundary (mirrored by the CHECK constraints of migration 005_minimal_orders,
//   including the accounting identity total = subtotal + tax_amount).
//
// Errors surface, never swallowed: a missing price, a non-positive quantity, or
// any non-idempotency error propagates (the transaction rolls back). A short-stock
// is the explicit { ok:false, shortages } contract, never a silent success.

import type { Kysely } from 'kysely';

import { RESERVE_ISOLATION_LEVEL, reserve, type Shortage } from '../inventory/reserve';
import { pricingRepository } from '../repository/pricing';
import { orderRepository } from '../repository/order';
import { UnknownVariantError } from '../repository/storefront';
import { toJsonb } from '../../books/snapshots';
import type { Buyer } from '../payment/buyer';
import { PAYMENT_WINDOW_MS, platformFee } from '../payment/payments';
import type { ProviderId } from '../payment/provider';
import type { CreateOrderLineItemInput } from '../repository/types';
import type { CommerceDB } from '../db-types';
import {
  assertReverseChargeAllowed,
  computeLineTax,
  KLEINUNTERNEHMER_NOTICE,
  REVERSE_CHARGE_NOTICE,
} from '../../tax/germanVat';

// The German VAT rules (rates, notices, per-line tax, the reverse-charge
// precondition) live in the shared module src/server/tax/germanVat.ts, which the
// Books domain uses too. They are re-exported here so every existing importer of
// this module keeps working unchanged.
export {
  STANDARD_RATE_BPS,
  REDUCED_RATE_BPS,
  ZERO_RATE_BPS,
  MAX_RATE_BPS,
  REVERSE_CHARGE_NOTICE,
  KLEINUNTERNEHMER_NOTICE,
  computeLineTax,
  resolveLineRate,
  type LineTax,
} from '../../tax/germanVat';

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
  /**
   * The selling company (the site's company, 020_catalogue_company). Every line's variant must belong to it:
   * a variant of another company of the tenant group is refused as unknown (UnknownVariantError, a 422).
   */
  tenantId: string;
  /** The site the order is placed on (stored on the order). */
  siteId?: string | null;
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
  /**
   * Open the order's payment in the same transaction (021_order_payment): pending, holding the reserved stock
   * for the payment window, with the 1% platform fee recorded once. The buyer may follow later (while
   * pending). Omitted: no payment row (the order is not paid online, e.g. a test or an import).
   */
  payment?: { provider: ProviderId; buyer?: Buyer | null; windowMs?: number };
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

/** True iff the error is the b3 inner-reserve concurrent-duplicate sentinel. */
export function isReserveDuplicate(error: unknown): boolean {
  // DuplicateRequestError is not exported from reserve.ts (it never escapes the
  // module by design), so we match its name tag, which it sets explicitly.
  return error instanceof Error && error.name === 'DuplicateRequestError';
}

/** Boundary validation: a malformed cart is a programming error, surfaced loudly. */
export function validateCart(cart: Cart): void {
  if (!cart.tenantId) throw new Error('createOrder: cart.tenantId (the selling company) is required');
  if (!cart.requestId) throw new Error('createOrder: cart.requestId is required');
  if (!cart.currency) throw new Error('createOrder: cart.currency is required');
  if (!cart.taxRegion) throw new Error('createOrder: cart.taxRegion is required');
  if (!Array.isArray(cart.lines) || cart.lines.length === 0) {
    throw new Error('createOrder: cart must have at least one line');
  }
  // Reverse-charge precondition (shared with the Books domain): the Section 13b
  // mechanism only applies to a B2B sale to a VAT-registered recipient.
  // reverseCharge is a bare client boolean that SUPPRESSES VAT and emits the 13b
  // notice, so without this gate a {customerType:'b2c', reverseCharge:true} cart
  // would silently yield a zero-VAT B2C invoice (illegal). An unset customerType
  // defaults to b2c and is rejected the same way.
  if (cart.reverseCharge) {
    assertReverseChargeAllowed({ customerType: cart.customerType ?? 'b2c', vatId: cart.vatId });
  }
  for (const line of cart.lines) {
    if (!line.inventoryItemId) throw new Error('createOrder: line.inventoryItemId is required');
    if (!line.variantId) throw new Error('createOrder: line.variantId is required');
    assertPositiveInt(line.quantity, 'line.quantity');
  }
}

/**
 * True iff `error` is a postgres.js unique-violation (SQLSTATE 23505) on the
 * order's UNIQUE(request_id) index (`order_request_id_key`). kysely-postgres-js
 * rethrows the raw postgres.js `PostgresError`, which carries `.code` ('23505')
 * and `.constraint_name` (the violated index). Matching the EXACT constraint name
 * is load-bearing: a miss would treat a duplicate order as a fresh failure (a
 * CRITICAL risk per the plan), and ANY OTHER 23505 (e.g. the order_number unique,
 * a real bug) MUST propagate unchanged: it is never swallowed.
 */
export function isOrderRequestIdConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; constraint_name?: unknown };
  if (e.code !== '23505') return false;
  const name = e.constraint_name;
  if (typeof name !== 'string') return false;
  return name === 'order_request_id_key' || name.includes('request_id');
}

/**
 * cart -> order in ONE READ COMMITTED transaction on the scoped `db`. Returns
 * { ok:true, orderId } on success, the explicit
 * { ok:false, shortages } when any line short-stocks (the whole order rolls back),
 * and is idempotent on the order's request_id (a duplicate returns the prior
 * order). `tgId` is threaded through for the per-tenant order_number_seq read and
 * the inner reserve's raw guarded UPDATE.
 */
export async function createOrder(
  db: Kysely<CommerceDB>,
  tgId: string,
  cart: Cart,
): Promise<CreateOrderResult> {
  validateCart(cart);

  try {
    return await runOrderTransaction(db, tgId, cart);
  } catch (error) {
    if (error instanceof OrderShortageError) {
      // The transaction already rolled back (the throw aborted it); surface the
      // explicit shortage contract, never a silent success.
      return { ok: false, shortages: error.shortages };
    }
    if (isReserveDuplicate(error) || isOrderRequestIdConflict(error)) {
      // A CONCURRENT duplicate request_id lost the UNIQUE race (on the order row,
      // or on a per-line reservation via the inner reserve's name-tagged
      // DuplicateRequestError). The loser rolled back; the winner committed. Re-read
      // the winner in a FRESH transaction (the aborted one cannot be queried).
      return resolvePriorOrder(db, cart.requestId);
    }
    throw error;
  }
}

/** Open the ONE READ COMMITTED Kysely transaction (the isolation b3 proves). */
function runOrderTransaction(
  db: Kysely<CommerceDB>,
  tgId: string,
  cart: Cart,
): Promise<CreateOrderResult> {
  return db
    .transaction()
    .setIsolationLevel(RESERVE_ISOLATION_LEVEL)
    .execute(async (trx) => {
      // NO `SET LOCAL search_path`: `trx` is already schema-qualified (it inherits
      // withSchema from commerceTenantDb(tgId)).

      // (1) Sequential idempotency: a prior order with this request_id wins.
      const prior = await orderRepository.findByRequestId(trx, cart.requestId);
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
        // The variant must be one of the selling company's (live or not: a reprint reads the snapshot).
        const owned = await trx
          .selectFrom('product_variant')
          .select('id')
          .where('id', '=', line.variantId)
          .where('tenant_id', '=', cart.tenantId)
          .executeTakeFirst();
        if (!owned) throw new UnknownVariantError(line.variantId);

        const unitPrice = await pricingRepository.resolvePrice(trx, line.variantId, {
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

        // Snapshot the variant title/sku/tax_class via an INLINE tx read (variant
        // row + product.tax_class fallback). This is a transaction-scoped read, NOT
        // routed through the storefront read repo. No deleted_at filter: the
        // snapshot is what a reprint reads, even for a since-deleted variant.
        const variant = await trx
          .selectFrom('product_variant')
          .leftJoin('product', (join) =>
            join
              .onRef('product.id', '=', 'product_variant.product_id')
              .onRef('product.tenant_id', '=', 'product_variant.tenant_id'),
          )
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
          tenantId: cart.tenantId,
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
      const orderNumber = await orderRepository.nextOrderNumber(trx, tgId);
      const order = await orderRepository.insertOrder(trx, {
        tenantId: cart.tenantId,
        siteId: cart.siteId ?? null,
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
        const lineItem = await orderRepository.insertLineItem(trx, {
          ...lines[i],
          orderId: order.id,
        });

        const cartLine = cart.lines[i];
        const result = await reserve(trx, tgId, {
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

      // (7) the payment, pending until the provider reports (a free order needs none).
      if (cart.payment && total > 0) {
        const opened = cart.now ?? new Date();
        await trx
          .insertInto('order_payment')
          .values({
            tenant_id: cart.tenantId,
            order_id: order.id,
            provider: cart.payment.provider,
            amount: total,
            currency_code: cart.currency,
            application_fee_amount: platformFee(total),
            buyer: toJsonb(cart.payment.buyer ?? {}),
            expires_at: new Date(opened.getTime() + (cart.payment.windowMs ?? PAYMENT_WINDOW_MS)),
            updated_at: opened,
          })
          .execute();
      }

      return { ok: true, orderId: order.id };
    });
}

/**
 * Re-read the prior committed order for `requestId` in a FRESH READ COMMITTED
 * transaction and return it as the idempotent success. If it is somehow absent,
 * surface loudly (never a silent 500).
 */
function resolvePriorOrder(
  db: Kysely<CommerceDB>,
  requestId: string,
): Promise<CreateOrderResult> {
  return db
    .transaction()
    .setIsolationLevel(RESERVE_ISOLATION_LEVEL)
    .execute(async (trx) => {
      const prior = await orderRepository.findByRequestId(trx, requestId);
      if (!prior) {
        throw new Error(
          `createOrder: request_id ${requestId} hit a UNIQUE violation but no prior order was found`,
        );
      }
      return { ok: true, orderId: prior.id };
    });
}
