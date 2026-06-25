// @vitest-environment node
//
// src/app/api/projects/__tests__/publish-route.test.ts
//
// Unit tests for POST /api/projects/publish (the publish write path). The
// auth-brain client (verifySession + can) and the site repository are mocked, so
// these assert the REAL guard + scope-resolution contract without a database:
//   - the scope is derived from the SERVER session (active workspace -> tenant
//     -> tenant_group), never from the client body,
//   - the snapshot round-trips through saveProject then publishProject,
//   - 401 with no session, 403 when not a workspace admin, 400 on a bad body,
//   - a cross-workspace site id is rejected as the typed 404 envelope.
// resolveActiveScope and the typed error mapping are kept REAL (only
// getSiteRepository is mocked) so the actual scope/error wiring is exercised.

import { describe, it, expect, beforeEach, vi } from 'vitest';

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

import { getSiteRepository, SiteNotFoundError } from '@/server/sites';
import { POST } from '../publish/route';

const getRepoMock = vi.mocked(getSiteRepository);

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

function publishReq(body: unknown, opts?: { cookie?: string | null }): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // Default to a present session cookie; tests that need "no session" pass null.
  if (opts?.cookie !== null) {
    headers['cookie'] = opts?.cookie ?? 'lumitra_session=good';
  }
  return new Request('http://t/api/projects/publish', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function installRepo(repo: { saveProject?: unknown; publishProject?: unknown }) {
  getRepoMock.mockReturnValue(repo as ReturnType<typeof getSiteRepository>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifySession.mockReset();
  mockCan.mockReset();
});

describe('POST /api/projects/publish guard', () => {
  it('401s when there is no session', async () => {
    mockVerifySession.mockResolvedValue(null);
    const save = vi.fn();
    installRepo({ saveProject: save, publishProject: vi.fn() });

    const res = await POST(publishReq({ project: PROJECT }, { cookie: null }));

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthorized');
    expect(save).not.toHaveBeenCalled();
  });

  it('403s when the session is valid but the user is not a workspace admin', async () => {
    mockVerifySession.mockResolvedValue(makeSession());
    mockCan.mockResolvedValue(false);
    const save = vi.fn();
    installRepo({ saveProject: save, publishProject: vi.fn() });

    const res = await POST(publishReq({ project: PROJECT }));

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
    expect(save).not.toHaveBeenCalled();
    // The admin check uses the real publishSite -> workspace.admin requirement.
    expect(mockCan).toHaveBeenCalledWith('user-1', 'workspace.admin', {
      type: 'workspace',
      id: 'ws_marlin',
      workspaceId: 'ws_marlin',
    });
  });
});

describe('POST /api/projects/publish (authorized)', () => {
  beforeEach(() => {
    mockVerifySession.mockResolvedValue(makeSession());
    mockCan.mockResolvedValue(true);
  });

  it('round-trips the snapshot through saveProject then publishProject under the session scope', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const publish = vi.fn().mockResolvedValue(undefined);
    installRepo({ saveProject: save, publishProject: publish });

    const res = await POST(publishReq({ project: PROJECT }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      siteId: 'site_1',
      status: 'published',
      publishedPages: ['', 'about'],
    });
    // Scope comes from the SERVER session, not the body.
    expect(save).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({ id: 'site_1' }),
    );
    expect(publish).toHaveBeenCalledWith(SCOPE, 'site_1');
    // publish runs AFTER the snapshot is persisted.
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(
      publish.mock.invocationCallOrder[0],
    );
  });

  it('preserves the full opaque page snapshot when saving (no field stripping)', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    installRepo({ saveProject: save, publishProject: vi.fn() });

    await POST(publishReq({ project: PROJECT }));

    const savedProject = save.mock.calls[0][1];
    expect(savedProject.pages.page_home.appComponentTree).toEqual({ kind: 'frame' });
  });

  it('400s on a malformed body (no project)', async () => {
    const save = vi.fn();
    installRepo({ saveProject: save, publishProject: vi.fn() });

    const res = await POST(publishReq({}));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_body');
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects a publish of a site id owned by another workspace as a 404 envelope', async () => {
    const save = vi.fn().mockRejectedValue(new SiteNotFoundError('site_1'));
    const publish = vi.fn();
    installRepo({ saveProject: save, publishProject: publish });

    const res = await POST(publishReq({ project: PROJECT }));

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('site_not_found');
    expect(publish).not.toHaveBeenCalled();
  });
});
