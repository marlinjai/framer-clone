// src/app/api/projects/__tests__/versionLock.itest.ts
//
// The version lock against a REAL Postgres (plan
// docs/plans/2026-11-02-lumitra-sites-agent-plugin.md, build step 1): every
// write of a site's working copy moves `sites.version`, and a save or publish
// based on an older version is refused, so an editor tab and an agent never
// overwrite each other unseen. The plain repository (no helper filling in the
// version) and the real save and publish routes, with only the auth-brain
// client and Next's cache mocked.
//
// The four stateful-flow paths (knowledge-base standards, stateful-flow
// testing): forward (load, save, save again), a conflicting write in between
// (refused, then an explicit save over it), resume after a reload (a fresh load
// carries the current version), and re-entry after a failed write (a refused
// save moves nothing, and the same version then saves).
//
// Runs only under `pnpm test:integration` (Docker Postgres).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

const TENANT_GROUP = '018f9c10-0000-7000-8000-00000000a0c1';
const WORKSPACE = 'ws_version_lock';
const SESSION = {
  user: { id: 'user-lock' },
  session: {},
  tenants: [{ id: 'tenant-lock', app_grants: ['sites'], group_id: TENANT_GROUP }],
  workspaces: [{ id: WORKSPACE, tenant_id: 'tenant-lock' }],
  active_tenant: { id: 'tenant-lock' },
  active_workspace: { id: WORKSPACE },
};

vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    verifySession: vi.fn(async (cookie: string) => (cookie === 'sess_lock' ? SESSION : null)),
    can: vi.fn(async () => true),
    verifyApiKey: vi.fn(),
    getCurrentUser: vi.fn(),
  },
}));
vi.mock('next/cache', () => ({ unstable_cache: vi.fn(), revalidateTag: vi.fn() }));

import { getPrismaClient } from '@/server/db';
import {
  SiteChangedError,
  SiteRepository,
  SiteVersionRequiredError,
  InvalidPageSlugError,
  type TenantScope,
} from '@/server/sites';
import { POST as SAVE } from '../save/route';
import { POST as PUBLISH } from '../publish/route';

const scope: TenantScope = { workspaceId: WORKSPACE, tenantGroupId: TENANT_GROUP };
let prisma: PrismaClient;
let repo: SiteRepository;
let siteId: string;

function page(id: string, slug: string, text: string) {
  return {
    id,
    slug,
    metadata: { title: id },
    appComponentTree: { id: `root-${id}`, type: 'div', componentType: 'host', props: { children: text }, children: [] },
    canvasNodes: {},
  };
}

/** A project snapshot whose home page says `text`, so a test can tell versions apart. */
function project(text: string, aboutSlug = 'about') {
  return {
    id: siteId,
    metadata: { title: 'Bakery', description: '', createdAt: 1, updatedAt: 2 },
    pages: { home: page('home', '', text), about: page('about', aboutSlug, text) },
  } as never;
}

async function storedText(): Promise<unknown> {
  const row = await prisma.sitePage.findUniqueOrThrow({ where: { siteId_pageId: { siteId, pageId: 'home' } } });
  return (row.snapshot as { appComponentTree: { props: { children: unknown } } }).appComponentTree.props.children;
}

async function storedVersion(): Promise<number> {
  return (await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { version: true } })).version;
}

