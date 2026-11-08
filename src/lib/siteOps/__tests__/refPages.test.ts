// createdIds.ts refPagesOf: the page each created ref landed on, for the skeleton plans.
import { describe, expect, it } from 'vitest';
import { refPagesOf } from '../createdIds';

describe('refPagesOf', () => {
  it('maps node refs (nested ones too) to their page, resolves a page the batch made, and leaves page refs out', () => {
    const ops = [
      { op: 'createPage', title: 'Pricing', ref: 'pp' },
      { op: 'insertNodes', pageId: 'ref:pp', nodes: [{ type: 'section', ref: 'hero', children: [{ type: 'h1', ref: 'title' }] }] },
      { op: 'insertNodes', pageId: 'home', nodes: [{ type: 'section', ref: 'faq' }] },
      { op: 'placeComponent', pageId: 'home', definitionId: 'd', ref: 'nav' },
      { op: 'insertNodes', pageId: 'ref:unknown', nodes: [{ type: 'section', ref: 'lost' }] },
    ];
    const created = { pp: 'page-9', hero: 'n1', title: 'n2', faq: 'n3', nav: 'n4', lost: 'n5' };
    expect(refPagesOf(ops, created)).toEqual({ hero: 'page-9', title: 'page-9', faq: 'home', nav: 'home' });
    expect(refPagesOf('nope', created)).toEqual({});
  });
});
