// src/server/sites/__tests__/saveLocking.itest.ts
//
// A site's writes are serialised by LOCKING THE SITE, not by the SERIALIZABLE isolation level
// (docs/plans/2026-11-12-save-serializable-contention.md). Against a REAL Postgres.
//
// What the plan found: a save ran SERIALIZABLE with four immediate retries, and Postgres' predicate locks
// (`max_pred_locks_per_page` = 2) made saves of DIFFERENT sites abort one another (P2034). A 3-page save failed 4 of
// 6 times beside six other writers. So the first test is the measurement itself, made a test: beside other writers
// of other sites, every save commits in ONE transaction (zero retries), and the rest hold the invariants the
// isolation level used to carry for this write path: one writer of a site at a time (the version lock still picks
// one winner), two creators of one id never both win, a branch save naming an image and the delete of that image
// never both commit, and a mix of every writer of a site terminates with no deadlock.
//
// Runs only under `pnpm test:integration` (Docker).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '@/server/db';
import { SiteChangedError, SiteImageMissingError, SiteVersionRequiredError, type TenantScope } from '@/server/sites';
import { SiteBranchRepository } from '@/server/sites/branches/repository';
import { SiteImageError, deleteSiteImage, storeSiteImage } from '@/server/sites/siteImages';
import { png } from '@/lib/images/__tests__/fixtures';
import { latestVersionRepository } from './latestVersionRepository';
import { SiteRepository } from '../repository';

const TENANT_GROUP = '018f9c10-0000-7000-8000-0000000b5a51';
const ACTOR = { kind: 'user' as const, id: 'user-lock' };

let prisma: PrismaClient;
const scopeOf = (): TenantScope => ({ workspaceId: `ws_lock_${randomUUID().slice(0, 8)}`, tenantGroupId: TENANT_GROUP });

function page(id: string, slug: string, text: string) {
  return {
    id,
    slug,
    metadata: { title: id },
    appComponentTree: { id: `root-${id}`, type: 'div', componentType: 'host', props: { children: text }, children: [] },
    canvasNodes: {},
  };
}

function project(siteId: string, over: { pages?: Record<string, unknown>; favicon?: string; text?: string } = {}) {
  return {
    id: siteId,
    metadata: { title: 'Bakery', description: '', createdAt: 1, updatedAt: 2 },
    pages: over.pages ?? { home: page('home', '', over.text ?? 'x'), about: page('about', 'about', over.text ?? 'y') },
    siteSettings: { siteName: 'Bakery', faviconUrl: over.favicon ?? '' },
  } as never;
}

const bigPages = (count: number, bytes: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`p${i}`, page(`p${i}`, i === 0 ? '' : `p${i}`, randomBytes(bytes / 2).toString('hex'))]));

beforeAll(() => {
  prisma = getPrismaClient();
});

afterAll(async () => {
  await prisma.site.deleteMany({ where: { tenantGroupId: TENANT_GROUP, branchOfSiteId: { not: null } } });
  await prisma.site.deleteMany({ where: { tenantGroupId: TENANT_GROUP } });
  await prisma.$disconnect();
});

