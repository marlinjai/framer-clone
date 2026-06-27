// @vitest-environment node
//
// src/app/api/projects/__tests__/unpublish-route.test.ts
//
// Unit tests for POST /api/projects/unpublish (the inverse of publish). The
// auth-brain client (verifySession + can) and the site repository are mocked, so
// these assert the REAL guard + scope-resolution contract without a database:
//   - the scope is derived from the SERVER session (active workspace -> tenant
//     -> tenant_group), never from the client body,
//   - the route authorizes the `publishSite` permission (the same gate as
//     publish) and calls unpublishProject under that scope,
//   - the success envelope is { siteId, status: 'draft' },
//   - the SiteDomain row survives an unpublish so a subsequent re-publish reuses
//     the original slug (idempotency, asserted against the publish route),
//   - 401 with no session, 403 when not a workspace admin, 400 on a bad body,
//   - a cross-workspace site id is rejected as the typed 404 envelope.
// resolveActiveScope and the typed error mapping are kept REAL (only
// getSiteRepository is mocked) so the actual scope/error wiring is exercised.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockVerifySession = vi.fn();
const mockCan = vi.fn();
vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    verifySession: (...args: unknown[]) => mockVerifySession(...args),
    can: (...args: unknown[]) => mockCan(...args),
    verifyApiKey: vi.fn(),
    getCurrentUser: vi.fn(),
  },
}));

vi.mock('@/server/sites', async (importActual) => {
  const actual = await importActual<typeof import('@/server/sites')>();
  return { ...actual, getSiteRepository: vi.fn() };
});

// MT-17: unpublish invalidates the origin render cache. The cache module is
// mocked — resolveSubdomainForSiteId stands in for the surviving SiteDomain
// lookup, and revalidateSiteCache is asserted. The real caching contract is
// covered in cachedResolver.test.
vi.mock('@/server/sites/cachedResolver', () => ({
  revalidateSiteCache: vi.fn(),
  resolveSubdomainForSiteId: vi.fn(),
}));

import { getSiteRepository, SiteNotFoundError } from '@/server/sites';
import {
  revalidateSiteCache,
  resolveSubdomainForSiteId,
} from '@/server/sites/cachedResolver';
import { POST } from '../unpublish/route';
import { POST as PUBLISH } from '../publish/route';

const getRepoMock = vi.mocked(getSiteRepository);
const resolveSubdomainMock = vi.mocked(resolveSubdomainForSiteId);
const revalidateMock = vi.mocked(revalidateSiteCache);

const SCOPE = { workspaceId: 'ws_marlin', tenantGroupId: 'tg_lumitra' };

const PROJECT = {
  id: 'site_1',
  metadata: { title: 'Demo', description: '', createdAt: 1000, updatedAt: 2000 },
  pages: {
    page_home: { slug: '', appComponentTree: { kind: 'frame' } },
    page_about: { slug: 'about' },
  },
};

function makeSession() {
  return {
    user: { id: 'user-1' },
    session: {},
    tenants: [{ id: 'tenant-1', group_id: 'tg_lumitra' }],
    workspaces: [{ id: 'ws_marlin', tenant_id: 'tenant-1' }],
    active_tenant: { id: 'tenant-1' },
    active_workspace: { id: 'ws_marlin' },
  };
}

function unpublishReq(body: unknown, opts?: { cookie?: string | null }): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // Default to a present session cookie; tests that need "no session" pass null.
  if (opts?.cookie !== null) {
    headers['cookie'] = opts?.cookie ?? 'lumitra_session=good';
  }
  return new Request('http://t/api/projects/unpublish', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function publishReq(body: unknown): Request {
  return new Request('http://t/api/projects/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'lumitra_session=good' },
    body: JSON.stringify(body),
  });
}

function installRepo(repo: {
  unpublishProject?: unknown;
  saveProject?: unknown;
  publishProject?: unknown;
  ensureSiteDomain?: unknown;
}) {
  getRepoMock.mockReturnValue(repo as ReturnType<typeof getSiteRepository>);
}

const ORIGINAL_BASE_HOST = process.env.PUBLIC_SITE_BASE_HOST;

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifySession.mockReset();
  mockCan.mockReset();
  delete process.env.PUBLIC_SITE_BASE_HOST;
});

afterEach(() => {
  if (ORIGINAL_BASE_HOST === undefined) {
    delete process.env.PUBLIC_SITE_BASE_HOST;
  } else {
    process.env.PUBLIC_SITE_BASE_HOST = ORIGINAL_BASE_HOST;
  }
});

