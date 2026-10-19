// @vitest-environment node
//
// src/app/(site)/[...slug]/__tests__/page.cmsTenancy.test.tsx
//
// The storefront SSR render reads CMS data DIRECTLY through the repository (not
// over /api/cms), so its tenancy is decided here: the repository handed to the
// hydrator must be bound to the workspace of the site the request HOST resolves
// to, never the session, never the module-constant workspace, never another
// host's site. Everything around that seam is faked (host resolution, snapshot
// adaptation, the render itself); the real per-workspace isolation of the
// repository is proven against Postgres in src/server/cms/__tests__/
// renderTenancy.itest.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

let requestHost = 'alpha.sites.lumitra.co';
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: requestHost }),
}));

const SITES: Record<string, { siteId: string; workspaceId: string }> = {
  'alpha.sites.lumitra.co': { siteId: 'site_alpha', workspaceId: 'ws_alpha' },
  'beta.sites.lumitra.co': { siteId: 'site_beta', workspaceId: 'ws_beta' },
};
vi.mock('@/server/sites/cachedResolver', () => ({
  getCachedPublishedSite: vi.fn(async (host: string) => {
    const site = SITES[host];
    return site
      ? {
          ...site,
          tenantGroupId: 'tg',
          name: site.siteId,
          analyticsProjectId: null,
          ingestionEndpoint: null,
          apiKeyRef: null,
          lumitraEnabled: false,
          pages: [],
        }
      : null;
  }),
}));

vi.mock('@/server/sites/publicResolver', () => ({
  matchPageBySlug: () => ({ page: { snapshot: {} }, params: {} }),
  resolvePublicIngestionKey: () => null,
  resolveTrackerScriptSrc: () => null,
  resolveIngestionEndpoint: () => null,
  resolveAnalyticsProjectId: () => null,
}));

vi.mock('@/lib/renderer/server/snapshotToComponentNode', () => ({
  snapshotToComponentNode: () => ({ root: { type: 'div' }, metadata: {} }),
}));

const renderPublishedPage = vi.fn(async () => ({ body: null, headSnippet: null }));
vi.mock('@/lib/renderer/server/renderPublishedPage', () => ({
  renderPublishedPage: (...args: unknown[]) => renderPublishedPage(...(args as [])),
  pageSeoToMetadata: () => ({}),
}));

vi.mock('@/server/commerce/storefrontTenant', () => ({
  commerceRepoForSite: vi.fn(async () => undefined),
}));

const getCmsRepository = vi.fn((workspaceId: string) => ({ __boundTo: workspaceId }));
vi.mock('@/server/cms', () => ({
  // The render must use the PUBLISHED repository (published, non-archived rows
  // only); the editor repository is deliberately absent from this mock.
  getPublishedCmsRepository: (workspaceId: string) => getCmsRepository(workspaceId),
}));

const mockVerifySession = vi.fn();
vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: { verifySession: (...a: unknown[]) => mockVerifySession(...a) },
}));

import SitePage from '../page';

function cmsRepoPassedToRender(): unknown {
  const input = (renderPublishedPage.mock.calls.at(-1) as unknown[] | undefined)?.[0] as
    | { cmsRepo: unknown }
    | undefined;
  return input?.cmsRepo;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('storefront SSR: CMS reads are bound to the Host site workspace', () => {
  it('hydrates with a repository bound to the alpha site\'s workspace on the alpha host', async () => {
    requestHost = 'alpha.sites.lumitra.co';
    await SitePage({ params: Promise.resolve({ slug: ['about'] }) });
    expect(getCmsRepository).toHaveBeenCalledTimes(1);
    expect(getCmsRepository).toHaveBeenCalledWith('ws_alpha');
    expect(cmsRepoPassedToRender()).toEqual({ __boundTo: 'ws_alpha' });
  });

  it('binds the beta workspace on the beta host (one host, one tenant)', async () => {
    requestHost = 'beta.sites.lumitra.co';
    await SitePage({ params: Promise.resolve({ slug: ['about'] }) });
    expect(getCmsRepository).toHaveBeenCalledWith('ws_beta');
    expect(getCmsRepository).not.toHaveBeenCalledWith('ws_alpha');
  });

  it('never reads the session to decide the workspace', async () => {
    requestHost = 'alpha.sites.lumitra.co';
    await SitePage({ params: Promise.resolve({ slug: ['about'] }) });
    expect(mockVerifySession).not.toHaveBeenCalled();
  });

  it('binds no repository at all for a host that is not a published site (404)', async () => {
    requestHost = 'nobody.sites.lumitra.co';
    await expect(SitePage({ params: Promise.resolve({ slug: ['about'] }) })).rejects.toThrow();
    expect(getCmsRepository).not.toHaveBeenCalled();
    expect(renderPublishedPage).not.toHaveBeenCalled();
  });
});
