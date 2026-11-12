// The review, update and merge routes of site branches (docs/plans/2026-11-10-site-branches.md, slice S3)
// against a real Postgres: the four paths of section 6 (forward, backtrack and revise, resume, re-entry), a
// merge racing a save of main, a double merge, an injected failure at the last write, an open editor of main
// hearing the merge as one step, and a foreign company answered like a missing site. The session and the
// permission check are faked; everything below them is real.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { SessionVerifyResponse } from '@marlinjai/auth-brain-sdk';

vi.mock('next/cache', () => ({ unstable_cache: (fn: (...args: unknown[]) => unknown) => fn, revalidateTag: vi.fn() }));
vi.mock('@/lib/auth-api', () => ({ getVerifiedSession: vi.fn(), authenticateRequest: vi.fn() }));
vi.mock('@/lib/auth-check', () => ({ checkWorkspaceAccess: vi.fn(async () => true) }));

import { authenticateRequest, getVerifiedSession } from '@/lib/auth-api';
import { adoptionLabel } from '@/lib/projects/liveSync';
import { LIVE_EVENTS, type SiteVersionEvent } from '@/lib/projects/liveEvents';
import { getPrismaClient } from '@/server/db';
import type { TenantScope } from '@/server/sites';
import { latestVersionRepository } from '@/server/sites/__tests__/latestVersionRepository';
import { getSiteBranchRepository } from '@/server/sites/branches/repository';
import { SiteBranchMergeService } from '@/server/sites/branches/merge';
import { getSiteRepository } from '@/server/sites/repository';
import { subscribeSite } from '@/server/sites/liveBus';
import { POST as createPOST } from '../[projectId]/branches/route';
import { DELETE as branchDELETE } from '../[projectId]/branches/[branchId]/route';
import { GET as changesGET } from '../[projectId]/branch/changes/route';
import { POST as updatePOST } from '../[projectId]/branch/update/route';
import { POST as approvePOST } from '../[projectId]/branch/approve/route';
import { POST as sendBackPOST } from '../[projectId]/branch/send-back/route';
import { POST as mergePOST } from '../[projectId]/branch/merge/route';
import { POST as answersPOST } from '../[projectId]/branch/answers/route';

const EDITOR = 'app.lumitra.test';
const TENANT_GROUP = '018f9c10-0000-7000-8000-0000000b5b02';
const sessionMock = vi.mocked(getVerifiedSession);
const authMock = vi.mocked(authenticateRequest);

interface Company {
  companyId: string;
  scope: TenantScope;
  mainId: string;
}

interface Texts {
  home: string;
  about: string;
  extra?: string;
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

/** A site with a home page and an about page, each with one text, and an extra page when given. */
function project(id: string, texts: Texts) {
  return {
    id,
    metadata: { title: 'Bakery', description: '', createdAt: 1, updatedAt: 2 },
    pages: {
      home: page('home', '', texts.home),
      about: page('about', 'about', texts.about),
      ...(texts.extra === undefined ? {} : { extra: page('extra', 'extra', texts.extra) }),
    },
  } as never;
}

async function makeCompany(): Promise<Company> {
  const companyId = `company-${randomUUID().slice(0, 8)}`;
  const scope = { workspaceId: `ws_brm_${randomUUID().slice(0, 8)}`, tenantGroupId: TENANT_GROUP };
  const mainId = randomUUID();
  await latestVersionRepository().saveProject(scope, project(mainId, { home: 'Fresh bread', about: 'Since 1990' }), { companyId });
  return { companyId, scope, mainId };
}

/** Save a site's whole document, as an open editor tab that has just loaded it would. */
async function edit(company: Company, siteId: string, texts: Texts) {
  return latestVersionRepository().saveProject(company.scope, project(siteId, texts), { mustExist: true });
}

/** The text of a page on a site's stored working copy. */
async function textOf(siteId: string, pageId: string): Promise<string | undefined> {
  const row = await prisma.sitePage.findUnique({ where: { siteId_pageId: { siteId, pageId } }, select: { snapshot: true } });
  const tree = (row?.snapshot as { appComponentTree?: { children?: Array<{ props?: { children?: string } }> } } | undefined)?.appComponentTree;
  return tree?.children?.[0]?.props?.children;
}

const versionOf = async (siteId: string) => (await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { version: true } })).version;

