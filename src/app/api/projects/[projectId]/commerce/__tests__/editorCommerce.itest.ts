// src/app/api/projects/[projectId]/commerce/__tests__/editorCommerce.itest.ts
//
// Integration test (Dockerized Postgres) for the EDITOR's authorized commerce
// reads, /api/projects/<projectId>/commerce/* (CM-10 follow-up). It runs on the
// shared integration database (storefrontFixtures.ts): two freshly provisioned
// tenant groups TG_A and TG_B, each with its own product and its own project
// (site row) in its own workspace, plus a project whose site carries a legacy
// non-UUID tenant group. The REAL route handlers run against the real site
// lookup and the real scoped Kysely handle (as commerce_app); only the
// auth-brain boundary is faked (the session verify and the OpenFGA access
// check), since auth-brain is a separate service.
//
// Proofs:
//   1. a signed-in member of project A's workspace sees project A's products,
//      and the detail + inventory reads work on the editor host,
//   2. a user without access to the project's workspace gets 403 (and an
//      unknown project the same 403); no session is a 401,
//   3. a project whose site has no valid tenant group gets 404
//      commerce_not_provisioned,
//   4. two tenants: project A in the editor never sees tenant B's products, even
//      when asked for B's handle or B's stock pair,
//   5. on a published storefront host the editor route is refused (404) even
//      with a valid session (D2), while the editor host still works.
//
// The `.itest.ts` suffix keeps this file OUT of the headless `pnpm test` gate.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SessionVerifyResponse } from '@marlinjai/auth-brain-sdk';

vi.mock('@/lib/auth-api', () => ({ getVerifiedSession: vi.fn() }));
vi.mock('@/lib/auth-check', () => ({ checkWorkspaceAccess: vi.fn() }));

import { getVerifiedSession } from '@/lib/auth-api';
import { checkWorkspaceAccess } from '@/lib/auth-check';
import {
  createPublishedSite,
  openStorefrontFixtures,
  provisionCommerceTenant,
  seedBuyableProduct,
  type ProvisionedTenant,
  type SeededProduct,
  type StorefrontFixtures,
} from '@/server/commerce/__tests__/storefrontFixtures';
import { GET as productsGET } from '../products/route';
import { GET as productGET } from '../products/[handle]/route';
import { GET as inventoryGET } from '../inventory/route';

const sessionMock = vi.mocked(getVerifiedSession);
const accessMock = vi.mocked(checkWorkspaceAccess);

let fx: StorefrontFixtures;
let tgA: ProvisionedTenant;
let tgB: ProvisionedTenant;
let projectA: { siteId: string; workspaceId: string };
let projectB: { siteId: string; workspaceId: string };
let projectUnprovisioned: { siteId: string; workspaceId: string };
let productA: SeededProduct;
let productB: SeededProduct;

/** A verified session for a member of exactly one workspace in one tenant group. */
function memberOf(workspaceId: string, groupId: string): SessionVerifyResponse {
  return {
    user: { id: `user-${workspaceId}` },
    workspaces: [{ id: workspaceId, tenant_id: `tenant-${workspaceId}` }],
    tenants: [{ id: `tenant-${workspaceId}`, app_grants: ['sites'], group_id: groupId }],
    active_workspace: { id: workspaceId },
  } as unknown as SessionVerifyResponse;
}

/** An editor-host request (localhost in dev): the host carries no tenant. */
function editorReq(path: string): Request {
  return new Request(`http://localhost:3000${path}`, {
    headers: { host: 'localhost:3000', cookie: 'lumitra_session=faked' },
  });
}

async function listHandles(projectId: string): Promise<{ status: number; handles: string[] }> {
  const res = await productsGET(editorReq(`/api/projects/${projectId}/commerce/products?limit=100`), {
    params: Promise.resolve({ projectId }),
  });
  if (res.status !== 200) return { status: res.status, handles: [] };
  const body = (await res.json()) as { products: Array<{ handle: string }> };
  return { status: 200, handles: body.products.map((p) => p.handle) };
}

beforeAll(async () => {
  fx = openStorefrontFixtures();
  tgA = await provisionCommerceTenant(fx, 'cm10-editor-a');
  tgB = await provisionCommerceTenant(fx, 'cm10-editor-b');
  productA = await seedBuyableProduct(tgA.db, {
    title: 'EDITOR_A',
    handle: `editor-a-${randomUUID().slice(0, 8)}`,
    amountCents: 1500,
    stocked: 4,
  });
  productB = await seedBuyableProduct(tgB.db, {
    title: 'EDITOR_B',
    handle: `editor-b-${randomUUID().slice(0, 8)}`,
    amountCents: 2500,
    stocked: 9,
  });
  projectA = await createPublishedSite(fx, tgA.tgId, 'cm10-editor-a');
  projectB = await createPublishedSite(fx, tgB.tgId, 'cm10-editor-b');
  projectUnprovisioned = await createPublishedSite(fx, 'legacy-tenant-group', 'cm10-editor-x');
}, 180_000);

afterAll(async () => {
  await fx?.close();
});

