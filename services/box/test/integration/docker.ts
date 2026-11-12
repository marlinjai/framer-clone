// services/box/test/integration/docker.ts
//
// Throwaway containers for the integration suite, through the docker command
// line. Everything is published on 127.0.0.1 only, named with random bytes,
// and removed afterwards. Every password is made from random bytes at run
// time and handed to docker through the environment or standard input, never
// on a command line.

import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

export function docker(args: string[], options: { input?: string; env?: Record<string, string> } = {}): string {
  return execFileSync('docker', args, {
    input: options.input,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** Runs docker and returns the exit code and output without throwing. */
export function dockerResult(args: string[], env: Record<string, string> = {}): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile('docker', args, { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, output: `${stdout}${stderr}` });
    });
  });
}

export function randomName(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(check: () => Promise<boolean> | boolean, what: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // Not yet.
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

export interface ScratchPostgres {
  network: string;
  container: string;
  /** For the test process, through 127.0.0.1. */
  readerUrl: string;
  /** For another container on the same network. */
  readerUrlInNetwork: string;
  /** Runs SQL as the superuser, through standard input. */
  sql(text: string): string;
  stop(): void;
  start(): Promise<void>;
  remove(): void;
}

/** A scratch Postgres 16 with the fixture applied and `box_reader` given a random password. */
export async function startScratchPostgres(): Promise<ScratchPostgres> {
  const network = randomName('box-itest-net');
  const container = randomName('box-itest-pg');
  const port = await freePort();
  const adminPassword = randomBytes(18).toString('hex');
  const readerPassword = randomBytes(18).toString('hex');
  docker(['network', 'create', network]);
  docker(
    ['run', '-d', '--name', container, '--network', network, '--network-alias', 'pg', '-p', `127.0.0.1:${port}:5432`, '-e', 'POSTGRES_PASSWORD', 'postgres:16-alpine'],
    { env: { POSTGRES_PASSWORD: adminPassword } },
  );
  const sql = (text: string) => docker(['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', '-U', 'postgres', '-d', 'postgres'], { input: text });
  // The image starts Postgres once to initialize and again for real: ready means a query answers over TCP.
  const ready = () => until(() => docker(['exec', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-t', '-A', '-c', 'select 1']).trim() === '1', 'the scratch database');
  await ready();
  sql(readFileSync(path.join(__dirname, 'fixture.sql'), 'utf8'));
  sql(`ALTER ROLE box_reader PASSWORD '${readerPassword}';`);
  return {
    network,
    container,
    readerUrl: `postgres://box_reader:${readerPassword}@127.0.0.1:${port}/postgres`,
    readerUrlInNetwork: `postgres://box_reader:${readerPassword}@pg:5432/postgres`,
    sql,
    stop: () => void docker(['stop', '-t', '2', container]),
    start: async () => {
      docker(['start', container]);
      await ready();
    },
    remove: () => {
      try {
        docker(['rm', '-f', '-v', container]);
      } finally {
        docker(['network', 'rm', network]);
      }
    },
  };
}

/** Builds the box image from the repository root, or uses the one named in BOX_IMAGE. */
export function boxImage(): string {
  if (process.env.BOX_IMAGE) return process.env.BOX_IMAGE;
  const tag = 'framer-clone-box:itest';
  docker(['build', '-q', '-f', path.join(REPO_ROOT, 'Dockerfile.box'), '-t', tag, REPO_ROOT]);
  return tag;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  rawHeaderNames: string[];
  body: string;
}

/** One request through node:http, so the fetch metadata headers can be set as a browser would. */
export function httpGet(port: number, target: string, headers: Record<string, string> = {}, method = 'GET'): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: target, method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          rawHeaderNames: res.rawHeaders.filter((_, i) => i % 2 === 0),
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

export const FRAME_HEADERS = { 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Site': 'cross-site' };
