// @vitest-environment node
//
// src/server/sites/__tests__/cachedResolver.test.ts
//
// MT-17: the ORIGIN render cache. These tests assert the caching CONTRACT around
// the host -> published-site resolution without a real Next incremental cache:
// `next/cache` is mocked with a faithful in-memory implementation that mirrors
// the parts MT-17 depends on — `unstable_cache` keys by its keyParts and
// associates tags, and `revalidateTag` evicts every entry under a tag. The
// Prisma read is a spy, so a cache HIT is asserted by call count.
//
// Coverage:
//   - a second identical request does NOT re-run the DB read (cross-request hit),
//   - revalidateTag('site:<subdomain>') forces the next request to re-read
//     (publish/unpublish invalidation),
//   - two different hosts produce two independent cache entries with NO bleed
//     (tenant-safe by construction: the key includes the subdomain),
//   - a host with no usable subdomain is not cached and never touches the DB.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// A faithful in-memory stand-in for next/cache: keyParts -> value, plus a
// tag -> Set<key> index so revalidateTag can evict. This models exactly the
// behavior MT-17 relies on (key isolation + tag invalidation).
const store = new Map<string, unknown>();
const tagIndex = new Map<string, Set<string>>();

vi.mock('next/cache', () => ({
  unstable_cache: (
    fn: (...args: unknown[]) => Promise<unknown>,
    keyParts: string[],
    opts?: { tags?: string[] },
  ) => {
    const key = JSON.stringify(keyParts);
    return async (...args: unknown[]) => {
      if (store.has(key)) return store.get(key);
      const value = await fn(...args);
      store.set(key, value);
      for (const tag of opts?.tags ?? []) {
        if (!tagIndex.has(tag)) tagIndex.set(tag, new Set());
        tagIndex.get(tag)!.add(key);
      }
      return value;
    };
  },
  revalidateTag: (tag: string) => {
    const keys = tagIndex.get(tag);
    if (!keys) return;
    for (const key of keys) store.delete(key);
    tagIndex.delete(tag);
  },
}));

// The DB seam: a spy-able fake Prisma. 'demo' -> site s1, 'shop' -> site s2.
const findUnique = vi.fn(
  async ({ where }: { where: { subdomain: string } }) => {
    if (where.subdomain === 'demo') return { siteId: 's1' };
    if (where.subdomain === 'shop') return { siteId: 's2' };
    return null;
  },
);
const findFirst = vi.fn(
  async ({ where }: { where: { id: string; status: string } }) => {
    if (where.status !== 'published') return null;
    if (where.id === 's1') {
      return {
        id: 's1',
        workspaceId: 'ws_demo',
        tenantGroupId: 'tg_demo',
        name: 'Demo',
        analyticsProjectId: null,
        ingestionEndpoint: null,
        apiKeyRef: null,
        lumitraEnabled: false,
        pages: [{ pageId: 'p1', slug: '', snapshot: { slug: '' } }],
      };
    }
    if (where.id === 's2') {
      return {
        id: 's2',
        workspaceId: 'ws_shop',
        tenantGroupId: 'tg_shop',
        name: 'Shop',
        analyticsProjectId: null,
        ingestionEndpoint: null,
        apiKeyRef: null,
        lumitraEnabled: false,
        pages: [{ pageId: 'p2', slug: '', snapshot: { slug: '' } }],
      };
    }
    return null;
  },
);

vi.mock('@/server/db', () => ({
  getPrismaClient: () => ({
    siteDomain: { findUnique, findFirst },
    site: { findFirst },
  }),
}));

import {
  getCachedPublishedSite,
  resolveSubdomainForSiteId,
  revalidateSiteCache,
  siteCacheTag,
} from '../cachedResolver';

const ORIGINAL_BASE_HOST = process.env.PUBLIC_SITE_BASE_HOST;

beforeEach(() => {
  store.clear();
  tagIndex.clear();
  findUnique.mockClear();
  findFirst.mockClear();
  process.env.PUBLIC_SITE_BASE_HOST = 'lumitra.site';
});

afterEach(() => {
  if (ORIGINAL_BASE_HOST === undefined) delete process.env.PUBLIC_SITE_BASE_HOST;
  else process.env.PUBLIC_SITE_BASE_HOST = ORIGINAL_BASE_HOST;
});

describe('getCachedPublishedSite', () => {
  it('serves a second identical request from cache (no second DB read)', async () => {
    const first = await getCachedPublishedSite('demo.lumitra.site');
    const second = await getCachedPublishedSite('demo.lumitra.site');

    expect(first?.siteId).toBe('s1');
    expect(second?.siteId).toBe('s1');
    // The published-site read ran exactly once across both requests.
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('re-reads after the site tag is revalidated (publish/unpublish invalidation)', async () => {
    await getCachedPublishedSite('demo.lumitra.site');
    expect(findFirst).toHaveBeenCalledTimes(1);

    // A second hit is cached...
    await getCachedPublishedSite('demo.lumitra.site');
    expect(findFirst).toHaveBeenCalledTimes(1);

    // ...until a (re)publish/unpublish invalidates the host's tag.
    revalidateSiteCache('demo');
    await getCachedPublishedSite('demo.lumitra.site');
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it('keys per host: two subdomains get two entries with no cross-tenant bleed', async () => {
    const demo = await getCachedPublishedSite('demo.lumitra.site');
    const shop = await getCachedPublishedSite('shop.lumitra.site');

    expect(demo?.siteId).toBe('s1');
    expect(demo?.workspaceId).toBe('ws_demo');
    expect(shop?.siteId).toBe('s2');
    expect(shop?.workspaceId).toBe('ws_shop');

    // Each host resolved independently (no shared entry).
    expect(findFirst).toHaveBeenCalledTimes(2);

    // Invalidating ONE host leaves the other's cache entry intact.
    revalidateSiteCache('demo');
    await getCachedPublishedSite('demo.lumitra.site'); // re-reads
    await getCachedPublishedSite('shop.lumitra.site'); // still cached
    expect(findFirst).toHaveBeenCalledTimes(3);

    // The re-served entries still carry the correct, un-swapped tenants.
    expect((await getCachedPublishedSite('demo.lumitra.site'))?.workspaceId).toBe('ws_demo');
    expect((await getCachedPublishedSite('shop.lumitra.site'))?.workspaceId).toBe('ws_shop');
  });

  it('does not cache or hit the DB for a host with no usable subdomain', async () => {
    const result = await getCachedPublishedSite('lumitra.site');
    expect(result).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe('siteCacheTag', () => {
  it('namespaces the tag by subdomain', () => {
    expect(siteCacheTag('demo')).toBe('site:demo');
  });
});

describe('resolveSubdomainForSiteId', () => {
  it('returns the surviving subdomain for a site id (for unpublish revalidation)', async () => {
    const prisma = {
      siteDomain: {
        findFirst: vi.fn().mockResolvedValue({ subdomain: 'demo-abc123' }),
      },
    } as never;
    expect(await resolveSubdomainForSiteId('s1', prisma)).toBe('demo-abc123');
  });

  it('returns null when the site has no allocated subdomain', async () => {
    const prisma = {
      siteDomain: { findFirst: vi.fn().mockResolvedValue(null) },
    } as never;
    expect(await resolveSubdomainForSiteId('s1', prisma)).toBeNull();
  });
});