function request(method: string, path: string, body?: unknown): Request {
  return new Request(`https://${EDITOR}${path}`, {
    method,
    headers: { host: EDITOR, cookie: 'lumitra_session=faked', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ctx = (projectId: string) => ({ params: Promise.resolve({ projectId }) });

async function createBranch(company: Company, name: string): Promise<string> {
  const res = await createPOST(request('POST', `/api/projects/${company.mainId}/branches`, { name }), ctx(company.mainId));
  expect(res.status).toBe(201);
  return (await res.json()).branch.branchId as string;
}

const changes = (branchId: string) => changesGET(request('GET', `/api/projects/${branchId}/branch/changes`), ctx(branchId));
const update = (branchId: string, body: unknown) => updatePOST(request('POST', `/api/projects/${branchId}/branch/update`, body), ctx(branchId));
const approve = (branchId: string, body: unknown) => approvePOST(request('POST', `/api/projects/${branchId}/branch/approve`, body), ctx(branchId));
const sendBack = (branchId: string, body: unknown) => sendBackPOST(request('POST', `/api/projects/${branchId}/branch/send-back`, body), ctx(branchId));
const answers = (branchId: string, body: unknown) => answersPOST(request('POST', `/api/projects/${branchId}/branch/answers`, body), ctx(branchId));
const merge = (branchId: string, body: unknown) => mergePOST(request('POST', `/api/projects/${branchId}/branch/merge`, body), ctx(branchId));

async function review(branchId: string) {
  const res = await changes(branchId);
  expect(res.status).toBe(200);
  return res.json();
}

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
  await prisma.site.deleteMany({ where: { tenantGroupId: TENANT_GROUP, branchOfSiteId: { not: null } } });
  await prisma.site.deleteMany({ where: { tenantGroupId: TENANT_GROUP } });
  await prisma.$disconnect();
});

describe('forward', () => {
  it('reviews, approves and merges: main gets one new version equal to the branch, nothing is published', async () => {
    const branchId = await createBranch(us, 'Summer sale');
    await edit(us, branchId, { home: 'Summer bread', about: 'Since 1990' });
    const mainVersion = await versionOf(us.mainId);

    const seen = await review(branchId);
    expect(seen.upToDate).toBe(true);
    expect(seen.conflicts).toEqual([]);
    expect(seen.problems).toEqual([]);
    expect(seen.branchChanges.pages.changed).toEqual(['home']);

    const approved = await approve(branchId, { token: seen.token });
    expect(approved.status).toBe(200);
    expect((await approved.json()).branch.approved).toBe(true);
    expect(authMock.mock.calls.at(-1)?.[2]).toBe('reviewBranch');

    // An open editor of main hears the merge once, as one step named for the branch.
    const heard: SiteVersionEvent[] = [];
    const stop = subscribeSite(us.mainId, (event, data) => {
      if (event === LIVE_EVENTS.siteVersion) heard.push(data as SiteVersionEvent);
    });
    const res = await merge(branchId, { token: seen.token });
    stop();
    expect(res.status).toBe(200);
    expect(authMock.mock.calls.at(-1)?.[2]).toBe('mergeBranch');
    const outcome = await res.json();
    expect(outcome).toMatchObject({ merged: true, mainVersion: mainVersion + 1, branch: { status: 'merged' } });

    expect(await textOf(us.mainId, 'home')).toBe('Summer bread');
    const main = await prisma.site.findUniqueOrThrow({ where: { id: us.mainId }, select: { version: true, status: true, publishedRevisionId: true } });
    expect(main).toEqual({ version: mainVersion + 1, status: 'draft', publishedRevisionId: null });
    expect(await prisma.site.findUnique({ where: { id: branchId } })).toBeNull();
    const record = await prisma.siteBranch.findUniqueOrThrow({ where: { id: branchId } });
    expect(record).toMatchObject({ status: 'merged', mergedMainVersion: mainVersion + 1, branchSiteId: null, baseDocument: null });
    expect(JSON.stringify(record.mainBeforeDocument)).toContain('Fresh bread');
    expect(record.mainBeforeExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);

    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ origin: 'merge', version: mainVersion + 1, versionBefore: mainVersion });
    expect(adoptionLabel(heard[0])).toBe('Merged branch Summer sale');

    const audit = await prisma.siteOperationAudit.findMany({ where: { siteId: us.mainId, operation: 'branch_merge' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ versionBefore: mainVersion, versionAfter: mainVersion + 1 });
    expect(JSON.stringify(audit[0].actorDetail)).not.toContain('Summer sale');
  });

  it('carries a rename of the branch’s site onto main; a rename of main since the fork is brought in first', async () => {
    const renamed = await createBranch(us, 'New name');
    await getSiteRepository().renameSite(us.scope, renamed, 'Bakery Deluxe');
    await merge(renamed, { token: (await review(renamed)).token });
    expect((await prisma.site.findUniqueOrThrow({ where: { id: us.mainId } })).name).toBe('Bakery Deluxe');

    // Only main renamed: the branch is behind, the update takes main's name, the merge keeps it.
    const mainOnly = await createBranch(us, 'Main renamed');
    await getSiteRepository().renameSite(us.scope, us.mainId, 'Main name');
    const behind = await review(mainOnly);
    expect(behind.upToDate).toBe(false);
    expect(behind.branch.mainMoved).toBe(true);
    const first = (await (await merge(mainOnly, { token: behind.token })).json()).error;
    expect(first.code).toBe('branch_updated_from_main');
    // The token the update answered is the one a fresh review gives, its name change included. The branch now
    // holds main's name and nothing of its own, so there is nothing to merge; with a change of its own it merges
    // and main keeps its name.
    const fresh = await review(mainOnly);
    expect(fresh.token).toBe(first.token);
    expect(fresh.branch.mainMoved).toBe(false);
    expect(fresh.unchanged).toBe(true);
    expect((await (await merge(mainOnly, { token: first.token })).json()).error.code).toBe('branch_unchanged');
    await edit(us, mainOnly, { home: 'Fresh bread, daily', about: 'Since 1990' });
    expect((await merge(mainOnly, { token: (await review(mainOnly)).token })).status).toBe(200);
    expect((await prisma.site.findUniqueOrThrow({ where: { id: us.mainId } })).name).toBe('Main name');

    // Both renamed: a conflict, never one name dropped without a word.
    const both = await createBranch(us, 'Both renamed');
    await getSiteRepository().renameSite(us.scope, both, 'Branch name');
    await getSiteRepository().renameSite(us.scope, us.mainId, 'Main again');
    const seen = await review(both);
    expect(seen.conflicts.map((c: { path: string[] }) => c.path)).toEqual([['name']]);
    const res = await merge(both, { token: seen.token });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('branch_conflicts');
    const [conflict] = seen.conflicts;
    expect((await update(both, { token: seen.token, resolutions: { [conflict.id]: { fingerprint: conflict.fingerprint, pick: 'branch' } } })).status).toBe(200);
    expect((await merge(both, { token: (await review(both)).token })).status).toBe(200);
    expect((await prisma.site.findUniqueOrThrow({ where: { id: us.mainId } })).name).toBe('Branch name');
  });
});

describe('backtrack and revise', () => {
  it('refuses a merge when main moved during the review, and writes nothing', async () => {
    const branchId = await createBranch(us, 'Stale');
    await edit(us, branchId, { home: 'Branch bread', about: 'Since 1990' });
    const { token } = await review(branchId);
    await edit(us, us.mainId, { home: 'Fresh bread', about: 'Since 1991' });
    const before = await versionOf(us.mainId);

    const res = await merge(branchId, { token });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('branch_review_stale');
    expect(await versionOf(us.mainId)).toBe(before);
    expect(await textOf(us.mainId, 'home')).toBe('Fresh bread');
    expect((await prisma.siteBranch.findUniqueOrThrow({ where: { id: branchId } })).status).toBe('open');
  });

  it('a rename of main makes an open review stale too', async () => {
    const branchId = await createBranch(us, 'Renamed under it');
    const { token } = await review(branchId);
    await getSiteRepository().renameSite(us.scope, us.mainId, 'Other');
    expect((await approve(branchId, { token })).status).toBe(409);
  });

  it('a branch behind main is updated first, the merge stops, and the next merge lands both changes', async () => {
    const branchId = await createBranch(us, 'Behind');
    await edit(us, branchId, { home: 'Branch bread', about: 'Since 1990' });
    const seen = await review(branchId);
    await approve(branchId, { token: seen.token });
    await edit(us, us.mainId, { home: 'Fresh bread', about: 'Since 1991' });

    const behind = await review(branchId);
    expect(behind.upToDate).toBe(false);
    expect(behind.conflicts).toEqual([]);
    expect(behind.mainChanges.pages.changed).toEqual(['about']);
    const mainVersion = await versionOf(us.mainId);

    const first = await merge(branchId, { token: behind.token });
    expect(first.status).toBe(409);
    const body = await first.json();
    expect(body.error.code).toBe('branch_updated_from_main');
    // Main untouched; the branch holds both changes, is based on main now, and its approval is gone.
    expect(await versionOf(us.mainId)).toBe(mainVersion);
    expect(await textOf(branchId, 'home')).toBe('Branch bread');
    expect(await textOf(branchId, 'about')).toBe('Since 1991');
    const updated = await review(branchId);
    expect(updated).toMatchObject({ upToDate: true, token: body.error.token, branch: { approved: false, baseVersion: mainVersion } });
    // A save of the branch after the update: the update's token no longer merges it unseen.
    await edit(us, branchId, { home: 'Branch bread', about: 'Since 1991', extra: 'Unseen' });
    expect((await merge(branchId, { token: body.error.token })).status).toBe(409);

    const res = await merge(branchId, { token: (await review(branchId)).token });
    expect(res.status).toBe(200);
    expect(await textOf(us.mainId, 'extra')).toBe('Unseen');
    expect(await textOf(us.mainId, 'home')).toBe('Branch bread');
    expect(await textOf(us.mainId, 'about')).toBe('Since 1991');
  });

  it('asks a conflict, keeps a partial answer, and lands the answered update', async () => {
    const branchId = await createBranch(us, 'Conflicts');
    await edit(us, branchId, { home: 'Branch home', about: 'Branch about' });
    await edit(us, us.mainId, { home: 'Main home', about: 'Main about' });

    const seen = await review(branchId);
    expect(seen.conflicts).toHaveLength(2);
    const [home, about] = [...seen.conflicts].sort((a: { unit: { id: string } }, b: { unit: { id: string } }) => (a.unit.id < b.unit.id ? 1 : -1));
    expect(home.unit.id).toBe('text-home');

    // Nothing written without every answer; the one given is kept.
    const partial = await update(branchId, { token: seen.token, resolutions: { [home.id]: { fingerprint: home.fingerprint, pick: 'branch' } } });
    expect(partial.status).toBe(409);
    const left = (await partial.json()).error;
    expect(left.code).toBe('branch_conflicts');
    expect(left.answersKept).toBe(true);
    expect(left.conflicts.map((c: { id: string }) => c.id)).toEqual([about.id]);
    expect(await textOf(branchId, 'home')).toBe('Branch home');

    // Resume: a reload shows the answer settled.
    const reloaded = await review(branchId);
    expect(reloaded.settled).toMatchObject([{ id: home.id, pick: 'branch', conflict: { id: home.id, main: 'Main home', branch: 'Branch home' } }]);
    expect(reloaded.token).toBe(seen.token);

    // Changing an answer changes only that conflict's outcome.
    const done = await update(branchId, {
      token: seen.token,
      resolutions: { [about.id]: { fingerprint: about.fingerprint, pick: 'main' } },
    });
    expect(done.status).toBe(200);
    expect(await textOf(branchId, 'home')).toBe('Branch home');
    expect(await textOf(branchId, 'about')).toBe('Main about');
    expect((await prisma.siteBranch.findUniqueOrThrow({ where: { id: branchId } })).mergeDraft).toBeNull();
    expect((await review(branchId)).upToDate).toBe(true);

    const audit = await prisma.siteOperationAudit.findMany({ where: { siteId: branchId, operation: 'branch_update' } });
    expect(audit).toHaveLength(1);
  });

  it('drops an answer whose values changed, and does not bring it back when they change back', async () => {
    const branchId = await createBranch(us, 'Flip');
    await edit(us, branchId, { home: 'Branch home', about: 'Since 1990' });
    await edit(us, us.mainId, { home: 'Main home', about: 'Since 1990' });
    const seen = await review(branchId);
    const [conflict] = seen.conflicts;
    await update(branchId, { token: seen.token, resolutions: { [conflict.id]: { fingerprint: conflict.fingerprint, pick: 'branch' } } }).then(
      (r) => expect(r.status).toBe(200),
    );

    // A second round: answered, then main changes that value, then changes it back.
    await edit(us, branchId, { home: 'Branch home 2', about: 'Since 1990' });
    await edit(us, us.mainId, { home: 'Main home 2', about: 'Since 1990' });
    const round = await review(branchId);
    const [second] = round.conflicts;
    expect((await update(branchId, { token: round.token, resolutions: { [second.id]: { fingerprint: second.fingerprint, pick: 'main' } } })).status).toBe(200);
    expect(await textOf(branchId, 'home')).toBe('Main home 2');

    // Third round: the answer is given and not applied (another conflict open), then the value moves away and back.
    await edit(us, branchId, { home: 'B3', about: 'B-about' });
    await edit(us, us.mainId, { home: 'M3', about: 'M-about' });
    const third = await review(branchId);
    const homeConflict = third.conflicts.find((c: { unit: { id: string } }) => c.unit.id === 'text-home');
    await update(branchId, { token: third.token, resolutions: { [homeConflict.id]: { fingerprint: homeConflict.fingerprint, pick: 'branch' } } });
    expect((await review(branchId)).settled).toHaveLength(1);
    await edit(us, us.mainId, { home: 'M3 changed', about: 'M-about' });
    expect((await review(branchId)).settled).toEqual([]);
    await edit(us, us.mainId, { home: 'M3', about: 'M-about' });
    expect((await review(branchId)).settled).toEqual([]);
  });

  it('withdraws an approval when the branch is edited, and send-back sets it to open with the note', async () => {
    const branchId = await createBranch(us, 'Approval');
    const seen = await review(branchId);
    await approve(branchId, { token: seen.token });
    await edit(us, branchId, { home: 'Edited after', about: 'Since 1990' });
    const after = await review(branchId);
    expect(after.branch.approved).toBe(false);
    expect((await approve(branchId, { token: seen.token })).status).toBe(409);

    const ready = await getSiteBranchRepository().setBranchReady(us.scope, us.mainId, branchId, true, { kind: 'user', id: 'u' });
    expect(ready.status).toBe('ready');
    const current = await review(branchId);
    await approve(branchId, { token: current.token });
    const sent = await sendBack(branchId, { token: current.token, note: '  Fix the‮ headline  ' });
    expect(sent.status).toBe(200);
    expect((await sent.json()).branch).toMatchObject({ status: 'open', approved: false, reviewNote: 'Fix the headline', readyBy: null });
  });

  it('the counter-case: leaving and coming back with nothing changed keeps the token, the answers and the approval', async () => {
    const branchId = await createBranch(us, 'Unchanged');
    await edit(us, branchId, { home: 'Branch home', about: 'Branch about' });
    await edit(us, us.mainId, { home: 'Main home', about: 'Main about' });
    const seen = await review(branchId);
    const [one] = seen.conflicts;
    await update(branchId, { token: seen.token, resolutions: { [one.id]: { fingerprint: one.fingerprint, pick: 'branch' } } });
    await approve(branchId, { token: seen.token });
    const again = await review(branchId);
    expect(again.token).toBe(seen.token);
    expect(again.settled).toMatchObject([{ id: one.id, pick: 'branch', conflict: { id: one.id } }]);
    expect(again.branch.approved).toBe(true);
    expect(again.conflicts).toEqual(seen.conflicts.filter((c: { id: string }) => c.id !== one.id));
  });
});

describe('re-entry after completion or failure', () => {
  it('a second merge answers the first one’s result and merges nothing twice', async () => {
    const branchId = await createBranch(us, 'Twice');
    await edit(us, branchId, { home: 'Twice', about: 'Since 1990' });
    const { token } = await review(branchId);
    const first = await (await merge(branchId, { token })).json();
    const again = await merge(branchId, { token });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ merged: false, mainVersion: first.mainVersion });
    expect(await versionOf(us.mainId)).toBe(first.mainVersion);
    // Update and approval on the merged branch: closed.
    expect((await update(branchId, { token })).status).toBe(410);
    expect((await approve(branchId, { token })).status).toBe(410);
    expect((await changes(branchId)).status).toBe(410);
  });

  it('two merges at once: one merges, the other answers its result', async () => {
    const branchId = await createBranch(us, 'Race');
    await edit(us, branchId, { home: 'Race', about: 'Since 1990' });
    const { token } = await review(branchId);
    const before = await versionOf(us.mainId);
    const outcomes = await Promise.all([merge(branchId, { token }), merge(branchId, { token })]);
    expect(outcomes.map((r) => r.status)).toEqual([200, 200]);
    const bodies = await Promise.all(outcomes.map((r) => r.json()));
    expect(bodies.map((b) => b.merged).sort()).toEqual([false, true]);
    expect(await versionOf(us.mainId)).toBe(before + 1);
    expect(await prisma.siteOperationAudit.count({ where: { siteId: us.mainId, operation: 'branch_merge' } })).toBe(1);
  });

  it('a merge racing a save of main: one wins, the other is refused, nothing is half written', async () => {
    const branchId = await createBranch(us, 'Against a save');
    await edit(us, branchId, { home: 'Merged', about: 'Since 1990' });
    const { token } = await review(branchId);
    const before = await versionOf(us.mainId);
    const [merged, saved] = await Promise.allSettled([
      merge(branchId, { token }),
      getSiteRepository().saveProject(us.scope, project(us.mainId, { home: 'Saved', about: 'Since 1990' }), { mustExist: true, expectedVersion: before }),
    ]);
    const mergedStatus = merged.status === 'fulfilled' ? merged.value.status : 500;
    expect(await versionOf(us.mainId)).toBe(before + 1);
    if (saved.status === 'fulfilled') {
      // The save won: the merge wrote nothing to main (stale, or it updated the branch first).
      expect([409]).toContain(mergedStatus);
      expect(await textOf(us.mainId, 'home')).toBe('Saved');
      expect((await prisma.siteBranch.findUniqueOrThrow({ where: { id: branchId } })).status).toBe('open');
    } else {
      expect(mergedStatus).toBe(200);
      expect(saved.reason).toMatchObject({ code: 'site_changed' });
      expect(await textOf(us.mainId, 'home')).toBe('Merged');
    }
  });

  it('a failure at the last write leaves main, the branch and the record as they were', async () => {
    const branchId = await createBranch(us, 'Fails');
    await edit(us, branchId, { home: 'Never lands', about: 'Since 1990' });
    const service = new SiteBranchMergeService(prisma, getSiteRepository(), {
      beforeCommit: async () => {
        throw new Error('injected failure');
      },
    });
    const { token } = await service.changes(us.scope, branchId);
    const mainBefore = await versionOf(us.mainId);
    const branchBefore = await versionOf(branchId);
    await expect(service.merge(us.scope, branchId, { token }, { kind: 'user', id: 'u' })).rejects.toThrow('injected failure');
    expect(await versionOf(us.mainId)).toBe(mainBefore);
    expect(await textOf(us.mainId, 'home')).toBe('Fresh bread');
    expect(await versionOf(branchId)).toBe(branchBefore);
    const record = await prisma.siteBranch.findUniqueOrThrow({ where: { id: branchId } });
    expect(record).toMatchObject({ status: 'open', branchSiteId: branchId, mainBeforeDocument: null });
    expect(await prisma.siteOperationAudit.count({ where: { siteId: us.mainId, operation: 'branch_merge' } })).toBe(0);

    // The same request again, without the failure, lands.
    const merged = await getSiteBranchRepository().getBranch(us.scope, us.mainId, branchId);
    expect(merged.status).toBe('open');
    expect((await merge(branchId, { token })).status).toBe(200);
  });

  it('a failure at the last write of an update leaves the branch and its record as they were, answers kept', async () => {
    const branchId = await createBranch(us, 'Update fails');
    await edit(us, branchId, { home: 'Branch home', about: 'Since 1990' });
    await edit(us, us.mainId, { home: 'Main home', about: 'Since 1990' });
    const service = new SiteBranchMergeService(prisma, getSiteRepository(), {
      beforeCommit: async () => {
        throw new Error('injected failure');
      },
    });
    const seen = await service.changes(us.scope, branchId);
    const [conflict] = seen.conflicts;
    const before = await prisma.siteBranch.findUniqueOrThrow({ where: { id: branchId }, select: { baseVersion: true } });
    const branchBefore = await versionOf(branchId);
    await expect(
      service.update(us.scope, branchId, { token: seen.token, resolutions: { [conflict.id]: { fingerprint: conflict.fingerprint, pick: 'branch' } } }, { kind: 'user', id: 'u' }),
    ).rejects.toThrow('injected failure');
    expect(await versionOf(branchId)).toBe(branchBefore);
    expect(await textOf(branchId, 'home')).toBe('Branch home');
    expect(await prisma.siteBranch.findUniqueOrThrow({ where: { id: branchId }, select: { baseVersion: true } })).toEqual(before);
    expect(await prisma.siteOperationAudit.count({ where: { siteId: branchId, operation: 'branch_update' } })).toBe(0);
    // The answer was stored before the write was tried: the same request, sent again without it, lands.
    expect((await review(branchId)).settled).toMatchObject([{ id: conflict.id, pick: 'branch', conflict: { id: conflict.id } }]);
    expect((await update(branchId, { token: seen.token })).status).toBe(200);
  });

  it('a discarded branch answers 410 everywhere, and a new branch may take its name fresh', async () => {
    const branchId = await createBranch(us, 'Gone');
    const { token } = await review(branchId);
    const del = await branchDELETE(request('DELETE', `/api/projects/${us.mainId}/branches/${branchId}`), {
      params: Promise.resolve({ projectId: us.mainId, branchId }),
    });
    expect(del.status).toBe(200);
    for (const res of [await changes(branchId), await update(branchId, { token }), await merge(branchId, { token }), await approve(branchId, { token })]) {
      expect(res.status).toBe(410);
    }
    const again = await createBranch(us, 'Gone');
    const fresh = await review(again);
    expect(fresh).toMatchObject({ upToDate: true, settled: [], branch: { approved: false } });
  });

  it('refuses a merge that would not be a valid site, and writes nothing', async () => {
    const branchId = await createBranch(us, 'Duplicate address');
    await edit(us, branchId, { home: 'Fresh bread', about: 'Since 1990', extra: 'Extra' });
    // Main takes the extra page's address meanwhile, under another page id: both pages would claim it.
    await latestVersionRepository().saveProject(
      us.scope,
      { ...(project(us.mainId, { home: 'Fresh bread', about: 'Since 1990' }) as object), pages: {
        home: page('home', '', 'Fresh bread'), about: page('about', 'about', 'Since 1990'), other: page('other', 'extra', 'Other'),
      } } as never,
      { mustExist: true },
    );
    const seen = await review(branchId);
    expect(seen.conflicts.map((c: { kind: string }) => c.kind)).toEqual(['slug']);
    const before = await versionOf(branchId);
    expect((await update(branchId, { token: seen.token })).status).toBe(409);
    expect(await versionOf(branchId)).toBe(before);
  });
});

