import 'server-only';

// src/server/commerce/jobs/runtime.ts
//
// The job engine as the running server uses it (docs/plans/2026-11-02-shop-backbone.md, section 1.7): one pass over
// every tenant group, the timer that repeats it in each server process, and the report the watchdog route answers.
// Any number of processes can run this at once: the claim hands each job to one of them.
//
// The groups come from `public.tenant_groups`, never from `site`: a group whose last site was deleted can still have
// a refund queued. Every status is read. `suspended` stops new provisioning, not a shop that is selling (the order and
// pay routes do not check it), so its jobs still run; a `provisioning` group has no schema or table yet and is skipped.
//
// Shutting down: a signal stops the timer and the claiming, so nothing new starts while Next finishes its requests.
// Next then exits without waiting for this worker, so a handler still running is cut off, and its job becomes due again
// when its lease ends. That counts as one open claim, as any crash does.

import type { Kysely } from 'kysely';

import { commerceTenantDbChecked, ensureCommerceBackstop, getCommerceBase, isCommerceTenantNotProvisioned } from '../db';
import type { CommerceDB } from '../db-types';
import { isTenantSchemaError } from '../tenant';
import { JOB_BACKFILLS, runJobBackfills, type JobBackfill } from './backfills';
import { runNextJob, type JobRunOptions } from './run';
import type { JobTenantGroup } from './types';
import { countUnissuedReceipts } from '../payment/unissuedReceipts';

const PASS_EVERY_MS = 30_000;
/** How many tenant groups a pass works on at a time. */
const GROUPS_AT_ONCE = 4;
/** Jobs per tenant group per pass, so a backlog in one group leaves room for the others. */
const JOBS_PER_GROUP = 20;
/** A pass over this logs a warning: section 1.7's sign that the scan by group needs replacing. */
const SLOW_PASS_MS = 20_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const KEEP_DONE_MS = 90 * DAY_MS;
const DONE_DELETED_PER_GROUP = 500;
/** How long a signal waits for the pass in hand when nothing else ends the process. */
const DRAIN_MS = 25_000;
const SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export interface CommercePassOptions extends JobRunOptions {
  /** The backfills to run. Defaults to the build's list. */
  backfills?: readonly JobBackfill[];
}

/** One pass's answer. `failed`: tenant groups that could not be worked on; a job's own failure is the job's state. */
export interface CommercePassSummary {
  tenantGroups: number;
  /** Tenant groups without a schema or the job table: nothing to run. */
  skipped: number;
  ran: number;
  failed: number;
}

/** What the watchdog route answers. */
export interface CommerceJobReport extends CommercePassSummary {
  /** A count, never a failure: a dead row stays, so a red monitor would hide the next real fault. */
  deadUnacknowledged: number;
  /** Always 0 until B8 adds `payment_finding` and reconciliation: there is nothing to count before that. */
  findingsOpen: number;
  /** How late the oldest due job is, 0 with nothing due. Includes kinds this build does not know. */
  oldestDueSeconds: number;
  /**
   * Stripe payments without an invoice that no live job will issue, or that were paid over an hour ago whatever their
   * job does (payment/unissuedReceipts.ts): money taken with no receipt, for a person to look at. A count, like the dead
   * jobs, so the route stays 200 for the other monitors.
   */
  receiptsUnissued: number;
  /**
   * "ok", or "unissued" while `receiptsUnissued` is above 0. The field an Uptime Kuma keyword monitor matches
   * (`"receipts":"ok"`), so a paid order left without its invoice turns that monitor red.
   */
  receipts: 'ok' | 'unissued';
}

interface CommerceWorker {
  timer: NodeJS.Timeout;
  /** The pass in hand, which is also what keeps two from overlapping. */
  pass: Promise<void> | null;
  onSignal: Partial<Record<NodeJS.Signals, () => void>>;
  /** The last failure logged, so an outage logs once and not every 30 seconds. */
  lastFailure: string | null;
}

// Next builds instrumentation and each route as separate bundles, so a module variable would not be shared with the
// route's passes, and a dev reload would start a second timer.
const globalForJobs = globalThis as unknown as {
  __commerceJobWorker?: CommerceWorker;
  __commerceJobsStopping?: boolean;
  __commerceJobHourly?: Map<string, number>;
};

type GroupSummary = Pick<CommercePassSummary, 'tenantGroups' | 'skipped' | 'failed'>;

