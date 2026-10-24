// The published storefront `(site)` route group, decoupled from the editor's
// root layout (MT-15), with the per-site head and 404 (plan
// docs/plans/2026-10-23-published-site-essentials.md):
//   1. The layout metadata is the site's own (title template, favicon set,
//      manifest, metadataBase on the primary host), never editor scaffolding,
//      and a neutral default for a host without a site.
//   2. A storefront miss renders: the site's designed 404 page; else a default
//      in the site's language with its name and home-page look; else (no site)
//      the generic English default. A failing designed page falls back.
//   3. `<html lang>` follows the site's language, `en` without a site.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { normalizeSiteSettings } from '@/lib/site/siteSettings';

let host = 'abc123.sites.lumitra.co';
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host }),
}));

type Site = Record<string, unknown> | null;
let site: Site = null;
vi.mock('@/server/sites/cachedResolver', () => ({
  getCachedPublishedSite: vi.fn(async () => site),
}));
vi.mock('@/server/sites/primaryHost', () => ({
  loadSitePrimaryHost: vi.fn(async () => 'www.mueller.de'),
}));

const renderSitePage = vi.fn(async (input: { matched: { page: { pageId: string } } }) => (
  <div data-testid="designed-404">designed {input.matched.page.pageId}</div>
));
vi.mock('@/server/sites/renderSitePage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/sites/renderSitePage')>();
  return { ...actual, renderSitePage: (input: never) => renderSitePage(input) };
});

import { generateMetadata } from '../layout';
import SiteNotFound from '../not-found';
import { getRequestLanguage } from '@/server/sites/requestSite';

const EDITOR_TITLE = 'Create Next App';

function makeSite(settings: Record<string, unknown> = {}, pages: unknown[] = []): Site {
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
    pages,
    siteSettings: normalizeSiteSettings(settings),
  };
}

const homePage = {
  pageId: 'home',
  slug: '',
  snapshot: {
    id: 'home',
    metadata: { title: 'Home' },
    appComponentTree: {
      id: 'root',
      type: 'div',
      props: { style: { fontFamily: 'Fraunces, serif', color: '#2b1d0e', backgroundColor: '#fbf6ee' } },
      children: [{ id: 'cta', type: 'a', props: { style: { backgroundColor: '#b4532a', color: '#fff' } } }],
    },
  },
};
const lostPage = {
  pageId: 'lost',
  slug: 'lost',
  snapshot: { id: 'lost', metadata: { title: 'Lost' }, appComponentTree: { id: 'r404', type: 'div' } },
};

beforeEach(() => {
  host = 'abc123.sites.lumitra.co';
  site = null;
  renderSitePage.mockClear();
});
afterEach(() => cleanup());

async function renderNotFound() {
  render(await SiteNotFound());
}

describe('(site) layout metadata', () => {
  it('is a neutral default, never editor scaffolding, for a host without a site', async () => {
    const metadata = await generateMetadata();
    expect(metadata.title).toBe('Site');
    expect(JSON.stringify(metadata)).not.toContain(EDITOR_TITLE);
  });

  it("is the site's own: title template, favicon set, manifest, primary host, twitter card", async () => {
    site = makeSite({
      siteName: 'Bäckerei Müller',
      faviconUrl: 'https://cdn.mueller.de/icon.png',
      ogImageUrl: 'https://cdn.mueller.de/og.jpg',
      twitterCard: 'summary',
      language: 'de',
      business: { country: 'DE' },
    });
    const metadata = await generateMetadata();
    expect(metadata.title).toEqual({ template: '%s | Bäckerei Müller', default: 'Bäckerei Müller' });
    expect(metadata.metadataBase?.toString()).toBe('https://www.mueller.de/');
    expect(metadata.icons).toEqual({
      icon: [{ url: 'https://cdn.mueller.de/icon.png' }],
      apple: [{ url: 'https://cdn.mueller.de/icon.png' }],
    });
    expect(metadata.manifest).toBe('/site.webmanifest');
    expect(metadata.openGraph).toMatchObject({
      siteName: 'Bäckerei Müller',
      locale: 'de_DE',
      images: [{ url: 'https://cdn.mueller.de/og.jpg' }],
    });
    expect(metadata.twitter).toMatchObject({ card: 'summary' });
  });

  it('uses the project name when no site name is set, and links no icon without a favicon', async () => {
    site = makeSite();
    const metadata = await generateMetadata();
    expect(metadata.title).toEqual({ template: '%s | Bakery project', default: 'Bakery project' });
    expect(metadata.icons).toBeUndefined();
  });
});

describe('(site) not-found', () => {
  it('renders the generic English 404 for a host without a site', async () => {
    await renderNotFound();
    expect(screen.getByTestId('storefront-404').getAttribute('lang')).toBe('en');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(screen.queryByTestId('storefront-404-site')).toBeNull();
    expect(screen.queryByText(EDITOR_TITLE)).toBeNull();
  });

  it("renders the default in the site's language with its name and home-page look", async () => {
    site = makeSite({ language: 'de', siteName: 'Bäckerei Müller' }, [homePage]);
    await renderNotFound();
    const main = screen.getByTestId('storefront-404');
    expect(main.getAttribute('lang')).toBe('de');
    expect(screen.getByRole('heading', { name: 'Seite nicht gefunden' })).toBeTruthy();
    expect(screen.getByTestId('storefront-404-site').textContent).toBe('Bäckerei Müller');
    expect(main.style.fontFamily).toContain('Fraunces');
    expect(screen.getByRole('link', { name: 'Zur Startseite' }).getAttribute('style')).toContain('rgb(180, 83, 42)');
  });

  it("renders the site's designed 404 page", async () => {
    site = makeSite({ notFoundPageId: 'lost' }, [homePage, lostPage]);
    await renderNotFound();
    expect(screen.getByTestId('designed-404').textContent).toBe('designed lost');
    expect(screen.queryByTestId('storefront-404')).toBeNull();
  });

  it('falls back to the default when the designed page is gone or fails to render', async () => {
    site = makeSite({ notFoundPageId: 'deleted' }, [homePage]);
    await renderNotFound();
    expect(screen.getByTestId('storefront-404')).toBeTruthy();
    cleanup();

    site = makeSite({ notFoundPageId: 'lost' }, [homePage, lostPage]);
    renderSitePage.mockRejectedValueOnce(new Error('cms down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await renderNotFound();
    expect(screen.getByTestId('storefront-404')).toBeTruthy();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('<html lang>', () => {
  it("is the site's language on a site host and en without a site", async () => {
    site = makeSite({ language: 'de-AT' });
    expect(await getRequestLanguage()).toBe('de-AT');
    site = null;
    expect(await getRequestLanguage()).toBe('en');
  });
});
