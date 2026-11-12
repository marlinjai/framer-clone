// The public preview link of a site branch (docs/plans/2026-11-10-site-branches.md, section 7, slice S8) against
// a real Postgres: the four paths (make and open, change the branch and replace the link, come back to it, after
// revoke, expiry and a closed branch), what is stored, who may, another company, and the switch off. The session
// and the permission check are faked; everything below them is real.

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
import { getSiteBranchRepository } from '@/server/sites/branches/repository';
import { getSiteBranchMergeService } from '@/server/sites/branches/merge';
import { previewTokenHash, resolvePreviewSite } from '@/server/sites/branches/previewLinks';
import { resolvePublishedSite } from '@/server/sites/publicResolver';
import { resolveStorefrontCommerce } from '@/server/commerce/storefrontTenant';
import { previewTokenOfHost } from '@/lib/sites/previewHost';
import { DELETE as linkDELETE, GET as linkGET, POST as linkPOST } from '../[projectId]/branches/[branchId]/preview-link/route';

const EDITOR = 'app.lumitra.test';
const SITES_BASE = 'sites.lumitra.test';
const TENANT_GROUP = '018f9c10-0000-7000-8000-0000000b5b08';
const USER = { kind: 'user', id: 'person-1' } as const;
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
const savedEnv = { editor: process.env.EDITOR_HOST, branches: process.env.SITE_BRANCHES_COMPANIES, base: process.env.PUBLIC_SITE_BASE_HOST };

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

function project(id: string, home: string) {
  return {
    id,
    metadata: { title: 'Bakery', description: '', createdAt: 1, updatedAt: 2 },
    pages: { home: page('home', '', home), about: page('about', 'about', 'Since 1990') },
  } as never;
}

async function makeCompany(): Promise<Company> {
  const companyId = `company-${randomUUID().slice(0, 8)}`;
  const scope = { workspaceId: `ws_bpv_${randomUUID().slice(0, 8)}`, tenantGroupId: TENANT_GROUP };
  const mainId = randomUUID();
  await latestVersionRepository().saveProject(scope, project(mainId, 'Fresh bread'), { companyId });
  return { companyId, scope, mainId };
}

const edit = (company: Company, siteId: string, home: string) => latestVersionRepository().saveProject(company.scope, project(siteId, home), { mustExist: true });

function textOf(site: { pages: Array<{ pageId: string; snapshot: unknown }> } | null, pageId: string): string | undefined {
  const snapshot = site?.pages.find((p) => p.pageId === pageId)?.snapshot as { appComponentTree?: { children?: Array<{ props?: { children?: string } }> } } | undefined;
  return snapshot?.appComponentTree?.children?.[0]?.props?.children;
}

async function newBranch(name = 'Summer sale', home = 'Summer bread'): Promise<string> {
  const { branch } = await getSiteBranchRepository().createBranch(us.scope, us.mainId, { name, actor: USER });
  await edit(us, branch.branchId, home);
  return branch.branchId;
}

