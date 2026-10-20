// @vitest-environment node
//
// src/app/projects/[projectId]/__tests__/loader.test.ts
//
// Unit tests for the per-project editor route's data loader (MT-10).
// next/headers, the auth-brain client, and the site repository are mocked;
// resolveActiveScope, SiteNotFoundError, and mobx-state-tree's getSnapshot are
// kept REAL, so these assert the actual scope-derivation + isolation + 404 +
// auth-bounce contract without a database or a rendered server component:
//   - a session for workspace A loads THAT project scoped to A's workspace and
//     returns a snapshot carrying the project's pages,
//   - a projectId that loadProject reports as SiteNotFoundError (missing OR
//     cross-workspace) resolves to `not_found` -> the page 404s, never another
//     tenant's project,
//   - no session / invalid session fail-closed to the login bounce with a
//     return_to of THIS project URL,
//   - a VALID session with no resolvable company (none picked, or none holding
//     the `sites` grant) goes to the dashboard (chooser or not-enabled page,
//     with this path as `next`), NEVER the login (2026-10-19 loop),
//   - the `framer_company` selector scopes the load only for a company of the
//     session that holds the grant (its workspace),
//   - a link to a project of another granted company offers the switch; one
//     of a company without the grant stays a 404.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import ProjectModel from '@/models/ProjectModel';
import { SiteNotFoundError } from '@/server/sites';
import { AuthBrainError, AuthBrainNetworkError } from '@marlinjai/auth-brain-sdk';

const mockVerifySession = vi.fn();
vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    verifySession: (...args: unknown[]) => mockVerifySession(...args),
    can: vi.fn(),
    verifyApiKey: vi.fn(),
    getCurrentUser: vi.fn(),
  },
}));

const mockLoadProject = vi.fn();
// Where the site lives (page settings URL preview); a never-published draft.
const mockGetSiteAddress = vi.fn(
  async (): Promise<{ host: string | null; everPublished: boolean }> => ({
    host: null,
    everPublished: false,
  }),
);
const mockFindSiteWorkspaceAmong = vi.fn();
vi.mock('@/server/sites', async (importActual) => {
  const actual = await importActual<typeof import('@/server/sites')>();
  return {
    ...actual,
    getSiteRepository: () => ({
      loadProject: mockLoadProject,
      findSiteWorkspaceAmong: mockFindSiteWorkspaceAmong,
      getSiteAddress: mockGetSiteAddress,
    }),
  };
});

const mockCookieGet = vi.fn();
const mockHeaderGet = vi.fn();
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: mockCookieGet }),
  headers: async () => ({ get: mockHeaderGet }),
}));

import { loadProjectSnapshot } from '../loader';

// A session whose only (granted) company is tenant-a, workspace ws_a, group tg_a.
function sessionA() {
  return {
    user: { id: 'user-a' },
    session: {},
    tenants: [{ id: 'tenant-a', app_grants: ['sites'], group_id: 'tg_a' }],
    workspaces: [{ id: 'ws_a', tenant_id: 'tenant-a' }],
    active_tenant: { id: 'tenant-a' },
    active_workspace: { id: 'ws_a' },
  };
}

// A session that verifies but has no company at all.
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

// A real ProjectModel node (the editor working copy loadProject returns) with a
// distinctly-named page, so getSnapshot(project) carries THAT project's pages.
function projectNode(id: string) {
  const project = ProjectModel.create({
    id,
    metadata: { title: 'A One', description: '' },
  });
  project.createPage('Landing'); // slug 'landing'
  return project;
}

function setHeaders(map: Record<string, string>) {
  mockHeaderGet.mockImplementation((name: string) => map[name] ?? null);
}

beforeEach(() => {
  vi.clearAllMocks();
  setHeaders({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'app.lumitra.co' });
});

