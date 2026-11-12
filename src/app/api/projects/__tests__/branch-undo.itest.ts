// "Undo this merge" (docs/plans/2026-11-10-site-branches.md, slice S7) against a real Postgres, through the real
// route and the real merge service: the site goes back to what it was before its latest merge, and what it holds
// now becomes a new open branch.
//
// The four stateful paths (knowledge-base standards, stateful-flow testing): forward (merge, undo, merge the new
// branch again), backtrack (the site written since the merge: the later changes are in the new branch, nothing
// is lost), resume (an erase of personal data between the merge and the undo: the kept copy was rewritten too),
// re-entry (a second undo answers the first; two at once make one branch; a later merge or 30 days end the
// offer; a failure at the last write leaves everything as it was). Also: another company is answered like a
// missing site, the limit of open branches, a taken name, a restored site name and slug.
//
// The session and the permission check are faked; everything below them is real.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { SessionVerifyResponse } from '@marlinjai/auth-brain-sdk';

vi.mock('next/cache', () => ({ unstable_cache: (fn: (...args: unknown[]) => unknown) => fn, revalidateTag: vi.fn() }));
vi.mock('@/lib/auth-api', () => ({ getVerifiedSession: vi.fn(), authenticateRequest: vi.fn() }));
vi.mock('@/lib/auth-check', () => ({ checkWorkspaceAccess: vi.fn(async () => true) }));

import { authenticateRequest, getVerifiedSession } from '@/lib/auth-api';
import { LIVE_EVENTS, type SiteVersionEvent } from '@/lib/projects/liveEvents';
import { MAX_OPEN_BRANCHES_PER_SITE } from '@/lib/sites/branches';
import { parseSiteRedirects } from '@/lib/pages/redirects';
import { getPrismaClient } from '@/server/db';
import type { TenantScope } from '@/server/sites';
import { latestVersionRepository } from '@/server/sites/__tests__/latestVersionRepository';
import { getSiteBranchRepository } from '@/server/sites/branches/repository';
import { getSiteBranchMergeService, SiteBranchMergeService } from '@/server/sites/branches/merge';
import { editorBranchState, closedBranchNotice } from '@/server/sites/branches/editorState';
import { getSiteRepository } from '@/server/sites/repository';
import { subscribeSite } from '@/server/sites/liveBus';
import { GET as listGET } from '../[projectId]/branches/route';
import { POST as undoPOST } from '../[projectId]/branches/[branchId]/undo-merge/route';

const EDITOR = 'app.lumitra.test';
const TENANT_GROUP = '018f9c10-0000-7000-8000-0000000b5b07';
const sessionMock = vi.mocked(getVerifiedSession);
const authMock = vi.mocked(authenticateRequest);
const USER = { kind: 'user' as const, id: 'u' };

interface Company {
  companyId: string;
  scope: TenantScope;
  mainId: string;
}

let prisma: PrismaClient;
let us: Company;
let them: Company;
const savedEnv = { editor: process.env.EDITOR_HOST, branches: process.env.SITE_BRANCHES_COMPANIES };

function memberOf(company: Company): SessionVerifyResponse {
  return {
    user: { id: `user-${company.companyId}` },
    workspaces: [{ id: company.scope.workspaceId, tenant_id: company.companyId }],
    tenants: [{ id: company.companyId, app_grants: ['sites'], group_id: company.scope.tenantGroupId }],
    active_workspace: { id: company.scope.workspaceId },
  } as unknown as SessionVerifyResponse;
}

function page(id: string, slug: string, text: string) {
  return {
    id,
    slug,
    metadata: { title: id },
    appComponentTree: {
      id: `root-${id}`,
      type: 'div',
      componentType: 'host',
      props: {},
      children: [{ id: `text-${id}`, type: 'p', componentType: 'host', props: { children: text }, children: [] }],
    },
    canvasNodes: {},
  };
}

interface Texts {
  home: string;
  about: string;
  aboutSlug?: string;
}

function project(id: string, texts: Texts) {
  return {
    id,
    metadata: { title: 'Bakery', description: '', createdAt: 1, updatedAt: 2 },
    pages: { home: page('home', '', texts.home), about: page('about', texts.aboutSlug ?? 'about', texts.about) },
  } as never;
}

