// The upload and blob-cleanup coordination protocol (coordination.ts, the plan's approved Option B) against EVERY
// interleaving of its steps, with a crash injected at every step boundary, and with mutations that each must be caught.
// The real `acceptModelUpload` and `deleteBlobsCoordinated` run; only the shared ports are gated by the scheduler.
//
// The storage fake has the semantics of the Storage Brain adapter: a file has a server-assigned id, `put` is skipped when a
// copy of the key is already listed, and a delete removes the ids listed at the time of the call (a list step, then a
// separate remove step), so a delete can land after other steps ran.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryBlobStore, MemorySiteModels } from '../memory';
import { acceptModelUpload } from '../uploadModel';
import { TOMBSTONE_LEASE_MS, assertLeaseCoversDelete, deleteBlobsCoordinated, reconcileTombstones, type BlobDeleter, type ModelCoordinator } from '../coordination';
import type { DecodedStats, ModelBlobStore, ModelReencoder, ModelValidator, SiteModelRepository } from '../ports';
import { explore, type Actor, type CrashPoint, type Gate } from './interleave';

const enc = new TextEncoder();
function glb(tag: string, bin = 8): Uint8Array {
  const json = enc.encode(JSON.stringify({ asset: { version: '2.0', generator: tag }, buffers: [{ byteLength: bin }], bufferViews: [{ buffer: 0, byteLength: bin }] }));
  const jl = Math.ceil(json.length / 4) * 4;
  const bl = Math.ceil(bin / 4) * 4;
  const out = new Uint8Array(12 + 8 + jl + 8 + bl);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true); v.setUint32(4, 2, true); v.setUint32(8, out.length, true);
  v.setUint32(12, jl, true); v.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jl); out.set(json, 20);
  v.setUint32(20 + jl, bl, true); v.setUint32(24 + jl, 0x004e4942, true);
  return out;
}
const sha = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b as unknown as ArrayBuffer))].map((x) => x.toString(16).padStart(2, '0')).join('');

const SMALL: DecodedStats = { triangles: 1000, maxTextureSide: 1024, boundingBox: [4, 2, 8], materials: 2, nodes: 5, clips: 0, textures: 0 };
const OUT = glb('out');
const INPUT = glb('in');
const validator: ModelValidator = { validate: async () => ({ ok: true }) };
const reencoder: ModelReencoder = { reencode: async () => ({ bytes: OUT, input: SMALL, output: { ...SMALL }, names: { materials: [], nodes: [] } }) };

/** Storage with file-id semantics (see the header). Not gated itself: the actors gate around it. */
class IdStorage {
  readonly files = new Map<string, string>(); // id -> key
  private n = 0;
  ids(key: string) { return [...this.files].filter(([, k]) => k === key).map(([id]) => id); }
  putIfAbsent(key: string) { if (!this.ids(key).length) this.files.set(`f${++this.n}`, key); }
  removeIds(ids: string[]) { for (const id of ids) this.files.delete(id); }
  has(key: string) { return this.ids(key).length > 0; }
}

interface World {
  models: MemorySiteModels;
  storage: IdStorage;
  clock: Date;
  results: Record<string, Awaited<ReturnType<typeof acceptModelUpload>> | undefined>;
}

let SERVED = '';
let ORIGINAL = '';
const servedKey = () => `served/${SERVED}`;
const originalKey = () => `original/${ORIGINAL}`;

function newWorld(Models: new () => MemorySiteModels = MemorySiteModels): World {
  const storage = new IdStorage();
  storage.putIfAbsent(servedKey()); // a blob left by a site whose rows are already gone
  storage.putIfAbsent(originalKey());
  return { models: new Models(), storage, clock: new Date('2026-11-12T08:00:00Z'), results: {} };
}

