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
import ProjectModel from '@/models/ProjectModel';
import { SiteRepository, type TenantScope } from '../repository';
import { SiteNotFoundError, InvalidTenantScopeError } from '../errors';

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
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  };
  const prisma = {
    site,
    sitePage,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(prisma),
    ),
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

    await repo.saveProject(SCOPE, makeProject());

    const upsertArg = prisma.site.upsert.mock.calls[0][0];
    expect(upsertArg.create.workspaceId).toBe('ws_marlin');
    expect(upsertArg.create.tenantGroupId).toBe('tg_lumitra');
  });

  it('stamps BOTH ids on every page create', async () => {
    prisma.site.findUnique.mockResolvedValue(null);
    prisma.site.upsert.mockResolvedValue({});
    prisma.sitePage.upsert.mockResolvedValue({});
    prisma.sitePage.deleteMany.mockResolvedValue({ count: 0 });

    await repo.saveProject(SCOPE, makeProject());

    expect(prisma.sitePage.upsert).toHaveBeenCalled();
    const pageArg = prisma.sitePage.upsert.mock.calls[0][0];
    expect(pageArg.create.workspaceId).toBe('ws_marlin');
    expect(pageArg.create.tenantGroupId).toBe('tg_lumitra');
  });

  it('refuses to overwrite a site owned by another workspace', async () => {
    // The id exists but in a different workspace: refuse, do not overwrite.
    prisma.site.findUnique.mockResolvedValue({
      id: 'site_save',
      workspaceId: 'ws_someone_else',
    });
    await expect(repo.saveProject(SCOPE, makeProject())).rejects.toBeInstanceOf(
      SiteNotFoundError,
    );
    expect(prisma.site.upsert).not.toHaveBeenCalled();
  });

  it('upserts by id (a re-save of an existing same-workspace site updates, not duplicates)', async () => {
    // The id already exists IN the caller's workspace: the save proceeds and
    // upserts by id, so a second publish updates the one row rather than
    // creating a duplicate.
    prisma.site.findUnique.mockResolvedValue({
      id: 'site_save',
      workspaceId: 'ws_marlin',
    });
    prisma.site.upsert.mockResolvedValue({});
    prisma.sitePage.upsert.mockResolvedValue({});
    prisma.sitePage.deleteMany.mockResolvedValue({ count: 0 });

    await repo.saveProject(SCOPE, makeProject());

    const upsertArg = prisma.site.upsert.mock.calls[0][0];
    expect(upsertArg.where).toEqual({ id: 'site_save' });
  });
});

describe('SiteRepository.publishProject', () => {
  it('flips status to published scoped by id AND workspace_id', async () => {
    prisma.site.updateMany.mockResolvedValue({ count: 1 });
    await repo.publishProject(SCOPE, 'site_1');
    expect(prisma.site.updateMany).toHaveBeenCalledWith({
      where: { id: 'site_1', workspaceId: 'ws_marlin' },
      data: { status: 'published' },
    });
  });

  it('throws SiteNotFoundError when no row in the workspace matched', async () => {
    // A site id owned by another workspace matches zero rows: refuse, do not
    // flip a foreign tenant's status.
    prisma.site.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      repo.publishProject(SCOPE, 'site_other_ws'),
    ).rejects.toBeInstanceOf(SiteNotFoundError);
  });

  it('rejects an empty scope', async () => {
    await expect(
      repo.publishProject({ workspaceId: '', tenantGroupId: 'tg' }, 'site_1'),
    ).rejects.toBeInstanceOf(InvalidTenantScopeError);
    expect(prisma.site.updateMany).not.toHaveBeenCalled();
  });
});

describe('SiteRepository.deleteSite', () => {
  it('scopes the delete by workspace_id and throws when nothing matched', async () => {
    prisma.site.deleteMany.mockResolvedValue({ count: 0 });
    await expect(repo.deleteSite(SCOPE, 'site_other_ws')).rejects.toBeInstanceOf(
      SiteNotFoundError,
    );
    expect(prisma.site.deleteMany).toHaveBeenCalledWith({
      where: { id: 'site_other_ws', workspaceId: 'ws_marlin' },
    });
  });

  it('succeeds when a row in the workspace was deleted', async () => {
    prisma.site.deleteMany.mockResolvedValue({ count: 1 });
    await expect(repo.deleteSite(SCOPE, 'site_1')).resolves.toBeUndefined();
  });
});
