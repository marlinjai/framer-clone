import 'server-only';

// src/server/commerce/jobs/backfills.ts
//
// Work that exists as a row but not yet as a job (docs/plans/2026-11-02-shop-backbone.md, section 1.10). A migration
// cannot do this: it runs in the new container while the old one still writes rows. So the worker runs each backfill
// itself, per tenant group, on its first pass and then hourly, and each one is an idempotent
// `INSERT ... SELECT ... ON CONFLICT DO NOTHING`.

import { sql, type Kysely } from 'kysely';

import type { CommerceDB } from '../db-types';
import { EXPIRY_KEY_PREFIX, PAYMENT_EXPIRY_KIND } from '../payment/expiryJob';
import { RECEIPT_ISSUE_KIND, RECEIPT_KEY_PREFIX } from '../payment/receiptJob';

export interface JobBackfill {
  /** Names it in the log when it fails. */
  name: string;
  run(db: Kysely<CommerceDB>, now: Date): Promise<void>;
}

/**
 * An expiry job for every pending payment that has none: one the old build placed, which only the old sweep would ever
 * close. Goes with that sweep, in slice B3R. A job already written or finished keeps its row.
 */
export const paymentExpiryBackfill: JobBackfill = {
  name: PAYMENT_EXPIRY_KIND,
  async run(db, now) {
    await db
      .insertInto('commerce_job')
      .columns(['id', 'tenant_id', 'kind', 'dedupe_key', 'payload', 'run_at', 'cycle_started_at', 'updated_at'])
      .expression(
        db
          .selectFrom('order_payment')
          .select((eb) => [
            sql<string>`gen_random_uuid()::text`.as('id'),
            'tenant_id',
            eb.val(PAYMENT_EXPIRY_KIND).as('kind'),
            sql<string>`${EXPIRY_KEY_PREFIX} || ${sql.ref('order_id')}`.as('dedupe_key'),
            sql<string>`jsonb_build_object('orderId', ${sql.ref('order_id')})`.as('payload'),
            'expires_at',
            eb.val(now).as('cycle_started_at'),
            eb.val(now).as('updated_at'),
          ])
          .where('status', '=', 'pending'),
      )
      .onConflict((conflict) => conflict.constraint('commerce_job_dedupe_key').doNothing())
      .execute();
  },
};

/**
 * A receipt job for every paid order without a receipt that has none: one paid before receipts were jobs, which relied
 * on Stripe delivering its webhook again. A repeated delivery is a duplicate now and writes no job, so without this such
 * an order would stay without a receipt, silently. Goes in slice B9. A job already written, done or dead keeps its row:
 * a dead receipt waits for a person, not for this.
 */
export const receiptIssueBackfill: JobBackfill = {
  name: RECEIPT_ISSUE_KIND,
  async run(db, now) {
    await db
      .insertInto('commerce_job')
      .columns(['id', 'tenant_id', 'kind', 'dedupe_key', 'payload', 'run_at', 'cycle_started_at', 'updated_at'])
      .expression(
        db
          .selectFrom('order_payment')
          .select((eb) => [
            sql<string>`gen_random_uuid()::text`.as('id'),
            'tenant_id',
            eb.val(RECEIPT_ISSUE_KIND).as('kind'),
            sql<string>`${RECEIPT_KEY_PREFIX} || ${sql.ref('order_id')}`.as('dedupe_key'),
            sql<string>`jsonb_build_object('orderId', ${sql.ref('order_id')})`.as('payload'),
            eb.val(now).as('run_at'),
            eb.val(now).as('cycle_started_at'),
            eb.val(now).as('updated_at'),
          ])
          .where('status', '=', 'paid')
          .where('receipt_document_id', 'is', null),
      )
      .onConflict((conflict) => conflict.constraint('commerce_job_dedupe_key').doNothing())
      .execute();
  },
};

export const JOB_BACKFILLS: readonly JobBackfill[] = [paymentExpiryBackfill, receiptIssueBackfill];

/** Run every backfill on one tenant group. The first failure stops the rest: they all come round again. */
export async function runJobBackfills(
  db: Kysely<CommerceDB>,
  now: Date,
  backfills: readonly JobBackfill[] = JOB_BACKFILLS,
): Promise<void> {
  for (const backfill of backfills) {
    try {
      await backfill.run(db, now);
    } catch (err) {
      throw new Error(`[commerce-job] the backfill ${backfill.name} failed`, { cause: err });
    }
  }
}
