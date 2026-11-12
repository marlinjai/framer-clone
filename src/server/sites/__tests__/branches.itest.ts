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
import { CLOSED_RECORDS_KEPT, SiteBranchRepository, isIdClash } from '@/server/sites/branches/repository';
import { parseRevisionDocument } from '@/server/sites/revision';
import { SiteImageError, deleteSiteImage, listSiteImages, readSiteImage, storeSiteImage } from '@/server/sites/siteImages';
import { MAX_OPEN_BRANCHES_PER_SITE } from '@/lib/sites/branches';
import { png } from '@/lib/images/__tests__/fixtures';
import { latestVersionRepository } from './latestVersionRepository';
import { cachedDocument, documentEpoch, rememberDocument } from '@/server/sites/liveDocumentCache';
import { EMPTY_SCOPE, eraseCompanyPublic } from '@/server/erasure/public';
import { getSite } from '@/server/siteOps';

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
    const { branch } = await create('  New\u202Ehero \u0007 ');
    expect(branch.name).toBe('New hero');
    await expect(create('\u200B ')).rejects.toBeInstanceOf(InvalidBranchNameError);
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
    const won = made.find((m) => m.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof create>>>;
    const first = won.value.branch;
    await branches.discardBranch(scope, mainId, first.branchId, ALICE);
    await expect(create('One more')).resolves.toMatchObject({ created: true });
  });
});

describe('a closed branch to an agent', () => {
  it('reads as a missing site that names its main site, through the site operations', async () => {
    const { branch } = await create('Agent work');
    await branches.discardBranch(scope, mainId, branch.branchId, ALICE);
    const caller = { scope, companyId: COMPANY, actor: { kind: 'key' as const, id: 'key_1' }, can: () => true };
    const read = await getSite(caller, { siteId: branch.branchId }, { repository: latestVersionRepository(), branches: { enabled: () => true } });
    expect(read).toMatchObject({ ok: false, error: { code: 'site_not_found' } });
    expect(!read.ok && read.error.message).toContain(`was discarded and is closed: nothing can be read from or written to it. Its site is "${mainId}"`);
  });
});

