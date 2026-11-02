// publicResolver: host -> published site, slug matching, ingestion-key resolution.
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  parseSubdomain,
  resolvePublishedSite,
  resolvePublishedSiteByKey,
  hostLookupKeys,
  matchPageBySlug,
  resolvePublicIngestionKey,
  resolveTrackerScriptSrc,
  resolveIngestionEndpoint,
  resolveAnalyticsProjectId,
  HOME_REWRITE_SENTINEL,
  revisionMemoKey,
  type PublishedPageRow,
} from '../publicResolver';

describe('revisionMemoKey', () => {
  it('keeps the key of a revision no erase touched, and changes it with every rewrite', () => {
    expect(revisionMemoKey('rev_1', null)).toBe('revision:rev_1');
    const first = revisionMemoKey('rev_1', new Date('2026-11-02T10:00:00.000Z'));
    const second = revisionMemoKey('rev_1', new Date('2026-11-02T11:00:00.000Z'));
    expect(first).toBe('revision:rev_1:2026-11-02T10:00:00.000Z');
    expect(new Set([revisionMemoKey('rev_1', null), first, second]).size).toBe(3);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ANALYTICS_PUBLIC_INGESTION_KEY;
  delete process.env.AP_KEY_REF_X;
  delete process.env.ANALYTICS_TRACKER_SCRIPT_URL;
  delete process.env.ANALYTICS_INGESTION_ENDPOINT;
  delete process.env.ANALYTICS_PROJECT_ID;
});

describe('parseSubdomain', () => {
  it('rejects a label that is not DNS-label shaped (no cache or DB work downstream)', () => {
    expect(parseSubdomain('bad_label.lumitra.site', 'lumitra.site')).toBeNull();
    expect(parseSubdomain('-lead.lumitra.site', 'lumitra.site')).toBeNull();
    expect(parseSubdomain('trail-.lumitra.site', 'lumitra.site')).toBeNull();
    expect(parseSubdomain(`${'a'.repeat(64)}.lumitra.site`, 'lumitra.site')).toBeNull();
    expect(parseSubdomain('bad_label.example.com', null)).toBeNull();
    // Hyphens inside a label and a 63-char label are fine.
    expect(parseSubdomain('my-shop.lumitra.site', 'lumitra.site')).toBe('my-shop');
    expect(parseSubdomain(`${'a'.repeat(63)}.lumitra.site`, 'lumitra.site')).toBe('a'.repeat(63));
  });

  it('does not apply the reserved-name list (an operator-seeded site may use one)', () => {
    expect(parseSubdomain('app.lumitra.site', 'lumitra.site')).toBe('app');
  });

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
  const fake = {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(fake),
    siteDomain: {
      findUnique: async ({
        where,
      }: {
        where: { subdomain?: string; customHostname?: string };
      }) => {
        if (where.subdomain === 'demo') return { siteId: 's1' };
        if (where.subdomain === 'draft') return { siteId: 's2' };
        // Custom domains: the live claim column, with its status.
        if (where.customHostname === 'shop.example.com') {
          return { siteId: 's1', verificationStatus: 'active' };
        }
        if (where.customHostname === 'xn--bcher-kva.example') return null;
        if (where.customHostname === 'xn--bcher-kva.de') {
          return { siteId: 's1', verificationStatus: 'verified' };
        }
        if (where.customHostname === 'pending.example.com') {
          return { siteId: 's1', verificationStatus: 'pending' };
        }
        if (where.customHostname === 'failed.example.com') {
          return { siteId: 's1', verificationStatus: 'failed' };
        }
        if (where.customHostname === 'draft-site.example.com') {
          return { siteId: 's2', verificationStatus: 'active' };
        }
        return null;
      },
    },
    site: {
      findFirst: async ({ where }: { where: { id: string; status: string } }) => {
        // Only s1 is published; the where-clause pins status: 'published'.
        if (where.id === 's1' && where.status === 'published') {
          return {
            id: 's1',
            workspaceId: 'framer-clone',
            tenantGroupId: 'demo-tenant-group',
            name: 'Demo',
            analyticsProjectId: 'proj_1',
            ingestionEndpoint: 'https://ingest',
            apiKeyRef: 'AP_KEY_REF_X',
            lumitraEnabled: true,
            updatedAt: new Date(0),
            redirects: [
              { from: 'old-about', pageId: 'p1', createdAt: '2026-10-21T10:00:00.000Z' },
              'malformed',
            ],
            pages,
          };
        }
        return null;
      },
    },
  };
  return fake as unknown as PrismaClient;
}

describe('resolvePublishedSite', () => {
  it('resolves a published site by subdomain', async () => {
    const site = await resolvePublishedSite('demo.lumitra.site', fakePrisma(), 'lumitra.site');
    expect(site).not.toBeNull();
    expect(site!.siteId).toBe('s1');
    expect(site!.lumitraEnabled).toBe(true);
    expect(site!.pages).toHaveLength(1);
  });

  it('carries the tenant (workspaceId + tenantGroupId) on the resolved site', async () => {
    const site = await resolvePublishedSite('demo.lumitra.site', fakePrisma(), 'lumitra.site');
    expect(site).not.toBeNull();
    expect(site!.workspaceId).toBe('framer-clone');
    expect(site!.tenantGroupId).toBe('demo-tenant-group');
  });

  it('carries the old-slug redirects, ignoring malformed entries', async () => {
    const site = await resolvePublishedSite('demo.lumitra.site', fakePrisma(), 'lumitra.site');
    expect(site!.redirects).toEqual([
      { from: 'old-about', pageId: 'p1', createdAt: '2026-10-21T10:00:00.000Z' },
    ]);
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

describe('resolvePublishedSite: custom hostnames', () => {
  it('resolves an active custom hostname to its published site', async () => {
    const site = await resolvePublishedSite('shop.example.com', fakePrisma(), 'lumitra.site');
    expect(site?.siteId).toBe('s1');
  });

  it('normalizes case, port and a trailing dot before the lookup', async () => {
    const site = await resolvePublishedSite('SHOP.Example.com.:443', fakePrisma(), 'lumitra.site');
    expect(site?.siteId).toBe('s1');
  });

  it('serves a verified (certificate pending) internationalized domain by its punycode', async () => {
    expect((await resolvePublishedSite('bücher.de', fakePrisma(), 'lumitra.site'))?.siteId).toBe('s1');
    expect(
      (await resolvePublishedSite('xn--bcher-kva.de', fakePrisma(), 'lumitra.site'))?.siteId,
    ).toBe('s1');
  });

  it('never serves a pending or failed domain', async () => {
    expect(await resolvePublishedSite('pending.example.com', fakePrisma(), 'lumitra.site')).toBeNull();
    expect(await resolvePublishedSite('failed.example.com', fakePrisma(), 'lumitra.site')).toBeNull();
  });

  it('never serves an unknown (or disconnected) hostname', async () => {
    expect(await resolvePublishedSite('gone.example.com', fakePrisma(), 'lumitra.site')).toBeNull();
  });

  it('never serves a custom domain whose site is not published', async () => {
    expect(
      await resolvePublishedSite('draft-site.example.com', fakePrisma(), 'lumitra.site'),
    ).toBeNull();
  });
});

describe('hostLookupKeys', () => {
  it('a host under the base host is only ever a subdomain', () => {
    expect(hostLookupKeys('demo.lumitra.site', 'lumitra.site')).toEqual([
      { kind: 'subdomain', value: 'demo' },
    ]);
    expect(hostLookupKeys('lumitra.site', 'lumitra.site')).toEqual([]);
  });

  it('any other well-formed public host is a custom hostname', () => {
    expect(hostLookupKeys('www.example.com', 'lumitra.site')).toEqual([
      { kind: 'custom', value: 'www.example.com' },
    ]);
  });

  it('platform zones, IP literals, local names and junk yield no key', () => {
    for (const host of [
      'app.lumitra.co',
      'lumitra.co',
      '10.0.0.1',
      '[::1]:3000',
      'localhost:3000',
      'shop.local',
      'bad_label.example.com',
      '',
      null,
    ]) {
      expect(hostLookupKeys(host, 'lumitra.site')).toEqual([]);
    }
  });

  it('without a base host: custom first, then the legacy first-label parse', () => {
    expect(hostLookupKeys('demo.lumitra.site', null)).toEqual([
      { kind: 'custom', value: 'demo.lumitra.site' },
      { kind: 'subdomain', value: 'demo' },
    ]);
    expect(hostLookupKeys('app.lumitra.co', null)).toEqual([{ kind: 'subdomain', value: 'app' }]);
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

  it('prefers the empty-slug home page over a page slugged home, whatever the order', () => {
    const m = matchPageBySlug(pages(['home', 'about', '']), [HOME_REWRITE_SENTINEL]);
    expect(m?.page.slug).toBe('');
    // ...and the page slugged `home` is still served at /home.
    expect(matchPageBySlug(pages(['home', 'about', '']), ['home'])?.page.slug).toBe('home');
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

describe('resolvePublishedSiteByKey with a revision', () => {
  /** A definition parseComponents keeps: an empty object is dropped as unreadable. */
  const NAV = {
    id: 'nav',
    name: 'Nav',
    page: {
      id: 'nav-page',
      slug: '',
      metadata: { title: 'Nav' },
      appComponentTree: { id: 'nav-root', type: 'nav', componentType: 'host', props: {}, children: [] },
      canvasNodes: {},
    },
    inputs: [],
    states: [],
  };

  function prismaWith(
    publishedRevision: unknown,
    pages: unknown[] = [],
    publishedRevisionId: string | null = 'rev',
  ): PrismaClient {
    const fake = {
      $transaction: async (run: (tx: unknown) => Promise<unknown>, options: unknown) => {
        transactionOptions.push(options);
        return run(fake);
      },
      siteDomain: { findUnique: async () => ({ siteId: 's1' }) },
      site: {
        findFirst: async () => ({
          id: 's1',
          workspaceId: 'ws',
          tenantGroupId: 'tg',
          companyId: 'c',
          name: 'Working copy name',
          analyticsProjectId: null,
          ingestionEndpoint: null,
          apiKeyRef: null,
          lumitraEnabled: false,
          redirects: [],
          siteSettings: { language: 'fr' },
          components: { nav: { ...NAV, name: 'Working nav' } },
          updatedAt: new Date('2026-11-02T08:00:00.000Z'),
          publishedRevisionId,
          publishedRevision,
          pages,
        }),
      },
    };
    return fake as unknown as PrismaClient;
  }

  const transactionOptions: unknown[] = [];

  it('reads the frozen document, keeping identity and tenancy live', async () => {
    const site = await resolvePublishedSiteByKey(
      { kind: 'subdomain', value: 'demo' },
      prismaWith({
        number: 4,
        document: {
          schemaVersion: 1,
          name: 'Frozen name',
          siteSettings: { language: 'de' },
          pages: [{ pageId: 'p', slug: 'about', snapshot: {} }],
          components: { nav: NAV },
        },
      }),
    );
    expect(site).toMatchObject({
      siteId: 's1',
      workspaceId: 'ws',
      companyId: 'c',
      name: 'Frozen name',
      revisionNumber: 4,
    });
    // Parsed once here, so the cached value is ready and no request parses it again.
    expect(site?.components.nav?.name).toBe('Nav');
    expect(site?.revision).toBe('revision:rev');
    expect(site?.siteSettings.language).toBe('de');
    expect(site?.pages.map((p) => p.slug)).toEqual(['about']);
    // One snapshot, so a first save between Prisma's statements cannot empty the site.
    expect(transactionOptions.at(-1)).toMatchObject({ isolationLevel: 'RepeatableRead' });
  });

  it('serves the working copy only when the pointer is null', async () => {
    const site = await resolvePublishedSiteByKey(
      { kind: 'subdomain', value: 'demo' },
      prismaWith(null, [{ pageId: 'p', slug: 'draft', snapshot: {} }], null),
    );
    expect(site?.revisionNumber).toBeNull();
    expect(site?.pages.map((p) => p.slug)).toEqual(['draft']);
    // A site from before revisions serves its components column with its rows.
    expect(site?.components.nav?.name).toBe('Working nav');
    // Every save moves updated_at, so the expansion memo keys on it until a revision exists.
    expect(site?.revision).toBe('working:2026-11-02T08:00:00.000Z');
  });

  it('throws when the pointer is set but no revision came back', async () => {
    await expect(
      resolvePublishedSiteByKey(
        { kind: 'subdomain', value: 'demo' },
        prismaWith(null, [{ pageId: 'p', slug: 'draft', snapshot: {} }], 'rev_gone'),
      ),
    ).rejects.toThrow('points at a revision that does not exist');
  });

  it('fails loudly on a damaged revision, never falling through to the working copy', async () => {
    await expect(
      resolvePublishedSiteByKey(
        { kind: 'subdomain', value: 'demo' },
        prismaWith({ number: 4, document: { name: 'no pages' } }, [{ pageId: 'p', slug: 'draft', snapshot: {} }]),
      ),
    ).rejects.toThrow('malformed site revision document');
  });
});
