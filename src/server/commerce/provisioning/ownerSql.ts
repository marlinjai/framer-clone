// src/server/commerce/provisioning/ownerSql.ts
//
// The one way commerce code opens an OWNER session (commerce_ddl,
// COMMERCE_OWNER_DATABASE_URL): a single postgres.js connection outside any
// pool, with BOUNDED lock waits. Postgres applies `lock_timeout` to every lock
// wait, advisory locks included, so a session stuck behind another container's
// migration lock, a provision or a table lock fails with a named error instead
// of hanging the container start (and Coolify's health check) or a
// project-create request.
//
// The timeouts are set with `set_config(...)` right after connecting, NOT as
// startup parameters: PgBouncer refuses unknown startup parameters unless it is
// configured to ignore them. The owner URL must still be a DIRECT connection
// (or a session-mode pooler): session advisory locks and session settings do not
// survive a transaction-mode pooler. `max_lifetime: null` keeps postgres.js from
// silently replacing the connection mid-run, which would drop both.
//
// Budgets, each sized to what waits on it:
//
//   BOOT_LOCK_TIMEOUTS (the start step's lock session): lock 30 s, statement
//     35 s (the statement budget must exceed the lock wait, or the wait would be
//     cancelled as a statement first). Coolify marks a new container unhealthy
//     when /api/health does not answer within its health-check window (start
//     period plus interval times retries; Coolify's defaults of 5 s, 5 s and 10
//     give about a minute), and the deploy workflow polls /api/health/db for at
//     most 180 s. Waiting up to 30 s for another container's start step fits.
//   migrationTimeouts() (the sessions that run the public and tenant
//     migrations at start): lock 5 s, statement unlimited by default. A
//     migration's DDL needs table locks the OLD container's storefront traffic
//     also takes; a short lock wait makes the migration give up (and the start
//     fail, retryably) instead of queueing an exclusive lock that stalls every
//     shop request behind it. A legitimate long migration (a backfill, an index
//     build) must not be killed by a fixed budget, so statements are unlimited
//     unless COMMERCE_MIGRATE_STATEMENT_TIMEOUT_MS sets a bound. A start that
//     runs longer than Coolify's health-check window needs that window raised
//     for the deploy.
//   PROVISION_TIMEOUTS (a company's first project, inline in the HTTP request):
//     lock 10 s, statement 30 s, queue 30 s (so at most 40 s in all, the last
//     wait running its full 10 s). A provision takes well under a
//     second when nobody else holds the lock. Every provision queues behind one
//     global lock, so with several companies at once a fixed wait would fail a
//     request whose queue is moving fine (it did, under load, with four). The
//     wait is therefore sized to the queue: `lockTimeoutMs` bounds how long ONE
//     holder may keep the lock while we wait (longer is a stuck provision: fail
//     fast with a retryable error), and as long as the holder keeps changing
//     the queue is moving and we keep waiting, up to `queueWaitMs` in all. A
//     waiter that times out rejoins at the back of the queue: right for a burst
//     of companies at once (the incident); under arrivals that never stop it
//     fails at `queueWaitMs`, retryably. A holder is told apart by its pid AND
//     a name it sets when it takes the lock (a session-mode pooler can hand the
//     same backend to the next client). A stuck holder is noticed within two
//     waits at most (one when the holder was known when the wait began).

import { randomUUID } from 'node:crypto';

import postgres from 'postgres';

export interface OwnerTimeouts {
  /**
   * Longest wait for any lock, advisory locks included (ms). For an advisory
   * lock taken with a `queueWaitMs`, the longest one holder may keep it while
   * we wait.
   */
  lockTimeoutMs: number;
  /** Longest any single statement may run (ms); 0 means no limit. */
  statementTimeoutMs: number;
  /**
   * Advisory locks only: keep waiting while the queue moves (the holder
   * changes within each `lockTimeoutMs`), starting no new wait after this long
   * (ms), so the whole wait is at most this plus one `lockTimeoutMs`. Unset:
   * one bounded wait of `lockTimeoutMs`.
   */
  queueWaitMs?: number;
}

/** The start step's lock session. See the module comment. */
export const BOOT_LOCK_TIMEOUTS: OwnerTimeouts = { lockTimeoutMs: 30_000, statementTimeoutMs: 35_000 };

/** First-project provisioning inside a request. See the module comment. */
export const PROVISION_TIMEOUTS: OwnerTimeouts = { lockTimeoutMs: 10_000, statementTimeoutMs: 30_000, queueWaitMs: 30_000 };

/** Lock wait for DDL inside the start-time migrations. See the module comment. */
export const MIGRATION_LOCK_TIMEOUT_MS = 5_000;

/** Optional bound on each start-time migration statement (ms); unset or 0: none. */
export const MIGRATE_STATEMENT_TIMEOUT_ENV = 'COMMERCE_MIGRATE_STATEMENT_TIMEOUT_MS';

/**
 * Timeouts for the sessions that run the start-time migrations: a short lock
 * wait, and a statement bound only when COMMERCE_MIGRATE_STATEMENT_TIMEOUT_MS
 * is set.
 *
 * @throws Error naming the variable when it is set to anything but a whole,
 *   non-negative number of milliseconds (a typo must not silently mean "none").
 */
