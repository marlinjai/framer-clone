import { describe, expect, it } from 'vitest';
import { isIdReference, suffixCloneIds, withFollowedRefs } from '../idRefs';

interface TestNode {
  props?: Record<string, unknown>;
  children?: TestNode[];
  cloneIndex?: number;
}

const el = (props: Record<string, unknown>, ...children: TestNode[]): TestNode => ({ props, children });
const row = (cloneIndex: number, props: Record<string, unknown>, ...children: TestNode[]): TestNode => ({ props, children, cloneIndex });

describe('withFollowedRefs', () => {
  const ids = new Map([['a', 'a-r1'], ['b', 'b-r1']]);

  it('follows each token of a list and leaves the others', () => {
    expect(withFollowedRefs({ 'aria-labelledby': 'a  other b' }, ids)).toEqual({ 'aria-labelledby': 'a-r1  other b-r1' });
  });

  it('reads an attribute in any stored spelling', () => {
    for (const name of ['for', 'htmlFor', 'popoverTarget', 'popovertarget', 'commandFor', 'commandfor']) {
      expect(withFollowedRefs({ [name]: 'a' }, ids)).toEqual({ [name]: 'a-r1' });
    }
  });

  it('follows a same-document link and no other', () => {
    expect(withFollowedRefs({ href: '#a' }, ids)).toEqual({ href: '#a-r1' });
    expect(withFollowedRefs({ href: '/a' }, ids)).toEqual({ href: '/a' });
    expect(withFollowedRefs({ href: '#c' }, ids)).toEqual({ href: '#c' });
  });

  it('hands back the same object when nothing changes', () => {
    const props = { 'aria-controls': 'c', title: 'a', count: 3 };
    expect(withFollowedRefs(props, ids)).toBe(props);
  });

  it('does not mistake a plain attribute for a reference', () => {
    expect(isIdReference('title')).toBe(false);
    expect(isIdReference('ARIA-CONTROLS')).toBe(true);
  });
});

describe('suffixCloneIds', () => {
  it('returns the same tree when nothing repeats', () => {
    const root = el({}, row(0, { id: 'a' }), row(1, { id: 'b' }));
    expect(suffixCloneIds(root)).toBe(root);
  });

  it('leaves a repeat outside any clone, which it cannot place', () => {
    const root = el({}, el({ id: 'a' }), el({ id: 'a' }));
    expect(suffixCloneIds(root)).toBe(root);
  });

  it('keeps the first use, so an anchor keeps working', () => {
    const out = suffixCloneIds(el({}, row(0, { id: 'a' }), row(1, { id: 'a' }), row(2, { id: 'a' })));
    expect(out.children?.map((child) => child.props?.id)).toEqual(['a', 'a-r1', 'a-r2']);
  });

  it('moves a row off an id the page holds outside the Collection', () => {
    const out = suffixCloneIds(el({}, row(0, { id: 'a' }), row(1, { id: 'a' }), el({ id: 'a' })));
    expect(out.children?.map((child) => child.props?.id)).toEqual(['a-r0', 'a-r1', 'a']);
  });

  it('takes no id the page already uses', () => {
    const out = suffixCloneIds(el({}, row(0, { id: 'a' }), row(1, { id: 'a' }), el({ id: 'a-r1' })));
    expect(out.children?.[1].props?.id).toBe('a-r1_');
  });

  it('follows a reference that comes before its id', () => {
    const out = suffixCloneIds(el({}, row(0, {}, el({ htmlFor: 'f' }), el({ id: 'f' })), row(1, {}, el({ htmlFor: 'f' }), el({ id: 'f' }))));
    expect(out.children?.[1].children?.map((child) => child.props)).toEqual([{ htmlFor: 'f-r1' }, { id: 'f-r1' }]);
  });

  it('leaves a reference out of the clone alone', () => {
    const out = suffixCloneIds(el({}, el({ id: 'top' }), row(0, { 'aria-controls': 'top' }), row(1, { 'aria-controls': 'top' })));
    expect(out.children?.[2].props).toEqual({ 'aria-controls': 'top' });
  });

  it('keeps a reference from outside on the first row', () => {
    const out = suffixCloneIds(el({}, el({ href: '#a' }), row(0, { id: 'a' }), row(1, { id: 'a' })));
    expect(out.children?.[0].props).toEqual({ href: '#a' });
  });

  it('keeps nested rows apart, and an inner reference finds its outer row', () => {
    const inner = (index: number) => row(index, { id: 'leaf', 'aria-owns': 'top' });
    const outer = (index: number) => row(index, { id: 'top' }, inner(0), inner(1));
    const out = suffixCloneIds(el({}, outer(0), outer(1)));
    const leaves = out.children?.flatMap((child) => child.children ?? []).map((child) => child.props);
    expect(leaves).toEqual([
      { id: 'leaf', 'aria-owns': 'top' },
      { id: 'leaf-r0-1', 'aria-owns': 'top' },
      { id: 'leaf-r1-0', 'aria-owns': 'top-r1' },
      { id: 'leaf-r1-1', 'aria-owns': 'top-r1' },
    ]);
  });

  it('does not change what it was given', () => {
    const root = el({}, row(0, { id: 'a' }), row(1, { id: 'a' }));
    const copy = JSON.parse(JSON.stringify(root));
    suffixCloneIds(root);
    expect(root).toEqual(copy);
  });

  it('ignores an id that is not text', () => {
    const root = el({}, row(0, { id: 3 }), row(1, { id: 3 }));
    expect(suffixCloneIds(root)).toBe(root);
  });
});
