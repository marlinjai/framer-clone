import { describe, expect, it } from 'vitest';
import { captureSiteModelHashes, erasureIsComplete, mergeCaptured, parseCaptured, planCompanyModelErasure } from '../erasure';

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

  it('is complete only when the cleanup report is complete and no count stayed unknown', () => {
    const kept = (reason: 'held' | 'unknown') => ({ keys: [], kept: [{ key: `served/${h('a')}`, reason }] });
    expect(erasureIsComplete(kept('held'), { complete: true })).toBe(true);
    expect(erasureIsComplete(kept('unknown'), { complete: true })).toBe(false);
    expect(erasureIsComplete(kept('held'), { complete: false })).toBe(false);
  });
});
