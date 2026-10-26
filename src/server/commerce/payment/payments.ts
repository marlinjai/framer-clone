import 'server-only';

// src/server/commerce/payment/payments.ts
//
// The payment of an order, from checkout to receipt (docs/plans/2026-10-25-catalogue-design.md, "Checkout,
// payment and receipt", items 2 to 6; migration 021_order_payment). Every provider outcome, a real webhook or
// the demo provider's immediate answer, goes through handlePaymentEvent:
//
//   payment_succeeded   pending -> paid. Closed (failed, cancelled, expired) -> paid when the stock can be
//                       reserved again; when it cannot, the payment is refunded in full and the order stays
//                       closed. Paid or refunded: nothing changes.
//   payment_failed      pending -> failed, the reserved stock released.
//   checkout_cancelled  pending -> cancelled, the reserved stock released.
//   checkout_expired    pending -> expired, the reserved stock released (also sweepExpiredPayments).
//
// This row is the order's state. The order itself is append-only (005_minimal_orders revokes UPDATE from the
// app role: a placed order is a bookkeeping record), so its `status` stays `confirmed`, meaning "placed",
// whatever the payment does. A late success clears the closing time and the decline code of the earlier
// close; the payment_event rows keep that history.
//
// Each provider event is recorded once (payment_event); a repeated delivery changes nothing. The state change,
// the event record and the stock movements commit together. A paid order without a receipt gets one after the
// commit (receipt.ts); when that fails the payment stays paid, the reason is kept on it, and the next delivery
// of any event for the order (a provider retries a webhook that answered an error) tries again.

import type { Kysely, Transaction } from 'kysely';

import type { CommerceDB } from '../db-types';
import { applyInventoryEffect, reserve, RESERVE_ISOLATION_LEVEL } from '../inventory/reserve';
import type { PaymentEvent, PaymentProvider, ProviderId } from './provider';

/** How long a pending payment holds its stock (the design: 30 minutes). */
export const PAYMENT_WINDOW_MS = 30 * 60 * 1000;

/**
 * The platform fee: 1% of the charged total, rounded half up, in the currency's minor unit (parent plan,
 * decision 12). 999 cents -> 10 cents.
 */
export function platformFee(amount: number): number {
  if (!Number.isInteger(amount) || amount < 0) throw new Error(`platformFee: invalid amount ${amount}`);
  return Math.floor((amount + 50) / 100);
}

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'cancelled' | 'expired' | 'refunded';

/** No payment for this order and company: a stale or foreign reference (the webhook answers 404). */
export class UnknownPaymentError extends Error {
  constructor(readonly orderId: string) {
    super(`no payment for order ${orderId}`);
    this.name = 'UnknownPaymentError';
  }
}

/** The provider reported another amount or currency than the payment's: nothing is changed. */
export class PaymentMismatchError extends Error {
  constructor(readonly orderId: string) {
    super(`the reported amount or currency of order ${orderId} does not match the payment`);
    this.name = 'PaymentMismatchError';
  }
}

/** A late success whose stock is gone: aborts the re-reserve transaction (refund follows). */
class LateStockGoneError extends Error {
  constructor() {
    super('late payment: the stock could not be reserved again');
    this.name = 'LateStockGoneError';
  }
}

export interface PaymentDeps {
  db: Kysely<CommerceDB>;
  tgId: string;
  provider: (id: ProviderId) => PaymentProvider;
  /** Issue the receipt of a paid order (receipt.ts ensureReceipt, bound to the company). */
  receipt: (orderId: string) => Promise<{ documentId: string }>;
  now?: () => Date;
  /** The company's connected account for refunds (Stripe Connect). */
  connectedAccountId?: string;
}

export interface PaymentOutcome {
  status: PaymentStatus;
  /** The event was a repeat: nothing changed. */
  duplicate: boolean;
  receiptDocumentId: string | null;
  /** Why the receipt could not be issued (the payment stands). */
  receiptError: string | null;
}

type Trx = Transaction<CommerceDB>;