describe('POST /api/projects/unpublish guard', () => {
  it('401s when there is no session', async () => {
    mockVerifySession.mockResolvedValue(null);
    const unpublish = vi.fn();
    installRepo({ unpublishProject: unpublish });

    const res = await POST(unpublishReq({ siteId: 'site_1' }, { cookie: null }));

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthorized');
    expect(unpublish).not.toHaveBeenCalled();
  });

  it('403s when the session is valid but the user is not a workspace admin', async () => {
    mockVerifySession.mockResolvedValue(makeSession());
    mockCan.mockResolvedValue(false);
    const unpublish = vi.fn();
    installRepo({ unpublishProject: unpublish });

    const res = await POST(unpublishReq({ siteId: 'site_1' }));

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
    expect(unpublish).not.toHaveBeenCalled();
    // The admin check uses the real publishSite -> workspace.admin requirement.
    expect(mockCan).toHaveBeenCalledWith('user-1', 'workspace.admin', {
      type: 'workspace',
      id: 'ws_marlin',
      workspaceId: 'ws_marlin',
    });
  });
});

describe('POST /api/projects/unpublish (authorized)', () => {
  beforeEach(() => {
    mockVerifySession.mockResolvedValue(makeSession());
    mockCan.mockResolvedValue(true);
  });

  it('authorizes publishSite and flips the site back to draft under the session scope', async () => {
    const unpublish = vi.fn().mockResolvedValue(undefined);
    installRepo({ unpublishProject: unpublish });

    const res = await POST(unpublishReq({ siteId: 'site_1' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ siteId: 'site_1', status: 'draft' });
    // Scope comes from the SERVER session, not the body.
    expect(unpublish).toHaveBeenCalledWith(SCOPE, 'site_1');
  });

  it('invalidates the origin render cache for the site\'s surviving subdomain (MT-17)', async () => {
    installRepo({ unpublishProject: vi.fn().mockResolvedValue(undefined) });
    // The SiteDomain row survives an unpublish, so the subdomain is still
    // resolvable and is the tag the resolver cached under.
    resolveSubdomainMock.mockResolvedValue('demo-abc123');

    const res = await POST(unpublishReq({ siteId: 'site_1' }));

    expect(res.status).toBe(200);
    expect(resolveSubdomainMock).toHaveBeenCalledWith('site_1');
    expect(revalidateMock).toHaveBeenCalledWith('demo-abc123');
  });

  it('does not revalidate when the site has no allocated subdomain', async () => {
    installRepo({ unpublishProject: vi.fn().mockResolvedValue(undefined) });
    resolveSubdomainMock.mockResolvedValue(null);

    const res = await POST(unpublishReq({ siteId: 'site_1' }));

    expect(res.status).toBe(200);
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it('400s on a malformed body (no siteId)', async () => {
    const unpublish = vi.fn();
    installRepo({ unpublishProject: unpublish });

    const res = await POST(unpublishReq({}));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_body');
    expect(unpublish).not.toHaveBeenCalled();
  });

  it('rejects an unpublish of a site id owned by another workspace as a 404 envelope', async () => {
    const unpublish = vi.fn().mockRejectedValue(new SiteNotFoundError('site_1'));
    installRepo({ unpublishProject: unpublish });

    const res = await POST(unpublishReq({ siteId: 'site_1' }));

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('site_not_found');
  });

  it('preserves the SiteDomain row: a re-publish after unpublish returns the ORIGINAL slug', async () => {
    process.env.PUBLIC_SITE_BASE_HOST = 'sites.lumitra.co';
    // A single shared repo: ensureSiteDomain is idempotent (MT-06) and returns
    // the SAME slug across publishes; unpublishProject does NOT touch the domain
    // row, so the slug survives the publish -> unpublish -> re-publish cycle.
    const repo = {
      saveProject: vi.fn().mockResolvedValue(undefined),
      publishProject: vi.fn().mockResolvedValue(undefined),
      ensureSiteDomain: vi.fn().mockResolvedValue({ subdomain: 'demo-abc123' }),
      unpublishProject: vi.fn().mockResolvedValue(undefined),
    };
    installRepo(repo);

    const firstPublish = await (
      await PUBLISH(publishReq({ project: PROJECT }))
    ).json();
    const unpublished = await (
      await POST(unpublishReq({ siteId: 'site_1' }))
    ).json();
    const rePublish = await (
      await PUBLISH(publishReq({ project: PROJECT }))
    ).json();

    expect(firstPublish.subdomain).toBe('demo-abc123');
    expect(unpublished).toEqual({ siteId: 'site_1', status: 'draft' });
    // The re-publish reuses the original slug — the domain row was never removed.
    expect(rePublish.subdomain).toBe('demo-abc123');
    expect(rePublish.liveUrl).toBe('https://demo-abc123.sites.lumitra.co');
  });
});
