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
import { existsSync } from 'node:fs';
import os from 'node:os';
import postgres from 'postgres';
import { migratePublic, provisionTenant } from '@marlinjai/tenant-db';

// Both imports are dependency-free on purpose: this globalSetup runs as plain
// Node (vite-node), so it must not pull modules that need the `server-only` /
// `@` aliases the test files get from vitest.integration.config.ts.
import { COMMERCE_TENANT_MIGRATIONS } from './src/server/commerce/migrations/tenant/index';
import { DEMO_TENANT_GROUP_ID } from './src/lib/renderer/server/demoTenant';

let container: StartedTestContainer | undefined;

/**
 * Make testcontainers find the Docker daemon WITHOUT the caller having to export
 * DOCKER_HOST. testcontainers-node only probes a fixed set of socket paths
 * (`/var/run/docker.sock` + a few rootless paths); it does NOT consult the
 * `docker` CLI's active context. On a machine whose Docker runs under colima (or
 * any non-default runtime), that default probing fails with "Could not find a
 * working container runtime strategy" even though `docker` works fine.
 *
 * So, when DOCKER_HOST is unset, resolve a working endpoint ourselves: prefer the
 * active `docker context` endpoint, then fall back to well-known socket paths,
 * accepting only a unix socket that actually exists. This runs in globalSetup
 * BEFORE any container starts, and the env it sets is inherited by the forked
 * test workers (which boot their own containers in `.itest.ts` files), so the
 * whole integration suite self-configures. It is best-effort and never throws: a
 * properly-configured CI env (DOCKER_HOST already set) is left untouched.
 */
function ensureDockerHost(): void {
  if (process.env.DOCKER_HOST) return;

  const candidates: string[] = [];

  // 1) The active docker CLI context's endpoint (covers colima / Docker Desktop /
  //    Rancher / remote contexts the default socket probing misses).
  try {
    const endpoint = execSync(
      "docker context inspect --format '{{.Endpoints.docker.Host}}'",
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 },
    )
      .toString()
      .trim();
    if (endpoint) candidates.push(endpoint);
  } catch {
    // No docker CLI / no context: fall through to socket-path probing.
  }

  // 2) Well-known unix socket paths, in preference order.
  const home = os.homedir();
  for (const path of [
    `${home}/.colima/default/docker.sock`,
    `${home}/.rd/docker.sock`,
    `${home}/.docker/run/docker.sock`,
    '/var/run/docker.sock',
  ]) {
    candidates.push(`unix://${path}`);
  }

  for (const candidate of candidates) {
    const socketPath = candidate.startsWith('unix://')
      ? candidate.slice('unix://'.length)
      : null;
    // A unix-socket candidate must actually exist on disk; a tcp:// endpoint
    // (e.g. a remote context) is taken as-is.
    if (socketPath && !existsSync(socketPath)) continue;
    process.env.DOCKER_HOST = candidate;
    // The ryuk reaper bind-mounts the daemon socket into a container; a
    // non-default runtime (e.g. colima) cannot mount its own runtime socket
    // ("operation not supported"), which fails startup. The canonical
    // `/var/run/docker.sock` mounts fine, so leave the reaper EXACTLY as default
    // testcontainers runs it there; disable it ONLY for a non-standard
    // discovered socket. Safe: every container this harness starts is explicitly
    // `.stop()`'d in teardown / each `.itest.ts` afterAll, so the reaper is
    // redundant here. This is the only non-DOCKER_HOST env it touches, and it is
    // reached solely on the no-DOCKER_HOST fallback path.
    if (socketPath && socketPath !== '/var/run/docker.sock') {
      process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';
    }
    break;
  }
}

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
  //   2. `migratePublic`: the `ext` schema + the `public.tenant_groups`
  //      registry (the global tier, CM-03).
  //   3. USAGE on `ext` for commerce_app: mirrors prisma/sql/commerce-roles.sql
  //      §3 (the runner's per-schema grants do not cover `ext`, and the
  //      ext-resident defaults/triggers must resolve under the ext-locked path).
  //   4. `provisionTenant`: the demo tenant-group's `tg_<demo>` schema with the
  //      commerce migration set, per-schema grants, and the ext-locked
  //      search_path backstop on commerce_app.
  const owner = postgres(url, { max: 1, prepare: false });
  try {
    await owner.unsafe('CREATE ROLE commerce_app LOGIN');
    await migratePublic(owner);
    await owner.unsafe('GRANT USAGE ON SCHEMA ext TO commerce_app');
    await provisionTenant(owner, {
      tenantGroupId: DEMO_TENANT_GROUP_ID,
      slug: 'demo',
      appRole: 'commerce_app',
      tenantMigrations: COMMERCE_TENANT_MIGRATIONS,
    });
  } finally {
    await owner.end();
  }

  // Username-only TRUST URI: no password component (GitGuardian-safe).
  process.env.COMMERCE_APP_DATABASE_URL = `postgresql://commerce_app@${host}:${port}/framer_clone_test`;
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
