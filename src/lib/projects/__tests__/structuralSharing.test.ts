import { describe, it, expect } from 'vitest';
import { shareUnchanged } from '../structuralSharing';

describe('shareUnchanged and an effect settings change', () => {
  const node = (appear: Record<string, unknown>, text = 'A') => ({
    id: 'n',
    props: { effects: { appear }, text },
  });

  it('adopts a changed direction and duration, and keeps the objects around them', () => {
    const slideUp = { kind: 'slide-up', distance: 16, duration: 280, delay: 0, stagger: 0 };
    const old = { children: [node(slideUp), { id: 'm', props: { text: 'B' } }] };
    const next = JSON.parse(JSON.stringify(old));
    next.children[0].props.effects.appear = { ...slideUp, kind: 'slide-left', duration: 400 };
    const out = shareUnchanged(old, next);
    expect(out.children[0].props.effects.appear).toEqual({ ...slideUp, kind: 'slide-left', duration: 400 });
    expect(out.children[1]).toBe(old.children[1]);
  });

  it('keeps the open copy when the server copy has the same settings', () => {
    const appear = { kind: 'fade', distance: 16, duration: 350, delay: 0, stagger: 0 };
    const old = { children: [node(appear)] };
    expect(shareUnchanged(old, JSON.parse(JSON.stringify(old)))).toBe(old);
  });
});

describe('shareUnchanged', () => {
  it('answers the old value itself when the content is equal', () => {
    const old = { a: 1, b: { c: [1, 2, { d: 'x' }] } };
    const next = JSON.parse(JSON.stringify(old));
    expect(shareUnchanged(old, next)).toBe(old);
  });

  it('keeps the old objects of unchanged parts and new ones only along the changed path', () => {
    const old = { left: { v: 1 }, right: { v: 2, deep: { w: 3 } } };
    const next = { left: { v: 1 }, right: { v: 2, deep: { w: 4 } } };
    const out = shareUnchanged(old, next);
    expect(out).not.toBe(old);
    expect(out.left).toBe(old.left);
    expect(out.right).not.toBe(old.right);
    expect(out).toEqual(next);
  });

  it('matches array items by id, so an insert does not unshare the siblings after it', () => {
    const a = { id: 'a', props: { t: 'A' } };
    const b = { id: 'b', props: { t: 'B' } };
    const old = { children: [a, b] };
    const next = { children: [{ id: 'n', props: { t: 'N' } }, { id: 'a', props: { t: 'A' } }, { id: 'b', props: { t: 'B' } }] };
    const out = shareUnchanged(old, next);
    expect(out.children[1]).toBe(a);
    expect(out.children[2]).toBe(b);
    expect(out.children[0]).toBe(next.children[0]);
  });

  it('a reorder or a removed key or item is a change', () => {
    const old = { list: [{ id: 'a' }, { id: 'b' }], k: 1, gone: 2 };
    const reordered = shareUnchanged(old, { list: [{ id: 'b' }, { id: 'a' }], k: 1, gone: 2 });
    expect(reordered).not.toBe(old);
    expect(reordered.list[0]).toBe(old.list[1]);
    expect(shareUnchanged(old, { list: [{ id: 'a' }, { id: 'b' }], k: 1 })).not.toBe(old);
    expect(shareUnchanged(old, { list: [{ id: 'a' }], k: 1, gone: 2 })).not.toBe(old);
  });

  it('an optional key the old snapshot names as undefined equals JSON that omits it', () => {
    const old = { id: 'x', canvasX: undefined, props: {} };
    expect(shareUnchanged(old, { id: 'x', props: {} })).toBe(old);
  });

  it('never changes its inputs', () => {
    const old = Object.freeze({ a: Object.freeze({ v: 1 }) });
    const next = { a: { v: 2 } };
    expect(() => shareUnchanged(old, next)).not.toThrow();
    expect(next.a.v).toBe(2);
  });

  it('keeps an own __proto__ key of the incoming JSON as an own key, and does not read the old prototype', () => {
    const old = { a: { v: 1 } };
    const next = JSON.parse('{"a":{"v":1},"__proto__":{"polluted":true}}');
    const out = shareUnchanged(old, next) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['a', '__proto__']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
    expect(out.a).toBe(old.a);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
