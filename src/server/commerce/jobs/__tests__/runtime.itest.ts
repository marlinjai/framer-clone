// src/server/commerce/jobs/__tests__/runtime.itest.ts
//
// The poller's pass and the watchdog route against real Postgres (docs/plans/2026-11-02-shop-backbone.md, slice B2).
// The database is shaped the way production is: `commerce-roles.sql`, then the real start step as `commerce_ddl`, and
// every pass runs as `commerce_app` through the real handles. So reading the registry is proven with the grants
// production has, not with a superuser's. There is no Prisma tier here, so no `site` row exists: every group below is
// a group with no site left. Test names follow the stateful flow standard: F forward, B backtrack, R resume, E re-entry.
//
// TRUST auth, no password literals. The `.itest.ts` suffix keeps this out of `pnpm test`.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import postgres from 'postgres';
import { tenantSchema } from '@marlinjai/tenant-db';

import { POST } from '@/app/api/internal/commerce/jobs/run/route';
import { commerceTenantDb } from '../../db';
import { runCommerceDeployMigrations } from '../../provisioning/deploy';
import { provisionCommerceTenant } from '../../provisioning/provision';
import { migrateCommercePublic } from '../../provisioning/public';
import { acknowledgeJob, claimJob } from '../claim';
import { scheduleJob } from '../emit';
import { runCommercePass, runCommerceWatchdogPass } from '../runtime';
import { JOB_LEASE_MS, JobRefused, type JobContext } from '../types';

const { handler } = vi.hoisted(() => ({ handler: { run: (async () => undefined) as (ctx: unknown) => Promise<void> } }));

// The stuck-purge count, held back after it has counted once for a group that has stuck purges: it makes two groups' reads overlap
// on purpose, which is what the watchdog's totals must survive (see the lost-update test).
const { purgeCount } = vi.hoisted(() => ({ purgeCount: { holdFirstPositiveMs: 0 } }));
vi.mock('@/server/forms/purge', async (original) => {
  const real = await original<typeof import('@/server/forms/purge')>();
  return {
    ...real,
    countStuckPurges: async (db: Parameters<typeof real.countStuckPurges>[0]) => {
      const count = await real.countStuckPurges(db);
      if (count > 0 && purgeCount.holdFirstPositiveMs > 0) {
        const wait = purgeCount.holdFirstPositiveMs;
        purgeCount.holdFirstPositiveMs = 0;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      return count;
    },
  };
});

vi.mock('../consumers', async (original) => {
  const { z } = await import('zod');
  const { defineJobKind } = await import('../types');
  return {
    ...(await original<typeof import('../consumers')>()),
    JOB_KINDS: {
      test: defineJobKind({
        policy: { deadlineMs: 30_000, backoffMinutes: [1], laterMinutes: 5, giveUpAfterMs: null },
        payload: z.object({ orderId: z.string() }),
        run: (ctx: JobContext<{ orderId: string }>) => handler.run(ctx),
      }),
    },
  };
});

const DB_NAME = 'framer_clone_jobs_runtime';
const ROLES_SQL_PATH = path.resolve(process.cwd(), 'prisma/sql/commerce-roles.sql');
const ROLES_SQL_IN_CONTAINER = '/tmp/commerce-roles.sql';
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const POLLER_PROCESS = fileURLToPath(new URL('./fixtures/pollerProcess.ts', import.meta.url));

const TOKEN = 'y'.repeat(40);
const COMPANY = '018f9c10-0000-7000-8000-00000000c001';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let container: StartedTestContainer;
let su: postgres.Sql;
let appUrl = '';
let ownerUrl = '';
let groupA = '';
let groupB = '';

async function makeGroup(slug: string): Promise<string> {
  const tenantGroupId = randomUUID();
  await provisionCommerceTenant({ tenantGroupId, slug, connectionString: ownerUrl });
  return tenantGroupId;
}

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'postgres', POSTGRES_DB: DB_NAME, POSTGRES_HOST_AUTH_METHOD: 'trust' })
    .withExposedPorts(5432)
    .withCopyFilesToContainer([{ source: ROLES_SQL_PATH, target: ROLES_SQL_IN_CONTAINER }])
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const url = (user: string) => `postgresql://${user}@${host}:${port}/${DB_NAME}`;
  su = postgres(url('postgres'), { max: 1, prepare: false, onnotice: () => {} });
  const { exitCode, output } = await container.exec([
    'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', 'postgres', '-d', DB_NAME, '-f', ROLES_SQL_IN_CONTAINER,
  ]);
  if (exitCode !== 0) throw new Error(`commerce-roles.sql failed (exit ${exitCode}): ${output}`);
  await su`ALTER ROLE commerce_app LOGIN`;
  await su`ALTER ROLE commerce_ddl LOGIN`;

  ownerUrl = url('commerce_ddl');
  appUrl = url('commerce_app');
  await runCommerceDeployMigrations({ ownerUrl, appUrl, log: () => {} });
  groupA = await makeGroup('runtime-a');
  groupB = await makeGroup('runtime-b');
  process.env.COMMERCE_APP_DATABASE_URL = appUrl;
}, 180_000);

