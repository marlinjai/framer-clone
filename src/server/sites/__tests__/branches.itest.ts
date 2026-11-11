// src/server/sites/__tests__/branches.itest.ts
//
// Site branches, slice S1 (docs/plans/2026-11-10-site-branches.md): the data model, its constraints and the
// repository, against a REAL Postgres (the integration globalSetup's throwaway container).
//
// Covered: a branch is an exact copy of main's working copy with the right fork point; every database constraint
// refuses what it should (publishing, a live revision, a domain, another workspace, a branch of a branch, moving
// the parent pointer); the repository refuses publish, rollback, unpublish, an address and a site delete on a
// branch; listings show main sites only; a foreign company gets 404 everywhere; images are main's; deleting main
// deletes its branches; an erase of personal data reaches every copy a branch keeps. The four paths of the flow
// as far as S1 has one: forward (create, edit, ready, discard), backtrack (back to open withdraws an approval),
// resume (a retried create answers the first one), re-entry (a discarded branch answers 410 to every write, and
// its name is free again).
//
// The merge itself, and "an erase followed by a merge leaves nothing behind", are S2 and S3.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { getPrismaClient } from '@/server/db';
import {
  BranchCannotPublishError,
  BranchClosedError,
  BranchLimitError,
  BranchNameTakenError,
  BranchNotFoundError,
  InvalidBranchNameError,
  SiteIsBranchError,
  SiteNotFoundError,
  type TenantScope,
} from '@/server/sites';
import { SiteBranchRepository } from '@/server/sites/branches/repository';
import { parseRevisionDocument } from '@/server/sites/revision';
import { SiteImageError, deleteSiteImage, listSiteImages, readSiteImage, storeSiteImage } from '@/server/sites/siteImages';
import { MAX_OPEN_BRANCHES_PER_SITE } from '@/lib/sites/branches';
import { png } from '@/lib/images/__tests__/fixtures';
import { latestVersionRepository } from './latestVersionRepository';

const TENANT_GROUP = '018f9c10-0000-7000-8000-0000000b5a01';
const OTHER_GROUP = '018f9c10-0000-7000-8000-0000000b5a02';
const COMPANY = 'company-branches';
const ALICE = { kind: 'user' as const, id: 'user-alice' };
const BOB = { kind: 'user' as const, id: 'user-bob' };
const VALUE = 'Max Mustermann';

let prisma: PrismaClient;
let branches: SiteBranchRepository;
let scope: TenantScope;
let foreign: TenantScope;
let mainId: string;

function page(id: string, slug: string, text: string) {
  return {
    id,
    slug,
    metadata: { title: id, description: `About ${text}` },
    appComponentTree: { id: `root-${id}`, type: 'div', componentType: 'host', props: { children: text }, children: [] },
    canvasNodes: {},
  };
}

function project(id: string, who: string, over: { description?: string; favicon?: string; erasureEpoch?: number } = {}) {
  return {
    id,
    metadata: {
      title: 'Bakery',
      description: over.description ?? 'A bakery',
      createdAt: 1,
      updatedAt: 2,
      ...(over.erasureEpoch === undefined ? {} : { erasureEpoch: over.erasureEpoch }),
    },
    pages: { home: page('home', '', `Run by ${who}`), about: page('about', 'about', `Ask ${who}`) },
    siteSettings: {
      siteName: 'Bakery',
      faviconUrl: over.favicon ?? '',
      business: { legalName: 'Bakery GmbH', managingDirectors: [who] },
    },
  } as never;
}

async function create(name = 'Spring sale', actor = ALICE, over: { scope?: TenantScope; branchId?: string; main?: string } = {}) {
  return branches.createBranch(over.scope ?? scope, over.main ?? mainId, { name, actor, branchId: over.branchId });
}

/** What a page row of a site holds, by page id. */
async function pagesOf(siteId: string) {
  const rows = await prisma.sitePage.findMany({ where: { siteId }, orderBy: { pageId: 'asc' }, select: { pageId: true, slug: true, snapshot: true } });
  return rows;
}

