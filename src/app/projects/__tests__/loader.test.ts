// @vitest-environment node
//
// src/app/projects/__tests__/loader.test.ts
//
// Unit tests for the /projects dashboard data loader (MT-09). next/headers,
// the auth-brain client, and the site repository are mocked; the scope
// resolution (resolveActiveScope / resolveActiveWorkspaceId) is kept REAL, so
// these assert the actual contract without a database or a rendered page:
//   - the listing is scoped to the workspace derived from the VERIFIED session
//     (the `framer_ws` selector only chooses among its workspaces),
//   - only an absent or invalid session yields a login URL; a valid session
//     with no resolvable workspace yields the chooser, NEVER a login URL (the
//     2026-10-19 redirect loop),
//   - the four stateful-flow paths of the selection: forward (choose), change
//     (the listing follows the new workspace), resume (cookie after reload),
//     re-entry after membership removal (stale cookie falls back safely).

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

let jar: Record<string, string> = {};
const mockHeaderGet = vi.fn();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined),
  }),
  headers: async () => ({ get: mockHeaderGet }),
}));

import { AuthBrainError, AuthBrainNetworkError } from '@marlinjai/auth-brain-sdk';
import { loadDashboard, type DashboardData } from '../loader';

const LOGIN_URL =
  'https://auth.lumitra.co/login?return_to=https%3A%2F%2Fapp.lumitra.co%2Fprojects';

// A session whose active workspace is ws_a (tenant_group tg_a).
function sessionA() {
  return {
    user: { id: 'user-a' },
    session: {},
    tenants: [{ id: 'tenant-a', group_id: 'tg_a', name: 'Acme', slug: 'acme' }],
    workspaces: [{ id: 'ws_a', tenant_id: 'tenant-a', name: 'Acme', slug: 'acme' }],
    active_tenant: { id: 'tenant-a' },
    active_workspace: { id: 'ws_a' },
  };
}

// The production shape of 2026-10-19: several companies, active_tenant set,
// active_workspace NULL.
function multiSession(workspaceIds = ['ws_a', 'ws_b', 'ws_c']) {
  const all = {
    ws_a: { tenant: 'tenant-a', group: 'tg_a', name: 'Acme', slug: 'acme' },
    ws_b: { tenant: 'tenant-b', group: 'tg_b', name: 'Beta', slug: 'beta' },
    ws_c: { tenant: 'tenant-c', group: 'tg_c', name: 'Cactus', slug: 'cactus' },
  } as const;
  const ids = workspaceIds as Array<keyof typeof all>;
  return {
    user: { id: 'user-m' },
    session: {},
    tenants: ids.map((id) => ({
      id: all[id].tenant,
      group_id: all[id].group,
      name: all[id].name,
      slug: all[id].slug,
    })),
    workspaces: ids.map((id) => ({
      id,
      tenant_id: all[id].tenant,
      name: all[id].name,
      slug: all[id].slug,
    })),
    active_tenant: { id: 'tenant-b' },
    active_workspace: null,
  };
}

// A session that verifies but has no workspace at all.
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

function signedIn(session: unknown, framerWs?: string) {
  jar = { lumitra_session: 'sess' };
  if (framerWs !== undefined) jar.framer_ws = framerWs;
  mockVerifySession.mockResolvedValue(session);
}

function expectOk(result: DashboardData) {
  if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  jar = {};
  setHeaders({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'app.lumitra.co' });
  mockListSites.mockResolvedValue([]);
});

