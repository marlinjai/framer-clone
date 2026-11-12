// The upload and blob-cleanup coordination protocol (coordination.ts) on its REAL Postgres implementation
// (PrismaSiteModels, migration 20261112300000_site_model_coordination), against the integration globalSetup's throwaway
// container. Scratch databases only. The in-memory harness (coordinationInterleaving.test.ts) enumerates every ordering
// of atomic steps; this file proves the steps ARE atomic and ordered on real concurrent connections: the locks, READ
// COMMITTED, the lock timeout, the constraints, and the real upload and cleanup code under concurrent, jittered runs.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { Prisma, type PrismaClient } from '@prisma/client';
import { getPrismaClient } from '@/server/db';
import { latestVersionRepository } from '@/server/sites/__tests__/latestVersionRepository';
import { PrismaSiteModels } from '../prismaModels';
import { PENDING_TTL_MS, TOMBSTONE_LEASE_MS, deleteBlobsCoordinated, reconcileTombstones, type BlobDeleter } from '../coordination';
import { acceptModelUpload } from '../uploadModel';
import type { DecodedStats, ModelBlobStore, ModelReencoder, ModelValidator, SiteModelRecord } from '../ports';

const GROUP = '018f9c10-0000-7000-8000-0000000b6c01';
const MB = 1024 * 1024;
const LIMITS = { servedBytes: 200 * MB, originalBytes: 200 * MB };
const hexOf = () => randomBytes(32).toString('hex');
let prisma: PrismaClient;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function project(id: string) {
  const page = { id: 'home', slug: '', metadata: { title: 'Home', description: 'Home' }, appComponentTree: { id: 'root', type: 'div', componentType: 'host', props: {}, children: [] }, canvasNodes: {} };
  return { id, metadata: { title: 'Site', description: 'A site', createdAt: 1, updatedAt: 2 }, pages: { home: page }, siteSettings: { siteName: 'Site' } } as never;
}
async function makeSite() {
  const scope = { workspaceId: `ws_coord_${randomUUID().slice(0, 8)}`, tenantGroupId: GROUP };
  const id = randomUUID();
  await latestVersionRepository().saveProject(scope, project(id), { companyId: 'company-coord' });
  return id;
}
const record = (siteId: string, sha = hexOf(), over: Partial<SiteModelRecord> = {}): SiteModelRecord => ({
  siteId, sha256: sha, bytes: MB, triangles: 1000, materials: 2, nodes: 5, clips: 1, textures: 1, extensions: [], materialNames: [], nodeNames: [], uploaderId: 'u',
  createdAt: new Date('2026-11-10T10:00:00Z'), lastUsedAt: new Date('2026-11-10T10:00:00Z'), originalSha256: hexOf(), originalBytes: MB, ...over,
});
const begin = (r: PrismaSiteModels, rec: SiteModelRecord, now = new Date(), attempt: string = randomUUID(), ttl = PENDING_TTL_MS) => r.beginUpload({ record: rec, limits: LIMITS, attempt, now, pendingTtlMs: ttl });

beforeAll(() => { prisma = getPrismaClient(); });
afterAll(async () => {
  await prisma.site.deleteMany({ where: { tenantGroupId: GROUP } });
  await prisma.$disconnect();
});

