// The cases an independent review of the merge engine found (site branches plan, S2), each with its input:
// a replaced top node, rule 10 asked from what the result leaves dangling, a node moved to another page, an
// answer whose values change, and the cost of a parent with many children.

import { describe, expect, it } from 'vitest';
import { mergeDocuments, type DocumentMerge, type MergeDocument, type MergePage } from '../document';
import { mergedDocumentProblems } from '../validate';
import type { MergeAnswers, MergeSide } from '../types';

type N = Record<string, unknown>;
const node = (id: string, props: N = {}, children?: N[]): N => ({ id, type: 'div', componentType: 'host', props, ...(children ? { children } : {}) });
const page = (pageId: string, slug: string, root: N): MergePage => ({
  pageId,
  slug,
  snapshot: { id: pageId, slug, metadata: { title: pageId }, appComponentTree: root, canvasNodes: {} },
});
const doc = (pages: MergePage[], over: Partial<MergeDocument> = {}): MergeDocument => ({
  name: 'S', description: '', analyticsProjectId: null, ingestionEndpoint: null, apiKeyRef: null, lumitraEnabled: false,
  redirects: [], siteSettings: {}, pages, components: {}, ...over,
});
const focus = (target: string) => ({ behaviour: { on: [{ event: 'click', do: [{ focus: target }] }] } });
const answer = (merged: DocumentMerge, pick: MergeSide, answers: MergeAnswers = {}): MergeAnswers => ({
  ...answers,
  ...Object.fromEntries(merged.conflicts.map((c) => [c.id, { fingerprint: c.fingerprint, pick }])),
});
/** Answer every conflict the same way, round after round, as the review screen would. */
function settle(base: MergeDocument, main: MergeDocument, branch: MergeDocument, pick: MergeSide) {
  let answers: MergeAnswers = {};
  for (let round = 0; round < 10; round++) {
    const merged = mergeDocuments(base, main, branch, answers);
    if (merged.conflicts.length === 0) return merged;
    answers = answer(merged, pick, answers);
  }
  throw new Error('never settled');
}
const rootOf = (d: MergeDocument, pageId = 'home') => d.pages.find((p) => p.pageId === pageId)!.snapshot.appComponentTree as N;

