// The review's change list (src/lib/siteMerge/elementChanges.ts, slice S5): per page and element, with values.

import { describe, expect, it } from 'vitest';
import { elementChanges, outlinedIds, reviewDocuments, shownValue, SHOWN_VALUE_MAX_CHARS } from '../elementChanges';
import { diffDocuments } from '../diff';
import type { MergeDocument, MergePage } from '../document';

type N = Record<string, unknown>;
const node = (id: string, props: N = {}, children?: N[], type = 'div'): N => ({ id, type, componentType: 'host', props, ...(children ? { children } : {}) });
const page = (pageId: string, children: N[], over: N = {}): MergePage => ({
  pageId,
  slug: (over.slug as string) ?? pageId,
  snapshot: { id: pageId, slug: pageId, metadata: { title: `Title ${pageId}` }, updatedAt: '2026-11-01', appComponentTree: node(`root-${pageId}`, {}, children), canvasNodes: {}, ...over },
});
const doc = (pages: MergePage[], over: Partial<MergeDocument> = {}): MergeDocument => ({
  name: 'S', description: '', analyticsProjectId: null, ingestionEndpoint: null, apiKeyRef: null, lumitraEnabled: false,
  redirects: [], siteSettings: { language: 'de' }, pages, components: {}, ...over,
});
const tree = (children: N[]) => ({ appComponentTree: node('root', {}, children), canvasNodes: {} });

describe('elementChanges', () => {
  it('names added, removed and changed elements, with each changed field', () => {
    const before = tree([node('a', { children: 'Hello', style: { color: 'red', margin: 4 } }), node('gone', {}, [], 'section')]);
    const after = tree([node('a', { children: 'Hello there', style: { color: 'blue', margin: 4 } }), node('new', { children: 'Fresh' }, [], 'p')]);
    const changes = elementChanges(before, after);
    expect(changes).toEqual([
      { id: 'a', kind: 'changed', type: 'div', label: 'Hello there', fields: [
        { field: 'props.children', before: 'Hello', after: 'Hello there' },
        { field: 'props.style.color', before: 'red', after: 'blue' },
      ] },
      { id: 'new', kind: 'added', type: 'p', label: 'Fresh', fields: [] },
      { id: 'gone', kind: 'removed', type: 'section', label: 'section', fields: [] },
    ]);
  });

  it('counts a move on the moved element only: a neighbour removed or added is no move', () => {
    const before = tree([node('a'), node('b'), node('c')]);
    expect(elementChanges(before, tree([node('b'), node('c')]))).toEqual([expect.objectContaining({ id: 'a', kind: 'removed' })]);
    expect(elementChanges(before, tree([node('x'), node('a'), node('b'), node('c')]))).toEqual([expect.objectContaining({ id: 'x', kind: 'added' })]);
    expect(elementChanges(before, tree([node('b'), node('c'), node('a')])).map((c) => [c.id, c.kind])).toEqual([['a', 'moved']]);
    // One moved among fifty marks that one.
    const many = Array.from({ length: 50 }, (_, i) => node(`n${i}`));
    const shifted = [...many.slice(1, 30), many[0], ...many.slice(30)];
    expect(elementChanges(tree(many), tree(shifted)).map((c) => [c.id, c.kind])).toEqual([['n0', 'moved']]);
    // A move with a neighbour removed: still only the moved one.
    expect(elementChanges(before, tree([node('c'), node('a')])).map((c) => [c.id, c.kind]).sort()).toEqual([['b', 'removed'], ['c', 'moved']].sort());
  });

  it('a move into another parent, with a field changed too, is one moved element with its fields', () => {
    const before = tree([node('box', {}, []), node('a', { children: 'x' })]);
    const after = tree([node('box', {}, [node('a', { children: 'y' })])]);
    const changes = elementChanges(before, after);
    expect(changes.find((c) => c.id === 'a')).toEqual({ id: 'a', kind: 'moved', type: 'div', label: 'y', fields: [{ field: 'props.children', before: 'x', after: 'y' }] });
  });

  it('leaves out where a frame sits on the canvas, and lists its width', () => {
    const frame = (x: number, width: string) => ({ appComponentTree: node('root'), canvasNodes: { v1: { id: 'v1', type: 'div', canvasX: x, canvasY: 0, canvasZIndex: 1, props: { style: { width } } } } });
    expect(elementChanges(frame(100, '1280px'), frame(900, '1280px'))).toEqual([]);
    expect(elementChanges(frame(100, '1280px'), frame(900, '1440px'))).toEqual([
      expect.objectContaining({ id: 'v1', kind: 'changed', fields: [{ field: 'props.style.width', before: '1280px', after: '1440px' }] }),
    ]);
  });

  it('nothing for the same tree', () => {
    const same = tree([node('a', { children: 'x' }, [node('b')])]);
    expect(elementChanges(same, JSON.parse(JSON.stringify(same)))).toEqual([]);
  });
});

describe('shownValue', () => {
  it('passes a short value and replaces a long one with its size', () => {
    expect(shownValue('short')).toBe('short');
    expect(shownValue(undefined)).toBeNull();
    const long = 'x'.repeat(SHOWN_VALUE_MAX_CHARS + 10);
    expect(shownValue(long)).toEqual({ omitted: true, characters: JSON.stringify(long).length });
  });

  it('applies to a changed field\'s values in the list', () => {
    const long = 'y'.repeat(SHOWN_VALUE_MAX_CHARS * 2);
    const [change] = elementChanges(tree([node('a', { children: 'x' })]), tree([node('a', { children: long })]));
    expect(change.fields[0].after).toEqual({ omitted: true, characters: JSON.stringify(long).length });
    expect(change.label.length).toBeLessThanOrEqual(60);
  });
});