async function makeCompany(): Promise<Company> {
  const companyId = `company-${randomUUID().slice(0, 8)}`;
  const scope = { workspaceId: `ws_bru_${randomUUID().slice(0, 8)}`, tenantGroupId: TENANT_GROUP };
  const mainId = randomUUID();
  await latestVersionRepository().saveProject(scope, project(mainId, { home: 'Fresh bread', about: 'Since 1990' }), { companyId });
  return { companyId, scope, mainId };
}

const edit = (company: Company, siteId: string, texts: Texts) => latestVersionRepository().saveProject(company.scope, project(siteId, texts), { mustExist: true });

async function textOf(siteId: string, pageId: string): Promise<string | undefined> {
  const row = await prisma.sitePage.findUnique({ where: { siteId_pageId: { siteId, pageId } }, select: { snapshot: true } });
  const tree = (row?.snapshot as { appComponentTree?: { children?: Array<{ props?: { children?: string } }> } } | undefined)?.appComponentTree;
  return tree?.children?.[0]?.props?.children;
}

const versionOf = async (siteId: string) => (await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { version: true } })).version;
const service = () => getSiteBranchMergeService();

/** A branch with the given content, merged into main: the branch's id. */
async function mergedBranch(name: string, texts: Texts): Promise<string> {
  const { branch } = await getSiteBranchRepository().createBranch(us.scope, us.mainId, { name, actor: USER });
  await edit(us, branch.branchId, texts);
  const { token } = await service().changes(us.scope, branch.branchId);
  const merged = await service().merge(us.scope, branch.branchId, { token }, USER);
  expect(merged.merged).toBe(true);
  return branch.branchId;
}

function request(method: string, path: string): Request {
  return new Request(`https://${EDITOR}${path}`, { method, headers: { host: EDITOR, cookie: 'lumitra_session=faked' } });
}

const undo = (mainId: string, branchId: string) =>
  undoPOST(request('POST', `/api/projects/${mainId}/branches/${branchId}/undo-merge`), { params: Promise.resolve({ projectId: mainId, branchId }) });
const list = async (mainId: string) => (await listGET(request('GET', `/api/projects/${mainId}/branches`), { params: Promise.resolve({ projectId: mainId }) })).json();

beforeAll(() => {
  prisma = getPrismaClient();
  process.env.EDITOR_HOST = EDITOR;
});

beforeEach(async () => {
  us = await makeCompany();
  them = await makeCompany();
  process.env.SITE_BRANCHES_COMPANIES = `${us.companyId},${them.companyId}`;
  sessionMock.mockResolvedValue(memberOf(us));
  authMock.mockImplementation(async () => ({ authenticated: true, userId: `user-${us.companyId}` }));
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  process.env.EDITOR_HOST = savedEnv.editor;
  process.env.SITE_BRANCHES_COMPANIES = savedEnv.branches;
  await prisma.siteOperationAudit.deleteMany({ where: { tenantGroupId: TENANT_GROUP } });
  await prisma.siteDomain.deleteMany({ where: { tenantGroupId: TENANT_GROUP } });
  await prisma.site.deleteMany({ where: { tenantGroupId: TENANT_GROUP, branchOfSiteId: { not: null } } });
  await prisma.site.deleteMany({ where: { tenantGroupId: TENANT_GROUP } });
  await prisma.$disconnect();
});

