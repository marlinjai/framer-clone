// Workspace-scoping tests for the site repository (P1b).
//
// The contract under test is the HARD ISOLATION BOUNDARY, not Prisma itself:
//   - every read filters by workspace_id,
//   - every write stamps BOTH workspace_id AND tenant_group_id,
//   - a cross-workspace load/save/delete is a deny, never a leak,
//   - an empty scope is rejected.
// Prisma is mocked so there is no database; we assert on the where/data the
// repository passes down.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import { Prisma } from '@prisma/client';
import ProjectModel from '@/models/ProjectModel';
import { REVISIONS_KEPT, SiteRepository, type TenantScope } from '../repository';
import { resetLiveBusForTests, subscribeSite } from '../liveBus';
import { announcePlan, resetLivePlansForTests } from '@/server/mcp/livePlans';
import {
  SiteNotFoundError,
  SiteNameConflictError,
  SiteGoneError,
  SiteChangedError,
  SiteVersionRequiredError,
  SiteErasedSinceLoadError,
  SiteDeleteConfirmationError,
  InvalidTenantScopeError,
  InvalidPageSlugError,
  InvalidSiteThemeError,
  SubdomainAllocationError,
} from '../errors';

/** A Prisma unique-constraint violation against the subdomain index. */
function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['subdomain'] },
  });
}

const SCOPE: TenantScope = {
  workspaceId: 'ws_marlin',
  tenantGroupId: 'tg_lumitra',
};

// A minimal fake PrismaClient: each model method is a vi.fn we assert on. The
// transaction helper just invokes the callback with the same fake (the
// repository's tx usage is single-connection sequential writes, no real atomicity
// needed for the scoping assertions).
function makeFakePrisma() {
  const site = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  };
  const sitePage = {
    // The stored slugs saveProject checks the incoming ones against; none by default.
    findMany: vi.fn(async () => [] as Array<{ pageId: string; slug: string }>),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  };
  const siteDomain = {
    findFirst: vi.fn(async () => null as unknown),
    create: vi.fn(),
    deleteMany: vi.fn(),
  };
  const siteRevision = {
    findFirst: vi.fn(async () => null as unknown),
    create: vi.fn(async () => ({ id: 'rev_new' }) as unknown),
    deleteMany: vi.fn(),
  };
  const prisma = {
    $queryRaw: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []),
    site,
    sitePage,
    siteDomain,
    siteRevision,
    // Typed with the options argument (tests read it from the calls); the fake only runs the callback.
    $transaction: vi.fn<(fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => Promise<unknown>>(async (fn): Promise<unknown> => fn(prisma)),
  };
  return prisma;
}

let prisma: ReturnType<typeof makeFakePrisma>;
let repo: SiteRepository;

beforeEach(() => {
  prisma = makeFakePrisma();
  // Cast: the fake implements only the methods the repository touches.
  repo = new SiteRepository(prisma as never);
});

describe('SiteRepository scope validation', () => {
  it('rejects an empty workspaceId', async () => {
    await expect(
      repo.listSites({ workspaceId: '', tenantGroupId: 'tg' }),
    ).rejects.toBeInstanceOf(InvalidTenantScopeError);
  });

  it('rejects an empty tenantGroupId', async () => {
    await expect(
      repo.listSites({ workspaceId: 'ws', tenantGroupId: '' }),
    ).rejects.toBeInstanceOf(InvalidTenantScopeError);
  });
});

describe('SiteRepository.listSites', () => {
  it('filters by workspace_id', async () => {
    prisma.site.findMany.mockResolvedValue([]);
    await repo.listSites(SCOPE);
    expect(prisma.site.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: 'ws_marlin' } }),
    );
  });

  it('carries the subdomain and connected custom domains (what a delete would take offline)', async () => {
    const at = new Date('2026-10-20T00:00:00Z');
    prisma.site.findMany.mockResolvedValue([
      {
        id: 'site_1', name: 'Bakery', description: '', status: 'published', lumitraEnabled: false,
        createdAt: at, updatedAt: at,
        domains: [{ subdomain: 'k3j9x0abcd12', hostname: null }, { subdomain: null, hostname: 'www.bakery.de' }],
      },
      {
        id: 'site_2', name: 'Draft', description: '', status: 'draft', lumitraEnabled: false,
        createdAt: at, updatedAt: at, domains: [],
      },
    ]);
    const [a, b] = await repo.listSites(SCOPE);
    expect(a).toMatchObject({ siteId: 'site_1', subdomain: 'k3j9x0abcd12', customDomains: ['www.bakery.de'] });
    expect(b).toMatchObject({ siteId: 'site_2', subdomain: null, customDomains: [] });
  });
});

describe('SiteRepository.loadProject', () => {
  it('filters the read by id AND workspace_id', async () => {
    prisma.site.findFirst.mockResolvedValue({
      id: 'site_1',
      name: 'S',
      description: '',
      analyticsProjectId: null,
      ingestionEndpoint: null,
      apiKeyRef: null,
      lumitraEnabled: false,
      projectCreatedAt: new Date('2026-06-24T00:00:00.000Z'),
      projectUpdatedAt: new Date('2026-06-24T00:00:00.000Z'),
      pages: [],
    });
    await repo.loadProject(SCOPE, 'site_1');
    expect(prisma.site.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'site_1', workspaceId: 'ws_marlin' },
      }),
    );
  });

  it('throws SiteNotFoundError when the scoped read returns null', async () => {
    // A site in another workspace returns null because workspace_id is in the
    // where-clause: indistinguishable from a missing site, by design.
    prisma.site.findFirst.mockResolvedValue(null);
    await expect(repo.loadProject(SCOPE, 'site_other_ws')).rejects.toBeInstanceOf(
      SiteNotFoundError,
    );
  });
});