describe('what the whole-feature review found', () => {
  it('renaming the site on an approved branch takes the approval back: it was given for the name the reviewer saw', async () => {
    const branchId = await createBranch(us, 'Approved, then renamed');
    await edit(us, branchId, { home: 'Approved bread', about: 'Since 1990' });
    await getSiteBranchRepository().changeBranch(us.scope, us.mainId, branchId, { ready: true }, { kind: 'user', id: 'author' });
    expect((await approvePOST(request('POST', `/api/projects/${branchId}/branch/approve`, { token: (await review(branchId)).token }), ctx(branchId))).status).toBe(200);
    expect((await review(branchId)).branch.approved).toBe(true);
    await getSiteRepository().renameSite(us.scope, branchId, 'Bakery, renamed after approval');
    expect((await review(branchId)).branch.approved).toBe(false);
    // Renaming main touches no branch's approval.
    expect((await approvePOST(request('POST', `/api/projects/${branchId}/branch/approve`, { token: (await review(branchId)).token }), ctx(branchId))).status).toBe(200);
    await getSiteRepository().renameSite(us.scope, us.mainId, 'Main, renamed');
    expect((await review(branchId)).branch.approved).toBe(true);
  });

  it('a site still served from its working copy (published before versions were frozen) takes no merge and no undo until it is published once', async () => {
    const branchId = await createBranch(us, 'On an old live site');
    await edit(us, branchId, { home: 'Would go live', about: 'Since 1990' });
    await prisma.site.update({ where: { id: us.mainId }, data: { status: 'published', publishedRevisionId: null } });
    const version = (await prisma.site.findUniqueOrThrow({ where: { id: us.mainId }, select: { version: true } })).version;
    const res = await merge(branchId, { token: (await review(branchId)).token });
    expect(res.status).toBe(409);
    const error = (await res.json()).error;
    expect(error.code).toBe('site_needs_republish');
    expect(error.message).toMatch(/Publish the site once, then merge/);
    expect((await prisma.site.findUniqueOrThrow({ where: { id: us.mainId }, select: { version: true } })).version).toBe(version);
    expect(await textOf(us.mainId, 'home')).not.toBe('Would go live');
    expect((await prisma.siteBranch.findUniqueOrThrow({ where: { id: branchId } })).status).toBe('open');
    // A draft site, as every site made today is until its first publish, merges.
    await prisma.site.update({ where: { id: us.mainId }, data: { status: 'draft' } });
    expect((await merge(branchId, { token: (await review(branchId)).token })).status).toBe(200);
  });

  it('a conflict on the analytics key reference names the field and never shows what it holds', async () => {
    const branchId = await createBranch(us, 'Key reference');
    await prisma.site.update({ where: { id: branchId }, data: { apiKeyRef: 'path/on/the/branch' } });
    await prisma.site.update({ where: { id: us.mainId }, data: { apiKeyRef: 'path/on/main', version: { increment: 1 } } });
    const seen = await review(branchId);
    const conflict = seen.conflicts.find((c: { path: string[] }) => c.path[0] === 'apiKeyRef');
    expect(conflict).toBeDefined();
    expect(conflict.main).toEqual({ omitted: true, hidden: true });
    expect(conflict.branch).toEqual({ omitted: true, hidden: true });
    expect(JSON.stringify(seen)).not.toContain('path/on/');
  });

  it('approve, send back and merge refuse a large body before reading it; update and answers still take their answers', async () => {
    const branchId = await createBranch(us, 'Body sizes');
    await edit(us, branchId, { home: 'Sized bread', about: 'Since 1990' });
    const big = { token: (await review(branchId)).token, note: 'x'.repeat(40_000) };
    for (const post of [approvePOST, sendBackPOST, mergePOST]) {
      const res = await post(request('POST', `/api/projects/${branchId}/branch/x`, big), ctx(branchId));
      expect(res.status).toBe(413);
    }
    const answers = await answersPOST(request('POST', `/api/projects/${branchId}/branch/answers`, { token: big.token, resolutions: {}, pad: 'x'.repeat(40_000) }), ctx(branchId));
    expect(answers.status).not.toBe(413);
  });
});

