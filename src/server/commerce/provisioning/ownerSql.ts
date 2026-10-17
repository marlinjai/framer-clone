// src/server/commerce/provisioning/ownerSql.ts
//
// The one way commerce code opens an OWNER session (commerce_ddl,
// COMMERCE_OWNER_DATABASE_URL): a single direct postgres.js connection outside
// any pool, with BOUNDED waits. Postgres applies `lock_timeout` to every lock
// wait, advisory locks included, and `statement_timeout` to every statement, so
// a session stuck behind another container's migration lock, a hung provision
// or a long table lock fails with a named error instead of hanging the
// container start (and Coolify's health check) or a project-create request
// forever.
//
// Two budgets, each sized to what waits on it:
//
//   BOOT_TIMEOUTS (container start, deploy/boot.sh): lock 30 s, statement 45 s.
//     Coolify marks a new container unhealthy when /api/health does not answer
//     within its health-check window (start period plus interval times retries;
//     Coolify defaults of 5 s, 5 s and 10 give about a minute), and the deploy workflow polls
//     /api/health/db for at most 180 s. A start step that waits up to 30 s for
//     another container's lock and then migrates still fits the minute; one
//     that would wait longer fails the start with a clear log line instead of
//     timing out silently in the health check.
//   PROVISION_TIMEOUTS (a company's first project, inline in the HTTP request):
//     lock 10 s, statement 30 s. A provision takes well under a second when
//     nobody else holds the lock; ten seconds of queueing behind other
//     provisions is the most a person should wait on "New project" before
//     seeing a retryable error.

import postgres from 'postgres';

export interface OwnerTimeouts {
  /** Longest wait for any lock, advisory locks included (ms). */
  lockTimeoutMs: number;
  /** Longest any single statement may run (ms). */
  statementTimeoutMs: number;
}

/** Container start: public tier plus fleet. See the module comment. */
export const BOOT_TIMEOUTS: OwnerTimeouts = { lockTimeoutMs: 30_000, statementTimeoutMs: 45_000 };

/** First-project provisioning inside a request. See the module comment. */
export const PROVISION_TIMEOUTS: OwnerTimeouts = { lockTimeoutMs: 10_000, statementTimeoutMs: 30_000 };

/**
 * Open a single-connection OWNER session with the given bounded waits.
 * `prepare: false` keeps it pooler-safe; the caller ends it in a `finally`.
 */
export function openOwnerSql(connectionString: string, timeouts: OwnerTimeouts): postgres.Sql {
  return postgres(connectionString, {
    max: 1,
    prepare: false,
    connection: {
      lock_timeout: timeouts.lockTimeoutMs,
      statement_timeout: timeouts.statementTimeoutMs,
      application_name: 'framer-clone-commerce-owner',
    },
  });
}

/** A commerce advisory lock was not granted within the lock timeout. */
export class CommerceLockTimeoutError extends Error {
  constructor(what: string, timeoutMs: number, options?: { cause?: unknown }) {
    super(
      `${what}: lock not granted within ${timeoutMs} ms (lock_timeout). Another ` +
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
 *
 * @throws CommerceLockTimeoutError when the wait exceeds the lock timeout.
 */
export async function acquireAdvisoryLock(
  sql: postgres.Sql,
  key: number,
  what: string,
  timeouts: OwnerTimeouts,
  onBusy?: () => void,
): Promise<void> {
  const [{ locked }] = await sql<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${key}) AS locked`;
  if (locked) return;
  onBusy?.();
  try {
    await sql`SELECT pg_advisory_lock(${key})`;
  } catch (err) {
    if (isLockTimeout(err)) throw new CommerceLockTimeoutError(what, timeouts.lockTimeoutMs, { cause: err });
    throw err;
  }
}

/** Release a session advisory lock; never masks the caller's own error. */
export async function releaseAdvisoryLock(sql: postgres.Sql, key: number): Promise<void> {
  // Ending the session releases it too, so a failure here (a broken connection)
  // is not worth surfacing over the real outcome.
  await sql`SELECT pg_advisory_unlock(${key})`.catch(() => undefined);
}