describe('one chosen id for two sites at once', () => {
  it('makes one branch and answers the other create 404, never 500', async () => {
    const otherMain = randomUUID();
    await latestVersionRepository().saveProject(scope, project(otherMain, 'Erika Muster'), { companyId: COMPANY });
    const branchId = randomUUID();
    const raced = await Promise.allSettled([create('A', ALICE, { branchId }), create('B', ALICE, { branchId, main: otherMain })]);
    expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = raced.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(BranchNotFoundError);
  });

  it('tells a taken id from any other unique violation, on the errors Postgres really gives', async () => {
    const caught = async (run: () => Promise<unknown>) => run().then(() => null, (err: unknown) => err);
    const { branch } = await create('Taken');
    const row = await prisma.site.findUniqueOrThrow({ where: { id: mainId } });
    const { id: _id, ...rest } = row;
    void _id;
    // A sites row under an id already in use.
    expect(isIdClash(await caught(() => prisma.site.create({ data: { ...rest, id: branch.branchId, siteSettings: {}, components: {}, redirects: [] } as never })))).toBe(true);
    // The open-name index is not an id clash.
    const nameClash = await caught(() =>
      prisma.siteBranch.create({
        data: { id: randomUUID(), siteId: mainId, workspaceId: scope.workspaceId, tenantGroupId: TENANT_GROUP, name: 'taken', createdByKind: 'user', createdBy: ALICE.id } as never,
      }),
    );
    expect(nameClash).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(isIdClash(nameClash)).toBe(false);
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

  it('refuses an id that is someone else\u2019s branch, another site\u2019s, or another workspace\u2019s site, like a missing one', async () => {
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

describe('the branch record constraints', () => {
  const record = (over: Record<string, unknown>) =>
    prisma.siteBranch.create({
      data: {
        id: randomUUID(), siteId: mainId, workspaceId: scope.workspaceId, tenantGroupId: TENANT_GROUP,
        name: 'Raw', createdByKind: 'user', createdBy: ALICE.id, ...over,
      } as never,
    });

  it('a second open branch with the same name, compared without case, is refused by the index itself', async () => {
    await record({ name: 'Raw' });
    const clash = await refusal(() => record({ name: 'RAW' }));
    // What the repository's name-clash check reads (P2002 naming the name).
    expect(clash).toMatch(/^P2002 /);
    expect(clash).toContain('name');
    // A closed one does not count.
    await expect(record({ name: 'raw', status: 'discarded' })).resolves.toBeTruthy();
  });

  it('refuses a content row other than its own id, an open-looking closed record, a bad name or actor', async () => {
    const { branch } = await create();
    expect(await refusal(() => record({ branchSiteId: branch.branchId }))).toContain('site_branches_content_row_check');
    const id = randomUUID();
    await prisma.$executeRaw`UPDATE public.site_branches SET branch_site_id = NULL WHERE id = ${branch.branchId}`;
    expect(
      await refusal(() => prisma.$executeRaw`UPDATE public.site_branches SET status = 'merged', branch_site_id = ${branch.branchId} WHERE id = ${branch.branchId}`),
    ).toContain('site_branches_closed_check');
    expect(await refusal(() => record({ id, name: '' }))).toContain('site_branches_name_check');
    expect(await refusal(() => record({ name: 'x'.repeat(61) }))).toContain('site_branches_name_check');
    expect(await refusal(() => record({ createdByKind: 'robot' }))).toContain('site_branches_created_by_kind_check');
  });

  it('a record whose content row is deleted some other way reads as closed (the foreign key sets it NULL)', async () => {
    const { branch } = await create();
    await prisma.site.delete({ where: { id: branch.branchId } });
    const record = await prisma.siteBranch.findUniqueOrThrow({ where: { id: branch.branchId } });
    // Closed by the trigger: no content, no fork point kept, the name and the place under the cap are free.
    expect(record).toMatchObject({ branchSiteId: null, status: 'discarded', baseVersion: null, baseDocument: null, mergeDraft: null });
    expect(record.discardedAt).toBeInstanceOf(Date);
    await expect(latestVersionRepository().loadProjectWithVersion(scope, branch.branchId)).rejects.toMatchObject({ code: 'branch_closed' });
    await expect(create(branch.name)).resolves.toMatchObject({ created: true });
  });
});

describe('the backstops added after the whole-feature review', () => {
  const now = new Date();
  const record = (over: Record<string, unknown>) =>
    prisma.siteBranch.create({
      data: {
        id: randomUUID(), siteId: mainId, workspaceId: scope.workspaceId, tenantGroupId: TENANT_GROUP,
        name: `Raw ${randomUUID().slice(0, 6)}`, createdByKind: 'user', createdBy: ALICE.id, ...over,
      } as never,
    });

  it('a record on a branch instead of a main site is refused, on insert and on a move', async () => {
    const { branch } = await create();
    expect(await refusal(() => record({ siteId: branch.branchId }))).toContain('never on another branch');
    const other = await record({ status: 'discarded' });
    expect(
      await refusal(() => prisma.$executeRaw`UPDATE public.site_branches SET site_id = ${branch.branchId} WHERE id = ${other.id}`),
    ).toContain('never on another branch');
  });

  it('a record whose content row is a site of another workspace is refused by the second key', async () => {
    // A site of another workspace, with the id a record of ours would point at.
    const id = randomUUID();
    await prisma.site.create({
      data: { id, workspaceId: foreign.workspaceId, tenantGroupId: OTHER_GROUP, name: 'theirs', projectCreatedAt: now, projectUpdatedAt: now },
    });
    expect(await refusal(() => record({ id, branchSiteId: id }))).toMatch(/P2003|site_branches_branch_site_id_workspace_id_fkey/);
    // Deleting a content row still clears the pointer only: the record keeps its workspace and closes.
    const { branch } = await create();
    await prisma.site.delete({ where: { id: branch.branchId } });
    expect(await prisma.siteBranch.findUniqueOrThrow({ where: { id: branch.branchId } })).toMatchObject({
      branchSiteId: null, workspaceId: scope.workspaceId, status: 'discarded',
    });
  });

  it('the fork point name is kept beside the document by the database, through every write of it', async () => {
    const { branch } = await create();
    const baseName = async () =>
      (await prisma.$queryRaw<{ base_name: string | null }[]>`SELECT base_name FROM public.site_branches WHERE id = ${branch.branchId}`)[0].base_name;
    expect(await baseName()).toBe('Bakery');
    expect((await branches.getBranch(scope, mainId, branch.branchId)).mainMoved).toBe(false);
    // A rename of the site moves no version: the branch is behind by the name alone.
    await prisma.site.update({ where: { id: mainId }, data: { name: 'Bakery & Cafe' } });
    expect((await branches.getBranch(scope, mainId, branch.branchId)).mainMoved).toBe(true);
    expect((await branches.listBranches(scope, mainId)).open[0].mainMoved).toBe(true);
    expect((await branches.siteBranchContext(scope, branch.branchId))).toMatchObject({ kind: 'branch', branch: { mainMoved: true } });
    // Any write of the fork document moves the stored name with it.
    const doc = (await prisma.siteBranch.findUniqueOrThrow({ where: { id: branch.branchId } })).baseDocument as Record<string, unknown>;
    await prisma.siteBranch.update({ where: { id: branch.branchId }, data: { baseDocument: { ...doc, name: 'Bakery & Cafe' } as never } });
    expect(await baseName()).toBe('Bakery & Cafe');
    expect((await branches.getBranch(scope, mainId, branch.branchId)).mainMoved).toBe(false);
    await branches.discardBranch(scope, mainId, branch.branchId, ALICE);
    expect(await baseName()).toBeNull();
  });
});

describe('closed records are bounded', () => {
  it(`keeps the ${CLOSED_RECORDS_KEPT} most recent closed records, a live undo copy and the branch an undone merge went to`, async () => {
    const closed = (over: Record<string, unknown> = {}) => ({
      id: randomUUID(), siteId: mainId, workspaceId: scope.workspaceId, tenantGroupId: TENANT_GROUP, name: 'Old',
      status: 'discarded' as const, createdByKind: 'user', createdBy: ALICE.id, ...over,
    });
    // Older than everything else: a merged record whose undo copy is live, a branch that an undone merge went
    // to with the record naming it, and one plain old record.
    const keptForUndo = closed({ status: 'merged', mainBeforeDocument: { name: 'Bakery' }, mainBeforeExpiresAt: new Date(Date.now() + 86_400_000) });
    const wentTo = closed();
    const undone = closed({ status: 'merged', undoneIntoBranchId: wentTo.id });
    const plain = closed();
    const expiredUndo = closed({ status: 'merged', mainBeforeDocument: { name: 'Bakery' }, mainBeforeExpiresAt: new Date(Date.now() - 1000) });
    await prisma.siteBranch.createMany({ data: [keptForUndo, wentTo, undone, plain, expiredUndo] as never });
    const july = Array.from({ length: CLOSED_RECORDS_KEPT - 2 }, () => closed());
    await prisma.siteBranch.createMany({ data: july as never });
    // When each was closed, set in SQL (Prisma stamps `updated_at` itself on a write).
    const aged = (ids: string[], at: string) =>
      prisma.$executeRaw`
        UPDATE public.site_branches SET updated_at = ${at}::timestamp,
          merged_at = CASE WHEN status = 'merged' THEN ${at}::timestamp END,
          discarded_at = CASE WHEN status = 'discarded' THEN ${at}::timestamp END
        WHERE id = ANY(${ids})`;
    await aged([keptForUndo.id, wentTo.id, plain.id, expiredUndo.id], '2026-01-01 00:00:00');
    await aged([undone.id], '2026-06-01 00:00:00');
    await aged(july.map((r) => r.id), '2026-07-01 00:00:00');

    // Listing, however often, deletes nothing: only closing a branch prunes. (It clears the expired copy, which
    // touches that record; a record's age is when it was closed, so that does not make it a recent one.)
    await branches.listBranches(scope, mainId);
    expect((await prisma.siteBranch.findUniqueOrThrow({ where: { id: expiredUndo.id } })).mainBeforeDocument).toBeNull();
    expect(await prisma.siteBranch.count({ where: { siteId: mainId } })).toBe(CLOSED_RECORDS_KEPT + 3);

    const { branch } = await create();
    await branches.discardBranch(scope, mainId, branch.branchId, ALICE);
    const left = new Set((await prisma.siteBranch.findMany({ where: { siteId: mainId }, select: { id: true } })).map((r) => r.id));
    // The newest prunable ones stay (the one just discarded, the 48 of July, the undone merge of June); the two
    // plain old ones go, the expired undo copy with them, and the two protected ones stay beyond the count.
    expect(left.has(branch.branchId)).toBe(true);
    expect(left.has(undone.id)).toBe(true);
    expect(left.has(keptForUndo.id)).toBe(true);
    expect(left.has(wentTo.id)).toBe(true);
    expect(left.has(plain.id)).toBe(false);
    expect(left.has(expiredUndo.id)).toBe(false);
    expect(left.size).toBe(CLOSED_RECORDS_KEPT + 2);
    // A pruned record's old address is a missing site, not a closed branch.
    await expect(branches.siteBranchContext(scope, plain.id)).rejects.toBeInstanceOf(SiteNotFoundError);
    // Another site's records are never counted or touched.
    const otherMain = randomUUID();
    await latestVersionRepository().saveProject(scope, project(otherMain, 'Erika Muster'), { companyId: COMPANY });
    const theirs = closed({ siteId: otherMain });
    await prisma.siteBranch.create({ data: theirs as never });
    const again = await create('Another');
    await branches.discardBranch(scope, mainId, again.branch.branchId, ALICE);
    expect(await prisma.siteBranch.count({ where: { id: theirs.id } })).toBe(1);
  });
});

describe('the listing keeps what the switcher needs', () => {
  it('the latest merge and the branch an undone merge went to stay listed behind any number of discards', async () => {
    const raw = (over: Record<string, unknown>) => ({
      id: randomUUID(), siteId: mainId, workspaceId: scope.workspaceId, tenantGroupId: TENANT_GROUP, name: 'Raw',
      status: 'discarded' as const, createdByKind: 'user', createdBy: ALICE.id, ...over,
    });
    const wentTo = raw({ name: 'Took the work', discardedAt: new Date('2026-02-01T00:00:00Z') });
    const undone = raw({ name: 'Undone merge', status: 'merged', mergedAt: new Date('2026-03-01T00:00:00Z'), undoneIntoBranchId: wentTo.id });
    const latest = raw({
      name: 'Latest merge', status: 'merged', mergedAt: new Date('2026-04-01T00:00:00Z'),
      mainBeforeDocument: { name: 'Bakery' }, mainBeforeExpiresAt: new Date(Date.now() + 86_400_000),
    });
    await prisma.siteBranch.createMany({ data: [wentTo, undone, latest] as never });
    await prisma.$executeRaw`UPDATE public.site_branches SET updated_at = '2026-01-01 00:00:00'::timestamp WHERE site_id = ${mainId}`;
    // Twenty-five discards after them: more than the listing shows.
    await prisma.siteBranch.createMany({ data: Array.from({ length: 25 }, () => raw({ discardedAt: new Date() })) as never });

    const { closed } = await branches.listBranches(scope, mainId);
    const byId = new Map(closed.map((b) => [b.branchId, b]));
    expect(byId.get(latest.id)).toMatchObject({ status: 'merged', name: 'Latest merge' });
    expect(byId.get(latest.id)!.undoUntil).toBeInstanceOf(Date);
    expect(byId.get(undone.id)).toMatchObject({ status: 'merged', undoneIntoBranchId: wentTo.id });
    expect(byId.get(wentTo.id)).toMatchObject({ name: 'Took the work', status: 'discarded' });
    // Bounded all the same: the twenty most recent, the latest merges, and what they name.
    expect(closed).toHaveLength(23);
    expect(new Set(closed.map((b) => b.branchId)).size).toBe(23);
  });
});

describe('one change, both or neither', () => {
  it('a rename and ready in one request: a name clash changes neither', async () => {
    const { branch: a } = await create('First');
    await create('Second');
    await expect(branches.changeBranch(scope, mainId, a.branchId, { name: 'SECOND', ready: true }, ALICE)).rejects.toBeInstanceOf(
      BranchNameTakenError,
    );
    expect(await prisma.siteBranch.findUniqueOrThrow({ where: { id: a.branchId }, select: { name: true, status: true } })).toEqual({
      name: 'First',
      status: 'open',
    });
    await expect(branches.changeBranch(scope, mainId, a.branchId, { name: 'Third', ready: true }, ALICE)).resolves.toMatchObject({
      name: 'Third',
      status: 'ready',
    });
  });

  it('compares names as the index does, so a name with % or _ clashes with nothing else', async () => {
    const { branch: a } = await create('Sale_1');
    await create('Sale 100%');
    await expect(branches.renameBranch(scope, mainId, a.branchId, 'Sale%')).resolves.toMatchObject({ name: 'Sale%' });
    await expect(branches.renameBranch(scope, mainId, a.branchId, 'sale 100%')).rejects.toBeInstanceOf(BranchNameTakenError);
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

describe('the company erasure', () => {
  it('forgets a branch that cascaded with its main site, even when the branch was not in the batch', async () => {
    const { branch } = await create();
    rememberDocument(scope, branch.branchId, 1, JSON.stringify({ holds: 'content' }), documentEpoch());
    const eventId = `evt-${randomUUID()}`;
    await prisma.erasureEvent.create({ data: { id: eventId, kind: 'company', tenantId: COMPANY } });
    // The scope names main only, as a batch that sorted the branch into a later one would.
    await eraseCompanyPublic(prisma, { ...EMPTY_SCOPE, siteIds: [mainId] }, eventId);
    expect(await prisma.site.count({ where: { id: { in: [mainId, branch.branchId] } } })).toBe(0);
    expect(cachedDocument(scope, branch.branchId, 1)).toBeUndefined();
    await prisma.erasureEvent.delete({ where: { id: eventId } });
  });

  it('takes main sites first, so a branch is never locked or deleted before its main', async () => {
    const { branch } = await create();
    const eventId = `evt-${randomUUID()}`;
    await prisma.erasureEvent.create({ data: { id: eventId, kind: 'company', tenantId: COMPANY } });
    // The branch named first, as a scope listing every site of the company would, in any order.
    const result = await eraseCompanyPublic(prisma, { ...EMPTY_SCOPE, siteIds: [branch.branchId, mainId].sort() }, eventId);
    expect(await prisma.site.count({ where: { id: { in: [mainId, branch.branchId] } } })).toBe(0);
    expect(await prisma.siteBranch.count({ where: { siteId: mainId } })).toBe(0);
    // One delete of main removed both rows by the cascade.
    expect(result?.rows.sites).toBe(1);
    await prisma.erasureEvent.delete({ where: { id: eventId } });
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

  it('a copy kept for the undo of a merge keeps its images in use for its 30 days, and no longer after them', async () => {
    const owner = { id: mainId, workspaceId: scope.workspaceId, tenantGroupId: TENANT_GROUP };
    const { image } = await storeSiteImage(owner, png(48, 48), 'favicon', ALICE.id, prisma);
    const { branch } = await create();
    await prisma.$transaction((tx) =>
      branches.closeRecord(tx, branch.branchId, {
        status: 'merged', mergedBy: ALICE.id, mergedAt: new Date(),
        mainBeforeDocument: { name: 'Bakery', siteSettings: { faviconUrl: image.path } },
        mainBeforeExpiresAt: new Date(Date.now() + 60_000),
      }),
    );
    await expect(deleteSiteImage(mainId, image.sha256, prisma)).rejects.toMatchObject({ code: 'image_in_use' });
    // Past its date and not cleared yet (nobody listed the branches): the undo would refuse it, so it holds nothing.
    await prisma.siteBranch.update({ where: { id: branch.branchId }, data: { mainBeforeExpiresAt: new Date(Date.now() - 1000) } });
    expect((await prisma.siteBranch.findUniqueOrThrow({ where: { id: branch.branchId } })).mainBeforeDocument).not.toBeNull();
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

  it('a kept pre-merge copy past its 30 days is not searched, and the erase removes it with whatever it held', async () => {
    const repo = latestVersionRepository();
    const { branch } = await create('Old merge');
    await prisma.$transaction((tx) =>
      branches.closeRecord(tx, branch.branchId, {
        status: 'merged', mergedBy: ALICE.id, mergedAt: new Date(),
        mainBeforeDocument: { name: `Bakery of ${VALUE}` }, mainBeforeExpiresAt: new Date(Date.now() - 1000),
      }),
    );
    await repo.saveProject(scope, project(mainId, VALUE), { mustExist: true });
    const query = { value: VALUE, caseSensitive: false };
    const preview = await repo.searchPersonalData(scope, mainId, query);
    expect(preview.matches.some((m) => m.location.kind === 'merge-undo')).toBe(false);
    // A search writes nothing: the expired copy is still stored.
    expect((await prisma.siteBranch.findUniqueOrThrow({ where: { id: branch.branchId } })).mainBeforeDocument).not.toBeNull();
    const erased = await repo.erasePersonalData(scope, mainId, {
      query, replacement: '[entfernt]', token: preview.token,
      chosen: preview.matches.filter((m) => m.blocked === null).map((m) => m.id), erasedBy: ALICE.id,
    });
    expect(erased.remaining).toBe(0);
    expect(await prisma.siteBranch.findUniqueOrThrow({ where: { id: branch.branchId } })).toMatchObject({
      mainBeforeDocument: null, mainBeforeExpiresAt: null, mainBeforeEnded: 'expired',
    });
    expect(JSON.stringify(await prisma.siteBranch.findMany({ where: { siteId: mainId } }))).not.toContain(VALUE);
  });

  it('an erased name that would equal another open branch name gets a number instead of failing', async () => {
    const repo = latestVersionRepository();
    await create('Sale [entfernt]');
    const { branch } = await create(`Sale ${VALUE}`);
    const query = { value: VALUE, caseSensitive: false };
    const preview = await repo.searchPersonalData(scope, mainId, query);
    await repo.erasePersonalData(scope, mainId, {
      query, replacement: '[ENTFERNT]', token: preview.token,
      chosen: preview.matches.filter((m) => m.blocked === null).map((m) => m.id), erasedBy: ALICE.id,
    });
    // Equal to "Sale [entfernt]" as the index compares (without case): numbered.
    expect((await branches.getBranch(scope, mainId, branch.branchId)).name).toBe('Sale [ENTFERNT] 2');
  });
});