afterAll(async () => {
  await su?.end();
  await container?.stop();
});

beforeEach(() => {
  vi.stubEnv('CUSTOM_DOMAIN_SYNC_TOKEN', TOKEN);
  vi.stubEnv('EDITOR_HOST', 'app.lumitra.co');
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  handler.run = async () => undefined;
  (globalThis as unknown as { __commerceJobHourly?: Map<string, number> }).__commerceJobHourly = undefined;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const group of [groupA, groupB]) await su`DELETE FROM ${su(tenantSchema(group))}."commerce_job"`;
});

function watchdog(): Promise<Response> {
  return POST(
    new Request('http://app.lumitra.co/api/internal/commerce/jobs/run', {
      method: 'POST',
      headers: { host: 'app.lumitra.co', authorization: `Bearer ${TOKEN}` },
    }),
  );
}

interface JobSeed {
  kind?: string;
  runAt?: Date;
  orderId?: string;
}

async function schedule(group: string, seed: JobSeed = {}): Promise<string> {
  const { kind = 'test', runAt = new Date(Date.now() - 1000), orderId = randomUUID() } = seed;
  const id = await commerceTenantDb(group)
    .transaction()
    .execute((trx) =>
      scheduleJob(trx, { tenantId: COMPANY, kind, dedupeKey: `test:${orderId}`, payload: { orderId }, runAt, at: new Date() }),
    );
  if (!id) throw new Error('the job was not written');
  return id;
}

function read(group: string, id: string) {
  return commerceTenantDb(group).selectFrom('commerce_job').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

/** A group in the registry and nothing else, as one in the middle of provisioning. */
async function registerEmptyGroup(status: string): Promise<string> {
  const id = randomUUID();
  await su`
    INSERT INTO public.tenant_groups (id, slug, schema_name, status)
    VALUES (${id}::uuid, ${`empty-${id}`}, ${tenantSchema(id)}, ${status})
  `;
  return id;
}

async function dropFromRegistry(...ids: string[]): Promise<void> {
  for (const id of ids) await su`DELETE FROM public.tenant_groups WHERE id = ${id}::uuid`;
}

describe('F: forward', () => {
  it('a pass runs the due jobs of two tenant groups that have no site, and leaves a future job alone', async () => {
    const ran: string[] = [];
    handler.run = async (ctx) => {
      ran.push((ctx as JobContext<{ orderId: string }>).job.id);
    };
    const a = await schedule(groupA);
    const b = await schedule(groupB);
    const later = await schedule(groupB, { runAt: new Date(Date.now() + 60 * MINUTE) });

    expect(await runCommercePass()).toEqual({ tenantGroups: 2, skipped: 0, ran: 2, failed: 0 });

    expect(ran.sort()).toEqual([a, b].sort());
    expect((await read(groupA, a)).status).toBe('done');
    expect((await read(groupB, b)).status).toBe('done');
    expect((await read(groupB, later)).status).toBe('pending');
  });

  it('with nothing to do a pass is harmless, and the route answers 200 with zeros', async () => {
    const res = await watchdog();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tenantGroups: 2,
      skipped: 0,
      ran: 0,
      failed: 0,
      deadUnacknowledged: 0,
      purgesStuck: 0,
      purges: 'ok',
      findingsOpen: 0,
      oldestDueSeconds: 0,
      receiptsUnissued: 0,
      receipts: 'ok',
    });
  });

  it('stops at 20 jobs of a group in one pass, and the next pass takes the rest', async () => {
    for (let n = 0; n < 23; n += 1) await schedule(groupA);
    expect((await runCommercePass()).ran).toBe(20);
    expect((await runCommercePass()).ran).toBe(3);
  });
});