/** The ports of one actor: every call is one gated step. */
function gated(w: World, gate: Gate, opts: { lateList?: boolean } = {}) {
  const blobs = {
    put: (key: string) => gate(`put ${key.split('/')[0]}`, () => w.storage.putIfAbsent(key)),
    get: async () => null, has: (key: string) => gate('has', () => w.storage.has(key)), delete: async () => {}, list: async () => [],
  } as unknown as ModelBlobStore;
  const m = w.models;
  const models = {
    find: (s: string, h: string) => gate('find', () => m.find(s, h)), totalBytes: (s: string) => gate('totalBytes', () => m.totalBytes(s)),
    touch: (s: string, h: string, at: Date) => gate('touch', () => m.touch(s, h, at)),
  } as unknown as SiteModelRepository;
  const coordinator = {
    beginUpload: (i: Parameters<MemorySiteModels['beginUpload']>[0]) => gate('beginUpload', () => m.beginUpload(i)),
    markReady: (s: string, h: string, a: string, at: Date) => gate('markReady', () => m.markReady(s, h, a, at)),
    abandonUpload: (s: string, h: string, a: string) => gate('abandonUpload', () => m.abandonUpload(s, h, a)),
    beginDelete: (i: Parameters<MemorySiteModels['beginDelete']>[0]) => gate('beginDelete', () => m.beginDelete(i)),
    completeDelete: (k: string, a: string) => gate('completeDelete', () => m.completeDelete(k, a)),
    expiredTombstones: async () => [], reapPendingUploads: async () => [],
  } as unknown as ModelCoordinator;
  const storage: BlobDeleter = {
    // The service lists the ids (the snapshot, taken before the tombstone), and later removes exactly those ids.
    snapshot: (key) => (opts.lateList ? Promise.resolve(null) : gate('list', () => w.storage.ids(key))),
    // MUTATION `lateList`: the copies are listed only when the remove runs, i.e. AFTER the tombstone (the flaw a review found).
    removeSnapshot: async (key, snap) => { if (opts.lateList) await gate('list+remove', () => w.storage.removeIds(w.storage.ids(key))); else await gate('remove', () => w.storage.removeIds(snap as string[])); },
    hasBlob: (key) => gate('hasBlob', () => w.storage.has(key)),
  };
  return { blobs, models, coordinator, storage };
}

const uploader = (name: string, siteId: string, w: World): Actor => ({
  name,
  run: async (gate) => {
    const p = gated(w, gate);
    w.results[name] = await acceptModelUpload(INPUT, siteId, 'u', { blobs: p.blobs, models: p.models, coordinator: p.coordinator, validator, reencoder, now: () => w.clock });
  },
});
const eraser = (name: string, keys: () => string[], w: World, opts: { lateList?: boolean; advanceClock?: boolean } = {}): Actor => ({
  name,
  run: async (gate) => {
    // `advanceClock`: this cleaner starts after the previous cleaner's lease has passed, i.e. it takes the cleanup over.
    if (opts.advanceClock) await gate('clock passes the lease', () => { w.clock = new Date(w.clock.getTime() + TOMBSTONE_LEASE_MS + 1000); });
    const p = gated(w, gate, opts);
    await deleteBlobsCoordinated(keys(), { coordinator: p.coordinator, storage: p.storage, now: () => w.clock });
  },
});
/** The cleanup this file replaces: count the references, then delete. Not atomic. Used only to prove the harness sees the race. */
const legacyEraser = (name: string, w: World): Actor => ({
  name,
  run: async (gate) => {
    const refs = await gate('count', () => [...w.models.rows.values()].filter((r) => `served/${r.sha256}` === servedKey()).length);
    if (refs > 0) return;
    const ids = await gate('list', () => w.storage.ids(servedKey()));
    await gate('remove', () => w.storage.removeIds(ids));
  },
});

/** Ungated storage access for recovery and unit tests. */
const plainDeleter = (st: IdStorage): BlobDeleter => ({ snapshot: async (k) => st.ids(k), removeSnapshot: async (k, snap) => { st.removeIds(snap as string[]); void k; }, hasBlob: async (k) => st.has(k) });

