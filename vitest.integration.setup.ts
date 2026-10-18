// vitest.integration.setup.ts
//
// globalSetup for the Dockerized-Postgres integration harness. Boots a real
// Postgres in a throwaway container (testcontainers), points DATABASE_URL at
// it, and runs `prisma migrate deploy` so the dt_* tables exist before any
// integration test runs. Stops the container on teardown.
//
// This harness is run ONLY via `pnpm test:integration` and is kept OUT of the
// headless `pnpm test` unit run (which must stay Docker-free). It requires a
// running Docker daemon.

import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { execSync } from 'node:child_process';
import postgres from 'postgres';
import { migratePublic, provisionTenant } from '@marlinjai/tenant-db';

// Both imports are dependency-free on purpose: this globalSetup runs as plain
// Node (vite-node), so it must not pull modules that need the `server-only` /
// `@` aliases the test files get from vitest.integration.config.ts.
import { commerceProvisionOptions } from './src/server/commerce/provisioning/provision';
import { DEMO_TENANT_GROUP_ID } from './src/lib/renderer/server/demoTenant';
import { ensureDockerHost } from './scripts/docker-host';

let container: StartedTestContainer | undefined;

export async function setup(): Promise<void> {
  ensureDockerHost();

  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'test',
      POSTGRES_PASSWORD: 'test',
      POSTGRES_DB: 'framer_clone_test',
      // TRUST auth so the password-less low-privilege `commerce_app` role
      // created below can log in by username alone (no password literal for it
      // anywhere, mirroring backstop.itest.ts / backfill-demo.itest.ts). The
      // existing test:test URL keeps working under trust.
      POSTGRES_HOST_AUTH_METHOD: 'trust',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const url = `postgresql://test:test@${host}:${port}/framer_clone_test`;

  // Forwarded to the test workers (they fork after globalSetup runs).
  process.env.DATABASE_URL = url;

  execSync('pnpm exec prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });

  // Commerce tier (CM-12): the shared container also carries the
  // schema-per-tenant-group commerce stack, because seedDemoSite now writes the
  // demo catalog through the scoped `commerceTenantDb(DEMO_TENANT_GROUP_ID)`
  // handle (COMMERCE_APP_DATABASE_URL) into `tg_<demo>`, never the legacy
  // `commerce` schema. So, exactly as this file owns DATABASE_URL, it owns
  // COMMERCE_APP_DATABASE_URL: stand up the role + registry + demo schema, then
  // export the app-role URL for the forked test workers.
  //
  //   1. `commerce_app`: the LOW-PRIVILEGE login role db.ts connects as.
  //      Password-less (TRUST auth above), so no password literal is needed.
  //      Its default search_path is set to `ext` here, by the superuser, as
  //      prisma/sql/commerce-roles.sql does: provisioning only verifies it.
  //   2. `migratePublic`: the `ext` schema + the `public.tenant_groups`
  //      registry (the global tier, CM-03).
  //   3. USAGE on `ext` for commerce_app: mirrors prisma/sql/commerce-roles.sql
  //      §3 (the runner's per-schema grants do not cover `ext`, and the
  //      ext-resident defaults/triggers must resolve under the ext-locked path).
  //   4. `provisionTenant`: the demo tenant-group's `tg_<demo>` schema with the
  //      commerce migration set, per-schema grants, the check of the ext-locked
  //      search_path backstop on commerce_app, and the append-only REVOKEs re-applied after
  //      the grants (the production `commerceProvisionOptions`).
  const owner = postgres(url, { max: 1, prepare: false });
  try {
    await owner.unsafe('CREATE ROLE commerce_app LOGIN');
    await owner`ALTER ROLE commerce_app SET search_path = ext`;
    await migratePublic(owner);
    await owner.unsafe('GRANT USAGE ON SCHEMA ext TO commerce_app');
    await provisionTenant(owner, commerceProvisionOptions(DEMO_TENANT_GROUP_ID, 'demo'));
  } finally {
    await owner.end();
  }

  // Username-only TRUST URI: no password component (GitGuardian-safe).
  process.env.COMMERCE_APP_DATABASE_URL = `postgresql://commerce_app@${host}:${port}/framer_clone_test`;
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
