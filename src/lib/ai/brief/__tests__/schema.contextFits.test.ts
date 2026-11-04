// contextFits (../schema.ts) must answer, never throw, for a context that cannot be serialized.

import { describe, expect, it } from 'vitest';
import { contextFits } from '../schema';

describe('contextFits', () => {
  it('accepts no context and a small one, refuses an oversized one', () => {
    expect(contextFits(undefined)).toBe(true);
    expect(contextFits(null)).toBe(true);
    expect(contextFits({ a: 1 })).toBe(true);
    expect(contextFits({ text: 'x'.repeat(20_000) })).toBe(false);
  });

  it('refuses a cyclic or absurdly deep context instead of throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(contextFits(cyclic)).toBe(false);
    let deep: unknown = 'leaf';
    for (let i = 0; i < 200_000; i += 1) deep = { child: deep };
    expect(contextFits(deep)).toBe(false);
  });
});
