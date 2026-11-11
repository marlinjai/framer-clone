// The site branch routes (docs/plans/2026-11-10-site-branches.md, slice S1) against a real Postgres: the guard
// chain with the per-company switch, a foreign company answered like a missing site, and the forward path over
// HTTP (create, a retried create, list, rename, ready, discard, the 410 after). The session and the permission
// check are faked; everything below them is real.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { SessionVerifyResponse } from '@marlinjai/auth-brain-sdk';

vi.mock('next/cache', () => ({ unstable_cache: (fn: (...args: unknown[]) => unknown) => fn, revalidateTag: vi.fn() }));
vi.mock('@/lib/auth-api', () => ({ getVerifiedSession: vi.fn(), authenticateRequest: vi.fn() }));
vi.mock('@/lib/auth-check', () => ({ checkWorkspaceAccess: vi.fn(async () => true) }));

import { authenticateRequest, getVerifiedSession } from '@/lib/auth-api';
import { getPrismaClient } from '@/server/db';
import type { TenantScope } from '@/server/sites';
import { latestVersionRepository } from '@/server/sites/__tests__/latestVersionRepository';
import { GET as listGET, POST as createPOST } from '../[projectId]/branches/route';
import { DELETE as branchDELETE, GET as branchGET, PATCH as branchPATCH } from '../[projectId]/branches/[branchId]/route';
import { DELETE as projectDELETE } from '../[projectId]/route';

const EDITOR = 'app.lumitra.test';
const TENANT_GROUP = '018f9c10-0000-7000-8000-0000000b5b01';
const sessionMock = vi.mocked(getVerifiedSession);
const authMock = vi.mocked(authenticateRequest);

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

async function makeCompany(): Promise<Company> {
  const companyId = `company-${randomUUID().slice(0, 8)}`;
  const scope = { workspaceId: `ws_brr_${randomUUID().slice(0, 8)}`, tenantGroupId: TENANT_GROUP };
  const mainId = randomUUID();
  await latestVersionRepository().saveProject(
    scope,
    {
      id: mainId,
      metadata: { title: 'Bakery', description: '', createdAt: 1, updatedAt: 2 },
      pages: {
        home: {
          id: 'home', slug: '', metadata: { title: 'Home' },
          appComponentTree: { id: 'root', type: 'div', componentType: 'host', props: {}, children: [] }, canvasNodes: {},
        },
      },
    } as never,
    { companyId },
  );
  return { companyId, scope, mainId };
}

function request(method: string, path: string, body?: unknown, host = EDITOR): Request {
  return new Request(`https://${host}${path}`, {
    method,
    headers: { host, cookie: 'lumitra_session=faked', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const list = (mainId: string, host?: string) =>
  listGET(request('GET', `/api/projects/${mainId}/branches`, undefined, host), { params: Promise.resolve({ projectId: mainId }) });
const create = (mainId: string, body: unknown) =>
  createPOST(request('POST', `/api/projects/${mainId}/branches`, body), { params: Promise.resolve({ projectId: mainId }) });
const one = (method: 'GET' | 'PATCH' | 'DELETE', mainId: string, branchId: string, body?: unknown) => {
  const handler = method === 'GET' ? branchGET : method === 'PATCH' ? branchPATCH : branchDELETE;
  return handler(request(method, `/api/projects/${mainId}/branches/${branchId}`, body), {
    params: Promise.resolve({ projectId: mainId, branchId }),
  });
};

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

describe('the guard chain', () => {
  it('answers 404 with the switch off for the company, and creates nothing', async () => {
    process.env.SITE_BRANCHES_COMPANIES = them.companyId;
    expect((await list(us.mainId)).status).toBe(404);
    expect((await create(us.mainId, { name: 'Off' })).status).toBe(404);
    delete process.env.SITE_BRANCHES_COMPANIES;
    expect((await create(us.mainId, { name: 'Off' })).status).toBe(404);
    expect(await prisma.siteBranch.count({ where: { siteId: us.mainId } })).toBe(0);
  });

  it('answers 404 on a published host, 401 without a session, 403 without the permission', async () => {
    expect((await list(us.mainId, 'bakery.sites.lumitra.co')).status).toBe(404);
    sessionMock.mockResolvedValueOnce(null);
    expect((await list(us.mainId)).status).toBe(401);
    authMock.mockResolvedValueOnce({ authenticated: false, error: 'Forbidden', status: 403 });
    expect((await create(us.mainId, { name: 'No' })).status).toBe(403);
  });

  it('answers another company’s site and branch exactly like missing ones, and changes nothing', async () => {
    sessionMock.mockResolvedValue(memberOf(them));
    const theirs = await create(them.mainId, { name: 'Theirs' });
    expect(theirs.status).toBe(201);
    const theirBranch = (await theirs.json()).branch.branchId as string;

    sessionMock.mockResolvedValue(memberOf(us));
    for (const res of [
      await list(them.mainId),
      await create(them.mainId, { name: 'Intruder' }),
      await one('GET', them.mainId, theirBranch),
      await one('PATCH', them.mainId, theirBranch, { name: 'Mine' }),
      await one('DELETE', them.mainId, theirBranch),
      // Their branch named under our own site.
      await one('GET', us.mainId, theirBranch),
      await one('DELETE', us.mainId, theirBranch),
    ]) {
      expect(res.status).toBe(404);
    }
    expect(await prisma.siteBranch.findUniqueOrThrow({ where: { id: theirBranch }, select: { name: true, status: true } })).toEqual({
      name: 'Theirs',
      status: 'open',
    });
  });
});

describe('forward over HTTP', () => {
  it('creates, retries, lists, renames, marks ready, discards, then answers 410', async () => {
    const branchId = randomUUID();
    const made = await create(us.mainId, { name: 'Spring sale', branchId });
    expect(made.status).toBe(201);
    const retried = await create(us.mainId, { name: 'Spring sale', branchId });
    expect(retried.status).toBe(200);
    expect((await retried.json()).created).toBe(false);
    expect((await create(us.mainId, { name: 'spring SALE' })).status).toBe(409);
    expect((await create(us.mainId, { name: '   ' })).status).toBe(400);

    const listed = await (await list(us.mainId)).json();
    expect(listed.open.map((b: { branchId: string }) => b.branchId)).toEqual([branchId]);

    const renamed = await one('PATCH', us.mainId, branchId, { name: 'Summer sale', ready: true });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).branch).toMatchObject({ name: 'Summer sale', status: 'ready' });

    // A branch is not deleted as a site.
    const asSite = await projectDELETE(request('DELETE', `/api/projects/${branchId}`), { params: Promise.resolve({ projectId: branchId }) });
    expect(asSite.status).toBe(409);
    expect((await asSite.json()).error.code).toBe('site_is_branch');

    const discarded = await one('DELETE', us.mainId, branchId);
    expect(discarded.status).toBe(200);
    expect(await discarded.json()).toMatchObject({ discarded: true, branch: { status: 'discarded' } });
    const late = await one('PATCH', us.mainId, branchId, { name: 'Too late' });
    expect(late.status).toBe(410);
    expect((await late.json()).error).toMatchObject({ code: 'branch_closed', branchStatus: 'discarded', mainSiteId: us.mainId });
    // The closed record stays readable.
    expect((await one('GET', us.mainId, branchId)).status).toBe(200);
  });
});
