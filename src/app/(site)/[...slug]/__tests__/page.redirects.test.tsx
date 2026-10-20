// @vitest-environment node
//
// The published router after a slug change: the page is served at its NEW
// slug, its OLD slug answers with a permanent redirect (308, via Next's
// permanentRedirect) to the new one, the query string survives, a page that
// now owns the old path wins over the redirect, and anything else is a 404.
// The real matcher (matchPageBySlug) and the real redirect lookup run; only
// host resolution, the snapshot adapter and the render are faked.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'abc123.sites.lumitra.co' }),
}));

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}
class NotFoundSignal extends Error {}
const permanentRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock('next/navigation', () => ({
  permanentRedirect: (url: string) => permanentRedirect(url),
  notFound: () => {
    throw new NotFoundSignal('not found');
  },
}));

type Page = { pageId: string; slug: string; snapshot: { id: string } };
let site: {
  pages: Page[];
  redirects: Array<{ from: string; pageId: string; createdAt: string }>;
};
vi.mock('@/server/sites/cachedResolver', () => ({
  getCachedPublishedSite: vi.fn(async () => ({
    siteId: 'site_1',
    workspaceId: 'ws_1',
    tenantGroupId: 'tg',
    name: 'Bakery',
    analyticsProjectId: null,
    ingestionEndpoint: null,
    apiKeyRef: null,
    lumitraEnabled: false,
    ...site,
  })),
}));

vi.mock('@/lib/renderer/server/snapshotToComponentNode', () => ({
  snapshotToComponentNode: (snapshot: { id: string }) => ({ root: { type: 'div', id: snapshot.id }, metadata: {} }),
}));

const renderPublishedPage = vi.fn(async () => ({ body: null, headSnippet: null }));
vi.mock('@/lib/renderer/server/renderPublishedPage', () => ({
  renderPublishedPage: (...args: unknown[]) => renderPublishedPage(...(args as [])),
  pageSeoToMetadata: () => ({}),
}));
vi.mock('@/server/commerce/storefrontTenant', () => ({
  commerceRepoForSite: vi.fn(async () => undefined),
}));
vi.mock('@/server/cms', () => ({
  getPublishedCmsRepository: () => ({}),
}));

import SitePage from '../page';

function page(pageId: string, slug: string): Page {
  return { pageId, slug, snapshot: { id: pageId } };
}

function renderedPageId(): string | undefined {
  const input = (renderPublishedPage.mock.calls.at(-1) as unknown[] | undefined)?.[0] as
    | { root: { id: string } }
    | undefined;
  return input?.root.id;
}

async function visit(slug: string[], searchParams: Record<string, string | string[]> = {}) {
  return SitePage({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(searchParams) });
}

beforeEach(() => {
  vi.clearAllMocks();
  site = {
    pages: [page('home', ''), page('p_about', 'about-us'), page('p_contact', 'contact')],
    redirects: [{ from: 'about', pageId: 'p_about', createdAt: '2026-10-21T10:00:00.000Z' }],
  };
});

describe('published router after a slug change', () => {
  it('serves the page at its new slug', async () => {
    await visit(['about-us']);
    expect(renderedPageId()).toBe('p_about');
    expect(permanentRedirect).not.toHaveBeenCalled();
  });

  it('answers the old slug with a permanent redirect to the new one', async () => {
    await expect(visit(['about'])).rejects.toBeInstanceOf(RedirectSignal);
    expect(permanentRedirect).toHaveBeenCalledWith('/about-us');
    expect(renderPublishedPage).not.toHaveBeenCalled();
  });

  it('keeps the query string', async () => {
    await expect(visit(['About'], { ref: 'mail', tag: ['a', 'b'] })).rejects.toBeInstanceOf(RedirectSignal);
    expect(permanentRedirect).toHaveBeenCalledWith('/about-us?ref=mail&tag=a&tag=b');
  });

  it('follows the page when it moves again (no chain)', async () => {
    site.pages = [page('home', ''), page('p_about', 'team')];
    site.redirects.push({ from: 'about-us', pageId: 'p_about', createdAt: '2026-10-21T11:00:00.000Z' });
    await expect(visit(['about'])).rejects.toBeInstanceOf(RedirectSignal);
    expect(permanentRedirect).toHaveBeenLastCalledWith('/team');
    await expect(visit(['about-us'])).rejects.toBeInstanceOf(RedirectSignal);
    expect(permanentRedirect).toHaveBeenLastCalledWith('/team');
  });

  it('lets a page that owns the old path win over the redirect', async () => {
    site.pages.push(page('p_new', 'about'));
    await visit(['about']);
    expect(renderedPageId()).toBe('p_new');
    expect(permanentRedirect).not.toHaveBeenCalled();
  });

  it('404s an unknown path and a redirect whose page is gone', async () => {
    await expect(visit(['nothing-here'])).rejects.toBeInstanceOf(NotFoundSignal);
    site.pages = [page('home', '')];
    await expect(visit(['about'])).rejects.toBeInstanceOf(NotFoundSignal);
    expect(permanentRedirect).not.toHaveBeenCalled();
  });

  it('still serves the home page at the root', async () => {
    await visit(['__home']);
    expect(renderedPageId()).toBe('home');
  });
});
