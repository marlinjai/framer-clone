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
//
// TRUST auth with username-only URIs: no password literal anywhere.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import postgres from 'postgres';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { provisionCommerceTenant } from '../provision';
import { runCommerceDeployMigrations } from '../deploy';

const DB_NAME = 'framer_clone_concurrency_test';
const ROLES_SQL_PATH = path.resolve(__dirname, '../../../../../prisma/sql/commerce-roles.sql');
const ROLES_SQL_IN_CONTAINER = '/tmp/commerce-roles.sql';

let container: StartedTestContainer | undefined;
let ownerUrl: string;
let appUrl: string;
let su: postgres.Sql | undefined;

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
  su = postgres(`postgresql://postgres@${host}:${port}/${DB_NAME}`, { max: 1, prepare: false });
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
});