describe('B: a group that cannot be worked on', () => {
  it('skips a group without a schema and one whose schema has no job table, and runs the others', async () => {
    const noSchema = await registerEmptyGroup('provisioning');
    const noTable = await registerEmptyGroup('active');
    await su`CREATE SCHEMA ${su(tenantSchema(noTable))}`;
    await su`GRANT USAGE ON SCHEMA ${su(tenantSchema(noTable))} TO commerce_app`;
    const job = await schedule(groupA);
    try {
      const res = await watchdog();
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ tenantGroups: 2, skipped: 2, ran: 1, failed: 0 });
      expect((await read(groupA, job)).status).toBe('done');
      expect(console.error).not.toHaveBeenCalled();
    } finally {
      await dropFromRegistry(noSchema, noTable);
      await su`DROP SCHEMA ${su(tenantSchema(noTable))}`;
    }
  });

  it('a failing group stops no other, and the route answers 500 with the report', async () => {
    const schema = tenantSchema(groupA);
    await su`REVOKE ALL ON ${su(schema)}."commerce_job" FROM commerce_app`;
    const job = await schedule(groupB);
    try {
      const res = await watchdog();
      expect(res.status).toBe(500);
      const { error } = await res.json();
      expect(error.code).toBe('commerce_jobs_unhealthy');
      expect(error.report).toMatchObject({ tenantGroups: 1, ran: 1, failed: 1 });
      expect((await read(groupB, job)).status).toBe('done');
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`tenant group ${groupA}`), expect.anything());
    } finally {
      await su`GRANT SELECT, INSERT, UPDATE, DELETE ON ${su(schema)}."commerce_job" TO commerce_app`;
    }
  });

  it('runs the jobs of a suspended group: suspending stops provisioning, not a shop that is selling', async () => {
    await su`UPDATE public.tenant_groups SET status = 'suspended' WHERE id = ${groupB}::uuid`;
    const job = await schedule(groupB);
    try {
      await runCommercePass();
      expect((await read(groupB, job)).status).toBe('done');
    } finally {
      await su`UPDATE public.tenant_groups SET status = 'active' WHERE id = ${groupB}::uuid`;
    }
  });
});

describe('R: resume', () => {
  it('two passes at once run each job once', async () => {
    const runs = new Map<string, number>();
    handler.run = async (ctx) => {
      const { id } = (ctx as JobContext<unknown>).job;
      runs.set(id, (runs.get(id) ?? 0) + 1);
      await new Promise((resolve) => setTimeout(resolve, 5));
    };
    for (let n = 0; n < 8; n += 1) await schedule(groupA);

    const [first, second] = await Promise.all([runCommercePass(), runCommercePass()]);

    expect(first.ran + second.ran).toBe(8);
    expect(runs.size).toBe(8);
    expect([...runs.values()]).toEqual(Array(8).fill(1));
  });

  it('a pass after a restart picks up what was due, and what a dead process held once its lease ends', async () => {
    const waiting = await schedule(groupA);
    const held = await schedule(groupA, { runAt: new Date(Date.now() - 2000) });
    const claimedAt = new Date();
    const crashed = await claimJob(commerceTenantDb(groupA), { kinds: ['test'], now: claimedAt });
    expect(crashed?.id).toBe(held);

    // Inside the lease the held job stays held.
    await runCommercePass();
    expect((await read(groupA, waiting)).status).toBe('done');
    expect((await read(groupA, held)).status).toBe('running');

    await runCommercePass({ now: () => new Date(claimedAt.getTime() + JOB_LEASE_MS + 1) });
    expect((await read(groupA, held)).status).toBe('done');
  });

  it('a job started late has a fresh lease: it starts when the job does, not when the pass did', async () => {
    const t0 = new Date('2030-01-01T10:00:00.000Z');
    let clock = t0.getTime();
    const leases: number[] = [];
    handler.run = async (ctx) => {
      leases.push((await read(groupA, (ctx as JobContext<unknown>).job.id)).run_at.getTime() - clock);
      clock += 8 * MINUTE;
    };
    await schedule(groupA, { runAt: new Date(t0.getTime() - 3000) });
    await schedule(groupA, { runAt: new Date(t0.getTime() - 2000) });
    await schedule(groupA, { runAt: new Date(t0.getTime() - 1000) });

    expect((await runCommercePass({ now: () => new Date(clock) })).ran).toBe(3);
    expect(clock - t0.getTime()).toBe(24 * MINUTE);
    expect(leases).toEqual([JOB_LEASE_MS, JOB_LEASE_MS, JOB_LEASE_MS]);
  });

  it('SIGTERM on a real process: the job in hand finishes, nothing new is claimed, and the process ends', async () => {
    const first = randomUUID();
    const seeded = [
      await schedule(groupA, { kind: 'held', orderId: first, runAt: new Date(Date.now() - 3000) }),
      await schedule(groupA, { kind: 'held', runAt: new Date(Date.now() - 2000) }),
      await schedule(groupA, { kind: 'held', runAt: new Date(Date.now() - 1000) }),
    ];

    const child = spawn(process.execPath, ['--conditions=react-server', '--import', 'tsx', POLLER_PROCESS], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH, TZ: 'UTC', NODE_ENV: 'test', COMMERCE_APP_DATABASE_URL: appUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    const ended = new Promise<NodeJS.Signals | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (_code, signal) => resolve(signal));
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
        if (stdout.includes('started')) resolve();
      });
      void ended.then(() => reject(new Error(`the worker ended early: ${stderr}`)));
    });
    child.kill('SIGTERM');

    expect(await ended, stderr).toBe('SIGTERM');
    expect(stdout).toBe(`started ${first}\nfinished ${first}\n`);
    const states = await Promise.all(seeded.map(async (id) => (await read(groupA, id)).status));
    expect(states).toEqual(['done', 'pending', 'pending']);
  }, 60_000);
});

