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

let container: StartedTestContainer | undefined;

export async function setup(): Promise<void> {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'test',
      POSTGRES_PASSWORD: 'test',
      POSTGRES_DB: 'framer_clone_test',
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
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
