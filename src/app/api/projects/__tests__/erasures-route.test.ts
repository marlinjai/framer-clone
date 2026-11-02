// @vitest-environment node
//
// src/app/api/projects/__tests__/erasures-route.test.ts
//
// The erase routes (/api/projects/<id>/erasures and .../erasures/search): the
// REAL guard with its owner step (auth-brain and the site lookup mocked), the
// answers, the cache refresh, the proof search, and that the searched value never
// reaches a log line or an error message. The repository is mocked here; what it
// does is proven on a real database in erasePersonalData.itest.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verifySession = vi.fn();
const can = vi.fn();
vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    verifySession: (...args: unknown[]) => verifySession(...args),
    can: (...args: unknown[]) => can(...args),
    verifyApiKey: vi.fn(),
    getCurrentUser: vi.fn(),
  },
}));

const siteFindUnique = vi.fn();
vi.mock('@/server/db', () => ({
  getPrismaClient: () => ({ site: { findUnique: siteFindUnique } }),
}));

vi.mock('@/server/sites', async (importActual) => {
  const actual = await importActual<typeof import('@/server/sites')>();
  return { ...actual, getSiteRepository: vi.fn() };
});

vi.mock('@/server/sites/cachedResolver', () => ({
  resolveSubdomainForSiteId: vi.fn(async () => 'bakery-abc123'),
  revalidateSiteCache: vi.fn(),
  revalidateCustomHostsForSiteId: vi.fn(async () => ['www.bakery.example']),
}));

import {
  ErasePreviewStaleError,
  getSiteRepository,
  NothingToEraseError,
  SiteErasedSinceLoadError,
} from '@/server/sites';
import { EraseQueryError } from '@/server/sites/erase';
import {
  resolveSubdomainForSiteId,
  revalidateCustomHostsForSiteId,
  revalidateSiteCache,
} from '@/server/sites/cachedResolver';
import { GET, POST } from '../[projectId]/erasures/route';
import { POST as SEARCH } from '../[projectId]/erasures/search/route';

const TG = '018f9c10-0000-7000-8000-0000000000e1';
const SITE = { id: 'site_1', workspaceId: 'ws_a', tenantGroupId: TG };
const SCOPE = { workspaceId: 'ws_a', tenantGroupId: TG };
const ctx = { params: Promise.resolve({ projectId: 'site_1' }) };
const VALUE = 'Max Mustermann';
const TOKEN = 'a'.repeat(32);

function session(role: string) {
  return {
    user: { id: 'user-owner' },
    session: {},
    tenants: [{ id: 'tenant-a', app_grants: ['sites'], group_id: TG, role }],
    workspaces: [{ id: 'ws_a', tenant_id: 'tenant-a' }],
    active_tenant: { id: 'tenant-a' },
  };
}

