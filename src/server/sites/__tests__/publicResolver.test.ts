// publicResolver: host -> published site, slug matching, ingestion-key resolution.
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  parseSubdomain,
  resolvePublishedSite,
  matchPageBySlug,
  resolvePublicIngestionKey,
  resolveTrackerScriptSrc,
  resolveIngestionEndpoint,
  resolveAnalyticsProjectId,
  HOME_REWRITE_SENTINEL,
  type PublishedPageRow,
} from '../publicResolver';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ANALYTICS_PUBLIC_INGESTION_KEY;
  delete process.env.AP_KEY_REF_X;
  delete process.env.ANALYTICS_TRACKER_SCRIPT_URL;
  delete process.env.ANALYTICS_INGESTION_ENDPOINT;
  delete process.env.ANALYTICS_PROJECT_ID;
});

describe('parseSubdomain', () => {
  it('extracts the leftmost label against a configured base host', () => {
    expect(parseSubdomain('demo.lumitra.site', 'lumitra.site')).toBe('demo');
    expect(parseSubdomain('demo.lumitra.site:3000', 'lumitra.site')).toBe('demo');
  });

  it('returns null for the bare base host or www', () => {
    expect(parseSubdomain('lumitra.site', 'lumitra.site')).toBeNull();
    expect(parseSubdomain('www.lumitra.site', 'lumitra.site')).toBeNull();
  });

  it('returns null when the host is not under the base host', () => {
    expect(parseSubdomain('demo.example.com', 'lumitra.site')).toBeNull();
  });

  it('unconfigured: takes the first label only for >=3-label hosts', () => {
    expect(parseSubdomain('demo.example.com', null)).toBe('demo');
    expect(parseSubdomain('example.com', null)).toBeNull();
    expect(parseSubdomain('localhost', null)).toBeNull();
    expect(parseSubdomain('localhost:3000', null)).toBeNull();
  });

  it('returns null for empty / missing host', () => {
    expect(parseSubdomain(null)).toBeNull();
    expect(parseSubdomain('')).toBeNull();
  });
});

/** A fake PrismaClient: 'demo' -> published site s1; 'draft' -> non-published s2. */
function fakePrisma(): PrismaClient {
  const pages: PublishedPageRow[] = [
    { pageId: 'p1', slug: 'about', snapshot: { slug: 'about' } as never },
  ];
  return {
    siteDomain: {
      findUnique: async ({ where }: { where: { subdomain: string } }) => {
        if (where.subdomain === 'demo') return { siteId: 's1' };
        if (where.subdomain === 'draft') return { siteId: 's2' };
        return null;
      },
    },
    site: {
      findFirst: async ({ where }: { where: { id: string; status: string } }) => {
        // Only s1 is published; the where-clause pins status: 'published'.
        if (where.id === 's1' && where.status === 'published') {
          return {
            id: 's1',
            name: 'Demo',
            analyticsProjectId: 'proj_1',
            ingestionEndpoint: 'https://ingest',
            apiKeyRef: 'AP_KEY_REF_X',
            lumitraEnabled: true,
            pages,
          };
        }
        return null;
      },
    },
  } as unknown as PrismaClient;
}

describe('resolvePublishedSite', () => {
  it('resolves a published site by subdomain', async () => {
    const site = await resolvePublishedSite('demo.lumitra.site', fakePrisma(), 'lumitra.site');
    expect(site).not.toBeNull();
    expect(site!.siteId).toBe('s1');
    expect(site!.lumitraEnabled).toBe(true);
    expect(site!.pages).toHaveLength(1);
  });

  it('returns null for an unknown subdomain', async () => {
    const site = await resolvePublishedSite('nope.lumitra.site', fakePrisma(), 'lumitra.site');
    expect(site).toBeNull();
  });

  it('returns null for a non-published (draft) site', async () => {
    const site = await resolvePublishedSite('draft.lumitra.site', fakePrisma(), 'lumitra.site');
    expect(site).toBeNull();
  });

  it('returns null when the host has no usable subdomain', async () => {
    const site = await resolvePublishedSite('lumitra.site', fakePrisma(), 'lumitra.site');
    expect(site).toBeNull();
  });
});

function pages(slugs: string[]): PublishedPageRow[] {
  return slugs.map((slug, i) => ({
    pageId: `p${i}`,
    slug,
    snapshot: { slug } as never,
  }));
}

