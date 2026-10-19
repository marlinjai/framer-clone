// @vitest-environment node
//
// src/app/projects/__tests__/loader.test.ts
//
// Unit tests for the /projects dashboard data loader (MT-09). next/headers,
// the auth-brain client, and the site repository are mocked; the scope
// resolution (resolveActiveScope / resolveActiveCompany) is kept REAL, so
// these assert the actual contract without a database or a rendered page:
//   - the listing is scoped to the active COMPANY's workspace, derived from the
//     VERIFIED session (the `framer_company` selector only chooses among its
//     companies holding the auth-brain app grant `sites`),
//   - only an absent or invalid session yields a login URL; a valid session
//     yields the chooser, the not-enabled page or (once) the legacy cookie
//     migration, NEVER a login URL (the 2026-10-19 redirect loop),
//   - the four stateful-flow paths of the selection: forward (choose), change
//     (the listing follows the new company), resume (cookie after reload),
//     re-entry after the grant or membership is removed (a stale cookie falls
//     back safely).

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

const COMPANIES = {
  a: { tenant: 'tenant-a', group: 'tg_a', name: 'Acme', slug: 'acme', ws: 'ws_a' },
  b: { tenant: 'tenant-b', group: 'tg_b', name: 'Beta', slug: 'beta', ws: 'ws_b' },
  c: { tenant: 'tenant-c', group: 'tg_c', name: 'Cactus', slug: 'cactus', ws: 'ws_c' },
  // A company of the same user WITHOUT the `sites` grant.
  d: { tenant: 'tenant-d', group: 'tg_d', name: 'Dune', slug: 'dune', ws: 'ws_d' },
} as const;
type Key = keyof typeof COMPANIES;

/**
 * A session over the given companies (one `main` workspace each). `granted`
 * names the ones holding `sites`; by default a, b and c do and d does not.
 * active_tenant is tenant-b, active_workspace NULL: the production shape of
 * 2026-10-19 (several companies, no active workspace).
 */
function multiSession(
  keys: Key[] = ['a', 'b', 'c', 'd'],
  {
    granted = ['a', 'b', 'c'] as Key[],
    activeTenant = 'tenant-b' as string | null,
  }: { granted?: Key[]; activeTenant?: string | null } = {},
) {
  return {
    user: { id: 'user-m' },
    session: {},
    tenants: keys.map((k) => ({
      id: COMPANIES[k].tenant,
      group_id: COMPANIES[k].group,
      name: COMPANIES[k].name,
      slug: COMPANIES[k].slug,
      app_grants: granted.includes(k) ? ['studio', 'sites'] : ['studio'],
    })),
    workspaces: keys.map((k) => ({
      id: COMPANIES[k].ws,
      tenant_id: COMPANIES[k].tenant,
      name: 'Main',
      slug: 'main',
    })),
    active_tenant: activeTenant ? { id: activeTenant } : null,
    active_workspace: null,
  };
}

/** One granted company, active: the plain case. */
function sessionA() {
  return multiSession(['a'], { granted: ['a'], activeTenant: 'tenant-a' });
}