describe('the protocol steps on Postgres', () => {
  it('a pending row is invisible to find, list and touch, counts toward the quota, and is promoted only by its own attempt', async () => {
    const repo = new PrismaSiteModels(prisma);
    const site = await makeSite();
    const rec = record(site);
    const b = await begin(repo, rec);
    expect(b).toMatchObject({ ok: true, takenOver: false });
    if (!b.ok) throw new Error('unreachable');
    expect(await repo.find(site, rec.sha256)).toBeNull();
    expect(await repo.list(site)).toEqual([]);
    expect(await repo.totalBytes(site)).toBe(MB);
    expect(await begin(repo, rec)).toEqual({ ok: false, reason: 'in-progress' });
    expect(await repo.markReady(site, rec.sha256, 'someone-else', new Date())).toBe(false);
    expect(await repo.markReady(site, rec.sha256, b.attempt, rec.lastUsedAt)).toBe(true);
    expect(await repo.find(site, rec.sha256)).toEqual(rec);
    expect(await begin(repo, rec)).toEqual({ ok: false, reason: 'exists' });
    expect(await repo.markReady(site, rec.sha256, b.attempt, new Date())).toBe(false); // already ready
  });

  it('a slow first attempt cannot promote the row a reaper dropped and a second attempt re-created (fencing)', async () => {
    const repo = new PrismaSiteModels(prisma);
    const site = await makeSite();
    const rec = record(site);
    const t0 = new Date('2026-11-12T10:00:00Z');
    const one = await begin(repo, rec, t0, 'one', 1000);
    expect(one.ok).toBe(true);
    const later = new Date(t0.getTime() + 5000);
    expect((await repo.reapPendingUploads(later, 100)).filter((x) => x.siteId === site)).toEqual([{ siteId: site, sha256: rec.sha256 }]);
    expect((await begin(repo, rec, later, 'two', 60_000)).ok).toBe(true);
    expect(await repo.markReady(site, rec.sha256, 'one', later)).toBe(false);
    expect(await repo.find(site, rec.sha256)).toBeNull();
    expect(await repo.markReady(site, rec.sha256, 'two', later)).toBe(true);
  });

  it('taking over an expired pending row replaces it whole (original hash and size) and re-checks the quota', async () => {
    const repo = new PrismaSiteModels(prisma);
    const site = await makeSite();
    const sha = hexOf();
    const t0 = new Date('2026-11-12T10:00:00Z');
    await begin(repo, record(site, sha, { originalSha256: hexOf(), originalBytes: MB }), t0, 'one', 1000);
    const later = new Date(t0.getTime() + 5000);
    const newOriginal = hexOf();
    expect(await begin(repo, record(site, sha, { originalSha256: newOriginal, originalBytes: 3 * MB }), later, 'two', 1000)).toMatchObject({ ok: true, takenOver: true });
    await repo.markReady(site, sha, 'two', later);
    expect(await repo.find(site, sha)).toMatchObject({ originalSha256: newOriginal, originalBytes: 3 * MB });
    const over = await repo.beginUpload({ record: record(site, hexOf(), { originalBytes: 1e9 > 2 ** 31 ? 2 ** 30 : 1e9 }), limits: { servedBytes: LIMITS.servedBytes, originalBytes: 4 * MB }, attempt: 'x', now: later, pendingTtlMs: 1000 });
    expect(over).toEqual({ ok: false, reason: 'originals-quota' });
  });

  it('cleanup: a referenced blob is kept (pending counts, any site), an unreferenced one gets a tombstone that blocks uploads even when expired', async () => {
    const repo = new PrismaSiteModels(prisma);
    const site = await makeSite();
    const other = await makeSite();
    const rec = record(site);
    const t0 = new Date('2026-11-12T10:00:00Z');
    await begin(repo, rec, t0, 'one', 60_000); // pending, never promoted
    const served = `served/${rec.sha256}`;
    expect(await repo.beginDelete({ key: served, attempt: 'c1', now: t0, leaseMs: 1000 })).toEqual({ kind: 'kept', reason: 'referenced' });
    expect(await repo.beginDelete({ key: `original/${rec.originalSha256}`, attempt: 'c1', now: t0, leaseMs: 1000 })).toEqual({ kind: 'kept', reason: 'referenced' });
    await repo.abandonUpload(site, rec.sha256, 'one');
    expect(await repo.beginDelete({ key: served, attempt: 'c1', now: t0, leaseMs: 1000 })).toEqual({ kind: 'started', attempt: 'c1', resumed: false });
    expect(await repo.beginDelete({ key: served, attempt: 'c2', now: t0, leaseMs: 1000 })).toEqual({ kind: 'busy' });
    const expired = new Date(t0.getTime() + 60_000);
    // Expired: still blocks uploads of ANY site; only a takeover cleaner may proceed.
    expect(await begin(repo, record(other, rec.sha256), expired)).toEqual({ ok: false, reason: 'busy' });
    expect(await repo.expiredTombstones(expired, 100)).toContain(served);
    expect(await repo.beginDelete({ key: served, attempt: 'c2', now: expired, leaseMs: 1000 })).toEqual({ kind: 'started', attempt: 'c2', resumed: true });
    expect(await repo.completeDelete(served, 'c1')).toBe(false); // the stale cleaner's token no longer owns it
    expect(await repo.completeDelete(served, 'c2')).toBe(true);
    expect((await begin(repo, record(other, rec.sha256), expired)).ok).toBe(true);
  });

  it('an expired tombstone on a referenced blob is dropped, so uploads are not blocked for ever', async () => {
    const repo = new PrismaSiteModels(prisma);
    const site = await makeSite();
    const rec = record(site);
    const b = await begin(repo, rec);
    if (!b.ok) throw new Error('unreachable');
    await repo.markReady(site, rec.sha256, b.attempt, rec.lastUsedAt);
    const key = `served/${rec.sha256}`;
    const past = new Date('2026-11-12T09:00:00Z');
    await prisma.modelBlobTombstone.create({ data: { key, attempt: 'dead', expiresAt: past } });
    expect(await repo.beginDelete({ key, attempt: 'x', now: new Date('2026-11-12T10:00:00Z'), leaseMs: 1000 })).toEqual({ kind: 'kept', reason: 'referenced' });
    expect(await prisma.modelBlobTombstone.count({ where: { key } })).toBe(0);
  });

  it('cleanup methods are refused on a workspace-scoped repository (they act across every workspace)', async () => {
    const scoped = new PrismaSiteModels(prisma, { workspaceId: 'ws-anything' });
    await expect(scoped.beginDelete({ key: `served/${hexOf()}`, attempt: 'a', now: new Date(), leaseMs: 1000 })).rejects.toThrow(/system level/);
    await expect(scoped.completeDelete(`served/${hexOf()}`, 'a')).rejects.toThrow(/system level/);
    await expect(scoped.expiredTombstones(new Date(), 10)).rejects.toThrow(/system level/);
    await expect(scoped.reapPendingUploads(new Date(), 10)).rejects.toThrow(/system level/);
  });

  it('the constraints: a ready row cannot carry an attempt, a pending row must, keys are validated', async () => {
    const site = await makeSite();
    const ws = (await prisma.site.findUniqueOrThrow({ where: { id: site }, select: { workspaceId: true } })).workspaceId;
    const row = (state: string, attempt: string | null, until: string | null) => prisma.$executeRawUnsafe(
      `INSERT INTO public.site_models (id, site_id, workspace_id, tenant_group_id, sha256, byte_size, triangles, material_count, node_count, clip_count, original_sha256, original_bytes, uploaded_by, state, attempt, pending_until) VALUES ($1, $2, $3, $4, $5, 10, 1, 1, 1, 0, $6, 10, 'u', $7, $8, $9::timestamp)`,
      randomUUID(), site, ws, GROUP, hexOf(), hexOf(), state, attempt, until);
    await expect(row('ready', 'a', null)).rejects.toThrow(/site_models_state_check|check constraint/i);
    await expect(row('pending', null, null)).rejects.toThrow(/site_models_state_check|check constraint/i);
    await expect(row('weird', null, null)).rejects.toThrow(/site_models_state_check|check constraint/i);
    await expect(row('pending', 'a', '2026-11-12 10:00:00')).resolves.toBeDefined();
    await expect(prisma.modelBlobTombstone.create({ data: { key: 'served/zz', attempt: 'a', expiresAt: new Date() } })).rejects.toThrow(/model_blob_tombstones_key_check|check constraint/i);
    await expect(prisma.modelBlobTombstone.create({ data: { key: `site-images/${hexOf()}`, attempt: 'a', expiresAt: new Date() } })).rejects.toThrow(/check constraint/i);
  });

  it('the reaper removes only expired pending rows, in bounded batches, and never a ready row', async () => {
    const repo = new PrismaSiteModels(prisma);
    const site = await makeSite();
    const t0 = new Date('2026-11-12T10:00:00Z');
    const ready = record(site); const stale = record(site); const fresh = record(site);
    const r = await begin(repo, ready, t0, 'r', 1000); if (!r.ok) throw new Error('unreachable');
    await repo.markReady(site, ready.sha256, 'r', ready.lastUsedAt);
    await begin(repo, stale, t0, 's', 1000);
    await begin(repo, fresh, new Date(t0.getTime() + 10_000), 'f', 600_000);
    const gone = await repo.reapPendingUploads(new Date(t0.getTime() + 20_000), 1000);
    expect(gone.filter((g) => g.siteId === site)).toEqual([{ siteId: site, sha256: stale.sha256 }]);
    expect(await repo.find(site, ready.sha256)).not.toBeNull();
    expect(await prisma.siteModel.count({ where: { siteId: site, sha256: fresh.sha256, state: 'pending' } })).toBe(1);
  });
});