describe('a tab open on the branch hears that it was closed', () => {
  it('a merge and a discard each announce it on the branch\'s own stream, once, after the commit', async () => {
    const heard: Array<[string, unknown]> = [];
    const mergedId = await createBranch(us, 'To merge');
    await edit(us, mergedId, { home: 'Merged bread', about: 'Since 1990' });
    const discardedId = await createBranch(us, 'To discard');
    const stop = [mergedId, discardedId].map((id) => subscribeSite(id, (event, data) => event === LIVE_EVENTS.branchClosed && heard.push([id, data])));
    expect((await merge(mergedId, { token: (await review(mergedId)).token })).status).toBe(200);
    await getSiteBranchRepository().discardBranch(us.scope, us.mainId, discardedId, { kind: 'user', id: 'u' });
    // A repeat of either writes nothing and says nothing again.
    await getSiteBranchRepository().discardBranch(us.scope, us.mainId, discardedId, { kind: 'user', id: 'u' });
    stop.forEach((off) => off());
    expect(heard).toEqual([
      [mergedId, { status: 'merged' }],
      [discardedId, { status: 'discarded' }],
    ]);
  });
});

describe('a branch that changes nothing', () => {
  it('is not merged, by the route as by the screen: nothing is written, it stays open, and the merge before it can still be undone', async () => {
    const first = await createBranch(us, 'First');
    await edit(us, first, { home: 'First bread', about: 'Since 1990' });
    expect((await merge(first, { token: (await review(first)).token })).status).toBe(200);
    const kept = await prisma.siteBranch.findUniqueOrThrow({ where: { id: first }, select: { mainBeforeExpiresAt: true } });
    expect(kept.mainBeforeExpiresAt).not.toBeNull();
    const version = (await prisma.site.findUniqueOrThrow({ where: { id: us.mainId }, select: { version: true } })).version;

    const empty = await createBranch(us, 'Nothing yet');
    const read = await review(empty);
    expect(read.unchanged).toBe(true);
    const res = await merge(empty, { token: read.token });
    expect(res.status).toBe(409);
    const error = (await res.json()).error;
    expect(error.code).toBe('branch_unchanged');
    expect(error.message).toMatch(/nothing to merge/);
    expect((await prisma.site.findUniqueOrThrow({ where: { id: us.mainId }, select: { version: true } })).version).toBe(version);
    expect((await prisma.siteBranch.findUniqueOrThrow({ where: { id: empty } })).status).toBe('open');
    // The copy kept for undoing the first merge was not replaced by a merge that did nothing.
    expect((await prisma.siteBranch.findUniqueOrThrow({ where: { id: first }, select: { mainBeforeExpiresAt: true } })).mainBeforeExpiresAt).toEqual(kept.mainBeforeExpiresAt);

    // With a change it merges, and says it is not unchanged.
    await edit(us, empty, { home: 'Second bread', about: 'Since 1990' });
    const again = await review(empty);
    expect(again.unchanged).toBe(false);
    expect((await merge(empty, { token: again.token })).status).toBe(200);
  });
});

