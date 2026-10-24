// @vitest-environment node
//
// DELETE /api/projects/<projectId>. The auth-brain client is mocked; the guard
// chain, the REAL SiteRepository.deleteSite, the REAL public resolver and the
// REAL proxy hostname feed (DomainService.listProxyHostnames) run against one
// small in-memory database with the schema's cascade, so the test proves the
// outcomes: the subdomain stops resolving, the custom domains leave the feed
// the proxy host sync reads, company data is untouched, and an editor tab
// still open on the project cannot bring it back.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

// Every permission maps to workspace.admin today, so the auth-brain mock alone
// cannot deny one action and allow another: this wraps the real check and
// denies exactly `deniedAction`.
let deniedAction: string | null = null;
vi.mock('@/lib/auth-check', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth-check')>();
  return {
    ...actual,
    checkWorkspaceAccess: async (...args: Parameters<typeof actual.checkWorkspaceAccess>) =>
      args[2] === deniedAction ? false : actual.checkWorkspaceAccess(...args),
  };
});

const revalidateSiteCache = vi.fn();
const revalidateCustomHostCache = vi.fn();
vi.mock('@/server/sites/cachedResolver', () => ({
  revalidateSiteCache: (...a: unknown[]) => revalidateSiteCache(...a),
  revalidateCustomHostCache: (...a: unknown[]) => revalidateCustomHostCache(...a),
}));

// The form submissions live in the company's tenant schema (another
// connection): the route deletes them after the site commit.
const deleteProjectSubmissions = vi.fn<(tenantGroupId: string, siteId: string) => Promise<number>>(async () => 0);
vi.mock('@/server/forms/projectDelete', () => ({
  deleteProjectSubmissions: (tenantGroupId: string, siteId: string) => deleteProjectSubmissions(tenantGroupId, siteId),
}));

// ---- in-memory database (sites, site_domains with ON DELETE CASCADE) ------
type Site = { id: string; workspaceId: string; tenantGroupId: string; name: string; status: string };
type Domain = {
  id: string;
  siteId: string;
  subdomain: string | null;
  hostname: string | null;
  customHostname: string | null;
  verificationStatus: string;
  verifiedAt: Date | null;
};
let sites: Site[] = [];
let domains: Domain[] = [];

function matches<T extends Record<string, unknown>>(row: T, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'not' in (v as object)) return row[k] !== (v as { not: unknown }).not;
    return row[k] === v;
  });
}

const db = {
  site: {
    findFirst: vi.fn(async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, unknown> }) => {
      const s = sites.find((x) => matches(x, where));
      if (!s) return null;
      return {
        ...s,
        ...(select?.domains ? { domains: domains.filter((d) => d.siteId === s.id) } : {}),
        ...(select?.pages ? { pages: [] } : {}),
      };
    }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => sites.find((s) => s.id === where.id) ?? null),
    updateMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => ({
      count: sites.filter((x) => matches(x, where)).length,
    })),
    deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const gone = sites.filter((s) => matches(s, where));
      sites = sites.filter((s) => !gone.includes(s));
      // ON DELETE CASCADE
      domains = domains.filter((d) => !gone.some((s) => s.id === d.siteId));
      return { count: gone.length };
    }),
    upsert: vi.fn(),
  },
  siteDomain: {
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => domains.find((d) => matches(d, where)) ?? null),
    findMany: vi.fn(async ({ where, skip = 0, take = 1000 }: { where: Record<string, unknown>; skip?: number; take?: number }) =>
      domains.filter((d) => matches(d, where)).slice(skip, skip + take),
    ),
  },
  sitePage: { upsert: vi.fn(), deleteMany: vi.fn() },
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
};

vi.mock('@/server/sites', async (importActual) => {
  const actual = await importActual<typeof import('@/server/sites')>();
  return { ...actual, getSiteRepository: () => new actual.SiteRepository(db as never) };
});

import { AuthBrainError } from '@marlinjai/auth-brain-sdk';
import { DELETE } from '../[projectId]/route';
import { POST as SAVE } from '../save/route';
import { resolvePublishedSiteByKey } from '@/server/sites/publicResolver';
import { DomainService } from '@/server/domains/service';

const ORIGINAL_EDITOR_HOST = process.env.EDITOR_HOST;

function makeSession() {
  return {
    user: { id: 'user-1' },
    session: {},
    tenants: [
      { id: 'tenant-1', app_grants: ['sites'], group_id: 'tg_lumitra' },
      { id: 'tenant-2', app_grants: ['sites'], group_id: 'tg_other' },
    ],
    workspaces: [
      { id: 'ws_marlin', tenant_id: 'tenant-1' },
      { id: 'ws_other', tenant_id: 'tenant-2' },
    ],
    active_tenant: { id: 'tenant-1' },
    active_workspace: { id: 'ws_marlin' },
  };
}

