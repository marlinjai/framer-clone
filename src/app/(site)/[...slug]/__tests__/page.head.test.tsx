// The published page's head from Site settings and Page settings: title through
// the template, canonical on the primary host (dynamic params filled in),
// noindex, the sharing image falling back to the site default, the designed
// 404 page answering its own path with the 404, and the business JSON-LD on the
// home page only. The real snapshot adapter, matcher and head builders run;
// host resolution, the primary host and the render are faked.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { normalizeSiteSettings } from '@/lib/site/siteSettings';

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'abc123.sites.lumitra.co' }),
}));

class NotFoundSignal extends Error {}
vi.mock('next/navigation', () => ({
  permanentRedirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
  notFound: () => {
    throw new NotFoundSignal('not found');
  },
}));

let site: Record<string, unknown>;
vi.mock('@/server/sites/cachedResolver', () => ({
  getCachedPublishedSite: vi.fn(async () => site),
}));
vi.mock('@/server/sites/primaryHost', () => ({
  loadSitePrimaryHost: vi.fn(async () => 'www.mueller.de'),
}));
vi.mock('@/lib/renderer/server/renderPublishedPage', () => ({
  renderPublishedPage: vi.fn(async () => ({ body: <p data-testid="body">body</p>, headSnippet: null })),
}));
vi.mock('@/server/commerce/storefrontTenant', () => ({
  commerceRepoForSite: vi.fn(async () => undefined),
}));
vi.mock('@/server/cms', () => ({
  getPublishedCmsRepository: () => ({}),
}));

import SitePage, { generateMetadata } from '../page';

function page(pageId: string, slug: string, metadata: Record<string, unknown> = {}) {
  return {
    pageId,
    slug,
    snapshot: {
      id: pageId,
      slug,
      metadata: { title: pageId, description: '', ...metadata },
      appComponentTree: { id: `root-${pageId}`, type: 'div', props: {}, children: [] },
      canvasNodes: {},
    },
  };
}

function setSite(settings: Record<string, unknown>, pages: unknown[]) {
  site = {
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

const meta = (slug: string[]) => generateMetadata({ params: Promise.resolve({ slug }) });
const visit = (slug: string[]) => SitePage({ params: Promise.resolve({ slug }) });

const business = {
  legalName: 'Müller GmbH',
  street: 'Hauptstr. 1',
  postalCode: '80331',
  city: 'München',
  country: 'DE',
  phone: '+49 89 123456',
  openingHours: [{ days: ['Monday', 'Tuesday'], opens: '07:00', closes: '18:00' }],
};

beforeEach(() => {
  cleanup();
  setSite(
    { siteName: 'Bäckerei Müller', ogImageUrl: 'https://cdn.mueller.de/og.jpg', notFoundPageId: 'oops', business },
    [
      page('Bäckerei Müller', ''),
      page('About us', 'about', { description: 'Who we are', ogImage: 'https://cdn.mueller.de/about.jpg' }),
      page('Imprint draft', 'draft', { noIndex: true }),
      page('Bread', 'bread/:id'),
      page('oops', 'oops'),
    ],
  );
});

describe('generateMetadata', () => {
  it('titles a page through the template and canonicalises it on the primary host', async () => {
    const m = await meta(['about']);
    expect(m.title).toBe('About us');
    expect(m.alternates).toEqual({ canonical: 'https://www.mueller.de/about' });
    expect(m.openGraph).toMatchObject({
      title: 'About us | Bäckerei Müller',
      description: 'Who we are',
      url: 'https://www.mueller.de/about',
      siteName: 'Bäckerei Müller',
      images: [{ url: 'https://cdn.mueller.de/about.jpg' }],
    });
    expect(m.twitter).toMatchObject({ card: 'summary_large_image', images: ['https://cdn.mueller.de/about.jpg'] });
    expect(m.robots).toBeUndefined();
  });

  it('shows the home page as the site name alone, with the site default sharing image', async () => {
    const m = await meta(['__home']);
    expect(m.title).toEqual({ absolute: 'Bäckerei Müller' });
    expect(m.alternates).toEqual({ canonical: 'https://www.mueller.de/' });
    expect(m.openGraph).toMatchObject({ images: [{ url: 'https://cdn.mueller.de/og.jpg' }] });
  });

  it('fills dynamic params into the canonical URL', async () => {
    const m = await meta(['bread', 'rye loaf']);
    expect(m.alternates).toEqual({ canonical: 'https://www.mueller.de/bread/rye%20loaf' });
  });

  it('marks a hidden page noindex', async () => {
    expect((await meta(['draft'])).robots).toEqual({ index: false, follow: true });
  });

  it('leaves the 404 page and unknown paths to the layout', async () => {
    expect(await meta(['oops'])).toEqual({});
    expect(await meta(['nowhere'])).toEqual({});
  });
});

describe('the page body', () => {
  it('answers the designed 404 page at its own path with the 404', async () => {
    await expect(visit(['oops'])).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it('embeds the business JSON-LD on the home page only', async () => {
    const { container } = render(await visit(['__home']));
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
    const data = JSON.parse(script!.innerHTML);
    expect(data['@type']).toBe('LocalBusiness');
    expect(data.name).toBe('Bäckerei Müller');
    expect(data.url).toBe('https://www.mueller.de/');
    expect(data.address).toMatchObject({ addressLocality: 'München', postalCode: '80331' });
    cleanup();

    const about = render(await visit(['about']));
    expect(about.container.querySelector('script[type="application/ld+json"]')).toBeNull();
    expect(about.getByTestId('body')).toBeTruthy();
  });
});