describe('isolation', () => {
  it('answers another company’s branch like a missing one on every review route, and writes nothing', async () => {
    sessionMock.mockResolvedValue(memberOf(them));
    authMock.mockImplementation(async () => ({ authenticated: true, userId: `user-${them.companyId}` }));
    const theirs = await createBranch(them, 'Theirs');
    await edit(them, theirs, { home: 'Their change', about: 'Since 1990' });
    const { token } = await review(theirs);

    sessionMock.mockResolvedValue(memberOf(us));
    authMock.mockImplementation(async () => ({ authenticated: true, userId: `user-${us.companyId}` }));
    for (const res of [
      await changes(theirs),
      await update(theirs, { token }),
      await approve(theirs, { token }),
      await sendBack(theirs, { token, note: 'x' }),
      await merge(theirs, { token }),
      // Their main site's id named as a branch.
      await changes(them.mainId),
      await merge(them.mainId, { token }),
    ]) {
      expect(res.status).toBe(404);
    }
    expect(await prisma.siteBranch.findUniqueOrThrow({ where: { id: theirs }, select: { status: true, approvedBy: true } })).toEqual({
      status: 'open',
      approvedBy: null,
    });
    expect(await textOf(them.mainId, 'home')).toBe('Fresh bread');
    expect(await prisma.siteOperationAudit.count({ where: { workspaceId: us.scope.workspaceId, operation: { in: ['branch_merge', 'branch_update'] } } })).toBe(0);
  });

  it('answers another company’s closed branch with 404, never 410', async () => {
    sessionMock.mockResolvedValue(memberOf(them));
    authMock.mockImplementation(async () => ({ authenticated: true, userId: `user-${them.companyId}` }));
    const theirs = await createBranch(them, 'Theirs, merged');
    await edit(them, theirs, { home: 'Their bread', about: 'Since 1990' });
    const { token } = await review(theirs);
    expect((await merge(theirs, { token })).status).toBe(200);

    sessionMock.mockResolvedValue(memberOf(us));
    authMock.mockImplementation(async () => ({ authenticated: true, userId: `user-${us.companyId}` }));
    for (const res of [await changes(theirs), await merge(theirs, { token }), await update(theirs, { token })]) expect(res.status).toBe(404);
  });

  it('answers 404 with the switch off, and a main site’s id is no branch', async () => {
    const branchId = await createBranch(us, 'Switched off');
    process.env.SITE_BRANCHES_COMPANIES = them.companyId;
    expect((await changes(branchId)).status).toBe(404);
    process.env.SITE_BRANCHES_COMPANIES = us.companyId;
    expect((await changes(us.mainId)).status).toBe(404);
  });
});

