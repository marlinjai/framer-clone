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
//   checkout_expired    pending -> expired, the reserved stock released. Besides a provider's own report, our clock
//                       closes a payment: its job when its window ends (expiryJob.ts), and sweepExpiredPayments, which
//                       runs before a new order reserves, before a payment starts, and on a schedule (expirySweep.ts).
//                       Those set `requireDue`: a payment that is not due writes nothing, not even the event.
//
// This row is the order's state. The order itself is append-only (005_minimal_orders revokes UPDATE from the
// app role: a placed order is a bookkeeping record), so its `status` stays `confirmed`, meaning "placed",
// whatever the payment does. A late success clears the closing time and the decline code of the earlier
// close; the payment_event rows keep that history.
//
// Each provider event is recorded once (payment_event); a repeated delivery changes nothing. The state change,
// the event record, the stock movements and the work the change starts commit together: a payment that becomes paid
// writes `payment.paid`, whose job issues the receipt (receiptJob.ts, slice B4 of
// docs/plans/2026-11-02-shop-backbone.md). So a receipt can no longer be forgotten: the job retries a failure on its
// own schedule, and the caller only starts its first attempt (`jobIds`). issueReceipt is that attempt.
//
// The registry of what an event starts (jobs/consumers.ts) loads this module, so this module never imports it: the
// caller hands the event writer in as `deps.emit`.

import { sql, type Kysely, type Transaction } from 'kysely';

import type { CommerceDB } from '../db-types';
import type { CommerceEvent } from '../jobs/types';
import { applyInventoryEffect, reserve, RESERVE_ISOLATION_LEVEL } from '../inventory/reserve';
import { isLockTimeout } from '../provisioning/ownerSql';
import type { PaymentEvent, PaymentProvider, ProviderId } from './provider';
import { enqueueShopMail } from '../mail/outbox';

/** How long a pending payment holds its stock (the design: 30 minutes). */
export const PAYMENT_WINDOW_MS = 30 * 60 * 1000;

/**
 * How long a close by our own clock (`requireDue`) waits for locks. It can always come back later, so it never waits on
 * a busy payment for longer than a job's deadline: until slice B6 a late refund holds this row across a Stripe call.
 */
export const DUE_LOCK_WAIT_MS = 2 * 60 * 1000;

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

/** A close by our own clock gave up waiting for a lock. Nothing changed, and trying again later is the answer. */
export class PaymentBusyError extends Error {
  constructor(readonly orderId: string) {
    super(`the payment of order ${orderId} stayed locked past the wait of a close by our clock`);
    this.name = 'PaymentBusyError';
  }
}

/**
 * The expiry of a payment is recorded, yet the payment is still pending. The event and the close commit together and
 * nothing returns a payment to pending, so this cannot happen. Finishing quietly would keep the stock held for good.
 */
export class ExpiryRecordedError extends Error {
  constructor(readonly orderId: string) {
    super(`the expiry of order ${orderId} is recorded, but its payment is still pending`);
    this.name = 'ExpiryRecordedError';
  }
}

/** A sweep could not close every expired payment. It closed the others; the next sweep tries these again. */
export class ExpirySweepError extends Error {
  constructor(
    readonly tenantId: string,
    readonly closed: string[],
    readonly failed: string[],
  ) {
    super(`company ${tenantId}: ${failed.length} expired payment(s) could not be closed`);
    this.name = 'ExpirySweepError';
  }
}

export interface PaymentDeps {
  db: Kysely<CommerceDB>;
  tgId: string;
  provider: (id: ProviderId) => PaymentProvider;
  /** Issue the receipt of a paid order (receipt.ts ensureReceipt, bound to the company). */
  receipt: (orderId: string) => Promise<{ documentId: string }>;
  /**
   * Write an event's jobs in the caller's transaction (jobs/emit.ts emitCommerceEvent). Handed in rather than imported:
   * the registry it reads loads this module. Answers the ids of the jobs written.
   */
  emit: (trx: Transaction<CommerceDB>, event: CommerceEvent) => Promise<string[]>;
  now?: () => Date;
  /** Overrides DUE_LOCK_WAIT_MS. */
  lockWaitMs?: number;
  /** The company's connected account for refunds (Stripe Connect). */
  connectedAccountId?: string;
  /**
   * Start sending the buyer's letter (the shop's receipt email, mail/runtime.ts) once it is written: the letter
   * itself is written in the transaction that links the receipt or records the refund, so it can never be lost,
   * and this only starts the first attempt without waiting for it (nothing waits for mail; the sweep sends
   * whatever this attempt could not). Absent in tests that send no mail.
   */
  deliverMail?: (tenantId: string, orderId: string, kind: 'order_confirmation' | 'late_refund') => void;
}