afterEach(() => {
  delete process.env.EDITOR_HOST;
});

beforeEach(() => {
  sessionMock.mockReset();
  accessMock.mockReset();
  // auth-brain's OpenFGA check, faked: a user may view exactly the workspace
  // their session is a member of.
  accessMock.mockImplementation(async (userId, workspaceId) => userId === `user-${workspaceId}`);
});

describe('editor commerce reads: /api/projects/<id>/commerce/*', () => {
  it("a signed-in member sees their project's products, detail and stock", async () => {
    sessionMock.mockResolvedValue(memberOf(projectA.workspaceId, tgA.tgId));

    expect(await listHandles(projectA.siteId)).toEqual({ status: 200, handles: [productA.handle] });

    const detail = await productGET(
      editorReq(`/api/projects/${projectA.siteId}/commerce/products/${productA.handle}`),
      { params: Promise.resolve({ projectId: projectA.siteId, handle: productA.handle }) },
    );
    expect(detail.status).toBe(200);
    expect((await detail.json()).variants[0].resolvedPriceCents).toBe(1500);

    const stock = await inventoryGET(
      editorReq(
        `/api/projects/${projectA.siteId}/commerce/inventory?variantId=${productA.inventoryItemId}&locationId=${productA.locationId}`,
      ),
      { params: Promise.resolve({ projectId: projectA.siteId }) },
    );
    expect(stock.status).toBe(200);
    expect((await stock.json()).availableQuantity).toBe(4);
  });

  it('a user without access to the project gets 403; an unknown project the same 403; no session 401', async () => {
    // Member of B, asking for A.
    sessionMock.mockResolvedValue(memberOf(projectB.workspaceId, tgB.tgId));
    expect((await listHandles(projectA.siteId)).status).toBe(403);
    expect((await listHandles(`missing-${randomUUID()}`)).status).toBe(403);

    // Listed in A's workspace by the session, but OpenFGA denies viewSite.
    sessionMock.mockResolvedValue(memberOf(projectA.workspaceId, tgA.tgId));
    accessMock.mockResolvedValue(false);
    expect((await listHandles(projectA.siteId)).status).toBe(403);

    sessionMock.mockResolvedValue(null);
    expect((await listHandles(projectA.siteId)).status).toBe(401);
  });

  it('a project whose site has no valid tenant group gets 404 commerce_not_provisioned', async () => {
    sessionMock.mockResolvedValue(memberOf(projectUnprovisioned.workspaceId, tgA.tgId));
    const res = await productsGET(
      editorReq(`/api/projects/${projectUnprovisioned.siteId}/commerce/products`),
      { params: Promise.resolve({ projectId: projectUnprovisioned.siteId }) },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('commerce_not_provisioned');
  });

  it("two tenants: project A in the editor never sees tenant B's products", async () => {
    sessionMock.mockResolvedValue(memberOf(projectA.workspaceId, tgA.tgId));
    const a = await listHandles(projectA.siteId);
    expect(a.handles).toContain(productA.handle);
    expect(a.handles).not.toContain(productB.handle);

    const crossDetail = await productGET(
      editorReq(`/api/projects/${projectA.siteId}/commerce/products/${productB.handle}`),
      { params: Promise.resolve({ projectId: projectA.siteId, handle: productB.handle }) },
    );
    expect(crossDetail.status).toBe(404);

    const crossStock = await inventoryGET(
      editorReq(
        `/api/projects/${projectA.siteId}/commerce/inventory?variantId=${productB.inventoryItemId}&locationId=${productB.locationId}`,
      ),
      { params: Promise.resolve({ projectId: projectA.siteId }) },
    );
    expect(crossStock.status).toBe(404);

    // And symmetric: a member of B sees exactly B's catalog.
    sessionMock.mockResolvedValue(memberOf(projectB.workspaceId, tgB.tgId));
    expect(await listHandles(projectB.siteId)).toEqual({ status: 200, handles: [productB.handle] });
  });

  it('is refused (404) on a published storefront host even with a valid session; the editor host still works', async () => {
    process.env.EDITOR_HOST = 'app.lumitra.co';
    sessionMock.mockResolvedValue(memberOf(projectA.workspaceId, tgA.tgId));

    const onStorefront = await productsGET(
      new Request(`https://acme.sites.lumitra.co/api/projects/${projectA.siteId}/commerce/products`, {
        headers: { host: 'acme.sites.lumitra.co', cookie: 'lumitra_session=valid' },
      }),
      { params: Promise.resolve({ projectId: projectA.siteId }) },
    );
    expect(onStorefront.status).toBe(404);
    expect((await onStorefront.json()).error.code).toBe('not_found');
    expect(sessionMock).not.toHaveBeenCalled();

    const onEditor = await productsGET(
      new Request(`https://app.lumitra.co/api/projects/${projectA.siteId}/commerce/products`, {
        headers: { host: 'app.lumitra.co', cookie: 'lumitra_session=valid' },
      }),
      { params: Promise.resolve({ projectId: projectA.siteId }) },
    );
    expect(onEditor.status).toBe(200);
  });
});