describe('reviewDocuments', () => {
  const base = doc([page('home', [node('a', { children: 'Hi' })]), page('about', [node('b')]), page('old', [node('o')])]);

  it('lists changed pages with their elements, counts the elements of a page that is new or removed as a whole, and leaves unchanged ones out', () => {
    const after = doc(
      [page('home', [node('a', { children: 'Hello' })], { updatedAt: '2026-11-09' }), page('about', [node('b')], { updatedAt: '2026-11-10' }), page('team', [node('t', { children: 'Team' })])],
      { name: 'Renamed', siteSettings: { language: 'en' } },
    );
    const review = reviewDocuments(base, after);
    expect(review.site).toEqual([{ field: 'name', before: 'S', after: 'Renamed' }]);
    expect(review.settings).toEqual([{ field: 'language', before: 'de', after: 'en' }]);
    expect(review.units.map((u) => [u.id, u.change])).toEqual([['home', 'changed'], ['team', 'added'], ['old', 'removed']]);
    const team = review.units.find((u) => u.id === 'team')!;
    expect(team).toMatchObject({ title: 'Title team', slug: { before: null, after: 'team' } });
    // New or removed as a whole: counted, never listed element by element (a large new page was a thousand rows).
    expect(team).toMatchObject({ elements: [], elementCount: 2 });
    expect(review.units.find((u) => u.id === 'old')).toMatchObject({ elements: [], elementCount: 2 });
    const home = review.units.find((u) => u.id === 'home')!;
    expect(home.elements.map((e) => [e.id, e.kind])).toEqual([['a', 'changed']]);
    expect(home.elementCount).toBeUndefined();
  });

  it('a new page of a thousand elements is one line of the review, not a thousand', () => {
    const many = Array.from({ length: 1_000 }, (_, i) => node(`n${i}`, { children: `Text ${i}` }));
    const review = reviewDocuments(base, doc([...base.pages, page('big', many)]));
    const big = review.units.find((u) => u.id === 'big')!;
    expect(big).toMatchObject({ change: 'added', elements: [], elementCount: 1_001 });
    expect(JSON.stringify(review).length).toBeLessThan(2_000);
  });

  it('names a new address and changed page settings outside the elements', () => {
    const after = doc([page('home', [node('a', { children: 'Hi' })], { slug: 'start', metadata: { title: 'Start' } }), page('about', [node('b')]), page('old', [node('o')])]);
    const home = reviewDocuments(base, after).units.find((u) => u.id === 'home')!;
    expect(home.slug).toEqual({ before: 'home', after: 'start' });
    expect(home.fields.map((f) => f.field)).toEqual(['metadata', 'slug']);
    expect(home.elements).toEqual([]);
  });

  it('lists components and their elements', () => {
    const withCard = doc(base.pages, { components: { card: { id: 'card', name: 'Card', page: tree([node('c', { children: 'One' })]) } } });
    const changedCard = doc(base.pages, { components: { card: { id: 'card', name: 'Card', page: tree([node('c', { children: 'Two' })]) } } });
    const units = reviewDocuments(withCard, changedCard).units;
    expect(units).toEqual([expect.objectContaining({ unit: 'component', id: 'card', title: 'Card', change: 'changed' })]);
    expect(units[0].elements).toEqual([expect.objectContaining({ id: 'c', kind: 'changed' })]);
    expect(reviewDocuments(changedCard, base).units).toEqual([expect.objectContaining({ unit: 'component', id: 'card', change: 'removed', elements: [], elementCount: 2 })]);
    expect(reviewDocuments(base, withCard).units).toEqual([expect.objectContaining({ unit: 'component', id: 'card', change: 'added', elements: [], elementCount: 2 })]);
  });

  it('agrees with the counts of diffDocuments', () => {
    const after = doc([page('home', [node('a', { children: 'Hello' }), node('n')]), page('about', []), page('team', [])]);
    const counts = diffDocuments(base, after);
    const review = reviewDocuments(base, after);
    const kinds = review.units.filter((u) => u.change === 'changed').flatMap((u) => u.elements.map((e) => e.kind));
    expect(kinds.filter((k) => k === 'added')).toHaveLength(counts.nodes.added);
    expect(kinds.filter((k) => k === 'removed')).toHaveLength(counts.nodes.removed);
  });

  it('names a changed key reference without its value', () => {
    const review = reviewDocuments(doc([]), doc([], { apiKeyRef: 'ref-b' }));
    expect(review.site).toEqual([{ field: 'apiKeyRef', before: { omitted: true, hidden: true }, after: { omitted: true, hidden: true } }]);
    expect(JSON.stringify(review)).not.toContain('ref-b');
  });

  it('nothing for the same document', () => {
    expect(reviewDocuments(base, JSON.parse(JSON.stringify(base)))).toEqual({ site: [], settings: [], units: [], pageOrder: false });
  });
});

describe('outlinedIds', () => {
  it('outlines on the branch what it adds, moves or changes, and on main what it removes or changes', () => {
    const unit = reviewDocuments(
      doc([page('home', [node('a', { children: 'x' }), node('gone')])]),
      doc([page('home', [node('a', { children: 'y' }), node('new')])]),
    ).units[0];
    expect(outlinedIds(unit, 'branch').sort()).toEqual(['a', 'new']);
    expect(outlinedIds(unit, 'main').sort()).toEqual(['a', 'gone']);
  });
});
