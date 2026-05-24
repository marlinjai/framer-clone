// src/lib/ai/__tests__/promptCache.test.ts
//
// The cache_control marker is the single most cost-relevant bit on the
// AI surface. These tests pin down (a) that the marker lands on the
// *last* cache=true block and (b) that nobody accidentally puts
// volatile state ahead of a cached block, which would defeat the cache.

import { describe, it, expect } from 'vitest';

import { buildSystemPrompt, type SystemBlock } from '../promptCache';

describe('buildSystemPrompt', () => {
  it('returns empty for empty input', () => {
    expect(buildSystemPrompt([])).toEqual([]);
  });

  it('places cache_control on the last cache=true block only', () => {
    const blocks: SystemBlock[] = [
      { type: 'text', text: 'A', cache: true },
      { type: 'text', text: 'B', cache: true },
      { type: 'text', text: 'C', cache: false },
    ];
    const out = buildSystemPrompt(blocks);

    expect(out).toHaveLength(3);
    expect(out[0].cache_control).toBeUndefined();
    expect(out[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(out[2].cache_control).toBeUndefined();
  });

  it('emits all blocks in input order with type=text', () => {
    const blocks: SystemBlock[] = [
      { type: 'text', text: 'stable-1', cache: true },
      { type: 'text', text: 'volatile-1' },
    ];
    const out = buildSystemPrompt(blocks);
    expect(out.map((b) => b.text)).toEqual(['stable-1', 'volatile-1']);
    expect(out.every((b) => b.type === 'text')).toBe(true);
  });

  it('does not mark volatile blocks with cache_control', () => {
    const blocks: SystemBlock[] = [
      { type: 'text', text: 'stable', cache: true },
      { type: 'text', text: 'snapshot', cache: false },
      { type: 'text', text: 'selection' },
    ];
    const out = buildSystemPrompt(blocks);
    expect(out[1].cache_control).toBeUndefined();
    expect(out[2].cache_control).toBeUndefined();
  });

  it('marks the only block when there is exactly one cache=true block', () => {
    const out = buildSystemPrompt([{ type: 'text', text: 'only', cache: true }]);
    expect(out).toHaveLength(1);
    expect(out[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('emits no cache_control when no block is flagged cacheable', () => {
    const out = buildSystemPrompt([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
    expect(out[0].cache_control).toBeUndefined();
    expect(out[1].cache_control).toBeUndefined();
  });

  it('throws if a volatile block precedes a cached block', () => {
    // This invariant matters: a cached block after a volatile block
    // means the prefix changes every turn, so the cache never hits.
    expect(() =>
      buildSystemPrompt([
        { type: 'text', text: 'volatile' },
        { type: 'text', text: 'stable', cache: true },
      ]),
    ).toThrow(/must not follow a volatile block/i);
  });
});