describe('forward', () => {
  it('main goes back to before the merge as a new version, and the merged work is a new open branch that merges again', async () => {
    const before = await versionOf(us.mainId);
    const branchId = await mergedBranch('Summer sale', { home: 'Summer bread', about: 'Since 1990' });
    const afterMerge = await versionOf(us.mainId);
    expect(afterMerge).toBe(before + 1);
    expect(await textOf(us.mainId, 'home')).toBe('Summer bread');
    // The listing offers the undo for about 30 days.
    const offered = (await list(us.mainId)).closed[0];
    expect(offered).toMatchObject({ branchId, status: 'merged', undoneIntoBranchId: null });
    expect(Date.parse(offered.undoUntil) - Date.now()).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);

    const events: SiteVersionEvent[] = [];
    const unsubscribe = subscribeSite(us.mainId, (event, data) => {
      if (event === LIVE_EVENTS.siteVersion) events.push(data as SiteVersionEvent);
    });
    const res = await undo(us.mainId, branchId);
    unsubscribe();
    expect(res.status).toBe(200);
    const outcome = await res.json();
    expect(outcome).toMatchObject({ undone: true, mainVersion: afterMerge + 1 });
    const newId = outcome.branch.branchId as string;
    expect(newId).not.toBe(branchId);

    // Main: the earlier content, a higher version (the counter never rewinds), nothing published.
    expect(await versionOf(us.mainId)).toBe(afterMerge + 1);
    expect(await textOf(us.mainId, 'home')).toBe('Fresh bread');
    expect(await prisma.siteRevision.count({ where: { siteId: us.mainId } })).toBe(0);
    // An open editor of main hears it as one step, named.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ origin: 'merge', version: afterMerge + 1, summary: ['Undid the merge of branch Summer sale'] });

    // The new branch: open, named after the old one, holding the merged work, up to date with main.
    expect(outcome.branch).toMatchObject({ name: 'Summer sale', status: 'open', baseVersion: afterMerge + 1, mainMoved: false, createdBy: `user-${us.companyId}` });
    expect(await textOf(newId, 'home')).toBe('Summer bread');
    const review = await service().changes(us.scope, newId);
    expect(review.upToDate).toBe(true);
    expect(review.conflicts).toEqual([]);
    expect(review.branchChanges.nodes.changed).toBe(1);
    expect(await editorBranchState(us.scope, us.companyId, newId)).toMatchObject({ kind: 'branch', mainSiteId: us.mainId });

    // The merged record: still merged and closed for good, says where its work went, and keeps no copy.
    const record = await prisma.siteBranch.findUniqueOrThrow({ where: { id: branchId } });
    expect(record).toMatchObject({ status: 'merged', branchSiteId: null, mainBeforeDocument: null, mainBeforeExpiresAt: null, undoneIntoBranchId: newId, undoneBy: `user-${us.companyId}` });
    expect(record.undoneAt).toBeInstanceOf(Date);
    expect(await closedBranchNotice(us.scope, us.companyId, branchId)).toMatchObject({ status: 'merged', undoUntil: null, undoneInto: { branchId: newId, name: 'Summer sale', open: true } });
    const listed = await list(us.mainId);
    expect(listed.open.map((b: { branchId: string }) => b.branchId)).toEqual([newId]);
    expect(listed.closed[0]).toMatchObject({ branchId, undoUntil: null, undoneIntoBranchId: newId });

    // Audited on the site, with ids and versions only.
    const audit = await prisma.siteOperationAudit.findFirstOrThrow({ where: { siteId: us.mainId, operation: 'branch_merge_undo' } });
    expect(audit).toMatchObject({ actorKind: 'user', versionBefore: afterMerge, versionAfter: afterMerge + 1, actorDetail: { branchId, newBranchId: newId } });
    expect(JSON.stringify(audit)).not.toContain('Summer');

    // Everything that reads the old branch says the merge was undone and where the work went (an agent's tools too).
    await expect(service().changes(us.scope, branchId)).rejects.toMatchObject({ code: 'branch_closed', branchStatus: 'merged', undoneIntoBranchId: newId });
    await expect(getSiteBranchRepository().discardBranch(us.scope, us.mainId, branchId, USER)).rejects.toMatchObject({ undoneIntoBranchId: newId });

    // Merging the new branch again is an ordinary merge, and that merge can be undone in turn.
    const again = await service().merge(us.scope, newId, { token: review.token }, USER);
    expect(again).toMatchObject({ merged: true, mainVersion: afterMerge + 2 });
    expect(await textOf(us.mainId, 'home')).toBe('Summer bread');
    expect((await list(us.mainId)).closed.find((b: { branchId: string }) => b.branchId === newId).undoUntil).toEqual(expect.any(String));
    expect(await closedBranchNotice(us.scope, us.companyId, branchId)).toMatchObject({ undoneInto: { branchId: newId, open: false } });
  });

  it('restores the site name and a renamed address, and leaves no redirect pointing at a page\'s own address', async () => {
    // A site that has been live keeps old addresses as redirects.
    await getSiteRepository().ensureSiteDomain(us.scope, us.mainId);
    const { branch } = await getSiteBranchRepository().createBranch(us.scope, us.mainId, { name: 'Rename', actor: USER });
    await edit(us, branch.branchId, { home: 'Fresh bread', about: 'Since 1990', aboutSlug: 'about-us' });
    await prisma.site.update({ where: { id: branch.branchId }, data: { name: 'Bakery and cafe' } });
    const { token } = await service().changes(us.scope, branch.branchId);
    await service().merge(us.scope, branch.branchId, { token }, USER);
    const merged = await prisma.site.findUniqueOrThrow({ where: { id: us.mainId }, select: { name: true, redirects: true, pages: { select: { pageId: true, slug: true } } } });
    expect(merged.name).toBe('Bakery and cafe');
    expect(merged.pages.find((p) => p.pageId === 'about')?.slug).toBe('about-us');
    expect(parseSiteRedirects(merged.redirects).map((r) => r.from)).toEqual(['about']);

    const outcome = await service().undoMerge(us.scope, us.mainId, branch.branchId, USER);
    const main = await prisma.site.findUniqueOrThrow({ where: { id: us.mainId }, select: { name: true, redirects: true, pages: { select: { pageId: true, slug: true } } } });
    expect(main.name).toBe('Bakery');
    expect(main.pages.find((p) => p.pageId === 'about')?.slug).toBe('about');
    // The page owns "about" again, so nothing redirects away from it; the address it had meanwhile leads to it.
    const slugs = new Set(main.pages.map((p) => p.slug));
    const redirects = parseSiteRedirects(main.redirects);
    expect(redirects.filter((r) => slugs.has(r.from))).toEqual([]);
    expect(redirects.map((r) => [r.from, r.pageId])).toEqual([['about-us', 'about']]);
    // The new branch carries the rename and the new name, and is up to date: main's name is the fork point's.
    const review = await service().changes(us.scope, outcome.branch.branchId);
    expect(review.upToDate).toBe(true);
    expect(review.branchChanges.site).toContain('name');
    expect((await prisma.site.findUniqueOrThrow({ where: { id: outcome.branch.branchId }, select: { name: true } })).name).toBe('Bakery and cafe');
  });
});

