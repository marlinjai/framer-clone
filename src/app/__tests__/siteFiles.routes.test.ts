// @vitest-environment node
//
// The per-host files: robots.txt, sitemap.xml, site.webmanifest and
// favicon.ico answer for the site the Host names (platform subdomain or custom
// domain, through getCachedPublishedSite like the page routes), and for a host
// without a published site answer safely (robots disallows all, the others 404,
// the favicon is the platform's). A resolver failure is a 503, never a wrong
// answer.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeSiteSettings } from '@/lib/site/siteSettings';

const getCachedPublishedSite = vi.fn();
vi.mock('@/server/sites/cachedResolver', () => ({
  getCachedPublishedSite: (host: string) => getCachedPublishedSite(host),
}));
vi.mock('@/server/sites/primaryHost', () => ({
  loadSitePrimaryHost: vi.fn(async () => 'www.mueller.de'),
}));
const loadSitemapExpansions = vi.fn(async () => new Map([['post', ['7']]]));
vi.mock('@/server/sites/sitemap', () => ({
  loadSitemapExpansions: (...args: unknown[]) => loadSitemapExpansions(...(args as [])),
}));

import { GET as robots } from '../robots.txt/route';
import { GET as sitemap } from '../sitemap.xml/route';
import { GET as manifest } from '../site.webmanifest/route';
import { GET as favicon } from '../favicon.ico/route';

const req = (host: string) => new Request(`https://${host}/x`, { headers: { host } });

function site(settings: Record<string, unknown> = {}) {
  return {
    siteId: 'site_1',
    workspaceId: 'ws',
    tenantGroupId: 'tg',
    name: 'Bakery project',
    analyticsProjectId: null,
    ingestionEndpoint: null,
    apiKeyRef: null,
    lumitraEnabled: false,
    redirects: [],
    siteSettings: normalizeSiteSettings(settings),
    pages: [
      { pageId: 'home', slug: '', snapshot: { metadata: { title: 'Home' }, updatedAt: Date.UTC(2026, 9, 1) } },
      { pageId: 'hidden', slug: 'hidden', snapshot: { metadata: { title: 'H', noIndex: true } } },
      { pageId: 'post', slug: 'blog/:id', snapshot: { metadata: { title: 'Post' } } },
    ],
  };
}

beforeEach(() => {
  getCachedPublishedSite.mockReset();
});

describe('robots.txt', () => {
  it('points a site host at its sitemap on the primary host', async () => {
    getCachedPublishedSite.mockResolvedValue(site());
    const res = await robots(req('abc123.sites.lumitra.co'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('User-agent: *\nAllow: /\n\nSitemap: https://www.mueller.de/sitemap.xml\n');
    expect(getCachedPublishedSite).toHaveBeenCalledWith('abc123.sites.lumitra.co');
  });

  it('disallows everything on a host without a site', async () => {
    getCachedPublishedSite.mockResolvedValue(null);
    expect(await (await robots(req('app.lumitra.co'))).text()).toBe('User-agent: *\nDisallow: /\n');
  });

  it('is a 503 when the site cannot be resolved', async () => {
    getCachedPublishedSite.mockRejectedValue(new Error('db down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await robots(req('a.test'))).status).toBe(503);
    spy.mockRestore();
  });
});

describe('sitemap.xml', () => {
  it('lists the listable pages on the primary host, expanded dynamic pages included', async () => {
    getCachedPublishedSite.mockResolvedValue(site());
    const res = await sitemap(req('www.mueller.de'));
    expect(res.headers.get('content-type')).toContain('application/xml');
    const xml = await res.text();
    expect(xml).toContain('<loc>https://www.mueller.de/</loc><lastmod>2026-10-01T00:00:00.000Z</lastmod>');
    expect(xml).toContain('<loc>https://www.mueller.de/blog/7</loc>');
    expect(xml).not.toContain('hidden');
  });

  it('is a 404 on a host without a site', async () => {
    getCachedPublishedSite.mockResolvedValue(null);
    expect((await sitemap(req('unknown.test'))).status).toBe(404);
  });
});

describe('site.webmanifest', () => {
  it("names the site in its language", async () => {
    getCachedPublishedSite.mockResolvedValue(site({ siteName: 'Bäckerei', language: 'de' }));
    const res = await manifest(req('www.mueller.de'));
    expect(res.headers.get('content-type')).toContain('application/manifest+json');
    expect(await res.json()).toMatchObject({ name: 'Bäckerei', lang: 'de' });
  });

  it('is a 404 on a host without a site', async () => {
    getCachedPublishedSite.mockResolvedValue(null);
    expect((await manifest(req('unknown.test'))).status).toBe(404);
  });
});

describe('favicon.ico', () => {
  it("redirects to the site's favicon", async () => {
    getCachedPublishedSite.mockResolvedValue(site({ faviconUrl: 'https://cdn.mueller.de/i.png' }));
    const res = await favicon(req('www.mueller.de'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://cdn.mueller.de/i.png');
  });

  it('is a 404 for a site without a favicon, never the platform icon', async () => {
    getCachedPublishedSite.mockResolvedValue(site());
    expect((await favicon(req('www.mueller.de'))).status).toBe(404);
  });

  it('is the platform icon on the editor host', async () => {
    getCachedPublishedSite.mockResolvedValue(null);
    const res = await favicon(req('app.lumitra.co'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('/platform-favicon.ico');
  });
});
