// src/server/commerce/jobs/__tests__/jobs.itest.ts
//
// The job table and engine against real Postgres, connected as the low-privilege `commerce_app` role through the real
// scoped handle (docs/plans/2026-11-02-shop-backbone.md, slice B1). The test names follow the stateful flow standard:
// F forward, B backtrack, R resume after a crash, E re-entry after completion or failure.
//
// The clock is passed in, so a lease or a give-up period ends without waiting for it. The crash test does not simulate:
// it starts real worker processes that SIGKILL themselves inside the handler.
//
// TRUST auth, no password literals, as catalog.isolation.itest.ts. The `.itest.ts` suffix keeps this out of `pnpm test`.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import postgres from 'postgres';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { assertTenantGroupId, migratePublic, provisionTenant, tenantDb, tenantSchema } from '@marlinjai/tenant-db';
import { createNodeDb } from '@marlinjai/tenant-db/node';

import { toJsonb } from '../../../books/snapshots';
import type { CommerceDB } from '../../db-types';
import { commerceProvisionOptions } from '../../provisioning/provision';
import {
  acknowledgeJob,
  CLAIMED_REPEATEDLY,
  claimJob,
  claimQuery,
  finishDone,
  finishRetry,
  requeueJob,
} from '../claim';
import { emitCommerceEvent, scheduleJob } from '../emit';
import { COMMERCE_CONSUMERS } from '../consumers';
import { runJobNow, runNextJob } from '../run';
import {
  defineJobKind,
  JOB_LEASE_MS,
  JobRefused,
  JobRetryLater,
  type CommerceJob,
  type ConsumerRegistry,
  type JobContext,
  type JobPolicy,
  type JobRerun,
  type ScheduledJob,
} from '../types';

const DB_NAME = 'framer_clone_jobs';
const APP_ROLE = 'commerce_app';

const TG_A = assertTenantGroupId('018f9c10-0000-7000-8000-00000000b1a1');
const TG_B = assertTenantGroupId('018f9c10-0000-7000-8000-00000000b1b1');
const COMPANY = '018f9c10-0000-7000-8000-00000000c001';
const OTHER_COMPANY = '018f9c10-0000-7000-8000-00000000c002';

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const CRASHING_WORKER = fileURLToPath(new URL('./fixtures/crashingWorker.ts', import.meta.url));

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const T0 = new Date('2026-11-01T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const clock = (ms: number) => () => at(ms);

/** The one test kind of this slice: a payload of one id, and a handler each test supplies. */
const Payload = z.object({ orderId: z.string() });
type Payload = z.infer<typeof Payload>;
type Handler = (ctx: JobContext<Payload>) => Promise<void | JobRerun<Payload>>;

const POLICY: JobPolicy = { deadlineMs: 30_000, backoffMinutes: [1, 5], laterMinutes: 360, giveUpAfterMs: 3 * DAY };

function testKinds(run: Handler, policy: Partial<JobPolicy> = {}) {
  return { test: defineJobKind({ policy: { ...POLICY, ...policy }, payload: Payload, run }) };
}

const succeed: Handler = async () => undefined;

let container: StartedTestContainer | undefined;
let owner: postgres.Sql | undefined;
let appUrl = '';
let base: Kysely<CommerceDB> | undefined;
let db: Kysely<CommerceDB>;
let dbB: Kysely<CommerceDB>;

beforeAll(async () => {
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
  owner = postgres(`postgresql://postgres@${host}:${port}/${DB_NAME}`, { max: 1, prepare: false });
  await owner`CREATE ROLE ${owner(APP_ROLE)} LOGIN`;
  await owner`ALTER ROLE ${owner(APP_ROLE)} SET search_path = ext`;
  await migratePublic(owner);
  await owner`GRANT USAGE ON SCHEMA ext TO ${owner(APP_ROLE)}`;
  await provisionTenant(owner, commerceProvisionOptions(TG_A, 'b1-a'));
  await provisionTenant(owner, commerceProvisionOptions(TG_B, 'b1-b'));

  appUrl = `postgresql://${APP_ROLE}@${host}:${port}/${DB_NAME}`;
  base = createNodeDb<CommerceDB>({ connectionString: appUrl, max: 10 });
  db = tenantDb(base, TG_A);
  dbB = tenantDb(base, TG_B);
}, 180_000);

afterAll(async () => {
  await base?.destroy();
  await owner?.end();
  await container?.stop();
});

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await db.deleteFrom('commerce_job').execute();
  await dbB.deleteFrom('commerce_job').execute();
  await db.deleteFrom('form_submission').execute();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function job(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    tenantId: COMPANY,
    kind: 'test',
    dedupeKey: `test:${randomUUID()}`,
    payload: { orderId: 'order-1' },
    runAt: T0,
    at: T0,
    ...overrides,
  };
}

