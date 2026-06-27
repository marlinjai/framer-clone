// src/server/commerce/__tests__/backstop.itest.ts
//
// Integration test (Dockerized Postgres) for the CM-02 startup compliance
// backstop. It proves BOTH directions of the crown invariant that makes the
// schema-per-tenant-group wall "safe by construction":
//
//   - A base handle built from a role whose DEFAULT search_path is exactly
//     `ext` (the low-privilege `commerce_app` role) → assertBackstop PASSES.
//   - A base handle built from a role whose default path still contains
//     `public` (e.g. a deploy that mistakenly points Kysely at the OWNER
//     `commerce_ddl` role) → assertBackstop THROWS BackstopError. The app must
//     refuse to start rather than silently re-open the bare-name cross-tenant
//     leak.
//
// It also exercises the real framer-clone wiring (createNodeDb base +
// assertCommerceBackstop reading COMMERCE_APP_DATABASE_URL) end to end.
//
// Mirrors @marlinjai/tenant-db's own tests/backstop.spec.ts, adapted to
// framer-clone's testcontainers convention (GenericContainer, as in
// inventory/__tests__/schema.itest.ts). It boots its OWN throwaway Postgres in
// beforeAll, so it is self-contained. The `.itest.ts` suffix keeps it OUT of
// the headless `pnpm test` unit run (vitest.config.ts matches only
// *.{test,spec}.{ts,tsx}) and runs it ONLY under `pnpm test:integration`
// against Docker. It requires a running Docker daemon.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import postgres from 'postgres';
import { createNodeDb } from '@marlinjai/tenant-db/node';
import { assertBackstop, BackstopError } from '@marlinjai/tenant-db';

// The low-privilege app role: default search_path locked to `ext` (the correct
// backstop). The owner role: default path still contains `public` (the
// misconfiguration the backstop traps).
const APP_ROLE = 'commerce_app';
const OWNER_ROLE = 'commerce_ddl';
const DB_NAME = 'framer_clone_test';

let container: StartedTestContainer | undefined;
let owner: postgres.Sql | undefined;

// Two base Kysely instances, each built via the real framer-clone factory
// (createNodeDb) against a different role's connection string.
let appBase: ReturnType<typeof createNodeDb> | undefined;
let ownerBase: ReturnType<typeof createNodeDb> | undefined;

function makeUrl(user: string, host: string, port: number): string {
  // trust auth → no password component; username alone authenticates.
  return `postgresql://${user}@${host}:${port}/${DB_NAME}`;
}

beforeAll(async () => {
  // `trust` auth so the throwaway, password-less roles below log in by username
  // alone (these are in-container roles only; no secret anywhere).
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'postgres',
      POSTGRES_PASSWORD: 'postgres',
      POSTGRES_DB: DB_NAME,
      POSTGRES_HOST_AUTH_METHOD: 'trust',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);

  owner = postgres(makeUrl('postgres', host, port), {
    max: 1,
    prepare: false,
    transform: { undefined: null },
  });

  // The ext schema exists in a real deployment (created by migratePublic, CM-03);
  // create it here so the ext-locked role is realistic.
  await owner.unsafe('CREATE SCHEMA IF NOT EXISTS ext');

  // Role 1 (commerce_app): ext-locked default path — the correct backstop.
  // Exactly what prisma/sql/commerce-roles.sql + bootstrapAppRole produce.
  await owner.unsafe(`DROP ROLE IF EXISTS "${APP_ROLE}"`).catch(() => {});
  await owner.unsafe(`CREATE ROLE "${APP_ROLE}" LOGIN`);
  await owner.unsafe(`ALTER ROLE "${APP_ROLE}" SET search_path = ext`);
  await owner.unsafe(`GRANT USAGE ON SCHEMA ext TO "${APP_ROLE}"`);
  await owner.unsafe(`GRANT CONNECT ON DATABASE "${DB_NAME}" TO "${APP_ROLE}"`);

  // Role 2 (commerce_ddl / owner): a default path that still contains `public`
  // — the misconfiguration of pointing the app at the owner role.
  await owner.unsafe(`DROP ROLE IF EXISTS "${OWNER_ROLE}"`).catch(() => {});
  await owner.unsafe(`CREATE ROLE "${OWNER_ROLE}" LOGIN`);
  await owner.unsafe(`ALTER ROLE "${OWNER_ROLE}" SET search_path = ext, public`);
  await owner.unsafe(`GRANT USAGE ON SCHEMA ext TO "${OWNER_ROLE}"`);
  await owner.unsafe(`GRANT CONNECT ON DATABASE "${DB_NAME}" TO "${OWNER_ROLE}"`);

  appBase = createNodeDb({ connectionString: makeUrl(APP_ROLE, host, port) });
  ownerBase = createNodeDb({ connectionString: makeUrl(OWNER_ROLE, host, port) });

  // Wire the app-role URL into the env the real db.ts singleton reads, so the
  // assertCommerceBackstop() end-to-end test below exercises the production path.
  process.env.COMMERCE_APP_DATABASE_URL = makeUrl(APP_ROLE, host, port);
}, 180_000);

afterAll(async () => {
  await appBase?.destroy();
  await ownerBase?.destroy();
  await owner?.end();
  await container?.stop();
});

describe('CM-02 commerce backstop (createNodeDb base + assertBackstop)', () => {
  it('PASSES for the ext-locked commerce_app role (search_path = ext)', async () => {
    await expect(assertBackstop(appBase!)).resolves.toBeUndefined();
  });

  it('THROWS BackstopError when pointed at the owner role (path contains public)', async () => {
    await expect(assertBackstop(ownerBase!)).rejects.toBeInstanceOf(BackstopError);
  });

  it('the BackstopError carries the offending search_path and the right code', async () => {
    let caught: unknown;
    try {
      await assertBackstop(ownerBase!);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BackstopError);
    expect((caught as BackstopError).code).toBe('TENANT_BACKSTOP_NOT_ENFORCED');
    expect((caught as BackstopError).searchPath).toMatch(/public/);
  });

  it('assertCommerceBackstop() (real db.ts wiring via COMMERCE_APP_DATABASE_URL) passes on the app role', async () => {
    // Imported lazily so the module-level singleton is built AFTER the env var
    // is set in beforeAll. `server-only` is aliased to a stub by the
    // integration vitest config, so importing db.ts is safe here.
    const { assertCommerceBackstop, getCommerceBase } = await import('../db');
    await expect(assertCommerceBackstop()).resolves.toBeUndefined();
    try {
      await getCommerceBase().destroy();
    } catch {
      // best-effort pool teardown; ignore if already destroyed.
    }
  });
});