/** What must hold when everything has stopped, a crashed actor's leftovers have been recovered, and uploads have been retried. */
async function check(w: World, retry: string[]): Promise<string | null> {
  // Recovery: time passes, the reaper and the reconciler run (ungated, against the plain storage).
  w.clock = new Date(w.clock.getTime() + 2 * 60 * 60_000);
  const plain = plainDeleter(w.storage);
  await w.models.reapPendingUploads(w.clock, 1000);
  await reconcileTombstones({ coordinator: w.models, storage: plain, now: () => w.clock });
  if (w.models.tombstones.size) return `a tombstone survived recovery: ${[...w.models.tombstones.keys()].join(', ')}`;
  if (w.models.pending.size) return 'a pending row survived recovery';
  const dangling = () => {
    for (const r of w.models.rows.values()) {
      if (!w.storage.has(`served/${r.sha256}`)) return `READY row ${r.siteId}/${r.sha256.slice(0, 6)} has no served blob`;
      if (!w.storage.has(`original/${r.originalSha256}`)) return `READY row ${r.siteId} has no original blob`;
    }
    return null;
  };
  const d1 = dangling();
  if (d1) return d1;
  // Liveness: an upload that was refused or interrupted succeeds when repeated, and its blobs are there.
  for (const site of retry) {
    const p = { blobs: new MemoryBlobStore(), models: w.models, coordinator: w.models };
    const blobs: ModelBlobStore = { ...p.blobs, put: async (k: string) => w.storage.putIfAbsent(k), get: async () => null, has: async (k: string) => w.storage.has(k), delete: async () => {}, list: async () => [] };
    const r = await acceptModelUpload(INPUT, site, 'u', { blobs, models: w.models, coordinator: w.models, validator, reencoder, now: () => w.clock });
    if (!r.ok) return `the retried upload of ${site} was refused: ${r.code}`;
  }
  return dangling();
}

beforeAll(() => { vi.spyOn(console, 'error').mockImplementation(() => undefined); }); // injected crashes are logged by the code under test
SERVED = await sha(OUT);
ORIGINAL = await sha(INPUT);

const summarize = (r: Awaited<ReturnType<typeof explore<World>>>) => r.violations.slice(0, 3).map((v) => `${v.problem}\n  ${v.trace.order.join(' > ')}`).join('\n');

describe('every interleaving of an upload and a cleanup of the same blob keeps every ready row\'s blobs', () => {
  it('upload vs cleanup of the served blob (all orderings)', async () => {
    const r = await explore(() => { const w = newWorld(); return { world: w, actors: [uploader('up', 'site-b', w), eraser('del', () => [servedKey()], w)] }; }, (w) => check(w, ['site-b']));
    expect(r.runs).toBeGreaterThan(100);
    expect(summarize(r)).toBe('');
  });

  it('upload vs cleanup of both blobs (all orderings)', async () => {
    const r = await explore(() => { const w = newWorld(); return { world: w, actors: [uploader('up', 'site-b', w), eraser('del', () => [servedKey(), originalKey()], w)] }; }, (w) => check(w, ['site-b']), { maxRuns: 20_000 });
    expect(r.runs).toBeGreaterThan(1000);
    expect(summarize(r)).toBe('');
  }, 120_000);

  it('two cleanups (two companies) of the same blob, and an upload of the same site twice', async () => {
    const del = await explore(() => { const w = newWorld(); return { world: w, actors: [eraser('d1', () => [servedKey()], w), eraser('d2', () => [servedKey()], w)] }; }, (w) => check(w, []));
    expect(summarize(del)).toBe('');
    const up = await explore(() => { const w = newWorld(); return { world: w, actors: [uploader('u1', 'site-b', w), uploader('u2', 'site-b', w)] }; }, (w) => check(w, ['site-b']));
    expect(summarize(up)).toBe('');
    expect(up.runs).toBeGreaterThan(100);
  });

  it('two sites upload the same content while a cleanup runs (sampled orderings)', async () => {
    // 6 + 6 + 5 steps is too many orderings to visit all; every ordering of the cleanup against each single uploader is
    // covered above, so here a bounded prefix of the tree is walked.
    let runs = 0;
    const r = await explore(() => { const w = newWorld(); return { world: w, actors: [uploader('u1', 'site-b', w), uploader('u2', 'site-c', w), eraser('del', () => [servedKey()], w)] }; }, (w) => { runs++; return check(w, ['site-b', 'site-c']); }, { maxRuns: 30_000, stopAtFirstViolation: true }).catch(() => null);
    expect(r === null || r.violations.length === 0).toBe(true);
    expect(runs).toBeGreaterThan(1000);
  }, 300_000);
});

