import 'server-only';

// src/server/commerce/mail/mailJob.ts
//
// Sending the buyer's letter as a job (docs/plans/2026-11-02-shop-backbone.md, section 5, slice B5): one `shop_mail`
// job per order and kind of letter, written with its row in the transaction of the change that needs the letter
// (`receipt.issued` writes the confirmation, `payment.refunded` the refund notice), only while the company is
// connected to Lumitra Mail. The handler is `ctx.mail.deliver`, bound to the job's company by the worker.
//
// How an attempt ends: sent or blocked is done (Lumitra Mail decided, and a person cannot change a block here); a
// refusal is dead at once and `failed` on the row, where the owner sees it; Lumitra Mail down, or the receipt link key
// missing, is retried with the backoff below until three days have passed, then written `failed` and dead. A repeat is
// harmless: a settled row answers as it is, and Lumitra Mail's idempotency key refuses a second send.
//
// Like receiptJob.ts this imports no registry: the consumers write through `schedule.ts`.

import { z } from 'zod';

import { defineJobKind, type EventConsumer } from '../jobs/types';
import { enqueueShopMail, GIVE_UP_AFTER_MS } from './outbox';
import { SHOP_MAIL_KINDS } from './templates';

export { SHOP_MAIL_JOB_KIND } from './outbox';

/** `receipt.issued` writes the confirmation's row and job, when the company is connected. */
export const receiptIssuedMailConsumer: EventConsumer<'receipt.issued'> = {
  enqueue: (trx, event) => enqueueShopMail(trx, event.tenantId, event.payload.orderId, 'order_confirmation', event.at),
};

/** `payment.refunded` writes the refund notice's row and job, when the company is connected. */
export const refundedMailConsumer: EventConsumer<'payment.refunded'> = {
  enqueue: (trx, event) => enqueueShopMail(trx, event.tenantId, event.payload.orderId, 'late_refund', event.at),
};

const HOUR_MS = 60 * 60 * 1000;

export const shopMailKind = defineJobKind({
  policy: {
    // One call to Lumitra Mail takes at most its own 10 second timeout, twice.
    deadlineMs: 60 * 1000,
    backoffMinutes: [1, 5, 15, 60],
    laterMinutes: 6 * 60,
    // The attempt itself writes `failed` after three days (outbox.ts); this only has to come after it.
    giveUpAfterMs: GIVE_UP_AFTER_MS + HOUR_MS,
  },
  payload: z.object({ orderId: z.string().min(1), kind: z.enum(SHOP_MAIL_KINDS) }).strict(),
  async run({ mail, payload: { orderId, kind } }) {
    await mail.deliver(orderId, kind);
  },
});
