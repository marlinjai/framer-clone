import { describe, expect, it } from 'vitest';
import type { PublishedPageRow } from '@/server/sites/publicResolver';
import { normalizeSiteSettings } from '../siteSettings';
import {
  SITEMAP_LIMITS,
  buildRobotsTxt,
  buildSitemapXml,
  buildWebManifest,
  dynamicPagePlan,
  sitemapEntries,
} from '../siteFiles';

function page(pageId: string, slug: string, extra: Record<string, unknown> = {}, tree?: unknown): PublishedPageRow {
  return {
    pageId,
    slug,
    snapshot: {
      id: pageId,
      slug,
      metadata: { title: pageId, ...extra },
      updatedAt: Date.UTC(2026, 9, 20, 12),
      appComponentTree: tree ?? { id: 'r', type: 'div', props: {}, children: [] },
    } as never,
  };
}

describe('robots.txt', () => {
  it('allows everything and points at the sitemap on the primary host', () => {
    expect(buildRobotsTxt('www.mueller.de')).toBe('User-agent: *\nAllow: /\n\nSitemap: https://www.mueller.de/sitemap.xml\n');
    expect(buildRobotsTxt(null)).toBe('User-agent: *\nAllow: /\n');
  });
});

describe('sitemap entries', () => {
  const settings = normalizeSiteSettings({ notFoundPageId: 'oops' });

  it('lists static pages with lastmod, minus noindex pages and the 404 page', () => {
    const entries = sitemapEntries(
      [page('home', ''), page('about', 'about'), page('hidden', 'hidden', { noIndex: true }), page('oops', 'oops')],
      settings,
      'www.mueller.de',
    );
    expect(entries).toEqual([
      { loc: 'https://www.mueller.de/', lastmod: '2026-10-20T12:00:00.000Z' },
      { loc: 'https://www.mueller.de/about', lastmod: '2026-10-20T12:00:00.000Z' },
    ]);
  });

  it('expands a dynamic page from the supplied values, and leaves it out without any', () => {
    const pages = [page('post', 'blog/:id'), page('product', 'shop/:handle')];
    const entries = sitemapEntries(pages, settings, 'x.de', new Map([['post', ['1', 'a b']]]));
    expect(entries.map((e) => e.loc)).toEqual(['https://x.de/blog/1', 'https://x.de/blog/a%20b']);
  });

  it('is capped per dynamic page and in total', () => {
    const many = Array.from({ length: SITEMAP_LIMITS.total + 50 }, (_, i) => String(i));
    const entries = sitemapEntries(
      [page('a', 'a/:id'), page('b', 'b/:id'), page('c', 'c/:id'), page('d', 'd/:id'), page('e', 'e/:id'), page('f', 'f/:id')],
      settings,
      'x.de',
      new Map(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => [id, many])),
    );
    expect(entries).toHaveLength(SITEMAP_LIMITS.total);
    expect(entries.filter((e) => e.loc.startsWith('https://x.de/a/'))).toHaveLength(SITEMAP_LIMITS.perDynamicPage);
  });

  it('is empty without a primary host', () => {
    expect(sitemapEntries([page('home', '')], settings, null)).toEqual([]);
  });

  it('escapes XML', () => {
    const xml = buildSitemapXml([{ loc: 'https://x.de/a?b=1&c=<2>' }]);
    expect(xml).toContain('<loc>https://x.de/a?b=1&amp;c=&lt;2&gt;</loc>');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });
});

describe('dynamicPagePlan', () => {
  const recordView = (expression: string) => ({
    id: 'r',
    type: 'div',
    children: [
      { id: 'rv', type: 'div', props: { 'data-component-kind': 'record-view' }, bindings: { record: { mode: 'read', expression } } },
    ],
  });

  it('lists CMS rows for a :id record view bound to a literal collection', () => {
    expect(dynamicPagePlan(page('p', 'blog/:id', {}, recordView('col_posts')))).toEqual({
      kind: 'cms-rows',
      param: 'id',
      collectionId: 'col_posts',
    });
  });

  it('refuses an expression binding, a wrong param name, or more than one dynamic segment', () => {
    expect(dynamicPagePlan(page('p', 'blog/:id', {}, recordView('{{page.params.c}}')))).toBeNull();
    expect(dynamicPagePlan(page('p', 'blog/:slug', {}, recordView('col_posts')))).toBeNull();
    expect(dynamicPagePlan(page('p', ':cat/:id', {}, recordView('col_posts')))).toBeNull();
    expect(dynamicPagePlan(page('p', 'about', {}, recordView('col_posts')))).toBeNull();
  });

  it('lists products for a bound :handle product detail page', () => {
    const tree = {
      id: 'r',
      type: 'div',
      children: [{ id: 'pd', type: 'div', props: { 'data-component-kind': 'product-detail' }, bindings: { product: { mode: 'read', expression: 'commerce' } } }],
    };
    expect(dynamicPagePlan(page('p', 'shop/:handle', {}, tree))).toEqual({ kind: 'commerce-products', param: 'handle' });
  });

  it('leaves out a page with no detail node', () => {
    expect(dynamicPagePlan(page('p', 'shop/:handle'))).toBeNull();
  });
});

describe('web manifest', () => {
  it('carries the name, language and an https icon', () => {
    expect(buildWebManifest(normalizeSiteSettings({ language: 'de', faviconUrl: 'https://x.de/i.png' }), 'Bäckerei Müller')).toEqual({
      name: 'Bäckerei Müller',
      short_name: 'Bäckerei Mül',
      lang: 'de',
      start_url: '/',
      display: 'browser',
      icons: [{ src: 'https://x.de/i.png', sizes: 'any' }],
    });
    expect(buildWebManifest(normalizeSiteSettings({ faviconUrl: 'http://x.de/i.png' }), '').icons).toBeUndefined();
  });
});