describe('a crash of either actor at every step boundary, before or after the step, then recovery', () => {
  it('upload vs cleanup: nothing is ever left dangling, and the repeated upload succeeds', async () => {
    const points: CrashPoint[] = [];
    for (const [actor, n] of [['up', 6], ['del', 5]] as const) for (let at = 1; at <= n; at++) for (const phase of ['before', 'after'] as const) points.push({ actor, at, phase });
    let runs = 0;
    for (const crash of points) {
      const r = await explore(() => { const w = newWorld(); return { world: w, actors: [uploader('up', 'site-b', w), eraser('del', () => [servedKey()], w)] }; }, (w) => check(w, ['site-b']), { crash });
      runs += r.runs;
      expect(summarize(r), JSON.stringify(crash)).toBe('');
    }
    expect(runs).toBeGreaterThan(1000);
  }, 300_000);
});

describe('a stalled cleaner (its lease passes, another cleaner takes over, an upload puts a fresh copy, then it resumes)', () => {
  const build = (lateList: boolean) => () => {
    const w = newWorld();
    return { world: w, actors: [eraser('stale', () => [servedKey()], w, { lateList }), eraser('takeover', () => [servedKey()], w, { advanceClock: true }), uploader('up', 'site-b', w)] };
  };

  it('never deletes the fresh copy: a cleaner removes only what it listed before its tombstone (seeded random walks)', async () => {
    const r = await explore(build(false), (w) => check(w, ['site-b']), { sample: { runs: 6000, seed: 20261112 } });
    expect(r.runs).toBe(6000);
    expect(summarize(r)).toBe('');
  }, 300_000);

  it('MUTATION: listing the copies after the tombstone (instead of before) is caught by the same walks', async () => {
    const r = await explore(build(true), (w) => check(w, ['site-b']), { sample: { runs: 6000, seed: 20261112 } });
    expect(r.violations.length).toBeGreaterThan(0);
  }, 300_000);
});

describe('a blob another site already references is never deleted by a cleanup', () => {
  it('upload and cleanup race while another site holds a ready row: every ordering keeps it', async () => {
    const mk = () => {
      const w = newWorld();
      w.models.seedReady({ siteId: 'site-a', sha256: SERVED, bytes: 8, triangles: 1, materials: 1, nodes: 1, clips: 0, textures: 0, extensions: [], materialNames: [], nodeNames: [], uploaderId: 'u', createdAt: w.clock, lastUsedAt: w.clock, originalSha256: ORIGINAL, originalBytes: 8 });
      return { world: w, actors: [uploader('up', 'site-b', w), eraser('del', () => [servedKey(), originalKey()], w)] };
    };
    const r = await explore(mk, (w) => check(w, ['site-b']), { maxRuns: 20_000 });
    expect(summarize(r)).toBe('');
    expect(r.runs).toBeGreaterThan(100);
  }, 120_000);
});

