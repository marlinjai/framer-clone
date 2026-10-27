import type { Migration } from '@marlinjai/tenant-db';

/**
 * The receipt's payment day, `024_receipt_paid_on`. Purely additive: one nullable column on `sales_document`.
 *
 * A shop receipt states the day the buyer paid ("Bezahlt am"), which is not always its issue day: a receipt that
 * could not be issued at once (the Books not set up yet, the contacts database not answering) is issued by a
 * later retry. `paid_on` is that day, taken from the payment's `paid_at` (Europe/Berlin) when the draft is
 * made, so it is frozen with the receipt: `sales_document_guard` compares the whole row on an issued document
 * (to_jsonb(OLD) - the few mutable columns), so the new column is immutable after issue without touching the
 * guard. Null for every other document.
 *
 * House style as 007 to 023: BARE names. Re-runnable.
 */
export const receiptPaidOn: Migration = {
  id: '024_receipt_paid_on',
  up: async (tx) => {
    await tx`ALTER TABLE "sales_document" ADD COLUMN IF NOT EXISTS "paid_on" DATE`;
  },
};