async function schedule(overrides: Partial<ScheduledJob> = {}, handle: Kysely<CommerceDB> = db): Promise<string> {
  const id = await handle.transaction().execute((trx) => scheduleJob(trx, job(overrides)));
  if (id === null) throw new Error('the job was not written');
  return id;
}

async function read(id: string, tenantId = COMPANY, handle: Kysely<CommerceDB> = db): Promise<CommerceJob> {
  return handle
    .selectFrom('commerce_job')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

async function countJobs(handle: Kysely<CommerceDB> = db): Promise<number> {
  return (await handle.selectFrom('commerce_job').select('id').execute()).length;
}

/** One consumer of `order.placed` that writes the test kind, deduped on the order. */
const CONSUMERS: ConsumerRegistry = {
  ...COMMERCE_CONSUMERS,
  'order.placed': [
    {
      enqueue: (trx, event) =>
        scheduleJob(trx, {
          tenantId: event.tenantId,
          kind: 'test',
          dedupeKey: `test:${event.payload.orderId}`,
          eventType: event.type,
          payload: { orderId: event.payload.orderId },
          runAt: event.at,
          at: event.at,
        }),
    },
  ],
};

const PLACED = { tenantId: COMPANY, type: 'order.placed', payload: { orderId: 'order-1', expiresAt: T0 }, at: T0 } as const;

// Never called: compiled by `pnpm typecheck`, which is the proof that a plain handle cannot write a job.
export function aPlainHandleDoesNotCompile(handle: Kysely<CommerceDB>) {
  // @ts-expect-error a job is only ever written in the caller's transaction
  void scheduleJob(handle, job());
  // @ts-expect-error a job is only ever written in the caller's transaction
  void emitCommerceEvent(handle, PLACED);
}

describe('F: forward', () => {
  it('an event emitted in a transaction is claimed, run and done', async () => {
    const ran: Payload[] = [];
    const ids = await db.transaction().execute((trx) => emitCommerceEvent(trx, PLACED, CONSUMERS));
    expect(ids).toHaveLength(1);

    const result = await runNextJob(db, TG_A, {
      kinds: testKinds(async (ctx) => {
        ran.push(ctx.payload);
      }),
      now: clock(MINUTE),
    });

    expect(result).toEqual({ id: ids[0], tenantId: COMPANY, kind: 'test', outcome: 'done' });
    expect(ran).toEqual([{ orderId: 'order-1' }]);
    const row = await read(ids[0]!);
    expect(row).toMatchObject({
      status: 'done',
      event_type: 'order.placed',
      attempts: 1,
      open_claims: 0,
      claim_token: null,
      last_error: null,
      finished_at: at(MINUTE),
    });
    expect(await runNextJob(db, TG_A, { kinds: testKinds(succeed), now: clock(MINUTE) })).toBeNull();
  });

  it('the production registries write what they know, and a pass leaves a kind they do not know alone', async () => {
    await schedule();
    const expiresAt = at(60 * MINUTE);
    const placed = { ...PLACED, payload: { orderId: 'order-1', expiresAt } };
    const [id] = await db.transaction().execute((trx) => emitCommerceEvent(trx, placed));
    expect(await read(id)).toMatchObject({ kind: 'payment_expiry', dedupe_key: 'expiry:order-1', run_at: expiresAt });
    expect(await runNextJob(db, TG_A, { now: clock(MINUTE) })).toBeNull();
    expect(await countJobs()).toBe(2);
  });

  it('a consumer may decide to write nothing', async () => {
    const consumers: ConsumerRegistry = { ...COMMERCE_CONSUMERS, 'order.placed': [{ enqueue: async () => null }] };
    expect(await db.transaction().execute((trx) => emitCommerceEvent(trx, PLACED, consumers))).toEqual([]);
    expect(await countJobs()).toBe(0);
  });

  it('a job is not claimed before it is due, and the oldest due job goes first', async () => {
    const later = await schedule({ runAt: at(10 * MINUTE) });
    const sooner = await schedule({ runAt: at(5 * MINUTE) });
    const kinds = testKinds(succeed);

    expect(await runNextJob(db, TG_A, { kinds, now: clock(4 * MINUTE) })).toBeNull();
    expect((await runNextJob(db, TG_A, { kinds, now: clock(20 * MINUTE) }))?.id).toBe(sooner);
    expect((await runNextJob(db, TG_A, { kinds, now: clock(20 * MINUTE) }))?.id).toBe(later);
  });

  it('{ rerunAt } puts the job back pending with a new payload, a new cycle and counters at zero', async () => {
    const id = await schedule();
    const kinds = testKinds(async () => ({ rerunAt: at(15 * MINUTE), payload: { orderId: 'cursor-2' } }));

    expect((await runNextJob(db, TG_A, { kinds, now: clock(MINUTE) }))?.outcome).toBe('rerun');

    expect(await read(id)).toMatchObject({
      status: 'pending',
      run_at: at(15 * MINUTE),
      payload: { orderId: 'cursor-2' },
      attempts: 0,
      open_claims: 0,
      cycle_started_at: at(MINUTE),
      claim_token: null,
      finished_at: null,
    });
  });

  it('{ rerunAt } without a payload keeps the one the job has', async () => {
    const id = await schedule();
    await runNextJob(db, TG_A, { kinds: testKinds(async () => ({ rerunAt: at(MINUTE) })), now: clock(0) });
    expect((await read(id)).payload).toEqual({ orderId: 'order-1' });
  });

  it('a handler reaches only its own company through ctx.company, and a claim spans both', async () => {
    const insert = (id: string, tenantId: string) =>
      db
        .insertInto('form_submission')
        .values({
          id,
          tenant_id: tenantId,
          workspace_id: 'workspace',
          site_id: 'site',
          page_id: 'page',
          page_path: '/',
          form_id: 'form',
          form_name: 'Contact',
          fields: toJsonb([]),
        })
        .execute();
    await insert('mine', COMPANY);
    await insert('mine-too', COMPANY);
    await insert('theirs', OTHER_COMPANY);
    await schedule({ tenantId: COMPANY });
    await schedule({ tenantId: OTHER_COMPANY, runAt: at(1) });

    const seen: Record<string, string[]> = {};
    const kinds = testKinds(async ({ company }) => {
      const rows = await company.selectFrom('form_submission').select('id').orderBy('id').execute();
      seen[company.tenantId] = rows.map((row) => row.id);
      if (company.tenantId !== COMPANY) return;
      await company.updateTable('form_submission').set({ read_at: T0 }).execute();
      await company.transaction((inner) => inner.deleteFrom('form_submission').where('id', '=', 'mine-too').execute());
      await company.deleteFrom('form_submission').where('id', '=', 'theirs').execute();
    });
    await runNextJob(db, TG_A, { kinds, now: clock(MINUTE) });

    expect(seen).toEqual({ [COMPANY]: ['mine', 'mine-too'] });
    const left = await db.selectFrom('form_submission').select(['id', 'read_at']).orderBy('id').execute();
    expect(left).toEqual([
      { id: 'mine', read_at: T0 },
      { id: 'theirs', read_at: null },
    ]);

    await runNextJob(db, TG_A, { kinds, now: clock(MINUTE) });
    expect(seen[OTHER_COMPANY]).toEqual(['theirs']);
  });
});

describe('B: backtrack', () => {
  it('a rolled-back transaction leaves no job', async () => {
    await expect(
      db.transaction().execute(async (trx) => {
        await emitCommerceEvent(trx, PLACED, CONSUMERS);
        throw new Error('the order did not commit');
      }),
    ).rejects.toThrow('the order did not commit');

    expect(await countJobs()).toBe(0);
    expect(await runNextJob(db, TG_A, { kinds: testKinds(succeed), now: clock(MINUTE) })).toBeNull();
  });

  it('a job written in an open transaction cannot be claimed until it commits', async () => {
    let commit = () => {};
    const open = new Promise<void>((resolve) => {
      commit = resolve;
    });
    let written = () => {};
    const isWritten = new Promise<void>((resolve) => {
      written = resolve;
    });
    const transaction = db.transaction().execute(async (trx) => {
      await emitCommerceEvent(trx, PLACED, CONSUMERS);
      written();
      await open;
    });
    await isWritten;
    expect(await runNextJob(db, TG_A, { kinds: testKinds(succeed), now: clock(MINUTE) })).toBeNull();
    commit();
    await transaction;
    expect((await runNextJob(db, TG_A, { kinds: testKinds(succeed), now: clock(MINUTE) }))?.outcome).toBe('done');
  });

  it('a repeated dedupe key writes one job, inside one company and kind only', async () => {
    const first = await db.transaction().execute((trx) => emitCommerceEvent(trx, PLACED, CONSUMERS));
    const again = await db.transaction().execute((trx) => emitCommerceEvent(trx, PLACED, CONSUMERS));
    expect(first).toHaveLength(1);
    expect(again).toEqual([]);
    expect(await countJobs()).toBe(1);

    const elsewhere = { ...PLACED, tenantId: OTHER_COMPANY };
    expect(await db.transaction().execute((trx) => emitCommerceEvent(trx, elsewhere, CONSUMERS))).toHaveLength(1);
    await schedule({ kind: 'another', dedupeKey: 'test:order-1' });
    expect(await countJobs()).toBe(3);
  });

  it('a finished job keeps its key, so a repeat does not run the work again', async () => {
    await db.transaction().execute((trx) => emitCommerceEvent(trx, PLACED, CONSUMERS));
    await runNextJob(db, TG_A, { kinds: testKinds(succeed), now: clock(MINUTE) });
    expect(await db.transaction().execute((trx) => emitCommerceEvent(trx, PLACED, CONSUMERS))).toEqual([]);
  });
});

describe('R: resume after a crash', () => {
  it('concurrent claimers never get one job twice', async () => {
    const ids = await Promise.all(Array.from({ length: 60 }, () => schedule()));
    const claimed: string[] = [];
    const claimer = async () => {
      for (;;) {
        const row = await claimJob(db, { kinds: ['test'], now: at(MINUTE) });
        if (!row) return;
        claimed.push(row.id);
      }
    };

    await Promise.all(Array.from({ length: 8 }, claimer));

    expect(claimed).toHaveLength(ids.length);
    expect(new Set(claimed)).toEqual(new Set(ids));
  });

  it('of many simultaneous claims of one job, exactly one wins', async () => {
    for (let round = 0; round < 10; round += 1) {
      await schedule();
      const claims = await Promise.all(
        Array.from({ length: 10 }, () => claimJob(db, { kinds: ['test'], now: at(MINUTE) })),
      );
      expect(claims.filter((row) => row !== null)).toHaveLength(1);
      await db.deleteFrom('commerce_job').execute();
    }
  });

  it('a claim skips a locked row instead of waiting for it', async () => {
    const locked = await schedule({ runAt: at(0) });
    const free = await schedule({ runAt: at(1) });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lockTaken = () => {};
    const isLocked = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });
    const holder = db.transaction().execute(async (trx) => {
      await trx.selectFrom('commerce_job').select('id').where('id', '=', locked).forUpdate().execute();
      lockTaken();
      await held;
    });
    await isLocked;

    expect((await claimJob(db, { kinds: ['test'], now: at(MINUTE) }))?.id).toBe(free);
    expect(await claimJob(db, { kinds: ['test'], now: at(MINUTE) })).toBeNull();

    release();
    await holder;
    expect((await claimJob(db, { kinds: ['test'], now: at(MINUTE) }))?.id).toBe(locked);
  });

  it("a killed worker's job is held until its lease ends, then claimed again with a fresh lease", async () => {
    const id = await schedule();
    const first = await claimJob(db, { kinds: ['test'], now: at(MINUTE) });
    expect(first).toMatchObject({ id, status: 'running', attempts: 1, open_claims: 1, run_at: at(MINUTE + JOB_LEASE_MS) });

    expect(await claimJob(db, { kinds: ['test'], now: at(MINUTE + JOB_LEASE_MS - 1) })).toBeNull();

    const later = MINUTE + JOB_LEASE_MS;
    const second = await claimJob(db, { kinds: ['test'], now: at(later) });
    expect(second).toMatchObject({ id, status: 'running', attempts: 2, open_claims: 2, run_at: at(later + JOB_LEASE_MS) });
    expect(second?.claim_token).not.toBe(first?.claim_token);
  });

  it('a stale token changes nothing: the worker that lost its lease cannot end the next one', async () => {
    const id = await schedule();
    const stale = await claimJob(db, { kinds: ['test'], now: at(0) });
    const current = await claimJob(db, { kinds: ['test'], now: at(JOB_LEASE_MS) });
    const before = await read(id);

    expect(await finishDone(db, stale!, at(JOB_LEASE_MS + 1))).toBe(false);
    expect(await finishRetry(db, stale!, at(JOB_LEASE_MS + 1), at(0), 'late')).toBe(false);
    expect(await read(id)).toEqual(before);

    expect(await finishDone(db, current!, at(JOB_LEASE_MS + 2))).toBe(true);
    expect((await read(id)).status).toBe('done');
  });

  it('a worker that wakes after losing its lease answers fenced and leaves the winner\'s result', async () => {
    const id = await schedule();
    let wake = () => {};
    const asleep = new Promise<void>((resolve) => {
      wake = resolve;
    });
    let started = () => {};
    const isStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stalled = runNextJob(db, TG_A, {
      kinds: testKinds(async () => {
        started();
        await asleep;
        throw new Error('too late to matter');
      }),
      now: clock(0),
    });
    await isStarted;

    const winner = await runNextJob(db, TG_A, { kinds: testKinds(succeed), now: clock(JOB_LEASE_MS) });
    expect(winner?.outcome).toBe('done');
    wake();

    expect((await stalled)?.outcome).toBe('fenced');
    expect(await read(id)).toMatchObject({ status: 'done', finished_at: at(JOB_LEASE_MS), last_error: null });
  });

  it('an unknown kind is left alone, whether pending or with a lease that ran out', async () => {
    const newer = await schedule({ kind: 'from_a_newer_build' });
    const before = await read(newer);

    expect(await claimJob(db, { kinds: ['test'], now: at(DAY) })).toBeNull();
    expect(await runJobNow(db, TG_A, COMPANY, newer, { kinds: testKinds(succeed), now: clock(DAY) })).toBeNull();
    expect(await read(newer)).toEqual(before);

    await claimJob(db, { kinds: ['from_a_newer_build'], now: at(0) });
    const leased = await read(newer);
    expect(await claimJob(db, { kinds: ['test'], now: at(DAY) })).toBeNull();
    expect(await read(newer)).toEqual(leased);
  });

  it('runJobNow and the poller cannot both run one job', async () => {
    for (let round = 0; round < 10; round += 1) {
      const id = await schedule();
      let runs = 0;
      const kinds = testKinds(async () => {
        runs += 1;
      });
      const results = await Promise.all([
        runJobNow(db, TG_A, COMPANY, id, { kinds, now: clock(MINUTE) }),
        runNextJob(db, TG_A, { kinds, now: clock(MINUTE) }),
      ]);
      expect(runs).toBe(1);
      expect(results.filter((result) => result?.outcome === 'done')).toHaveLength(1);
    }
  });

  it('runJobNow runs only the job it names, once it is due, and only for its own company', async () => {
    const other = await schedule();
    const id = await schedule({ runAt: at(MINUTE) });
    const kinds = testKinds(succeed);

    expect(await runJobNow(db, TG_A, COMPANY, id, { kinds, now: clock(0) })).toBeNull();
    expect(await runJobNow(db, TG_A, OTHER_COMPANY, id, { kinds, now: clock(MINUTE) })).toBeNull();
    expect((await runJobNow(db, TG_A, COMPANY, id, { kinds, now: clock(MINUTE) }))?.outcome).toBe('done');
    expect((await read(other)).status).toBe('pending');
    expect(await runJobNow(db, TG_A, COMPANY, id, { kinds, now: clock(MINUTE) })).toBeNull();
  });

  it('a claim reads the due index, however many finished jobs the table holds', async () => {
    const table = owner!`${owner!(tenantSchema(TG_A))}.commerce_job`;
    await owner!`
      INSERT INTO ${table} (id, tenant_id, kind, dedupe_key, payload, status, run_at, cycle_started_at, updated_at, finished_at)
      SELECT n::text, ${COMPANY}, 'test', n::text, '{}', 'done', ${T0}, ${T0}, ${T0}, ${T0}
        FROM generate_series(1, 20000) AS n
    `;
    await schedule();
    await owner!`ANALYZE ${table}`;

    const plan = (await claimQuery(db, { kinds: ['test'], now: at(MINUTE) }).explain())
      .map((row) => String(row['QUERY PLAN']))
      .join('\n');

    expect(plan).toContain('commerce_job_due_idx');
    expect(plan).not.toMatch(/Seq Scan/);
    expect(plan).toContain('LockRows');
  });

  it('a claim stays inside its tenant group', async () => {
    await schedule({}, dbB);
    expect(await claimJob(db, { kinds: ['test'], now: at(MINUTE) })).toBeNull();
    expect((await claimJob(dbB, { kinds: ['test'], now: at(MINUTE) }))?.status).toBe('running');
  });

  it('a handler that ignores its deadline is abandoned at the end of its lease, and the worker moves on', async () => {
    const id = await schedule();
    const hangs = testKinds(() => new Promise<void>(() => undefined), { deadlineMs: 10 });

    const result = await runNextJob(db, TG_A, { kinds: hangs, now: clock(0), leaseMs: 50 });

    expect(result?.outcome).toBe('abandoned');
    expect(await read(id)).toMatchObject({ status: 'running', open_claims: 1 });
  });
});