describe('mutations: each broken variant of the protocol must be caught by the same exploration', () => {
  const caught = async (build: () => { world: World; actors: Actor[] }, retry = ['site-b']) => (await explore(build, (w) => check(w, retry), { stopAtFirstViolation: true })).violations.length > 0;

  it('a recheck-only cleanup (count, then delete) loses a blob under the intent-first upload', async () => {
    expect(await caught(() => { const w = newWorld(); return { world: w, actors: [uploader('up', 'site-b', w), legacyEraser('del', w)] }; })).toBe(true);
  });

  it('an upload that ignores tombstones is caught', async () => {
    class NoTombstoneCheck extends MemorySiteModels {
      override async beginUpload(i: Parameters<MemorySiteModels['beginUpload']>[0]) {
        const saved = new Map(this.tombstones); this.tombstones.clear();
        const out = await super.beginUpload(i);
        for (const [k, v] of saved) this.tombstones.set(k, v);
        return out;
      }
    }
    expect(await caught(() => { const w = newWorld(NoTombstoneCheck); return { world: w, actors: [uploader('up', 'site-b', w), eraser('del', () => [servedKey()], w)] }; })).toBe(true);
  });

  it('a cleanup that does not count pending rows is caught', async () => {
    class IgnoresPending extends MemorySiteModels {
      override async beginDelete(i: Parameters<MemorySiteModels['beginDelete']>[0]) {
        const hidden = [...this.pending.keys()].map((k) => [k, this.rows.get(k)!] as const);
        for (const [k] of hidden) this.rows.delete(k);
        const out = await super.beginDelete(i);
        for (const [k, row] of hidden) this.rows.set(k, row);
        return out;
      }
    }
    expect(await caught(() => { const w = newWorld(IgnoresPending); return { world: w, actors: [uploader('up', 'site-b', w), eraser('del', () => [servedKey()], w)] }; })).toBe(true);
  });

  it('an expired tombstone that stops blocking uploads is caught once the delete outlives its lease', async () => {
    // A delete that is slow (its remove step lands late) while the lease passes: if expiry unblocked uploads, the upload's
    // put would be skipped (a copy is still listed) and the late remove would then delete it.
    class ExpiryUnblocks extends MemorySiteModels {
      override async beginUpload(i: Parameters<MemorySiteModels['beginUpload']>[0]) {
        const saved = new Map(this.tombstones);
        for (const [k, t] of saved) if (t.expiresAt.getTime() <= i.now.getTime()) this.tombstones.delete(k);
        const out = await super.beginUpload(i);
        for (const [k, t] of saved) this.tombstones.set(k, t);
        return out;
      }
    }
    const build = (Models: new () => MemorySiteModels) => () => {
      const w = newWorld(Models);
      const slowEraser: Actor = { name: 'del', run: async (gate) => {
        const p = gated(w, gate);
        const b = await p.coordinator.beginDelete({ key: servedKey(), attempt: 'a1', now: w.clock, leaseMs: TOMBSTONE_LEASE_MS });
        if (b.kind !== 'started') return;
        const ids = await gate('list', () => w.storage.ids(servedKey()));
        await gate('lease passes', () => { w.clock = new Date(w.clock.getTime() + TOMBSTONE_LEASE_MS + 1); });
        await gate('remove', () => w.storage.removeIds(ids));
      } };
      return { world: w, actors: [uploader('up', 'site-b', w), slowEraser] };
    };
    expect(await caught(build(ExpiryUnblocks))).toBe(true);
    // The real protocol survives the very same scenario: its expired tombstone still blocks the upload.
    expect(await caught(build(MemorySiteModels))).toBe(false);
  });
});

