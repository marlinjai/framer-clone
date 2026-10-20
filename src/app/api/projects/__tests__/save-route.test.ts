// @vitest-environment node
//
// src/app/api/projects/__tests__/save-route.test.ts
//
// Unit tests for POST /api/projects/save (the NON-DESTRUCTIVE write path). The
// auth-brain client (verifySession + can) and the site repository are mocked, so
// these assert the REAL guard + scope-resolution contract without a database:
//   - the scope is derived from the SERVER session (active workspace -> tenant
//     -> tenant_group), never from the client body,
//   - the snapshot round-trips through saveProject and NOTHING else — save NEVER
//     publishes (publishProject is never called),
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
import { POST } from '../save/route';

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
    tenants: [{ id: 'tenant-1', app_grants: ['sites'], group_id: 'tg_lumitra' }],
    workspaces: [{ id: 'ws_marlin', tenant_id: 'tenant-1' }],
    active_tenant: { id: 'tenant-1' },
    active_workspace: { id: 'ws_marlin' },
  };
}

function saveReq(body: unknown, opts?: { cookie?: string | null }): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // Default to a present session cookie; tests that need "no session" pass null.
  if (opts?.cookie !== null) {
    headers['cookie'] = opts?.cookie ?? 'lumitra_session=good';
  }
  return new Request('http://t/api/projects/save', {
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

describe('POST /api/projects/save guard', () => {
  it('401s when there is no session', async () => {
    mockVerifySession.mockResolvedValue(null);
    const save = vi.fn();
    installRepo({ saveProject: save, publishProject: vi.fn() });

    const res = await POST(saveReq({ project: PROJECT }, { cookie: null }));

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthorized');
    expect(save).not.toHaveBeenCalled();
  });

  it('403s when the session is valid but the user is not a workspace admin', async () => {
    mockVerifySession.mockResolvedValue(makeSession());
    mockCan.mockResolvedValue(false);
    const save = vi.fn();
    installRepo({ saveProject: save, publishProject: vi.fn() });

    const res = await POST(saveReq({ project: PROJECT }));

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
    expect(save).not.toHaveBeenCalled();
    // The admin check uses the real editSite -> workspace.admin requirement.
    expect(mockCan).toHaveBeenCalledWith('user-1', 'workspace.admin', {
      type: 'workspace',
      id: 'ws_marlin',
      workspaceId: 'ws_marlin',
    });
  });

  it('503s authz_unavailable (never 403) when OpenFGA cannot answer', async () => {
    const { AuthBrainError } = await import('@marlinjai/auth-brain-sdk');
    mockVerifySession.mockResolvedValue(makeSession());
    mockCan.mockRejectedValue(new AuthBrainError('OpenFGA check failed: 503', 503));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const save = vi.fn();
    const publish = vi.fn();
    installRepo({ saveProject: save, publishProject: publish });

    const res = await POST(saveReq({ project: PROJECT }));

    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('authz_unavailable');
    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('POST /api/projects/save (authorized)', () => {
  beforeEach(() => {
    mockVerifySession.mockResolvedValue(makeSession());
    mockCan.mockResolvedValue(true);
  });

  it('persists the snapshot through saveProject under the session scope and NEVER publishes', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const publish = vi.fn().mockResolvedValue(undefined);
    installRepo({ saveProject: save, publishProject: publish });

    const res = await POST(saveReq({ project: PROJECT }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      siteId: 'site_1',
      savedPages: ['', 'about'],
    });
    // Scope comes from the SERVER session, not the body.
    // ...and only UPDATES an existing site: it never creates (or re-creates a
    // deleted) one; creating is POST /api/projects.
    expect(save).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({ id: 'site_1' }),
      { mustExist: true },
    );
    // Save is non-destructive: it must NEVER flip the site to published.
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not claim a status in the success envelope (save leaves it untouched)', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    installRepo({ saveProject: save, publishProject: vi.fn() });

    const res = await POST(saveReq({ project: PROJECT }));
    const json = await res.json();

    expect(json).not.toHaveProperty('status');
  });

  it('preserves the full opaque page snapshot when saving (no field stripping)', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    installRepo({ saveProject: save, publishProject: vi.fn() });

    await POST(saveReq({ project: PROJECT }));

    const savedProject = save.mock.calls[0][1];
    expect(savedProject.pages.page_home.appComponentTree).toEqual({ kind: 'frame' });
  });

  it('400s on a malformed body (no project)', async () => {
    const save = vi.fn();
    installRepo({ saveProject: save, publishProject: vi.fn() });

    const res = await POST(saveReq({}));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_body');
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects a save of a site id owned by another workspace as a 404 envelope', async () => {
    const save = vi.fn().mockRejectedValue(new SiteNotFoundError('site_1'));
    const publish = vi.fn();
    installRepo({ saveProject: save, publishProject: publish });

    const res = await POST(saveReq({ project: PROJECT }));

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('site_not_found');
    expect(publish).not.toHaveBeenCalled();
  });
});

// The save path enforces the slug rules itself (src/lib/pages/slug.ts), so a
// request built by hand cannot store a slug the editor would refuse. The REAL
// repository runs here over a fake Prisma, so the route + repository + rules
// are exercised together without a database.
describe('POST /api/projects/save slug rules (real repository)', () => {
  // Bypass the module mock: the real class, imported from its own module.
  async function installRealRepo(stored: Record<string, string>) {
    const { SiteRepository } = await vi.importActual<typeof import('@/server/sites/repository')>(
      '@/server/sites/repository',
    );
    const prisma = {
      site: {
        findUnique: vi.fn(async () => ({ id: 'site_1', workspaceId: 'ws_marlin', redirects: [] })),
        upsert: vi.fn(async () => ({})),
        // The editor's Save only UPDATEs an existing site (mustExist).
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      sitePage: {
        findMany: vi.fn(async () => Object.entries(stored).map(([pageId, slug]) => ({ pageId, slug }))),
        upsert: vi.fn(async () => ({})),
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
      siteDomain: { findFirst: vi.fn(async () => ({ id: 'dom_1' })) },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    };
    getRepoMock.mockReturnValue(new SiteRepository(prisma as never) as ReturnType<typeof getSiteRepository>);
    return prisma;
  }

  beforeEach(() => {
    mockVerifySession.mockResolvedValue(makeSession());
    mockCan.mockResolvedValue(true);
  });

  it.each([
    ['uppercase and spaces', 'About Us'],
    ['a reserved path', 'api'],
    ['a second home page (empty slug)', ''],
    ['a leading slash', '/about'],
  ])('400s invalid_page_slug for %s and writes nothing', async (_label, slug) => {
    const prisma = await installRealRepo({ page_home: '', page_about: 'about' });
    const body = { project: { ...PROJECT, pages: { ...PROJECT.pages, page_about: { slug } } } };

    const res = await POST(saveReq(body));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_page_slug');
    expect(prisma.site.upsert).not.toHaveBeenCalled();
    expect(prisma.site.updateMany).not.toHaveBeenCalled();
    expect(prisma.sitePage.upsert).not.toHaveBeenCalled();
  });

  it('400s a request that drops the home page', async () => {
    const prisma = await installRealRepo({ page_home: '', page_about: 'about' });
    const body = { project: { ...PROJECT, pages: { page_about: { slug: 'about' } } } };

    const res = await POST(saveReq(body));

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/home page cannot be deleted/);
    expect(prisma.site.upsert).not.toHaveBeenCalled();
    expect(prisma.site.updateMany).not.toHaveBeenCalled();
  });

  it('saves a valid slug change and records the old path as a redirect', async () => {
    const prisma = await installRealRepo({ page_home: '', page_about: 'about' });
    const body = { project: { ...PROJECT, pages: { ...PROJECT.pages, page_about: { slug: 'about-us' } } } };

    const res = await POST(saveReq(body));

    expect(res.status).toBe(200);
    const siteUpdate = (prisma.site.updateMany.mock.calls[0] as unknown as [{ data: { redirects: unknown } }])[0];
    expect(siteUpdate.data.redirects).toEqual([
      { from: 'about', pageId: 'page_about', createdAt: expect.any(String) },
    ]);
  });
});

describe('save of a deleted project', () => {
  it('is refused with a message the editor shows as is, and nothing is written', async () => {
    mockVerifySession.mockResolvedValue(makeSession());
    mockCan.mockResolvedValue(true);
    const { SiteGoneError } = await import('@/server/sites');
    const save = vi.fn().mockRejectedValue(new SiteGoneError());
    const publish = vi.fn();
    installRepo({ saveProject: save, publishProject: publish });

    const res = await POST(saveReq({ project: PROJECT }));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('site_not_found');
    expect(body.error.message).toBe(
      'This project does not exist (any more): it may have been deleted. Your changes were not saved.',
    );
    expect(publish).not.toHaveBeenCalled();
  });
});
