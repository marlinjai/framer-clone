import 'server-only';

// src/server/commerce/jobs/claim.ts
//
// Taking and ending a lease on one job (docs/plans/2026-11-02-shop-backbone.md, sections 1.4 and 1.5). The work runs
// outside any transaction, so `FOR UPDATE SKIP LOCKED` alone is not a claim: a claim is one short statement that
// moves the row to `running` with a token and a lease in `run_at`. One job at a time, so a lease starts when its job
// does. Every finish is conditional on the token, so a worker that outlived its lease changes nothing.

import { randomUUID } from 'node:crypto';

import type { Kysely, UpdateObject } from 'kysely';

import { toJsonb } from '../../books/snapshots';
import type { CommerceDB } from '../db-types';
import { JOB_LEASE_MS, MAX_OPEN_CLAIMS, type CommerceJob } from './types';

/** Stored when the claim itself kills a job that kept dying with its process. */
export const CLAIMED_REPEATEDLY = 'claimed repeatedly without finishing';

export interface ClaimOptions {
  /** The kinds this build can run: a job of any other kind stays untouched. */
  kinds: readonly string[];
  now: Date;
  leaseMs?: number;
  /** Narrows the claim to one job (`runJobNow`). */
  only?: { tenantId: string; id: string };
}

/** The claim as one statement. `MATERIALIZED` keeps the planner from re-evaluating the `LIMIT` of the selection. */
export function claimQuery(db: Kysely<CommerceDB>, options: ClaimOptions) {
  const { kinds, now, leaseMs = JOB_LEASE_MS, only } = options;
  const token = randomUUID();
  return db
    .with(
      (cte) => cte('due').materialized(),
      (query) => {
        const due = query
          .selectFrom('commerce_job')
          .select(['tenant_id', 'id'])
          .where('status', 'in', ['pending', 'running'])
          .where('run_at', '<=', now)
          .where('kind', 'in', [...kinds]);
        const narrowed = only ? due.where('tenant_id', '=', only.tenantId).where('id', '=', only.id) : due;
        return narrowed.orderBy('run_at').orderBy('id').limit(1).forUpdate().skipLocked();
      },
    )
    .updateTable('commerce_job as j')
    .from('due')
    .set((eb) => {
      const tooMany = () => eb.case().when('j.open_claims', '>=', MAX_OPEN_CLAIMS);
      return {
        status: tooMany().then('dead' as const).else('running' as const).end(),
        finished_at: tooMany().then(now).end(),
        last_error: tooMany().then(CLAIMED_REPEATEDLY).else(eb.ref('j.last_error')).end(),
        claim_token: tooMany().then(null).else(token).end(),
        attempts: eb('j.attempts', '+', 1),
        open_claims: eb('j.open_claims', '+', 1),
        run_at: new Date(now.getTime() + leaseMs),
        updated_at: now,
      };
    })
    .whereRef('j.tenant_id', '=', 'due.tenant_id')
    .whereRef('j.id', '=', 'due.id')
    .returningAll('j');
}

/**
 * Claim the oldest due job: one that is pending, or running with its lease over. Answers it `running` with a new
 * `claim_token`, or `dead` when it had too many open claims (the caller must not run it), or null when nothing is due.
 */
export async function claimJob(db: Kysely<CommerceDB>, options: ClaimOptions): Promise<CommerceJob | null> {
  if (options.kinds.length === 0) return null;
  return (await claimQuery(db, options).executeTakeFirst()) ?? null;
}

/** End a lease. False when the token is no longer this job's: the lease ran out, and the change is dropped. */
async function finish(
  db: Kysely<CommerceDB>,
  job: CommerceJob,
  at: Date,
  values: UpdateObject<CommerceDB, 'commerce_job'>,
): Promise<boolean> {
  const { claim_token: token } = job;
  if (token === null) throw new Error(`[commerce-job] job ${job.id} was not claimed`);
  const result = await db
    .updateTable('commerce_job')
    .set({ ...values, claim_token: null, open_claims: 0, updated_at: at })
    .where('tenant_id', '=', job.tenant_id)
    .where('id', '=', job.id)
    .where('claim_token', '=', token)
    .executeTakeFirst();
  if (result.numUpdatedRows === BigInt(0)) {
    console.warn(`[commerce-job] ${job.kind} ${job.id} of company ${job.tenant_id} outlived its lease: its finish was dropped`);
    return false;
  }
  return true;
}

export function finishDone(db: Kysely<CommerceDB>, job: CommerceJob, at: Date): Promise<boolean> {
  return finish(db, job, at, { status: 'done', finished_at: at, last_error: null });
}

/** Back to `pending` for a recurring job or a date that moved: a new give-up cycle, counters at zero. */
export function finishRerun(
  db: Kysely<CommerceDB>,
  job: CommerceJob,
  at: Date,
  rerunAt: Date,
  payload?: Record<string, unknown>,
): Promise<boolean> {
  return finish(db, job, at, {
    status: 'pending',
    run_at: rerunAt,
    attempts: 0,
    cycle_started_at: at,
    last_error: null,
    ...(payload === undefined ? {} : { payload: toJsonb(payload) }),
  });
}

export function finishRetry(
  db: Kysely<CommerceDB>,
  job: CommerceJob,
  at: Date,
  runAt: Date,
  lastError: string,
): Promise<boolean> {
  return finish(db, job, at, { status: 'pending', run_at: runAt, last_error: lastError });
}

export function finishDead(db: Kysely<CommerceDB>, job: CommerceJob, at: Date, lastError: string): Promise<boolean> {
  return finish(db, job, at, { status: 'dead', finished_at: at, last_error: lastError });
}

/** A person's retry of a dead job: `pending` with fresh counters. False when the company has no such dead job. */
export async function requeueJob(
  db: Kysely<CommerceDB>,
  tenantId: string,
  id: string,
  at: Date = new Date(),
): Promise<boolean> {
  const result = await db
    .updateTable('commerce_job')
    .set({
      status: 'pending',
      run_at: at,
      attempts: 0,
      open_claims: 0,
      cycle_started_at: at,
      last_error: null,
      acknowledged_at: null,
      finished_at: null,
      updated_at: at,
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', id)
    .where('status', '=', 'dead')
    .executeTakeFirst();
  return result.numUpdatedRows > BigInt(0);
}

/** A person has seen a dead job nobody should retry. False when the company has no such unacknowledged job. */
export async function acknowledgeJob(
  db: Kysely<CommerceDB>,
  tenantId: string,
  id: string,
  at: Date = new Date(),
): Promise<boolean> {
  const result = await db
    .updateTable('commerce_job')
    .set({ acknowledged_at: at, updated_at: at })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', id)
    .where('status', '=', 'dead')
    .where('acknowledged_at', 'is', null)
    .executeTakeFirst();
  return result.numUpdatedRows > BigInt(0);
}
