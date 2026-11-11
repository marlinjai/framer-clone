// The merge of one value (src/lib/siteMerge/value.ts), rule by rule of the site branches plan, section 5.

import { describe, expect, it } from 'vitest';
import { fingerprint, jsonEqual, mergeValue, type SplitRule } from '../value';

const splitProps: SplitRule = (path) => path.length === 0 || (path[0] === 'style' && path.length === 1);

describe('mergeValue', () => {
  it('rule 1: only one side changed, that side is taken', () => {
    expect(mergeValue('a', 'a', 'b')).toEqual({ value: 'b', conflicts: [], changed: true });
    expect(mergeValue('a', 'b', 'a')).toEqual({ value: 'b', conflicts: [], changed: false });
  });

  it('rule 2: the same change on both sides is taken once', () => {
    expect(mergeValue('a', 'b', 'b')).toEqual({ value: 'b', conflicts: [], changed: false });
    expect(mergeValue({ x: 1 }, { x: 2, y: [1] }, { y: [1], x: 2 }).conflicts).toEqual([]);
  });

  it('rule 3: two different changes conflict, main stands in until answered; text is one value', () => {
    const merged = mergeValue('Hello world', 'Hello there world', 'Hello big world');
    expect(merged.value).toBe('Hello there world');
    expect(merged.conflicts).toEqual([{ path: [], base: 'Hello world', main: 'Hello there world', branch: 'Hello big world' }]);
    expect(mergeValue('a', 'b', 'c', { pick: () => 'branch' })).toEqual({ value: 'c', conflicts: [], changed: true });
    expect(mergeValue('a', 'b', 'c', { pick: () => 'main' }).conflicts).toEqual([]);
  });

  it('rule 5: removed on one side, untouched on the other: removed', () => {
    expect(mergeValue('a', undefined, 'a').value).toBeUndefined();
    expect(mergeValue('a', 'a', undefined).value).toBeUndefined();
  });

  it('a split value merges per key: different keys never conflict, the same key does', () => {
    const base = { text: 'Hi', style: { color: 'red', padding: '1px' } };
    const main = { text: 'Hello', style: { color: 'red', padding: '2px' } };
    const branch = { text: 'Hi', style: { color: 'blue', padding: '1px' }, title: 'New' };
    expect(mergeValue(base, main, branch, { split: splitProps })).toEqual({
      value: { text: 'Hello', style: { color: 'blue', padding: '2px' }, title: 'New' },
      conflicts: [],
      changed: true,
    });
    const both = mergeValue(base, { ...base, style: { color: 'green', padding: '1px' } }, branch, { split: splitProps });
    expect(both.conflicts).toEqual([{ path: ['style', 'color'], base: 'red', main: 'green', branch: 'blue' }]);
    // A key removed on one side and untouched on the other goes.
    expect(mergeValue({ a: 1, b: 2 }, { a: 1 }, { a: 3, b: 2 }, { split: () => true }).value).toEqual({ a: 3 });
  });

  it('a value not split is never spliced, and a whole object removed against a changed key conflicts', () => {
    expect(mergeValue({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 2 }).conflicts).toHaveLength(1);
    expect(mergeValue({ a: 1 }, undefined, { a: 2 }, { split: () => true }).conflicts).toHaveLength(1);
    // Lists are one value.
    expect(mergeValue([1, 2], [1, 2, 3], [0, 1, 2], { split: () => true }).conflicts).toHaveLength(1);
  });

  it('answers are asked per path', () => {
    const seen: string[] = [];
    const merged = mergeValue({ a: 1, b: 1 }, { a: 2, b: 2 }, { a: 3, b: 3 }, {
      split: (p) => p.length === 0,
      pick: (path) => {
        seen.push(path.join('/'));
        return path[0] === 'a' ? 'branch' : undefined;
      },
    });
    expect(seen).toEqual(['a', 'b']);
    expect(merged.value).toEqual({ a: 3, b: 2 });
    expect(merged.conflicts.map((c) => c.path)).toEqual([['b']]);
  });
});

describe('equality and fingerprints', () => {
  it('a missing key equals one holding undefined; dates compare by time; key order does not matter', () => {
    expect(jsonEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(jsonEqual(new Date(5), new Date(5))).toBe(true);
    expect(jsonEqual(new Date(5), new Date(6))).toBe(false);
    expect(fingerprint({ b: 1, a: [1, { d: 2, c: 1 }] })).toBe(fingerprint({ a: [1, { c: 1, d: 2 }], b: 1 }));
    expect(jsonEqual(null, undefined)).toBe(false);
  });

  it('a fingerprint follows the values, not their key order', () => {
    expect(fingerprint({ a: 1, b: 2 }, 'x')).toBe(fingerprint({ b: 2, a: 1 }, 'x'));
    expect(fingerprint('a', 'b')).not.toBe(fingerprint('b', 'a'));
    expect(fingerprint('ab', 'c')).not.toBe(fingerprint('a', 'bc'));
    expect(fingerprint('x')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('keeps own keys named like inherited ones, and an own __proto__ as data', () => {
    const split: SplitRule = () => true;
    const branch = JSON.parse('{"constructor":"keep","__proto__":{"x":1}}');
    const out = mergeValue({}, { x: 1 }, branch, { split }).value as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.constructor).toBe('keep');
    expect(Object.keys(out)).toEqual(['x', 'constructor', '__proto__']);
  });
});