describe('the erase of personal data and a merge', () => {
  it('after an erase the review sends no trace of the value: not in the list, the questions or the answered ones', async () => {
    const VALUE = 'Petra Probe';
    const branchId = await createBranch(us, 'Values');
    await edit(us, branchId, { home: `Branch: ${VALUE}`, about: `About ${VALUE}` });
    await edit(us, us.mainId, { home: `Main: ${VALUE}`, about: `Main about ${VALUE}` });
    const seen = await review(branchId);
    // Before: the change list and the questions carry the values (that is what a reviewer reads).
    expect(JSON.stringify(seen.review)).toContain(VALUE);
    const [one] = seen.conflicts;
    expect((await answers(branchId, { token: seen.token, resolutions: { [one.id]: { fingerprint: one.fingerprint, pick: 'branch' } } })).status).toBe(200);
    expect(JSON.stringify((await review(branchId)).settled)).toContain(VALUE);

    const repo = getSiteRepository();
    const query = { value: VALUE, caseSensitive: false };
    const preview = await repo.searchPersonalData(us.scope, us.mainId, query);
    await repo.erasePersonalData(us.scope, us.mainId, {
      query,
      replacement: '[entfernt]',
      token: preview.token,
      chosen: preview.matches.filter((m) => m.blocked === null).map((m) => m.id),
      erasedBy: 'u',
    });
    expect((await repo.searchPersonalData(us.scope, us.mainId, query)).total).toBe(0);
    const after = await review(branchId);
    expect(JSON.stringify(after)).not.toContain(VALUE);
    const stored = JSON.stringify(await prisma.siteBranch.findMany({ where: { siteId: us.mainId } }));
    expect(stored).not.toContain(VALUE);
  });

  it('an erase of only main’s matches leaves the branch behind main, and the merge keeps main erased', async () => {
    const VALUE = 'Erika Muster';
    // Main and the branch's fork point hold the value; the branch changes another page only.
    await edit(us, us.mainId, { home: `Run by ${VALUE}`, about: 'Since 1990' });
    const branchId = await createBranch(us, 'Partial');
    await edit(us, branchId, { home: `Run by ${VALUE}`, about: 'Branch about' });
    const repo = getSiteRepository();
    const query = { value: VALUE, caseSensitive: false };
    const preview = await repo.searchPersonalData(us.scope, us.mainId, query);
    const onMain = preview.matches.filter((m) => m.blocked === null && m.location.kind === 'working').map((m) => m.id);
    expect(onMain.length).toBeGreaterThan(0);
    const erased = await repo.erasePersonalData(us.scope, us.mainId, { query, replacement: '[entfernt]', token: preview.token, chosen: onMain, erasedBy: 'u' });
    expect(erased.remaining).toBeGreaterThan(0);

    const after = await review(branchId);
    expect(after.upToDate).toBe(false);
    await merge(branchId, { token: after.token });
    expect((await merge(branchId, { token: (await review(branchId)).token })).status).toBe(200);
    expect(await textOf(us.mainId, 'home')).toBe('Run by [entfernt]');
    expect(await textOf(us.mainId, 'about')).toBe('Branch about');
  });

  it('an erase between the review and the merge makes it stale, and the merge after leaves nothing', async () => {
    const VALUE = 'Max Mustermann';
    const branchId = await createBranch(us, 'With a name');
    await edit(us, branchId, { home: `Run by ${VALUE}`, about: 'Since 1990' });
    const { token } = await review(branchId);
    const repo = getSiteRepository();
    const query = { value: VALUE, caseSensitive: false };
    const preview = await repo.searchPersonalData(us.scope, us.mainId, query);
    await repo.erasePersonalData(us.scope, us.mainId, {
      query,
      replacement: '[entfernt]',
      token: preview.token,
      chosen: preview.matches.filter((m) => m.blocked === null).map((m) => m.id),
      erasedBy: 'u',
    });
    expect((await merge(branchId, { token })).status).toBe(409);
    // The fork point was rewritten as main was: the branch is still up to date, not behind.
    const after = await review(branchId);
    expect(after.upToDate).toBe(true);
    expect((await merge(branchId, { token: after.token })).status).toBe(200);
    const stored = JSON.stringify([
      await prisma.site.findMany({ where: { workspaceId: us.scope.workspaceId }, include: { pages: true } }),
      await prisma.siteBranch.findMany({ where: { siteId: us.mainId } }),
    ]);
    expect(stored).not.toContain(VALUE);
    expect((await repo.searchPersonalData(us.scope, us.mainId, query)).total).toBe(0);
  });
});

