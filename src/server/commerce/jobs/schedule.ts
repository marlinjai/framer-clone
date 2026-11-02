import 'server-only';

// src/server/commerce/jobs/schedule.ts
//
// Writing one job in the caller's transaction (docs/plans/2026-11-02-shop-backbone.md, section 1.3). Apart from emit.ts
// because the consumers call it: emit.ts imports the registry, so a consumer importing emit.ts would load the registry
// before the consumer itself exists.

import { randomUUID } from 'node:crypto';

import type { Transaction } from 'kysely';

import { toJsonb } from '../../books/snapshots';
import type { CommerceDB } from '../db-types';
import type { ScheduledJob } from './types';

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
