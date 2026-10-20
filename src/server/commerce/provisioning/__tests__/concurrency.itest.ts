// src/server/commerce/provisioning/__tests__/concurrency.itest.ts
//
// Integration test (Dockerized Postgres 16) for the two advisory locks of the
// commerce tier, in the production role topology (the roles file applied, the
// owner commerce_ddl a non-superuser):
//
//   1. Two container start steps at once on a FRESH database
//      (runCommerceDeployMigrations twice in parallel): both succeed, and the
//      public migrations are applied exactly once (COMMERCE_DEPLOY_LOCK_KEY).
//   2. Several companies provisioning at once (provisionCommerceTenant in
//      parallel for DIFFERENT tenant groups): all succeed. Without
//      COMMERCE_PROVISION_LOCK_KEY they collide on `ALTER ROLE commerce_app`
//      ("tuple concurrently updated").
//   3. ensureCommerceTenant (project create): the first project of a company
//      provisions; a later one reads the registry and stops, without calling
//      provisionTenant and without taking the provisioning lock.
//   4. Bounded waits: a lock held elsewhere turns into CommerceLockTimeoutError
//      for the start step and for a provision, instead of an endless wait.
//   5. Two companies whose display slugs collide both provision.
//   6. A suspended company is refused and stays suspended; a row still
//      provisioning, a missing progress row and a dropped schema are misses.
//   7. Owner sessions set their waits with SET; start-time migrations give up
//      on a held table lock after their short lock wait.
//   8. The start step accepts only commerce_ddl as login AND effective role,
//      without superuser, BYPASSRLS or all-data / server-access memberships.
//
// TRUST auth with username-only URIs: no password literal anywhere.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import postgres from 'postgres';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Spy on the runner's provisionTenant (calling through to the real one) so the
// fast path can prove it never runs a full provision.
vi.mock('@marlinjai/tenant-db', async (importActual) => {
  const actual = await importActual<typeof import('@marlinjai/tenant-db')>();
  return { ...actual, provisionTenant: vi.fn(actual.provisionTenant) };
});

import { provisionTenant } from '@marlinjai/tenant-db';
import {
  COMMERCE_PROVISION_LOCK_KEY,
  commerceSlugFor,
  CommerceTenantSuspendedError,
  ensureCommerceTenant,
  provisionCommerceTenant,
} from '../provision';
import { COMMERCE_DEPLOY_LOCK_KEY, runCommerceDeployMigrations } from '../deploy';
import { acquireAdvisoryLock, CommerceLockTimeoutError, openOwnerSql, PROVISION_TIMEOUTS, releaseAdvisoryLock } from '../ownerSql';

const provisionSpy = vi.mocked(provisionTenant);
/** Short waits for the timeout cases, so the suite stays fast. */
const SHORT = { lockTimeoutMs: 300, statementTimeoutMs: 5_000 };

const DB_NAME = 'framer_clone_concurrency_test';
const ROLES_SQL_PATH = path.resolve(__dirname, '../../../../../prisma/sql/commerce-roles.sql');
const ROLES_SQL_IN_CONTAINER = '/tmp/commerce-roles.sql';

let container: StartedTestContainer | undefined;
let ownerUrl: string;
let appUrl: string;
let su: postgres.Sql | undefined;
let superUrl: string;
let hostPort: string;

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'postgres',
      POSTGRES_DB: DB_NAME,
      POSTGRES_HOST_AUTH_METHOD: 'trust',
    })
    .withExposedPorts(5432)
    .withCopyFilesToContainer([{ source: ROLES_SQL_PATH, target: ROLES_SQL_IN_CONTAINER }])
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  ownerUrl = `postgresql://commerce_ddl@${host}:${port}/${DB_NAME}`;
  appUrl = `postgresql://commerce_app@${host}:${port}/${DB_NAME}`;

  const { exitCode, output } = await container.exec([
    'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', 'postgres', '-d', DB_NAME, '-f', ROLES_SQL_IN_CONTAINER,
  ]);
  if (exitCode !== 0) throw new Error(`commerce-roles.sql failed (exit ${exitCode}): ${output}`);
  hostPort = `${host}:${port}`;
  superUrl = `postgresql://postgres@${host}:${port}/${DB_NAME}`;
  su = postgres(superUrl, { max: 1, prepare: false });
  await su`ALTER ROLE commerce_app LOGIN`;
  await su`ALTER ROLE commerce_ddl LOGIN`;
}, 180_000);