export interface PaymentOutcome {
  status: PaymentStatus;
  /** The event was a repeat: nothing changed. */
  duplicate: boolean;
  /**
   * The jobs this event wrote (the receipt of a payment that became paid). They exist once the event committed and a
   * worker runs them in any case; the caller starts the first attempt (jobs/run.ts runJobNow) so nobody waits on it.
   */
  jobIds: string[];
  /**
   * `requireDue` found the payment not due and nothing was written. `expiresAt`: when its window now ends, for a
   * payment still pending; null for one that closed or was paid.
   */
  notDue?: { expiresAt: Date | null };
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

/**
 * Whether a locked payment's window is over, and when it ends. Decided by Postgres and read as an instant, because a
 * timestamp read back as it is stored is only right when the process runs in UTC.
 */
async function readWindow(trx: Trx, tenantId: string, orderId: string, at: Date) {
  return trx
    .selectFrom('order_payment')
    .select((eb) => [
      eb('expires_at', '<=', at).as('due'),
      sql<Date>`${sql.ref('expires_at')} AT TIME ZONE 'UTC'`.as('expiresAt'),
    ])
    .where('tenant_id', '=', tenantId)
    .where('order_id', '=', orderId)
    .executeTakeFirstOrThrow();
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
 * Apply one provider event to its order's payment (the state machine above). A payment that becomes paid writes its
 * receipt's job in the same transaction (`jobIds`). Throws UnknownPaymentError (no such payment for the company) and
 * PaymentMismatchError (another amount or currency) with nothing changed; a database or provider failure propagates
 * and changes nothing.
 */
export async function handlePaymentEvent(deps: PaymentDeps, event: PaymentEvent): Promise<PaymentOutcome> {
  const now = deps.now ?? (() => new Date());
  let duplicate = false;
  let notDue: PaymentOutcome['notDue'];
  let status: PaymentStatus;
  let jobIds: string[] = [];
  try {
    let written: string[] = [];
    status = await inTransaction(deps.db, async (trx) => {
      if (event.requireDue) {
        const wait = `${deps.lockWaitMs ?? DUE_LOCK_WAIT_MS}ms`;
        await sql`SELECT set_config('lock_timeout', ${wait}, true)`.execute(trx);
      }
      const payment = await lockPayment(trx, event.tenantId, event.orderId);
      const at = now();
      const current = payment.status as PaymentStatus;
      // Before the event: the append-only record must never say a payment closed that did not.
      if (event.requireDue) {
        const window = await readWindow(trx, event.tenantId, event.orderId, at);
        if (current !== 'pending' || !window.due) {
          notDue = { expiresAt: current === 'pending' ? window.expiresAt : null };
          return current;
        }
      }
      if (!(await recordEvent(trx, event))) {
        if (event.requireDue) throw new ExpiryRecordedError(event.orderId);
        duplicate = true;
        return current;
      }
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
          // Only here, where the payment really became paid: a repeat or a paid payment returned above.
          written = await deps.emit(trx, {
            tenantId: event.tenantId,
            type: 'payment.paid',
            payload: { orderId: event.orderId },
            at,
          });
          return 'paid';
        }
      }
    });
    jobIds = written;
  } catch (err) {
    if (event.requireDue && isLockTimeout(err)) throw new PaymentBusyError(event.orderId);
    if (!(err instanceof LateStockGoneError)) throw err;
    status = await refundLatePayment(deps, event, now());
    if (status === 'refunded') deps.deliverMail?.(event.tenantId, event.orderId, 'late_refund');
  }
  return { status, duplicate, jobIds, ...(notDue ? { notDue } : {}) };
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
    // The buyer's refund notice (when the shop sends mail) is written before any money moves, so a failure to
    // write it stops here instead of after the refund.
    await enqueueShopMail(trx, event.tenantId, event.orderId, 'late_refund', at);
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

/** How an attempt at a receipt ended without a failure. */
export type ReceiptAttempt =
  | { outcome: 'issued'; documentId: string }
  /** Linked before, by this job's earlier run or another attempt: nothing to do. */
  | { outcome: 'linked'; documentId: string }
  /** The payment is no longer paid (refunded since): it needs no receipt. */
  | { outcome: 'not_paid' };

/**
 * Issue the receipt of a paid order and link it, the work of its `receipt_issue` job (receiptJob.ts). The link, the
 * buyer's letter (when the shop sends mail) and `receipt.issued` commit together, and only when the link filled an
 * empty column, so a concurrent attempt that linked first writes nothing twice. On a failure the reason is kept on the
 * payment, where the owner sees it, and the error is thrown for the job to retry or refuse.
 */
export async function issueReceipt(deps: PaymentDeps, tenantId: string, orderId: string): Promise<ReceiptAttempt> {
  const now = deps.now ?? (() => new Date());
  const payment = await deps.db
    .selectFrom('order_payment')
    .select(['status', 'receipt_document_id'])
    .where('tenant_id', '=', tenantId)
    .where('order_id', '=', orderId)
    .executeTakeFirst();
  if (!payment) throw new UnknownPaymentError(orderId);
  if (payment.receipt_document_id) return { outcome: 'linked', documentId: payment.receipt_document_id };
  if (payment.status !== 'paid') return { outcome: 'not_paid' };

  let documentId: string;
  try {
    ({ documentId } = await deps.receipt(orderId));
  } catch (err) {
    const reason = receiptFailure(err);
    // A refund that overtook this attempt: the receipt is not owed any more, which is no failure.
    if (reason === 'NOT_PAID') return { outcome: 'not_paid' };
    // `[receipt-unissued]` is the stable prefix to alert on: money taken, no invoice yet.
    console.error(`[receipt-unissued] order ${orderId} of company ${tenantId}: the receipt could not be issued (${reason}):`, err);
    await deps.db
      .updateTable('order_payment')
      .set({ receipt_error: reason, updated_at: now() })
      .where('tenant_id', '=', tenantId)
      .where('order_id', '=', orderId)
      .execute();
    throw err;
  }

  const at = now();
  const linked = await deps.db.transaction().execute(async (trx) => {
    const update = await trx
      .updateTable('order_payment')
      .set({ receipt_document_id: documentId, receipt_error: null, updated_at: at })
      .where('tenant_id', '=', tenantId)
      .where('order_id', '=', orderId)
      .where('receipt_document_id', 'is', null)
      .executeTakeFirst();
    // Zero rows: another attempt linked it first and wrote the rest with it.
    if (update.numUpdatedRows === BigInt(0)) return false;
    await enqueueShopMail(trx, tenantId, orderId, 'order_confirmation', at);
    await deps.emit(trx, { tenantId, type: 'receipt.issued', payload: { orderId }, at });
    return true;
  });
  if (!linked) return { outcome: 'linked', documentId };
  // The buyer hears once the receipt exists (the letter links it).
  deps.deliverMail?.(tenantId, orderId, 'order_confirmation');
  return { outcome: 'issued', documentId };
}

/** A short, personal-data-free reason: the Books error code when there is one. */
export function receiptFailure(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z_]{3,60}$/.test(code)) return code;
  return err instanceof Error ? err.name.slice(0, 100) : 'unknown';
}