function del(projectId: string, body?: unknown, opts: { host?: string; cookie?: string | null } = {}) {
  const headers: Record<string, string> = { host: opts.host ?? 'app.lumitra.co' };
  if (opts.cookie !== null) headers.cookie = opts.cookie ?? 'lumitra_session=good';
  if (body !== undefined) headers['content-type'] = 'application/json';
  const req = new Request(`http://app.lumitra.co/api/projects/${projectId}`, {
    method: 'DELETE',
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return DELETE(req, { params: Promise.resolve({ projectId }) });
}

const domainService = () => new DomainService({ prisma: db as never, invalidateHost: () => {} });

beforeEach(() => {
  vi.clearAllMocks();
  deniedAction = null;
  process.env.EDITOR_HOST = 'app.lumitra.co';
  sites = [
    { id: 'site_pub', workspaceId: 'ws_marlin', tenantGroupId: 'tg_lumitra', name: 'Bakery', status: 'published' },
    { id: 'site_draft', workspaceId: 'ws_marlin', tenantGroupId: 'tg_lumitra', name: 'Scratch', status: 'draft' },
    { id: 'site_foreign', workspaceId: 'ws_other', tenantGroupId: 'tg_other', name: 'Theirs', status: 'published' },
  ];
  const d = (siteId: string, extra: Partial<Domain>): Domain => ({
    id: `${siteId}-${Math.random()}`,
    siteId,
    subdomain: null,
    hostname: null,
    customHostname: null,
    verificationStatus: 'active',
    verifiedAt: new Date(0),
    ...extra,
  });
  domains = [
    d('site_pub', { subdomain: 'bakery0label' }),
    d('site_pub', { hostname: 'www.bakery.de', customHostname: 'www.bakery.de' }),
    d('site_pub', { hostname: 'shop.bakery.de', customHostname: null, verificationStatus: 'pending', verifiedAt: null }),
    d('site_foreign', { subdomain: 'theirs0label' }),
    d('site_foreign', { hostname: 'www.theirs.com', customHostname: 'www.theirs.com' }),
  ];
  mockVerifySession.mockResolvedValue(makeSession());
  mockCan.mockResolvedValue(true);
  deleteProjectSubmissions.mockImplementation(async () => 0);
});

afterEach(() => {
  if (ORIGINAL_EDITOR_HOST === undefined) delete process.env.EDITOR_HOST;
  else process.env.EDITOR_HOST = ORIGINAL_EDITOR_HOST;
});

describe('DELETE /api/projects/<id> guards', () => {
  it('404s on a published-site host before reading the session', async () => {
    const res = await del('site_draft', undefined, { host: 'www.bakery.de' });
    expect(res.status).toBe(404);
    expect(mockVerifySession).not.toHaveBeenCalled();
    expect(sites).toHaveLength(3);
  });

  it('401s without a session', async () => {
    mockVerifySession.mockResolvedValue(null);
    expect((await del('site_draft', undefined, { cookie: null })).status).toBe(401);
    expect(sites).toHaveLength(3);
  });

  it('403s for a non-admin, and deletes nothing', async () => {
    mockCan.mockResolvedValue(false);
    expect((await del('site_draft')).status).toBe(403);
    expect(sites).toHaveLength(3);
  });

  it.each(['publishSite', 'manageDomain'])('403s without %s (deleting takes the site offline and releases domains)', async (action) => {
    deniedAction = action;
    const res = await del('site_draft');
    expect(res.status).toBe(403);
    expect(sites.find((s) => s.id === 'site_draft')).toBeTruthy();
  });

  it('403s sites_not_enabled when no company has Lumitra Sites', async () => {
    const s = makeSession();
    s.tenants = s.tenants.map((t) => ({ ...t, app_grants: [] }));
    mockVerifySession.mockResolvedValue(s);
    const res = await del('site_draft');
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('sites_not_enabled');
  });

  it('503s authz_unavailable when the permission service is down', async () => {
    mockCan.mockRejectedValue(new AuthBrainError('OpenFGA check failed: 503', 503));
    expect((await del('site_draft')).status).toBe(503);
    expect(sites).toHaveLength(3);
  });

  it("answers 404 for another company's project and leaves it, and its domains, untouched", async () => {
    const res = await del('site_foreign', { confirmName: 'Theirs' });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('site_not_found');
    expect(sites.find((s) => s.id === 'site_foreign')).toBeTruthy();
    expect(domains.filter((x) => x.siteId === 'site_foreign')).toHaveLength(2);
  });

  it('answers 404 for a missing project', async () => {
    expect((await del('site_missing')).status).toBe(404);
  });

  it('400s on a body that is not JSON', async () => {
    const res = await del('site_draft', '{nope');
    expect(res.status).toBe(400);
    expect(sites).toHaveLength(3);
  });
});

describe('DELETE /api/projects/<id> confirmation', () => {
  it('a published project without the typed name is refused (409) and nothing changes', async () => {
    for (const body of [undefined, {}, { confirmName: 'bakery' }, { confirmName: 'Bakery ' }]) {
      const res = await del('site_pub', body);
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error.code).toBe('confirmation_mismatch');
      expect(json.error.currentName).toBe('Bakery');
    }
    expect(sites.find((s) => s.id === 'site_pub')).toBeTruthy();
    expect(revalidateSiteCache).not.toHaveBeenCalled();
    // A refused delete keeps the form submissions too.
    expect(deleteProjectSubmissions).not.toHaveBeenCalled();
  });

  it('an unpublished project is deleted without a typed name', async () => {
    const res = await del('site_draft');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ siteId: 'site_draft', deleted: true, subdomain: null, releasedHostnames: [] });
    expect(sites.find((s) => s.id === 'site_draft')).toBeUndefined();
  });
});

