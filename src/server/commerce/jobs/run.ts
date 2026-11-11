import 'server-only';

// src/server/commerce/jobs/run.ts
//
// Running one claimed job (docs/plans/2026-11-02-shop-backbone.md, sections 1.4 to 1.6): parse its payload, give the
// handler a context bound to the job's company and a signal that fires at the kind's deadline, and turn how the
// handler ended into the row's next state. Delivery is at least once, so every kind's handler is idempotent.

import type { Kysely } from 'kysely';

import type { CommerceDB } from '../db-types';
import { deliverShopMail, type OutboxDeps } from '../mail/outbox';
import { outboxDeps } from '../mail/runtime';
import { paymentDeps } from '../payment/deps';
import { handlePaymentEvent, issueReceipt, receiptFailure, type PaymentDeps } from '../payment/payments';
import { claimJob, finishDead, finishDone, finishRerun, finishRetry, type ClaimOptions } from './claim';
import { JOB_KINDS } from './consumers';
import {
  JOB_LEASE_MS,
  JobRefused,
  JobRetryLater,
  type CommerceJob,
  type CompanyContext,
  type JobKind,
  type JobKindRegistry,
  type JobMail,
  type JobPayments,
  type JobPolicy,
  type JobTenantGroup,
} from './types';

const MINUTE_MS = 60 * 1000;
const PAYLOAD_INVALID = 'payload_invalid';
const DEADLINE_EXCEEDED = 'deadline_exceeded';
const LAST_ERROR_MAX = 1000;

export interface JobRunOptions {
  /** The kinds to run. Defaults to the build's registry. */
  kinds?: JobKindRegistry;
  now?: () => Date;
  leaseMs?: number;
  /**
   * The payment wiring of one company (payment/deps.ts paymentDeps). Tests hand in fakes for the Books' contacts and
   * the providers; the worker and the routes use the default.
   */
  paymentDeps?: (group: JobTenantGroup, tenantId: string) => PaymentDeps;
  /**
   * The shop mail wiring of one tenant group (mail/runtime.ts outboxDeps). Tests hand in a fake Lumitra Mail; the worker
   * and the routes use the default.
   */
  mailDeps?: (group: JobTenantGroup) => OutboxDeps;
}

const defaultPaymentDeps = (group: JobTenantGroup, tenantId: string) => paymentDeps(group.db, group.id, tenantId);
const defaultMailDeps = (group: JobTenantGroup) => outboxDeps(group.db, group.id);

/**
 * How one run ended. `fenced`: the lease ran out first, so another worker owns the job and nothing was written.
 * `abandoned`: the handler outlived its lease without answering, so the worker moved on.
 */
export type JobRunOutcome = 'done' | 'rerun' | 'retry' | 'dead' | 'fenced' | 'abandoned';

export interface JobRunResult {
  id: string;
  tenantId: string;
  kind: string;
  outcome: JobRunOutcome;
}

/**
 * The payment state machine for one job: bound to its company, and the row lock's wait to its deadline, so a job
 * blocked on a payment ends as an ordinary retry instead of running out its lease as an open claim.
 */
function jobPayments(
  group: JobTenantGroup,
  tenantId: string,
  kind: JobKind,
  now: () => Date,
  wiring: NonNullable<JobRunOptions['paymentDeps']>,
): JobPayments {
  const deps = { ...wiring(group, tenantId), now, lockWaitMs: kind.policy.deadlineMs };
  return {
    handleEvent: (event) => handlePaymentEvent(deps, { ...event, tenantId }),
    issueReceipt: (orderId) => issueReceipt(deps, tenantId, orderId),
  };
}

/** The buyer's letters for one job: bound to its company, on the worker's clock. */
function jobMail(group: JobTenantGroup, tenantId: string, now: () => Date, wiring: NonNullable<JobRunOptions['mailDeps']>): JobMail {
  const deps = { ...wiring(group), now };
  return { deliver: (orderId, kind) => deliverShopMail(deps, tenantId, orderId, kind) };
}