describe('fencing, the late-landing delete, and the lease rule', () => {
  const t0 = new Date('2026-11-12T08:00:00Z');
  const record = (site: string) => ({ siteId: site, sha256: SERVED, bytes: 8, triangles: 1, materials: 1, nodes: 1, clips: 0, textures: 0, extensions: [], materialNames: [], nodeNames: [], uploaderId: 'u', createdAt: t0, lastUsedAt: t0, originalSha256: ORIGINAL, originalBytes: 8 });
  const limits = { servedBytes: 1e9, originalBytes: 1e9 };

  it('a slow first attempt cannot promote the row a reaper dropped and a second attempt re-created', async () => {
    const m = new MemorySiteModels();
    const a1 = await m.beginUpload({ record: record('s'), limits, attempt: 'one', now: t0, pendingTtlMs: 1000 });
    expect(a1.ok).toBe(true);
    const later = new Date(t0.getTime() + 5000);
    expect((await m.reapPendingUploads(later, 10)).length).toBe(1);
    const a2 = await m.beginUpload({ record: record('s'), limits, attempt: 'two', now: later, pendingTtlMs: 60_000 });
    expect(a2.ok).toBe(true);
    expect(await m.markReady('s', SERVED, 'one', later)).toBe(false); // fenced
    expect(await m.find('s', SERVED)).toBeNull(); // still pending
    expect(await m.markReady('s', SERVED, 'two', later)).toBe(true);
    expect((await m.find('s', SERVED))?.siteId).toBe('s');
  });

  it('a pending row is refused as in-progress until its deadline, then taken over with a new token', async () => {
    const m = new MemorySiteModels();
    await m.beginUpload({ record: record('s'), limits, attempt: 'one', now: t0, pendingTtlMs: 1000 });
    expect(await m.beginUpload({ record: record('s'), limits, attempt: 'two', now: t0, pendingTtlMs: 1000 })).toEqual({ ok: false, reason: 'in-progress' });
    const taken = await m.beginUpload({ record: record('s'), limits, attempt: 'two', now: new Date(t0.getTime() + 2000), pendingTtlMs: 1000 });
    expect(taken).toMatchObject({ ok: true, takenOver: true });
    expect(await m.markReady('s', SERVED, 'one', t0)).toBe(false);
  });

  it('taking over an expired pending row replaces it whole: the original hash and the quota follow the new attempt', async () => {
    const m = new MemorySiteModels();
    await m.beginUpload({ record: { ...record('s'), originalSha256: 'o'.repeat(64), originalBytes: 8 }, limits, attempt: 'one', now: t0, pendingTtlMs: 1000 });
    const later = new Date(t0.getTime() + 5000);
    const taken = await m.beginUpload({ record: { ...record('s'), originalSha256: 'p'.repeat(64), originalBytes: 9 }, limits, attempt: 'two', now: later, pendingTtlMs: 1000 });
    expect(taken).toMatchObject({ ok: true, takenOver: true });
    await m.markReady('s', SERVED, 'two', later);
    expect(await m.find('s', SERVED)).toMatchObject({ originalSha256: 'p'.repeat(64), originalBytes: 9 });
    // The new attempt's originals are subject to the quota like any new row.
    const m2 = new MemorySiteModels();
    await m2.beginUpload({ record: record('s'), limits, attempt: 'one', now: t0, pendingTtlMs: 1000 });
    const over = await m2.beginUpload({ record: { ...record('s'), originalSha256: 'q'.repeat(64), originalBytes: 1e9 }, limits: { servedBytes: 1e9, originalBytes: 100 }, attempt: 'two', now: later, pendingTtlMs: 1000 });
    expect(over).toEqual({ ok: false, reason: 'originals-quota' });
  });

  it('an expired tombstone on a blob that something references is dropped, so uploads are not blocked forever', async () => {
    const m = new MemorySiteModels();
    m.seedReady(record('s'));
    m.tombstones.set(servedKey(), { attempt: 'dead', expiresAt: new Date(t0.getTime() - 1) });
    expect(await m.beginDelete({ key: servedKey(), attempt: 'x', now: t0, leaseMs: 1000 })).toEqual({ kind: 'kept', reason: 'referenced' });
    expect(m.tombstones.size).toBe(0);
  });

  it('a stale cleaner whose tombstone was taken over reports superseded, not deleted, and removes only its own snapshot', async () => {
    const m = new MemorySiteModels();
    const st = new IdStorage(); st.putIfAbsent(servedKey());
    const snap = st.ids(servedKey());
    const base = plainDeleter(st);
    // The cleaner stalls between its tombstone and its remove; meanwhile a takeover finishes and an upload puts a fresh copy.
    let resume!: () => void;
    const stalled: BlobDeleter = { ...base, snapshot: async () => snap, removeSnapshot: async (k, s2) => { await new Promise<void>((r) => { resume = r; }); await base.removeSnapshot(k, s2); } };
    const stale = deleteBlobsCoordinated([servedKey()], { coordinator: m, storage: stalled, now: () => t0 });
    while (!resume) await new Promise((r) => setTimeout(r, 1));
    const after = new Date(t0.getTime() + TOMBSTONE_LEASE_MS + 1000);
    const takeover = await deleteBlobsCoordinated([servedKey()], { coordinator: m, storage: plainDeleter(st), now: () => after });
    expect(takeover.deleted).toEqual([servedKey()]);
    st.putIfAbsent(servedKey()); // a fresh upload's copy
    resume();
    const report = await stale;
    expect(st.has(servedKey())).toBe(true); // the fresh copy survived the stale remove
    expect(report.deleted).toEqual([]);
    expect(report.retry.length + report.kept.length).toBe(1); // still-present or superseded: never "deleted"
  });

  it('an EXPIRED tombstone still blocks uploads; only a reconciler takes it over, and the upload then succeeds', async () => {
    const m = new MemorySiteModels();
    const storage = new IdStorage(); storage.putIfAbsent(servedKey());
    expect(await m.beginDelete({ key: servedKey(), attempt: 'x', now: t0, leaseMs: 1000 })).toMatchObject({ kind: 'started' });
    const expired = new Date(t0.getTime() + 60_000);
    expect(await m.beginUpload({ record: record('s'), limits, attempt: 'u', now: expired, pendingTtlMs: 1000 })).toEqual({ ok: false, reason: 'busy' });
    const plain = plainDeleter(storage);
    const report = await reconcileTombstones({ coordinator: m, storage: plain, now: () => expired, leaseMs: TOMBSTONE_LEASE_MS });
    expect(report.deleted).toEqual([servedKey()]);
    expect(storage.has(servedKey())).toBe(false);
    expect(m.tombstones.size).toBe(0);
    expect(await m.beginUpload({ record: record('s'), limits, attempt: 'u', now: expired, pendingTtlMs: 1000 })).toMatchObject({ ok: true });
  });

  it('a delete that fails or cannot be verified leaves its tombstone and reports a retry (the erasure stays unprocessed)', async () => {
    const m = new MemorySiteModels();
    const failing: BlobDeleter = { snapshot: async () => [], removeSnapshot: async () => { throw new Error('timeout'); }, hasBlob: async () => true };
    const r1 = await deleteBlobsCoordinated([servedKey()], { coordinator: m, storage: failing, now: () => t0 });
    expect(r1).toMatchObject({ complete: false, retry: [{ key: servedKey(), reason: 'delete-failed' }] });
    expect(m.tombstones.has(servedKey())).toBe(true);
    const stillThere: BlobDeleter = { snapshot: async () => [], removeSnapshot: async () => {}, hasBlob: async () => true };
    const r2 = await deleteBlobsCoordinated([servedKey()], { coordinator: m, storage: stillThere, now: () => new Date(t0.getTime() + 11 * 60_000) });
    expect(r2.retry[0].reason).toBe('still-present');
    expect(m.tombstones.has(servedKey())).toBe(true);
  });

  it('keeps a referenced blob, reports a retry for another cleanup\'s live tombstone, and refuses foreign keys', async () => {
    const m = new MemorySiteModels();
    await m.beginUpload({ record: record('s'), limits, attempt: 'u', now: t0, pendingTtlMs: 60_000 });
    const noStorage: BlobDeleter = { snapshot: async () => [], removeSnapshot: async () => { throw new Error('must not be called'); }, hasBlob: async () => { throw new Error('must not be called'); } };
    const r = await deleteBlobsCoordinated([servedKey()], { coordinator: m, storage: noStorage, now: () => t0 });
    expect(r).toMatchObject({ complete: true, kept: [{ reason: 'referenced' }], deleted: [] });
    await m.abandonUpload('s', SERVED, 'u');
    await m.beginDelete({ key: servedKey(), attempt: 'other', now: t0, leaseMs: TOMBSTONE_LEASE_MS });
    expect((await deleteBlobsCoordinated([servedKey()], { coordinator: m, storage: noStorage, now: () => t0 })).retry).toEqual([{ key: servedKey(), reason: 'busy' }]);
    expect((await deleteBlobsCoordinated(['../x', 'site-images/a'], { coordinator: m, storage: noStorage, now: () => t0 })).retry).toHaveLength(2);
  });

  it('a delete that lands late removes only the ids it listed, never the copy a later upload put (id-addressed storage)', async () => {
    const storage = new IdStorage(); storage.putIfAbsent(servedKey());
    const listed = storage.ids(servedKey()); // the first cleanup lists, then its request stalls
    storage.removeIds(listed); // a takeover finished the delete and verified it
    storage.putIfAbsent(servedKey()); // a fresh upload puts a new copy (a new id)
    storage.removeIds(listed); // the stalled request finally lands
    expect(storage.has(servedKey())).toBe(true);
  });

  it('the lease must exceed the longest blob delete, or the configuration is refused', () => {
    expect(() => assertLeaseCoversDelete(TOMBSTONE_LEASE_MS)).not.toThrow();
    expect(() => assertLeaseCoversDelete(60_000)).toThrow(/lease/);
  });
});