describe('DELETE /api/projects/<id> outcome for a published project', () => {
  it('takes the site offline, releases its domains, invalidates every cache, touches nothing else', async () => {
    // Before: the subdomain resolves and the custom domain is in the proxy feed.
    expect(await resolvePublishedSiteByKey({ kind: 'subdomain', value: 'bakery0label' }, db as never)).not.toBeNull();
    expect((await domainService().listProxyHostnames()).hostnames).toContain('www.bakery.de');

    const res = await del('site_pub', { confirmName: 'Bakery' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      deleted: true,
      subdomain: 'bakery0label',
      releasedHostnames: ['www.bakery.de', 'shop.bakery.de'],
    });

    // The subdomain and the custom host resolve to nothing (the site answers 404).
    expect(await resolvePublishedSiteByKey({ kind: 'subdomain', value: 'bakery0label' }, db as never)).toBeNull();
    expect(await resolvePublishedSiteByKey({ kind: 'custom', value: 'www.bakery.de' }, db as never)).toBeNull();
    // Its domains left the feed the proxy host sync reads; the other company's stayed.
    const feed = (await domainService().listProxyHostnames()).hostnames;
    expect(feed).not.toContain('www.bakery.de');
    expect(feed).toContain('www.theirs.com');
    expect(domains.some((x) => x.siteId === 'site_pub')).toBe(false);
    // Caches invalidated by the names captured before the cascade.
    expect(revalidateSiteCache).toHaveBeenCalledWith('bakery0label');
    expect(revalidateCustomHostCache.mock.calls.map((c) => c[0]).sort()).toEqual(['shop.bakery.de', 'www.bakery.de']);
    // The only delete was the one scoped site row (CMS, commerce and Books
    // carry no site reference; see the PR's data table); the other projects
    // are untouched.
    expect(db.site.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.site.upsert).not.toHaveBeenCalled();
    expect(sites.map((s) => s.id).sort()).toEqual(['site_draft', 'site_foreign']);
  });

  it("deletes the project's form submissions in its tenant schema after the site commit", async () => {
    deleteProjectSubmissions.mockImplementation(async () => {
      // The site row is already gone when the submissions are deleted.
      expect(sites.find((s) => s.id === 'site_pub')).toBeUndefined();
      return 3;
    });
    const res = await del('site_pub', { confirmName: 'Bakery' });
    expect(res.status).toBe(200);
    expect(deleteProjectSubmissions).toHaveBeenCalledTimes(1);
    expect(deleteProjectSubmissions).toHaveBeenCalledWith('tg_lumitra', 'site_pub');
  });

  it('a failure deleting the form submissions is loud (500), the caches are still invalidated', async () => {
    deleteProjectSubmissions.mockImplementation(async () => {
      throw new Error('tenant schema unreachable');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await del('site_pub', { confirmName: 'Bakery' });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('delete_submissions_failed');
    expect(sites.find((s) => s.id === 'site_pub')).toBeUndefined();
    expect(revalidateSiteCache).toHaveBeenCalledWith('bakery0label');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('a cache invalidation failure is loud (500), and every other host is still invalidated', async () => {
    revalidateSiteCache.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await del('site_pub', { confirmName: 'Bakery' });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('delete_cache_failed');
    expect(revalidateCustomHostCache).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('invalidates the captured hosts a second time a few seconds later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      expect((await del('site_pub', { confirmName: 'Bakery' })).status).toBe(200);
      expect(revalidateSiteCache).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5_000);
      expect(revalidateSiteCache).toHaveBeenCalledTimes(2);
      expect(revalidateCustomHostCache).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an editor tab still open on the deleted project cannot bring it back on Save', async () => {
    expect((await del('site_draft')).status).toBe(200);
    const res = await SAVE(
      new Request('http://app.lumitra.co/api/projects/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'lumitra_session=good', host: 'app.lumitra.co' },
        body: JSON.stringify({
          project: {
            id: 'site_draft',
            metadata: { title: 'Scratch', description: '', createdAt: 1, updatedAt: 2 },
            pages: {},
          },
        }),
      }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toBe(
      'This project does not exist (any more): it may have been deleted. Your changes were not saved.',
    );
    expect(db.site.upsert).not.toHaveBeenCalled();
    expect(sites.find((s) => s.id === 'site_draft')).toBeUndefined();
  });

  it('deleting twice: the second answers 404', async () => {
    expect((await del('site_draft')).status).toBe(200);
    expect((await del('site_draft')).status).toBe(404);
  });
});