describe('real concurrent connections: the locks, READ COMMITTED and the lock timeout', () => {
  const direct = () => postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
  const lockName = (key: string) => `model_blob:${key}`;

  it('the transactions run at READ COMMITTED (and the isolation option is what the database reports)', async () => {
    const level = await prisma.$transaction(async (tx) => (await tx.$queryRaw<{ transaction_isolation: string }[]>`SHOW transaction_isolation`)[0].transaction_isolation, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    expect(level).toBe('read committed');
    // And the repository's own transactions pass exactly that option.
    const seen: unknown[] = [];
    const spy = new Proxy(prisma, { get: (t, p, r) => (p === '$transaction' ? (fn: never, opts: unknown) => { seen.push(opts); return (t as never as { $transaction: (a: unknown, b: unknown) => unknown }).$transaction(fn, opts); } : Reflect.get(t, p, r)) }) as PrismaClient;
    const repo = new PrismaSiteModels(spy);
    const site = await makeSite();
    await begin(repo, record(site));
    await repo.beginDelete({ key: `served/${hexOf()}`, attempt: 'a', now: new Date(), leaseMs: 1000 });
    expect(seen.length).toBe(2);
    for (const o of seen) expect(o).toMatchObject({ isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  });

  it('a cleanup waits for a holder of the blob lock and then sees what the holder committed (it keeps the blob)', async () => {
    const repo = new PrismaSiteModels(prisma);
    const site = await makeSite();
    const rec = record(site);
    const key = `served/${rec.sha256}`;
    const sql = direct();
    try {
      let release!: () => void;
      const holder = sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${lockName(key)}))`;
        // The holder is an upload that already holds the blob lock; it inserts its pending row, then commits.
        const ws = (await prisma.site.findUniqueOrThrow({ where: { id: site }, select: { workspaceId: true } })).workspaceId;
        await tx`INSERT INTO public.site_models (id, site_id, workspace_id, tenant_group_id, sha256, byte_size, triangles, material_count, node_count, clip_count, original_sha256, original_bytes, uploaded_by, state, attempt, pending_until)
                 VALUES (${randomUUID()}, ${site}, ${ws}, ${GROUP}, ${rec.sha256}, 10, 1, 1, 1, 0, ${rec.originalSha256}, 10, 'u', 'pending', 'h', now() + interval '5 minutes')`;
        await new Promise<void>((r) => { release = r; });
      });
      await sleep(300);
      let finished = false;
      const cleaner = repo.beginDelete({ key, attempt: 'c', now: new Date(), leaseMs: 1000 }).then((o) => { finished = true; return o; });
      await sleep(700);
      expect(finished).toBe(false); // blocked on the lock the holder has
      release();
      await holder;
      // READ COMMITTED: after the wait it counts the row the holder just committed.
      expect(await cleaner).toEqual({ kind: 'kept', reason: 'referenced' });
    } finally { await sql.end({ timeout: 2 }); }
  });

  it('an upload waits for a cleanup that holds the blob lock and then sees its tombstone (busy)', async () => {
    const repo = new PrismaSiteModels(prisma);
    const site = await makeSite();
    const rec = record(site);
    const key = `served/${rec.sha256}`;
    const sql = direct();
    try {
      let release!: () => void;
      const holder = sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${lockName(key)}))`;
        await tx`INSERT INTO public.model_blob_tombstones (key, attempt, expires_at) VALUES (${key}, 'c', now() + interval '10 minutes')`;
        await new Promise<void>((r) => { release = r; });
      });
      await sleep(300);
      let finished = false;
      const upload = begin(repo, rec).then((o) => { finished = true; return o; });
      await sleep(700);
      expect(finished).toBe(false);
      release();
      await holder;
      expect(await upload).toEqual({ ok: false, reason: 'busy' });
      expect(await prisma.siteModel.count({ where: { siteId: site } })).toBe(0);
    } finally { await sql.end({ timeout: 2 }); }
  });

  it('a lock wait gives up after the lock timeout instead of wedging, and leaves nothing behind', async () => {
    const repo = new PrismaSiteModels(prisma);
    const key = `served/${hexOf()}`;
    const sql = direct();
    try {
      let release!: () => void;
      const holder = sql.begin(async (tx) => { await tx`SELECT pg_advisory_xact_lock(hashtext(${lockName(key)}))`; await new Promise<void>((r) => { release = r; }); });
      await sleep(300);
      const started = Date.now();
      await expect(repo.beginDelete({ key, attempt: 'c', now: new Date(), leaseMs: 1000 })).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(12_000);
      release();
      await holder;
      expect(await prisma.modelBlobTombstone.count({ where: { key } })).toBe(0);
    } finally { await sql.end({ timeout: 2 }); }
  }, 30_000);

  it('uploads of different content to one site cannot both pass the quota (the site lock orders the sums)', async () => {
    const repo = new PrismaSiteModels(prisma);
    const site = await makeSite();
    const outcomes = await Promise.all(Array.from({ length: 12 }, () => repo.beginUpload({ record: record(site), limits: { servedBytes: 5 * MB, originalBytes: LIMITS.originalBytes }, attempt: randomUUID(), now: new Date(), pendingTtlMs: PENDING_TTL_MS })));
    expect(outcomes.filter((o) => o.ok).length).toBe(5);
    expect(outcomes.filter((o) => !o.ok && o.reason === 'quota').length).toBe(7);
  });
});