describe('loadProjectSnapshot — loads the caller-workspace project', () => {
  it('loads the project scoped to the session workspace and returns its pages', async () => {
    mockCookieGet.mockReturnValue({ value: 'sess_a' });
    mockVerifySession.mockResolvedValue(sessionA());
    mockLoadProject.mockResolvedValue(projectNode('site-a1'));

    const result = await loadProjectSnapshot('site-a1');

    // The session cookie was verified.
    expect(mockVerifySession).toHaveBeenCalledWith('sess_a');
    // loadProject was called with the scope DERIVED from session A and the
    // requested id — never a client-supplied workspace.
    expect(mockLoadProject).toHaveBeenCalledTimes(1);
    expect(mockLoadProject).toHaveBeenCalledWith(
      { workspaceId: 'ws_a', tenantGroupId: 'tg_a' },
      'site-a1',
    );

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    // The serialized snapshot is THAT project's: id + its page.
    expect(result.snapshot.id).toBe('site-a1');
    const slugs = Object.values(result.snapshot.pages).map((p) => p.slug);
    expect(slugs).toContain('landing');
  });

  it('also returns where the site lives, read under the same scope', async () => {
    mockCookieGet.mockReturnValue({ value: 'sess_a' });
    mockVerifySession.mockResolvedValue(sessionA());
    mockLoadProject.mockResolvedValue(projectNode('site-a1'));
    mockGetSiteAddress.mockResolvedValueOnce({
      host: 'abc123.sites.lumitra.co',
      everPublished: true,
    });

    const result = await loadProjectSnapshot('site-a1');

    expect(mockGetSiteAddress).toHaveBeenCalledWith(
      { workspaceId: 'ws_a', tenantGroupId: 'tg_a' },
      'site-a1',
    );
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.site).toEqual({ host: 'abc123.sites.lumitra.co', everPublished: true });
  });
});

describe('loadProjectSnapshot — cross-workspace / missing id 404s', () => {
  it('maps SiteNotFoundError (missing OR foreign-tenant id) to not_found', async () => {
    mockCookieGet.mockReturnValue({ value: 'sess_a' });
    mockVerifySession.mockResolvedValue(sessionA());
    // loadProject filters by workspace_id, so a cross-workspace id throws.
    mockLoadProject.mockRejectedValue(new SiteNotFoundError('site-foreign'));

    const result = await loadProjectSnapshot('site-foreign');

    expect(mockLoadProject).toHaveBeenCalledWith(
      { workspaceId: 'ws_a', tenantGroupId: 'tg_a' },
      'site-foreign',
    );
    expect(result).toEqual({ status: 'not_found' });
  });

  it('does not swallow a non-isolation error into a 404', async () => {
    mockCookieGet.mockReturnValue({ value: 'sess_a' });
    mockVerifySession.mockResolvedValue(sessionA());
    mockLoadProject.mockRejectedValue(new Error('db is down'));

    await expect(loadProjectSnapshot('site-a1')).rejects.toThrow('db is down');
  });
});

describe('loadProjectSnapshot — fail-closed auth bounce', () => {
  it('bounces to login (return_to of THIS project) when there is no session cookie', async () => {
    mockCookieGet.mockReturnValue(undefined);

    const result = await loadProjectSnapshot('site-a1');

    expect(mockVerifySession).not.toHaveBeenCalled();
    expect(mockLoadProject).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'unauthenticated',
      loginUrl:
        'https://auth.lumitra.co/login?return_to=https%3A%2F%2Fapp.lumitra.co%2Fprojects%2Fsite-a1',
    });
  });

  it('bounces when the session cookie fails to verify (fail-closed)', async () => {
    mockCookieGet.mockReturnValue({ value: 'bad' });
    mockVerifySession.mockResolvedValue(null);

    const result = await loadProjectSnapshot('site-a1');

    expect(mockLoadProject).not.toHaveBeenCalled();
    expect(result.status).toBe('unauthenticated');
  });

  it('auth-brain unavailable -> auth_unavailable, never the login (no outage loop)', async () => {
    mockCookieGet.mockReturnValue({ value: 'sess_a' });
    mockVerifySession.mockRejectedValue(new AuthBrainNetworkError(new Error('timeout')));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await loadProjectSnapshot('site-a1');

    expect(result).toEqual({ status: 'auth_unavailable' });
    expect(mockLoadProject).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('preview: a 502 from auth-brain is auth_unavailable too', async () => {
    mockCookieGet.mockReturnValue({ value: 'sess_a' });
    mockVerifySession.mockRejectedValue(new AuthBrainError('verifySession failed: 502', 502));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await loadProjectSnapshot('site-a1', '/preview')).toEqual({ status: 'auth_unavailable' });
    errSpy.mockRestore();
  });

  it('a cookie auth-brain rejects with a 4xx (not 401) bounces to login', async () => {
    mockCookieGet.mockReturnValue({ value: 'garbage' });
    mockVerifySession.mockRejectedValue(new AuthBrainError('verifySession failed: 400', 400));

    expect((await loadProjectSnapshot('site-a1')).status).toBe('unauthenticated');
  });

  it('sends a valid session with no company to the dashboard, never the login', async () => {
    mockCookieGet.mockReturnValue({ value: 'sess_a' });
    mockVerifySession.mockResolvedValue(sessionNoWorkspace());

    const result = await loadProjectSnapshot('site-a1');

    expect(mockLoadProject).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'choose_company',
      chooserUrl: '/projects?next=%2Fprojects%2Fsite-a1',
    });
  });

  it('falls back to the Host header when x-forwarded-host is absent', async () => {
    setHeaders({ host: 'app.lumitra.co' });
    mockCookieGet.mockReturnValue(undefined);

    const result = await loadProjectSnapshot('site-a1');

    expect(result).toEqual({
      status: 'unauthenticated',
      loginUrl:
        'https://auth.lumitra.co/login?return_to=https%3A%2F%2Fapp.lumitra.co%2Fprojects%2Fsite-a1',
    });
  });
});