describe('the review (S5): the change list and answers saved as given', () => {
  it('lists what the branch changes per page and element, with old and new values', async () => {
    const branchId = await createBranch(us, 'List');
    await edit(us, branchId, { home: 'Fresh rolls', about: 'Since 1990', extra: 'New page' });
    const seen = await review(branchId);
    const units = seen.review.units as Array<{ id: string; change: string; elements: Array<{ id: string; kind: string; fields: Array<{ field: string; before: unknown; after: unknown }> }> }>;
    const home = units.find((u) => u.id === 'home')!;
    expect(home.change).toBe('changed');
    expect(home.elements).toEqual([
      expect.objectContaining({ id: 'text-home', kind: 'changed', fields: [{ field: 'props.children', before: 'Fresh bread', after: 'Fresh rolls' }] }),
    ]);
    expect(units.find((u) => u.id === 'extra')).toMatchObject({ change: 'added', slug: { before: null, after: 'extra' } });
    expect(units.find((u) => u.id === 'about')).toBeUndefined();
  });

  it('stores an answer without bringing main in; a reload finds it; changing it changes only that one', async () => {
    const branchId = await createBranch(us, 'Answers');
    await edit(us, branchId, { home: 'Branch home', about: 'Branch about' });
    await edit(us, us.mainId, { home: 'Main home', about: 'Main about' });
    const seen = await review(branchId);
    const home = seen.conflicts.find((c: { unit: { id: string } }) => c.unit.id === 'text-home');
    const about = seen.conflicts.find((c: { unit: { id: string } }) => c.unit.id === 'text-about');
    const versionBefore = await versionOf(branchId);

    // Both answered: still nothing applied (that is Update's), and the review shows both settled.
    const res = await answers(branchId, {
      token: seen.token,
      resolutions: { [home.id]: { fingerprint: home.fingerprint, pick: 'branch' }, [about.id]: { fingerprint: about.fingerprint, pick: 'main' } },
    });
    expect(res.status).toBe(200);
    const answered = await res.json();
    expect(answered.conflicts).toEqual([]);
    expect(answered.settled.map((x: { id: string; pick: string }) => [x.id, x.pick]).sort()).toEqual([[about.id, 'main'], [home.id, 'branch']].sort());
    expect(await versionOf(branchId)).toBe(versionBefore);
    expect(await textOf(branchId, 'home')).toBe('Branch home');

    // Resume: a reload (a fresh read) finds both, with the same token.
    const reloaded = await review(branchId);
    expect(reloaded.token).toBe(seen.token);
    expect(reloaded.settled).toHaveLength(2);

    // Backtrack: one answer changed from main to branch; the other stays.
    await answers(branchId, { token: seen.token, resolutions: { [about.id]: { fingerprint: about.fingerprint, pick: 'branch' } } }).then((r) => expect(r.status).toBe(200));
    const changed = await review(branchId);
    expect(Object.fromEntries(changed.settled.map((x: { id: string; pick: string }) => [x.id, x.pick]))).toEqual({ [home.id]: 'branch', [about.id]: 'branch' });

    // Update applies the stored answers.
    expect((await update(branchId, { token: seen.token })).status).toBe(200);
    expect(await textOf(branchId, 'home')).toBe('Branch home');
    expect(await textOf(branchId, 'about')).toBe('Branch about');
  });

  it('two answers stored at once both land: a draft changed by the other is no stale review', async () => {
    const branchId = await createBranch(us, 'Parallel');
    await edit(us, branchId, { home: 'Branch home', about: 'Branch about' });
    await edit(us, us.mainId, { home: 'Main home', about: 'Main about' });
    const seen = await review(branchId);
    const [one, two] = seen.conflicts;
    const [r1, r2] = await Promise.all([
      answers(branchId, { token: seen.token, resolutions: { [one.id]: { fingerprint: one.fingerprint, pick: 'branch' } } }),
      answers(branchId, { token: seen.token, resolutions: { [two.id]: { fingerprint: two.fingerprint, pick: 'main' } } }),
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const after = await review(branchId);
    expect(Object.fromEntries(after.settled.map((x: { id: string; pick: string }) => [x.id, x.pick]))).toEqual({ [one.id]: 'branch', [two.id]: 'main' });
  });

  it('refuses answers for a state that moved, storing nothing', async () => {
    const branchId = await createBranch(us, 'Stale');
    await edit(us, branchId, { home: 'Branch home', about: 'Since 1990' });
    await edit(us, us.mainId, { home: 'Main home', about: 'Since 1990' });
    const seen = await review(branchId);
    const [conflict] = seen.conflicts;
    await edit(us, us.mainId, { home: 'Main home 2', about: 'Since 1990' });
    const res = await answers(branchId, { token: seen.token, resolutions: { [conflict.id]: { fingerprint: conflict.fingerprint, pick: 'branch' } } });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('branch_review_stale');
    expect((await prisma.siteBranch.findUniqueOrThrow({ where: { id: branchId } })).mergeDraft).toBeNull();
  });

  it('ignores an answer whose fingerprint is not the conflict\'s, and a viewer may not answer', async () => {
    const branchId = await createBranch(us, 'Wrong');
    await edit(us, branchId, { home: 'Branch home', about: 'Since 1990' });
    await edit(us, us.mainId, { home: 'Main home', about: 'Since 1990' });
    const seen = await review(branchId);
    const [conflict] = seen.conflicts;
    const res = await answers(branchId, { token: seen.token, resolutions: { [conflict.id]: { fingerprint: 'not-it', pick: 'branch' } } });
    expect(res.status).toBe(200);
    expect((await res.json()).settled).toEqual([]);

    authMock.mockImplementation(async (_req: unknown, _ws: unknown, action: unknown) =>
      action === 'editSite' ? { authenticated: false, status: 403, error: 'not allowed' } : { authenticated: true, userId: `user-${us.companyId}` },
    );
    const viewer = await answers(branchId, { token: seen.token, resolutions: { [conflict.id]: { fingerprint: conflict.fingerprint, pick: 'branch' } } });
    expect(viewer.status).toBe(403);
    // A viewer still reads the review.
    expect((await changes(branchId)).status).toBe(200);
  });

  it('answers another company\'s branch like a missing one, storing nothing', async () => {
    const branchId = await createBranch(us, 'Ours');
    sessionMock.mockResolvedValue(memberOf(them));
    const res = await answers(branchId, { token: 'x'.repeat(64), resolutions: {} });
    expect(res.status).toBe(404);
  });
});