describe('E: re-entry after completion or failure', () => {
  it('the route answers 500 on a job over 10 minutes late, a kind this build does not know included', async () => {
    await schedule(groupA, { kind: 'from_a_newer_build', runAt: new Date(Date.now() - 11 * MINUTE) });
    const res = await watchdog();
    expect(res.status).toBe(500);
    const { error } = await res.json();
    expect(error.code).toBe('commerce_jobs_unhealthy');
    expect(error.report.failed).toBe(0);
    expect(error.report.oldestDueSeconds).toBeGreaterThan(10 * 60);
  });

  it('a job due for under 10 minutes is reported and stays 200; a job not due yet is not late', async () => {
    await schedule(groupB, { kind: 'from_a_newer_build', runAt: new Date(Date.now() - 2 * MINUTE) });
    await schedule(groupB, { kind: 'from_a_newer_build', runAt: new Date(Date.now() + 2 * MINUTE) });
    const res = await watchdog();
    expect(res.status).toBe(200);
    const report = await res.json();
    expect(report.oldestDueSeconds).toBeGreaterThanOrEqual(120);
    expect(report.oldestDueSeconds).toBeLessThan(10 * 60);
  });

  it('a form purge that keeps failing is reported as stuck (purgesStuck, purges "stuck") and the route stays 200; below five failures it is not', async () => {
    // Not due yet, so the pass does not run it: this is a job waiting out its backoff after failures.
    const purge = await schedule(groupA, { kind: 'form_purge', runAt: new Date(Date.now() + 60 * MINUTE) });
    await su`UPDATE ${su(tenantSchema(groupA))}."commerce_job" SET attempts = 4 WHERE id = ${purge}`;
    let res = await watchdog();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ purgesStuck: 0, purges: 'ok' });

    await su`UPDATE ${su(tenantSchema(groupA))}."commerce_job" SET attempts = 5 WHERE id = ${purge}`;
    res = await watchdog();
    // The status code is the other monitors' business: a stuck purge is a count with its own keyword, never a 500.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ purgesStuck: 1, purges: 'stuck', failed: 0, deadUnacknowledged: 0 });

    // Another kind with many attempts is not a purge; a second group's stuck purge adds up.
    const other = await schedule(groupB, { kind: 'form_purge', runAt: new Date(Date.now() + 60 * MINUTE) });
    await su`UPDATE ${su(tenantSchema(groupB))}."commerce_job" SET attempts = 9 WHERE id = ${other}`;
    expect((await runCommerceWatchdogPass()).purgesStuck).toBe(2);
    // The totals survive overlapping reads: the first group's count is held back while the second group's is added. With a total
    // read before the wait (`total += await count()`) the held group's addition overwrote the other's and this was 1.
    purgeCount.holdFirstPositiveMs = 400;
    expect((await runCommerceWatchdogPass()).purgesStuck).toBe(2);
    expect(purgeCount.holdFirstPositiveMs).toBe(0);
    // Once a purge is gone (it finished and was cleaned up) it no longer counts.
    await su`DELETE FROM ${su(tenantSchema(groupA))}."commerce_job" WHERE id = ${purge}`;
    expect((await runCommerceWatchdogPass()).purgesStuck).toBe(1);
  });

  it('a purge that keeps outliving its lease sits in running and still counts as stuck', async () => {
    const purge = await schedule(groupA, { kind: 'form_purge', runAt: new Date(Date.now() + 60 * MINUTE) });
    await su`UPDATE ${su(tenantSchema(groupA))}."commerce_job" SET status = 'running', claim_token = 'held-by-a-worker', attempts = 6 WHERE id = ${purge}`;
    expect(await (await watchdog()).json()).toMatchObject({ purgesStuck: 1, purges: 'stuck' });
    // Below the threshold a running purge is just a purge in progress.
    await su`UPDATE ${su(tenantSchema(groupA))}."commerce_job" SET attempts = 2 WHERE id = ${purge}`;
    expect(await (await watchdog()).json()).toMatchObject({ purgesStuck: 0, purges: 'ok' });
  });

  it('the route answers 200 with a count on a dead job, and the count falls when a person acknowledges it', async () => {
    handler.run = async () => {
      throw new JobRefused('only_a_person');
    };
    const dead = await schedule(groupA);

    const res = await watchdog();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ran: 1, failed: 0, deadUnacknowledged: 1 });
    expect((await read(groupA, dead)).last_error).toBe('only_a_person');
    expect((await runCommerceWatchdogPass()).deadUnacknowledged).toBe(1);

    expect(await acknowledgeJob(commerceTenantDb(groupA), COMPANY, dead)).toBe(true);
    expect((await runCommerceWatchdogPass()).deadUnacknowledged).toBe(0);
  });
});