describe('SiteRepository.saveProject', () => {
  function makeProject() {
    const p = ProjectModel.create({
      id: 'site_save',
      metadata: { title: 'Save Me', description: '' },
      pages: {},
    });
    p.createPage('Home');
    return p;
  }

  it('stamps BOTH workspace_id and tenant_group_id on the site create', async () => {
    prisma.site.findUnique.mockResolvedValue(null);
    prisma.site.upsert.mockResolvedValue({});
    prisma.sitePage.upsert.mockResolvedValue({});
    prisma.sitePage.deleteMany.mockResolvedValue({ count: 0 });

    await repo.saveProject(SCOPE, makeProject(), { expectedVersion: 1 });

    const upsertArg = prisma.site.upsert.mock.calls[0][0];
    expect(upsertArg.create.workspaceId).toBe('ws_marlin');
    expect(upsertArg.create.tenantGroupId).toBe('tg_lumitra');
  });

  it('stamps BOTH ids on every page create', async () => {
    prisma.site.findUnique.mockResolvedValue(null);
    prisma.site.upsert.mockResolvedValue({});
    prisma.sitePage.upsert.mockResolvedValue({});
    prisma.sitePage.deleteMany.mockResolvedValue({ count: 0 });

    await repo.saveProject(SCOPE, makeProject(), { expectedVersion: 1 });

    expect(prisma.sitePage.upsert).toHaveBeenCalled();
    const pageArg = prisma.sitePage.upsert.mock.calls[0][0];
    expect(pageArg.create.workspaceId).toBe('ws_marlin');
    expect(pageArg.create.tenantGroupId).toBe('tg_lumitra');
  });

  it('refuses to overwrite a site owned by another workspace', async () => {
    // The id exists but in a different workspace: refuse, do not overwrite.
    prisma.site.findUnique.mockResolvedValue({ erasureEpoch: 0, version: 1,
      id: 'site_save',
      workspaceId: 'ws_someone_else',
    });
    await expect(repo.saveProject(SCOPE, makeProject(), { expectedVersion: 1 })).rejects.toBeInstanceOf(
      SiteNotFoundError,
    );
    expect(prisma.site.upsert).not.toHaveBeenCalled();
  });

  it('upserts by id (a re-save of an existing same-workspace site updates, not duplicates)', async () => {
    // The id already exists IN the caller's workspace: the save proceeds and
    // upserts by id, so a second publish updates the one row rather than
    // creating a duplicate.
    prisma.site.findUnique.mockResolvedValue({ erasureEpoch: 0, version: 1,
      id: 'site_save',
      workspaceId: 'ws_marlin',
    });
    prisma.site.upsert.mockResolvedValue({});
    prisma.sitePage.upsert.mockResolvedValue({});
    prisma.sitePage.deleteMany.mockResolvedValue({ count: 0 });

    await repo.saveProject(SCOPE, makeProject(), { expectedVersion: 1 });

    const upsertArg = prisma.site.upsert.mock.calls[0][0];
    expect(upsertArg.where).toEqual({ id: 'site_save' });
  });

  it("runs beforeAnnounce after the commit, then ends skeleton plans whose page is gone, then announces the write; refuses a later announcement checked on the older read", async () => {
    resetLiveBusForTests();
    resetLivePlansForTests();
    prisma.site.findUnique.mockResolvedValue({ erasureEpoch: 0, version: 1, id: 'site_save', workspaceId: 'ws_marlin' });
    prisma.site.upsert.mockResolvedValue({});
    prisma.sitePage.upsert.mockResolvedValue({});
    prisma.sitePage.deleteMany.mockResolvedValue({ count: 0 });
    const order: string[] = [];
    subscribeSite('site_save', (event, data) => order.push(event === 'plan:update' ? `plan:${(data as { ended?: string }).ended}` : event));
    const plan = { siteId: 'site_save', scope: SCOPE, agentId: 'agent-a', label: 'Claude', pageId: 'page-gone', sections: [{ ref: 'hero', title: 'Hero', kind: 'hero' as const }] };
    expect(announcePlan(plan).ok).toBe(true);
    order.length = 0;
    const { version } = await repo.saveProject(SCOPE, makeProject(), { expectedVersion: 1, beforeAnnounce: (v) => order.push(`before:${v}`) });
    expect(order).toEqual([`before:${version}`, 'plan:anchor_removed', 'site:version']);
    // An announcement whose anchor was read before that write is refused.
    expect(announcePlan({ ...plan, checkedVersion: version - 1 })).toMatchObject({ ok: false, code: 'site_changed' });
    resetLivePlansForTests();
    resetLiveBusForTests();
  });
});

describe('SiteRepository.saveProject keeps the theme and the head items a body lacks', () => {
  const STORED_THEME = { mode: 'dark', tokens: [{ id: 'ab12cd34', name: 'Ink', kind: 'color', light: '#111111' }], document: {} };
  const STORED_HEAD = [{ kind: 'meta', name: 'author', content: 'Marlin' }];

  function body(siteSettings: Record<string, unknown>) {
    const p = ProjectModel.create({ id: 'site_keep', metadata: { title: 'Keep', description: '' }, pages: {} });
    p.createPage('Home');
    return { ...getSnapshot(p), siteSettings } as never;
  }

  beforeEach(() => {
    prisma.site.findUnique.mockResolvedValue({ erasureEpoch: 0, version: 1,
      id: 'site_keep',
      workspaceId: 'ws_marlin',
      redirects: [],
      siteSettings: { language: 'de', theme: STORED_THEME, head: STORED_HEAD },
    });
    prisma.site.updateMany.mockResolvedValue({ count: 1 });
    prisma.sitePage.upsert.mockResolvedValue({});
    prisma.sitePage.deleteMany.mockResolvedValue({ count: 0 });
  });

  const written = () => prisma.site.updateMany.mock.calls[0][0].data.siteSettings;

  it('a body from a tab built before the keys existed keeps the stored theme and head', async () => {
    await repo.saveProject(SCOPE, body({ language: 'en', siteName: 'New name' }), { mustExist: true, expectedVersion: 1 });
    expect(written()).toMatchObject({ language: 'en', siteName: 'New name', theme: STORED_THEME, head: STORED_HEAD });
  });

  it('a body carrying the keys writes them, and an explicit empty theme clears the stored one', async () => {
    await repo.saveProject(SCOPE, body({ theme: { tokens: [], document: {} }, head: [] }), { mustExist: true, expectedVersion: 1 });
    expect(written().theme).toEqual({ tokens: [], document: {} });
    expect(written().head).toEqual([]);
  });

  it('reads the stored settings in the same transaction it writes them', async () => {
    await repo.saveProject(SCOPE, body({}), { mustExist: true, expectedVersion: 1 });
    expect(prisma.site.findUnique.mock.calls[0][0].select).toMatchObject({ siteSettings: true });
  });
});

