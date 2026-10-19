// src/app/api/projects/__tests__/create-route.itest.ts
//
// The END-TO-END isolation proof for POST /api/projects against a REAL Postgres.
// The unit test (create-route.test.ts) mocks the repository; this file runs the
// route with NO repository mock — only the auth-brain client is mocked (to mint
// two distinct verified sessions for two distinct workspaces), so the FULL chain
// executes against the container DB:
//   getVerifiedSession -> resolveActiveScope -> authenticateRequest('editSite')
//     -> provisionCommerceTenant(tenant group) -> getSiteRepository().saveProject(...)
//
// It asserts the hard-isolation contract MT-05 exists to guarantee: two
// different sessions create rows in DIFFERENT workspaces, and neither scope can
// `loadProject` the other's site id (each gets SiteNotFoundError, never the
// other tenant's data).
//
// The `.itest.ts` suffix keeps this OUT of the headless `pnpm test` unit gate
// (vitest.config.ts matches only *.{test,spec}.{ts,tsx}); it runs ONLY under
// `pnpm test:integration`, whose globalSetup boots a Dockerized Postgres, runs
// `prisma migrate deploy`, and exposes DATABASE_URL before the workers fork. It
// requires a running Docker daemon.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

// Two workspaces in two tenant_groups. The mocked auth-brain maps each session
// cookie to one of these; resolveActiveScope (REAL) derives the scope from it.
const SESSION_A = {
  user: { id: 'user-a' },
  session: {},
  tenants: [{ id: 'tenant-a', app_grants: ['sites'], group_id: '018f9c10-0000-7000-8000-0000000000a1' }],
  workspaces: [{ id: 'ws_a', tenant_id: 'tenant-a' }],
  active_tenant: { id: 'tenant-a' },
  active_workspace: { id: 'ws_a' },
};
const SESSION_B = {
  user: { id: 'user-b' },
  session: {},
  tenants: [{ id: 'tenant-b', app_grants: ['sites'], group_id: '018f9c10-0000-7000-8000-0000000000b1' }],
  workspaces: [{ id: 'ws_b', tenant_id: 'tenant-b' }],
  active_tenant: { id: 'tenant-b' },
  active_workspace: { id: 'ws_b' },
};

// Map the session cookie -> verified session. `can` always allows (both users
// are admins of their own workspace); the isolation under test is the DATA
// boundary (workspace_id filtering), not authorization.
vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    verifySession: vi.fn(async (cookie: string) => {
      if (cookie === 'sess_a') return SESSION_A;
      if (cookie === 'sess_b') return SESSION_B;
      return null;
    }),
    can: vi.fn(async () => true),
    verifyApiKey: vi.fn(),
    getCurrentUser: vi.fn(),
  },
}));

import { getPrismaClient } from '@/server/db';
import {
  getSiteRepository,
  SiteNotFoundError,
  type TenantScope,
} from '@/server/sites';
import { POST } from '../route';

const SCOPE_A: TenantScope = { workspaceId: 'ws_a', tenantGroupId: '018f9c10-0000-7000-8000-0000000000a1' };
const SCOPE_B: TenantScope = { workspaceId: 'ws_b', tenantGroupId: '018f9c10-0000-7000-8000-0000000000b1' };

let prisma: PrismaClient;

function createReq(cookie: string, name: string): Request {
  return new Request('http://t/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `lumitra_session=${cookie}` },
    body: JSON.stringify({ name }),
  });
}

// The route provisions each company's commerce schema before writing its site
// row, on the OWNER connection. In this harness DATABASE_URL is the container
// superuser, which plays the owner here (roles.itest.ts covers the real
// non-superuser owner).
const savedOwnerUrl = process.env.COMMERCE_OWNER_DATABASE_URL;

beforeAll(async () => {
  prisma = getPrismaClient();
  process.env.COMMERCE_OWNER_DATABASE_URL = process.env.DATABASE_URL;
}, 120_000);

afterAll(async () => {
  if (savedOwnerUrl === undefined) delete process.env.COMMERCE_OWNER_DATABASE_URL;
  else process.env.COMMERCE_OWNER_DATABASE_URL = savedOwnerUrl;
  await prisma.$disconnect();
});

describe('POST /api/projects (integration) — cross-workspace isolation', () => {
  it('creates draft rows in different workspaces that the other scope cannot load', async () => {
    // Session A and session B each create a fresh draft.
    const resA = await POST(createReq('sess_a', 'A site'));
    const resB = await POST(createReq('sess_b', 'B site'));
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    const { siteId: siteA } = await resA.json();
    const { siteId: siteB } = await resB.json();
    expect(siteA).not.toBe(siteB);

    const repo = getSiteRepository();

    // Each scope loads its OWN site: a draft with exactly one home page.
    const ownA = await repo.loadProject(SCOPE_A, siteA);
    expect(ownA.id).toBe(siteA);
    expect(ownA.pagesArray).toHaveLength(1);
    expect(ownA.pagesArray[0].slug).toBe('');

    const ownB = await repo.loadProject(SCOPE_B, siteB);
    expect(ownB.id).toBe(siteB);

    // The created rows default to `draft` status (saveProject create-path omits it).
    const rowA = await prisma.site.findUnique({
      where: { id: siteA },
      select: { status: true, workspaceId: true, tenantGroupId: true },
    });
    expect(rowA).toMatchObject({
      status: 'draft',
      workspaceId: 'ws_a',
      tenantGroupId: SCOPE_A.tenantGroupId,
    });

    // Cross-workspace loads are invisible: each is a SiteNotFoundError, never
    // the other tenant's data.
    await expect(repo.loadProject(SCOPE_B, siteA)).rejects.toBeInstanceOf(
      SiteNotFoundError,
    );
    await expect(repo.loadProject(SCOPE_A, siteB)).rejects.toBeInstanceOf(
      SiteNotFoundError,
    );

    // Each company got its commerce schema, provisioned and active.
    const groups = await prisma.$queryRaw<{ id: string; status: string }[]>`
      SELECT id::text AS id, status FROM public.tenant_groups
      WHERE id IN (${SCOPE_A.tenantGroupId}::uuid, ${SCOPE_B.tenantGroupId}::uuid)
      ORDER BY id
    `;
    expect(groups).toEqual([
      { id: SCOPE_A.tenantGroupId, status: 'active' },
      { id: SCOPE_B.tenantGroupId, status: 'active' },
    ]);
  });

  it('without the owner URL: 500 commerce_not_configured and no site row is written', async () => {
    const before = await prisma.site.count({ where: { workspaceId: 'ws_a' } });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.COMMERCE_OWNER_DATABASE_URL;
    try {
      const res = await POST(createReq('sess_a', 'never written'));
      expect(res.status).toBe(500);
      expect((await res.json()).error.code).toBe('commerce_not_configured');
    } finally {
      process.env.COMMERCE_OWNER_DATABASE_URL = process.env.DATABASE_URL;
      errorSpy.mockRestore();
    }
    expect(await prisma.site.count({ where: { workspaceId: 'ws_a' } })).toBe(before);
  });
});