// Two companies with Sites (a, b) and one without (c), no active company.
function multiSession() {
  return {
    user: { id: 'user-m' },
    session: {},
    tenants: [
      { id: 'tenant-a', app_grants: ['sites'], group_id: 'tg_a' },
      { id: 'tenant-b', app_grants: ['sites'], group_id: 'tg_b' },
      { id: 'tenant-c', app_grants: ['studio'], group_id: 'tg_c' },
    ],
    workspaces: [
      { id: 'ws_a', tenant_id: 'tenant-a' },
      { id: 'ws_b', tenant_id: 'tenant-b' },
      { id: 'ws_c', tenant_id: 'tenant-c' },
    ],
    active_tenant: null,
    active_workspace: null,
  };
}

function cookieJar(values: Record<string, string>) {
  mockCookieGet.mockImplementation((name: string) =>
    name in values ? { name, value: values[name] } : undefined,
  );
}

describe('loadProjectSnapshot: app-local active company (framer_company)', () => {
  it('several companies without a selection go to the chooser, never the login', async () => {
    cookieJar({ lumitra_session: 'sess' });
    mockVerifySession.mockResolvedValue(multiSession());

    const result = await loadProjectSnapshot('site-a1');

    expect(result.status).toBe('choose_company');
    expect(JSON.stringify(result)).not.toContain('/login');
    expect(mockLoadProject).not.toHaveBeenCalled();
  });

  it("loads under the selected company's workspace", async () => {
    cookieJar({ lumitra_session: 'sess', framer_company: 'tenant-b' });
    mockVerifySession.mockResolvedValue(multiSession());
    mockLoadProject.mockResolvedValue(projectNode('site-b1'));

    const result = await loadProjectSnapshot('site-b1');

    expect(result.status).toBe('ok');
    expect(mockLoadProject).toHaveBeenCalledWith(
      { workspaceId: 'ws_b', tenantGroupId: 'tg_b' },
      'site-b1',
    );
  });

  it('ignores a forged selector (company outside the session)', async () => {
    cookieJar({ lumitra_session: 'sess', framer_company: 'tenant-foreign' });
    mockVerifySession.mockResolvedValue(multiSession());

    const result = await loadProjectSnapshot('site-a1');

    expect(result.status).toBe('choose_company');
    expect(mockLoadProject).not.toHaveBeenCalled();
  });

  it('carries the preview suffix into the chooser `next`', async () => {
    cookieJar({ lumitra_session: 'sess' });
    mockVerifySession.mockResolvedValue(multiSession());

    const result = await loadProjectSnapshot('site-a1', '/preview');

    expect(result).toEqual({
      status: 'choose_company',
      chooserUrl: '/projects?next=%2Fprojects%2Fsite-a1%2Fpreview',
    });
  });
});

