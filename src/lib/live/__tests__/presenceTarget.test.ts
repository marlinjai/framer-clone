// The presence frame's target (src/lib/live/presenceTarget.ts): the section
// containing the call's nodes, the page when it names no node, nothing when
// its nodes are gone.

import { describe, expect, it } from 'vitest';
import { presencePageId, presencePagesOf, presenceTarget, sectionOf, type PresencePage, type PresenceTreeNode } from '../presenceTarget';

const node = (id: string, children: PresenceTreeNode[] = []): PresenceTreeNode => ({ id, children });

const home: PresencePage = {
  id: 'home',
  appComponentTree: node('root', [
    node('hero', [node('hero-title'), node('hero-text', [node('hero-link')])]),
    node('pricing', [node('plan-a'), node('plan-b')]),
    node('footer'),
  ]),
};
const about: PresencePage = { id: 'about', appComponentTree: node('about-root', [node('team', [node('person')])]) };

describe('sectionOf', () => {
  it('is the top-level child holding a node, at any depth', () => {
    expect(sectionOf(home.appComponentTree, ['hero-link'])).toBe('hero');
    expect(sectionOf(home.appComponentTree, ['pricing'])).toBe('pricing');
  });

  it('frames the first section in document order when a call touches several', () => {
    expect(sectionOf(home.appComponentTree, ['plan-b', 'hero-title', 'footer'])).toBe('hero');
  });

  it('is nothing for the root itself, unknown ids, or none', () => {
    expect(sectionOf(home.appComponentTree, ['root'])).toBeUndefined();
    expect(sectionOf(home.appComponentTree, ['nope'])).toBeUndefined();
    expect(sectionOf(home.appComponentTree, [])).toBeUndefined();
  });
});

describe('presenceTarget', () => {
  it('frames the section, on the page named or the page that holds the nodes', () => {
    expect(presenceTarget([home, about], { pageId: 'home', nodeIds: ['plan-a'] })).toEqual({ kind: 'section', pageId: 'home', sectionId: 'pricing' });
    expect(presenceTarget([home, about], { nodeIds: ['person'] })).toEqual({ kind: 'section', pageId: 'about', sectionId: 'team' });
    // A stale page id does not hide nodes that live elsewhere.
    expect(presenceTarget([home, about], { pageId: 'about', nodeIds: ['hero-title'] })).toEqual({ kind: 'section', pageId: 'home', sectionId: 'hero' });
  });

  it('frames the page for a call that names a page and no node, or only its root', () => {
    expect(presenceTarget([home, about], { pageId: 'about', nodeIds: [] })).toEqual({ kind: 'page', pageId: 'about' });
    expect(presenceTarget([home, about], { pageId: 'home', nodeIds: ['root'] })).toEqual({ kind: 'page', pageId: 'home' });
  });

  it('frames nothing when every node it named is gone, even with a page', () => {
    expect(presenceTarget([home, about], { pageId: 'home', nodeIds: ['deleted-1', 'deleted-2'] })).toBeUndefined();
    expect(presenceTarget([home], { pageId: 'gone', nodeIds: [] })).toBeUndefined();
    expect(presenceTarget([home], { nodeIds: [] })).toBeUndefined();
  });

  it('keeps framing while one of its nodes still exists', () => {
    expect(presenceTarget([home], { nodeIds: ['deleted', 'footer'] })).toEqual({ kind: 'section', pageId: 'home', sectionId: 'footer' });
  });

  it('names the page for the Pages panel dot', () => {
    expect(presencePageId([home, about], { nodeIds: ['person'] })).toBe('about');
    expect(presencePageId([home, about], { nodeIds: ['gone'] })).toBeUndefined();
  });
});

describe('floating elements and component definitions', () => {
  const withFloating: PresencePage = { ...home, floatingElements: [node('modal', [node('modal-title')])] };

  it('frames a floating element holding the node, and a deleted node still frames nothing', () => {
    expect(presenceTarget([withFloating], { nodeIds: ['modal-title'] })).toEqual({ kind: 'section', pageId: 'home', sectionId: 'modal' });
    expect(presenceTarget([withFloating], { nodeIds: ['modal'] })).toEqual({ kind: 'section', pageId: 'home', sectionId: 'modal' });
    expect(presenceTarget([withFloating], { nodeIds: ['gone'] })).toBeUndefined();
    expect(presencePageId([withFloating], { nodeIds: ['modal-title'] })).toBe('home');
  });

  it('prefers the page tree when the node is there', () => {
    expect(presenceTarget([withFloating], { nodeIds: ['plan-a'] })).toEqual({ kind: 'section', pageId: 'home', sectionId: 'pricing' });
  });

  it('searches the pages of component definitions as well as the pages', () => {
    const definition: PresencePage = { id: 'card-def', appComponentTree: node('card-root', [node('card-body', [node('card-title')])]) };
    const pages = presencePagesOf({ pages: new Map([['home', home]]), components: new Map([['card', { page: definition }]]) });
    expect(pages.map((p) => p.id)).toEqual(['home', 'card-def']);
    expect(presenceTarget(pages, { nodeIds: ['card-title'] })).toEqual({ kind: 'section', pageId: 'card-def', sectionId: 'card-body' });
    expect(presencePagesOf({ pages: new Map([['home', home]]) })).toEqual([home]);
    expect(presencePagesOf(undefined)).toEqual([]);
  });
});