export function migrationTimeouts(env: Record<string, string | undefined> = process.env): OwnerTimeouts {
  const raw = env[MIGRATE_STATEMENT_TIMEOUT_ENV]?.trim();
  let statementTimeoutMs = 0;
  if (raw) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(
        `${MIGRATE_STATEMENT_TIMEOUT_ENV} must be a whole number of milliseconds (0 for no limit), got "${raw}".`,
      );
    }
    statementTimeoutMs = n;
  }
  return { lockTimeoutMs: MIGRATION_LOCK_TIMEOUT_MS, statementTimeoutMs };
}

/**
 * Open a single-connection OWNER session and set its bounded waits with
 * `set_config` (session scope) before returning it. `prepare: false` keeps it
 * pooler-safe; the caller ends it in a `finally`.
 */
export async function openOwnerSql(connectionString: string, timeouts: OwnerTimeouts): Promise<postgres.Sql> {
  const sql = postgres(connectionString, { max: 1, prepare: false, max_lifetime: null });
  try {
    await sql`
      SELECT set_config('lock_timeout', ${`${timeouts.lockTimeoutMs}ms`}, false),
             set_config('statement_timeout', ${`${timeouts.statementTimeoutMs}ms`}, false),
             set_config('application_name', 'framer-clone-commerce-owner', false)
    `;
  } catch (err) {
    await sql.end();
    throw err;
  }
  return sql;
}

/** A commerce advisory lock was not granted within the lock timeout (or the queue stopped moving). */
export class CommerceLockTimeoutError extends Error {
  constructor(what: string, timeoutMs: number, options?: { cause?: unknown; queued?: boolean }) {
    super(
      options?.queued
        ? `${what}: lock not granted within ${timeoutMs} ms of queueing. Other processes kept it ` +
            'busy the whole time; retry in a moment.'
        : `${what}: lock not granted within ${timeoutMs} ms (lock_timeout). Another ` +
            'process holds it; check for a stuck container start or provision, then retry.',
      options,
    );
    this.name = 'CommerceLockTimeoutError';
  }
}

/** Postgres `lock_not_available` (55P03): what lock_timeout raises. */
export function isLockTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '55P03';
}

/**
 * Take a session advisory lock on `sql`, bounded by the session's lock_timeout.
 * Logs once when the lock is busy (so a queued start is visible), then waits.
 * With `timeouts.queueWaitMs`, a wait that times out while the lock changed
 * hands (the queue moves) is started again, until `queueWaitMs` has passed;
 * one holder keeping the lock for a whole wait (stuck) fails at once.
 *
 * @throws CommerceLockTimeoutError when one holder outlasts a wait, or the
 *   queue outlasts `queueWaitMs`.
 */
export async function acquireAdvisoryLock(
  sql: postgres.Sql,
  key: number,
  what: string,
  timeouts: OwnerTimeouts,
  onBusy?: () => void,
): Promise<void> {
  const [{ locked }] = await sql<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${key}) AS locked`;
  if (locked) return markHolder(sql);
  onBusy?.();
  const started = Date.now();
  let holder = await advisoryLockHolder(sql, key);
  for (;;) {
    try {
      await sql`SELECT pg_advisory_lock(${key})`;
      return markHolder(sql);
    } catch (err) {
      if (!isLockTimeout(err)) throw err;
      if (timeouts.queueWaitMs === undefined) throw new CommerceLockTimeoutError(what, timeouts.lockTimeoutMs, { cause: err });
      // The queue moved when the lock changed hands (or was free a moment) during this wait.
      const current = await advisoryLockHolder(sql, key);
      const moved = holder === null || current === null || current !== holder;
      if (!moved) throw new CommerceLockTimeoutError(what, timeouts.lockTimeoutMs, { cause: err });
      const waited = Date.now() - started;
      if (waited >= timeouts.queueWaitMs) throw new CommerceLockTimeoutError(what, waited, { cause: err, queued: true });
      holder = current;
    }
  }
}

/**
 * Give this session an identity of its own while it holds a lock: behind a
 * session-mode pooler the next client can get the same server backend (the
 * same pid) right after the previous holder left, so a waiter compares the pid
 * AND this name, and sees a new holder as one.
 */
async function markHolder(sql: postgres.Sql): Promise<void> {
  await sql`SELECT set_config('application_name', ${`framer-clone-commerce-owner:${randomUUID()}`}, false)`;
}

/**
 * Who holds a session advisory lock on `key` in this database (null when
 * nobody does): the backend pid and its application name (see markHolder).
 * `pg_advisory_lock(bigint)` keys are stored as their high and low 32 bits in
 * classid and objid, with objsubid 1.
 */
async function advisoryLockHolder(sql: postgres.Sql, key: number): Promise<string | null> {
  const rows = await sql<{ holder: string }[]>`
    SELECT l.pid::text || ':' || COALESCE(a.application_name, '') AS holder
      FROM pg_locks l
      LEFT JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE l.locktype = 'advisory' AND l.objsubid = 1 AND l.granted
       AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND ((l.classid::bigint << 32) | l.objid::bigint) = ${key}::bigint
     LIMIT 1
  `;
  return rows[0]?.holder ?? null;
}

/** Release a session advisory lock; never masks the caller's own error. */
export async function releaseAdvisoryLock(sql: postgres.Sql, key: number): Promise<void> {
  // Ending the session releases it too, so a failure here (a broken connection)
  // is not worth surfacing over the real outcome.
  await sql`SELECT pg_advisory_unlock(${key})`.catch(() => undefined);
}