/** A group whose schema exists from before the job table: `isCommerceTenantNotProvisioned` cannot see this one. */
function isJobTableMissing(err: unknown): boolean {
  return /relation "[^"]*commerce_job" does not exist/.test(String(err));
}

/**
 * Run `work` on every tenant group, at most GROUPS_AT_ONCE at a time. One group failing never stops the others. A
 * group is skipped only for what makes it empty; anything else is logged and counted.
 */
async function forEachTenantGroup(
  label: string,
  work: (group: JobTenantGroup) => Promise<void>,
): Promise<GroupSummary> {
  await ensureCommerceBackstop();
  const groups = await getCommerceBase().selectFrom('public.tenant_groups').select('id').execute();
  const summary: GroupSummary = { tenantGroups: 0, skipped: 0, failed: 0 };
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < groups.length) {
      const tenantGroupId = groups[next].id;
      next += 1;
      try {
        await work({ id: tenantGroupId, db: await commerceTenantDbChecked(tenantGroupId) });
        summary.tenantGroups += 1;
      } catch (err) {
        if (isCommerceTenantNotProvisioned(err) || isTenantSchemaError(err) || isJobTableMissing(err)) {
          summary.skipped += 1;
        } else {
          console.error(`[commerce-job] ${label} of tenant group ${tenantGroupId} failed:`, err);
          summary.failed += 1;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(GROUPS_AT_ONCE, groups.length) }, lane));
  return summary;
}

/** Delete the oldest `done` jobs past retention. A dedupe key concerns one order or checkout, so none can recur. */
async function deleteOldDoneJobs(db: Kysely<CommerceDB>, now: Date): Promise<void> {
  await db
    .deleteFrom('commerce_job')
    .where(({ eb, refTuple, selectFrom }) =>
      eb(
        refTuple('tenant_id', 'id'),
        'in',
        selectFrom('commerce_job')
          .select(['tenant_id', 'id'])
          .where('status', '=', 'done')
          .where('finished_at', '<', new Date(now.getTime() - KEEP_DONE_MS))
          .orderBy('finished_at')
          .limit(DONE_DELETED_PER_GROUP)
          .$asTuple('tenant_id', 'id'),
      ),
    )
    .execute();
}

/** The hourly duties, on a group's first pass in this process and then once an hour. A failure tries again next pass. */
async function runHourlyDuties(
  db: Kysely<CommerceDB>,
  tenantGroupId: string,
  now: Date,
  backfills: readonly JobBackfill[],
): Promise<void> {
  const hourly = (globalForJobs.__commerceJobHourly ??= new Map());
  const last = hourly.get(tenantGroupId);
  if (last !== undefined && now.getTime() - last < HOUR_MS) return;
  await deleteOldDoneJobs(db, now);
  await runJobBackfills(db, now, backfills);
  hourly.set(tenantGroupId, now.getTime());
}

/** One pass: the due jobs of every tenant group, one by one, so each lease starts when its job does. */
export async function runCommercePass(options: CommercePassOptions = {}): Promise<CommercePassSummary> {
  const { backfills = JOB_BACKFILLS, now = () => new Date() } = options;
  const startedAt = Date.now();
  let ran = 0;
  const groups = await forEachTenantGroup('the pass', async (group) => {
    if (globalForJobs.__commerceJobsStopping) return;
    // Before the claims, so what a backfill writes can run in this pass. Its failure must not hold up jobs already due.
    const duties = await Promise.allSettled([runHourlyDuties(group.db, group.id, now(), backfills)]);
    for (let jobs = 0; jobs < JOBS_PER_GROUP && !globalForJobs.__commerceJobsStopping; jobs += 1) {
      if (!(await runNextJob(group, options))) break;
      ran += 1;
    }
    if (duties[0].status === 'rejected') throw duties[0].reason;
  });
  const ms = Date.now() - startedAt;
  const line = `[commerce-job] pass: ${groups.tenantGroups} groups, ${groups.skipped} skipped, ${ran} ran, ${groups.failed} failed, ${ms} ms`;
  if (ms > SLOW_PASS_MS) console.warn(`${line}: over the ${SLOW_PASS_MS} ms a pass should take`);
  else console.info(line);
  return { ...groups, ran };
}