/** The handler's end, before it is written. */
type Ending =
  | { type: 'done' }
  | { type: 'rerun'; rerunAt: Date; payload?: Record<string, unknown> }
  | { type: 'retry'; reason: string; delayMs?: number }
  | { type: 'refused'; reason: string }
  | { type: 'abandoned' };

/** The wait after a failed attempt (1 is the first). Past the list, the later value. */
export function backoffMs(policy: JobPolicy, attempts: number): number {
  return (policy.backoffMinutes[attempts - 1] ?? policy.laterMinutes) * MINUTE_MS;
}

/**
 * A company's view of a tenant group's handle (see CompanyContext). Each helper names one concrete table so Kysely
 * can check `tenant_id`, which CompanyTable guarantees every table has; the caller gets its own table's types back.
 */
export function companyContext(db: Kysely<CommerceDB>, tenantId: string): CompanyContext {
  return {
    tenantId,
    selectFrom: (table) => db.selectFrom(table as 'commerce_job').where('tenant_id', '=', tenantId) as never,
    updateTable: (table) => db.updateTable(table as 'commerce_job').where('tenant_id', '=', tenantId) as never,
    deleteFrom: (table) => db.deleteFrom(table as 'commerce_job').where('tenant_id', '=', tenantId) as never,
    transaction: (work) => db.transaction().execute((trx) => work(companyContext(trx, tenantId), trx)),
  };
}

/** The handler's run as an Ending. Never rejects, so a handler that answers after being abandoned harms nothing. */
async function invoke(
  group: JobTenantGroup,
  job: CommerceJob,
  kind: JobKind,
  payload: unknown,
  signal: AbortSignal,
  now: () => Date,
  wiring: NonNullable<JobRunOptions['paymentDeps']>,
  mailWiring: NonNullable<JobRunOptions['mailDeps']>,
): Promise<Ending> {
  const where = `${job.kind} ${job.id} of company ${job.tenant_id}`;
  try {
    const answer = await kind.run({
      job: { id: job.id, kind: job.kind, attempts: job.attempts },
      company: companyContext(group.db, job.tenant_id),
      payload,
      signal,
      payments: jobPayments(group, job.tenant_id, kind, now, wiring),
      mail: jobMail(group, job.tenant_id, now, mailWiring),
    });
    if (!answer) return { type: 'done' };
    if (answer.payload === undefined) return { type: 'rerun', rerunAt: answer.rerunAt };
    const next = kind.payload.safeParse(answer.payload);
    if (!next.success) return { type: 'refused', reason: PAYLOAD_INVALID };
    return { type: 'rerun', rerunAt: answer.rerunAt, payload: next.data as Record<string, unknown> };
  } catch (err) {
    if (err instanceof JobRefused) return { type: 'refused', reason: err.reason };
    if (err instanceof JobRetryLater) {
      console.warn(`[commerce-job] ${where} will retry: ${err.reason}`);
      return { type: 'retry', reason: err.reason, delayMs: err.delayMs };
    }
    const reason = receiptFailure(err);
    console.error(`[commerce-job] ${where} failed (${reason}):`, err);
    return { type: 'retry', reason };
  }
}

/** Run the handler under its deadline. A handler that ignores the signal is given up on when its lease ends. */
async function attempt(
  group: JobTenantGroup,
  job: CommerceJob,
  kind: JobKind,
  payload: unknown,
  leaseMs: number,
  now: () => Date,
  wiring: NonNullable<JobRunOptions['paymentDeps']>,
  mailWiring: NonNullable<JobRunOptions['mailDeps']>,
): Promise<Ending> {
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(new JobRetryLater(DEADLINE_EXCEEDED)), kind.policy.deadlineMs);
  let leaseTimer: NodeJS.Timeout | undefined;
  const leaseOver = new Promise<Ending>((resolve) => {
    leaseTimer = setTimeout(() => resolve({ type: 'abandoned' }), leaseMs);
  });
  try {
    return await Promise.race([invoke(group, job, kind, payload, deadline.signal, now, wiring, mailWiring), leaseOver]);
  } finally {
    clearTimeout(deadlineTimer);
    clearTimeout(leaseTimer);
  }
}

