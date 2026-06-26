// @vitest-environment node
//
// src/app/projects/__tests__/loader.test.ts
//
// Unit tests for the /projects dashboard data loader (MT-09). next/headers,
// the auth-brain client, and the site repository are mocked; resolveActiveScope
// is kept REAL, so these assert the actual scope-derivation + isolation +
// auth-bounce contract without a database or a rendered server component:
//   - a session for workspace A loads ONLY workspace-A sites: listSites is
//     called with the scope derived from THAT session (active workspace ->
//     tenant -> tenant_group), never a client-supplied workspace,
//   - no session (no cookie) bounces to the auth-brain login with a return_to
//     of this dashboard,
//   - an invalid/expired session (verify -> null) and a session with no active
//     workspace both fail-closed to the same login bounce.

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

const mockListSites = vi.fn();
vi.mock('@/server/sites', async (importActual) => {
  const actual = await importActual<typeof import('@/server/sites')>();
  return {
    ...actual,
    getSiteRepository: () => ({ listSites: mockListSites }),
  };
});

const mockCookieGet = vi.fn();
const mockHeaderGet = vi.fn();
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: mockCookieGet }),
  headers: async () => ({ get: mockHeaderGet }),
}));

import { loadDashboard } from '../loader';

// A session whose active workspace is ws_a (tenant_group tg_a).
function sessionA() {
  return {
    user: { id: 'user-a' },
    session: {},
    tenants: [{ id: 'tenant-a', group_id: 'tg_a' }],
    workspaces: [{ id: 'ws_a', tenant_id: 'tenant-a' }],
    active_tenant: { id: 'tenant-a' },
    active_workspace: { id: 'ws_a' },
  };
}

// A session that verifies but has no resolvable active workspace.
function sessionNoWorkspace() {
  return {
    user: { id: 'user-a' },
    session: {},
    tenants: [],
    workspaces: [],
    active_tenant: null,
    active_workspace: null,
  };
}

function setHeaders(map: Record<string, string>) {
  mockHeaderGet.mockImplementation((name: string) => map[name] ?? null);
}

beforeEach(() => {
  vi.clearAllMocks();
  setHeaders({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'app.lumitra.co' });
});

describe('loadDashboard — workspace isolation', () => {
  it('lists only the caller workspace’s sites, scoped to the session workspace', async () => {
    mockCookieGet.mockReturnValue({ value: 'sess_a' });
    mockVerifySession.mockResolvedValue(sessionA());
    const sitesA = [
      {
        siteId: 'site-a1',
        name: 'A One',
        description: '',
        status: 'draft',
        lumitraEnabled: false,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-02'),
      },
    ];
    mockListSites.mockResolvedValue(sitesA);

    const result = await loadDashboard();

    // The session cookie was verified.
    expect(mockVerifySession).toHaveBeenCalledWith('sess_a');
    // listSites was called with the scope DERIVED from session A, never a
    // client-supplied workspace.
    expect(mockListSites).toHaveBeenCalledTimes(1);
    expect(mockListSites).toHaveBeenCalledWith({
      workspaceId: 'ws_a',
      tenantGroupId: 'tg_a',
    });
    expect(result).toEqual({ authenticated: true, sites: sitesA });
  });
});

describe('loadDashboard — fail-closed auth bounce', () => {
  it('redirects to the auth-brain login with a return_to of /projects when there is no session cookie', async () => {
    mockCookieGet.mockReturnValue(undefined);

    const result = await loadDashboard();

    expect(mockVerifySession).not.toHaveBeenCalled();
    expect(mockListSites).not.toHaveBeenCalled();
    expect(result).toEqual({
      authenticated: false,
      loginUrl:
        'https://auth.lumitra.co/login?return_to=https%3A%2F%2Fapp.lumitra.co%2Fprojects',
    });
  });

  it('redirects when the session cookie fails to verify (fail-closed)', async () => {
    mockCookieGet.mockReturnValue({ value: 'bad' });
    mockVerifySession.mockResolvedValue(null);

    const result = await loadDashboard();

    expect(mockListSites).not.toHaveBeenCalled();
    expect(result).toEqual({
      authenticated: false,
      loginUrl:
        'https://auth.lumitra.co/login?return_to=https%3A%2F%2Fapp.lumitra.co%2Fprojects',
    });
  });

  it('redirects when verifySession throws (never a 500)', async () => {
    mockCookieGet.mockReturnValue({ value: 'boom' });
    mockVerifySession.mockRejectedValue(new Error('network'));

    const result = await loadDashboard();

    expect(mockListSites).not.toHaveBeenCalled();
    expect(result.authenticated).toBe(false);
  });

  it('redirects when the session has no resolvable active workspace', async () => {
    mockCookieGet.mockReturnValue({ value: 'sess_a' });
    mockVerifySession.mockResolvedValue(sessionNoWorkspace());

    const result = await loadDashboard();

    expect(mockListSites).not.toHaveBeenCalled();
    expect(result.authenticated).toBe(false);
  });

  it('falls back to the Host header when x-forwarded-host is absent', async () => {
    setHeaders({ host: 'app.lumitra.co' });
    mockCookieGet.mockReturnValue(undefined);

    const result = await loadDashboard();

    expect(result).toEqual({
      authenticated: false,
      loginUrl:
        'https://auth.lumitra.co/login?return_to=https%3A%2F%2Fapp.lumitra.co%2Fprojects',
    });
  });
});
