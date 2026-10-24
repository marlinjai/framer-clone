// @vitest-environment node
//
// Dynamic page expansion for sitemap.xml: CMS row ids and product handles,
// paged and capped, read through the injected per-site repositories; a failing
// read leaves only that page out; noindex and non-expandable pages are skipped;
// no commerce tenant means no product URLs (fail closed).

import { describe, expect, it, vi } from 'vitest';
import { normalizeSiteSettings } from '@/lib/site/siteSettings';
import { SITEMAP_LIMITS } from '@/lib/site/siteFiles';
import type { PublishedSite } from '../publicResolver';
import { loadSitemapExpansions, type SitemapRepos } from '../sitemap';

const recordViewTree = (collection: string) => ({
  id: 'r',
  type: 'div',
  props: {},
  children: [{ id: 'rv', type: 'div', props: { 'data-component-kind': 'record-view' }, bindings: { record: { mode: 'read', expression: collection } } }],
});
const productTree = {
  id: 'r',
  type: 'div',
  props: {},
  children: [{ id: 'pd', type: 'div', props: { 'data-component-kind': 'product-detail' }, bindings: { product: { mode: 'read', expression: 'x' } } }],
};

function site(pages: Array<{ pageId: string; slug: string; tree: unknown; noIndex?: boolean }>): PublishedSite {
  return {
    siteId: 's',
    workspaceId: 'ws',
    tenantGroupId: 'tg',
    name: 'S',
    analyticsProjectId: null,
    ingestionEndpoint: null,
    apiKeyRef: null,
    lumitraEnabled: false,
    redirects: [],
    siteSettings: normalizeSiteSettings({}),
    pages: pages.map((p) => ({
      pageId: p.pageId,
      slug: p.slug,
      snapshot: { id: p.pageId, metadata: { title: p.pageId, noIndex: p.noIndex ?? false }, appComponentTree: p.tree } as never,
    })),
  };
}

function repos(over: Partial<SitemapRepos> = {}): SitemapRepos {
  return {
    cmsRepo: {
      listCollections: vi.fn(),
      getCollection: vi.fn(),
      getRow: vi.fn(),
      listRows: vi.fn(async (_id: string, query?: { cursor?: string }) =>
        query?.cursor
          ? { rows: [{ id: 'r3', values: {} }] }
          : { rows: [{ id: 'r1', values: {} }, { id: 'r2', values: {} }], nextCursor: 'next' },
      ),
    } as never,
    commerceRepo: vi.fn(async () => ({
      listProducts: vi.fn(async () => ({ products: [{ handle: 'tee' }, { handle: 'cap' }], total: 2 })),
    })) as never,
    ...over,
  };
}

describe('loadSitemapExpansions', () => {
  it('lists row ids across pages and product handles', async () => {
    const result = await loadSitemapExpansions(
      site([
        { pageId: 'post', slug: 'blog/:id', tree: recordViewTree('col_posts') },
        { pageId: 'product', slug: 'shop/:handle', tree: productTree },
        { pageId: 'about', slug: 'about', tree: recordViewTree('col_posts') },
      ]),
      repos(),
    );
    expect(result.get('post')).toEqual(['r1', 'r2', 'r3']);
    expect(result.get('product')).toEqual(['tee', 'cap']);
    expect(result.has('about')).toBe(false);
  });

  it('skips noindex pages and stops at the per-page cap', async () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ id: `r${i}`, values: {} }));
    const listRows = vi.fn(async () => ({ rows: many, nextCursor: 'more' }));
    const result = await loadSitemapExpansions(
      site([
        { pageId: 'post', slug: 'blog/:id', tree: recordViewTree('c') },
        { pageId: 'hidden', slug: 'h/:id', tree: recordViewTree('c'), noIndex: true },
      ]),
      repos({ cmsRepo: { listRows } as never }),
    );
    expect(result.get('post')).toHaveLength(SITEMAP_LIMITS.perDynamicPage);
    expect(result.has('hidden')).toBe(false);
  });

  it('leaves out a page whose read fails, and product pages without a commerce tenant', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await loadSitemapExpansions(
      site([
        { pageId: 'post', slug: 'blog/:id', tree: recordViewTree('c') },
        { pageId: 'product', slug: 'shop/:handle', tree: productTree },
      ]),
      repos({
        cmsRepo: { listRows: vi.fn(async () => { throw new Error('cms down'); }) } as never,
        commerceRepo: vi.fn(async () => undefined),
      }),
    );
    expect(result.size).toBe(0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
