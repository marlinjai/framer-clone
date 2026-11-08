// createdIds.ts refPagesOf: the page each created ref landed on, for the skeleton plans.
import { describe, expect, it } from 'vitest';
import { refPagesOf } from '../createdIds';

describe('refPagesOf', () => {
  it('maps the refs of sections inserted at the page root to their page, resolves a page the batch made, and leaves page refs out', () => {
    const ops = [
      { op: 'createPage', title: 'Pricing', ref: 'pp' },
      { op: 'insertNodes', pageId: 'ref:pp', nodes: [{ type: 'section', ref: 'hero', children: [{ type: 'h1', ref: 'title' }] }] },
      { op: 'insertNodes', pageId: 'home', nodes: [{ type: 'section', ref: 'faq' }] },
      { op: 'placeComponent', pageId: 'home', definitionId: 'd', ref: 'nav' },
      { op: 'insertNodes', pageId: 'ref:unknown', nodes: [{ type: 'section', ref: 'lost' }] },
      // Inside an existing section: not a section of its own.
      { op: 'insertNodes', pageId: 'home', parentId: 'about', nodes: [{ type: 'div', ref: 'inner' }] },
      { op: 'placeComponent', pageId: 'home', definitionId: 'd', ref: 'card', to: { parentId: 'about' } },
      // The page root named explicitly is still the page root.
      { op: 'insertNodes', pageId: 'home', parentId: 'root-home', nodes: [{ type: 'section', ref: 'cta' }] },
    ];
    const created = { pp: 'page-9', hero: 'n1', title: 'n2', faq: 'n3', nav: 'n4', lost: 'n5', inner: 'n6', card: 'n7', cta: 'n8' };
    expect(refPagesOf(ops, created, (p) => (p === 'home' ? 'root-home' : undefined))).toEqual({ hero: 'page-9', faq: 'home', nav: 'home', cta: 'home' });
    expect(refPagesOf('nope', created)).toEqual({});
  });
});