describe('backtrack: the site written since the merge', () => {
  it('the later changes go to the new branch with the merged work, and main is as it was before the merge', async () => {
    const branchId = await mergedBranch('Summer sale', { home: 'Summer bread', about: 'Since 1990' });
    await edit(us, us.mainId, { home: 'Summer bread', about: 'Since 1990, family run' });
    const written = await versionOf(us.mainId);

    const res = await undo(us.mainId, branchId);
    expect(res.status).toBe(200);
    const outcome = await res.json();
    expect(outcome).toMatchObject({ undone: true, mainVersion: written + 1 });
    expect([await textOf(us.mainId, 'home'), await textOf(us.mainId, 'about')]).toEqual(['Fresh bread', 'Since 1990']);
    const newId = outcome.branch.branchId as string;
    expect([await textOf(newId, 'home'), await textOf(newId, 'about')]).toEqual(['Summer bread', 'Since 1990, family run']);
    const review = await service().changes(us.scope, newId);
    expect(review).toMatchObject({ upToDate: true, conflicts: [] });
    expect(review.branchChanges.nodes.changed).toBe(2);
  });
});

describe('resume: an erase of personal data between the merge and the undo', () => {
  it('the kept copy was rewritten too, so the undo brings the value back nowhere', async () => {
    const VALUE = 'Petra Probe';
    await edit(us, us.mainId, { home: `Fresh bread by ${VALUE}`, about: 'Since 1990' });
    const branchId = await mergedBranch('Team', { home: `Fresh bread by ${VALUE}`, about: `Run by ${VALUE}` });
    expect(JSON.stringify((await prisma.siteBranch.findUniqueOrThrow({ where: { id: branchId } })).mainBeforeDocument)).toContain(VALUE);

    const repo = getSiteRepository();
    const query = { value: VALUE, caseSensitive: false };
    const preview = await repo.searchPersonalData(us.scope, us.mainId, query);
    const erased = await repo.erasePersonalData(us.scope, us.mainId, {
      query,
      replacement: '[entfernt]',
      token: preview.token,
      chosen: preview.matches.filter((m) => m.blocked === null).map((m) => m.id),
      erasedBy: 'u',
    });
    expect(erased.remaining).toBe(0);

    const outcome = await service().undoMerge(us.scope, us.mainId, branchId, USER);
    expect(outcome.undone).toBe(true);
    expect(await textOf(us.mainId, 'home')).toBe('Fresh bread by [entfernt]');
    expect(await textOf(outcome.branch.branchId, 'about')).toBe('Run by [entfernt]');
    expect((await repo.searchPersonalData(us.scope, us.mainId, query)).total).toBe(0);
    const stored = JSON.stringify([
      await prisma.site.findMany({ where: { OR: [{ id: us.mainId }, { branchOfSiteId: us.mainId }] }, include: { pages: true } }),
      await prisma.siteBranch.findMany({ where: { siteId: us.mainId } }),
    ]);
    expect(stored).not.toContain(VALUE);
    // The new branch shares main's erasure epoch, so its tabs and a later merge agree with the erase.
    const epochs = await prisma.site.findMany({ where: { OR: [{ id: us.mainId }, { id: outcome.branch.branchId }] }, select: { erasureEpoch: true } });
    expect(new Set(epochs.map((e) => e.erasureEpoch)).size).toBe(1);
    expect((await service().changes(us.scope, outcome.branch.branchId)).upToDate).toBe(true);
  });

  it('an erase that leaves a match in the kept copy removes that copy: the undo is refused and brings nothing back', async () => {
    const VALUE = 'Petra Probe';
    await edit(us, us.mainId, { home: `Fresh bread by ${VALUE}`, about: 'Since 1990' });
    const branchId = await mergedBranch('Team', { home: `Fresh bread by ${VALUE}`, about: `Run by ${VALUE}` });

    // The owner ticks only what the working copy holds; the copy from before the merge holds the value too.
    const repo = getSiteRepository();
    const query = { value: VALUE, caseSensitive: false };
    const preview = await repo.searchPersonalData(us.scope, us.mainId, query);
    expect(preview.matches.some((m) => m.location.kind === 'merge-undo')).toBe(true);
    await repo.erasePersonalData(us.scope, us.mainId, {
      query,
      replacement: '[entfernt]',
      token: preview.token,
      chosen: preview.matches.filter((m) => m.blocked === null && m.location.kind === 'working').map((m) => m.id),
      erasedBy: 'u',
    });
    const record = await prisma.siteBranch.findUniqueOrThrow({ where: { id: branchId } });
    expect(record).toMatchObject({ mainBeforeDocument: null, mainBeforeExpiresAt: null, mainBeforeEnded: 'erased' });
    expect((await list(us.mainId)).closed[0]).toMatchObject({ branchId, undoUntil: null });

    const version = await versionOf(us.mainId);
    const res = await undo(us.mainId, branchId);
    expect(res.status).toBe(409);
    const error = (await res.json()).error;
    expect(error.code).toBe('merge_undo_unavailable');
    expect(error.message).toMatch(/personal data was erased/);
    expect(await versionOf(us.mainId)).toBe(version);
    expect(await textOf(us.mainId, 'home')).toBe('Fresh bread by [entfernt]');
    expect((await repo.searchPersonalData(us.scope, us.mainId, query)).total).toBe(0);
  });
});

