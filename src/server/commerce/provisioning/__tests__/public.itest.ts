// src/server/commerce/provisioning/__tests__/public.itest.ts
//
// Integration test (Dockerized Postgres) for the CM-03 commerce PUBLIC tier.
// It proves that `migrateCommercePublic` — the thin wrapper over the package's
// `migratePublic` (default PUBLIC_MIGRATIONS) on a DIRECT OWNER connection —
// stands up exactly the global objects the schema-per-tenant-group model needs,
// and is IDEMPOTENT so a deploy can re-run `pnpm db:public` safely.
//
// The only global objects commerce has are:
//   - the shared `ext` schema: pgcrypto + `ext.gen_uuid_v7()` (UUIDv7 DEFAULTs)
//     + `ext.touch_updated_at()` (the updatedAt trigger fn), from 001_ext_schema.
//   - the runner's registry: `public.tenant_groups` + `public.tenant_migration_progress`,
//     from 002_tenant_groups.
// Commerce owns NO public commerce tables (product/order/inventory are 100%
// per-tenant and land in CM-04 as tg_<id>-schema migrations).
//
// It boots its OWN throwaway Postgres (testcontainers) in beforeAll, so it is
// self-contained. The container superuser (`postgres`) is the OWNER with DDL
// privilege, so its connection string is the owner URL `migrateCommercePublic`
// expects. The `.itest.ts` suffix keeps this OUT of the headless `pnpm test`
// unit run (vitest.config.ts matches only *.{test,spec}.{ts,tsx}) — it runs
// ONLY under `pnpm test:integration` against Docker, and requires a running
// Docker daemon. Mirrors the testcontainers convention of backstop.itest.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import postgres from 'postgres';
import { migrateCommercePublic } from '../public';

const DB_NAME = 'framer_clone_test';

let container: StartedTestContainer | undefined;
let ownerUrl: string | undefined;
// A direct probe client (the container superuser) used only to assert the
// resulting schema — NOT the handle under test.
let probe: postgres.Sql | undefined;

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'postgres',
      POSTGRES_PASSWORD: 'postgres',
      POSTGRES_DB: DB_NAME,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  // The container superuser is the DDL owner — exactly the role
  // COMMERCE_OWNER_DATABASE_URL (`commerce_ddl`) plays in a real deploy.
  ownerUrl = `postgresql://postgres:postgres@${host}:${port}/${DB_NAME}`;
  probe = postgres(ownerUrl, { max: 1, prepare: false });
}, 180_000);

afterAll(async () => {
  await probe?.end();
  await container?.stop();
});

describe('CM-03 commerce public migrations (migrateCommercePublic → migratePublic)', () => {
  it('throws a clear OWNER-role error when no owner connection string is available', async () => {
    const saved = process.env.COMMERCE_OWNER_DATABASE_URL;
    delete process.env.COMMERCE_OWNER_DATABASE_URL;
    try {
      await expect(migrateCommercePublic()).rejects.toThrow(/COMMERCE_OWNER_DATABASE_URL/);
      await expect(migrateCommercePublic()).rejects.toThrow(/OWNER role/);
    } finally {
      if (saved !== undefined) process.env.COMMERCE_OWNER_DATABASE_URL = saved;
    }
  });

  it('applies the default public set on a fresh DB and stands up ext + the registry', async () => {
    const applied = await migrateCommercePublic(ownerUrl);

    // First run applies both default public migrations, in order.
    expect(applied).toEqual(['001_ext_schema', '002_tenant_groups']);

    // The `ext` schema exists.
    const extSchema = await probe!`
      SELECT 1 FROM information_schema.schemata WHERE schema_name = 'ext'
    `;
    expect(extSchema.length).toBe(1);

    // ext.gen_uuid_v7() exists AND is callable, returning a real uuid.
    const genFn = await probe!`
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'ext' AND p.proname = 'gen_uuid_v7'
    `;
    expect(genFn.length).toBe(1);
    const uuidRow = await probe!`SELECT ext.gen_uuid_v7() AS id`;
    expect(uuidRow[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    // ext.touch_updated_at() exists (the shared updatedAt trigger fn).
    const touchFn = await probe!`
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'ext' AND p.proname = 'touch_updated_at'
    `;
    expect(touchFn.length).toBe(1);

    // The registry tables exist in public.
    const registryTables = await probe!`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('tenant_groups', 'tenant_migration_progress')
      ORDER BY table_name
    `;
    expect(registryTables.map((r) => r.table_name)).toEqual([
      'tenant_groups',
      'tenant_migration_progress',
    ]);
  });

  it('is idempotent: a second run applies nothing new (returns [])', async () => {
    // The first describe-block run already migrated this shared container; a
    // re-run must be a clean no-op (the runner guards via __public_db_migrations).
    const second = await migrateCommercePublic(ownerUrl);
    expect(second).toEqual([]);

    // And the objects are still intact (not dropped/recreated).
    const stillThere = await probe!`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'tenant_groups'
    `;
    expect(stillThere.length).toBe(1);
  });
});
