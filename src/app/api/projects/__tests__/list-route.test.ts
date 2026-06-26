// @vitest-environment node
//
// src/app/api/projects/__tests__/list-route.test.ts
//
// Unit tests for GET /api/projects/list (the session-guarded read path behind
// the TopBar workspace switcher). The auth-brain client (verifySession) and the
// site repository are mocked, so these assert the REAL guard + scope-resolution
// contract without a database:
//   - 401 with no session,
//   - the listing is scoped to the SERVER session's workspace (the query is
//     filtered by the resolved scope, so it returns ONLY the caller's sites),
//   - an explicit `?workspace=` re-scopes via resolveScopeForWorkspace and a
//     workspace NOT in the session is a 403 (never another tenant's sites).
// resolveActiveScope / resolveScopeForWorkspace are kept REAL (only
// getSiteRepository is mocked) so the actual scope wiring is exercised.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockVerifySession = vi.fn();
vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    verifySession: (...args: unknown[]) => mockVerifySession(...args),
    can: vi.fn(),
    verifyApiKey: vi.fn(),
    getCurrentUser: vi.fn(),
  },
}));

vi.mock('@/server/sites', async (importActual) => {
  const actual = await importActual<typeof import('@/server/sites')>();
  return { ...actual, getSiteRepository: vi.fn() };
});

import { getSiteRepository } from '@/server/sites';
import { GET } from '../list/route';

const getRepoMock = vi.mocked(getSiteRepository);

const MARLIN_SITES = [
  {
    siteId: 'site_1',
    name: 'Demo',
    description: '',
    status: 'draft',
    lumitraEnabled: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  },
];

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

function listReq(opts?: { cookie?: string | null; workspace?: string }): Request {
  const headers: Record<string, string> = {};
  if (opts?.cookie !== null) {
    headers['cookie'] = opts?.cookie ?? 'lumitra_session=good';
  }
  const qs = opts?.workspace ? `?workspace=${encodeURIComponent(opts.workspace)}` : '';
  return new Request(`http://t/api/projects/list${qs}`, { method: 'GET', headers });
}

function installListSites(listSites: unknown) {
  getRepoMock.mockReturnValue({ listSites } as unknown as ReturnType<
    typeof getSiteRepository
  >);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifySession.mockReset();
});

describe('GET /api/projects/list', () => {
  it('401s when there is no session', async () => {
    mockVerifySession.mockResolvedValue(null);
    const listSites = vi.fn();
    installListSites(listSites);

    const res = await GET(listReq({ cookie: null }));

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthorized');
    expect(listSites).not.toHaveBeenCalled();
  });

  it("returns ONLY the caller's sites, scoped to the session's active workspace", async () => {
    mockVerifySession.mockResolvedValue(makeSession());
    const listSites = vi.fn().mockResolvedValue(MARLIN_SITES);
    installListSites(listSites);

    const res = await GET(listReq());

    expect(res.status).toBe(200);
    const json = await res.json();
    // Returns exactly the caller's sites (Dates serialize to ISO strings).
    expect(json.sites).toHaveLength(1);
    expect(json.sites[0].siteId).toBe('site_1');
    // The query is scoped to the SERVER session's workspace, not the client.
    expect(listSites).toHaveBeenCalledWith({
      workspaceId: 'ws_marlin',
      tenantGroupId: 'tg_lumitra',
    });
  });

  it('re-scopes to an explicit ?workspace that the session contains', async () => {
    mockVerifySession.mockResolvedValue(makeSession());
    const listSites = vi.fn().mockResolvedValue(MARLIN_SITES);
    installListSites(listSites);

    const res = await GET(listReq({ workspace: 'ws_marlin' }));

    expect(res.status).toBe(200);
    expect(listSites).toHaveBeenCalledWith({
      workspaceId: 'ws_marlin',
      tenantGroupId: 'tg_lumitra',
    });
  });

  it("403s (never another tenant's sites) when ?workspace is not in the session", async () => {
    mockVerifySession.mockResolvedValue(makeSession());
    const listSites = vi.fn();
    installListSites(listSites);

    const res = await GET(listReq({ workspace: 'ws_someone_else' }));

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('no_active_workspace');
    expect(listSites).not.toHaveBeenCalled();
  });
});