describe('matchPageBySlug', () => {
  it('matches an exact static slug', () => {
    const m = matchPageBySlug(pages(['about', 'contact']), ['about']);
    expect(m?.page.slug).toBe('about');
    expect(m?.params).toEqual({});
  });

  it('resolves the home page for an empty request path', () => {
    const m = matchPageBySlug(pages(['', 'about']), []);
    expect(m?.page.slug).toBe('');
  });

  it('resolves the SAME home page for the home rewrite sentinel as for empty segments', () => {
    const ps = pages(['', 'about']);
    const fromEmpty = matchPageBySlug(ps, []);
    const fromSentinel = matchPageBySlug(ps, [HOME_REWRITE_SENTINEL]);
    expect(fromSentinel?.page.slug).toBe('');
    expect(fromSentinel?.page.slug).toBe(fromEmpty?.page.slug);
    expect(fromSentinel?.params).toEqual({});
  });

  it('resolves a "home" alias slug via the sentinel', () => {
    const m = matchPageBySlug(pages(['home', 'about']), [HOME_REWRITE_SENTINEL]);
    expect(m?.page.slug).toBe('home');
  });

  it('does NOT match a page literally slugged like the sentinel (sentinel means home)', () => {
    // A site with no home page but a page slugged `__home`: the sentinel resolves
    // HOME (none here -> null), it never matches the literal `__home` slug.
    expect(matchPageBySlug(pages([HOME_REWRITE_SENTINEL, 'about']), [HOME_REWRITE_SENTINEL])).toBeNull();
  });

  it('captures a :handle dynamic segment', () => {
    const m = matchPageBySlug(pages(['products/:handle']), ['products', 'classic-tee']);
    expect(m?.page.slug).toBe('products/:handle');
    expect(m?.params).toEqual({ handle: 'classic-tee' });
  });

  it('captures a [id] dynamic segment', () => {
    const m = matchPageBySlug(pages(['posts/[id]']), ['posts', '42']);
    expect(m?.params).toEqual({ id: '42' });
  });

  it('prefers an exact static match over a dynamic one', () => {
    const m = matchPageBySlug(pages(['products/:handle', 'products/sale']), ['products', 'sale']);
    expect(m?.page.slug).toBe('products/sale');
    expect(m?.params).toEqual({});
  });

  it('returns null when nothing matches', () => {
    expect(matchPageBySlug(pages(['about']), ['missing'])).toBeNull();
    expect(matchPageBySlug(pages(['a/b']), ['a'])).toBeNull();
  });
});

describe('resolvePublicIngestionKey', () => {
  it('resolves the key named by the apiKeyRef env var', () => {
    process.env.AP_KEY_REF_X = 'ap_live_fromref';
    expect(resolvePublicIngestionKey('AP_KEY_REF_X')).toBe('ap_live_fromref');
  });

  it('falls back to ANALYTICS_PUBLIC_INGESTION_KEY', () => {
    process.env.ANALYTICS_PUBLIC_INGESTION_KEY = 'ap_live_shared';
    expect(resolvePublicIngestionKey('UNSET_REF')).toBe('ap_live_shared');
    expect(resolvePublicIngestionKey(null)).toBe('ap_live_shared');
  });

  it('returns null when no key is configured', () => {
    expect(resolvePublicIngestionKey(null)).toBeNull();
  });
});

describe('resolveTrackerScriptSrc', () => {
  it('returns the configured loader URL', () => {
    process.env.ANALYTICS_TRACKER_SCRIPT_URL = 'https://cdn.lumitra.co/tracker.js';
    expect(resolveTrackerScriptSrc()).toBe('https://cdn.lumitra.co/tracker.js');
  });

  it('returns null when unset (snippet degrades to config-only)', () => {
    expect(resolveTrackerScriptSrc()).toBeNull();
  });
});

describe('resolveIngestionEndpoint', () => {
  it('prefers the per-site endpoint when set', () => {
    process.env.ANALYTICS_INGESTION_ENDPOINT = 'https://env-ingest';
    expect(resolveIngestionEndpoint('https://site-ingest')).toBe('https://site-ingest');
  });

  it('falls back to the env endpoint when the site has none', () => {
    process.env.ANALYTICS_INGESTION_ENDPOINT = 'https://env-ingest';
    expect(resolveIngestionEndpoint(null)).toBe('https://env-ingest');
  });

  it('returns null when neither is set', () => {
    expect(resolveIngestionEndpoint(null)).toBeNull();
  });
});

describe('resolveAnalyticsProjectId', () => {
  it('prefers the per-site project id, falls back to env, else null', () => {
    process.env.ANALYTICS_PROJECT_ID = 'proj_env';
    expect(resolveAnalyticsProjectId('proj_site')).toBe('proj_site');
    expect(resolveAnalyticsProjectId(null)).toBe('proj_env');
    delete process.env.ANALYTICS_PROJECT_ID;
    expect(resolveAnalyticsProjectId(null)).toBeNull();
  });
});