/** Write how the run ended, through the fence. */
async function settle(
  db: Kysely<CommerceDB>,
  job: CommerceJob,
  policy: JobPolicy,
  ending: Ending,
  at: Date,
): Promise<JobRunOutcome> {
  const where = `${job.kind} ${job.id} of company ${job.tenant_id}`;
  const die = async (reason: string): Promise<JobRunOutcome> => {
    const stored = reason.slice(0, LAST_ERROR_MAX);
    if (!(await finishDead(db, job, at, stored))) return 'fenced';
    console.error(`[commerce-job] ${where} is dead: ${stored}`);
    return 'dead';
  };
  switch (ending.type) {
    case 'done':
      return (await finishDone(db, job, at)) ? 'done' : 'fenced';
    case 'rerun':
      return (await finishRerun(db, job, at, ending.rerunAt, ending.payload)) ? 'rerun' : 'fenced';
    case 'refused':
      return die(ending.reason);
    case 'abandoned':
      console.error(`[commerce-job] ${where} outlived its lease without answering: left for the next claim`);
      return 'abandoned';
    case 'retry': {
      const { giveUpAfterMs } = policy;
      const cycleMs = at.getTime() - job.cycle_started_at.getTime();
      if (giveUpAfterMs !== null && cycleMs >= giveUpAfterMs) return die(ending.reason);
      const runAt = new Date(at.getTime() + (ending.delayMs ?? backoffMs(policy, job.attempts)));
      return (await finishRetry(db, job, at, runAt, ending.reason.slice(0, LAST_ERROR_MAX))) ? 'retry' : 'fenced';
    }
  }
}

/** Claim one job and run it. */
async function claimAndRun(
  group: JobTenantGroup,
  options: JobRunOptions,
  only?: ClaimOptions['only'],
): Promise<JobRunResult | null> {
  const { kinds = JOB_KINDS, now = () => new Date(), leaseMs = JOB_LEASE_MS, paymentDeps: wiring = defaultPaymentDeps, mailDeps: mailWiring = defaultMailDeps } = options;
  const { db } = group;
  const job = await claimJob(db, { kinds: Object.keys(kinds), now: now(), leaseMs, only });
  if (!job) return null;
  const result = { id: job.id, tenantId: job.tenant_id, kind: job.kind };
  if (job.status === 'dead') {
    console.error(`[commerce-job] ${job.kind} ${job.id} of company ${job.tenant_id} is dead: ${job.last_error}`);
    return { ...result, outcome: 'dead' };
  }
  // The claim's filter means this build knows the kind.
  const kind = kinds[job.kind];
  const payload = kind.payload.safeParse(job.payload);
  const ending = payload.success
    ? await attempt(group, job, kind, payload.data, leaseMs, now, wiring, mailWiring)
    : ({ type: 'refused', reason: PAYLOAD_INVALID } as const);
  return { ...result, outcome: await settle(db, job, kind.policy, ending, now()) };
}

/** Claim the oldest due job of the tenant group and run it. Null when nothing is due. */
export function runNextJob(group: JobTenantGroup, options: JobRunOptions = {}): Promise<JobRunResult | null> {
  return claimAndRun(group, options);
}

/**
 * The first attempt after a commit: the same claim, narrowed to one job, so it and the poller cannot both run it.
 * Null when the job is not due, or another worker holds it.
 */
export function runJobNow(
  group: JobTenantGroup,
  tenantId: string,
  jobId: string,
  options: JobRunOptions = {},
): Promise<JobRunResult | null> {
  return claimAndRun(group, options, { tenantId, id: jobId });
}
