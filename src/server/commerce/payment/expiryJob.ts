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

import { z } from 'zod';

import { scheduleJob } from '../jobs/schedule';
import { defineJobKind, JobRefused, JobRetryLater, type EventConsumer } from '../jobs/types';
import { DUE_LOCK_WAIT_MS, ExpiryRecordedError, PaymentBusyError, type PaymentOutcome } from './payments';
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
  async run({ company, payments, payload: { orderId } }) {
    const payment = await company
      .selectFrom('order_payment')
      .select('provider')
      .where('order_id', '=', orderId)
      .executeTakeFirst();
    // A payment row is never deleted (BK018) and the job is written with it, so this job names something else.
    if (!payment) throw new JobRefused('unknown_payment');
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
