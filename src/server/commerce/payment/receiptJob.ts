import 'server-only';

// src/server/commerce/payment/receiptJob.ts
//
// Issuing a paid order's receipt (docs/plans/2026-11-02-shop-backbone.md, sections 1.8 and 1.9): one job per order,
// written in the transaction that marks its payment paid, so a receipt can no longer be forgotten. Before this, a receipt
// that failed was retried only when Stripe delivered a webhook again, and a demo payment was never retried at all.
//
// The handler is `ctx.payments.issueReceipt`, the payment state machine's own step bound to this job's company: it
// issues through the Books, then links the receipt and writes `receipt.issued` in one transaction, and on a failure keeps
// the reason on the payment, where the owner sees it. A repeat is harmless: `ensureReceipt` answers an issued receipt as
// it is, a partial unique index allows one per order, and the link only fills an empty column.
//
// How a failure ends depends on whether time can heal it. The Books not set up yet, the contacts database not answering,
// an archived contact a person restores: retried for 30 days, since a company may set up its Books late. A receipt whose
// figures or tax identity disagree with the order: dead at once, for a person to look at, since a retry can only fail
// the same way. A payment no longer paid (refunded since) needs no receipt: done.
//
// This module imports nothing from the registry: the consumer writes through `schedule.ts`, and the handler reaches the
// payment only through its context, because `payments.ts` cannot load the registry (it would load this module first).

import { z } from 'zod';

import { scheduleJob } from '../jobs/schedule';
import { defineJobKind, JobRefused, JobRetryLater, type EventConsumer } from '../jobs/types';
import { receiptFailure } from './payments';

export const RECEIPT_ISSUE_KIND = 'receipt_issue';
/** The job's dedupe key starts this way, followed by the order id. */
export const RECEIPT_KEY_PREFIX = 'receipt:';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The reasons a retry cannot change: the order's own figures, its buyer, or a tax case the Books do not cover. The
 * job is dead and counted where a person looks; `requeueJob` runs it again once they fixed the cause.
 */
export const RECEIPT_REFUSALS: ReadonlySet<string> = new Set([
  'ORDER_NOT_FOUND',
  'BUYER_MISSING',
  'TOTALS_MISMATCH',
  'TAX_IDENTITY_MISMATCH',
  'TAX_CASE_UNSUPPORTED',
  'REVERSE_CHARGE_NOT_ALLOWED',
  'INVALID_INPUT',
  // No payment row for the job's order: a row is never deleted (BK018), so the job names something else, as the expiry
  // job's `unknown_payment`.
  'UnknownPaymentError',
]);

interface ReceiptIssuePayload {
  orderId: string;
}

/** `payment.paid` writes the job, due at once. */
export const receiptIssueConsumer: EventConsumer<'payment.paid'> = {
  enqueue: (trx, event) =>
    scheduleJob(trx, {
      tenantId: event.tenantId,
      kind: RECEIPT_ISSUE_KIND,
      dedupeKey: `${RECEIPT_KEY_PREFIX}${event.payload.orderId}`,
      eventType: event.type,
      payload: { orderId: event.payload.orderId },
      runAt: event.at,
      at: event.at,
    }),
};

export const receiptIssueKind = defineJobKind<ReceiptIssuePayload>({
  policy: {
    // A render and a store cannot be stopped partway, so the signal reaches nothing here: the deadline only has to sit
    // under the lease, which is far longer than a render (section 1.4).
    deadlineMs: 8 * 60 * 1000,
    backoffMinutes: [1, 5, 15, 60],
    laterMinutes: 6 * 60,
    giveUpAfterMs: 30 * DAY_MS,
  },
  payload: z.object({ orderId: z.string().min(1) }).strict(),
  async run({ payments, payload: { orderId } }) {
    try {
      await payments.issueReceipt(orderId);
    } catch (err) {
      const reason = receiptFailure(err);
      if (RECEIPT_REFUSALS.has(reason)) throw new JobRefused(reason);
      throw new JobRetryLater(reason);
    }
  },
});
