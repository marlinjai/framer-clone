// Rule 10 of the site branches plan: a removal the other side newly points at is asked, never left
// dangling silently, and what still dangles after the answers is reported.

import { describe, expect, it } from 'vitest';
import { mergeDocuments, type MergeDocument, type MergePage } from '../document';
import { nodeReferences } from '../references';

type N = Record<string, unknown>;
const node = (id: string, props: N = {}, children?: N[]): N => ({ id, type: 'div', componentType: 'host', props, ...(children ? { children } : {}) });

function page(pageId: string, slug: string, children: N[]): MergePage {
  return { pageId, slug, snapshot: { id: pageId, slug, metadata: { title: pageId }, appComponentTree: node(`root-${pageId}`, {}, children), canvasNodes: {} } };
}

function doc(pages: MergePage[], over: Partial<MergeDocument> = {}): MergeDocument {
  return {
    name: 'S', description: '', analyticsProjectId: null, ingestionEndpoint: null, apiKeyRef: null, lumitraEnabled: false,
    redirects: [], siteSettings: { notFoundPageId: '' }, pages, components: {}, ...over,
  };
}

const answerAll = (merged: ReturnType<typeof mergeDocuments>, pick: 'main' | 'branch') =>
  Object.fromEntries(merged.conflicts.map((c) => [c.id, { fingerprint: c.fingerprint, pick }]));

describe('nodeReferences', () => {
  it('finds behaviour references and HTML id references, mapped to node ids', () => {
    const trees = [
      node('root', {}, [
        node('menu', { id: 'main-menu' }),
        node('button', { 'aria-controls': 'main-menu', behaviour: { on: [{ event: 'click', do: [{ popover: 'dialog1' }] }] } }),
        node('label', { htmlFor: 'missing-html-id' }),
      ]),
    ];
    expect([...nodeReferences(trees)].sort()).toEqual(['dialog1', 'menu']);
  });
});

describe('a removal the other side points at', () => {
  const base = doc([page('home', '', [node('a'), node('target', { text: 'T' })])]);

  it('a node main removed that the branch newly points at is asked, and a dangling result is reported', () => {
    const main = doc([page('home', '', [node('a')])]);
    const branch = doc([page('home', '', [node('a', { behaviour: { on: [{ event: 'click', do: [{ focus: 'target' }] }] } }), node('target', { text: 'T' })])]);
    const merged = mergeDocuments(base, main, branch);
    expect(merged.conflicts.map((c) => [c.kind, c.unit.id, c.removedOn])).toEqual([['removed', 'target', 'main']]);
    // Main stands in: removed, and the branch's new reference now points at nothing: reported.
    expect(merged.dangling).toEqual([{ kind: 'node', id: 'target', container: 'page:home' }]);
    const kept = mergeDocuments(base, main, branch, answerAll(merged, 'branch'));
    expect(kept.conflicts).toEqual([]);
    expect(kept.dangling).toEqual([]);
  });

  it('a page main removed that the branch newly links to is asked', () => {
    const b = doc([page('home', '', [node('a')]), page('about', 'about', [])]);
    const main = doc([page('home', '', [node('a')])]);
    const branch = doc([page('home', '', [node('a', { href: '/about' })]), page('about', 'about', [])]);
    const merged = mergeDocuments(b, main, branch);
    expect(merged.conflicts.map((c) => [c.kind, c.unit.kind, c.unit.id])).toEqual([['removed', 'page', 'about']]);
  });

  it('a page main removed that the branch made the 404 page, or a form’s thank-you page, is asked', () => {
    const b = doc([page('home', '', [node('a')]), page('thanks', 'thanks', [])]);
    const main = doc([page('home', '', [node('a')])]);
    const as404 = doc([page('home', '', [node('a')]), page('thanks', 'thanks', [])], { siteSettings: { notFoundPageId: 'thanks' } });
    expect(mergeDocuments(b, main, as404).conflicts.map((c) => c.unit.id)).toEqual(['thanks']);
    const asForm = doc([page('home', '', [node('a', { successBehavior: 'redirect', redirectPageId: 'thanks' })]), page('thanks', 'thanks', [])]);
    const merged = mergeDocuments(b, main, asForm);
    expect(merged.conflicts.map((c) => c.unit.id)).toEqual(['thanks']);
    expect(merged.dangling).toEqual([{ kind: 'page', id: 'thanks' }]);
  });

  it('a component main removed that the branch newly places is asked', () => {
    const definition = { id: 'card', name: 'Card', page: { id: 'p', slug: '', metadata: { title: 'Card' }, appComponentTree: node('card-root'), canvasNodes: {} } };
    const b = doc([page('home', '', [node('a')])], { components: { card: definition } });
    const main = doc([page('home', '', [node('a')])]);
    const branch = doc([page('home', '', [node('a'), { id: 'use', type: '#component', componentType: 'host', props: { component: 'card' } }])], { components: { card: definition } });
    const merged = mergeDocuments(b, main, branch);
    expect(merged.conflicts.map((c) => [c.kind, c.unit.kind, c.unit.id])).toEqual([['removed', 'component', 'card']]);
    expect(merged.dangling).toEqual([{ kind: 'component', id: 'card' }]);
  });

  it('links to an address the other side renamed are reported, with their count', () => {
    const b = doc([page('home', '', [node('a')]), page('about', 'about', [])]);
    const main = doc([page('home', '', [node('a')]), page('about', 'ueber-uns', [])]);
    const branch = doc([page('home', '', [node('a', { href: '/about' }), node('b', { href: '/About/#team' })]), page('about', 'about', [])]);
    const merged = mergeDocuments(b, main, branch);
    expect(merged.conflicts).toEqual([]);
    expect(merged.dangling).toEqual([{ kind: 'link', id: 'about', slug: 'about', count: 2 }]);
    // The same links with the old address kept: nothing dangles.
    expect(mergeDocuments(b, b, branch).dangling).toEqual([]);
  });

  it('a reference that already dangled on one side alone is not the merge’s doing', () => {
    const main = doc([page('home', '', [node('a', { behaviour: { on: [{ event: 'click', do: [{ focus: 'ghost' }] }] } })])]);
    expect(mergeDocuments(base, main, base).dangling).toEqual([]);
  });
});
