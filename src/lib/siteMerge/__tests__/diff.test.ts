// What changed between two site documents (src/lib/siteMerge/diff.ts), for the counts of S3 and S5.

import { describe, expect, it } from 'vitest';
import { diffDocuments } from '../diff';
import type { MergeDocument, MergePage } from '../document';

type N = Record<string, unknown>;
const node = (id: string, props: N = {}, children?: N[]): N => ({ id, type: 'div', componentType: 'host', props, ...(children ? { children } : {}) });
const page = (pageId: string, children: N[], over: N = {}): MergePage => ({
  pageId,
  slug: pageId,
  snapshot: { id: pageId, slug: pageId, metadata: { title: pageId }, updatedAt: '2026-11-01', appComponentTree: node(`root-${pageId}`, {}, children), canvasNodes: {}, ...over },
});
const doc = (pages: MergePage[], over: Partial<MergeDocument> = {}): MergeDocument => ({
  name: 'S', description: '', analyticsProjectId: null, ingestionEndpoint: null, apiKeyRef: null, lumitraEnabled: false,
  redirects: [], siteSettings: { language: 'de', head: [] }, pages, components: {}, ...over,
});

describe('diffDocuments', () => {
  const base = doc([page('home', [node('a'), node('b', {}, [node('b1')])]), page('about', [])]);

  it('the same document: nothing changed, timestamps aside', () => {
    const touched = doc([page('home', [node('a'), node('b', {}, [node('b1')])], { updatedAt: '2026-11-09' }), page('about', [])]);
    expect(diffDocuments(base, touched)).toEqual({
      site: [], settings: [], pages: { added: [], removed: [], changed: [] }, components: { added: [], removed: [], changed: [] },
      nodes: { added: 0, removed: 0, changed: 0 }, pageOrder: false,
    });
  });

  it('counts pages, nodes, settings and site fields', () => {
    const after = doc(
      [page('about', []), page('home', [node('b', { x: 1 }, [node('b1'), node('new')])]), page('team', [node('t')])],
      { name: 'Renamed', siteSettings: { language: 'en', head: [] }, components: { card: { id: 'card', page: { appComponentTree: node('c') } } } },
    );
    const changes = diffDocuments(base, after);
    expect(changes.site).toEqual(['name']);
    expect(changes.settings).toEqual(['language']);
    expect(changes.pages).toEqual({ added: ['team'], removed: [], changed: ['home'] });
    expect(changes.components).toEqual({ added: ['card'], removed: [], changed: [] });
    // On home: a removed, new added, b changed (a field and a new child).
    expect(changes.nodes).toEqual({ added: 1, removed: 1, changed: 1 });
    expect(changes.pageOrder).toBe(true);
  });

  it('a moved node counts as changed, a reorder changes its parent', () => {
    const moved = doc([page('home', [node('a', {}, [node('b1')]), node('b')]), page('about', [])]);
    expect(diffDocuments(base, moved).nodes).toEqual({ added: 0, removed: 0, changed: 1 });
    const reordered = doc([page('home', [node('b', {}, [node('b1')]), node('a')]), page('about', [])]);
    expect(diffDocuments(base, reordered).nodes).toEqual({ added: 0, removed: 0, changed: 1 });
  });
});