describe('review cases', () => {
  it('a page whose top node main replaced, edited inside on the branch: main’s tree is never lost', () => {
    const base = doc([page('home', '', node('root', {}, [node('a', { t: 'A' })]))]);
    const main = doc([page('home', '', node('root2', {}, [node('b', { t: 'main work' })]))]);
    const branch = doc([page('home', '', node('root', {}, [node('a', { t: 'edited' })]))]);
    const first = mergeDocuments(base, main, branch);
    expect(first.conflicts.map((c) => [c.kind, c.unit.id])).toEqual([['removed', 'root']]);
    expect(rootOf(first.document).id).toBe('root2');
    // Keeping the old top brings two tops: asked, and main's stands in meanwhile.
    const kept = mergeDocuments(base, main, branch, answer(first, 'branch'));
    expect(kept.conflicts.map((c) => c.path)).toEqual([['appComponentTree']]);
    expect(rootOf(kept.document).id).toBe('root2');
    expect(rootOf(settle(base, main, branch, 'branch').document).id).toBe('root');
  });

  it('rule 10: a second node newly pointing at what main removed is asked, though the base pointed at it already', () => {
    const base = doc([page('home', '', node('root', {}, [node('a', focus('target')), node('target'), node('b')]))]);
    const main = doc([page('home', '', node('root', {}, [node('b')]))]);
    const branch = doc([page('home', '', node('root', {}, [node('a', focus('target')), node('target'), node('b', focus('target'))]))]);
    const merged = mergeDocuments(base, main, branch);
    expect(merged.conflicts.map((c) => [c.kind, c.unit.id, c.removedOn])).toEqual([['removed', 'target', 'main']]);
    expect(merged.dangling).toEqual([{ kind: 'node', id: 'target', container: 'page:home' }]);
    expect(settle(base, main, branch, 'branch').dangling).toEqual([]);
  });

  it('rule 10: a link the branch moved to a new node, to a page main removed, is asked', () => {
    const base = doc([page('home', '', node('root', {}, [node('x', { href: '/about' })])), page('about', 'about', node('ra'))]);
    const main = doc([page('home', '', node('root', {}, [node('x', { href: '/about' })]))]);
    const branch = doc([page('home', '', node('root', {}, [node('x'), node('y', { href: '/about' })])), page('about', 'about', node('ra'))]);
    const merged = mergeDocuments(base, main, branch);
    expect(merged.conflicts.map((c) => [c.kind, c.unit.kind, c.unit.id])).toEqual([['removed', 'page', 'about']]);
    // Main stands in: the page is gone, and the link the merge made is reported.
    expect(merged.dangling).toEqual([{ kind: 'link', id: 'about', slug: 'about', count: 1 }]);
  });

  it('rule 10: a placement kept against main’s removal asks the component it uses too', () => {
    const card = { id: 'card', name: 'Card', page: { id: 'p', slug: '', metadata: { title: 'Card' }, appComponentTree: node('card-root'), canvasNodes: {} } };
    const use = (props: N = {}) => ({ id: 'use', type: '#component', componentType: 'host', props: { component: 'card', ...props } });
    const base = doc([page('home', '', node('root', {}, [use()]))], { components: { card } });
    const main = doc([page('home', '', node('root', {}, []))]);
    const branch = doc([page('home', '', node('root', {}, [use({ inputs: { title: 'Hi' } })]))], { components: { card } });
    const first = mergeDocuments(base, main, branch);
    expect(first.conflicts.map((c) => [c.kind, c.unit.kind, c.unit.id])).toEqual([['removed', 'node', 'use']]);
    const second = mergeDocuments(base, main, branch, answer(first, 'branch'));
    expect(second.conflicts.map((c) => [c.kind, c.unit.kind, c.unit.id])).toEqual([['removed', 'component', 'card']]);
    const done = settle(base, main, branch, 'branch');
    expect(Object.keys(done.document.components)).toEqual(['card']);
    expect(done.dangling).toEqual([]);
  });

  it('decision 36: a node moved to another page is a removal plus an addition; kept on both, the check refuses it', () => {
    const base = doc([page('home', '', node('rh', {}, [node('m', { t: 'M' })])), page('about', 'about', node('ra', {}, []))]);
    const main = doc([page('home', '', node('rh', {}, [node('m', { t: 'main edit' })])), page('about', 'about', node('ra', {}, []))]);
    const branch = doc([page('home', '', node('rh', {}, [])), page('about', 'about', node('ra', {}, [node('m', { t: 'M' })]))]);
    const merged = mergeDocuments(base, main, branch);
    expect(merged.conflicts.map((c) => [c.kind, c.unit.container, c.unit.id, c.removedOn])).toEqual([['removed', 'page:home', 'm', 'branch']]);
    const toProject = () => ({}) as never;
    expect(mergedDocumentProblems(merged.document, main, toProject).map((p) => p.code)).toContain('duplicate_id');
    // Taking the branch's side: moved, main's edit not kept.
    const moved = settle(base, main, branch, 'branch');
    expect(mergedDocumentProblems(moved.document, main, toProject).map((p) => p.code)).not.toContain('duplicate_id');
  });

  it('an answer whose values change on main is asked again', () => {
    const base = doc([page('home', '', node('root', { t: 'base' }))]);
    const branch = doc([page('home', '', node('root', { t: 'branch' }))]);
    const main1 = doc([page('home', '', node('root', { t: 'main 1' }))]);
    const first = mergeDocuments(base, main1, branch);
    const answers = answer(first, 'branch');
    expect(mergeDocuments(base, main1, branch, answers).conflicts).toEqual([]);
    const main2 = doc([page('home', '', node('root', { t: 'main 2' }))]);
    const again = mergeDocuments(base, main2, branch, answers);
    expect(again.conflicts.map((c) => c.id)).toEqual([first.conflicts[0].id]);
    expect((rootOf(again.document).props as N).t).toBe('main 2');
  });

  it('a parent with 20,000 children merges in linear time', () => {
    const kids = Array.from({ length: 20_000 }, (_, i) => node(`k${i}`, { t: i }));
    const base = doc([page('home', '', node('root', {}, kids))]);
    const main = doc([page('home', '', node('root', {}, [...kids.slice(1), kids[0], node('m-new')]))]);
    const branch = doc([page('home', '', node('root', {}, [node('r-new'), ...kids.map((k, i) => (i === 500 ? node('k500', { t: 'edited' }) : k))]))]);
    const started = performance.now();
    const merged = mergeDocuments(base, main, branch);
    const took = performance.now() - started;
    expect(merged.conflicts).toEqual([]);
    const children = rootOf(merged.document).children as N[];
    expect(children).toHaveLength(20_002);
    expect(children[0].id).toBe('r-new');
    expect(children.at(-1)?.id).toBe('m-new');
    // Generous for a loaded machine; the quadratic version took over two seconds here.
    expect(took).toBeLessThan(1500);
  });
});
