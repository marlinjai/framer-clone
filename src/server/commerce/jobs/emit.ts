import 'server-only';

// src/server/commerce/jobs/emit.ts
//
// Writing work in the same transaction as the change that needs it (docs/plans/2026-11-02-shop-backbone.md, section
// 1.3). Commit means the jobs exist, rollback means they do not, and a worker cannot see them earlier. Both functions
// take a Transaction, not a Kysely: a plain handle does not type-check, so a job can never be written beside its data.

import { randomUUID } from 'node:crypto';

import type { Transaction } from 'kysely';

import { toJsonb } from '../../books/snapshots';
import type { CommerceDB } from '../db-types';
import { COMMERCE_CONSUMERS } from './consumers';
import type { CommerceEvent, CommerceEventType, ConsumerRegistry, ScheduledJob } from './types';

/**
 * Write one job, once per company, kind and dedupe key. Answers its id, or null when the key already has a job, so
 * a repeated emission cannot double the work. Emit only where the change really happened: inside a transition under
 * the row lock, or after checking the update count.
 */
export async function scheduleJob(trx: Transaction<CommerceDB>, job: ScheduledJob): Promise<string | null> {
  const written = await trx
    .insertInto('commerce_job')
    .values({
      id: randomUUID(),
      tenant_id: job.tenantId,
      kind: job.kind,
      dedupe_key: job.dedupeKey,
      event_type: job.eventType ?? null,
      payload: toJsonb(job.payload),
      run_at: job.runAt,
      cycle_started_at: job.at,
      updated_at: job.at,
    })
    .onConflict((conflict) => conflict.constraint('commerce_job_dedupe_key').doNothing())
    .returning('id')
    .executeTakeFirst();
  return written?.id ?? null;
}

/** Write the jobs of an event's consumers. Answers the ids it wrote, for the first attempt after the commit. */
export async function emitCommerceEvent<E extends CommerceEventType>(
  trx: Transaction<CommerceDB>,
  event: CommerceEvent<E>,
  consumers: ConsumerRegistry = COMMERCE_CONSUMERS,
): Promise<string[]> {
  const ids: string[] = [];
  for (const consumer of consumers[event.type]) {
    const id = await consumer.enqueue(trx, event);
    if (id !== null) ids.push(id);
  }
  return ids;
}
