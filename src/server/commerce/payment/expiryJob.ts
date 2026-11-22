import 'server-only';

// src/server/commerce/payment/expiryJob.ts
//
// Ending a stock hold when its payment's window runs out (docs/plans/2026-11-02-shop-backbone.md, sections 1.8 and 1.9):
// one job per payment, written with the order and due at `expires_at`, so a hold ends in a shop nobody is buying from.
//
// Everything that decides is under the payment's row lock, in handlePaymentEvent (`requireDue`). This handler reads no
// status or date of its own, so it cannot act on one that changed: a payment paid or closed meanwhile writes nothing, and
// one whose date moved answers the new date. A repeated run is harmless for the same reason, and `payment_event` holds
// `expiry:<orderId>` once, the same key the sweep uses, so the job and the sweep cannot both close a payment.
//
// A payment with a stored checkout session is asked about first (checkoutSession.ts sessionAtExpiry, section 2.1 step 6),
// once its hold is over: a session Stripe completed applies the success under `session:<id>`, an open one is asked about
// again in 5 minutes, an expired one closes. While Stripe does not answer the job retries, and an hour past the hold it
// closes anyway: the late path and reconciliation recover a payment taken meanwhile, and a hold must not depend on Stripe.

import { z } from 'zod';

import { scheduleJob } from '../jobs/schedule';
import { defineJobKind, JobRefused, JobRetryLater, type EventConsumer } from '../jobs/types';
import type { ExpiryDecision } from './checkoutSession';
import { DUE_LOCK_WAIT_MS, ExpiryRecordedError, PaymentBusyError, PaymentMismatchError, type PaymentOutcome } from './payments';
import type { ProviderId } from './provider';

export const PAYMENT_EXPIRY_KIND = 'payment_expiry';
/** Both the job's dedupe key and the event id start this way, followed by the order id. */
export const EXPIRY_KEY_PREFIX = 'expiry:';

const DAY_MS = 24 * 60 * 60 * 1000;

interface PaymentExpiryPayload {
  orderId: string;
}

/** `order.placed` writes the job, due when the hold ends. */
export const paymentExpiryConsumer: EventConsumer<'order.placed'> = {
  enqueue: (trx, event) =>
    scheduleJob(trx, {
      tenantId: event.tenantId,
      kind: PAYMENT_EXPIRY_KIND,
      dedupeKey: `${EXPIRY_KEY_PREFIX}${event.payload.orderId}`,
      eventType: event.type,
      payload: { orderId: event.payload.orderId },
      runAt: event.payload.expiresAt,
      at: event.at,
    }),
};

export const paymentExpiryKind = defineJobKind<PaymentExpiryPayload>({
  policy: {
    // Only database work on one payment, so all it can wait for is a lock, and the worker bounds that wait by this.
    deadlineMs: DUE_LOCK_WAIT_MS,
    backoffMinutes: [1, 5, 15, 60],
    laterMinutes: 6 * 60,
    giveUpAfterMs: 3 * DAY_MS,
  },
  payload: z.object({ orderId: z.string().min(1) }).strict(),
  async run({ company, payments, payload: { orderId }, signal }) {
    const payment = await company
      .selectFrom('order_payment')
      .select('provider')
      .where('order_id', '=', orderId)
      .executeTakeFirst();
    // A payment row is never deleted (BK018) and the job is written with it, so this job names something else.
    if (!payment) throw new JobRefused('unknown_payment');
    let decision: ExpiryDecision;
    try {
      decision = await payments.sessionAtExpiry(orderId, signal);
    } catch (err) {
      if (err instanceof PaymentBusyError) throw new JobRetryLater('payment_busy');
      // Stripe charged another amount than the payment's: only a person can say what this order is.
      if (err instanceof PaymentMismatchError) throw new JobRefused('session_amount_mismatch');
      throw err;
    }
    if (decision.kind === 'paid') return;
    if (decision.kind === 'recheck') return { rerunAt: decision.at };
    if (decision.kind === 'retry') throw new JobRetryLater('stripe_unreachable', decision.delayMs);

    let outcome: PaymentOutcome;
    try {
      outcome = await payments.handleEvent({
        provider: payment.provider as ProviderId,
        eventId: `${EXPIRY_KEY_PREFIX}${orderId}`,
        type: 'checkout_expired',
        orderId,
        requireDue: true,
      });
    } catch (err) {
      if (err instanceof PaymentBusyError) throw new JobRetryLater('payment_busy');
      if (err instanceof ExpiryRecordedError) throw new JobRefused('expiry_recorded_while_pending');
      throw err;
    }
    if (outcome.notDue?.expiresAt) return { rerunAt: outcome.notDue.expiresAt };
  },
});
