// The broker's rules that need no frame (slice C3 of docs/plans/2026-11-02-sandboxed-custom-code.md):
// what a write may carry (fits), and the blocks it refuses before creating anything. What frames do
// is proven in real browsers, test/renderGate/customCodeBridge.gate.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBroker, fits, sizeOf } from '../broker';
import { addBlock, type IslandBlock } from '../registry';
import type { Kit } from '@/lib/behaviour/program';

describe('fits', () => {
  it.each([
    [{ type: 'boolean' as const }, true, true],
    [{ type: 'boolean' as const }, 'true', false],
    [{ type: 'boolean' as const }, 1, false],
    [{ type: 'number' as const, min: 0, max: 9 }, 9, true],
    [{ type: 'number' as const, min: 0, max: 9 }, 0, true],
    [{ type: 'number' as const, min: 0, max: 9 }, 10, false],
    [{ type: 'number' as const, min: 0, max: 9 }, -1, false],
    [{ type: 'number' as const, min: 0, max: 9 }, '5', false],
    [{ type: 'number' as const, min: 0, max: 9 }, Number.NaN, false],
    [{ type: 'number' as const }, Number.POSITIVE_INFINITY, false],
    [{ type: 'number' as const }, -1e9, true],
    [{ type: 'choice' as const, options: ['a', 'b'] }, 'b', true],
    [{ type: 'choice' as const, options: ['a', 'b'] }, 'c', false],
    [{ type: 'choice' as const, options: ['a', 'b'] }, ['a'], false],
    [{ type: 'choice' as const }, 'a', false],
    [{ type: 'text' } as never, 'anything', false],
    [undefined, true, false],
  ])('%j with %j is %s', (state, value, expected) => {
    expect(fits(state, value)).toBe(expected);
  });
});

describe('sizeOf: the UTF-8 length of a message as JSON, of plain data only, with a bounded walk', () => {
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

  it('measures plain data, nulls and nested values included', () => {
    const message = { kind: 'setState', id: 'n', value: null, list: [1, 'ä', { deep: [true, null] }], when: undefined };
    expect(sizeOf(message)).toBe(bytes(message));
    expect(sizeOf([])).toBe(2);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 5],
    ['a string', 'setState'],
    ['a buffer', { kind: 'x', pad: new ArrayBuffer(8) }],
    ['a typed array', { kind: 'x', pad: new Uint8Array(4) }],
    ['a Map', { kind: 'x', pad: new Map() }],
    ['a Set', { kind: 'x', pad: new Set([1]) }],
    ['a bigint', { kind: 'x', pad: BigInt(1) }],
    ['a sparse array of ten million slots', { kind: 'x', pad: new Array(1e7) }],
    ['the longest array there is', { kind: 'x', pad: new Array(2 ** 32 - 1) }],
    ['a string longer than 65,536', { kind: 'x', pad: 'x'.repeat(65_537) }],
    ['more than 65,536 values', { kind: 'x', pad: Array.from({ length: 300 }, () => Array.from({ length: 300 }, () => 0)) }],
    ['an object with its own length past 65,536', { kind: 'x', length: 70_000 }],
  ])('refuses %s', (_name, value) => {
    expect(sizeOf(value)).toBe(-1);
  });

  it('refuses a cycle', () => {
    const cyclic: Record<string, unknown> = { kind: 'x' };
    cyclic.self = cyclic;
    expect(sizeOf(cyclic)).toBe(-1);
  });

  it('lets the size rule decide what the budget lets through: escaped characters count their escapes', () => {
    // 65,536 quotes: within the walk's bounds, but twice that as JSON, so over 64 KB for the caller.
    expect(sizeOf({ pad: '"'.repeat(65_536) })).toBe(bytes({ pad: '"'.repeat(65_536) }));
    expect(sizeOf({ pad: '"'.repeat(65_536) })).toBeGreaterThan(65_536);
    // A string of exactly 65,536 and an array of 65,000 are not refused by the walk.
    expect(sizeOf({ pad: 'x'.repeat(65_536) })).toBeGreaterThan(65_536);
    expect(sizeOf({ pad: new Array(65_000).fill(0) })).toBe(bytes({ pad: new Array(65_000).fill(0) }));
  });

  it('starts every message with a fresh budget', () => {
    const big = { pad: new Array(60_000).fill(0) };
    expect(sizeOf(big)).toBeGreaterThan(0);
    expect(sizeOf(big)).toBeGreaterThan(0);
  });
});

const SRC = `https://run.box.test/box/0b9e2f4a-1c2d-4e5f-8a9b-0c1d2e3f4a5b/${'a'.repeat(64)}`;
const block = (extra: Partial<IslandBlock> = {}): IslandBlock => ({
  src: SRC, title: 'T', reads: [], writes: [], emits: [], sizing: 'fixed', interactive: true, states: {}, ...extra,
});

let observed: Element[];
let stop: (() => void) | undefined;
let removes: (() => void)[];

beforeEach(() => {
  observed = [];
  removes = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('IntersectionObserver', class {
    observe(el: Element) {
      observed.push(el);
    }
    disconnect() {}
  });
  stop = createBroker({ doc: document, write: () => true, emit: () => {} } as unknown as Kit);
});

afterEach(() => {
  removes.forEach((remove) => remove());
  stop?.();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

function add(extra: Partial<IslandBlock> = {}) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const settled: boolean[] = [];
  removes.push(addBlock({ el, block: block(extra), settle: (shown) => settled.push(shown) }));
  return { el, settled };
}

describe('the broker before any frame', () => {
  it('watches four blocks and refuses a fifth at once', () => {
    const four = [add(), add(), add(), add()];
    const fifth = add();
    expect(observed).toEqual(four.map((b) => b.el));
    expect(four.every((b) => b.settled.length === 0)).toBe(true);
    expect(fifth.settled).toEqual([false]);
    expect(console.warn).toHaveBeenCalledWith('Custom code "T": not run');
  });

  it('lets a new block in once one of the four is gone', () => {
    for (let i = 0; i < 4; i++) add();
    removes.shift()?.();
    expect(add().settled).toEqual([]);
    expect(observed).toHaveLength(5);
  });

  it('creates no frame before its box nears the screen', () => {
    add();
    expect(document.querySelector('iframe')).toBeNull();
  });
});
