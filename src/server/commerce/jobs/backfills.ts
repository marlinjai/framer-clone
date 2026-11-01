import 'server-only';

// src/server/commerce/jobs/backfills.ts
//
// Work that exists as a row but not yet as a job (docs/plans/2026-11-02-shop-backbone.md, section 1.10). A migration
// cannot do this: it runs in the new container while the old one still writes rows. So the worker runs each backfill
// itself, per tenant group, on its first pass and then hourly, and each one is an idempotent
// `INSERT ... SELECT ... ON CONFLICT DO NOTHING`. Empty until the slices that move work onto the engine.

import type { Kysely } from 'kysely';

import type { CommerceDB } from '../db-types';

export interface JobBackfill {
  /** Names it in the log when it fails. */
  name: string;
  run(db: Kysely<CommerceDB>, now: Date): Promise<void>;
}

export const JOB_BACKFILLS: readonly JobBackfill[] = [];

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