describe('loadDashboard: workspace isolation', () => {
  it('lists only the caller workspace’s sites, scoped to the session workspace', async () => {
    signedIn(sessionA());
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

    const result = expectOk(await loadDashboard());

    expect(mockVerifySession).toHaveBeenCalledWith('sess');
    expect(mockListSites).toHaveBeenCalledTimes(1);
    expect(mockListSites).toHaveBeenCalledWith({ workspaceId: 'ws_a', tenantGroupId: 'tg_a' });
    expect(result.sites).toBe(sitesA);
    expect(result.activeWorkspace).toMatchObject({ id: 'ws_a', companyName: 'Acme' });
  });

  it('ignores a forged framer_ws naming a workspace outside the session', async () => {
    signedIn(sessionA(), 'ws_foreign');

    expectOk(await loadDashboard());

    expect(mockListSites).toHaveBeenCalledWith({ workspaceId: 'ws_a', tenantGroupId: 'tg_a' });
  });

  it('a forged framer_ws on a multi-workspace session renders the chooser, never another tenant', async () => {
    signedIn(multiSession(), 'ws_foreign');

    const result = await loadDashboard();

    expect(result.status).toBe('choose_workspace');
    expect(mockListSites).not.toHaveBeenCalled();
  });
});

describe('loadDashboard: only an absent or invalid session goes to the login', () => {
  it('redirects to the auth-brain login when there is no session cookie', async () => {
    const result = await loadDashboard();

    expect(mockVerifySession).not.toHaveBeenCalled();
    expect(mockListSites).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'unauthenticated', loginUrl: LOGIN_URL });
  });

  it('redirects when the session cookie fails to verify (fail-closed)', async () => {
    signedIn(null);

    expect(await loadDashboard()).toEqual({ status: 'unauthenticated', loginUrl: LOGIN_URL });
    expect(mockListSites).not.toHaveBeenCalled();
  });

  // An auth-brain outage is NOT "signed out": no login URL (that would loop),
  // the page renders the retry notice instead.
  it.each([
    ['a network error', new AuthBrainNetworkError(new Error('ECONNREFUSED'))],
    ['a 503', new AuthBrainError('verifySession failed: 503', 503)],
    ['a 500', new AuthBrainError('verifySession failed: 500', 500)],
    ['a 429', new AuthBrainError('verifySession failed: 429', 429)],
    ['an unreadable body', new SyntaxError('Unexpected token')],
  ])('auth-brain unavailable (%s) -> auth_unavailable, never a login URL', async (_n, err) => {
    jar = { lumitra_session: 'sess', framer_ws: 'ws_a' };
    mockVerifySession.mockRejectedValue(err);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await loadDashboard();

    expect(result).toEqual({ status: 'auth_unavailable' });
    expect(mockListSites).not.toHaveBeenCalled();
  });

  it('a cookie auth-brain rejects with a 4xx (not 401) counts as signed out', async () => {
    jar = { lumitra_session: 'garbage' };
    mockVerifySession.mockRejectedValue(new AuthBrainError('verifySession failed: 400', 400));

    expect(await loadDashboard()).toEqual({ status: 'unauthenticated', loginUrl: LOGIN_URL });
  });

  it('a framer_ws cookie without a session still goes to the login', async () => {
    jar = { framer_ws: 'ws_a' };

    expect((await loadDashboard()).status).toBe('unauthenticated');
  });

  it('falls back to the Host header when x-forwarded-host is absent', async () => {
    setHeaders({ host: 'app.lumitra.co' });

    expect(await loadDashboard()).toEqual({ status: 'unauthenticated', loginUrl: LOGIN_URL });
  });

  // The loop-impossibility contract: for EVERY valid session shape, whatever the
  // selector cookie says, the loader never returns a login URL.
  const validCases: Array<[string, () => unknown, string | undefined]> = [
    ['multi-workspace, no cookie (the production bug)', () => multiSession(), undefined],
    ['multi-workspace, forged cookie', () => multiSession(), 'ws_foreign'],
    ['multi-workspace, empty cookie', () => multiSession(), ''],
    ['multi-workspace, valid cookie', () => multiSession(), 'ws_b'],
    ['single workspace, no active_workspace', () => ({ ...sessionA(), active_workspace: null }), undefined],
    ['active_workspace set', () => sessionA(), undefined],
    ['no workspace at all', () => sessionNoWorkspace(), undefined],
    ['no workspace at all, stale cookie', () => sessionNoWorkspace(), 'ws_a'],
  ];
  it.each(validCases)('never returns a login URL for a valid session: %s', async (_name, make, cookie) => {
    signedIn(make(), cookie);

    const result = await loadDashboard();

    expect(result.status).not.toBe('unauthenticated');
    expect(JSON.stringify(result)).not.toContain('/login');
  });
});