describe('SiteRepository.saveProject slug rules and redirects', () => {
  // A snapshot with a home page and the given extra pages (pageId -> slug).
  function snapshot(pages: Record<string, string>) {
    const all: Record<string, unknown> = {
      home: { id: 'home', slug: '', metadata: { title: 'Home' } },
    };
    for (const [id, slug] of Object.entries(pages)) {
      all[id] = { id, slug, metadata: { title: id } };
    }
    return {
      id: 'site_1',
      metadata: { title: 'Site', description: '', createdAt: 1, updatedAt: 2 },
      pages: all,
    } as never;
  }

  function existingSite(opts: {
    stored: Record<string, string>;
    published: boolean;
    redirects?: unknown;
  }) {
    prisma.site.findUnique.mockResolvedValue({ erasureEpoch: 0, version: 1,
      id: 'site_1',
      workspaceId: 'ws_marlin',
      redirects: opts.redirects ?? [],
    });
    prisma.sitePage.findMany.mockResolvedValue(
      Object.entries({ home: '', ...opts.stored }).map(([pageId, slug]) => ({ pageId, slug })),
    );
    prisma.siteDomain.findFirst.mockResolvedValue(opts.published ? { id: 'dom_1' } : null);
    prisma.site.upsert.mockResolvedValue({});
    prisma.sitePage.upsert.mockResolvedValue({});
    prisma.sitePage.deleteMany.mockResolvedValue({ count: 0 });
  }

  it('rejects an invalid changed slug with InvalidPageSlugError and writes nothing', async () => {
    existingSite({ stored: { about: 'about' }, published: true });
    const err = await repo.saveProject(SCOPE, snapshot({ about: 'About Us' }), { expectedVersion: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidPageSlugError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('invalid_page_slug');
    expect(prisma.site.upsert).not.toHaveBeenCalled();
    expect(prisma.sitePage.upsert).not.toHaveBeenCalled();
  });

  it('rejects a reserved path, a duplicate and a moved home page', async () => {
    existingSite({ stored: { about: 'about' }, published: false });
    await expect(repo.saveProject(SCOPE, snapshot({ about: 'about', x: 'api' }), { expectedVersion: 1 })).rejects.toBeInstanceOf(InvalidPageSlugError);
    await expect(repo.saveProject(SCOPE, snapshot({ about: 'about', x: 'about' }), { expectedVersion: 1 })).rejects.toBeInstanceOf(InvalidPageSlugError);
    const movedHome = snapshot({ about: 'about' }) as unknown as { pages: Record<string, { slug: string }> };
    movedHome.pages.home.slug = 'start';
    await expect(repo.saveProject(SCOPE, movedHome as never, { expectedVersion: 1 })).rejects.toMatchObject({ reason: 'home_locked' });
    expect(prisma.site.upsert).not.toHaveBeenCalled();
  });

  it('refuses a theme past the token cap or with an over-long name, and writes nothing', async () => {
    existingSite({ stored: {}, published: false });
    const withTheme = (theme: unknown) => {
      const snap = snapshot({}) as unknown as Record<string, unknown>;
      return { ...snap, siteSettings: { theme } } as never;
    };
    const tooMany = { tokens: Array.from({ length: 201 }, (_, i) => ({ id: `t${String(i).padStart(7, '0')}`, name: `C ${i}`, kind: 'color', light: '#000000' })), document: {} };
    const err = await repo.saveProject(SCOPE, withTheme(tooMany), { expectedVersion: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidSiteThemeError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('invalid_site_theme');
    const longName = { tokens: [{ id: 'aa000001', name: 'x'.repeat(41), kind: 'color', light: '#000000' }], document: {} };
    await expect(repo.saveProject(SCOPE, withTheme(longName), { expectedVersion: 1 })).rejects.toBeInstanceOf(InvalidSiteThemeError);
    expect(prisma.site.upsert).not.toHaveBeenCalled();
    expect(prisma.site.updateMany).not.toHaveBeenCalled();
  });

  it('saves a theme within the caps', async () => {
    existingSite({ stored: {}, published: false });
    const snap = snapshot({}) as unknown as Record<string, unknown>;
    const theme = { tokens: [{ id: 'aa000001', name: 'x'.repeat(40), kind: 'color', light: '#000000' }], document: {} };
    await repo.saveProject(SCOPE, { ...snap, siteSettings: { theme } } as never, { expectedVersion: 1 });
    expect(prisma.site.upsert).toHaveBeenCalledTimes(1);
  });

  it('accepts an unchanged legacy slug that predates the rules', async () => {
    existingSite({ stored: { legacy: 'Old_Slug' }, published: true });
    await repo.saveProject(SCOPE, snapshot({ legacy: 'Old_Slug' }), { expectedVersion: 1 });
    expect(prisma.site.upsert).toHaveBeenCalledTimes(1);
  });

  it('keeps the old slug as a redirect when a page of a published site moves', async () => {
    existingSite({ stored: { about: 'about' }, published: true });
    await repo.saveProject(SCOPE, snapshot({ about: 'about-us' }), { expectedVersion: 1 });
    const arg = prisma.site.upsert.mock.calls[0][0];
    expect(arg.update.redirects).toEqual([
      { from: 'about', pageId: 'about', createdAt: expect.any(String) },
    ]);
    expect(prisma.siteDomain.findFirst).toHaveBeenCalledWith({
      where: { siteId: 'site_1', subdomain: { not: null } },
      select: { id: true },
    });
  });

  it('records no redirect for a site that was never published', async () => {
    existingSite({ stored: { about: 'about' }, published: false });
    await repo.saveProject(SCOPE, snapshot({ about: 'about-us' }), { expectedVersion: 1 });
    expect(prisma.site.upsert.mock.calls[0][0].update.redirects).toEqual([]);
  });

  it('drops a stored redirect once a page claims its path', async () => {
    existingSite({
      stored: { about: 'about-us' },
      published: true,
      redirects: [{ from: 'about', pageId: 'about', createdAt: 't' }],
    });
    await repo.saveProject(SCOPE, snapshot({ about: 'about-us', team: 'about' }), { expectedVersion: 1 });
    expect(prisma.site.upsert.mock.calls[0][0].update.redirects).toEqual([]);
  });

  it('starts a brand-new site with no redirects', async () => {
    prisma.site.findUnique.mockResolvedValue(null);
    prisma.site.upsert.mockResolvedValue({});
    prisma.sitePage.upsert.mockResolvedValue({});
    prisma.sitePage.deleteMany.mockResolvedValue({ count: 0 });
    await repo.saveProject(SCOPE, snapshot({ about: 'about' }), { expectedVersion: 1 });
    expect(prisma.sitePage.findMany).not.toHaveBeenCalled();
    expect(prisma.site.upsert.mock.calls[0][0].create.redirects).toEqual([]);
  });
});

describe('SiteRepository.saveProject concurrency', () => {
  function conflict(): Prisma.PrismaClientKnownRequestError {
    return new Prisma.PrismaClientKnownRequestError('serialization failure', {
      code: 'P2034',
      clientVersion: 'test',
    });
  }

  beforeEach(() => {
    prisma.site.findUnique.mockResolvedValue(null);
    prisma.site.upsert.mockResolvedValue({});
    prisma.sitePage.upsert.mockResolvedValue({});
    prisma.sitePage.deleteMany.mockResolvedValue({ count: 0 });
  });

  const project = () =>
    ({
      id: 'site_1',
      metadata: { title: 'S', description: '', createdAt: 1, updatedAt: 2 },
      pages: { home: { id: 'home', slug: '', metadata: { title: 'Home' } } },
    }) as never;

  it('runs the save SERIALIZABLE, so overlapping saves cannot lose a redirect', async () => {
    await repo.saveProject(SCOPE, project(), { expectedVersion: 1 });
    expect(prisma.$transaction.mock.calls[0][1]).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      // Room for a body at the 10 MB limit; Prisma's default is 5 seconds.
      maxWait: 5_000,
      timeout: 30_000,
    });
  });

  it('retries a save that lost a serialization conflict', async () => {
    const real = prisma.$transaction.getMockImplementation()!;
    prisma.$transaction.mockImplementationOnce(async () => {
      throw conflict();
    });
    prisma.$transaction.mockImplementation(real);
    await repo.saveProject(SCOPE, project(), { expectedVersion: 1 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.site.upsert).toHaveBeenCalledTimes(1);
  });

  it('gives up loudly after repeated conflicts, and never retries other errors', async () => {
    prisma.$transaction.mockImplementation(async () => {
      throw conflict();
    });
    await expect(repo.saveProject(SCOPE, project(), { expectedVersion: 1 })).rejects.toMatchObject({ code: 'P2034' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(4);

    prisma.$transaction.mockReset();
    prisma.$transaction.mockImplementation(async () => {
      throw new Error('db down');
    });
    await expect(repo.saveProject(SCOPE, project(), { expectedVersion: 1 })).rejects.toThrow('db down');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('SiteRepository.getSiteAddress', () => {
  const domain = (over: Record<string, unknown>) => ({
    subdomain: null,
    customHostname: null,
    verificationStatus: 'pending',
    activatedAt: null,
    createdAt: new Date('2026-01-01'),
    ...over,
  });

  it('reads scoped by id AND workspace and throws for a foreign site', async () => {
    prisma.site.findFirst.mockResolvedValue(null);
    await expect(repo.getSiteAddress(SCOPE, 'site_x', 'sites.lumitra.co')).rejects.toBeInstanceOf(SiteNotFoundError);
    expect(prisma.site.findFirst.mock.calls[0][0].where).toEqual({ id: 'site_x', workspaceId: 'ws_marlin' });
  });

  it('is unpublished with no address before the first publish', async () => {
    prisma.site.findFirst.mockResolvedValue({ domains: [] });
    expect(await repo.getSiteAddress(SCOPE, 'site_1', 'sites.lumitra.co')).toEqual({
      host: null,
      everPublished: false,
    });
  });

  it('uses the platform subdomain under the base host', async () => {
    prisma.site.findFirst.mockResolvedValue({
      domains: [domain({ subdomain: 'abc123', verificationStatus: 'active' })],
    });
    expect(await repo.getSiteAddress(SCOPE, 'site_1', 'sites.lumitra.co')).toMatchObject({
      host: 'abc123.sites.lumitra.co',
      everPublished: true,
    });
  });

  it('prefers a serving custom domain, never a pending one', async () => {
    prisma.site.findFirst.mockResolvedValue({
      domains: [
        domain({ subdomain: 'abc123', verificationStatus: 'active' }),
        domain({ customHostname: 'pending.example', verificationStatus: 'pending' }),
        domain({ customHostname: 'www.bakery.example', verificationStatus: 'active', activatedAt: new Date('2026-02-01') }),
      ],
    });
    expect((await repo.getSiteAddress(SCOPE, 'site_1', 'sites.lumitra.co')).host).toBe('www.bakery.example');
  });
});

describe('SiteRepository.saveProject leaves the name to the rename action', () => {
  it('writes the name on create but never on update', async () => {
    prisma.site.findUnique.mockResolvedValue({ erasureEpoch: 0, version: 1, id: 'site_save', workspaceId: 'ws_marlin' });
    prisma.site.upsert.mockResolvedValue({});
    prisma.sitePage.upsert.mockResolvedValue({});
    prisma.sitePage.deleteMany.mockResolvedValue({ count: 0 });
    const p = ProjectModel.create({
      id: 'site_save',
      metadata: { title: 'Stale title from an old editor tab', description: '' },
      pages: {},
    });

    await repo.saveProject(SCOPE, p, { expectedVersion: 1 });

    const upsertArg = prisma.site.upsert.mock.calls[0][0];
    expect(upsertArg.create.name).toBe('Stale title from an old editor tab');
    expect(upsertArg.update).not.toHaveProperty('name');
  });
});

describe('SiteRepository.renameSite', () => {
  it('renames scoped by id AND workspace_id', async () => {
    prisma.site.updateMany.mockResolvedValue({ count: 1 });
    const out = await repo.renameSite(SCOPE, 'site_1', 'New name');
    const arg = prisma.site.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'site_1', workspaceId: 'ws_marlin', tenantGroupId: 'tg_lumitra' });
    expect(arg.data.name).toBe('New name');
    expect(arg.data.projectUpdatedAt).toBeInstanceOf(Date);
    expect(out.name).toBe('New name');
  });

  it('puts the expected name into the same UPDATE (no read-then-write window)', async () => {
    prisma.site.updateMany.mockResolvedValue({ count: 1 });
    await repo.renameSite(SCOPE, 'site_1', 'New name', 'Old name');
    expect(prisma.site.updateMany.mock.calls[0][0].where).toEqual({
      id: 'site_1',
      workspaceId: 'ws_marlin',
      tenantGroupId: 'tg_lumitra',
      name: 'Old name',
    });
    expect(prisma.site.findFirst).not.toHaveBeenCalled();
  });

  it('a lost race writes nothing and reports the current name (409)', async () => {
    prisma.site.updateMany.mockResolvedValue({ count: 0 });
    prisma.site.findFirst.mockResolvedValue({ name: 'Renamed by someone else' });
    const err = await repo.renameSite(SCOPE, 'site_1', 'Mine', 'Old name').catch((e) => e);
    expect(err).toBeInstanceOf(SiteNameConflictError);
    expect(err.status).toBe(409);
    expect(err.currentName).toBe('Renamed by someone else');
    expect(prisma.site.findFirst.mock.calls[0][0].where).toEqual({
      id: 'site_1',
      workspaceId: 'ws_marlin',
      tenantGroupId: 'tg_lumitra',
    });
  });

  it('two tabs setting the same name is not a conflict', async () => {
    prisma.site.updateMany.mockResolvedValue({ count: 0 });
    const stored = new Date('2026-10-20T10:00:00Z');
    prisma.site.findFirst.mockResolvedValue({ name: 'Same', projectUpdatedAt: stored });
    // The stored timestamp, not a made-up "now": nothing was written.
    await expect(repo.renameSite(SCOPE, 'site_1', 'Same', 'Old')).resolves.toEqual({ name: 'Same', updatedAt: stored });
  });

  it('a missing or foreign site is a 404, indistinguishable', async () => {
    prisma.site.updateMany.mockResolvedValue({ count: 0 });
    prisma.site.findFirst.mockResolvedValue(null);
    await expect(repo.renameSite(SCOPE, 'site_x', 'Name')).rejects.toBeInstanceOf(SiteNotFoundError);
  });

  it('rejects an empty scope', async () => {
    await expect(
      repo.renameSite({ workspaceId: '', tenantGroupId: 'tg' }, 'site_1', 'Name'),
    ).rejects.toBeInstanceOf(InvalidTenantScopeError);
    expect(prisma.site.updateMany).not.toHaveBeenCalled();
  });
});

describe('SiteRepository.publishProject', () => {
  const PROJECT = {
    id: 'site_1',
    metadata: { title: 'S', description: '', createdAt: 1, updatedAt: 2 },
    pages: {},
  } as never;

  /** A stored site in the caller's workspace, as the transaction reads it. */
  function storedSite(over: Record<string, unknown> = {}) {
    prisma.site.findUnique.mockResolvedValue({ erasureEpoch: 0, version: 1,
      id: 'site_1', workspaceId: 'ws_marlin', redirects: [], status: 'draft', publishedRevisionId: null, ...over,
    });
    prisma.site.findFirst.mockResolvedValue({
      name: 'S', analyticsProjectId: null, ingestionEndpoint: null, apiKeyRef: null, lumitraEnabled: false,
      redirects: [], siteSettings: {}, pages: [],
    });
    prisma.site.updateMany.mockResolvedValue({ count: 1 });
  }

  it('flips status to published and points at the new revision, scoped by id AND workspace_id', async () => {
    storedSite();
    await expect(repo.publishProject(SCOPE, PROJECT, { expectedVersion: 1 })).resolves.toEqual({ revision: 1, version: 2 });
    expect(prisma.site.updateMany).toHaveBeenCalledWith({
      where: { id: 'site_1', workspaceId: 'ws_marlin' },
      data: { status: 'published', publishedRevisionId: 'rev_new' },
    });
  });

  it('stamps the tenant scope and the publisher on the revision, and numbers it after the newest', async () => {
    storedSite();
    prisma.siteRevision.findFirst.mockResolvedValue({ number: 41 });
    await expect(repo.publishProject(SCOPE, PROJECT, { publishedBy: 'user-1', expectedVersion: 1 })).resolves.toEqual({ revision: 42, version: 2 });
    expect(prisma.siteRevision.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        siteId: 'site_1', workspaceId: 'ws_marlin', tenantGroupId: 'tg_lumitra', number: 42, kind: 'publish', publishedBy: 'user-1',
      }),
    }));
  });

  it('runs in one transaction that locks the site row first, with room for a body at the limit', async () => {
    storedSite();
    await repo.publishProject(SCOPE, PROJECT, { expectedVersion: 1 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Not SERIALIZABLE: that made publishes of unrelated sites abort each other.
    expect(prisma.$transaction.mock.calls[0][1]).toEqual({ maxWait: 5_000, timeout: 30_000 });
    const [sql, siteId] = prisma.$queryRaw.mock.calls[0] as [TemplateStringsArray, string];
    expect(sql.join('?')).toBe('SELECT id FROM public.sites WHERE id = ? FOR UPDATE');
    expect(siteId).toBe('site_1');
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prisma.site.findUnique.mock.invocationCallOrder[0]);
  });

  it('keeps the newest revisions and prunes the rest', async () => {
    storedSite();
    prisma.siteRevision.findFirst.mockResolvedValue({ number: 40 });
    await repo.publishProject(SCOPE, PROJECT, { expectedVersion: 1 });
    expect(prisma.siteRevision.deleteMany).toHaveBeenCalledWith({
      where: { siteId: 'site_1', number: { lte: 41 - REVISIONS_KEPT } },
    });
  });

  it('throws SiteNotFoundError for a site in another workspace, flipping nothing', async () => {
    // A site id owned by another workspace: refuse, do not flip a foreign tenant's status.
    storedSite({ workspaceId: 'ws_other' });
    await expect(repo.publishProject(SCOPE, PROJECT, { expectedVersion: 1 })).rejects.toBeInstanceOf(SiteNotFoundError);
    expect(prisma.site.updateMany).not.toHaveBeenCalled();
    expect(prisma.siteRevision.create).not.toHaveBeenCalled();
  });

  it('throws SiteGoneError for a deleted site: publish only ever updates', async () => {
    prisma.site.findUnique.mockResolvedValue(null);
    await expect(repo.publishProject(SCOPE, PROJECT, { expectedVersion: 1 })).rejects.toBeInstanceOf(SiteGoneError);
    expect(prisma.siteRevision.create).not.toHaveBeenCalled();
  });

  it('rejects an empty scope', async () => {
    await expect(
      repo.publishProject({ workspaceId: '', tenantGroupId: 'tg' }, PROJECT),
    ).rejects.toBeInstanceOf(InvalidTenantScopeError);
    expect(prisma.site.updateMany).not.toHaveBeenCalled();
  });
});

describe('SiteRepository.rollbackToRevision', () => {
  it('moves the pointer and sets published, scoped by id AND workspace_id', async () => {
    prisma.site.findFirst.mockResolvedValue({ id: 'site_1' });
    prisma.siteRevision.findFirst.mockResolvedValue({ id: 'rev_3' });
    await repo.rollbackToRevision(SCOPE, 'site_1', 3);
    expect(prisma.siteRevision.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { siteId: 'site_1', workspaceId: 'ws_marlin', number: 3 },
    }));
    expect(prisma.site.updateMany).toHaveBeenCalledWith({
      where: { id: 'site_1', workspaceId: 'ws_marlin' },
      data: { status: 'published', publishedRevisionId: 'rev_3' },
    });
  });

  it('a site in another workspace reads as missing', async () => {
    prisma.site.findFirst.mockResolvedValue(null);
    await expect(repo.rollbackToRevision(SCOPE, 'site_other', 1)).rejects.toBeInstanceOf(SiteNotFoundError);
    expect(prisma.site.updateMany).not.toHaveBeenCalled();
  });

  it('an unknown number changes nothing', async () => {
    prisma.site.findFirst.mockResolvedValue({ id: 'site_1' });
    await expect(repo.rollbackToRevision(SCOPE, 'site_1', 9)).rejects.toMatchObject({ code: 'revision_not_found', status: 404 });
    expect(prisma.site.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an empty scope', async () => {
    await expect(
      repo.rollbackToRevision({ workspaceId: '', tenantGroupId: 'tg' }, 'site_1', 1),
    ).rejects.toBeInstanceOf(InvalidTenantScopeError);
  });
});

describe('SiteRepository.listRevisions', () => {
  it('lists newest first, names the live number, and loads no documents', async () => {
    const at = new Date('2026-11-01T10:00:00Z');
    prisma.site.findFirst.mockResolvedValue({
      status: 'published',
      publishedRevisionId: 'rev_1',
      revisions: [
        { id: 'rev_2', number: 2, kind: 'publish', publishedBy: 'user-1', createdAt: at },
        { id: 'rev_1', number: 1, kind: 'baseline', publishedBy: null, createdAt: at },
      ],
    });
    const list = await repo.listRevisions(SCOPE, 'site_1');
    expect(list).toEqual({
      status: 'published',
      live: 1,
      revisions: [
        { number: 2, kind: 'publish', publishedBy: 'user-1', createdAt: at },
        { number: 1, kind: 'baseline', publishedBy: null, createdAt: at },
      ],
    });
    const query = prisma.site.findFirst.mock.calls[0][0] as { where: unknown; select: { revisions: { select: object } } };
    expect(query.where).toEqual({ id: 'site_1', workspaceId: 'ws_marlin' });
    expect(query.select.revisions.select).not.toHaveProperty('document');
  });

  it('a missing or foreign site throws SiteNotFoundError', async () => {
    prisma.site.findFirst.mockResolvedValue(null);
    await expect(repo.listRevisions(SCOPE, 'site_x')).rejects.toBeInstanceOf(SiteNotFoundError);
  });
});

describe('SiteRepository.ensureSiteDomain', () => {
  it('returns an existing non-null subdomain UNCHANGED (re-publish is a no-op)', async () => {
    prisma.site.findFirst.mockResolvedValue({ id: 'site_1' });
    prisma.siteDomain.findFirst.mockResolvedValue({ subdomain: 'coolteal42abc' });

    const result = await repo.ensureSiteDomain(SCOPE, 'site_1');

    expect(result).toEqual({ subdomain: 'coolteal42abc' });
    // Idempotent: it must NOT allocate a second row.
    expect(prisma.siteDomain.create).not.toHaveBeenCalled();
  });

  it('allocates a non-null subdomain row stamped with scope, active + primary', async () => {
    prisma.site.findFirst.mockResolvedValue({ id: 'site_1' });
    prisma.siteDomain.findFirst.mockResolvedValue(null);
    prisma.siteDomain.create.mockResolvedValue({});

    const result = await repo.ensureSiteDomain(SCOPE, 'site_1');

    expect(typeof result.subdomain).toBe('string');
    expect(result.subdomain.length).toBeGreaterThan(0);

    const createArg = prisma.siteDomain.create.mock.calls[0][0];
    expect(createArg.data.subdomain).toBe(result.subdomain);
    expect(createArg.data.subdomain).not.toBeNull();
    expect(createArg.data.workspaceId).toBe('ws_marlin');
    expect(createArg.data.tenantGroupId).toBe('tg_lumitra');
    expect(createArg.data.siteId).toBe('site_1');
    expect(createArg.data.verificationStatus).toBe('active');
    expect(createArg.data.isPrimary).toBe(true);
  });

  it('retries on a P2002 collision and RESOLVES to a label', async () => {
    prisma.site.findFirst.mockResolvedValue({ id: 'site_1' });
    prisma.siteDomain.findFirst.mockResolvedValue(null);
    // First insert collides, second succeeds — DB-enforced, not check-then-insert.
    prisma.siteDomain.create
      .mockRejectedValueOnce(p2002())
      .mockResolvedValueOnce({});

    const result = await repo.ensureSiteDomain(SCOPE, 'site_1');

    expect(typeof result.subdomain).toBe('string');
    expect(prisma.siteDomain.create).toHaveBeenCalledTimes(2);
    // The retry regenerated a fresh label rather than reusing the colliding one.
    const first = prisma.siteDomain.create.mock.calls[0][0].data.subdomain;
    const second = prisma.siteDomain.create.mock.calls[1][0].data.subdomain;
    expect(second).toBe(result.subdomain);
    expect(first).not.toBe(second);
  });

  it('throws a LOUD SubdomainAllocationError (500) when retries are exhausted', async () => {
    prisma.site.findFirst.mockResolvedValue({ id: 'site_1' });
    prisma.siteDomain.findFirst.mockResolvedValue(null);
    // Every attempt collides.
    prisma.siteDomain.create.mockRejectedValue(p2002());

    let err: SubdomainAllocationError | undefined;
    try {
      await repo.ensureSiteDomain(SCOPE, 'site_1');
    } catch (e) {
      err = e as SubdomainAllocationError;
    }
    expect(err).toBeInstanceOf(SubdomainAllocationError);
    expect(err?.status).toBe(500);
    expect(err?.code).toBe('subdomain_allocation_failed');
  });

  it('does NOT swallow a non-P2002 error from the insert', async () => {
    prisma.site.findFirst.mockResolvedValue({ id: 'site_1' });
    prisma.siteDomain.findFirst.mockResolvedValue(null);
    const boom = new Error('connection reset');
    prisma.siteDomain.create.mockRejectedValue(boom);

    await expect(repo.ensureSiteDomain(SCOPE, 'site_1')).rejects.toBe(boom);
  });

  it('throws SiteNotFoundError for a site id in ANOTHER workspace (never allocates across the boundary)', async () => {
    // workspace_id is in the where-clause, so a foreign site returns null.
    prisma.site.findFirst.mockResolvedValue(null);

    await expect(
      repo.ensureSiteDomain(SCOPE, 'site_other_ws'),
    ).rejects.toBeInstanceOf(SiteNotFoundError);
    expect(prisma.siteDomain.create).not.toHaveBeenCalled();

    expect(prisma.site.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'site_other_ws', workspaceId: 'ws_marlin' },
      }),
    );
  });

  it('rejects an empty scope', async () => {
    await expect(
      repo.ensureSiteDomain({ workspaceId: '', tenantGroupId: 'tg' }, 'site_1'),
    ).rejects.toBeInstanceOf(InvalidTenantScopeError);
    expect(prisma.site.findFirst).not.toHaveBeenCalled();
  });
});