/** A transaction that holds a site's row lock until released, as a long writer of that site would. */
async function holdSiteLock(siteId: string): Promise<{ release: () => void; done: Promise<void> }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const done = prisma
    .$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM public.sites WHERE id = ${siteId} FOR UPDATE`;
        locked();
        await gate;
      },
      { timeout: 60_000 },
    )
    .then(() => undefined);
  await ready;
  return { release, done };
}

/** A transaction that holds an arbitrary lock until released. */
async function holdLock(lock: (tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<unknown>): Promise<{ release: () => void; done: Promise<void> }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const done = prisma
    .$transaction(
      async (tx) => {
        await lock(tx);
        locked();
        await gate;
      },
      { timeout: 60_000 },
    )
    .then(() => undefined);
  await ready;
  return { release, done };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('saves of different sites do not conflict', () => {
  it('beside six other writers, every save commits in one transaction: no retry, no failure', async () => {
    const repo = latestVersionRepository();
    const spy = vi.spyOn(prisma, '$transaction');
    let stop = false;
    let committed = 0;
    const failures: unknown[] = [];
    const background = Array.from({ length: 6 }, async () => {
      for (let i = 0; i < 12 && !stop; i += 1) {
        try {
          await repo.saveProject(scopeOf(), project(randomUUID()));
          committed += 1;
        } catch (err) {
          failures.push(err);
        }
      }
    });
    const foreground = (async () => {
      for (let i = 0; i < 4; i += 1) {
        try {
          await repo.saveProject(scopeOf(), project(randomUUID(), { pages: bigPages(20, 40_000) }));
          committed += 1;
        } catch (err) {
          failures.push(err);
        }
      }
    })();
    await Promise.all([...background, foreground]);
    stop = true;
    const started = spy.mock.calls.length;
    spy.mockRestore();
    expect(failures.map((e) => (e as { code?: string }).code ?? String(e))).toEqual([]);
    // One transaction per save: a retry would start another.
    expect(started).toBe(committed);
    expect(committed).toBe(6 * 12 + 4);
  }, 240_000);
});

// The three tests below hold on the old SERIALIZABLE save as well (a retry gives the same answer); they guard the
// invariants the change had to keep. The ones that fail on the old save are the measurement above and the image tests.
describe('one writer of a site at a time', () => {
  it('ten saves racing on one version: exactly one commits and the rest are refused as changed', async () => {
    const repo = new SiteRepository(prisma);
    const scope = scopeOf();
    const siteId = randomUUID();
    const first = await repo.saveProject(scope, project(siteId));
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => repo.saveProject(scope, project(siteId, { text: `writer ${i}` }), { mustExist: true, expectedVersion: first.version })),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost.every((r) => r.reason instanceof SiteChangedError)).toBe(true);
    const row = await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { version: true } });
    expect(row.version).toBe(first.version + 1);
  }, 60_000);

  it('two creators of one id never both win the first save', async () => {
    const repo = new SiteRepository(prisma);
    const scope = scopeOf();
    const siteId = randomUUID();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => repo.saveProject(scope, project(siteId))));
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost.every((r) => r.reason instanceof SiteVersionRequiredError)).toBe(true);
    expect(await prisma.site.count({ where: { id: siteId } })).toBe(1);
    expect(await prisma.sitePage.count({ where: { siteId } })).toBe(2);
  }, 60_000);

  it('a save behind a lock another writer holds waits for it, then writes', async () => {
    const repo = latestVersionRepository();
    const scope = scopeOf();
    const siteId = randomUUID();
    await repo.saveProject(scope, project(siteId));
    const hold = await holdSiteLock(siteId);
    let settled = false;
    const save = repo.saveProject(scope, project(siteId, { text: 'after the wait' }), { mustExist: true }).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(settled).toBe(false);
    hold.release();
    await Promise.all([save, hold.done]);
    expect(settled).toBe(true);
    const home = await prisma.sitePage.findFirstOrThrow({ where: { siteId, pageId: 'home' }, select: { snapshot: true } });
    expect(JSON.stringify(home.snapshot)).toContain('after the wait');
  }, 60_000);
});

describe('a branch save naming an image and the delete of that image never both commit', () => {
  // Each test pins ONE interleaving with real locks, so it fails when the lock that decides it is missing:
  // the branch save's shared lock on main (lockSiteForSave) is what makes the delete wait for it.
  async function setup() {
    const repo = latestVersionRepository();
    const branches = new SiteBranchRepository(prisma);
    const scope = scopeOf();
    const mainId = randomUUID();
    await repo.saveProject(scope, project(mainId));
    const { branch } = await branches.createBranch(scope, mainId, { name: 'Sale', actor: ACTOR });
    const owner = { id: mainId, workspaceId: scope.workspaceId, tenantGroupId: TENANT_GROUP };
    return { repo, scope, mainId, branchId: branch.branchId, owner };
  }
  const stored = async (mainId: string, sha: string) => (await prisma.siteImage.count({ where: { siteId: mainId, sha256: sha } })) === 1;
  const named = async (branchId: string, path: string) =>
    ((await prisma.site.findUniqueOrThrow({ where: { id: branchId }, select: { siteSettings: true } })).siteSettings as { faviconUrl?: string }).faviconUrl === path;
  const outcome = <T,>(run: Promise<T>) =>
    run.then(
      () => 'ok',
      (e: unknown) => (e instanceof SiteImageMissingError ? 'missing' : e instanceof SiteImageError ? e.code : `error ${String(e).slice(0, 80)}`),
    );

  it('the save is in flight (blocked writing a page) when the delete asks: the delete waits for it, then finds the image in use', async () => {
    const { repo, scope, mainId, branchId, owner } = await setup();
    for (let round = 0; round < 5; round += 1) {
      const { image } = await storeSiteImage(owner, png(32 + round, 32 + round), 'favicon', ACTOR.id, prisma);
      // The save passes its image check, then waits on a page row of the branch.
      const page = await holdLock((tx) => tx.$queryRaw`SELECT 1 FROM public.site_pages WHERE site_id = ${branchId} AND page_id = 'home' FOR UPDATE`);
      const save = outcome(repo.saveProject(scope, project(branchId, { favicon: image.path }), { mustExist: true }));
      await pause(400);
      const del = outcome(deleteSiteImage(mainId, image.sha256, prisma));
      await pause(400);
      page.release();
      const [saved, deleted] = await Promise.all([save, del, page.done]);
      expect(saved, `round ${round} save`).toBe('ok');
      expect(deleted, `round ${round} delete`).toBe('image_in_use');
      expect(await stored(mainId, image.sha256)).toBe(true);
      expect(await named(branchId, image.path)).toBe(true);
      await repo.saveProject(scope, project(branchId), { mustExist: true });
      await deleteSiteImage(mainId, image.sha256, prisma);
    }
  }, 120_000);

  it('the delete is in flight (holding main, waiting for the image lock) when the save asks: the save waits for it, then finds the image gone', async () => {
    const { repo, scope, mainId, branchId, owner } = await setup();
    for (let round = 0; round < 5; round += 1) {
      const { image } = await storeSiteImage(owner, png(60 + round, 60 + round), 'favicon', ACTOR.id, prisma);
      const gate = await holdLock((tx) => tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`site_images:${mainId}`}))`);
      const del = outcome(deleteSiteImage(mainId, image.sha256, prisma));
      await pause(400);
      const save = outcome(repo.saveProject(scope, project(branchId, { favicon: image.path }), { mustExist: true }));
      await pause(400);
      gate.release();
      const [deleted, saved] = await Promise.all([del, save, gate.done]);
      expect(deleted, `round ${round} delete`).toBe('ok');
      expect(saved, `round ${round} save`).toBe('missing');
      expect(await stored(mainId, image.sha256)).toBe(false);
      expect(await named(branchId, image.path)).toBe(false);
    }
  }, 120_000);

  it('a branch save naming no image does not wait for main at all', async () => {
    const { repo, scope, mainId, branchId } = await setup();
    const hold = await holdSiteLock(mainId);
    await repo.saveProject(scope, project(branchId, { text: 'no image' }), { mustExist: true });
    hold.release();
    await hold.done;
  }, 60_000);
});

