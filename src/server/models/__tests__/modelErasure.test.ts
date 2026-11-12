import { describe, expect, it } from 'vitest';
import {
  captureSiteModelHashes, executeModelBlobErasure, mergeCaptured, parseCaptured, planCompanyModelErasure,
} from '../erasure';

const h = (c: string) => c.repeat(64);

describe('company model erasure (offline)', () => {
  it('captures distinct valid hashes and drops malformed ones', () => {
    const c = captureSiteModelHashes([
      { sha256: h('a'), originalSha256: h('b') }, { sha256: h('a'), originalSha256: h('c') }, { sha256: '../x', originalSha256: 'ZZ' },
    ]);
    expect(c).toEqual({ served: [h('a')], originals: [h('b'), h('c')] });
  });

  it('merges a retry with the stored capture, and parses garbage as empty', () => {
    expect(mergeCaptured({ served: [h('a')], originals: [] }, { served: [h('b')], originals: [h('c')] })).toEqual({ served: [h('a'), h('b')], originals: [h('c')] });
    expect(parseCaptured(null)).toEqual({ served: [], originals: [] });
    expect(parseCaptured({ served: [1, '../x', h('d')], originals: 'no' })).toEqual({ served: [h('d')], originals: [] });
  });

  it('plans only blobs no remaining row of any site keeps; unknown counts are kept', () => {
    const plan = planCompanyModelErasure({
      captured: { served: [h('a'), h('b'), h('c')], originals: [h('d'), h('e')] },
      remainingServed: new Map([[h('a'), 0], [h('b'), 2]]), // c unknown
      remainingOriginals: new Map([[h('d'), 0], [h('e'), 1]]),
    });
    expect(plan.keys).toEqual([`served/${h('a')}`, `original/${h('d')}`]);
    expect(plan.kept).toEqual([
      { key: `served/${h('b')}`, reason: 'held' }, { key: `served/${h('c')}`, reason: 'unknown' }, { key: `original/${h('e')}`, reason: 'held' },
    ]);
  });

  it('treats a negative or non-finite count as unknown', () => {
    const plan = planCompanyModelErasure({ captured: { served: [h('a'), h('b')], originals: [] }, remainingServed: new Map([[h('a'), -1], [h('b'), Number.NaN]]), remainingOriginals: new Map() });
    expect(plan.keys).toEqual([]);
    expect(plan.kept.map((k) => k.reason)).toEqual(['unknown', 'unknown']);
  });

  it('re-checks right before each delete: an upload that landed since the plan keeps its blob', async () => {
    const live = new Map<string, number>([[`served/${h('a')}`, 0], [`served/${h('b')}`, 0]]);
    const deleted: string[] = [];
    const plan = { keys: [`served/${h('a')}`, `served/${h('b')}`], kept: [] };
    const report = await executeModelBlobErasure(plan, {
      rowsReferencing: async (k) => { if (k.endsWith(h('b'))) live.set(k, 1); return live.get(k) ?? null; },
      deleteBlob: async (k) => { deleted.push(k); },
    });
    expect(deleted).toEqual([`served/${h('a')}`]);
    expect(report.skipped).toEqual([{ key: `served/${h('b')}`, reason: 'held-now' }]);
    expect(report.complete).toBe(true); // a blob provably held by another row needs no retry
  });

  it('does not delete when the count cannot be read, and reports incomplete so the erasure retries', async () => {
    const deleted: string[] = [];
    const report = await executeModelBlobErasure({ keys: [`served/${h('a')}`, `served/${h('b')}`], kept: [] }, {
      rowsReferencing: async (k) => { if (k.endsWith(h('a'))) throw new Error('db down'); return null; },
      deleteBlob: async (k) => { deleted.push(k); },
    });
    expect(deleted).toEqual([]);
    expect(report.complete).toBe(false);
  });

  it('keeps going after a failed delete, reports its name only, and is incomplete', async () => {
    const deleted: string[] = [];
    const report = await executeModelBlobErasure({ keys: [`served/${h('a')}`, `original/${h('b')}`], kept: [] }, {
      rowsReferencing: async () => 0,
      deleteBlob: async (k) => { if (k.startsWith('served')) throw new TypeError('secret-token in message'); deleted.push(k); },
    });
    expect(deleted).toEqual([`original/${h('b')}`]);
    expect(report.failed).toEqual([{ key: `served/${h('a')}`, error: 'TypeError' }]);
    expect(report.complete).toBe(false);
  });

  it('is incomplete while the plan kept an unknown count, even if every delete succeeded', async () => {
    const report = await executeModelBlobErasure({ keys: [], kept: [{ key: `served/${h('a')}`, reason: 'unknown' }] }, { rowsReferencing: async () => 0, deleteBlob: async () => {} });
    expect(report.complete).toBe(false);
  });

  it('refuses a key outside the store namespaces whatever the plan says, and is idempotent on a rerun', async () => {
    const store = new Set([`served/${h('a')}`]);
    const ports = { rowsReferencing: async () => 0, deleteBlob: async (k: string) => { store.delete(k); } };
    const bad = await executeModelBlobErasure({ keys: ['../../etc/passwd', 'site-images/x'], kept: [] }, ports);
    expect(bad.failed).toHaveLength(2);
    const plan = { keys: [`served/${h('a')}`], kept: [] };
    expect((await executeModelBlobErasure(plan, ports)).complete).toBe(true);
    expect((await executeModelBlobErasure(plan, ports)).complete).toBe(true);
    expect(store.size).toBe(0);
  });

  // The interleaving the executor's re-check does NOT close. This test pins the current, known-unsafe behaviour so
  // that nobody wires the executor believing the re-check is atomic. When a lock or tombstone protocol exists, replace
  // it with the same interleaving run against that protocol and assert the blob SURVIVES (see the todos below).
  it('RACE (documented, unsafe): a reference created between the re-check and the delete loses its blob', async () => {
    const key = `served/${h('a')}`;
    const blobs = new Set([key]);
    const rows = new Set<string>(); // sites holding a row for the hash
    const report = await executeModelBlobErasure({ keys: [key], kept: [] }, {
      rowsReferencing: async () => rows.size, // t1: 0
      deleteBlob: async (k) => {
        // t2: site B's upload finds the blob present, skips `put`, inserts its row, and commits ...
        rows.add('site-b');
        // t3: ... and only then does the storage delete land.
        blobs.delete(k);
      },
    });
    expect(report.deleted).toEqual([key]); // the executor believes it was safe
    expect(rows.size).toBe(1); // a committed row exists
    expect(blobs.has(key)).toBe(false); // and its blob is gone: a dangling reference
  });

  it.todo('PROTOCOL: with the shared lock or tombstone, the same interleaving keeps the blob (or makes the upload re-put it)');
  it.todo('PROTOCOL: an upload that has put the blob but not yet committed its row cannot have the blob deleted under it');
  it.todo('PROTOCOL: a stuck storage delete does not block uploads past the lock timeout, and the erasure stays unprocessed');
  it.todo('PROTOCOL: run both orders (eraser first, upload first) and a crash of either side between its steps, against Postgres');
});
