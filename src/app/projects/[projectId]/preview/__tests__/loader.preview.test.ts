// @vitest-environment node
//
// src/app/projects/[projectId]/preview/__tests__/loader.preview.test.ts
//
// MT-11: the id-aware preview route (`/projects/<id>/preview`) reuses MT-10's
// `loadProjectSnapshot` loader, passing the `/preview` return-path suffix. These
// tests assert the PREVIEW-side contract on that shared loader:
//   - previewing project A returns ONLY project A's pages, scoped to A's
//     session workspace — project B's content never leaks across the boundary,
//   - a cross-workspace (or missing) id resolves to `not_found` -> the page
//     404s, never previewing a foreign tenant's project,
//   - no session fails closed to a login bounce whose return_to points back at
//     THIS preview URL (so login returns the user to the preview, not the editor).
//
// next/headers, the auth-brain client, and the site repository are mocked;
// resolveActiveScope, SiteNotFoundError, and getSnapshot stay REAL, so this is
// the actual scope-derivation + isolation contract without a DB.

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

import { loadProjectSnapshot } from '../../loader';

// Session whose active workspace is ws_a (tenant_group tg_a).
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

// A real ProjectModel node with a uniquely-named page, so the serialized
// snapshot demonstrably carries THIS project's pages and not another's.
function projectNode(id: string, pageName: string) {
  const project = ProjectModel.create({
    id,
    metadata: { title: id, description: '' },
  });
  project.createPage(pageName);
  return project;
}

function setHeaders(map: Record<string, string>) {
  mockHeaderGet.mockImplementation((name: string) => map[name] ?? null);
}

beforeEach(() => {
  vi.clearAllMocks();
  setHeaders({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'app.lumitra.co' });
});

describe('MT-11 preview loader — previews only the requested project', () => {
  it('returns project A\'s pages scoped to A\'s workspace, never project B\'s', async () => {
    mockCookieGet.mockReturnValue({ value: 'sess_a' });
    mockVerifySession.mockResolvedValue(sessionA());
    // The repo is workspace-scoped: previewing 'site-a' yields A's node only.
    mockLoadProject.mockResolvedValue(projectNode('site-a', 'AlphaPage'));

    const result = await loadProjectSnapshot('site-a', '/preview');

    // Loaded under the SERVER-derived scope + the requested id only.
    expect(mockLoadProject).toHaveBeenCalledTimes(1);
    expect(mockLoadProject).toHaveBeenCalledWith(
      { workspaceId: 'ws_a', tenantGroupId: 'tg_a' },
      'site-a',
    );

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    // The previewed snapshot is A's: its id + its page, with no B content.
    expect(result.snapshot.id).toBe('site-a');
    const slugs = Object.values(result.snapshot.pages).map((p) => p.slug);
    expect(slugs).toContain('alphapage');
    expect(slugs).not.toContain('betapage');
  });

  it('maps a cross-workspace / missing id to not_found (no foreign-tenant preview)', async () => {
    mockCookieGet.mockReturnValue({ value: 'sess_a' });
    mockVerifySession.mockResolvedValue(sessionA());
    // 'site-b' lives in another workspace: loadProject filters by workspace_id,
    // so it throws SiteNotFoundError exactly as a missing id would.
    mockLoadProject.mockRejectedValue(new SiteNotFoundError('site-b'));

    const result = await loadProjectSnapshot('site-b', '/preview');

    expect(mockLoadProject).toHaveBeenCalledWith(
      { workspaceId: 'ws_a', tenantGroupId: 'tg_a' },
      'site-b',
    );
    expect(result).toEqual({ status: 'not_found' });
  });
});

describe('MT-11 preview loader — auth bounce returns to the preview URL', () => {
  it('bounces to login with a return_to of THIS preview route when unauthenticated', async () => {
    mockCookieGet.mockReturnValue(undefined);

    const result = await loadProjectSnapshot('site-a', '/preview');

    expect(mockLoadProject).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'unauthenticated',
      loginUrl:
        'https://auth.lumitra.co/login?return_to=https%3A%2F%2Fapp.lumitra.co%2Fprojects%2Fsite-a%2Fpreview',
    });
  });
});
