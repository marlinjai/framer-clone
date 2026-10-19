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
//   - a host with no usable subdomain is not cached and never touches the DB,
//   - a MISS is never written to unstable_cache: it is remembered in the bounded
//     in-process negative cache for NEGATIVE_CACHE_TTL_MS, so a site that
//     appears out of band (seed, restore) resolves once the TTL lapses, and
//     revalidateSiteCache clears a remembered miss immediately,
//   - a malformed label never reaches the DB or either cache,
//   - the negative cache is bounded (a flood of random labels cannot grow it).

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
// `domains` is mutable so a test can make a site APPEAR out of band (the way the
// seed script or a restore writes rows without the publish route).
const BASE_DOMAINS: Record<string, string> = { demo: 's1', shop: 's2' };
let domains: Record<string, string> = { ...BASE_DOMAINS };
const findUnique = vi.fn(
  async ({ where }: { where: { subdomain: string } }) => {
    const siteId = domains[where.subdomain];
    return siteId ? { siteId } : null;
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
  NEGATIVE_CACHE_MAX_ENTRIES,
  NEGATIVE_CACHE_TTL_MS,
  clearSiteMissCache,
  getCachedPublishedSite,
  resolveSubdomainForSiteId,
  revalidateSiteCache,
  siteCacheTag,
  siteMissCacheSize,
} from '../cachedResolver';

const ORIGINAL_BASE_HOST = process.env.PUBLIC_SITE_BASE_HOST;

beforeEach(() => {
  store.clear();
  tagIndex.clear();
  clearSiteMissCache();
  domains = { ...BASE_DOMAINS };
  findUnique.mockClear();
  findFirst.mockClear();
  process.env.PUBLIC_SITE_BASE_HOST = 'lumitra.site';
});

afterEach(() => {
  vi.useRealTimers();
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

describe('getCachedPublishedSite: misses are never cached forever', () => {
  it('does not write a miss to unstable_cache', async () => {
    expect(await getCachedPublishedSite('nosuchsite1.lumitra.site')).toBeNull();
    expect(store.size).toBe(0);
    expect(tagIndex.size).toBe(0);
    expect(siteMissCacheSize()).toBe(1);
  });

  it('serves a site that appears out of band once the miss TTL lapses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T12:00:00Z'));

    // The label 404s before its site exists: one indexed lookup.
    expect(await getCachedPublishedSite('fresh123.lumitra.site')).toBeNull();
    expect(findUnique).toHaveBeenCalledTimes(1);

    // A seed script writes the rows WITHOUT calling the publish route.
    domains.fresh123 = 's1';

    // Within the TTL the remembered miss is served: no second DB read.
    vi.advanceTimersByTime(NEGATIVE_CACHE_TTL_MS - 1);
    expect(await getCachedPublishedSite('fresh123.lumitra.site')).toBeNull();
    expect(findUnique).toHaveBeenCalledTimes(1);

    // Once the TTL lapses the site resolves...
    vi.advanceTimersByTime(1);
    const site = await getCachedPublishedSite('fresh123.lumitra.site');
    expect(site?.siteId).toBe('s1');
    expect(findUnique).toHaveBeenCalledTimes(2);
    expect(siteMissCacheSize()).toBe(0);

    // ...and from then on is a normal cached hit.
    await getCachedPublishedSite('fresh123.lumitra.site');
    expect(findUnique).toHaveBeenCalledTimes(2);
    expect(store.size).toBe(1);
  });

  it('revalidateSiteCache clears a remembered miss immediately (publish stays instant)', async () => {
    expect(await getCachedPublishedSite('justpub1.lumitra.site')).toBeNull();
    domains.justpub1 = 's2';

    revalidateSiteCache('justpub1');
    const site = await getCachedPublishedSite('justpub1.lumitra.site');
    expect(site?.siteId).toBe('s2');
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('treats a mapped but unpublished site as a miss (not cached)', async () => {
    domains.draftsite = 's_draft';
    expect(await getCachedPublishedSite('draftsite.lumitra.site')).toBeNull();
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(0);
  });

  it('still serves hits from cache until revalidateSiteCache, past the miss TTL', async () => {
    vi.useFakeTimers();
    await getCachedPublishedSite('demo.lumitra.site');
    vi.advanceTimersByTime(NEGATIVE_CACHE_TTL_MS * 10);
    await getCachedPublishedSite('demo.lumitra.site');
    expect(findFirst).toHaveBeenCalledTimes(1);

    revalidateSiteCache('demo');
    await getCachedPublishedSite('demo.lumitra.site');
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it('resolves a site on a reserved label (the hosted demo runs as `app`)', async () => {
    domains.app = 's1';
    expect((await getCachedPublishedSite('app.lumitra.site'))?.siteId).toBe('s1');
  });

  it('propagates a real database error and does not remember it as a miss', async () => {
    findUnique.mockRejectedValueOnce(new Error('connection refused'));
    await expect(getCachedPublishedSite('demo.lumitra.site')).rejects.toThrow(
      'connection refused',
    );
    expect(siteMissCacheSize()).toBe(0);
    expect(store.size).toBe(0);

    // The next request retries the DB and succeeds.
    expect((await getCachedPublishedSite('demo.lumitra.site'))?.siteId).toBe('s1');
  });
});

describe('getCachedPublishedSite: invalid labels', () => {
  it.each([
    ['an underscore', 'bad_label.lumitra.site'],
    ['a leading hyphen', '-lead.lumitra.site'],
    ['a trailing hyphen', 'trail-.lumitra.site'],
    ['more than 63 characters', `${'a'.repeat(64)}.lumitra.site`],
    ['a non-ASCII character', 'bücher.lumitra.site'],
  ])('a label with %s never reaches the DB or either cache', async (_why, host) => {
    expect(await getCachedPublishedSite(host)).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
    expect(siteMissCacheSize()).toBe(0);
  });
});

describe('getCachedPublishedSite: bounded under a flood of random labels', () => {
  it('caps the negative cache and evicts the oldest label first', async () => {
    const flood = NEGATIVE_CACHE_MAX_ENTRIES + 25;
    for (let i = 0; i < flood; i += 1) {
      await getCachedPublishedSite(`rnd${i}.lumitra.site`);
    }
    expect(siteMissCacheSize()).toBe(NEGATIVE_CACHE_MAX_ENTRIES);
    expect(store.size).toBe(0);
    expect(findUnique).toHaveBeenCalledTimes(flood);

    // The newest label is still remembered (no DB read)...
    await getCachedPublishedSite(`rnd${flood - 1}.lumitra.site`);
    expect(findUnique).toHaveBeenCalledTimes(flood);

    // ...while the oldest was evicted and costs one fresh indexed lookup.
    await getCachedPublishedSite('rnd0.lumitra.site');
    expect(findUnique).toHaveBeenCalledTimes(flood + 1);
    expect(siteMissCacheSize()).toBe(NEGATIVE_CACHE_MAX_ENTRIES);
  });
});

describe('getCachedPublishedSite: shared state and coalescing', () => {
  it('shares the miss map across module instances (publish route and page bundles)', async () => {
    expect(await getCachedPublishedSite('sharedmiss.lumitra.site')).toBeNull();
    expect(findUnique).toHaveBeenCalledTimes(1);

    // A second, independently evaluated copy of the module (as a separately
    // bundled route handler would load it) sees the same remembered miss...
    vi.resetModules();
    const other = await import('../cachedResolver');
    // Genuinely a different module instance, not the cached one.
    expect(other.getCachedPublishedSite).not.toBe(getCachedPublishedSite);
    expect(other.siteMissCacheSize()).toBe(1);
    expect(await other.getCachedPublishedSite('sharedmiss.lumitra.site')).toBeNull();
    expect(findUnique).toHaveBeenCalledTimes(1);

    // ...and a revalidate through that copy clears it for this one.
    domains.sharedmiss = 's1';
    other.revalidateSiteCache('sharedmiss');
    expect((await getCachedPublishedSite('sharedmiss.lumitra.site'))?.siteId).toBe('s1');
  });

  it('coalesces N concurrent requests for one unknown label into one lookup', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    findUnique.mockImplementationOnce(async () => {
      await gate;
      return null;
    });

    const N = 25;
    const requests = Array.from({ length: N }, () =>
      getCachedPublishedSite('burstlabel.lumitra.site'),
    );
    release();
    const results = await Promise.all(requests);

    expect(results).toEqual(Array(N).fill(null));
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(siteMissCacheSize()).toBe(1);

    // The in-flight entry was cleared on settle: after the TTL a new lookup runs.
    clearSiteMissCache();
    await getCachedPublishedSite('burstlabel.lumitra.site');
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('does not remember a stale miss when a publish revalidates the label mid-lookup', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    findUnique.mockImplementationOnce(async () => {
      await gate;
      return null;
    });

    const stale = getCachedPublishedSite('racelabel.lumitra.site');
    // The publish lands while the lookup is still running.
    domains.racelabel = 's2';
    revalidateSiteCache('racelabel');
    release();
    expect(await stale).toBeNull();

    expect(siteMissCacheSize()).toBe(0);
    expect((await getCachedPublishedSite('racelabel.lumitra.site'))?.siteId).toBe('s2');
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