function request(method: string, path: string, body?: unknown): Request {
  return new Request(`https://${EDITOR}${path}`, {
    method,
    headers: { host: EDITOR, cookie: 'lumitra_session=faked', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ctx = (mainId: string, branchId: string) => ({ params: Promise.resolve({ projectId: mainId, branchId }) });
const path = (mainId: string, branchId: string) => `/api/projects/${mainId}/branches/${branchId}/preview-link`;
const make = (mainId: string, branchId: string, body: unknown = {}) => linkPOST(request('POST', path(mainId, branchId), body), ctx(mainId, branchId));
const read = (mainId: string, branchId: string) => linkGET(request('GET', path(mainId, branchId)), ctx(mainId, branchId));
const revoke = (mainId: string, branchId: string) => linkDELETE(request('DELETE', path(mainId, branchId)), ctx(mainId, branchId));

/** Make a link and answer the host of its address. */
async function linkHost(branchId: string, body: unknown = {}): Promise<string> {
  const res = await make(us.mainId, branchId, body);
  expect(res.status).toBe(201);
  return new URL((await res.json()).link.url).host;
}

beforeAll(() => {
  prisma = getPrismaClient();
  process.env.EDITOR_HOST = EDITOR;
});

beforeEach(async () => {
  us = await makeCompany();
  them = await makeCompany();
  process.env.SITE_BRANCHES_COMPANIES = `${us.companyId},${them.companyId}`;
  process.env.PUBLIC_SITE_BASE_HOST = SITES_BASE;
  sessionMock.mockResolvedValue(memberOf(us));
  authMock.mockImplementation(async () => ({ authenticated: true, userId: `user-${us.companyId}` }));
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  process.env.EDITOR_HOST = savedEnv.editor;
  process.env.SITE_BRANCHES_COMPANIES = savedEnv.branches;
  process.env.PUBLIC_SITE_BASE_HOST = savedEnv.base;
  await prisma.siteOperationAudit.deleteMany({ where: { tenantGroupId: TENANT_GROUP } });
  await prisma.site.deleteMany({ where: { tenantGroupId: TENANT_GROUP, branchOfSiteId: { not: null } } });
  await prisma.site.deleteMany({ where: { tenantGroupId: TENANT_GROUP } });
  await prisma.$disconnect();
});

describe('forward', () => {
  it('makes a link whose address shows the branch, read as a preview of main\'s site with analytics off', async () => {
    const branchId = await newBranch();
    await prisma.site.update({ where: { id: branchId }, data: { lumitraEnabled: true, apiKeyRef: 'some/ref', analyticsProjectId: 'p1' } });
    expect(await (await read(us.mainId, branchId)).json()).toEqual({ link: null });

    const res = await make(us.mainId, branchId);
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { link } = await res.json();
    expect(link.url).toMatch(new RegExp(`^https://preview-[a-z2-7]{32}\\.${SITES_BASE.replace(/\./g, '\\.')}/$`));
    expect(link).toMatchObject({ expired: false, createdBy: `user-${us.companyId}` });
    // Seven days unless asked otherwise.
    expect(Date.parse(link.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
    expect(Date.parse(link.expiresAt) - Date.now()).toBeLessThan(7.1 * 24 * 60 * 60 * 1000);

    const host = new URL(link.url).host;
    const token = previewTokenOfHost(host)!;
    // Stored: the hash, never the token.
    const row = await prisma.siteBranchPreview.findUniqueOrThrow({ where: { branchId } });
    expect(row.tokenHash).toBe(previewTokenHash(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row).toMatchObject({ workspaceId: us.scope.workspaceId, tenantGroupId: TENANT_GROUP, companyId: us.companyId });

    const site = await resolvePreviewSite(host);
    expect(textOf(site, 'home')).toBe('Summer bread');
    expect(site).toMatchObject({
      siteId: us.mainId,
      workspaceId: us.scope.workspaceId,
      lumitraEnabled: false,
      apiKeyRef: null,
      analyticsProjectId: null,
      ingestionEndpoint: null,
      revisionNumber: null,
      preview: { branchId, branchName: 'Summer sale', expiresAt: link.expiresAt },
    });
    expect(site?.revision).toMatch(new RegExp(`^preview:${branchId}:\\d+:\\d+$`));
    // The address in any letter case and with a port is the same address.
    expect(textOf(await resolvePreviewSite(`${host.toUpperCase()}:443`), 'home')).toBe('Summer bread');

    // It is not a published site: nothing that serves, sells or takes a form on a published host knows it.
    expect(await resolvePublishedSite(host)).toBeNull();
    const storefront = await resolveStorefrontCommerce(host);
    expect(storefront.ok).toBe(false);
    if (!storefront.ok) expect(storefront.response.status).toBe(403);

    // Audited with ids and the day count only.
    const audit = await prisma.siteOperationAudit.findFirstOrThrow({ where: { siteId: us.mainId, operation: 'branch_preview_create' } });
    expect(audit).toMatchObject({ actorKind: 'user', actorId: `user-${us.companyId}`, actorDetail: { branchId, days: 7 } });
    expect(JSON.stringify(audit)).not.toContain(token);
    expect(JSON.stringify(audit)).not.toContain(row.tokenHash);
  });

  it('takes 1, 7 or 30 days and refuses anything else', async () => {
    const branchId = await newBranch();
    const res = await make(us.mainId, branchId, { days: 30 });
    expect(res.status).toBe(201);
    expect(Date.parse((await res.json()).link.expiresAt) - Date.now()).toBeGreaterThan(29.9 * 24 * 60 * 60 * 1000);
    for (const days of [0, 2, 365, -7, '7']) expect((await make(us.mainId, branchId, { days })).status).toBe(400);
  });

  it('says so when no address for published sites is configured, and makes nothing', async () => {
    const branchId = await newBranch();
    delete process.env.PUBLIC_SITE_BASE_HOST;
    const res = await make(us.mainId, branchId);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('preview_link_unavailable');
    expect(await prisma.siteBranchPreview.count({ where: { branchId } })).toBe(0);
  });
});

describe('backtrack and revise', () => {
  it('shows the branch as it is now, under a new memo key, after every save', async () => {
    const branchId = await newBranch();
    const host = await linkHost(branchId);
    const first = await resolvePreviewSite(host);
    await edit(us, branchId, 'Autumn bread');
    const second = await resolvePreviewSite(host);
    expect(textOf(second, 'home')).toBe('Autumn bread');
    expect(second?.revision).not.toBe(first?.revision);
    // Main is untouched and not what the preview shows.
    expect((await prisma.site.findUniqueOrThrow({ where: { id: us.mainId }, select: { version: true } })).version).toBe(1);
  });

  it('a new link replaces the old one: the old address shows nothing at once', async () => {
    const branchId = await newBranch();
    const oldHost = await linkHost(branchId);
    const newHost = await linkHost(branchId, { days: 1 });
    expect(newHost).not.toBe(oldHost);
    expect(await resolvePreviewSite(oldHost)).toBeNull();
    expect(textOf(await resolvePreviewSite(newHost), 'home')).toBe('Summer bread');
    expect(await prisma.siteBranchPreview.count({ where: { branchId } })).toBe(1);
  });
});

describe('resume', () => {
  it('coming back shows that a link exists and until when, never its address', async () => {
    const branchId = await newBranch();
    const host = await linkHost(branchId);
    const res = await read(us.mainId, branchId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.link).toMatchObject({ expired: false, createdBy: `user-${us.companyId}` });
    expect(Object.keys(body.link).sort()).toEqual(['createdAt', 'createdBy', 'expired', 'expiresAt']);
    expect(JSON.stringify(body)).not.toContain(previewTokenOfHost(host)!);
  });
});

describe('re-entry', () => {
  it('a revoked link shows nothing, and revoking again changes nothing', async () => {
    const branchId = await newBranch();
    const host = await linkHost(branchId);
    const res = await revoke(us.mainId, branchId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    expect(await resolvePreviewSite(host)).toBeNull();
    expect(await (await read(us.mainId, branchId)).json()).toEqual({ link: null });
    expect(await (await revoke(us.mainId, branchId)).json()).toEqual({ revoked: false });
    expect(await prisma.siteOperationAudit.count({ where: { siteId: us.mainId, operation: 'branch_preview_revoke' } })).toBe(1);
    // A new one can be made afterwards.
    expect(textOf(await resolvePreviewSite(await linkHost(branchId)), 'home')).toBe('Summer bread');
  });

  it('an expired link shows nothing, reads as expired, and can be replaced', async () => {
    const branchId = await newBranch();
    const host = await linkHost(branchId);
    await prisma.siteBranchPreview.update({ where: { branchId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await resolvePreviewSite(host)).toBeNull();
    expect((await (await read(us.mainId, branchId)).json()).link).toMatchObject({ expired: true });
    const again = await linkHost(branchId);
    expect(await resolvePreviewSite(host)).toBeNull();
    expect(textOf(await resolvePreviewSite(again), 'home')).toBe('Summer bread');
  });

  it('a discarded branch has no link left, and none can be made', async () => {
    const branchId = await newBranch();
    const host = await linkHost(branchId);
    await getSiteBranchRepository().discardBranch(us.scope, us.mainId, branchId, USER);
    expect(await prisma.siteBranchPreview.count({ where: { branchId } })).toBe(0);
    expect(await resolvePreviewSite(host)).toBeNull();
    expect((await make(us.mainId, branchId)).status).toBe(410);
    expect((await read(us.mainId, branchId)).status).toBe(410);
    expect(await (await revoke(us.mainId, branchId)).json()).toEqual({ revoked: false });
  });

  it('a merged branch has no link left: the work is on the site, not behind a preview address', async () => {
    const branchId = await newBranch();
    const host = await linkHost(branchId);
    const service = getSiteBranchMergeService();
    const { token } = await service.changes(us.scope, branchId);
    expect((await service.merge(us.scope, branchId, { token }, USER)).merged).toBe(true);
    expect(await prisma.siteBranchPreview.count({ where: { branchId } })).toBe(0);
    expect(await resolvePreviewSite(host)).toBeNull();
  });
});

describe('bounds and isolation', () => {
  it('an address that names no link reads nothing: wrong shape, unknown token, another base', async () => {
    const branchId = await newBranch();
    const host = await linkHost(branchId);
    const token = previewTokenOfHost(host)!;
    const flipped = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
    for (const other of [
      `preview-${flipped}.${SITES_BASE}`,
      `preview-${token.slice(1)}.${SITES_BASE}`,
      `preview-${token}x.${SITES_BASE}`,
      `preview-${token}.example.com`,
      `x.preview-${token}.${SITES_BASE}`,
      `${token}.${SITES_BASE}`,
      `preview-${previewTokenHash(token).slice(0, 32)}.${SITES_BASE}`,
      SITES_BASE,
      '',
    ]) {
      expect(await resolvePreviewSite(other), other).toBeNull();
    }
    expect(await resolvePreviewSite(null)).toBeNull();
  });

  it('another company is answered like a missing site, and its own session opens nothing of ours', async () => {
    const branchId = await newBranch();
    const host = await linkHost(branchId);
    sessionMock.mockResolvedValue(memberOf(them));
    authMock.mockImplementation(async () => ({ authenticated: true, userId: `user-${them.companyId}` }));
    for (const [main, branch] of [[us.mainId, branchId], [them.mainId, branchId]]) {
      for (const call of [read, make, revoke]) {
        const res = await call(main, branch);
        expect(res.status).toBe(404);
        expect(JSON.stringify(await res.json())).not.toContain('Summer');
      }
    }
    // Ours is as it was.
    expect(textOf(await resolvePreviewSite(host), 'home')).toBe('Summer bread');
    expect(await prisma.siteBranchPreview.count({ where: { branchId } })).toBe(1);
  });

  it('making and revoking need the right to edit; reading needs the right to view', async () => {
    const branchId = await newBranch();
    const host = await linkHost(branchId);
    authMock.mockImplementation(async (_req, _workspace, action) =>
      action === 'editSite' ? { authenticated: false, status: 403, error: 'forbidden' } : { authenticated: true, userId: 'viewer' },
    );
    expect((await make(us.mainId, branchId)).status).toBe(403);
    expect((await revoke(us.mainId, branchId)).status).toBe(403);
    expect((await read(us.mainId, branchId)).status).toBe(200);
    expect(textOf(await resolvePreviewSite(host), 'home')).toBe('Summer bread');
    authMock.mockImplementation(async () => ({ authenticated: false, status: 403, error: 'forbidden' }));
    expect((await read(us.mainId, branchId)).status).toBe(403);
  });

  it('with the switch off for the company the routes are not there and the address shows nothing, until it is on again', async () => {
    const branchId = await newBranch();
    const host = await linkHost(branchId);
    process.env.SITE_BRANCHES_COMPANIES = them.companyId;
    for (const call of [read, make, revoke]) expect((await call(us.mainId, branchId)).status).toBe(404);
    expect(await resolvePreviewSite(host)).toBeNull();
    process.env.SITE_BRANCHES_COMPANIES = us.companyId;
    expect(textOf(await resolvePreviewSite(host), 'home')).toBe('Summer bread');
  });

  it('a link row of another workspace\'s branch cannot exist, and a stored hash is a hash', async () => {
    const branchId = await newBranch();
    const row = { id: randomUUID(), branchId, tenantGroupId: TENANT_GROUP, expiresAt: new Date(Date.now() + 1000), createdBy: 'x' };
    await expect(prisma.siteBranchPreview.create({ data: { ...row, workspaceId: them.scope.workspaceId, tokenHash: 'a'.repeat(64) } })).rejects.toThrow();
    await expect(prisma.siteBranchPreview.create({ data: { ...row, workspaceId: us.scope.workspaceId, tokenHash: 'not-a-hash' } })).rejects.toThrow();
  });
});