/** One real worker process: the exit signal and, when it lived, what it printed. */
function runCrashingWorker(now: Date): Promise<{ signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--conditions=react-server', '--import', 'tsx', CRASHING_WORKER, appUrl, TG_A, now.toISOString()],
      { cwd: REPO_ROOT, env: { PATH: process.env.PATH, TZ: 'UTC', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (_code, signal) => resolve({ signal, stdout, stderr }));
  });
}

describe('E: re-entry after completion or failure', () => {
  it('a job that kills its process is stopped by the claim: real workers, SIGKILL, three times, then dead', async () => {
    const id = await schedule({ kind: 'crashes' });

    for (let kill = 1; kill <= 3; kill += 1) {
      const worker = await runCrashingWorker(at(kill * JOB_LEASE_MS));
      expect(worker.signal, worker.stderr).toBe('SIGKILL');
      expect(await read(id)).toMatchObject({ status: 'running', open_claims: kill, attempts: kill });
    }

    const worker = await runCrashingWorker(at(4 * JOB_LEASE_MS));

    expect(worker.signal, worker.stderr).toBeNull();
    expect(JSON.parse(worker.stdout)).toEqual({ outcome: 'dead' });
    const row = await read(id);
    expect(row).toMatchObject({
      status: 'dead',
      last_error: CLAIMED_REPEATEDLY,
      claim_token: null,
      finished_at: at(4 * JOB_LEASE_MS),
    });
    // Nothing is left for a fifth worker to die on.
    expect(JSON.parse((await runCrashingWorker(at(5 * JOB_LEASE_MS))).stdout)).toEqual({ outcome: null });
  }, 120_000);

  it('three unfinished claims go dead from the claim, without running the handler a fourth time', async () => {
    const id = await schedule();
    let runs = 0;
    const hangs = testKinds(
      () => {
        runs += 1;
        return new Promise<void>(() => undefined);
      },
      { deadlineMs: 5 },
    );

    for (let claim = 0; claim < 3; claim += 1) {
      const result = await runNextJob(db, TG_A, { kinds: hangs, now: clock(claim * MINUTE), leaseMs: 20 });
      expect(result?.outcome).toBe('abandoned');
    }

    const stopped = await runNextJob(db, TG_A, { kinds: hangs, now: clock(4 * MINUTE), leaseMs: 20 });

    expect(stopped?.outcome).toBe('dead');
    expect(runs).toBe(3);
    expect(await read(id)).toMatchObject({ status: 'dead', last_error: CLAIMED_REPEATEDLY, claim_token: null });
    expect(errorLog.mock.calls.flat().join(' ')).toContain(`test ${id} of company ${COMPANY} is dead`);
  });

  it('any finish returns the crash count to zero, so ordinary retries never add up to a crash', async () => {
    const id = await schedule({});
    await claimJob(db, { kinds: ['test'], now: at(0) });
    await claimJob(db, { kinds: ['test'], now: at(JOB_LEASE_MS) });

    const fails = testKinds(async () => {
      throw new JobRetryLater('later', 0);
    });
    for (let run = 2; run < 8; run += 1) {
      const result = await runNextJob(db, TG_A, { kinds: fails, now: clock(run * JOB_LEASE_MS) });
      expect(result?.outcome).toBe('retry');
      expect((await read(id)).open_claims).toBe(0);
    }
  });

  it('a failure backs off by the policy, keeps a stable reason and never stores the message', async () => {
    const id = await schedule();
    const fails = testKinds(async () => {
      throw new Error('could not reach buyer@example.com');
    });

    expect((await runNextJob(db, TG_A, { kinds: fails, now: clock(0) }))?.outcome).toBe('retry');
    expect(await read(id)).toMatchObject({
      status: 'pending',
      run_at: at(MINUTE),
      attempts: 1,
      open_claims: 0,
      claim_token: null,
      last_error: 'Error',
    });

    await runNextJob(db, TG_A, { kinds: fails, now: clock(MINUTE) });
    expect((await read(id)).run_at).toEqual(at(6 * MINUTE));

    await runNextJob(db, TG_A, { kinds: fails, now: clock(6 * MINUTE) });
    expect((await read(id)).run_at).toEqual(at((6 + 360) * MINUTE));
  });

  it('an error code is kept, and JobRetryLater sets its own reason and delay', async () => {
    const id = await schedule();
    const coded = testKinds(async () => {
      throw Object.assign(new Error('not for the table'), { code: 'BOOKS_NOT_SET_UP' });
    });
    await runNextJob(db, TG_A, { kinds: coded, now: clock(0) });
    expect((await read(id)).last_error).toBe('BOOKS_NOT_SET_UP');

    const later = testKinds(async () => {
      throw new JobRetryLater('provider_busy', 42 * MINUTE);
    });
    await runNextJob(db, TG_A, { kinds: later, now: clock(MINUTE) });
    expect(await read(id)).toMatchObject({ last_error: 'provider_busy', run_at: at(43 * MINUTE) });
  });

  it('a job past give-up goes dead on its failure', async () => {
    const id = await schedule();
    const fails = testKinds(async () => {
      throw new JobRetryLater('provider_down');
    });

    expect((await runNextJob(db, TG_A, { kinds: fails, now: clock(3 * DAY - 1) }))?.outcome).toBe('retry');
    expect((await read(id)).status).toBe('pending');

    expect((await runNextJob(db, TG_A, { kinds: fails, now: clock(4 * DAY) }))?.outcome).toBe('dead');
    expect(await read(id)).toMatchObject({
      status: 'dead',
      last_error: 'provider_down',
      finished_at: at(4 * DAY),
      claim_token: null,
      open_claims: 0,
    });
    expect(await runNextJob(db, TG_A, { kinds: fails, now: clock(40 * DAY) })).toBeNull();
    expect(errorLog.mock.calls.flat().join(' ')).toContain(`test ${id} of company ${COMPANY} is dead: provider_down`);
  });

  it('give-up counts from cycle_started_at: an old recurring job survives one failure', async () => {
    const id = await schedule();
    await runNextJob(db, TG_A, { kinds: testKinds(async () => ({ rerunAt: at(100 * DAY) })), now: clock(100 * DAY - MINUTE) });
    expect((await read(id)).created_at.getTime()).toBeLessThan(at(100 * DAY).getTime());

    const fails = testKinds(async () => {
      throw new JobRetryLater('provider_down');
    });
    expect((await runNextJob(db, TG_A, { kinds: fails, now: clock(100 * DAY) }))?.outcome).toBe('retry');
    expect((await read(id)).status).toBe('pending');
  });

  it('a null give-up never kills on a transient error', async () => {
    await schedule();
    const fails = testKinds(
      async () => {
        throw new JobRetryLater('provider_down');
      },
      { giveUpAfterMs: null },
    );
    expect((await runNextJob(db, TG_A, { kinds: fails, now: clock(1000 * DAY) }))?.outcome).toBe('retry');
  });

  it('JobRefused is dead at once, whatever the give-up says', async () => {
    const id = await schedule();
    const refuses = testKinds(async () => {
      throw new JobRefused('TOTALS_MISMATCH');
    });

    expect((await runNextJob(db, TG_A, { kinds: refuses, now: clock(0) }))?.outcome).toBe('dead');
    expect(await read(id)).toMatchObject({ status: 'dead', last_error: 'TOTALS_MISMATCH', attempts: 1 });
  });

  it('a payload that does not parse is refused at claim, and the handler never runs', async () => {
    const id = await schedule({ payload: { somethingElse: true } });
    let runs = 0;
    const kinds = testKinds(async () => {
      runs += 1;
    });

    expect((await runNextJob(db, TG_A, { kinds, now: clock(0) }))?.outcome).toBe('dead');
    expect(runs).toBe(0);
    expect(await read(id)).toMatchObject({ status: 'dead', last_error: 'payload_invalid' });
  });

  it('a rerun with a payload that does not parse is refused, and the old payload stays', async () => {
    const id = await schedule();
    const kinds = testKinds(async () => ({ rerunAt: at(MINUTE), payload: { orderId: 7 } as unknown as Payload }));

    expect((await runNextJob(db, TG_A, { kinds, now: clock(0) }))?.outcome).toBe('dead');
    expect(await read(id)).toMatchObject({ last_error: 'payload_invalid', payload: { orderId: 'order-1' } });
  });

  it('the signal fires at the deadline, inside the lease, and a handler that heeds it retries', async () => {
    const id = await schedule();
    const kinds = testKinds(
      ({ signal }) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      { deadlineMs: 10 },
    );

    expect((await runNextJob(db, TG_A, { kinds, now: clock(0) }))?.outcome).toBe('retry');
    expect((await read(id)).last_error).toBe('deadline_exceeded');
  });

  it('requeueJob gives a dead job fresh counters and a new cycle, and it runs again', async () => {
    const id = await schedule();
    await runNextJob(db, TG_A, {
      kinds: testKinds(async () => {
        throw new JobRefused('NEEDS_A_PERSON');
      }),
      now: clock(0),
    });
    await acknowledgeJob(db, COMPANY, id, at(1));

    expect(await requeueJob(db, COMPANY, id, at(MINUTE))).toBe(true);

    expect(await read(id)).toMatchObject({
      status: 'pending',
      run_at: at(MINUTE),
      attempts: 0,
      open_claims: 0,
      cycle_started_at: at(MINUTE),
      claim_token: null,
      last_error: null,
      acknowledged_at: null,
      finished_at: null,
    });
    expect((await runNextJob(db, TG_A, { kinds: testKinds(succeed), now: clock(MINUTE) }))?.outcome).toBe('done');
  });

  it('a job stopped by the claim can be requeued too, and is not stopped again at once', async () => {
    const id = await schedule();
    for (let claim = 0; claim <= 3; claim += 1) await claimJob(db, { kinds: ['test'], now: at(claim * JOB_LEASE_MS) });
    expect((await read(id)).status).toBe('dead');

    await requeueJob(db, COMPANY, id, at(5 * JOB_LEASE_MS));

    const again = await runNextJob(db, TG_A, { kinds: testKinds(succeed), now: clock(5 * JOB_LEASE_MS) });
    expect(again?.outcome).toBe('done');
  });

  it('acknowledgeJob marks a dead job once and keeps it dead', async () => {
    const id = await schedule();
    await runNextJob(db, TG_A, {
      kinds: testKinds(async () => {
        throw new JobRefused('NEEDS_A_PERSON');
      }),
      now: clock(0),
    });

    expect(await acknowledgeJob(db, COMPANY, id, at(MINUTE))).toBe(true);
    expect(await acknowledgeJob(db, COMPANY, id, at(2 * MINUTE))).toBe(false);
    expect(await read(id)).toMatchObject({ status: 'dead', acknowledged_at: at(MINUTE) });
  });

  it('requeueJob and acknowledgeJob answer false for another company and for a job that is not dead', async () => {
    const id = await schedule();
    expect(await requeueJob(db, COMPANY, id, at(0))).toBe(false);
    expect(await acknowledgeJob(db, COMPANY, id, at(0))).toBe(false);

    await runNextJob(db, TG_A, {
      kinds: testKinds(async () => {
        throw new JobRefused('NEEDS_A_PERSON');
      }),
      now: clock(0),
    });
    const before = await read(id);

    expect(await requeueJob(db, OTHER_COMPANY, id, at(1))).toBe(false);
    expect(await acknowledgeJob(db, OTHER_COMPANY, id, at(1))).toBe(false);
    expect(await read(id)).toEqual(before);
  });
});