describe('loadDashboard: workspace chooser and selection flow', () => {
  it('renders the chooser (not a redirect) with every workspace when none is active', async () => {
    signedIn(multiSession());

    const result = await loadDashboard();

    expect(result.status).toBe('choose_workspace');
    if (result.status !== 'choose_workspace') return;
    expect(result.activeWorkspaceId).toBeNull();
    expect(result.workspaces.map((w) => [w.id, w.companyName, w.companySlug])).toEqual([
      ['ws_a', 'Acme', 'acme'],
      ['ws_b', 'Beta', 'beta'],
      ['ws_c', 'Cactus', 'cactus'],
    ]);
    expect(mockListSites).not.toHaveBeenCalled();
  });

  it('does not guess from active_tenant', async () => {
    // active_tenant is tenant-b, but the user never picked a workspace.
    signedIn(multiSession());

    expect((await loadDashboard()).status).toBe('choose_workspace');
  });

  it('renders an empty chooser for a session with no workspace at all', async () => {
    signedIn(sessionNoWorkspace());

    const result = await loadDashboard();

    expect(result).toEqual({ status: 'choose_workspace', workspaces: [], activeWorkspaceId: null });
  });

  it('forward + resume: the chosen workspace (framer_ws) scopes the listing, also after a reload', async () => {
    signedIn(multiSession(), 'ws_b');
    const first = expectOk(await loadDashboard());
    // A reload is a fresh request carrying the same cookie.
    const again = expectOk(await loadDashboard());

    expect(first.activeWorkspace.id).toBe('ws_b');
    expect(again.activeWorkspace.id).toBe('ws_b');
    expect(mockListSites).toHaveBeenNthCalledWith(1, { workspaceId: 'ws_b', tenantGroupId: 'tg_b' });
    expect(mockListSites).toHaveBeenNthCalledWith(2, { workspaceId: 'ws_b', tenantGroupId: 'tg_b' });
  });

  it('change: switching the workspace makes the project list follow it', async () => {
    mockListSites.mockImplementation(async (scope: { workspaceId: string }) => [
      { siteId: `site-of-${scope.workspaceId}` },
    ]);

    signedIn(multiSession(), 'ws_a');
    const before = expectOk(await loadDashboard());
    signedIn(multiSession(), 'ws_c');
    const after = expectOk(await loadDashboard());

    expect(before.sites).toEqual([{ siteId: 'site-of-ws_a' }]);
    expect(after.sites).toEqual([{ siteId: 'site-of-ws_c' }]);
    expect(after.activeWorkspace.id).toBe('ws_c');
  });

  it('switch mode shows the chooser with the current workspace marked, without listing', async () => {
    signedIn(multiSession(), 'ws_b');

    const result = await loadDashboard({ forceChooser: true });

    expect(result).toMatchObject({ status: 'choose_workspace', activeWorkspaceId: 'ws_b' });
    expect(mockListSites).not.toHaveBeenCalled();
  });

  it('re-entry after membership removal, several left: stale cookie falls back to the chooser', async () => {
    signedIn(multiSession(['ws_a', 'ws_c']), 'ws_b');

    const result = await loadDashboard();

    expect(result.status).toBe('choose_workspace');
    expect(mockListSites).not.toHaveBeenCalled();
  });

  it('re-entry after membership removal, one left: stale cookie falls back to that one', async () => {
    signedIn(multiSession(['ws_c']), 'ws_b');

    const result = expectOk(await loadDashboard());

    expect(result.activeWorkspace.id).toBe('ws_c');
    expect(mockListSites).toHaveBeenCalledWith({ workspaceId: 'ws_c', tenantGroupId: 'tg_c' });
  });
});