describe('SiteRepository.unpublishProject', () => {
  it('flips status to draft scoped by id AND workspace_id, and does NOT delete the SiteDomain', async () => {
    prisma.site.updateMany.mockResolvedValue({ count: 1 });

    await repo.unpublishProject(SCOPE, 'site_1');

    expect(prisma.site.updateMany).toHaveBeenCalledWith({
      where: { id: 'site_1', workspaceId: 'ws_marlin' },
      data: { status: 'draft' },
    });
    // D3: the slug is preserved for a stable URL on re-publish.
    expect(prisma.siteDomain.deleteMany).not.toHaveBeenCalled();
  });

  it('throws SiteNotFoundError when no row in the workspace matched', async () => {
    prisma.site.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      repo.unpublishProject(SCOPE, 'site_other_ws'),
    ).rejects.toBeInstanceOf(SiteNotFoundError);
  });

  it('rejects an empty scope', async () => {
    await expect(
      repo.unpublishProject({ workspaceId: '', tenantGroupId: 'tg' }, 'site_1'),
    ).rejects.toBeInstanceOf(InvalidTenantScopeError);
    expect(prisma.site.updateMany).not.toHaveBeenCalled();
  });
});

describe('SiteRepository.deleteSite', () => {
  const WHERE = { id: 'site_1', workspaceId: 'ws_marlin', tenantGroupId: 'tg_lumitra' };

  function siteRow(status: string, domains: Array<Record<string, string | null>> = []) {
    return {
      name: 'Bakery',
      status,
      domains: domains.map((d) => ({ subdomain: null, hostname: null, customHostname: null, ...d })),
    };
  }

  beforeEach(() => {
    // The row lock taken first (an UPDATE of the row's own write timestamp).
    prisma.site.updateMany.mockResolvedValue({ count: 1 });
  });

  it('locks, reads and deletes scoped by id, workspace AND tenant group, in one transaction', async () => {
    prisma.site.findFirst.mockResolvedValue(siteRow('draft'));
    prisma.site.deleteMany.mockResolvedValue({ count: 1 });
    await repo.deleteSite(SCOPE, 'site_1');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const lock = prisma.site.updateMany.mock.calls[0][0];
    expect(lock.where).toEqual(WHERE);
    expect(Object.keys(lock.data)).toEqual(['updatedAt']);
    // The lock comes before the status read, so a publish in flight finishes first.
    expect(prisma.site.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.site.findFirst.mock.invocationCallOrder[0],
    );
    expect(prisma.site.findFirst.mock.calls[0][0].where).toEqual(WHERE);
    expect(prisma.site.deleteMany).toHaveBeenCalledWith({ where: WHERE });
  });

  it('a missing or foreign site is a 404 and nothing is deleted', async () => {
    prisma.site.updateMany.mockResolvedValue({ count: 0 });
    await expect(repo.deleteSite(SCOPE, 'site_other_ws')).rejects.toBeInstanceOf(SiteNotFoundError);
    expect(prisma.site.deleteMany).not.toHaveBeenCalled();
  });

  it('captures the subdomain and every custom hostname BEFORE the cascade removes them', async () => {
    prisma.site.findFirst.mockResolvedValue(
      siteRow('draft', [
        { subdomain: 'k3j9x0abcd12' },
        { hostname: 'www.bakery.de', customHostname: 'www.bakery.de' },
        { hostname: 'bakery.de' },
      ]),
    );
    prisma.site.deleteMany.mockResolvedValue({ count: 1 });
    await expect(repo.deleteSite(SCOPE, 'site_1')).resolves.toEqual({
      siteId: 'site_1',
      name: 'Bakery',
      wasPublished: false,
      subdomain: 'k3j9x0abcd12',
      hostnames: ['www.bakery.de', 'bakery.de'],
    });
  });

  it('a published site needs its exact current name, else nothing is deleted (409)', async () => {
    prisma.site.findFirst.mockResolvedValue(siteRow('published'));
    for (const confirmName of [undefined, 'bakery', 'Old name before a rename']) {
      const err = await repo.deleteSite(SCOPE, 'site_1', { confirmName }).catch((e) => e);
      expect(err).toBeInstanceOf(SiteDeleteConfirmationError);
      expect(err.status).toBe(409);
      expect(err.currentName).toBe('Bakery');
    }
    expect(prisma.site.deleteMany).not.toHaveBeenCalled();
  });

  it('a published site with the right name is deleted', async () => {
    prisma.site.findFirst.mockResolvedValue(siteRow('published'));
    prisma.site.deleteMany.mockResolvedValue({ count: 1 });
    await expect(repo.deleteSite(SCOPE, 'site_1', { confirmName: 'Bakery' })).resolves.toMatchObject({
      wasPublished: true,
    });
  });

  it('a concurrent delete between read and delete is a 404', async () => {
    prisma.site.findFirst.mockResolvedValue(siteRow('draft'));
    prisma.site.deleteMany.mockResolvedValue({ count: 0 });
    await expect(repo.deleteSite(SCOPE, 'site_1')).rejects.toBeInstanceOf(SiteNotFoundError);
  });
});