describe('loadProjectSnapshot: a project in another of the caller\'s companies', () => {
  it('offers the forced chooser with this path as next (not a 404)', async () => {
    cookieJar({ lumitra_session: 'sess', framer_company: 'tenant-a' });
    mockVerifySession.mockResolvedValue(multiSession());
    mockLoadProject.mockRejectedValue(new SiteNotFoundError('site-b1'));
    mockFindSiteWorkspaceAmong.mockResolvedValue('ws_b');

    const result = await loadProjectSnapshot('site-b1', '/preview');

    // Only the workspaces of the caller's OTHER companies with Sites are
    // searched: never ws_c, whose company lacks the grant.
    expect(mockFindSiteWorkspaceAmong).toHaveBeenCalledWith('site-b1', ['ws_b']);
    expect(result).toEqual({
      status: 'choose_company',
      chooserUrl: '/projects?switch=1&next=%2Fprojects%2Fsite-b1%2Fpreview',
    });
  });

  it('keeps the 404 for a site outside the session (no leak)', async () => {
    cookieJar({ lumitra_session: 'sess', framer_company: 'tenant-a' });
    mockVerifySession.mockResolvedValue(multiSession());
    mockLoadProject.mockRejectedValue(new SiteNotFoundError('site-x'));
    mockFindSiteWorkspaceAmong.mockResolvedValue(null);

    expect(await loadProjectSnapshot('site-x')).toEqual({ status: 'not_found' });
  });

  it('a single-company session does not look anywhere else', async () => {
    mockCookieGet.mockReturnValue({ value: 'sess_a' });
    mockVerifySession.mockResolvedValue(sessionA());
    mockLoadProject.mockRejectedValue(new SiteNotFoundError('site-x'));

    expect(await loadProjectSnapshot('site-x')).toEqual({ status: 'not_found' });
    expect(mockFindSiteWorkspaceAmong).not.toHaveBeenCalled();
  });
});

describe('loadProjectSnapshot: the sites grant', () => {
  it('a session whose companies lack the grant goes to the dashboard (not-enabled page), never the login', async () => {
    cookieJar({ lumitra_session: 'sess', framer_company: 'tenant-c' });
    mockVerifySession.mockResolvedValue({
      ...multiSession(),
      tenants: multiSession().tenants.map((t) => ({ ...t, app_grants: [] })),
      active_tenant: { id: 'tenant-c' },
    });

    const result = await loadProjectSnapshot('site-c1');

    expect(result).toEqual({
      status: 'choose_company',
      chooserUrl: '/projects?next=%2Fprojects%2Fsite-c1',
    });
    expect(mockLoadProject).not.toHaveBeenCalled();
  });

  it('a selector naming a company without the grant is ignored', async () => {
    cookieJar({ lumitra_session: 'sess', framer_company: 'tenant-c' });
    mockVerifySession.mockResolvedValue(multiSession());

    expect((await loadProjectSnapshot('site-c1')).status).toBe('choose_company');
    expect(mockLoadProject).not.toHaveBeenCalled();
  });

  it('the retired framer_ws cookie still selects its company until it is migrated', async () => {
    cookieJar({ lumitra_session: 'sess', framer_ws: 'ws_b' });
    mockVerifySession.mockResolvedValue(multiSession());
    mockLoadProject.mockResolvedValue(projectNode('site-b1'));

    expect((await loadProjectSnapshot('site-b1')).status).toBe('ok');
    expect(mockLoadProject).toHaveBeenCalledWith(
      { workspaceId: 'ws_b', tenantGroupId: 'tg_b' },
      'site-b1',
    );
  });

  it('a project of a company without the grant stays a 404 (nothing to switch to)', async () => {
    cookieJar({ lumitra_session: 'sess', framer_company: 'tenant-a' });
    mockVerifySession.mockResolvedValue(multiSession());
    mockLoadProject.mockRejectedValue(new SiteNotFoundError('site-c1'));
    mockFindSiteWorkspaceAmong.mockResolvedValue(null);

    expect(await loadProjectSnapshot('site-c1')).toEqual({ status: 'not_found' });
    expect(mockFindSiteWorkspaceAmong).toHaveBeenCalledWith('site-c1', ['ws_b']);
  });
});