/** The Prisma error code, or the Postgres message, of a refused statement. */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) return `${err.code} ${err.message}`;
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('the statement was not refused');
}

beforeAll(() => {
  prisma = getPrismaClient();
  branches = new SiteBranchRepository(prisma);
});

beforeEach(async () => {
  scope = { workspaceId: `ws_br_${randomUUID().slice(0, 8)}`, tenantGroupId: TENANT_GROUP };
  foreign = { workspaceId: `ws_brx_${randomUUID().slice(0, 8)}`, tenantGroupId: OTHER_GROUP };
  mainId = randomUUID();
  await latestVersionRepository().saveProject(scope, project(mainId, 'Erika Muster'), { companyId: COMPANY });
});

afterAll(async () => {
  await prisma.site.deleteMany({ where: { tenantGroupId: { in: [TENANT_GROUP, OTHER_GROUP] }, branchOfSiteId: { not: null } } });
  await prisma.site.deleteMany({ where: { tenantGroupId: { in: [TENANT_GROUP, OTHER_GROUP] } } });
  await prisma.siteErasure.deleteMany({ where: { tenantGroupId: TENANT_GROUP } });
  await prisma.$disconnect();
});

describe('forward: creating a branch', () => {
  it('is an exact copy of main as stored, with main version and document as its fork point', async () => {
    const repo = latestVersionRepository();
    await repo.saveProject(scope, project(mainId, 'Erika Muster', { description: 'Fresh bread' }), { mustExist: true });
    const mainVersion = (await repo.getSiteVersion(scope, mainId));

    const { branch, created } = await create();
    expect(created).toBe(true);
    expect(branch).toMatchObject({
      mainSiteId: mainId,
      name: 'Spring sale',
      status: 'open',
      version: 1,
      baseVersion: mainVersion,
      mainMoved: false,
      createdByKind: 'user',
      createdBy: ALICE.id,
      approved: false,
    });

    const [main, copy] = await Promise.all(
      [mainId, branch.branchId].map((id) =>
        prisma.site.findUniqueOrThrow({
          where: { id },
          select: {
            name: true, description: true, siteSettings: true, components: true, analyticsProjectId: true, lumitraEnabled: true,
            companyId: true, erasureEpoch: true, status: true, branchOfSiteId: true, workspaceId: true, tenantGroupId: true,
            publishedRevisionId: true,
          },
        }),
      ),
    );
    expect(copy).toEqual({ ...main, branchOfSiteId: mainId });
    expect(copy.companyId).toBe(COMPANY);
    expect(await pagesOf(branch.branchId)).toEqual(await pagesOf(mainId));

    const record = await prisma.siteBranch.findUniqueOrThrow({ where: { id: branch.branchId } });
    expect(record).toMatchObject({ siteId: mainId, branchSiteId: branch.branchId, workspaceId: scope.workspaceId, companyId: COMPANY });
    const base = parseRevisionDocument(record.baseDocument);
    expect(base.description).toBe('Fresh bread');
    expect(base.pages.map((p) => p.pageId).sort()).toEqual(['about', 'home']);
    expect(JSON.stringify(base.siteSettings)).toContain('Erika Muster');
  });

  it('opens in the editor like any site, and saves under its own version lock with main untouched', async () => {
    const repo = latestVersionRepository();
    const { branch } = await create();
    const loaded = await repo.loadProjectWithVersion(scope, branch.branchId);
    expect(loaded.version).toBe(1);
    const mainBefore = await repo.getSiteVersion(scope, mainId);
    await repo.saveProject(scope, project(branch.branchId, 'Branch Author'), { mustExist: true, expectedVersion: 1 });

    expect(await repo.getSiteVersion(scope, branch.branchId)).toBe(2);
    expect(await repo.getSiteVersion(scope, mainId)).toBe(mainBefore);
    expect(JSON.stringify(await pagesOf(mainId))).not.toContain('Branch Author');
    // Main written since the fork: the listing says so.
    await repo.saveProject(scope, project(mainId, 'Main Author'), { mustExist: true });
    const listed = await branches.listBranches(scope, mainId);
    expect(listed.open[0]).toMatchObject({ branchId: branch.branchId, version: 2, mainMoved: true });
  });

  it('cleans the name and refuses an empty or too long one', async () => {
    const { branch } = await create('  New‮hero \u0007 ');
    expect(branch.name).toBe('New hero');
    await expect(create('​ ')).rejects.toBeInstanceOf(InvalidBranchNameError);
    await expect(create('x'.repeat(61))).rejects.toBeInstanceOf(InvalidBranchNameError);
  });

  it('keeps a name unique among open branches, compared without case', async () => {
    await create('Spring sale');
    await expect(create('SPRING SALE')).rejects.toBeInstanceOf(BranchNameTakenError);
    // Two creates racing past the check: the partial unique index decides.
    const both = await Promise.allSettled([create('Race'), create('race')]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = both.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(BranchNameTakenError);
  });

  it(`allows at most ${MAX_OPEN_BRANCHES_PER_SITE} open branches per site, counted under the lock`, async () => {
    const made = await Promise.allSettled(
      Array.from({ length: MAX_OPEN_BRANCHES_PER_SITE + 2 }, (_, i) => create(`Branch ${i}`)),
    );
    expect(made.filter((r) => r.status === 'fulfilled')).toHaveLength(MAX_OPEN_BRANCHES_PER_SITE);
    for (const r of made.filter((m) => m.status === 'rejected') as PromiseRejectedResult[]) {
      expect(r.reason).toBeInstanceOf(BranchLimitError);
    }
    // A discarded one frees its place.
    const first = (made[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof create>>>).value.branch;
    await branches.discardBranch(scope, mainId, first.branchId, ALICE);
    await expect(create('One more')).resolves.toMatchObject({ created: true });
  });
});

describe('resume: a retried create', () => {
  it('answers the branch the first request made, never a second one', async () => {
    const branchId = randomUUID();
    const first = await create('Retry', ALICE, { branchId });
    const again = await create('Retry', ALICE, { branchId });
    expect(again).toEqual({ branch: first.branch, created: false });
    expect(await prisma.siteBranch.count({ where: { siteId: mainId } })).toBe(1);
  });

  it('refuses an id that is someone else’s branch, another site’s, or another workspace’s site, like a missing one', async () => {
    const branchId = randomUUID();
    await create('Retry', ALICE, { branchId });
    await expect(create('Retry', BOB, { branchId })).rejects.toBeInstanceOf(BranchNotFoundError);
    const otherMain = randomUUID();
    await latestVersionRepository().saveProject(scope, project(otherMain, 'Erika Muster'));
    await expect(create('Retry', ALICE, { branchId, main: otherMain })).rejects.toBeInstanceOf(BranchNotFoundError);
    const foreignSite = randomUUID();
    await latestVersionRepository().saveProject(foreign, project(foreignSite, 'Someone'));
    await expect(create('Taken id', ALICE, { branchId: foreignSite })).rejects.toBeInstanceOf(BranchNotFoundError);
    await expect(create('Main id', ALICE, { branchId: mainId })).rejects.toBeInstanceOf(BranchNotFoundError);
  });
});

describe('the database refuses what a branch may never be, whatever code runs', () => {
  it('published, or carrying a live revision', async () => {
    const { branch } = await create();
    expect(await refusal(() => prisma.site.update({ where: { id: branch.branchId }, data: { status: 'published' } }))).toContain(
      'sites_branch_never_published_check',
    );
    // Main's revision, pointed at from the branch.
    await latestVersionRepository().publishProject(scope, project(mainId, 'Erika Muster'));
    const revision = await prisma.siteRevision.findFirstOrThrow({ where: { siteId: mainId }, select: { id: true } });
    expect(
      await refusal(() => prisma.site.update({ where: { id: branch.branchId }, data: { publishedRevisionId: revision.id } })),
    ).toContain('sites_branch_never_published_check');
  });

  it('holding a domain', async () => {
    const { branch } = await create();
    expect(
      await refusal(() =>
        prisma.siteDomain.create({
          data: { siteId: branch.branchId, workspaceId: scope.workspaceId, tenantGroupId: TENANT_GROUP, subdomain: `br${randomUUID().slice(0, 8)}` },
        }),
      ),
    ).toContain('cannot hold a domain');
  });

  it('a branch of a branch, or a parent pointer that moves', async () => {
    const { branch } = await create();
    await expect(branches.createBranch(scope, branch.branchId, { name: 'Nested', actor: ALICE })).rejects.toBeInstanceOf(SiteIsBranchError);
    const now = new Date();
    expect(
      await refusal(() =>
        prisma.site.create({
          data: {
            id: randomUUID(), workspaceId: scope.workspaceId, tenantGroupId: TENANT_GROUP, name: 'x',
            projectCreatedAt: now, projectUpdatedAt: now, branchOfSiteId: branch.branchId,
          },
        }),
      ),
    ).toContain('cannot be made from another branch');
    expect(await refusal(() => prisma.site.update({ where: { id: branch.branchId }, data: { branchOfSiteId: null } }))).toContain(
      'never changed',
    );
    expect(await refusal(() => prisma.site.update({ where: { id: mainId }, data: { branchOfSiteId: branch.branchId } }))).toContain(
      'never changed',
    );
  });

  it('a branch in another workspace than its site', async () => {
    const now = new Date();
    expect(
      await refusal(() =>
        prisma.site.create({
          data: {
            id: randomUUID(), workspaceId: foreign.workspaceId, tenantGroupId: OTHER_GROUP, name: 'x',
            projectCreatedAt: now, projectUpdatedAt: now, branchOfSiteId: mainId,
          },
        }),
      ),
    ).toMatch(/P2003|foreign key/i);
  });
});

describe('the repository refuses what only main may do', () => {
  it('publish, rollback, unpublish, an address, a site delete, an erase', async () => {
    const repo = latestVersionRepository();
    const { branch } = await create();
    await expect(repo.publishProject(scope, project(branch.branchId, 'x'), { expectedVersion: 1 })).rejects.toBeInstanceOf(
      BranchCannotPublishError,
    );
    await expect(repo.rollbackToRevision(scope, branch.branchId, 1)).rejects.toBeInstanceOf(BranchCannotPublishError);
    await expect(repo.unpublishProject(scope, branch.branchId)).rejects.toBeInstanceOf(BranchCannotPublishError);
    await expect(repo.ensureSiteDomain(scope, branch.branchId)).rejects.toBeInstanceOf(BranchCannotPublishError);
    await expect(repo.deleteSite(scope, branch.branchId)).rejects.toBeInstanceOf(SiteIsBranchError);
    await expect(repo.searchPersonalData(scope, branch.branchId, { value: VALUE, caseSensitive: false })).rejects.toBeInstanceOf(
      SiteIsBranchError,
    );
    // Nothing of it happened.
    expect(await prisma.site.findUniqueOrThrow({ where: { id: branch.branchId }, select: { status: true, version: true } })).toEqual({
      status: 'draft',
      version: 1,
    });
    expect(await prisma.siteDomain.count({ where: { siteId: branch.branchId } })).toBe(0);
  });

  it('lists main sites only, each with its count of open branches; a branch shows its site address', async () => {
    const repo = latestVersionRepository();
    await create('One');
    await create('Two');
    const listed = await repo.listSites(scope);
    expect(listed.map((s) => [s.siteId, s.openBranches])).toEqual([[mainId, 2]]);
    const { subdomain } = await repo.ensureSiteDomain(scope, mainId);
    const { branch } = await create('Three');
    const address = await repo.getSiteAddress(scope, branch.branchId, 'sites.lumitra.co');
    expect(address).toEqual({ host: `${subdomain}.sites.lumitra.co`, everPublished: true });
  });
});

describe('tenant isolation', () => {
  it('another company sees nothing and changes nothing: every call answers like a missing site', async () => {
    const { branch } = await create();
    await expect(branches.listBranches(foreign, mainId)).rejects.toBeInstanceOf(SiteNotFoundError);
    await expect(branches.getBranch(foreign, mainId, branch.branchId)).rejects.toBeInstanceOf(SiteNotFoundError);
    await expect(create('Intruder', BOB, { scope: foreign })).rejects.toBeInstanceOf(SiteNotFoundError);
    await expect(branches.renameBranch(foreign, mainId, branch.branchId, 'Mine')).rejects.toBeInstanceOf(SiteNotFoundError);
    await expect(branches.setBranchReady(foreign, mainId, branch.branchId, true, BOB)).rejects.toBeInstanceOf(SiteNotFoundError);
    await expect(branches.discardBranch(foreign, mainId, branch.branchId, BOB)).rejects.toBeInstanceOf(SiteNotFoundError);
    await expect(branches.siteBranchContext(foreign, branch.branchId)).rejects.toBeInstanceOf(SiteNotFoundError);
    await expect(latestVersionRepository().loadProjectWithVersion(foreign, branch.branchId)).rejects.toBeInstanceOf(SiteNotFoundError);
    expect(await prisma.siteBranch.findUniqueOrThrow({ where: { id: branch.branchId }, select: { name: true, status: true } })).toEqual({
      name: 'Spring sale',
      status: 'open',
    });
  });

  it('a branch named under another main site of the same workspace is not found', async () => {
    const otherMain = randomUUID();
    await latestVersionRepository().saveProject(scope, project(otherMain, 'Erika Muster'));
    const { branch } = await create();
    await expect(branches.getBranch(scope, otherMain, branch.branchId)).rejects.toBeInstanceOf(BranchNotFoundError);
    await expect(branches.discardBranch(scope, otherMain, branch.branchId, ALICE)).rejects.toBeInstanceOf(BranchNotFoundError);
  });
});

describe('ready for review, and back to open', () => {
  it('marks ready, and back to open withdraws an approval', async () => {
    const { branch } = await create();
    const ready = await branches.setBranchReady(scope, mainId, branch.branchId, true, ALICE);
    expect(ready).toMatchObject({ status: 'ready', readyBy: ALICE.id });
    // An approval of the current version (written by S3's review route; set here directly).
    await prisma.siteBranch.update({ where: { id: branch.branchId }, data: { approvedBy: BOB.id, approvedBranchVersion: 1 } });
    expect((await branches.getBranch(scope, mainId, branch.branchId)).approved).toBe(true);
    const open = await branches.setBranchReady(scope, mainId, branch.branchId, false, ALICE);
    expect(open).toMatchObject({ status: 'open', readyBy: null, approved: false });
  });

  it('an edit of the branch keeps ready and withdraws the approval', async () => {
    const { branch } = await create();
    await branches.setBranchReady(scope, mainId, branch.branchId, true, ALICE);
    await prisma.siteBranch.update({ where: { id: branch.branchId }, data: { approvedBy: BOB.id, approvedBranchVersion: 1 } });
    await latestVersionRepository().saveProject(scope, project(branch.branchId, 'Edited'), { mustExist: true });
    expect(await branches.getBranch(scope, mainId, branch.branchId)).toMatchObject({ status: 'ready', approved: false, version: 2 });
  });
});

describe('re-entry: a discarded branch', () => {
  it('loses its content at once, keeps its record, and answers 410 to every later write', async () => {
    const repo = latestVersionRepository();
    const { branch } = await create();
    const outcome = await branches.discardBranch(scope, mainId, branch.branchId, BOB);
    expect(outcome).toMatchObject({ discarded: true, branch: { status: 'discarded', version: null, baseVersion: null } });
    expect(await prisma.site.count({ where: { id: branch.branchId } })).toBe(0);
    expect(await prisma.sitePage.count({ where: { siteId: branch.branchId } })).toBe(0);
    expect(await prisma.siteBranch.findUniqueOrThrow({ where: { id: branch.branchId } })).toMatchObject({
      status: 'discarded', branchSiteId: null, baseDocument: null, discardedBy: BOB.id,
    });

    // A repeat answers the same outcome.
    expect(await branches.discardBranch(scope, mainId, branch.branchId, BOB)).toMatchObject({ discarded: false, branch: { status: 'discarded' } });
    // An open tab's save, an agent's load, a rename: 410 naming the site.
    const save = repo.saveProject(scope, project(branch.branchId, 'Late'), { mustExist: true, expectedVersion: 1 });
    await expect(save).rejects.toBeInstanceOf(BranchClosedError);
    await expect(save).rejects.toMatchObject({ status: 410, code: 'branch_closed', mainSiteId: mainId, branchStatus: 'discarded' });
    await expect(repo.loadProjectWithVersion(scope, branch.branchId)).rejects.toBeInstanceOf(BranchClosedError);
    await expect(branches.siteBranchContext(scope, branch.branchId)).rejects.toBeInstanceOf(BranchClosedError);
    await expect(branches.renameBranch(scope, mainId, branch.branchId, 'Again')).rejects.toBeInstanceOf(BranchClosedError);
    await expect(branches.setBranchReady(scope, mainId, branch.branchId, true, ALICE)).rejects.toBeInstanceOf(BranchClosedError);
    // The late save did not bring it back.
    expect(await prisma.site.count({ where: { id: branch.branchId } })).toBe(0);

    // Its name is free, and a new branch of it starts from main as it is now, with nothing left over.
    const again = await create('Spring sale');
    expect(again.branch).toMatchObject({ status: 'open', approved: false, version: 1, readyAt: null });
    const listed = await branches.listBranches(scope, mainId);
    expect(listed.open.map((b) => b.branchId)).toEqual([again.branch.branchId]);
    expect(listed.closed.map((b) => [b.branchId, b.status])).toEqual([[branch.branchId, 'discarded']]);
  });

  it('a merged record answers 410 merged to a discard', async () => {
    const { branch } = await create();
    await prisma.$transaction((tx) => branches.closeRecord(tx, branch.branchId, { status: 'merged', mergedBy: ALICE.id, mergedAt: new Date() }));
    await expect(branches.discardBranch(scope, mainId, branch.branchId, ALICE)).rejects.toMatchObject({ code: 'branch_closed', branchStatus: 'merged' });
  });
});

describe('deleting main', () => {
  it('deletes its branches, their pages and records with it', async () => {
    const one = (await create('One')).branch.branchId;
    const two = (await create('Two')).branch.branchId;
    await branches.discardBranch(scope, mainId, two, ALICE);
    await latestVersionRepository().deleteSite(scope, mainId);
    expect(await prisma.site.count({ where: { id: { in: [mainId, one] } } })).toBe(0);
    expect(await prisma.sitePage.count({ where: { siteId: one } })).toBe(0);
    expect(await prisma.siteBranch.count({ where: { siteId: mainId } })).toBe(0);
  });
});

describe('uploaded images belong to main', () => {
  it('an upload from a branch is stored on main, readable from both, and named by a branch it stays in use', async () => {
    const repo = latestVersionRepository();
    const { branch } = await create();
    const owner = { id: branch.branchId, workspaceId: scope.workspaceId, tenantGroupId: TENANT_GROUP };
    const { image } = await storeSiteImage(owner, png(64, 64), 'favicon', ALICE.id, prisma);
    expect(await prisma.siteImage.count({ where: { siteId: mainId, sha256: image.sha256 } })).toBe(1);
    expect(await prisma.siteImage.count({ where: { siteId: branch.branchId } })).toBe(0);
    expect(await readSiteImage(branch.branchId, image.sha256, prisma)).not.toBeNull();
    expect(await readSiteImage(mainId, image.sha256, prisma)).not.toBeNull();

    // The branch's save names it: the check finds it on main.
    await repo.saveProject(scope, project(branch.branchId, 'Erika Muster', { favicon: image.path }), { mustExist: true });
    // Main does not name it, the branch does: it cannot be deleted, from either side.
    expect((await listSiteImages(mainId, prisma)).items[0]).toMatchObject({ sha256: image.sha256, inUse: true });
    await expect(deleteSiteImage(mainId, image.sha256, prisma)).rejects.toMatchObject({ code: 'image_in_use' });
    await expect(deleteSiteImage(branch.branchId, image.sha256, prisma)).rejects.toBeInstanceOf(SiteImageError);

    // Once the branch no longer names it (here: discarded), only the fork point could; it named none.
    await branches.discardBranch(scope, mainId, branch.branchId, ALICE);
    await expect(deleteSiteImage(mainId, image.sha256, prisma)).resolves.toBeUndefined();
  });
});

describe('an erase of personal data reaches every copy a branch keeps', () => {
  it('finds the value in an open branch, its fork point, its name, a closed record and a kept pre-merge copy, and erases it everywhere', async () => {
    const repo = latestVersionRepository();
    await repo.saveProject(scope, project(mainId, VALUE), { mustExist: true });
    const { branch } = await create(`Page for ${VALUE}`);
    await prisma.siteBranch.update({ where: { id: branch.branchId }, data: { mergeDraft: { answers: { x: 'hash-of-a-value' } } } });
    // Main moves on without the value; the branch and its fork point keep it.
    await repo.saveProject(scope, project(mainId, 'Erika Muster'), { mustExist: true });
    // A closed branch with a review note and a kept pre-merge copy holding it (as S7 keeps one).
    const closed = (await create('Old work')).branch.branchId;
    const baseOfClosed = (await prisma.siteBranch.findUniqueOrThrow({ where: { id: closed } })).baseDocument;
    await prisma.$transaction((tx) => branches.closeRecord(tx, closed, { status: 'merged', mergedAt: new Date() }));
    await prisma.siteBranch.update({
      where: { id: closed },
      data: { reviewNote: `Ask ${VALUE} first`, mainBeforeDocument: JSON.parse(JSON.stringify(baseOfClosed).replaceAll('Erika Muster', VALUE)) },
    });

    const branchVersion = await repo.getSiteVersion(scope, branch.branchId);
    const epochBefore = (await prisma.site.findUniqueOrThrow({ where: { id: branch.branchId }, select: { erasureEpoch: true } })).erasureEpoch;
    const query = { value: VALUE, caseSensitive: false };
    const preview = await repo.searchPersonalData(scope, mainId, query);
    const kinds = preview.locations.filter((l) => l.matches > 0).map((l) => l.location.kind);
    expect(kinds).toEqual(expect.arrayContaining(['branch', 'branch-base', 'merge-undo']));
    expect(preview.locations.find((l) => l.location.kind === 'working')?.matches).toBe(0);

    const result = await repo.erasePersonalData(scope, mainId, {
      query,
      replacement: '[entfernt]',
      token: preview.token,
      chosen: preview.matches.filter((m) => m.blocked === null).map((m) => m.id),
      erasedBy: ALICE.id,
    });
    expect(result.remaining).toBe(0);
    expect(result.places.some((p) => p.branchId === branch.branchId)).toBe(true);
    expect(JSON.stringify(result.places)).not.toContain(VALUE);

    // Nothing anywhere: every site row of the workspace, every page, every record.
    const stored = JSON.stringify([
      await prisma.site.findMany({ where: { workspaceId: scope.workspaceId }, include: { pages: true } }),
      await prisma.siteBranch.findMany({ where: { siteId: mainId } }),
    ]);
    expect(stored).not.toContain(VALUE);
    expect((await repo.searchPersonalData(scope, mainId, query)).total).toBe(0);

    // The branch moved with main: an older tab of it is refused, an agent loads again, the review starts over.
    const after = await prisma.site.findUniqueOrThrow({ where: { id: branch.branchId }, select: { erasureEpoch: true, version: true } });
    expect(after).toEqual({ erasureEpoch: epochBefore + 1, version: branchVersion + 1 });
    expect((await prisma.siteBranch.findUniqueOrThrow({ where: { id: branch.branchId } })).mergeDraft).toBeNull();
    const renamed = await branches.getBranch(scope, mainId, branch.branchId);
    expect(renamed.name).toBe('Page for [entfernt]');
    await expect(
      repo.saveProject(scope, project(branch.branchId, VALUE, { erasureEpoch: epochBefore }), { mustExist: true, expectedVersion: after.version }),
    ).rejects.toMatchObject({ code: 'erased_since_load' });
  });
});