describe('every writer of a site together', () => {
  it('main saves, branch saves, publishes and image deletes terminate: no deadlock, no serialization failure', async () => {
    const repo = latestVersionRepository();
    const branches = new SiteBranchRepository(prisma);
    const scope = scopeOf();
    const mainId = randomUUID();
    await repo.saveProject(scope, project(mainId));
    await prisma.site.update({ where: { id: mainId }, data: { status: 'published' } });
    const { branch } = await branches.createBranch(scope, mainId, { name: 'Mix', actor: ACTOR });
    const owner = { id: mainId, workspaceId: scope.workspaceId, tenantGroupId: TENANT_GROUP };
    const problems: string[] = [];
    const succeeded: Record<string, number> = {};
    const domain: Record<string, string> = {};
    const ok = (label: string) => () => {
      succeeded[label] = (succeeded[label] ?? 0) + 1;
    };
    const deadlocks = async () => Number((await prisma.$queryRaw<{ n: bigint }[]>`SELECT deadlocks AS n FROM pg_stat_database WHERE datname = current_database()`)[0].n);
    const deadlocksBefore = await deadlocks();
    const note = (label: string) => (err: unknown) => {
      const code = (err as { code?: string }).code;
      const text = err instanceof Error ? err.message : String(err);
      domain[label] = `${err instanceof Error ? err.constructor.name : ''} ${text.slice(0, 100)}`;
      // Domain answers are fine; a database conflict or deadlock is the defect.
      if (code === 'P2034' || /deadlock|could not serialize|40001|40P01/i.test(text) || (err instanceof SiteImageError && err.code === 'image_busy')) problems.push(`${label}: ${code ?? ''} ${text.slice(0, 120)}`);
    };
    for (let round = 0; round < 10; round += 1) {
      const { image } = await storeSiteImage(owner, png(40 + round, 40 + round), 'favicon', ACTOR.id, prisma);
      await Promise.all([
        repo.saveProject(scope, project(mainId, { text: `main ${round}` }), { mustExist: true }).then(ok('main save'), note('main save')),
        repo.saveProject(scope, project(branch.branchId, { favicon: image.path, text: `branch ${round}` }), { mustExist: true }).then(ok('branch save'), note('branch save')),
        repo.publishProject(scope, project(mainId, { text: `publish ${round}` })).then(ok('publish'), note('publish')),
        deleteSiteImage(mainId, image.sha256, prisma).then(ok('image delete'), note('image delete')),
        repo.saveProject(scopeOf(), project(randomUUID())).then(ok('other site'), note('other site')),
        repo.saveProject(scope, project(branch.branchId, { text: `branch again ${round}` }), { mustExist: true }).then(ok('branch save 2'), note('branch save 2')),
      ]);
    }
    expect(problems).toEqual([]);
    // A deadlock that a retry hid would still be counted by the database.
    expect(await deadlocks()).toBe(deadlocksBefore);
    // Not everything may have been refused. Two writers of one site that read the same version race by design (the
    // version lock refuses the loser), so success is asked per site: main (a save or a publish), the branch, another site.
    const n = (...labels: string[]) => labels.reduce((sum, label) => sum + (succeeded[label] ?? 0), 0);
    expect(n('main save', 'publish'), `main: ${domain['main save']} / ${domain.publish}`).toBeGreaterThan(0);
    expect(n('branch save', 'branch save 2'), `branch: ${domain['branch save']} / ${domain['branch save 2']}`).toBeGreaterThan(0);
    expect(n('other site')).toBe(10);
  }, 180_000);
});
