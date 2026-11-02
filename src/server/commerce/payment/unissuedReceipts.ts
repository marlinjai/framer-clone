import 'server-only';

// src/server/commerce/payment/unissuedReceipts.ts
//
// Paid orders without an invoice, so that money taken without a receipt is never silent (the money review of
// 2026-11-02, finding 1). Since slice B4 the webhook answers 200 and the receipt's job retries a failure on its own,
// so nothing else would tell anyone. Two readers:
//   - the owner's payments page lists the company's own, with the reason the payment keeps (`receipt_error`) and
//     whether the job still retries or has stopped for a person;
//   - the watchdog route counts the stopped ones across a tenant group, and its `receipts` field turns from "ok" to
//     "unissued", which an Uptime Kuma keyword monitor matches.
//
// "Stopped" means no live job will issue it: the job is dead, or there is none. A just-paid order whose job is pending
// or running is "retrying", so the monitor does not flicker red for the seconds before its first attempt.

import { sql, type Kysely } from 'kysely';

import type { CommerceDB } from '../db-types';
import { RECEIPT_ISSUE_KIND, RECEIPT_KEY_PREFIX } from './receiptJob';

export type UnissuedState = 'retrying' | 'stopped';

export interface UnissuedReceipt {
  orderId: string;
  orderNumber: string;
  paidAt: Date;
  /** The stable code the last attempt failed with (no personal data), null before a first attempt. */
  reason: string | null;
  state: UnissuedState;
}

/** The largest list the payments page shows; `count` says how many there are in all. */
export const UNISSUED_LIST_LIMIT = 50;

function unissuedQuery(db: Kysely<CommerceDB>) {
  return db
    .selectFrom('order_payment')
    .innerJoin('order', (join) =>
      join.onRef('order.id', '=', 'order_payment.order_id').onRef('order.tenant_id', '=', 'order_payment.tenant_id'),
    )
    .leftJoin('commerce_job', (join) =>
      join
        .onRef('commerce_job.tenant_id', '=', 'order_payment.tenant_id')
        .on('commerce_job.kind', '=', RECEIPT_ISSUE_KIND)
        .on('commerce_job.dedupe_key', '=', sql<string>`${RECEIPT_KEY_PREFIX} || ${sql.ref('order_payment.order_id')}`),
    )
    .where('order_payment.status', '=', 'paid')
    .where('order_payment.receipt_document_id', 'is', null);
}

const STOPPED = sql<boolean>`(${sql.ref('commerce_job.status')} IS NULL OR ${sql.ref('commerce_job.status')} IN ('dead', 'done'))`;

/** The company's paid orders without an invoice, oldest first, and how many there are. */
export async function unissuedReceipts(
  db: Kysely<CommerceDB>,
  companyId: string,
): Promise<{ count: number; orders: UnissuedReceipt[] }> {
  const rows = await unissuedQuery(db)
    .where('order_payment.tenant_id', '=', companyId)
    .select([
      'order_payment.order_id as orderId',
      'order.order_number as orderNumber',
      sql<Date>`${sql.ref('order_payment.paid_at')} AT TIME ZONE 'UTC'`.as('paidAt'),
      'order_payment.receipt_error as reason',
      STOPPED.as('stopped'),
    ])
    .orderBy('order_payment.paid_at')
    .limit(UNISSUED_LIST_LIMIT)
    .execute();
  const { n } = await unissuedQuery(db)
    .where('order_payment.tenant_id', '=', companyId)
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .executeTakeFirstOrThrow();
  return {
    count: Number(n),
    orders: rows.map((row) => ({
      orderId: row.orderId,
      orderNumber: row.orderNumber,
      paidAt: new Date(row.paidAt),
      reason: row.reason,
      state: row.stopped ? 'stopped' : 'retrying',
    })),
  };
}

/** Across every company of one tenant group: paid orders without an invoice that no live job will issue. */
export async function countStoppedReceipts(db: Kysely<CommerceDB>): Promise<number> {
  const { n } = await unissuedQuery(db)
    .where(STOPPED)
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .executeTakeFirstOrThrow();
  return Number(n);
}