describe('SiteRepository.saveProject with mustExist (editor Save and Publish)', () => {
  function project() {
    return ProjectModel.create({ id: 'site_gone', metadata: { title: 'Gone', description: '' }, pages: {} });
  }

  it('refuses a site that no longer exists instead of re-creating it', async () => {
    prisma.site.findUnique.mockResolvedValue(null);
    prisma.site.updateMany.mockResolvedValue({ count: 0 });
    const err = await repo.saveProject(SCOPE, project(), { mustExist: true, expectedVersion: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(SiteGoneError);
    expect(err.message).toBe('This project does not exist (any more): it may have been deleted. Your changes were not saved.');
    expect(prisma.site.upsert).not.toHaveBeenCalled();
    expect(prisma.sitePage.upsert).not.toHaveBeenCalled();
  });

  it('still updates a site that exists, with an UPDATE (row lock), never an upsert', async () => {
    prisma.site.findUnique.mockResolvedValue({ erasureEpoch: 0, version: 1, id: 'site_gone', workspaceId: 'ws_marlin' });
    prisma.site.updateMany.mockResolvedValue({ count: 1 });
    prisma.sitePage.deleteMany.mockResolvedValue({ count: 0 });
    await expect(repo.saveProject(SCOPE, project(), { mustExist: true, expectedVersion: 1 })).resolves.toEqual({ version: 2 });
    // The version lock rides in the same UPDATE: compared in its WHERE, raised in its data.
    expect(prisma.site.updateMany.mock.calls[0][0].where).toEqual({ id: 'site_gone', workspaceId: 'ws_marlin', version: 1 });
    expect(prisma.site.updateMany.mock.calls[0][0].data).toMatchObject({ version: 2 });
    expect(prisma.site.updateMany.mock.calls[0][0].data).not.toHaveProperty('name');
    expect(prisma.site.upsert).not.toHaveBeenCalled();
  });

  it('a stale expectedVersion is refused with the stored version, before anything is written', async () => {
    prisma.site.findUnique.mockResolvedValue({ erasureEpoch: 0, version: 4, id: 'site_gone', workspaceId: 'ws_marlin' });
    const err = await repo.saveProject(SCOPE, project(), { mustExist: true, expectedVersion: 3 }).catch((e) => e);
    expect(err).toBeInstanceOf(SiteChangedError);
    expect(err).toMatchObject({ code: 'site_changed', status: 409, currentVersion: 4 });
    expect(prisma.site.updateMany).not.toHaveBeenCalled();
    expect(prisma.sitePage.upsert).not.toHaveBeenCalled();
    expect(prisma.sitePage.deleteMany).not.toHaveBeenCalled();
  });

  it('no expectedVersion for an existing site is refused (no newest-wins path), before anything is written', async () => {
    prisma.site.findUnique.mockResolvedValue({ erasureEpoch: 0, version: 4, id: 'site_gone', workspaceId: 'ws_marlin' });
    await expect(repo.saveProject(SCOPE, project(), { mustExist: true })).rejects.toBeInstanceOf(SiteVersionRequiredError);
    await expect(repo.saveProject(SCOPE, project())).rejects.toMatchObject({ code: 'version_required', status: 400 });
    expect(prisma.site.updateMany).not.toHaveBeenCalled();
    expect(prisma.site.upsert).not.toHaveBeenCalled();
  });

  it('an erased-since-load tab is told to reload, not offered to save over (the erasure check comes first)', async () => {
    prisma.site.findUnique.mockResolvedValue({ erasureEpoch: 1, version: 5, id: 'site_gone', workspaceId: 'ws_marlin' });
    await expect(repo.saveProject(SCOPE, project(), { mustExist: true, expectedVersion: 1 })).rejects.toBeInstanceOf(
      SiteErasedSinceLoadError,
    );
  });

  it('a write landing between the read and the UPDATE: the UPDATE matches nothing, refused with the new version', async () => {
    prisma.site.findUnique.mockResolvedValue({ erasureEpoch: 0, version: 1, id: 'site_gone', workspaceId: 'ws_marlin' });
    prisma.site.updateMany.mockResolvedValue({ count: 0 });
    prisma.site.findFirst.mockResolvedValue({ version: 2 });
    const err = await repo.saveProject(SCOPE, project(), { mustExist: true, expectedVersion: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(SiteChangedError);
    expect(err.currentVersion).toBe(2);
    expect(prisma.sitePage.upsert).not.toHaveBeenCalled();
  });

  it('a delete committed between the existence check and the write: still refused, no re-create', async () => {
    prisma.site.findUnique.mockResolvedValue({ erasureEpoch: 0, version: 1, id: 'site_gone', workspaceId: 'ws_marlin' });
    prisma.site.updateMany.mockResolvedValue({ count: 0 });
    await expect(repo.saveProject(SCOPE, project(), { mustExist: true, expectedVersion: 1 })).rejects.toBeInstanceOf(SiteGoneError);
    expect(prisma.site.upsert).not.toHaveBeenCalled();
    expect(prisma.sitePage.upsert).not.toHaveBeenCalled();
  });
});

describe('SiteRepository.saveProject: attempt keys bound to the version they wrote', () => {
  function makeProject() {
    const p = ProjectModel.create({ id: 'site_key', metadata: { title: 'Key', description: '' }, pages: {} });
    p.createPage('Home');
    return p;
  }
  const stored = (over: Record<string, unknown>) => ({
    erasureEpoch: 0,
    version: 1,
    id: 'site_key',
    workspaceId: 'ws_marlin',
    lastWriteKey: null,
    lastWriteVersion: null,
    ...over,
  });
  const ready = () => {
    prisma.site.updateMany.mockResolvedValue({ count: 1 });
    prisma.sitePage.upsert.mockResolvedValue({});
    prisma.sitePage.deleteMany.mockResolvedValue({ count: 0 });
  };
  const save = (options: Record<string, unknown>) => repo.saveProject(SCOPE, makeProject(), { mustExist: true, ...options });

  it('stores the key with the version it wrote; a write without a key clears both', async () => {
    ready();
    prisma.site.findUnique.mockResolvedValue(stored({ version: 4 }));
    await expect(save({ expectedVersion: 4, requestKey: 'attempt-0001' })).resolves.toEqual({ version: 5 });
    expect(prisma.site.updateMany.mock.calls[0][0].data).toMatchObject({ version: 5, lastWriteKey: 'attempt-0001', lastWriteVersion: 5 });
    await save({ expectedVersion: 4 });
    expect(prisma.site.updateMany.mock.calls.at(-1)![0].data).toMatchObject({ lastWriteKey: null, lastWriteVersion: null });
  });

  it('a repeat of the latest write is answered with its version and writes nothing', async () => {
    prisma.site.findUnique.mockResolvedValue(stored({ version: 5, lastWriteKey: 'attempt-0001', lastWriteVersion: 5 }));
    await expect(save({ expectedVersion: 4, requestKey: 'attempt-0001' })).resolves.toEqual({ version: 5 });
    expect(prisma.site.updateMany).not.toHaveBeenCalled();
    expect(prisma.sitePage.upsert).not.toHaveBeenCalled();
  });

  it('newer content naming a lost attempt that is the latest write builds on it', async () => {
    ready();
    prisma.site.findUnique.mockResolvedValue(stored({ version: 5, lastWriteKey: 'attempt-lost', lastWriteVersion: 5 }));
    await expect(save({ expectedVersion: 4, requestKey: 'attempt-new', previousRequestKeys: ['attempt-lost'] })).resolves.toEqual({ version: 6 });
    const update = prisma.site.updateMany.mock.calls[0][0];
    expect(update.where).toMatchObject({ version: 5 });
    expect(update.data).toMatchObject({ version: 6, lastWriteKey: 'attempt-new', lastWriteVersion: 6 });
  });

  it('two lost answers in a row: the latest write of this tab is recognised among the named ones', async () => {
    ready();
    // A (on 4) wrote 5, B (naming A) wrote 6; both answers were lost. C names A and B.
    prisma.site.findUnique.mockResolvedValue(stored({ version: 6, lastWriteKey: 'attempt-b', lastWriteVersion: 6 }));
    await expect(save({ expectedVersion: 4, requestKey: 'attempt-c', previousRequestKeys: ['attempt-a', 'attempt-b'] })).resolves.toEqual({ version: 7 });
    // And B's own retry is a replay.
    prisma.site.findUnique.mockResolvedValue(stored({ version: 6, lastWriteKey: 'attempt-b', lastWriteVersion: 6 }));
    await expect(save({ expectedVersion: 4, requestKey: 'attempt-b', previousRequestKeys: ['attempt-a'] })).resolves.toEqual({ version: 6 });
  });

  it('a stale key after a writer that does not know it (an older container) never matches', async () => {
    // A wrote 5; an older container then wrote 6 and left the key as it was.
    prisma.site.findUnique.mockResolvedValue(stored({ version: 6, lastWriteKey: 'attempt-a', lastWriteVersion: 5 }));
    await expect(save({ expectedVersion: 4, requestKey: 'attempt-a' })).rejects.toBeInstanceOf(SiteChangedError);
    await expect(save({ expectedVersion: 4, requestKey: 'attempt-b', previousRequestKeys: ['attempt-a'] })).rejects.toBeInstanceOf(SiteChangedError);
    expect(prisma.site.updateMany).not.toHaveBeenCalled();
  });

  it('a third-party write in between is still a 409, also for a key it does not hold', async () => {
    prisma.site.findUnique.mockResolvedValue(stored({ version: 6, lastWriteKey: null, lastWriteVersion: null }));
    await expect(save({ expectedVersion: 4, requestKey: 'attempt-c', previousRequestKeys: ['attempt-a', 'attempt-b'] })).rejects.toBeInstanceOf(SiteChangedError);
    prisma.site.findUnique.mockResolvedValue(stored({ version: 6, lastWriteKey: 'agent-write', lastWriteVersion: 6 }));
    await expect(save({ expectedVersion: 4, requestKey: 'attempt-c', previousRequestKeys: ['attempt-a', 'attempt-b'] })).rejects.toBeInstanceOf(SiteChangedError);
    expect(prisma.site.updateMany).not.toHaveBeenCalled();
  });
});