/**
 * Close every pending payment whose window ran out (checkout_expired, stock released). Idempotent and safe to
 * run concurrently: the payment row is locked and each expiry recorded once per order, so a second sweep finds
 * the event and releases nothing. Answers the orders it closed. One payment that cannot be closed never keeps
 * the others holding their stock: it is logged, the rest are closed, then ExpirySweepError reports it. `only` narrows
 * the sweep to one order: the pay route needs an answer about its own order, and each order's job closes the rest.
 */
export async function sweepExpiredPayments(
  deps: PaymentDeps,
  tenantId: string,
  only?: { orderId: string },
): Promise<string[]> {
  const at = (deps.now ?? (() => new Date()))();
  let query = deps.db
    .selectFrom('order_payment')
    .select(['order_id', 'provider'])
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'pending')
    .where('expires_at', '<', at);
  if (only) query = query.where('order_id', '=', only.orderId);
  const due = await query.execute();
  const closed: string[] = [];
  const failed: string[] = [];
  for (const row of due) {
    try {
      const outcome = await handlePaymentEvent(deps, {
        provider: row.provider as ProviderId,
        eventId: `expiry:${row.order_id}`,
        type: 'checkout_expired',
        tenantId,
        orderId: row.order_id,
        requireDue: true,
      });
      if (!outcome.duplicate && !outcome.notDue && outcome.status === 'expired') closed.push(row.order_id);
    } catch (err) {
      console.error(`[payments] order ${row.order_id}: the expired payment could not be closed:`, err);
      failed.push(row.order_id);
    }
  }
  if (failed.length > 0) throw new ExpirySweepError(tenantId, closed, failed);
  return closed;
}