/** One pass, then what the watchdog needs to know. Separate from the pass: the poller has no use for these reads. */
export async function runCommerceWatchdogPass(options: CommercePassOptions = {}): Promise<CommerceJobReport> {
  const { now = () => new Date() } = options;
  const pass = await runCommercePass(options);
  const at = now();
  let deadUnacknowledged = 0;
  let receiptsUnissued = 0;
  let oldestDueMs = Infinity;
  const read = await forEachTenantGroup('the watchdog read', async ({ db }) => {
    const dead = await db
      .selectFrom('commerce_job')
      .select((eb) => eb.fn.countAll<string>().as('jobs'))
      .where('status', '=', 'dead')
      .where('acknowledged_at', 'is', null)
      .executeTakeFirstOrThrow();
    const due = await db
      .selectFrom('commerce_job')
      .select('run_at')
      .where('status', 'in', ['pending', 'running'])
      .where('run_at', '<=', at)
      .orderBy('run_at')
      .limit(1)
      .executeTakeFirst();
    deadUnacknowledged += Number(dead.jobs);
    receiptsUnissued += await countUnissuedReceipts(db, at);
    if (due) oldestDueMs = Math.min(oldestDueMs, due.run_at.getTime());
  });
  return {
    ...pass,
    // A group that fails usually fails both, so this counts it once. At least the number of groups that failed.
    failed: Math.max(pass.failed, read.failed),
    deadUnacknowledged,
    findingsOpen: 0,
    oldestDueSeconds: oldestDueMs === Infinity ? 0 : Math.floor((at.getTime() - oldestDueMs) / 1000),
    receiptsUnissued,
    // A group whose read failed is counted in `failed`, which turns the route 500 on its own.
    receipts: receiptsUnissued > 0 ? 'unissued' : 'ok',
  };
}

/** A timer tick: a pass, unless the last is still running. A failing pass is logged and the next tick tries again. */
function tick(worker: CommerceWorker, options: CommercePassOptions): void {
  if (worker.pass) return;
  worker.pass = runCommercePass(options)
    .then(
      () => {
        worker.lastFailure = null;
      },
      (err: unknown) => {
        const failure = String(err);
        if (failure !== worker.lastFailure) console.error('[commerce-job] the pass failed:', err);
        worker.lastFailure = failure;
      },
    )
    .finally(() => {
      worker.pass = null;
    });
}

/**
 * Start the poller once per server process (instrumentation.ts). Only when commerce is configured. The first pass
 * comes one interval after the start, so it never competes with booting and a database outage cannot delay it.
 */
export function startCommerceWorker(options: CommercePassOptions & { everyMs?: number } = {}): void {
  if (globalForJobs.__commerceJobWorker) return;
  if (!process.env.COMMERCE_APP_DATABASE_URL?.trim()) {
    console.warn('[commerce-job] COMMERCE_APP_DATABASE_URL is not set: the poller does not run');
    return;
  }
  const { everyMs = PASS_EVERY_MS, ...passOptions } = options;
  globalForJobs.__commerceJobsStopping = false;
  const worker: CommerceWorker = {
    timer: setInterval(() => tick(worker, passOptions), everyMs),
    pass: null,
    onSignal: {},
    lastFailure: null,
  };
  worker.timer.unref?.();
  for (const signal of SIGNALS) {
    const onSignal = () => {
      // Next's own listener ends the process. Alone here, this listener has replaced the default exit, so it re-raises.
      void stopCommerceWorker().finally(() => {
        if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
      });
    };
    worker.onSignal[signal] = onSignal;
    process.once(signal, onSignal);
  }
  globalForJobs.__commerceJobWorker = worker;
}

/** Stop the timer and the claiming, and wait for the pass in hand, at most DRAIN_MS. */
export async function stopCommerceWorker(): Promise<void> {
  const worker = globalForJobs.__commerceJobWorker;
  if (!worker) return;
  globalForJobs.__commerceJobWorker = undefined;
  globalForJobs.__commerceJobsStopping = true;
  clearInterval(worker.timer);
  for (const signal of SIGNALS) {
    const onSignal = worker.onSignal[signal];
    if (onSignal) process.removeListener(signal, onSignal);
  }
  let drainTimer: NodeJS.Timeout | undefined;
  await Promise.race([
    worker.pass,
    new Promise((resolve) => {
      drainTimer = setTimeout(resolve, DRAIN_MS);
      drainTimer.unref?.();
    }),
  ]);
  clearTimeout(drainTimer);
}
