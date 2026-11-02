import { describe, expect, it } from 'vitest';
import { isIdReference, suffixCloneIds, withFollowedRefs } from '../idRefs';

interface TestNode {
  type?: string;
  props?: Record<string, unknown>;
  children?: TestNode[];
  cloneIndex?: number;
}

const el = (props: Record<string, unknown>, ...children: TestNode[]): TestNode => ({ props, children });
const row = (cloneIndex: number, props: Record<string, unknown>, ...children: TestNode[]): TestNode => ({ props, children, cloneIndex });
/** A row holding `id` and something pointing at it. */
const pointed = (cloneIndex: number, id = 'a'): TestNode => row(cloneIndex, { id, 'aria-owns': id });

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
    const out = suffixCloneIds(el({}, pointed(0), pointed(1), pointed(2)));
    expect(out.children?.map((child) => child.props?.id)).toEqual(['a', 'a-r1', 'a-r2']);
  });

  it('moves a row off an id the page holds outside the Collection', () => {
    const out = suffixCloneIds(el({}, pointed(0), pointed(1), el({ id: 'a' })));
    expect(out.children?.map((child) => child.props?.id)).toEqual(['a-r0', 'a-r1', 'a']);
  });

  it('takes no id the page already uses', () => {
    const out = suffixCloneIds(el({}, pointed(0), pointed(1), el({ id: 'a-r1' })));
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
    const out = suffixCloneIds(el({}, el({ href: '#a' }), pointed(0), pointed(1)));
    expect(out.children?.[0].props).toEqual({ href: '#a' });
  });

  it('keeps nested rows apart, and an inner reference finds its outer row', () => {
    const inner = (index: number) => row(index, { id: 'leaf', 'aria-owns': 'top leaf' });
    const outer = (index: number) => row(index, { id: 'top' }, inner(0), inner(1));
    const out = suffixCloneIds(el({}, outer(0), outer(1)));
    const leaves = out.children?.flatMap((child) => child.children ?? []).map((child) => child.props);
    expect(leaves).toEqual([
      { id: 'leaf', 'aria-owns': 'top leaf' },
      { id: 'leaf-r0-1', 'aria-owns': 'top leaf-r0-1' },
      { id: 'leaf-r1-0', 'aria-owns': 'top-r1 leaf-r1-0' },
      { id: 'leaf-r1-1', 'aria-owns': 'top-r1 leaf-r1-1' },
    ]);
  });

  it('does not change what it was given', () => {
    const root = el({}, pointed(0), pointed(1));
    const copy = JSON.parse(JSON.stringify(root));
    suffixCloneIds(root);
    expect(root).toEqual(copy);
  });

  it('leaves a repeat nothing inside the clone points at', () => {
    const root = el({}, row(0, { id: 'badge' }), row(1, { id: 'badge' }));
    expect(suffixCloneIds(root)).toBe(root);
    const fromOutside = el({}, el({ href: '#badge' }), row(0, { id: 'badge' }), row(1, { id: 'badge' }));
    expect(suffixCloneIds(fromOutside)).toBe(fromOutside);
  });

  describe('an id a rule names', () => {
    const page = (rule: object) => el({ rules: [rule] }, pointed(0, 'badge'), pointed(1, 'badge'));

    it('stays, in every way a selector can read it', () => {
      for (const selector of ['& #badge', '&#badge', '& > #badge:hover', '& [id="badge"]', "& [ID='badge']", '& [id=badge]', '& [id$="dge"]', '& :is(#badge, p)']) {
        const root = page({ id: 'r', selector, style: {} });
        expect(suffixCloneIds(root), selector).toBe(root);
      }
    });

    it('stays when a wrapper or a compiled rule names it', () => {
      const wrapped = page({ id: 'r', selector: '&', at: ['@scope (#badge)'], style: {} });
      expect(suffixCloneIds(wrapped)).toBe(wrapped);
      const compiled = { ...el({}, pointed(0, 'badge'), pointed(1, 'badge')), compiledRules: [{ parts: ['& #badge'], at: [] }] };
      expect(suffixCloneIds(compiled)).toBe(compiled);
    });

    it('does not stop for a longer id or a colour', () => {
      const root = page({ id: 'r', selector: '& #badge2', style: { color: '#badge' } });
      expect(suffixCloneIds(root).children?.[1].props?.id).toBe('badge-r1');
    });
  });

  it('follows an image map, which is found by its name', () => {
    const copy = (index: number): TestNode => row(index, {}, { type: 'map', props: { name: 'm', id: 'm' } }, el({ useMap: '#m' }));
    const out = suffixCloneIds(el({}, copy(0), copy(1)));
    expect(out.children?.[1].children?.map((child) => child.props)).toEqual([{ name: 'm-r1', id: 'm-r1' }, { useMap: '#m-r1' }]);
    const named = (index: number): TestNode => row(index, {}, { type: 'map', props: { name: 'n' } }, el({ usemap: '#n' }));
    const onlyName = suffixCloneIds(el({}, named(0), named(1)));
    expect(onlyName.children?.[1].children?.map((child) => child.props)).toEqual([{ name: 'n-r1' }, { usemap: '#n-r1' }]);
  });

  it('ignores an id that is not text', () => {
    const root = el({}, row(0, { id: 3 }), row(1, { id: 3 }));
    expect(suffixCloneIds(root)).toBe(root);
  });
});
