import { describe, it, expect } from 'vitest';
import {
  MAX_SITE_REDIRECTS,
  findRedirectTarget,
  nextSiteRedirects,
  parseSiteRedirects,
  type SiteRedirect,
} from '../redirects';

const NOW = new Date('2026-10-21T10:00:00.000Z');

function step(
  previous: SiteRedirect[],
  stored: Record<string, string>,
  pages: Array<[string, string]>,
  everPublished = true,
): SiteRedirect[] {
  return nextSiteRedirects({
    previous,
    storedSlugs: new Map(Object.entries(stored)),
    pages: pages.map(([pageId, slug]) => ({ pageId, slug })),
    everPublished,
    now: NOW,
  });
}

describe('nextSiteRedirects', () => {
  it('records the old path when a published page changes its slug', () => {
    const out = step([], { home: '', p1: 'about' }, [['home', ''], ['p1', 'about-us']]);
    expect(out).toEqual([{ from: 'about', pageId: 'p1', createdAt: NOW.toISOString() }]);
  });

  it('records nothing for a site that was never published', () => {
    expect(step([], { p1: 'about' }, [['p1', 'about-us']], false)).toEqual([]);
  });

  it('records nothing for a new page or an unchanged slug', () => {
    expect(step([], { p1: 'about' }, [['p1', 'about'], ['p2', 'new']])).toEqual([]);
  });

  it('records nothing when only the letter case changed (same path)', () => {
    expect(step([], { p1: 'About' }, [['p1', 'about']])).toEqual([]);
  });

  it('does not redirect from a dynamic pattern', () => {
    expect(step([], { p1: 'products/:handle' }, [['p1', 'shop']])).toEqual([]);
  });

  it('does not record a redirect when the page moves to a dynamic slug', () => {
    expect(step([], { p1: 'products' }, [['p1', 'products/:handle']])).toEqual([]);
  });

  it('never chains: both old paths lead to the page wherever it lives now', () => {
    const first = step([], { p1: 'a' }, [['p1', 'b']]);
    const second = step(first, { p1: 'b' }, [['p1', 'c']]);
    expect(second.map((r) => r.from)).toEqual(['a', 'b']);
    const pages = [{ pageId: 'p1', slug: 'c' }];
    expect(findRedirectTarget(second, pages, ['a'])).toBe('/c');
    expect(findRedirectTarget(second, pages, ['b'])).toBe('/c');
  });

  it('refuses a loop: renaming back drops the redirect from the reclaimed path', () => {
    const first = step([], { p1: 'a' }, [['p1', 'b']]);
    const back = step(first, { p1: 'b' }, [['p1', 'a']]);
    expect(back).toEqual([{ from: 'b', pageId: 'p1', createdAt: NOW.toISOString() }]);
  });

  it('lets a page win: a page that takes over an old path removes its redirect', () => {
    const first = step([], { p1: 'about' }, [['p1', 'about-us']]);
    const claimed = step(first, { p1: 'about-us' }, [['p1', 'about-us'], ['p2', 'about']]);
    expect(claimed).toEqual([]);
  });

  it('drops redirects whose page was deleted', () => {
    const first = step([], { p1: 'about' }, [['p1', 'about-us'], ['p2', 'x']]);
    expect(step(first, { p1: 'about-us', p2: 'x' }, [['p2', 'x']])).toEqual([]);
  });

  it('replaces an older entry for the same old path', () => {
    const first = step([], { p1: 'a' }, [['p1', 'b'], ['p2', 'z']]);
    // p1 leaves `b`, p2 takes `a`... then p2 moves away from `a` again.
    const second = step(first, { p1: 'b', p2: 'z' }, [['p1', 'b'], ['p2', 'a']]);
    const third = step(second, { p1: 'b', p2: 'a' }, [['p1', 'b'], ['p2', 'y']]);
    expect(third.filter((r) => r.from === 'a')).toEqual([{ from: 'a', pageId: 'p2', createdAt: NOW.toISOString() }]);
  });

  it(`keeps at most ${MAX_SITE_REDIRECTS}, dropping the oldest`, () => {
    const previous: SiteRedirect[] = Array.from({ length: MAX_SITE_REDIRECTS }, (_, i) => ({
      from: `old-${i}`,
      pageId: 'p1',
      createdAt: NOW.toISOString(),
    }));
    const out = step(previous, { p1: 'current' }, [['p1', 'newest']]);
    expect(out).toHaveLength(MAX_SITE_REDIRECTS);
    expect(out[0].from).toBe('old-1');
    expect(out[out.length - 1].from).toBe('current');
  });
});

