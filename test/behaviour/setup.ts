// Everything the behaviour proofs run on: the integration harness's real Postgres, a
// real `next build`, and `next start` as a published host would run it. EDITOR_HOST is set
// so `<label>.sites.localhost` is a published host and the real middleware and the real
// `(site)/[...slug]` route answer. No page, route or flag exists for this test.

import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup as startDatabase, teardown as stopDatabase } from '../../vitest.integration.setup';

// BEHAVIOUR_SERVER_PORT moves the server off the default when another checkout's run holds it.
const PORT = Number(process.env.BEHAVIOUR_SERVER_PORT ?? 3931);
const LOG = path.join(os.tmpdir(), 'behaviour-next-start.log');

let server: ChildProcess | undefined;

async function answers(): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${PORT}/robots.txt`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Another checkout's run on the same port would answer in place of this build, and every
 * proof would then hold for the wrong code: refuse a taken port, and a server that died.
 */
async function assertPortFree(): Promise<void> {
  if (await answers()) throw new Error(`port ${PORT} already answers, so a run would test another server: set BEHAVIOUR_SERVER_PORT to a free port`);
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) throw new Error(`next start exited with ${server.exitCode}, see ${LOG}`);
    if (await answers()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`next start did not answer, see ${LOG}`);
}

export async function setup(): Promise<void> {
  await assertPortFree();
  await startDatabase();
  if (process.env.BEHAVIOUR_REUSE_BUILD !== '1') {
    execSync('pnpm build', { stdio: 'inherit', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
  }
  const log = fs.openSync(LOG, 'w');
  server = spawn('pnpm', ['exec', 'next', 'start', '-p', String(PORT)], {
    stdio: ['ignore', log, log],
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      TZ: 'UTC',
      EDITOR_HOST: 'editor.invalid',
      NEXT_TELEMETRY_DISABLED: '1',
      // Public by design, and only a site with analytics turned on reads them: the consent banner needs both.
      ANALYTICS_PUBLIC_INGESTION_KEY: `ap_live_${randomBytes(16).toString('hex')}`,
      ANALYTICS_INGESTION_ENDPOINT: 'https://analytics.invalid/ingest',
    },
  });
  await waitForServer();
  process.env.BEHAVIOUR_PORT = String(PORT);
}

export async function teardown(): Promise<void> {
  if (server?.pid && server.exitCode === null) process.kill(-server.pid);
  await stopDatabase();
}