describe('the registry read', () => {
  it('a registry the owner role cannot grant on does not fail the start, and the route reports the denied read', async () => {
    await su`REVOKE ALL ON public.tenant_groups FROM commerce_app`;
    await su`ALTER TABLE public.tenant_groups OWNER TO postgres`;
    try {
      await expect(migrateCommercePublic(ownerUrl)).resolves.toEqual([]);

      const res = await watchdog();
      expect(res.status).toBe(500);
      expect((await res.json()).error.code).toBe('commerce_jobs_unhealthy');
      expect(console.error).toHaveBeenCalledWith(
        '[commerce-job] the watchdog pass failed:',
        expect.objectContaining({ message: expect.stringContaining('permission denied') }),
      );
    } finally {
      await su`ALTER TABLE public.tenant_groups OWNER TO commerce_ddl`;
      await migrateCommercePublic(ownerUrl);
    }
    expect((await watchdog()).status).toBe(200);
  });
});

describe('hourly duties', () => {
  it('delete done jobs past 90 days, once an hour per group, and run the backfills beside them', async () => {
    const base = new Date('2031-06-01T10:00:00.000Z');
    const db = commerceTenantDb(groupA);
    const old = await schedule(groupA, { runAt: new Date(base.getTime() + DAY) });
    const recent = await schedule(groupA, { runAt: new Date(base.getTime() + DAY) });
    const deadOld = await schedule(groupA, { runAt: new Date(base.getTime() + DAY) });
    const finished = (id: string, status: 'done' | 'dead', age: number) =>
      db.updateTable('commerce_job').set({ status, finished_at: new Date(base.getTime() - age) }).where('id', '=', id).execute();
    await finished(old, 'done', 91 * DAY);
    await finished(recent, 'done', 89 * DAY);
    await finished(deadOld, 'dead', 91 * DAY);

    let backfills = 0;
    const backfill = {
      name: 'test',
      run: async () => {
        backfills += 1;
      },
    };
    const remaining = async () => (await db.selectFrom('commerce_job').select('id').execute()).map(({ id }) => id).sort();

    await runCommercePass({ now: () => base, backfills: [backfill] });
    expect(await remaining()).toEqual([recent, deadOld].sort());
    expect(backfills).toBeGreaterThanOrEqual(1);

    const counted = backfills;
    await runCommercePass({ now: () => new Date(base.getTime() + 59 * MINUTE), backfills: [backfill] });
    expect(backfills).toBe(counted);
    await runCommercePass({ now: () => new Date(base.getTime() + 61 * MINUTE), backfills: [backfill] });
    expect(backfills).toBeGreaterThan(counted);
  });

  it('a failing backfill is reported, does not hold up due jobs, and tries again on the next pass', async () => {
    const at = new Date('2033-01-01T10:00:00.000Z');
    let attempts = 0;
    const backfill = {
      name: 'failing',
      run: async () => {
        attempts += 1;
        throw new Error('backfill failed');
      },
    };
    await schedule(groupA, { runAt: new Date(at.getTime() - 1000) });

    const pass = await runCommercePass({ now: () => at, backfills: [backfill] });
    expect(pass).toMatchObject({ ran: 1, failed: 2 });
    expect(attempts).toBe(2);

    await runCommercePass({ now: () => at, backfills: [backfill] });
    expect(attempts).toBe(4);
  });
});
