// Everything the behaviour proofs run on: the integration harness's real Postgres, a
// real `next build`, and `next start` as a published host would run it. EDITOR_HOST is set
// so `<label>.sites.localhost` is a published host and the real middleware and the real
// `(site)/[...slug]` route answer. No page, route or flag exists for this test.

import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setup as startDatabase, teardown as stopDatabase } from '../../vitest.integration.setup';

// Each run takes a port the system hands out, so runs in parallel (the agent fleet, two
// checkouts) never meet on one: a fixed port made the second run talk to the first run's
// server, or fail to bind. The port is free when asked and taken a moment later by
// `next start`; another process can take it in between, so a start that fails to bind
// tries a new one.
const START_ATTEMPTS = 3;

let server: ChildProcess | undefined;

/** A port nothing listens on now, from the system. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** Resolves when this server answers; rejects as soon as it exits, so a dead start is never waited out. */
async function waitForServer(child: ChildProcess, port: number, log: string): Promise<void> {
  let exited: string | undefined;
  // A process killed by a signal exits with code null and a signal name, so both are reported.
  child.once('exit', (code, signal) => {
    exited = signal ? `signal ${signal}` : `code ${code}`;
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (exited !== undefined) throw new Error(`next start exited with ${exited} on port ${port}, see ${log}`);
    try {
      await fetch(`http://127.0.0.1:${port}/robots.txt`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`next start did not answer on port ${port}, see ${log}`);
}

export async function setup(): Promise<void> {
  await startDatabase();
  if (process.env.BEHAVIOUR_REUSE_BUILD !== '1') {
    execSync('pnpm build', { stdio: 'inherit', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
  }
  for (let attempt = 1; ; attempt += 1) {
    const port = await freePort();
    const log = path.join(os.tmpdir(), `behaviour-next-start-${port}.log`);
    server = start(port, log);
    try {
      await waitForServer(server, port, log);
      process.env.BEHAVIOUR_PORT = String(port);
      return;
    } catch (error) {
      stopServer();
      const taken = fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('EADDRINUSE');
      if (!taken || attempt === START_ATTEMPTS) throw error;
    }
  }
}

function start(port: number, logFile: string): ChildProcess {
  const log = fs.openSync(logFile, 'w');
  const child = spawn('pnpm', ['exec', 'next', 'start', '-p', String(port)], {
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
  // The child holds its own copy of the file.
  fs.closeSync(log);
  return child;
}

/** Stops the server's whole process group, which `detached` made it lead. */
function stopServer(): void {
  if (!server?.pid) return;
  try {
    process.kill(-server.pid);
  } catch (error) {
    // Already gone, which is what this wanted.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  server = undefined;
}

export async function teardown(): Promise<void> {
  stopServer();
  await stopDatabase();
}