function post(route: typeof SAVE, path: string, body: unknown): Promise<Response> {
  return route(
    new Request(`http://app.lumitra.co/api/projects/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'lumitra_session=sess_lock', host: 'app.lumitra.co' },
      body: JSON.stringify(body),
    }),
  );
}

beforeAll(() => {
  prisma = getPrismaClient();
  repo = new SiteRepository(prisma);
});

beforeEach(async () => {
  siteId = randomUUID();
  // Creating a site is the one write without an expectedVersion.
  await expect(repo.saveProject(scope, project('created'))).resolves.toEqual({ version: 1 });
});

afterAll(async () => {
  await prisma.siteDomain.deleteMany({ where: { tenantGroupId: TENANT_GROUP } });
  await prisma.site.deleteMany({ where: { tenantGroupId: TENANT_GROUP } });
  await prisma.$disconnect();
});

describe('version lock in the repository (real database)', () => {
  it('forward: a load carries the version, each save names it and answers the next one', async () => {
    const loaded = await repo.loadProjectWithVersion(scope, siteId);
    expect(loaded.version).toBe(1);
    await expect(repo.saveProject(scope, project('one'), { mustExist: true, expectedVersion: 1 })).resolves.toEqual({
      version: 2,
    });
    await expect(repo.saveProject(scope, project('two'), { mustExist: true, expectedVersion: 2 })).resolves.toEqual({
      version: 3,
    });
    expect(await storedText()).toBe('two');
    expect((await repo.loadProjectWithVersion(scope, siteId)).version).toBe(3);
  });

  it('a conflicting write in between: the stale save is refused and writes nothing; saving over it is explicit', async () => {
    // Two copies loaded at version 1 (an editor tab and an agent).
    await repo.saveProject(scope, project('agent'), { mustExist: true, expectedVersion: 1 });

    const err = await repo
      .saveProject(scope, project('tab'), { mustExist: true, expectedVersion: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SiteChangedError);
    expect((err as SiteChangedError).currentVersion).toBe(2);
    expect(await storedText()).toBe('agent');
    expect(await storedVersion()).toBe(2);

    // "Save mine over it": the tab names the version it was told about.
    await expect(repo.saveProject(scope, project('tab'), { mustExist: true, expectedVersion: 2 })).resolves.toEqual({
      version: 3,
    });
    expect(await storedText()).toBe('tab');
  });

  it('a stale publish freezes nothing and changes nothing a visitor reads', async () => {
    await repo.saveProject(scope, project('agent'), { mustExist: true, expectedVersion: 1 });
    await expect(repo.publishProject(scope, project('tab'), { expectedVersion: 1 })).rejects.toBeInstanceOf(
      SiteChangedError,
    );
    expect(await prisma.siteRevision.count({ where: { siteId } })).toBe(0);
    const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { status: true, version: true } });
    expect(site).toEqual({ status: 'draft', version: 2 });

    await expect(repo.publishProject(scope, project('tab'), { expectedVersion: 2 })).resolves.toEqual({
      revision: 1,
      version: 3,
    });
  });

  it('resume after a reload: the fresh load carries the current version, and its save goes through', async () => {
    await repo.saveProject(scope, project('elsewhere'), { mustExist: true, expectedVersion: 1 });
    await expect(repo.saveProject(scope, project('stale'), { mustExist: true, expectedVersion: 1 })).rejects.toBeInstanceOf(
      SiteChangedError,
    );
    const reloaded = await repo.loadProjectWithVersion(scope, siteId);
    expect(reloaded.version).toBe(2);
    await expect(
      repo.saveProject(scope, project('after reload'), { mustExist: true, expectedVersion: reloaded.version }),
    ).resolves.toEqual({ version: 3 });
    expect(await storedText()).toBe('after reload');
  });

  it('re-entry after a failed save: a refused save moves nothing, and the same version then saves', async () => {
    await expect(
      repo.saveProject(scope, project('bad slug', 'Not A Slug'), { mustExist: true, expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(InvalidPageSlugError);
    expect(await storedVersion()).toBe(1);
    await expect(repo.saveProject(scope, project('fixed'), { mustExist: true, expectedVersion: 1 })).resolves.toEqual({
      version: 2,
    });
  });

  it('a save naming no version for an existing site is refused, and nothing is written', async () => {
    await expect(repo.saveProject(scope, project('unversioned'), { mustExist: true })).rejects.toBeInstanceOf(
      SiteVersionRequiredError,
    );
    await expect(repo.saveProject(scope, project('unversioned'))).rejects.toBeInstanceOf(SiteVersionRequiredError);
    await expect(repo.publishProject(scope, project('unversioned'))).rejects.toBeInstanceOf(SiteVersionRequiredError);
    expect(await storedText()).toBe('created');
    expect(await storedVersion()).toBe(1);
  });

  it('two writes from the same version at once: exactly one lands, the other is told the new version', async () => {
    const results = await Promise.allSettled([
      repo.saveProject(scope, project('left'), { mustExist: true, expectedVersion: 1 }),
      repo.publishProject(scope, project('right'), { expectedVersion: 1 }),
      repo.saveProject(scope, project('middle'), { mustExist: true, expectedVersion: 1 }),
    ]);
    const landed = results.filter((r) => r.status === 'fulfilled');
    const refused = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    expect(landed).toHaveLength(1);
    expect(refused).toHaveLength(2);
    for (const reason of refused) {
      expect(reason).toBeInstanceOf(SiteChangedError);
      expect((reason as SiteChangedError).currentVersion).toBe(2);
    }
    expect(await storedVersion()).toBe(2);
  });

  it('rename and rollback leave the version alone (neither writes what a save writes)', async () => {
    await repo.publishProject(scope, project('v1'), { expectedVersion: 1 });
    await repo.publishProject(scope, project('v2'), { expectedVersion: 2 });
    expect(await storedVersion()).toBe(3);
    await repo.renameSite(scope, siteId, 'Renamed bakery');
    await repo.rollbackToRevision(scope, siteId, 1);
    expect(await storedVersion()).toBe(3);
    // So a tab loaded before them still saves.
    await expect(repo.saveProject(scope, project('v3'), { mustExist: true, expectedVersion: 3 })).resolves.toEqual({
      version: 4,
    });
  });
});

describe('version lock in the save and publish routes (real database)', () => {
  it('save: answers the new version, 409 site_changed with the current one when stale, 400 without one', async () => {
    const first = await post(SAVE, 'save', { project: project('one'), expectedVersion: 1 });
    expect(first.status).toBe(200);
    expect((await first.json()).version).toBe(2);

    const stale = await post(SAVE, 'save', { project: project('stale'), expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toMatchObject({ code: 'site_changed', currentVersion: 2 });

    const missing = await post(SAVE, 'save', { project: project('missing') });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.code).toBe('version_required');

    expect(await storedText()).toBe('one');
    expect(await storedVersion()).toBe(2);
  });

  it('publish: answers revision and version; a stale publish is 409 and freezes nothing', async () => {
    await repo.saveProject(scope, project('elsewhere'), { mustExist: true, expectedVersion: 1 });

    const stale = await post(PUBLISH, 'publish', { project: project('stale'), expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toMatchObject({ code: 'site_changed', currentVersion: 2 });
    expect(await prisma.siteRevision.count({ where: { siteId } })).toBe(0);

    const missing = await post(PUBLISH, 'publish', { project: project('missing') });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.code).toBe('version_required');

    const ok = await post(PUBLISH, 'publish', { project: project('mine'), expectedVersion: 2 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: 'published', revision: 1, version: 3 });

    // The editor's next Save names what the publish answered.
    const save = await post(SAVE, 'save', { project: project('after publish'), expectedVersion: 3 });
    expect(save.status).toBe(200);
    expect((await save.json()).version).toBe(4);
  });
});