describe('the real upload and cleanup code under concurrent, jittered runs on Postgres', () => {
  // Storage with file-id semantics (as Storage Brain): put is skipped when a copy is listed; a delete names listed ids.
  class IdStorage {
    readonly files = new Map<string, string>(); private n = 0;
    ids(key: string) { return [...this.files].filter(([, k]) => k === key).map(([id]) => id); }
    has(key: string) { return this.ids(key).length > 0; }
  }
  const enc = new TextEncoder();
  function glb(tag: string): Uint8Array {
    const bin = 8;
    const json = enc.encode(JSON.stringify({ asset: { version: '2.0', generator: tag }, buffers: [{ byteLength: bin }], bufferViews: [{ buffer: 0, byteLength: bin }] }));
    const jl = Math.ceil(json.length / 4) * 4; const bl = 8;
    const out = new Uint8Array(12 + 8 + jl + 8 + bl); const v = new DataView(out.buffer);
    v.setUint32(0, 0x46546c67, true); v.setUint32(4, 2, true); v.setUint32(8, out.length, true);
    v.setUint32(12, jl, true); v.setUint32(16, 0x4e4f534a, true); out.fill(0x20, 20, 20 + jl); out.set(json, 20);
    v.setUint32(20 + jl, bl, true); v.setUint32(24 + jl, 0x004e4942, true);
    return out;
  }
  const SMALL: DecodedStats = { triangles: 1000, maxTextureSide: 1024, boundingBox: [4, 2, 8], materials: 2, nodes: 5, clips: 0, textures: 0 };
  const validator: ModelValidator = { validate: async () => ({ ok: true }) };
  const sha = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b as unknown as ArrayBuffer))].map((x) => x.toString(16).padStart(2, '0')).join('');
  const jitter = () => sleep(Math.floor(Math.random() * 6));

  /** Runs the concurrent rounds against `repo` and returns the first violation found, or null. */
  type Stats = { upOk: number; upBusy: number; upOther: number; kept: number; deleted: number; retry: number };
  async function rounds(repo: PrismaSiteModels, count: number, stats: Stats = { upOk: 0, upBusy: 0, upOther: 0, kept: 0, deleted: 0, retry: 0 }, opts: { slowRemove?: boolean } = {}): Promise<string | null> {
    for (let i = 0; i < count; i++) {
      const storage = new IdStorage();
      let counter = 0;
      const out = glb(`out-${randomUUID()}`); const input = glb(`in-${randomUUID()}`);
      const served = `served/${await sha(out)}`; const original = `original/${await sha(input)}`;
      for (const k of [served, original]) storage.files.set(`f${++counter}`, k); // a blob left by a site whose rows are gone
      const reencoder: ModelReencoder = { reencode: async () => ({ bytes: out, input: SMALL, output: { ...SMALL }, names: { materials: [], nodes: [] } }) };
      const blobs: ModelBlobStore = {
        put: async (k) => { await jitter(); if (!storage.has(k)) storage.files.set(`f${++counter}`, k); },
        get: async () => null, has: async (k) => storage.has(k), list: async () => [],
      };
      const deleter: BlobDeleter = {
        snapshot: async (k) => { await jitter(); return storage.ids(k); },
        // `slowRemove` widens the window between a cleaner's tombstone and its storage delete (a slow storage call).
        removeSnapshot: async (_k, snap) => { await (opts.slowRemove ? sleep(15 + Math.floor(Math.random() * 20)) : jitter()); for (const id of snap as string[]) storage.files.delete(id); },
        hasBlob: async (k) => { await jitter(); return storage.has(k); },
      };
      const siteB = await makeSite(); const siteC = await makeSite();
      const upload = (site: string) => jitter().then(() => acceptModelUpload(input, site, 'u', { blobs, models: repo, coordinator: repo, validator, reencoder }));
      const clean = () => jitter().then(() => deleteBlobsCoordinated([served, original], { coordinator: repo, storage: deleter }));
      const [u1, u2, c1, c2] = await Promise.all([upload(siteB), upload(siteC), clean(), clean()]);
      for (const u of [u1, u2]) { if (u.ok) stats.upOk++; else if (u.code === 'busy') stats.upBusy++; else stats.upOther++; }
      for (const c of [c1, c2]) { stats.kept += c.kept.length; stats.deleted += c.deleted.length; stats.retry += c.retry.length; }
      // No actor crashed, so nothing may be left pending: an upload that returned ok promoted its row, a refused one released it.
      if (await prisma.siteModel.count({ where: { siteId: { in: [siteB, siteC] }, state: 'pending' } })) return `round ${i}: a pending row was left by an upload that finished`;
      // Recovery: leftovers of an interrupted run would be taken over after their lease; here time simply passes.
      const later = new Date(Date.now() + 2 * 60 * 60_000);
      await repo.reapPendingUploads(later, 1000);
      await reconcileTombstones({ coordinator: repo, storage: deleter, now: () => later, leaseMs: TOMBSTONE_LEASE_MS });
      if (await prisma.modelBlobTombstone.count({ where: { key: { in: [served, original] } } })) return `round ${i}: a tombstone survived recovery`;
      // Every ready row of these sites has both blobs.
      for (const r of await prisma.siteModel.findMany({ where: { siteId: { in: [siteB, siteC] } } })) {
        if (r.state !== 'ready') return `round ${i}: a pending row survived recovery`;
        if (!storage.has(`served/${r.sha256}`)) return `round ${i}: the ready row of ${r.siteId} has no served blob`;
        if (!storage.has(`original/${r.originalSha256}`)) return `round ${i}: the ready row of ${r.siteId} has no original blob`;
      }
      // A repeated upload (the busy ones were told to retry) succeeds, and its blob is there.
      for (const site of [siteB, siteC]) {
        const retry = await upload(site);
        if (!retry.ok) return `round ${i}: the retried upload was refused (${retry.code})`;
        if (!storage.has(served)) return `round ${i}: the retried upload left no served blob`;
      }
    }
    return null;
  }

  it('upload vs cleanup, two sites, two cleaners: no ready row ever lacks its blobs, and nothing is left over', async () => {
    const stats: Stats = { upOk: 0, upBusy: 0, upOther: 0, kept: 0, deleted: 0, retry: 0 };
    expect(await rounds(new PrismaSiteModels(prisma), 60, stats)).toBeNull();
    // The dangerous orderings were really reached: uploads won (their blobs were kept), cleanups won (uploads told to retry).
    expect(stats.upOk).toBeGreaterThan(0);
    expect(stats.upBusy).toBeGreaterThan(0);
    expect(stats.kept).toBeGreaterThan(0);
    expect(stats.deleted).toBeGreaterThan(0);
  }, 280_000);

  it('MUTATION: an upload that ignores tombstones is caught by the same concurrent rounds', async () => {
    class IgnoresTombstones extends PrismaSiteModels {
      override async beginUpload(i: Parameters<PrismaSiteModels['beginUpload']>[0]) {
        // Arrives after the cleaner's tombstone (a later request) and removes it first, as if the check were not there.
        await sleep(12);
        await prisma.modelBlobTombstone.deleteMany({ where: { key: { in: [`served/${i.record.sha256}`, `original/${i.record.originalSha256}`] } } });
        return super.beginUpload(i);
      }
    }
    expect(await rounds(new IgnoresTombstones(prisma), 80, undefined, { slowRemove: true })).toMatch(/has no (served|original) blob/);
    // And the real protocol survives the very same slow deletes.
    expect(await rounds(new PrismaSiteModels(prisma), 40, undefined, { slowRemove: true })).toBeNull();
  }, 280_000);

  it('MUTATION: a cleanup that does not count pending rows is caught by the same concurrent rounds', async () => {
    class IgnoresPending extends PrismaSiteModels {
      override async beginDelete(i: Parameters<PrismaSiteModels['beginDelete']>[0]) {
        const hit = await prisma.siteModel.count({ where: { OR: [{ sha256: i.key.slice(i.key.indexOf('/') + 1) }, { originalSha256: i.key.slice(i.key.indexOf('/') + 1) }], state: 'ready' } });
        if (hit > 0) return { kind: 'kept', reason: 'referenced' } as const;
        // Writes the tombstone WITHOUT looking at pending rows: the flaw.
        await sleep(Math.floor(Math.random() * 4));
        await prisma.modelBlobTombstone.upsert({ where: { key: i.key }, create: { key: i.key, attempt: i.attempt, expiresAt: new Date(i.now.getTime() + i.leaseMs) }, update: { attempt: i.attempt, expiresAt: new Date(i.now.getTime() + i.leaseMs) } });
        return { kind: 'started', attempt: i.attempt, resumed: false } as const;
      }
    }
    // The violation is the right one: a ready row whose blob is gone.
    expect(await rounds(new IgnoresPending(prisma), 150)).toMatch(/has no (served|original) blob/);
  }, 280_000);
});