function req(path: string, body?: unknown, method = 'POST'): Request {
  return new Request(`http://app.lumitra.co/api/projects/site_1/${path}`, {
    method,
    headers: {
      host: 'app.lumitra.co',
      cookie: 'lumitra_session=good',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const SEARCH_RESULT = {
  token: TOKEN,
  total: 2,
  erasable: 2,
  blocked: 0,
  matches: [],
  truncated: false,
  locations: [],
};

function installRepo(repo: Record<string, unknown>) {
  vi.mocked(getSiteRepository).mockReturnValue(repo as unknown as ReturnType<typeof getSiteRepository>);
}

let errors: ReturnType<typeof vi.spyOn>;
const savedEditorHost = process.env.EDITOR_HOST;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.EDITOR_HOST = 'app.lumitra.co';
  verifySession.mockResolvedValue(session('owner'));
  can.mockResolvedValue(true);
  siteFindUnique.mockResolvedValue(SITE);
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (savedEditorHost === undefined) delete process.env.EDITOR_HOST;
  else process.env.EDITOR_HOST = savedEditorHost;
});

/** Nothing the routes logged or answered may carry the value. */
async function expectNoValueIn(res: Response) {
  const text = await res.clone().text();
  expect(text).not.toContain(VALUE);
  for (const call of errors.mock.calls) expect(JSON.stringify(call)).not.toContain(VALUE);
}

describe('the owner gate', () => {
  it('refuses an admin who is not the company owner, reading nothing', async () => {
    verifySession.mockResolvedValue(session('admin'));
    const searchPersonalData = vi.fn();
    installRepo({ searchPersonalData });

    const res = await SEARCH(req('erasures/search', { value: VALUE }), ctx);

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('owner_required');
    expect(searchPersonalData).not.toHaveBeenCalled();
  });

  it('refuses before the owner step when OpenFGA says no', async () => {
    can.mockResolvedValue(false);
    installRepo({ erasePersonalData: vi.fn() });
    const res = await POST(req('erasures', { value: VALUE, token: TOKEN }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
    expect(can).toHaveBeenCalledWith('user-owner', 'workspace.admin', expect.objectContaining({ id: 'ws_a' }));
  });

  it('answers 401 without a session and 404 off the editor host', async () => {
    verifySession.mockResolvedValue(null);
    installRepo({});
    expect((await GET(req('erasures', undefined, 'GET'), ctx)).status).toBe(401);
    const offHost = new Request('http://bakery.sites.lumitra.co/api/projects/site_1/erasures', {
      headers: { host: 'bakery.sites.lumitra.co' },
    });
    expect((await GET(offHost, ctx)).status).toBe(404);
  });
});

describe('POST .../erasures/search', () => {
  it('searches in the site scope, uncached', async () => {
    const searchPersonalData = vi.fn().mockResolvedValue(SEARCH_RESULT);
    installRepo({ searchPersonalData });

    const res = await SEARCH(req('erasures/search', { value: VALUE, caseSensitive: true }), ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual(SEARCH_RESULT);
    expect(searchPersonalData).toHaveBeenCalledWith(SCOPE, 'site_1', { value: VALUE, caseSensitive: true });
  });

  it('answers a value outside the bounds with 400 and its code', async () => {
    installRepo({
      searchPersonalData: vi.fn().mockRejectedValue(new EraseQueryError('value_too_short', 'Search for at least 3 characters.')),
    });
    const res = await SEARCH(req('erasures/search', { value: 'ab' }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('value_too_short');
  });

  it('never echoes the value when the database fails', async () => {
    installRepo({ searchPersonalData: vi.fn().mockRejectedValue(new Error(`write failed near "${VALUE}"`)) });
    const res = await SEARCH(req('erasures/search', { value: VALUE }), ctx);
    expect(res.status).toBe(500);
    expect((await res.clone().json()).error.code).toBe('erase_search_failed');
    await expectNoValueIn(res);
  });
});

describe('POST .../erasures', () => {
  const erasure = { erasureId: 'er_1', erased: 2, places: [{ location: 'revision', revision: 3, pageId: null, area: 'settings', path: '/siteSettings/business/managingDirectors/0' }], remaining: 0 };

  it('erases, refreshes the published site, and proves it with a fresh search', async () => {
    const erasePersonalData = vi.fn().mockResolvedValue(erasure);
    const searchPersonalData = vi.fn().mockResolvedValue({ ...SEARCH_RESULT, total: 1, erasable: 0, blocked: 1 });
    installRepo({ erasePersonalData, searchPersonalData });

    const res = await POST(
      req('erasures', { value: VALUE, replacement: '[entfernt]', token: TOKEN, leaveOut: ['b'.repeat(32)] }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      erasureId: 'er_1',
      erased: 2,
      places: erasure.places,
      remaining: 1,
      erasableRemaining: 0,
    });
    expect(erasePersonalData).toHaveBeenCalledWith(SCOPE, 'site_1', {
      query: { value: VALUE, caseSensitive: false },
      replacement: '[entfernt]',
      token: TOKEN,
      leaveOut: ['b'.repeat(32)],
      erasedBy: 'user-owner',
    });
    expect(resolveSubdomainForSiteId).toHaveBeenCalledWith('site_1');
    expect(revalidateSiteCache).toHaveBeenCalledWith('bakery-abc123');
    expect(revalidateCustomHostsForSiteId).toHaveBeenCalledWith('site_1');
  });

  it('allocates no subdomain for a site never published', async () => {
    vi.mocked(resolveSubdomainForSiteId).mockResolvedValueOnce(null);
    installRepo({ erasePersonalData: vi.fn().mockResolvedValue(erasure), searchPersonalData: vi.fn().mockResolvedValue({ ...SEARCH_RESULT, total: 0, erasable: 0 }) });
    const res = await POST(req('erasures', { value: VALUE, token: TOKEN }), ctx);
    expect(res.status).toBe(200);
    expect(revalidateSiteCache).not.toHaveBeenCalled();
    expect(revalidateCustomHostsForSiteId).toHaveBeenCalledWith('site_1');
  });

  it('answers a stale preview with 409 and refreshes nothing', async () => {
    installRepo({ erasePersonalData: vi.fn().mockRejectedValue(new ErasePreviewStaleError()) });
    const res = await POST(req('erasures', { value: VALUE, token: TOKEN }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('erase_preview_stale');
    expect(revalidateCustomHostsForSiteId).not.toHaveBeenCalled();
  });

  it('refreshes the published site on nothing_to_erase, so a repeat recovers a failed refresh', async () => {
    installRepo({ erasePersonalData: vi.fn().mockRejectedValue(new NothingToEraseError()) });
    const res = await POST(req('erasures', { value: VALUE, token: TOKEN }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('nothing_to_erase');
    expect(revalidateSiteCache).toHaveBeenCalledWith('bakery-abc123');
    expect(revalidateCustomHostsForSiteId).toHaveBeenCalledWith('site_1');
  });

  it('says so when the data was erased but the refresh failed', async () => {
    vi.mocked(revalidateCustomHostsForSiteId).mockRejectedValueOnce(new Error('db down'));
    installRepo({ erasePersonalData: vi.fn().mockResolvedValue(erasure), searchPersonalData: vi.fn() });
    const res = await POST(req('erasures', { value: VALUE, token: TOKEN }), ctx);
    expect(res.status).toBe(500);
    const body = await res.clone().json();
    expect(body.error.code).toBe('erase_cache_refresh_failed');
    expect(body.error.message).toMatch(/was erased/);
    await expectNoValueIn(res);
  });

  it('answers remaining null when the proof search fails, without failing the erase', async () => {
    installRepo({ erasePersonalData: vi.fn().mockResolvedValue(erasure), searchPersonalData: vi.fn().mockRejectedValue(new Error(VALUE)) });
    const res = await POST(req('erasures', { value: VALUE, token: TOKEN }), ctx);
    expect(res.status).toBe(200);
    expect(await res.clone().json()).toMatchObject({ erased: 2, remaining: null, erasableRemaining: null });
    await expectNoValueIn(res);
  });

  it('refuses a malformed body before anything runs', async () => {
    const erasePersonalData = vi.fn();
    installRepo({ erasePersonalData });
    expect((await POST(req('erasures', { value: VALUE }), ctx)).status).toBe(400);
    expect((await POST(req('erasures', { value: VALUE, token: 'not-a-token' }), ctx)).status).toBe(400);
    expect((await POST(req('erasures', { value: VALUE, token: TOKEN, replacement: 'x'.repeat(201) }), ctx)).status).toBe(400);
    expect(erasePersonalData).not.toHaveBeenCalled();
  });

  it('maps other repository errors through their own status', async () => {
    installRepo({ erasePersonalData: vi.fn().mockRejectedValue(new SiteErasedSinceLoadError()) });
    const res = await POST(req('erasures', { value: VALUE, token: TOKEN }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('erased_since_load');
  });
});

describe('GET .../erasures', () => {
  it('lists the audit rows for the owner', async () => {
    const rows = [{ id: 'er_1', erasedBy: 'user-owner', erasedCount: 2, remainingCount: 0, places: [], createdAt: '2026-11-02T10:00:00.000Z' }];
    const listErasures = vi.fn().mockResolvedValue(rows);
    installRepo({ listErasures });
    const res = await GET(req('erasures', undefined, 'GET'), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ erasures: rows });
    expect(listErasures).toHaveBeenCalledWith(SCOPE, 'site_1');
  });
});