describe('re-entry', () => {
  it('a second undo answers the first result and writes nothing', async () => {
    const branchId = await mergedBranch('Summer sale', { home: 'Summer bread', about: 'Since 1990' });
    const first = await (await undo(us.mainId, branchId)).json();
    const version = await versionOf(us.mainId);
    const res = await undo(us.mainId, branchId);
    expect(res.status).toBe(200);
    const second = await res.json();
    expect(second).toMatchObject({ undone: false, mainVersion: version });
    expect(second.branch.branchId).toBe(first.branch.branchId);
    expect(await versionOf(us.mainId)).toBe(version);
    expect(await prisma.siteBranch.count({ where: { siteId: us.mainId } })).toBe(2);
    expect(await prisma.siteOperationAudit.count({ where: { siteId: us.mainId, operation: 'branch_merge_undo' } })).toBe(1);
  });

  it('two undo requests at once make one branch and one new version', async () => {
    const branchId = await mergedBranch('Summer sale', { home: 'Summer bread', about: 'Since 1990' });
    const version = await versionOf(us.mainId);
    const [a, b] = await Promise.all([service().undoMerge(us.scope, us.mainId, branchId, USER), service().undoMerge(us.scope, us.mainId, branchId, USER)]);
    expect([a.undone, b.undone].sort()).toEqual([false, true]);
    expect(a.branch.branchId).toBe(b.branch.branchId);
    expect(await versionOf(us.mainId)).toBe(version + 1);
    expect(await prisma.site.count({ where: { branchOfSiteId: us.mainId } })).toBe(1);
  });

  it('is no longer offered once a later merge landed: only the latest merge can be undone', async () => {
    const first = await mergedBranch('First', { home: 'First bread', about: 'Since 1990' });
    const second = await mergedBranch('Second', { home: 'Second bread', about: 'Since 1990' });
    const version = await versionOf(us.mainId);
    const res = await undo(us.mainId, first);
    expect(res.status).toBe(409);
    const error = (await res.json()).error;
    expect(error.code).toBe('merge_undo_unavailable');
    expect(error.message).toMatch(/only the latest merge can be undone/);
    expect(await versionOf(us.mainId)).toBe(version);
    expect(await prisma.site.count({ where: { branchOfSiteId: us.mainId } })).toBe(0);
    const closed = (await list(us.mainId)).closed as Array<{ branchId: string; undoUntil: string | null }>;
    expect(closed.find((b) => b.branchId === first)?.undoUntil).toBeNull();
    expect(closed.find((b) => b.branchId === second)?.undoUntil).toEqual(expect.any(String));
    // The latest one still can.
    expect((await undo(us.mainId, second)).status).toBe(200);
    expect(await textOf(us.mainId, 'home')).toBe('First bread');
  });

  it('is no longer offered after 30 days, and the kept copy is removed the next time the branches are listed', async () => {
    const branchId = await mergedBranch('Summer sale', { home: 'Summer bread', about: 'Since 1990' });
    await prisma.siteBranch.update({ where: { id: branchId }, data: { mainBeforeExpiresAt: new Date(Date.now() - 1000) } });
    const version = await versionOf(us.mainId);
    const res = await undo(us.mainId, branchId);
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toMatch(/kept for 30 days/);
    expect(await versionOf(us.mainId)).toBe(version);
    expect((await prisma.siteBranch.findUniqueOrThrow({ where: { id: branchId } })).mainBeforeDocument).not.toBeNull();
    expect((await list(us.mainId)).closed[0]).toMatchObject({ branchId, undoUntil: null });
    expect(await prisma.siteBranch.findUniqueOrThrow({ where: { id: branchId }, select: { mainBeforeDocument: true, mainBeforeExpiresAt: true } })).toEqual({ mainBeforeDocument: null, mainBeforeExpiresAt: null });
    expect(await closedBranchNotice(us.scope, us.companyId, branchId)).toMatchObject({ undoUntil: null, undoneInto: null });
    // A page loaded before still says why, not that another branch was merged.
    expect((await (await undo(us.mainId, branchId)).json()).error.message).toMatch(/kept for 30 days/);
  });

  it('a kept copy that holds a part the editor cannot load is not put back: refused, nothing written', async () => {
    const branchId = await mergedBranch('Summer sale', { home: 'Summer bread', about: 'Since 1990' });
    const record = await prisma.siteBranch.findUniqueOrThrow({ where: { id: branchId }, select: { mainBeforeDocument: true } });
    const kept = record.mainBeforeDocument as { components: Record<string, unknown> };
    await prisma.siteBranch.update({
      where: { id: branchId },
      data: { mainBeforeDocument: { ...kept, components: { ...kept.components, ghost: 'not a component' } } as never },
    });
    const version = await versionOf(us.mainId);
    const res = await undo(us.mainId, branchId);
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toMatch(/cannot be undone: the copy of the site from before it holds parts/);
    expect(await versionOf(us.mainId)).toBe(version);
    expect(await prisma.site.count({ where: { branchOfSiteId: us.mainId } })).toBe(0);
    expect(await textOf(us.mainId, 'home')).toBe('Summer bread');
  });

  it('a kept copy with an address today\'s rules would refuse as new still goes back as it was stored', async () => {
    // The site stored this address before the rules for new addresses existed; the branch tidied it.
    const about = await prisma.sitePage.findUniqueOrThrow({ where: { siteId_pageId: { siteId: us.mainId, pageId: 'about' } } });
    await prisma.sitePage.update({
      where: { siteId_pageId: { siteId: us.mainId, pageId: 'about' } },
      data: { slug: 'About Us!', snapshot: { ...(about.snapshot as object), slug: 'About Us!' } },
    });
    const { branch } = await getSiteBranchRepository().createBranch(us.scope, us.mainId, { name: 'Tidy', actor: USER });
    await edit(us, branch.branchId, { home: 'Fresh bread', about: 'Since 1990', aboutSlug: 'about-us' });
    const { token } = await service().changes(us.scope, branch.branchId);
    await service().merge(us.scope, branch.branchId, { token }, USER);
    expect((await prisma.sitePage.findUniqueOrThrow({ where: { siteId_pageId: { siteId: us.mainId, pageId: 'about' } } })).slug).toBe('about-us');

    expect((await undo(us.mainId, branch.branchId)).status).toBe(200);
    expect((await prisma.sitePage.findUniqueOrThrow({ where: { siteId_pageId: { siteId: us.mainId, pageId: 'about' } } })).slug).toBe('About Us!');
  });

  it('a branch that was not merged has no merge to undo: open, or discarded', async () => {
    const { branch } = await getSiteBranchRepository().createBranch(us.scope, us.mainId, { name: 'Open', actor: USER });
    const open = await undo(us.mainId, branch.branchId);
    expect(open.status).toBe(409);
    expect((await open.json()).error.code).toBe('merge_undo_unavailable');
    await getSiteBranchRepository().discardBranch(us.scope, us.mainId, branch.branchId, USER);
    expect((await undo(us.mainId, branch.branchId)).status).toBe(409);
    expect((await undo(us.mainId, randomUUID())).status).toBe(404);
    // Given a branch as the site.
    const other = await getSiteBranchRepository().createBranch(us.scope, us.mainId, { name: 'Other', actor: USER });
    expect((await undo(other.branch.branchId, branch.branchId)).status).toBe(409);
  });

  it('a failure at the last write leaves main, the record and the branches as they were, and the undo then works', async () => {
    const branchId = await mergedBranch('Summer sale', { home: 'Summer bread', about: 'Since 1990' });
    const version = await versionOf(us.mainId);
    const failing = new SiteBranchMergeService(prisma, getSiteRepository(), {
      beforeCommit: async (_tx, step) => {
        if (step === 'undo') throw new Error('injected failure');
      },
    });
    await expect(failing.undoMerge(us.scope, us.mainId, branchId, USER)).rejects.toThrow('injected failure');
    expect(await versionOf(us.mainId)).toBe(version);
    expect(await textOf(us.mainId, 'home')).toBe('Summer bread');
    expect(await prisma.site.count({ where: { branchOfSiteId: us.mainId } })).toBe(0);
    expect(await prisma.siteBranch.count({ where: { siteId: us.mainId } })).toBe(1);
    const record = await prisma.siteBranch.findUniqueOrThrow({ where: { id: branchId } });
    expect(record.undoneIntoBranchId).toBeNull();
    expect(record.mainBeforeDocument).not.toBeNull();
    expect(await prisma.siteOperationAudit.count({ where: { siteId: us.mainId, operation: 'branch_merge_undo' } })).toBe(0);
    expect((await undo(us.mainId, branchId)).status).toBe(200);
    expect(await textOf(us.mainId, 'home')).toBe('Fresh bread');
  });
});