async function lockPayment(trx: Trx, tenantId: string, orderId: string) {
  const row = await trx
    .selectFrom('order_payment')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('order_id', '=', orderId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw new UnknownPaymentError(orderId);
  return row;
}

/** Record the event; false when it was recorded before (a repeated delivery). */
async function recordEvent(trx: Trx, event: PaymentEvent): Promise<boolean> {
  const inserted = await trx
    .insertInto('payment_event')
    .values({
      provider: event.provider,
      event_id: event.eventId,
      tenant_id: event.tenantId,
      order_id: event.orderId,
      event_type: event.type,
    })
    .onConflict((oc) => oc.columns(['provider', 'event_id']).doNothing())
    .returning('event_id')
    .executeTakeFirst();
  return inserted !== undefined;
}

/** The reserve movements of an order's lines (untracked variants have none). */
async function reservedStock(trx: Trx, tenantId: string, orderId: string) {
  return trx
    .selectFrom('stock_movement')
    .innerJoin('order_line_item', 'order_line_item.id', 'stock_movement.ref_id')
    .select([
      'stock_movement.inventory_item_id as inventoryItemId',
      'stock_movement.location_id as locationId',
      'stock_movement.quantity as quantity',
      'stock_movement.request_id as requestId',
      'order_line_item.variant_ref as variantRef',
      'order_line_item.variant_ref_source as variantRefSource',
    ])
    .where('stock_movement.ref_type', '=', 'order_line')
    .where('stock_movement.movement_type', '=', 'reserve')
    .where('order_line_item.tenant_id', '=', tenantId)
    .where('order_line_item.order_id', '=', orderId)
    .orderBy('stock_movement.request_id')
    .execute();
}

/** Give back what the order reserved (idempotent per movement). */
async function releaseStock(trx: Trx, tgId: string, tenantId: string, orderId: string): Promise<void> {
  for (const m of await reservedStock(trx, tenantId, orderId)) {
    await applyInventoryEffect(trx, tgId, {
      type: 'release',
      inventoryItemId: m.inventoryItemId,
      locationId: m.locationId,
      quantity: m.quantity,
      requestId: `${m.requestId}:release`,
      refType: 'order_payment',
      refId: orderId,
    });
  }
}

/** Reserve the order's stock again after a late success; throws LateStockGoneError on a shortage. */
async function reserveAgain(trx: Trx, tgId: string, tenantId: string, orderId: string): Promise<void> {
  for (const m of await reservedStock(trx, tenantId, orderId)) {
    const result = await reserve(trx, tgId, {
      inventoryItemId: m.inventoryItemId,
      variantId: m.variantRefSource === 'owned' && m.variantRef ? m.variantRef : undefined,
      locationId: m.locationId,
      needed: m.quantity,
      requestId: `${m.requestId}:again`,
      refType: 'order_payment',
      refId: orderId,
    });
    if (!result.ok) throw new LateStockGoneError();
  }
}

function inTransaction<T>(db: Kysely<CommerceDB>, fn: (trx: Trx) => Promise<T>): Promise<T> {
  return db.transaction().setIsolationLevel(RESERVE_ISOLATION_LEVEL).execute(fn);
}

/**
 * Apply one provider event to its order's payment (the state machine above), then make sure a paid order has
 * its receipt. Throws UnknownPaymentError (no such payment for the company) and PaymentMismatchError (another
 * amount or currency) with nothing changed; a database or provider failure propagates and changes nothing.
 */
export async function handlePaymentEvent(deps: PaymentDeps, event: PaymentEvent): Promise<PaymentOutcome> {
  const now = deps.now ?? (() => new Date());
  let duplicate = false;
  let status: PaymentStatus;
  try {
    status = await inTransaction(deps.db, async (trx) => {
      const payment = await lockPayment(trx, event.tenantId, event.orderId);
      if (!(await recordEvent(trx, event))) {
        duplicate = true;
        return payment.status as PaymentStatus;
      }
      const at = now();
      const current = payment.status as PaymentStatus;
      const close = async (next: 'failed' | 'cancelled' | 'expired') => {
        if (current !== 'pending') return current;
        await releaseStock(trx, deps.tgId, event.tenantId, event.orderId);
        await trx
          .updateTable('order_payment')
          .set({
            status: next,
            closed_at: at,
            failure_code: event.failureCode ?? null,
            provider_payment_id: payment.provider_payment_id ?? event.providerPaymentId ?? null,
            version: payment.version + 1,
            updated_at: at,
          })
          .where('tenant_id', '=', event.tenantId)
          .where('order_id', '=', event.orderId)
          .execute();
        return next;
      };
      switch (event.type) {
        case 'payment_failed':
          return close('failed');
        case 'checkout_cancelled':
          return close('cancelled');
        case 'checkout_expired':
          return close('expired');
        case 'payment_succeeded': {
          if (
            (event.amount !== undefined && event.amount !== payment.amount) ||
            (event.currency !== undefined && event.currency.toUpperCase() !== payment.currency_code)
          ) {
            throw new PaymentMismatchError(event.orderId);
          }
          if (current === 'paid' || current === 'refunded') return current;
          // A late success on a closed order holds only if its stock can be reserved again.
          if (current !== 'pending') await reserveAgain(trx, deps.tgId, event.tenantId, event.orderId);
          await trx
            .updateTable('order_payment')
            .set({
              status: 'paid',
              paid_at: at,
              // A late success: the earlier close no longer describes the payment.
              closed_at: null,
              failure_code: null,
              provider_payment_id: payment.provider_payment_id ?? event.providerPaymentId ?? null,
              version: payment.version + 1,
              updated_at: at,
            })
            .where('tenant_id', '=', event.tenantId)
            .where('order_id', '=', event.orderId)
            .execute();
          return 'paid';
        }
      }
    });
  } catch (err) {
    if (!(err instanceof LateStockGoneError)) throw err;
    status = await refundLatePayment(deps, event, now());
  }

  const after = await deps.db
    .selectFrom('order_payment')
    .select(['receipt_document_id', 'receipt_error'])
    .where('tenant_id', '=', event.tenantId)
    .where('order_id', '=', event.orderId)
    .executeTakeFirstOrThrow();
  if (status !== 'paid' || after.receipt_document_id) {
    return { status, duplicate, receiptDocumentId: after.receipt_document_id, receiptError: after.receipt_error };
  }
  return { status, duplicate, ...(await issueReceipt(deps, event.tenantId, event.orderId, now())) };
}

/** The late success whose stock is gone: refund in full, the order stays closed. */
async function refundLatePayment(deps: PaymentDeps, event: PaymentEvent, at: Date): Promise<PaymentStatus> {
  return inTransaction(deps.db, async (trx) => {
    const payment = await lockPayment(trx, event.tenantId, event.orderId);
    // A concurrent delivery may have decided it already.
    if (payment.status === 'refunded' || payment.status === 'paid') {
      await recordEvent(trx, event);
      return payment.status as PaymentStatus;
    }
    const providerPaymentId = payment.provider_payment_id ?? event.providerPaymentId;
    if (!providerPaymentId) throw new Error(`late payment of order ${event.orderId} carries no provider payment id`);
    const { refundId } = await deps
      .provider(payment.provider as ProviderId)
      .refund({ providerPaymentId, amount: payment.amount, connectedAccountId: deps.connectedAccountId });
    await recordEvent(trx, event);
    await trx
      .updateTable('order_payment')
      .set({
        status: 'refunded',
        provider_payment_id: providerPaymentId,
        refund_id: refundId,
        failure_code: 'stock_gone',
        version: payment.version + 1,
        updated_at: at,
      })
      .where('tenant_id', '=', event.tenantId)
      .where('order_id', '=', event.orderId)
      .execute();
    console.error(`[payments] order ${event.orderId}: paid after it closed and its stock was gone; refunded ${refundId}`);
    return 'refunded';
  });
}

/** Issue the receipt; on failure keep the reason on the payment (the payment stands) and answer it. */
async function issueReceipt(
  deps: PaymentDeps,
  tenantId: string,
  orderId: string,
  at: Date,
): Promise<{ receiptDocumentId: string | null; receiptError: string | null }> {
  try {
    const { documentId } = await deps.receipt(orderId);
    await deps.db
      .updateTable('order_payment')
      .set({ receipt_document_id: documentId, receipt_error: null, updated_at: at })
      .where('tenant_id', '=', tenantId)
      .where('order_id', '=', orderId)
      .where('receipt_document_id', 'is', null)
      .execute();
    return { receiptDocumentId: documentId, receiptError: null };
  } catch (err) {
    const reason = receiptFailure(err);
    console.error(`[payments] order ${orderId}: the receipt could not be issued (${reason}):`, err);
    await deps.db
      .updateTable('order_payment')
      .set({ receipt_error: reason, updated_at: at })
      .where('tenant_id', '=', tenantId)
      .where('order_id', '=', orderId)
      .execute();
    return { receiptDocumentId: null, receiptError: reason };
  }
}

/** A short, personal-data-free reason: the Books error code when there is one. */
export function receiptFailure(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z_]{3,60}$/.test(code)) return code;
  return err instanceof Error ? err.name.slice(0, 100) : 'unknown';
}

/**
 * Close every pending payment whose window ran out (checkout_expired, stock released). Idempotent: each
 * expiry is recorded once per order. Answers the orders it closed.
 */
export async function sweepExpiredPayments(deps: PaymentDeps, tenantId: string): Promise<string[]> {
  const at = (deps.now ?? (() => new Date()))();
  const due = await deps.db
    .selectFrom('order_payment')
    .select(['order_id', 'provider'])
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'pending')
    .where('expires_at', '<', at)
    .execute();
  const closed: string[] = [];
  for (const row of due) {
    const outcome = await handlePaymentEvent(deps, {
      provider: row.provider as ProviderId,
      eventId: `expiry:${row.order_id}`,
      type: 'checkout_expired',
      tenantId,
      orderId: row.order_id,
    });
    if (!outcome.duplicate && outcome.status === 'expired') closed.push(row.order_id);
  }
  return closed;
}
