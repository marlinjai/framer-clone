// src/server/sites/__tests__/branchEditorState.itest.ts
//
// Site branches, slice S4 (docs/plans/2026-11-10-site-branches.md): what the editor page is told about the site
// it opens, against a REAL Postgres. Main with its open branch count; a branch with its record and its main's
// name; a merged or discarded branch's old address as a notice with its date; with the switch off nothing for
// main and `hidden` for a branch (its address answers 404); another workspace's ids read as nothing.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '@/server/db';
import { SiteNotFoundError, type TenantScope } from '@/server/sites';
import { SiteBranchRepository } from '@/server/sites/branches/repository';
import { closedBranchNotice, editorBranchState } from '@/server/sites/branches/editorState';
import { latestVersionRepository } from './latestVersionRepository';

const TENANT_GROUP = '018f9c10-0000-7000-8000-0000000b5e01';
const OTHER_GROUP = '018f9c10-0000-7000-8000-0000000b5e02';
const COMPANY = 'company-branch-editor';
const ALICE = { kind: 'user' as const, id: 'user-alice' };

let prisma: PrismaClient;
let branches: SiteBranchRepository;
let scope: TenantScope;
let foreign: TenantScope;
let mainId: string;
const savedSwitch = process.env.SITE_BRANCHES_COMPANIES;

function project(id: string) {
  return {
    id,
    metadata: { title: 'Bakery', description: 'A bakery', createdAt: 1, updatedAt: 2 },
    pages: {
      home: {
        id: 'home',
        slug: '',
        metadata: { title: 'Home', description: '' },
        appComponentTree: { id: 'root-home', type: 'div', componentType: 'host', props: { children: 'Hi' }, children: [] },
        canvasNodes: {},
      },
    },
    siteSettings: { siteName: 'Bakery' },
  } as never;
}

beforeAll(() => {
  prisma = getPrismaClient();
  branches = new SiteBranchRepository(prisma);
});

beforeEach(async () => {
  process.env.SITE_BRANCHES_COMPANIES = COMPANY;
  scope = { workspaceId: `ws_bre_${randomUUID().slice(0, 8)}`, tenantGroupId: TENANT_GROUP };
  foreign = { workspaceId: `ws_brex_${randomUUID().slice(0, 8)}`, tenantGroupId: OTHER_GROUP };
  mainId = randomUUID();
  await latestVersionRepository().saveProject(scope, project(mainId), { companyId: COMPANY });
});

afterEach(() => {
  if (savedSwitch === undefined) delete process.env.SITE_BRANCHES_COMPANIES;
  else process.env.SITE_BRANCHES_COMPANIES = savedSwitch;
});

afterAll(async () => {
  await prisma.site.deleteMany({ where: { tenantGroupId: { in: [TENANT_GROUP, OTHER_GROUP] }, branchOfSiteId: { not: null } } });
  await prisma.site.deleteMany({ where: { tenantGroupId: { in: [TENANT_GROUP, OTHER_GROUP] } } });
  await prisma.$disconnect();
});

describe('the editor page on main and on a branch', () => {
  it('tells main its name and how many branches are open', async () => {
    expect(await editorBranchState(scope, COMPANY, mainId)).toEqual({ kind: 'main', siteId: mainId, siteName: 'Bakery', openBranches: 0 });
    await branches.createBranch(scope, mainId, { name: 'Spring sale', actor: ALICE });
    await branches.createBranch(scope, mainId, { name: 'Autumn', actor: ALICE });
    expect(await editorBranchState(scope, COMPANY, mainId)).toMatchObject({ kind: 'main', openBranches: 2 });
  });

  it('tells a branch its record, as JSON, and its main', async () => {
    const { branch } = await branches.createBranch(scope, mainId, { name: 'Spring sale', actor: ALICE });
    const state = await editorBranchState(scope, COMPANY, branch.branchId);
    expect(state).toMatchObject({
      kind: 'branch',
      siteId: branch.branchId,
      mainSiteId: mainId,
      mainName: 'Bakery',
      branch: { branchId: branch.branchId, name: 'Spring sale', status: 'open', mainMoved: false, createdAt: branch.createdAt.toISOString() },
    });
    // Survives the trip from the server page to the client: plain JSON.
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it('says when main moved since the fork point', async () => {
    const { branch } = await branches.createBranch(scope, mainId, { name: 'Spring sale', actor: ALICE });
    const changed = project(mainId) as unknown as { metadata: { description: string } };
    changed.metadata.description = 'Fresh bread';
    await latestVersionRepository().saveProject(scope, changed as never, { mustExist: true });
    expect(await editorBranchState(scope, COMPANY, branch.branchId)).toMatchObject({ kind: 'branch', branch: { mainMoved: true } });
  });
});

describe('the switch off', () => {
  it('tells main nothing, and hides a branch', async () => {
    const { branch } = await branches.createBranch(scope, mainId, { name: 'Spring sale', actor: ALICE });
    delete process.env.SITE_BRANCHES_COMPANIES;
    expect(await editorBranchState(scope, COMPANY, mainId)).toBeNull();
    expect(await editorBranchState(scope, COMPANY, branch.branchId)).toBe('hidden');
    expect(await closedBranchNotice(scope, COMPANY, branch.branchId)).toBeNull();
  });

  it('is per company', async () => {
    expect(await editorBranchState(scope, 'another-company', mainId)).toBeNull();
  });
});

describe('a closed branch\'s old address', () => {
  it('names the discard, its date and the site', async () => {
    const { branch } = await branches.createBranch(scope, mainId, { name: 'Spring sale', actor: ALICE });
    await branches.discardBranch(scope, mainId, branch.branchId, ALICE);
    const notice = await closedBranchNotice(scope, COMPANY, branch.branchId);
    expect(notice).toMatchObject({ branchId: branch.branchId, status: 'discarded', name: 'Spring sale', mainSiteId: mainId, mainName: 'Bakery' });
    expect(Date.parse(notice!.closedAt!)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('is nothing for an open branch, a main site or an unknown id', async () => {
    const { branch } = await branches.createBranch(scope, mainId, { name: 'Spring sale', actor: ALICE });
    expect(await closedBranchNotice(scope, COMPANY, branch.branchId)).toBeNull();
    expect(await closedBranchNotice(scope, COMPANY, mainId)).toBeNull();
    expect(await closedBranchNotice(scope, COMPANY, randomUUID())).toBeNull();
  });
});

describe('another workspace', () => {
  it('reads as nothing: no state, no notice', async () => {
    const { branch } = await branches.createBranch(scope, mainId, { name: 'Spring sale', actor: ALICE });
    await expect(editorBranchState(foreign, COMPANY, mainId)).rejects.toBeInstanceOf(SiteNotFoundError);
    await branches.discardBranch(scope, mainId, branch.branchId, ALICE);
    expect(await closedBranchNotice(foreign, COMPANY, branch.branchId)).toBeNull();
  });
});
