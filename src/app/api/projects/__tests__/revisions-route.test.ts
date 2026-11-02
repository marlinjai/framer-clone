// @vitest-environment node
//
// src/app/api/projects/__tests__/revisions-route.test.ts
//
// GET and POST /api/projects/<id>/revisions: the published versions of a site and
// the rollback. The guard (src/server/domains/guard.ts) and the repository are
// mocked: the guard's own contract has its own tests, and what the repository
// does is proven on a real database in publishedCopy.itest.ts. These assert which
// permission each verb asks for, the answers, and the cache invalidation.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuthorize = vi.fn();
vi.mock('@/server/domains/guard', () => ({
  authorizeDomainProject: (...args: unknown[]) => mockAuthorize(...args),
}));

vi.mock('@/server/sites', async (importActual) => {
  const actual = await importActual<typeof import('@/server/sites')>();
  return { ...actual, getSiteRepository: vi.fn() };
});

vi.mock('@/server/sites/cachedResolver', () => ({
  revalidateSiteCache: vi.fn(),
  revalidateCustomHostsForSiteId: vi.fn(async () => []),
}));

import { getSiteRepository, SiteNotFoundError, SiteRevisionNotFoundError } from '@/server/sites';
import { revalidateCustomHostsForSiteId, revalidateSiteCache } from '@/server/sites/cachedResolver';
import { GET, POST } from '../[projectId]/revisions/route';
import { GET as GET_ONE } from '../[projectId]/revisions/[number]/route';

const PROJECT = { id: 'site_1', workspaceId: 'ws_marlin', tenantGroupId: 'tg_lumitra' };
const SCOPE = { workspaceId: 'ws_marlin', tenantGroupId: 'tg_lumitra' };
const ctx = { params: Promise.resolve({ projectId: 'site_1' }) };

function get(): Request {
  return new Request('http://localhost/api/projects/site_1/revisions');
}

function post(body: unknown): Request {
  return new Request('http://localhost/api/projects/site_1/revisions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function installRepo(repo: Record<string, unknown>) {
  vi.mocked(getSiteRepository).mockReturnValue({
    ensureSiteDomain: vi.fn().mockResolvedValue({ subdomain: 'demo-abc123' }),
    ...repo,
  } as unknown as ReturnType<typeof getSiteRepository>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthorize.mockResolvedValue({ ok: true, project: PROJECT });
});

describe('GET /api/projects/<id>/revisions', () => {
  it('lists under viewSite, uncached', async () => {
    const list = { live: 2, status: 'published', revisions: [] };
    const listRevisions = vi.fn().mockResolvedValue(list);
    installRepo({ listRevisions });

    const res = await GET(get(), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(list);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(mockAuthorize).toHaveBeenCalledWith(expect.anything(), 'site_1', 'viewSite');
    expect(listRevisions).toHaveBeenCalledWith(SCOPE, 'site_1');
  });

  it('answers what the guard answers, reading nothing', async () => {
    const listRevisions = vi.fn();
    installRepo({ listRevisions });
    mockAuthorize.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });

    expect((await GET(get(), ctx)).status).toBe(403);
    expect(listRevisions).not.toHaveBeenCalled();
  });

  it('surfaces a repository failure as the error envelope', async () => {
    installRepo({ listRevisions: vi.fn().mockRejectedValue(new SiteNotFoundError('site_1')) });
    const res = await GET(get(), ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('site_not_found');

    installRepo({ listRevisions: vi.fn().mockRejectedValue(new Error('db down')) });
    const failed = await GET(get(), ctx);
    expect(failed.status).toBe(500);
    expect((await failed.json()).error.code).toBe('revisions_failed');
  });
});

describe('POST /api/projects/<id>/revisions (rollback)', () => {
  it('needs publishSite, the same gate as publish', async () => {
    const rollbackToRevision = vi.fn();
    installRepo({ rollbackToRevision });
    mockAuthorize.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });

    expect((await POST(post({ number: 1 }), ctx)).status).toBe(403);
    expect(mockAuthorize).toHaveBeenCalledWith(expect.anything(), 'site_1', 'publishSite');
    expect(rollbackToRevision).not.toHaveBeenCalled();
  });

  it('rolls back under the project scope, then invalidates the subdomain and every custom host', async () => {
    const rollbackToRevision = vi.fn().mockResolvedValue(undefined);
    installRepo({ rollbackToRevision });

    const res = await POST(post({ number: 3 }), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ siteId: 'site_1', status: 'published', live: 3 });
    expect(rollbackToRevision).toHaveBeenCalledWith(SCOPE, 'site_1', 3);
    expect(revalidateSiteCache).toHaveBeenCalledWith('demo-abc123');
    expect(revalidateCustomHostsForSiteId).toHaveBeenCalledWith('site_1');
    expect(rollbackToRevision.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(revalidateSiteCache).mock.invocationCallOrder[0],
    );
  });

  it('a failed custom-host revalidation is surfaced: those hosts would keep the bad version', async () => {
    installRepo({ rollbackToRevision: vi.fn().mockResolvedValue(undefined) });
    vi.mocked(revalidateCustomHostsForSiteId).mockRejectedValueOnce(new Error('db hiccup'));

    const res = await POST(post({ number: 3 }), ctx);

    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('rollback_failed');
  });

  it.each([[{}], [{ number: 0 }], [{ number: -1 }], [{ number: 1.5 }], [{ number: '1' }], [{ number: 2147483648 }]])('400s on %j', async (body) => {
    const rollbackToRevision = vi.fn();
    installRepo({ rollbackToRevision });

    const res = await POST(post(body), ctx);

    expect(res.status).toBe(400);
    expect(rollbackToRevision).not.toHaveBeenCalled();
  });

  it('404s on an unknown version, invalidating nothing', async () => {
    installRepo({ rollbackToRevision: vi.fn().mockRejectedValue(new SiteRevisionNotFoundError('site_1', 9)) });

    const res = await POST(post({ number: 9 }), ctx);

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('revision_not_found');
    expect(revalidateSiteCache).not.toHaveBeenCalled();
  });
});

describe('GET /api/projects/<id>/revisions/<number> (the warnings)', () => {
  const one = (number: string) => GET_ONE(
    new Request(`http://localhost/api/projects/site_1/revisions/${number}`),
    { params: Promise.resolve({ projectId: 'site_1', number }) },
  );

  it('answers the check of that version under viewSite', async () => {
    const check = { missingImpressum: true, placeholders: [] };
    const checkRevision = vi.fn().mockResolvedValue(check);
    installRepo({ checkRevision });

    const res = await one('3');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ number: 3, check });
    expect(mockAuthorize).toHaveBeenCalledWith(expect.anything(), 'site_1', 'viewSite');
    expect(checkRevision).toHaveBeenCalledWith(SCOPE, 'site_1', 3);
  });

  it('answers what the guard answers, reading nothing', async () => {
    const checkRevision = vi.fn();
    installRepo({ checkRevision });
    mockAuthorize.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });

    expect((await one('3')).status).toBe(403);
    expect(checkRevision).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', '1.5', 'abc', '2147483648', '99999999999'])('%s is a version no site has: 404', async (number) => {
    const checkRevision = vi.fn();
    installRepo({ checkRevision });

    const res = await one(number);

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('revision_not_found');
    expect(checkRevision).not.toHaveBeenCalled();
  });

  it('surfaces a repository failure as the error envelope', async () => {
    installRepo({ checkRevision: vi.fn().mockRejectedValue(new Error('db down')) });
    const res = await one('3');
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('revision_check_failed');
  });
});