describe('findRedirectTarget', () => {
  const redirects: SiteRedirect[] = [
    { from: 'about', pageId: 'p1', createdAt: '' },
    { from: 'gone', pageId: 'deleted', createdAt: '' },
    { from: 'dyn', pageId: 'p2', createdAt: '' },
  ];
  const pages = [
    { pageId: 'p1', slug: 'about-us' },
    { pageId: 'p2', slug: 'products/:handle' },
  ];

  it('sends an old path to the page it belongs to, case-insensitively', () => {
    expect(findRedirectTarget(redirects, pages, ['about'])).toBe('/about-us');
    expect(findRedirectTarget(redirects, pages, ['About'])).toBe('/about-us');
  });

  it('returns null for an unknown path, the root, a deleted page or a dynamic target', () => {
    expect(findRedirectTarget(redirects, pages, ['nope'])).toBeNull();
    expect(findRedirectTarget(redirects, pages, [])).toBeNull();
    expect(findRedirectTarget(redirects, pages, ['gone'])).toBeNull();
    expect(findRedirectTarget(redirects, pages, ['dyn'])).toBeNull();
  });

  it('never redirects a path to itself', () => {
    expect(findRedirectTarget([{ from: 'x', pageId: 'p', createdAt: '' }], [{ pageId: 'p', slug: 'x' }], ['x'])).toBeNull();
  });
});

describe('parseSiteRedirects', () => {
  it('keeps well-formed entries and ignores everything else', () => {
    expect(parseSiteRedirects(null)).toEqual([]);
    expect(parseSiteRedirects({ from: 'a' })).toEqual([]);
    expect(
      parseSiteRedirects([
        { from: 'a', pageId: 'p', createdAt: 't' },
        { from: '', pageId: 'p' },
        { from: 'b' },
        'junk',
        { from: 'c', pageId: 'q' },
      ]),
    ).toEqual([
      { from: 'a', pageId: 'p', createdAt: 't' },
      { from: 'c', pageId: 'q', createdAt: '' },
    ]);
  });
});

describe('redirect targets are always on-site', () => {
  const r = (pageId: string): SiteRedirect[] => [{ from: 'old', pageId, createdAt: '' }];

  it('never produces a protocol-relative address from a legacy slug', () => {
    expect(findRedirectTarget(r('p'), [{ pageId: 'p', slug: '/evil.com' }], ['old'])).toBe('/evil.com');
    expect(findRedirectTarget(r('p'), [{ pageId: 'p', slug: '//evil.com/x' }], ['old'])).toBe('/evil.com/x');
  });

  it('percent-encodes each segment, so a backslash cannot act as a slash', () => {
    expect(findRedirectTarget(r('p'), [{ pageId: 'p', slug: '\\evil.com' }], ['old'])).toBe('/%5Cevil.com');
  });

  it('refuses dot segments', () => {
    expect(findRedirectTarget(r('p'), [{ pageId: 'p', slug: 'a/../b' }], ['old'])).toBeNull();
  });

  it('sends the old path of a page that became the home page to the root', () => {
    const list = step([], { p1: 'about' }, [['p1', '']]);
    expect(list).toEqual([{ from: 'about', pageId: 'p1', createdAt: NOW.toISOString() }]);
    expect(findRedirectTarget(list, [{ pageId: 'p1', slug: '' }], ['about'])).toBe('/');
  });

  it('on a home page change, sends the new home page old path to the root and records nothing for the root', () => {
    // "About" becomes the home page; the former home page moves to /home-page.
    const pages: Array<[string, string]> = [['home', 'home-page'], ['about', '']];
    const list = step([], { home: '', about: 'about' }, pages);
    expect(list).toEqual([{ from: 'about', pageId: 'about', createdAt: NOW.toISOString() }]);
    const live = pages.map(([pageId, slug]) => ({ pageId, slug }));
    expect(findRedirectTarget(list, live, ['about'])).toBe('/');
    expect(findRedirectTarget(list, live, ['home-page'])).toBeNull();
    // Never published: no old links to keep.
    expect(step([], { home: '', about: 'about' }, pages, false)).toEqual([]);
  });

  it('changing the home page back drops the redirect, because the page owns its path again', () => {
    const first = step([], { home: '', about: 'about' }, [['home', 'home-page'], ['about', '']]);
    const back = step(first, { home: 'home-page', about: '' }, [['home', ''], ['about', 'about']]);
    expect(back).toEqual([{ from: 'home-page', pageId: 'home', createdAt: NOW.toISOString() }]);
    expect(findRedirectTarget(back, [{ pageId: 'home', slug: '' }, { pageId: 'about', slug: 'about' }], ['about'])).toBeNull();
  });
});