describe('bounds and isolation', () => {
  it(`works at the limit of ${MAX_OPEN_BRANCHES_PER_SITE} open branches (merging one to make room would end the undo), and a new branch is still refused`, async () => {
    const branchId = await mergedBranch('Summer sale', { home: 'Summer bread', about: 'Since 1990' });
    for (let n = 0; n < MAX_OPEN_BRANCHES_PER_SITE; n++) {
      await getSiteBranchRepository().createBranch(us.scope, us.mainId, { name: `Fill ${n}`, actor: USER });
    }
    expect((await undo(us.mainId, branchId)).status).toBe(200);
    expect(await prisma.site.count({ where: { branchOfSiteId: us.mainId } })).toBe(MAX_OPEN_BRANCHES_PER_SITE + 1);
    await expect(getSiteBranchRepository().createBranch(us.scope, us.mainId, { name: 'One more', actor: USER })).rejects.toMatchObject({ code: 'branch_limit' });
  });

  it('a branch renamed to the merged one\'s name while the undo waits for the site is not a failure: the new branch takes the next free name', async () => {
    const branchId = await mergedBranch('Summer sale', { home: 'Summer bread', about: 'Since 1990' });
    const { branch: other } = await getSiteBranchRepository().createBranch(us.scope, us.mainId, { name: 'Other', actor: USER });
    let pending: ReturnType<typeof undo> | undefined;
    // A rename holds the site's row lock, as changeBranch does, and commits after the undo has begun to wait.
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM public.sites WHERE id = ${us.mainId} FOR UPDATE`;
      pending = undo(us.mainId, branchId);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await tx.siteBranch.update({ where: { id: other.branchId }, data: { name: 'summer SALE' } });
    });
    const res = await pending!;
    expect(res.status).toBe(200);
    expect((await res.json()).branch.name).toBe('Summer sale 2');
  });

  it('takes a free name when an open branch already has the merged one\'s', async () => {
    const branchId = await mergedBranch('Summer sale', { home: 'Summer bread', about: 'Since 1990' });
    await getSiteBranchRepository().createBranch(us.scope, us.mainId, { name: 'summer SALE', actor: USER });
    const outcome = await (await undo(us.mainId, branchId)).json();
    expect(outcome.branch.name).toBe('Summer sale 2');
  });

  it('another company is answered like a missing site, and nothing is written', async () => {
    const branchId = await mergedBranch('Summer sale', { home: 'Summer bread', about: 'Since 1990' });
    const version = await versionOf(us.mainId);
    sessionMock.mockResolvedValue(memberOf(them));
    authMock.mockImplementation(async () => ({ authenticated: true, userId: `user-${them.companyId}` }));
    for (const [main, branch] of [[us.mainId, branchId], [them.mainId, branchId]]) {
      const res = await undo(main, branch);
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).not.toContain('Summer');
    }
    expect(await versionOf(us.mainId)).toBe(version);
    expect(await versionOf(them.mainId)).toBe(1);
    expect(await prisma.site.count({ where: { branchOfSiteId: { in: [us.mainId, them.mainId] } } })).toBe(0);
    expect((await prisma.siteBranch.findUniqueOrThrow({ where: { id: branchId } })).undoneIntoBranchId).toBeNull();
  });

  it('needs the right to merge, and is not there with the switch off', async () => {
    const branchId = await mergedBranch('Summer sale', { home: 'Summer bread', about: 'Since 1990' });
    authMock.mockImplementation(async (_req, _workspace, action) =>
      action === 'mergeBranch' ? { authenticated: false, status: 403, error: 'forbidden' } : { authenticated: true, userId: 'viewer' },
    );
    expect((await undo(us.mainId, branchId)).status).toBe(403);
    authMock.mockImplementation(async () => ({ authenticated: true, userId: `user-${us.companyId}` }));
    process.env.SITE_BRANCHES_COMPANIES = '';
    expect((await undo(us.mainId, branchId)).status).toBe(404);
    expect((await prisma.siteBranch.findUniqueOrThrow({ where: { id: branchId } })).undoneIntoBranchId).toBeNull();
  });
});