describe('the migration 20261112300000_site_model_coordination on a scratch database', () => {
  const migrationsDir = path.join(process.cwd(), 'prisma/migrations');
  const first = path.join(migrationsDir, '20261112200000_site_models/migration.sql');
  const dir = path.join(migrationsDir, '20261112300000_site_model_coordination');
  const migrationFile = path.join(dir, 'migration.sql');
  const rollbackFile = path.join(dir, 'rollback.sql');
  const migration = readFileSync(migrationFile, 'utf8');
  const admin = () => postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
  const dbName = `scratch_coord_${randomUUID().slice(0, 8)}`;
  let url: string;

  beforeAll(async () => {
    const a = admin();
    await a`CREATE DATABASE ${a(dbName)}`;
    await a.end();
    url = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
    const s = postgres(url, { max: 1, onnotice: () => undefined });
    await s`CREATE TABLE public.sites (id text PRIMARY KEY, workspace_id text NOT NULL, UNIQUE (id, workspace_id))`;
    await s`CREATE TABLE public.sentinel (id int)`;
    await s`INSERT INTO public.sentinel VALUES (1)`;
    await s`INSERT INTO public.sites VALUES ('s1', 'w')`;
    await s.file(first); // the previous migration, already applied in production
    await s`CREATE TABLE public._prisma_migrations (migration_name text PRIMARY KEY)`;
    await s`INSERT INTO public._prisma_migrations VALUES ('20261112200000_site_models'), ('20261112300000_site_model_coordination'), ('20261112180000_site_branch_backstops')`;
    await s`DELETE FROM public._prisma_migrations WHERE migration_name = '20261112300000_site_model_coordination'`;
    await s.end();
  });
  afterAll(async () => {
    const a = admin();
    await a`DROP DATABASE IF EXISTS ${a(dbName)} WITH (FORCE)`;
    await a.end();
  });

  const shape = async (s: postgres.Sql) => (await s`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2`).map((r) => `${r.table_name}.${r.column_name}:${r.data_type}:${r.is_nullable}:${r.column_default}`);
  const history = async (s: postgres.Sql) => (await s`SELECT migration_name FROM public._prisma_migrations ORDER BY 1`).map((r) => r.migration_name as string);

  it('applies on top of a table that already holds a row (it becomes ready), rolls back to exactly the previous shape, and applies again', async () => {
    const s = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      await s`INSERT INTO public.site_models (id, site_id, workspace_id, tenant_group_id, sha256, byte_size, triangles, material_count, node_count, clip_count, original_sha256, original_bytes, uploaded_by) VALUES ('m1', 's1', 'w', 'g', ${'a'.repeat(64)}, 10, 1, 1, 1, 0, ${'b'.repeat(64)}, 10, 'u')`;
      const before = await shape(s);
      await s.file(migrationFile);
      expect((await s`SELECT state, attempt, pending_until FROM public.site_models WHERE id = 'm1'`)[0]).toMatchObject({ state: 'ready', attempt: null, pending_until: null });
      expect((await s`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`).map((r) => r.table_name)).toContain('model_blob_tombstones');
      // A second apply fails and nothing changes.
      await expect(s.file(migrationFile)).rejects.toThrow(/already exists/);
      expect((await s`SELECT count(*)::int AS n FROM public.site_models`)[0].n).toBe(1);

      // The rollback, in one transaction as its header says: it also drops a pending row (its column goes), keeps ready rows.
      await s`INSERT INTO public.site_models (id, site_id, workspace_id, tenant_group_id, sha256, byte_size, triangles, material_count, node_count, clip_count, original_sha256, original_bytes, uploaded_by, state, attempt, pending_until) VALUES ('m2', 's1', 'w', 'g', ${'c'.repeat(64)}, 10, 1, 1, 1, 0, ${'d'.repeat(64)}, 10, 'u', 'pending', 'x', now())`;
      await s`INSERT INTO public._prisma_migrations VALUES ('20261112300000_site_model_coordination')`;
      await s.begin(async (tx) => { await tx.file(rollbackFile); });
      expect(await shape(s)).toEqual(before);
      expect((await s`SELECT id FROM public.site_models ORDER BY 1`).map((r) => r.id)).toEqual(['m1']);
      expect(await history(s)).toEqual(['20261112180000_site_branch_backstops', '20261112200000_site_models']);
      expect((await s`SELECT count(*)::int AS n FROM public.sentinel`)[0].n).toBe(1);
      await s.file(rollbackFile); // safe to run twice

      await s.file(migrationFile);
      expect((await s`SELECT state FROM public.site_models WHERE id = 'm1'`)[0].state).toBe('ready');
    } finally { await s.file(rollbackFile).catch(() => undefined); await s.end(); }
  });

  it('leaves nothing behind when an apply fails part way inside a transaction', async () => {
    const s = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      await s`DELETE FROM public.site_models WHERE id <> 'm1'`;
      const before = await shape(s);
      await expect(s.begin(async (tx) => { await tx.file(migrationFile); await tx`SELECT 1/0`; })).rejects.toThrow(/division by zero/);
      expect(await shape(s)).toEqual(before);
      await s.file(migrationFile);
    } finally { await s.file(rollbackFile).catch(() => undefined); await s.end(); }
  });

  it('is additive: it adds columns to site_models and creates model_blob_tombstones, and touches nothing else', async () => {
    const s = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      const others = async () => (await shape(s)).filter((l) => !l.startsWith('site_models.') && !l.startsWith('model_blob_tombstones.'));
      const before = await others();
      const cols = async () => (await s`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'site_models' ORDER BY 1`).map((r) => r.column_name as string);
      const colsBefore = await cols();
      await s.file(migrationFile);
      expect(await others()).toEqual(before);
      expect((await cols()).filter((c) => !colsBefore.includes(c))).toEqual(['attempt', 'pending_until', 'state']);
      expect(colsBefore.every((c) => c)).toBe(true);
      // Every statement is an ALTER of site_models, a CREATE of the tombstone table or an index on one of the two.
      const statements = migration.replace(/--[^\n]*/g, '').split(';').map((p) => p.trim()).filter(Boolean);
      for (const st of statements) expect(st).toMatch(/^(ALTER TABLE "public"\."site_models"|CREATE TABLE "public"\."model_blob_tombstones"|CREATE INDEX "(site_models|model_blob_tombstones)_[a-z_]+" ON "public"\."(site_models|model_blob_tombstones)")/);
      // No existing column is dropped, retyped or made stricter: the only ALTERs are ADDs.
      for (const st of statements.filter((p) => p.startsWith('ALTER TABLE'))) expect(st).toMatch(/ADD (COLUMN|CONSTRAINT)/);
      expect(statements.some((p) => /DROP|TRUNCATE|DELETE|UPDATE|RENAME/i.test(p))).toBe(false);
    } finally { await s.file(rollbackFile).catch(() => undefined); await s.end(); }
  });
});
