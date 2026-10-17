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
//   6. The start step refuses a superuser owner URL.
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
  ensureCommerceTenant,
  provisionCommerceTenant,
} from '../provision';
import { COMMERCE_DEPLOY_LOCK_KEY, runCommerceDeployMigrations } from '../deploy';
import { CommerceLockTimeoutError } from '../ownerSql';

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

  it('a start step behind a held migration lock logs that it waits, then fails with CommerceLockTimeoutError', async () => {
    const lines: string[] = [];
    await su!`SELECT pg_advisory_lock(${COMMERCE_DEPLOY_LOCK_KEY})`;
    try {
      await expect(
        runCommerceDeployMigrations({ ownerUrl, appUrl, log: (l) => lines.push(l), timeouts: SHORT }),
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

  it('the start step refuses a superuser owner URL', async () => {
    await expect(runCommerceDeployMigrations({ ownerUrl: superUrl, appUrl, log: () => {} })).rejects.toThrow(
      /authenticates as postgres, a superuser/,
    );
  });
});
