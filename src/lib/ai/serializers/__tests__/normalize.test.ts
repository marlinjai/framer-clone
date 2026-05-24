// src/lib/ai/serializers/__tests__/normalize.test.ts
//
// Determinism is the foundation of the entire serializer layer — if these
// tests pass, prompt-caching can hit; if they don't, the cached prefix is
// no longer byte-identical turn-to-turn and we pay full input cost on
// every request.

import { describe, it, expect } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';

import { normalize, stableStringify, toPromptString } from '../normalize';

import ComponentModel, {
  ComponentTypeEnum,
} from '@/models/ComponentModel';

describe('normalize', () => {
  it('sorts plain-object keys alphabetically', () => {
    const out = normalize({ b: 1, a: 2, c: { z: 3, y: 4 } });
    expect(JSON.stringify(out)).toBe('{"a":2,"b":1,"c":{"y":4,"z":3}}');
  });

  it('preserves array order (arrays carry meaning)', () => {
    const out = normalize([{ id: 3 }, { id: 1 }, { id: 2 }]);
    expect(JSON.stringify(out)).toBe('[{"id":3},{"id":1},{"id":2}]');
  });

  it('drops undefineds from objects', () => {
    expect(normalize({ a: undefined, b: 1 })).toEqual({ b: 1 });
  });

  it('converts Date instances to ISO strings', () => {
    const d = new Date('2026-05-24T12:00:00.000Z');
    expect(normalize({ at: d })).toEqual({ at: '2026-05-24T12:00:00.000Z' });
  });

  it('strips known MST-internal keys', () => {
    const out = normalize({ $treenode: 'leak', $mobx: 'leak', real: 'value' });
    expect(out).toEqual({ real: 'value' });
  });

  it('is idempotent', () => {
    const value = { z: 1, a: [2, { c: 3, b: 4 }] };
    const once = normalize(value);
    const twice = normalize(once);
    expect(twice).toEqual(once);
  });

  it('produces byte-identical stableStringify for inputs differing only in key order', () => {
    const a = { z: 1, a: [{ y: 1, x: 2 }] };
    const b = { a: [{ x: 2, y: 1 }], z: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });
});

describe('normalize (against real MST snapshots)', () => {
  it('two MST snapshots of equivalent trees produce byte-identical JSON', () => {
    // Building two ComponentModel instances with the same id / shape and
    // running them through `getSnapshot()` should yield identical
    // stable-stringified output. MST inserts `children: []` defaults and
    // may emit keys in declaration order; normalize sorts those away.
    const make = () =>
      ComponentModel.create({
        id: 'fixed-id',
        type: 'div',
        componentType: ComponentTypeEnum.HOST,
        props: { style: { color: 'red', padding: '8px' } },
        label: 'Hello',
      });

    const a = stableStringify(getSnapshot(make()));
    const b = stableStringify(getSnapshot(make()));
    expect(a).toBe(b);
  });
});

describe('toPromptString', () => {
  it('wraps payload with XML-style label tag', () => {
    expect(toPromptString('foo', { a: 1 })).toBe('<foo>\n{"a":1}\n</foo>');
  });

  it('uses stable key ordering inside the wrapper', () => {
    const left = toPromptString('foo', { b: 1, a: 2 });
    const right = toPromptString('foo', { a: 2, b: 1 });
    expect(left).toBe(right);
    expect(left).toBe('<foo>\n{"a":2,"b":1}\n</foo>');
  });
});
