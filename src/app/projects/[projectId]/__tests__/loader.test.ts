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
//   - no session / invalid session / no active workspace all fail-closed to the
//     same login bounce with a return_to of THIS project URL.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import ProjectModel from '@/models/ProjectModel';
import { SiteNotFoundError } from '@/server/sites';

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
vi.mock('@/server/sites', async (importActual) => {
  const actual = await importActual<typeof import('@/server/sites')>();
  return {
    ...actual,
    getSiteRepository: () => ({ loadProject: mockLoadProject }),
  };
});

const mockCookieGet = vi.fn();
const mockHeaderGet = vi.fn();
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: mockCookieGet }),
  headers: async () => ({ get: mockHeaderGet }),
}));

import { loadProjectSnapshot } from '../loader';

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

  it('bounces when verifySession throws (never a 500)', async () => {
    mockCookieGet.mockReturnValue({ value: 'boom' });
    mockVerifySession.mockRejectedValue(new Error('network'));

    const result = await loadProjectSnapshot('site-a1');

    expect(mockLoadProject).not.toHaveBeenCalled();
    expect(result.status).toBe('unauthenticated');
  });

  it('bounces when the session has no resolvable active workspace', async () => {
    mockCookieGet.mockReturnValue({ value: 'sess_a' });
    mockVerifySession.mockResolvedValue(sessionNoWorkspace());

    const result = await loadProjectSnapshot('site-a1');

    expect(mockLoadProject).not.toHaveBeenCalled();
    expect(result.status).toBe('unauthenticated');
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