afterAll(async () => {
  await su?.end();
  await container?.stop();
});

describe('commerce advisory locks', () => {
  it('two start steps at once on a fresh database: both succeed, public migrations apply once', async () => {
    const logs: string[][] = [[], []];
    const results = await Promise.all(
      [0, 1].map((i) =>
        runCommerceDeployMigrations({ ownerUrl, appUrl, log: (line) => logs[i].push(line) }),
      ),
    );

    const applied = results.map((r) => r.publicApplied).sort((a, b) => b.length - a.length);
    expect(applied).toEqual([['001_ext_schema', '002_tenant_groups'], []]);

    const rows = await su!<{ id: string }[]>`SELECT id FROM public.__public_db_migrations ORDER BY id`;
    expect(rows.map((r) => r.id)).toEqual(['001_ext_schema', '002_tenant_groups']);
  });

  it('several companies provisioning at once: every provision succeeds', async () => {
    const ids = Array.from({ length: 4 }, () => randomUUID());
    const results = await Promise.allSettled(
      ids.map((tenantGroupId, i) =>
        provisionCommerceTenant({ tenantGroupId, slug: `parallel-${i}`, connectionString: ownerUrl }),
      ),
    );
    const failures = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => String(r.reason));
    expect(failures).toEqual([]);

    const active = await su!<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.tenant_groups WHERE status = 'active'
    `;
    expect(active[0].n).toBe(4);

    // Both locks released: nothing is left holding an advisory lock.
    const held = await su!<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`;
    expect(held[0].n).toBe(0);
  });
  it('project create: the first project provisions, a later one neither provisions nor locks', async () => {
    const tenantGroupId = randomUUID();
    const slug = commerceSlugFor(tenantGroupId, 'fast-path');
    provisionSpy.mockClear();

    const first = await ensureCommerceTenant({ tenantGroupId, slug, connectionString: ownerUrl });
    expect(first.provisioned).toBe(true);
    expect(first.applied.length).toBeGreaterThan(0);
    expect(provisionSpy).toHaveBeenCalledTimes(1);

    // Hold the provisioning lock elsewhere: a path that tried to take it would
    // now time out, so a clean, quick return proves the hit path takes none.
    await su!`SELECT pg_advisory_lock(${COMMERCE_PROVISION_LOCK_KEY})`;
    try {
      const second = await ensureCommerceTenant({ tenantGroupId, slug, connectionString: ownerUrl, timeouts: SHORT });
      expect(second).toEqual({ schema: first.schema, applied: [], provisioned: false });
      expect(provisionSpy).toHaveBeenCalledTimes(1);
    } finally {
      await su!`SELECT pg_advisory_unlock(${COMMERCE_PROVISION_LOCK_KEY})`;
    }
  });

  it('a provision behind a held lock fails with CommerceLockTimeoutError, not an endless wait', async () => {
    await su!`SELECT pg_advisory_lock(${COMMERCE_PROVISION_LOCK_KEY})`;
    try {
      const started = Date.now();
      await expect(
        ensureCommerceTenant({
          tenantGroupId: randomUUID(),
          slug: 'blocked',
          connectionString: ownerUrl,
          timeouts: SHORT,
        }),
      ).rejects.toBeInstanceOf(CommerceLockTimeoutError);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await su!`SELECT pg_advisory_unlock(${COMMERCE_PROVISION_LOCK_KEY})`;
    }
  });

  describe('a wait sized to the queue (queueWaitMs)', () => {
    // A key of its own, so these holders never meet a real provision.
    const KEY = 74_610_099;
    const QUEUED = { lockTimeoutMs: 300, statementTimeoutMs: 5_000, queueWaitMs: 5_000 };

    /** Sessions all queued for the lock before the waiter arrives, each holding it `holdMs`: a queue that moves. */
    async function movingQueue(holders: number, holdMs: number) {
      const sessions = Array.from({ length: holders }, () => postgres(superUrl, { max: 1, prepare: false }));
      await sessions[0]`SELECT pg_advisory_lock(${KEY})`;
      const runs = sessions.map(async (s, i) => {
        if (i > 0) await s`SELECT pg_advisory_lock(${KEY})`;
        await new Promise((r) => setTimeout(r, holdMs));
        await s`SELECT pg_advisory_unlock(${KEY})`;
      });
      // Every other holder is in the queue (Postgres grants a waiting lock in arrival order).
      for (let i = 0; i < 200; i += 1) {
        const [{ n }] = await su!<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid = ${KEY}`;
        if (n >= holders - 1) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      return { done: Promise.all(runs), end: () => Promise.all(sessions.map((s) => s.end())) };
    }

    it('keeps waiting while the lock changes hands, far beyond one lock wait', async () => {
      const queue = await movingQueue(5, 200);
      const waiter = await openOwnerSql(ownerUrl, QUEUED);
      try {
        const started = Date.now();
        await acquireAdvisoryLock(waiter, KEY, 'test lock', QUEUED);
        // Five holders of 200 ms: well past the 300 ms a single wait would have allowed.
        expect(Date.now() - started).toBeGreaterThan(600);
        await releaseAdvisoryLock(waiter, KEY);
        await queue.done;
      } finally {
        await waiter.end();
        await queue.end();
      }
    });

    it('a single wait (no queueWaitMs) still fails after one lock wait, the old contract', async () => {
      const queue = await movingQueue(5, 200);
      const waiter = await openOwnerSql(ownerUrl, SHORT);
      try {
        await expect(acquireAdvisoryLock(waiter, KEY, 'test lock', SHORT)).rejects.toThrow(/not granted within 300 ms \(lock_timeout\)/);
        await queue.done;
      } finally {
        await waiter.end();
        await queue.end();
      }
    });

    it('fails fast behind one holder that keeps the lock (a stuck provision), queue or not', async () => {
      await su!`SELECT pg_advisory_lock(${KEY})`;
      const waiter = await openOwnerSql(ownerUrl, QUEUED);
      try {
        const started = Date.now();
        await expect(acquireAdvisoryLock(waiter, KEY, 'test lock', QUEUED)).rejects.toThrow(/not granted within 300 ms \(lock_timeout\)/);
        expect(Date.now() - started).toBeLessThan(2_000);
      } finally {
        await su!`SELECT pg_advisory_unlock(${KEY})`;
        await waiter.end();
      }
    });

    it('gives up when the queue keeps moving longer than queueWaitMs in all, with its own message', async () => {
      const queue = await movingQueue(8, 200);
      const capped = { ...QUEUED, queueWaitMs: 600 };
      const waiter = await openOwnerSql(ownerUrl, capped);
      try {
        await expect(acquireAdvisoryLock(waiter, KEY, 'test lock', capped)).rejects.toThrow(/within 600 ms of queueing/);
        await queue.done;
      } finally {
        await waiter.end();
        await queue.end();
      }
    });

    it('the provisioning budget sizes its wait to the queue', () => {
      expect(PROVISION_TIMEOUTS.queueWaitMs).toBeGreaterThan(PROVISION_TIMEOUTS.lockTimeoutMs);
      expect(PROVISION_TIMEOUTS.lockTimeoutMs + PROVISION_TIMEOUTS.queueWaitMs!).toBeGreaterThan(0);
    });
  });

  it('a start step behind a held migration lock logs that it waits, then fails with CommerceLockTimeoutError', async () => {
    const lines: string[] = [];
    await su!`SELECT pg_advisory_lock(${COMMERCE_DEPLOY_LOCK_KEY})`;
    try {
      await expect(
        runCommerceDeployMigrations({ ownerUrl, appUrl, log: (l) => lines.push(l), timeouts: { lock: SHORT } }),
      ).rejects.toThrow(/commerce migration lock: lock not granted within 300 ms/);
      expect(lines).toContain('commerce: another start step holds the commerce migration lock, waiting');
    } finally {
      await su!`SELECT pg_advisory_unlock(${COMMERCE_DEPLOY_LOCK_KEY})`;
    }
  });

  it('two companies whose display slugs collide both provision, each with its own registry slug', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const results = await Promise.all(
      [a, b].map((id) => ensureCommerceTenant({ tenantGroupId: id, slug: commerceSlugFor(id, 'Acme'), connectionString: ownerUrl })),
    );
    expect(results.map((r) => r.provisioned)).toEqual([true, true]);
    const rows = await su!<{ id: string; slug: string; status: string }[]>`
      SELECT id::text AS id, slug, status FROM public.tenant_groups WHERE id IN (${a}::uuid, ${b}::uuid)
    `;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.slug)).size).toBe(2);
    for (const row of rows) {
      expect(row.status).toBe('active');
      expect(row.slug).toBe(`acme-${row.id.replace(/-/g, '')}`);
    }
  });

  /** Provision a fresh company through the project-create path; returns its id and schema. */
  async function freshCompany(label: string): Promise<{ id: string; schema: string }> {
    const id = randomUUID();
    const r = await ensureCommerceTenant({ tenantGroupId: id, slug: commerceSlugFor(id, label), connectionString: ownerUrl });
    expect(r.provisioned).toBe(true);
    return { id, schema: r.schema };
  }

  it('a suspended company is refused, never provisioned, and stays suspended', async () => {
    const { id } = await freshCompany('suspended');
    await su!`UPDATE public.tenant_groups SET status = 'suspended' WHERE id = ${id}::uuid`;
    provisionSpy.mockClear();

    await expect(
      ensureCommerceTenant({ tenantGroupId: id, slug: commerceSlugFor(id, 'suspended'), connectionString: ownerUrl }),
    ).rejects.toBeInstanceOf(CommerceTenantSuspendedError);

    expect(provisionSpy).not.toHaveBeenCalled();
    const [row] = await su!<{ status: string }[]>`SELECT status FROM public.tenant_groups WHERE id = ${id}::uuid`;
    expect(row.status).toBe('suspended');
  });

  it('misses: a row still provisioning, a missing progress row, a dropped schema; each is provisioned again', async () => {
    const stillProvisioning = await freshCompany('half-done');
    await su!`UPDATE public.tenant_groups SET status = 'provisioning' WHERE id = ${stillProvisioning.id}::uuid`;

    const missingProgress = await freshCompany('no-progress');
    await su!`
      DELETE FROM public.tenant_migration_progress
      WHERE schema_name = ${missingProgress.schema} AND migration_id = '003_catalog'
    `;

    const dropped = await freshCompany('dropped');
    await su!`DROP SCHEMA ${su!(dropped.schema)} CASCADE`;

    for (const company of [stillProvisioning, missingProgress, dropped]) {
      provisionSpy.mockClear();
      const r = await ensureCommerceTenant({
        tenantGroupId: company.id,
        slug: commerceSlugFor(company.id, 'again'),
        connectionString: ownerUrl,
      });
      expect(r.provisioned).toBe(true);
      expect(provisionSpy).toHaveBeenCalledTimes(1);
      // ...and afterwards the company is a hit again.
      const again = await ensureCommerceTenant({ tenantGroupId: company.id, slug: 'x', connectionString: ownerUrl });
      expect(again.provisioned).toBe(false);
    }

    const [state] = await su!<{ status: string; schema_back: boolean; progress_back: boolean }[]>`
      SELECT
        (SELECT status FROM public.tenant_groups WHERE id = ${stillProvisioning.id}::uuid) AS status,
        to_regnamespace(${dropped.schema}) IS NOT NULL AS schema_back,
        EXISTS (SELECT 1 FROM public.tenant_migration_progress
                WHERE schema_name = ${missingProgress.schema} AND migration_id = '003_catalog') AS progress_back
    `;
    expect(state).toEqual({ status: 'active', schema_back: true, progress_back: true });
    // The dropped schema was rebuilt from scratch: every migration applied again.
    const tables = await su!<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = ${dropped.schema}
    `;
    expect(tables[0].n).toBeGreaterThan(10);
  });

  it('owner sessions get their bounded waits with SET after connecting, not as startup parameters', async () => {
    const sql = await openOwnerSql(ownerUrl, { lockTimeoutMs: 1234, statementTimeoutMs: 0 });
    try {
      const [row] = await sql<{ lock: string; statement: string; app: string }[]>`
        SELECT current_setting('lock_timeout') AS lock,
               current_setting('statement_timeout') AS statement,
               current_setting('application_name') AS app
      `;
      expect(row).toEqual({ lock: '1234ms', statement: '0', app: 'framer-clone-commerce-owner' });
    } finally {
      await sql.end();
    }
  });

  it('start-time migrations give up on a held table lock after their short lock wait', async () => {
    // Another session holds an exclusive lock on the registry, like DDL stuck
    // behind long storefront transactions. The migrations must not queue forever.
    const holder = postgres(superUrl, { max: 1, prepare: false });
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holding = holder.begin(async (tx) => {
      await tx`LOCK TABLE public.tenant_groups IN ACCESS EXCLUSIVE MODE`;
      locked();
      await released;
    });
    try {
      await isLocked;
      const started = Date.now();
      await expect(
        runCommerceDeployMigrations({
          ownerUrl,
          appUrl,
          log: () => {},
          timeouts: { migration: { lockTimeoutMs: 300, statementTimeoutMs: 0 } },
        }),
      ).rejects.toThrow(/lock timeout/);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      release();
      await holding;
      await holder.end();
    }
  });

  describe('owner identity at start', () => {
    const urlFor = (user: string, role?: string) =>
      `postgresql://${user}@${hostPort}/${DB_NAME}` + (role ? `?options=${encodeURIComponent(`-c role=${role}`)}` : '');
    const run = (url: string) => runCommerceDeployMigrations({ ownerUrl: url, appUrl, log: () => {} });

    beforeAll(async () => {
      await su!`CREATE ROLE impostor LOGIN`;
      await su!`GRANT commerce_ddl TO impostor`;
    });

    it('refuses a superuser login, also when the URL switches the role to commerce_ddl', async () => {
      await expect(run(superUrl)).rejects.toThrow(/reaches a superuser \(session_user postgres, current_user postgres\)/);
      await expect(run(urlFor('postgres', 'commerce_ddl'))).rejects.toThrow(
        /reaches a superuser \(session_user postgres, current_user commerce_ddl\)/,
      );
    });

    it('refuses any other login, even one that switches to commerce_ddl', async () => {
      await expect(run(urlFor('impostor', 'commerce_ddl'))).rejects.toThrow(
        /must log in as commerce_ddl and stay that role \(found session_user impostor, current_user commerce_ddl\)/,
      );
      // The app role itself (with a distinct app URL, so the URL shape check passes).
      await expect(
        runCommerceDeployMigrations({ ownerUrl: appUrl, appUrl: 'postgresql://other@h/db', log: () => {} }),
      ).rejects.toThrow(/found session_user commerce_app, current_user commerce_app/);
    });

    it('refuses commerce_ddl with BYPASSRLS', async () => {
      await su!`ALTER ROLE commerce_ddl BYPASSRLS`;
      try {
        await expect(run(ownerUrl)).rejects.toThrow(/has BYPASSRLS/);
      } finally {
        await su!`ALTER ROLE commerce_ddl NOBYPASSRLS`;
      }
    });

    it('refuses commerce_ddl as a member of a predefined all-data or server-access role', async () => {
      for (const role of ['pg_read_all_data', 'pg_write_all_data', 'pg_execute_server_program']) {
        await su!`GRANT ${su!(role)} TO commerce_ddl`;
        try {
          await expect(run(ownerUrl)).rejects.toThrow(new RegExp(`member of ${role}`));
        } finally {
          await su!`REVOKE ${su!(role)} FROM commerce_ddl`;
        }
      }
      // And the clean owner still passes.
      await expect(run(ownerUrl)).resolves.toMatchObject({ role: 'commerce_ddl' });
    });
  });
});