/** A session that verifies but belongs to no company at all. */
function sessionNoCompany() {
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

function signedIn(session: unknown, cookies: { company?: string; legacyWs?: string } = {}) {
  jar = { lumitra_session: 'sess' };
  if (cookies.company !== undefined) jar.framer_company = cookies.company;
  if (cookies.legacyWs !== undefined) jar.framer_ws = cookies.legacyWs;
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

describe('loadDashboard: company isolation and the sites grant', () => {
  it("lists only the active company's sites, scoped to its workspace", async () => {
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
    expect(result.activeCompany).toEqual({
      id: 'tenant-a',
      name: 'Acme',
      slug: 'acme',
      workspaceId: 'ws_a',
    });
  });

  it('ignores a forged framer_company naming a company outside the session', async () => {
    signedIn(sessionA(), { company: 'tenant-foreign' });

    expectOk(await loadDashboard());

    expect(mockListSites).toHaveBeenCalledWith({ workspaceId: 'ws_a', tenantGroupId: 'tg_a' });
  });

  it('ignores a framer_company naming a company of the session WITHOUT the grant', async () => {
    signedIn(multiSession(), { company: 'tenant-d' });

    const result = await loadDashboard();

    // active_tenant (tenant-b) has the grant, so it is used; never tenant-d.
    expect(expectOk(result).activeCompany.id).toBe('tenant-b');
    expect(mockListSites).toHaveBeenCalledWith({ workspaceId: 'ws_b', tenantGroupId: 'tg_b' });
  });

  it('a forged cookie with no usable fallback renders the chooser, never another tenant', async () => {
    signedIn(multiSession(undefined, { activeTenant: null }), { company: 'tenant-foreign' });

    const result = await loadDashboard();

    expect(result.status).toBe('choose_company');
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
    jar = { lumitra_session: 'sess', framer_company: 'tenant-a', framer_ws: 'ws_a' };
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

  it('selector cookies without a session still go to the login (no migration first)', async () => {
    jar = { framer_company: 'tenant-a', framer_ws: 'ws_a' };

    expect((await loadDashboard()).status).toBe('unauthenticated');
  });

  it('falls back to the Host header when x-forwarded-host is absent', async () => {
    setHeaders({ host: 'app.lumitra.co' });

    expect(await loadDashboard()).toEqual({ status: 'unauthenticated', loginUrl: LOGIN_URL });
  });

  // The loop-impossibility contract, for EVERY valid session shape: 0, 1 or
  // several granted companies x every selector-cookie state x active_tenant
  // null / granted / ungranted, before and after the legacy migration. The
  // loader never returns a login URL; `migrate_legacy` (the only redirect a
  // valid session can get) appears only with a framer_ws cookie and never once
  // `migrated=1` is set, so a valid session reaches a rendered page in at most
  // one redirect.
  const grantSets: Array<[string, Key[]]> = [
    ['no granted company', []],
    ['one granted company', ['a']],
    ['several granted companies', ['a', 'b', 'c']],
  ];
  const cookieStates: Array<[string, { company?: string; legacyWs?: string }]> = [
    ['no cookie', {}],
    ['valid company cookie', { company: 'tenant-a' }],
    ['forged company cookie', { company: 'tenant-foreign' }],
    ['ungranted company cookie', { company: 'tenant-d' }],
    ['empty company cookie', { company: '' }],
    ['legacy cookie of a granted company', { legacyWs: 'ws_a' }],
    ['legacy cookie of an ungranted company', { legacyWs: 'ws_d' }],
    ['forged legacy cookie', { legacyWs: 'ws_foreign' }],
    ['both cookies', { company: 'tenant-b', legacyWs: 'ws_a' }],
  ];
  const activeTenants: Array<[string, string | null]> = [
    ['active_tenant null', null],
    ['active_tenant granted', 'tenant-a'],
    ['active_tenant ungranted', 'tenant-d'],
  ];
  const shapes: Array<[string, () => unknown, { company?: string; legacyWs?: string }]> = [];
  for (const [g, granted] of grantSets) {
    for (const [c, cookies] of cookieStates) {
      for (const [t, activeTenant] of activeTenants) {
        shapes.push([
          `${g}, ${c}, ${t}`,
          () => multiSession(['a', 'b', 'c', 'd'], { granted, activeTenant }),
          cookies,
        ]);
      }
    }
  }
  shapes.push(['no company at all', () => sessionNoCompany(), {}]);
  shapes.push(['no company at all, stale cookies', () => sessionNoCompany(), { company: 'tenant-a', legacyWs: 'ws_a' }]);

  it.each(shapes)('never a login URL, at most one redirect: %s', async (_name, make, cookies) => {
    signedIn(make(), cookies);

    const first = await loadDashboard();
    expect(first.status).not.toBe('unauthenticated');
    expect(JSON.stringify(first)).not.toContain('/login');
    if (cookies.legacyWs) {
      expect(first.status).toBe('migrate_legacy');
    } else {
      expect(first.status).not.toBe('migrate_legacy');
    }

    // Back from the migration handler (even if the browser kept framer_ws):
    // a rendered outcome, never a second redirect.
    const back = await loadDashboard({ legacyMigrated: true });
    expect(['ok', 'choose_company', 'not_enabled']).toContain(back.status);
  });
});

describe('loadDashboard: Lumitra Sites not enabled', () => {
  it('renders the not-enabled page (not a redirect) when no company holds the grant', async () => {
    signedIn(multiSession(['a', 'd'], { granted: [], activeTenant: 'tenant-a' }));

    expect(await loadDashboard()).toEqual({ status: 'not_enabled', grantedWithoutWorkspace: [] });
    expect(mockListSites).not.toHaveBeenCalled();
  });

  it('renders it for a session with no company at all', async () => {
    signedIn(sessionNoCompany());

    expect(await loadDashboard()).toEqual({ status: 'not_enabled', grantedWithoutWorkspace: [] });
  });

  it('names a granted company the user has no workspace in', async () => {
    const s = multiSession(['a', 'b'], { granted: ['b'] });
    s.workspaces = s.workspaces.filter((w) => w.id !== 'ws_b');
    signedIn(s);

    expect(await loadDashboard()).toEqual({
      status: 'not_enabled',
      grantedWithoutWorkspace: ['Beta'],
    });
  });

  it('re-entry after the grant is revoked: the stale company cookie lands on the page', async () => {
    signedIn(multiSession(['a'], { granted: [] }), { company: 'tenant-a' });

    expect((await loadDashboard()).status).toBe('not_enabled');
    expect(mockListSites).not.toHaveBeenCalled();
  });
});

describe('loadDashboard: the retired framer_ws cookie', () => {
  it('a valid session with framer_ws is sent once to the migration handler', async () => {
    signedIn(multiSession(), { legacyWs: 'ws_c' });

    expect(await loadDashboard()).toEqual({
      status: 'migrate_legacy',
      migrateUrl: '/projects/migrate-company',
    });
    expect(mockListSites).not.toHaveBeenCalled();
  });

  it('keeps a deep link through the migration', async () => {
    signedIn(multiSession(), { legacyWs: 'ws_c' });

    expect(await loadDashboard({ next: '/projects/site_3' })).toEqual({
      status: 'migrate_legacy',
      migrateUrl: '/projects/migrate-company?next=%2Fprojects%2Fsite_3',
    });
  });

  it('after the migration (migrated=1) the legacy cookie is still honoured as a selector', async () => {
    signedIn(multiSession(undefined, { activeTenant: null }), { legacyWs: 'ws_c' });

    const result = expectOk(await loadDashboard({ legacyMigrated: true }));

    expect(result.activeCompany.id).toBe('tenant-c');
  });

  it('switch mode never migrates (the choice itself deletes framer_ws)', async () => {
    signedIn(multiSession(), { legacyWs: 'ws_c' });

    expect((await loadDashboard({ forceChooser: true })).status).toBe('choose_company');
  });
});

describe('loadDashboard: company chooser and selection flow', () => {
  it('renders the chooser (not a redirect) with only the granted companies when none is active', async () => {
    signedIn(multiSession(undefined, { activeTenant: null }));

    const result = await loadDashboard();

    expect(result.status).toBe('choose_company');
    if (result.status !== 'choose_company') return;
    expect(result.activeCompanyId).toBeNull();
    expect(result.companies.map((c) => [c.id, c.name])).toEqual([
      ['tenant-a', 'Acme'],
      ['tenant-b', 'Beta'],
      ['tenant-c', 'Cactus'],
    ]);
    expect(mockListSites).not.toHaveBeenCalled();
  });

  it('an active_tenant without the grant is not used to guess', async () => {
    signedIn(multiSession(undefined, { activeTenant: 'tenant-d' }));

    expect((await loadDashboard()).status).toBe('choose_company');
  });

  it('the only granted company is used without asking', async () => {
    signedIn(multiSession(['a', 'd'], { granted: ['a'], activeTenant: 'tenant-d' }));

    expect(expectOk(await loadDashboard()).activeCompany.id).toBe('tenant-a');
  });

  it('forward + resume: the chosen company (framer_company) scopes the listing, also after a reload', async () => {
    signedIn(multiSession(), { company: 'tenant-c' });
    const first = expectOk(await loadDashboard());
    // A reload is a fresh request carrying the same cookie.
    const again = expectOk(await loadDashboard());

    expect(first.activeCompany.id).toBe('tenant-c');
    expect(again.activeCompany.id).toBe('tenant-c');
    expect(mockListSites).toHaveBeenNthCalledWith(1, { workspaceId: 'ws_c', tenantGroupId: 'tg_c' });
    expect(mockListSites).toHaveBeenNthCalledWith(2, { workspaceId: 'ws_c', tenantGroupId: 'tg_c' });
  });

  it('change: switching the company makes the project list follow it', async () => {
    mockListSites.mockImplementation(async (scope: { workspaceId: string }) => [
      { siteId: `site-of-${scope.workspaceId}` },
    ]);

    signedIn(multiSession(), { company: 'tenant-a' });
    const before = expectOk(await loadDashboard());
    signedIn(multiSession(), { company: 'tenant-c' });
    const after = expectOk(await loadDashboard());

    expect(before.sites).toEqual([{ siteId: 'site-of-ws_a' }]);
    expect(after.sites).toEqual([{ siteId: 'site-of-ws_c' }]);
    expect(after.activeCompany.id).toBe('tenant-c');
  });

  it('switch mode shows the chooser with the current company marked, without listing', async () => {
    signedIn(multiSession(), { company: 'tenant-b' });

    const result = await loadDashboard({ forceChooser: true });

    expect(result).toMatchObject({ status: 'choose_company', activeCompanyId: 'tenant-b' });
    expect(mockListSites).not.toHaveBeenCalled();
  });

  it('re-entry after removal, several left: a stale cookie falls back to the chooser', async () => {
    signedIn(multiSession(['a', 'c', 'd'], { activeTenant: null }), { company: 'tenant-b' });

    const result = await loadDashboard();

    expect(result.status).toBe('choose_company');
    expect(mockListSites).not.toHaveBeenCalled();
  });

  it('re-entry after removal, one left: a stale cookie falls back to that one', async () => {
    signedIn(multiSession(['c', 'd'], { activeTenant: null }), { company: 'tenant-b' });

    const result = expectOk(await loadDashboard());

    expect(result.activeCompany.id).toBe('tenant-c');
    expect(mockListSites).toHaveBeenCalledWith({ workspaceId: 'ws_c', tenantGroupId: 'tg_c' });
  });
});

describe('loadDashboard: deep link through the login', () => {
  it('carries a validated next into the login return_to', async () => {
    const result = await loadDashboard({ next: '/projects/site_7/preview' });

    expect(result).toEqual({
      status: 'unauthenticated',
      loginUrl:
        'https://auth.lumitra.co/login?return_to=' +
        encodeURIComponent('https://app.lumitra.co/projects?next=%2Fprojects%2Fsite_7%2Fpreview'),
    });
  });

  it('drops an unsafe next from the return_to', async () => {
    expect(await loadDashboard({ next: 'https://evil.example/x' })).toEqual({
      status: 'unauthenticated',
      loginUrl: LOGIN_URL,
    });
  });
});
