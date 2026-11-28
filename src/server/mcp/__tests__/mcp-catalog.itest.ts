// src/server/mcp/__tests__/mcp-catalog.itest.ts
//
// The catalogue read tools of the MCP endpoint (plan docs/plans/2026-11-27-agent-catalogue-tools.md, slice 1)
// against a REAL Postgres, through the REAL route (src/app/api/mcp/route.ts), the REAL key verification
// (verifyCompanyKey, including its site-row check) and two REAL provisioned shop schemas, read as the
// low-privilege commerce role. Only the outside services are mocked: auth-brain's verifyApiKey, the OpenFGA
// company-structure read, Next's cache, the shop provisioning on create_site, and the tenant handle factory,
// which answers each tenant group's OWN schema (and "not provisioned" for any other), so a cross-group read
// cannot pass by landing in the same schema.
//
// Proven here:
//   - forward: products made through the editor's repository (options, variants, prices, stock) read back
//     through list_products and get_product for a site of the key's company, filters and paging included;
//   - a product switched off for the site is neither listed nor readable there, and is on the other site;
//   - a branch id reads its main site's catalogue;
//   - another company of the SAME tenant group (same schema) sees none of it: its own site lists nothing,
//     and naming company A's site or product answers site_not_found / not_found;
//   - a company of ANOTHER tenant group (its own schema) likewise;
//   - a key whose company role is `member` gets forbidden on both tools;
//   - an unprovisioned shop schema answers catalog_not_provisioned.
// All data is synthetic. Runs only under `pnpm test:integration` (Docker Postgres).

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const fakeCredential = (prefix: string) => `${prefix}_${randomBytes(16).toString('hex')}`;
const fakeKey = () => fakeCredential(['sk', 'live'].join('_'));

const state = vi.hoisted(() => ({
  /** company id -> its tenant groups and workspaces (the OpenFGA structure read). */
  structure: {} as Record<string, { groupIds: string[]; workspaceIds: string[] }>,
  /** presented key -> what auth-brain answers for it. */
  keys: {} as Record<string, unknown>,
  /** tenant group -> its commerce_app handle. */
  dbs: {} as Record<string, unknown>,
}));

vi.mock('@/lib/auth-brain-machine', () => ({
  machineAuthBrainClient: { verifyApiKey: vi.fn(async (key: string) => state.keys[key] ?? null) },
}));
vi.mock('@/lib/openfgaRead', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/openfgaRead')>();
  return { ...actual, readCompanyStructure: vi.fn(async (tenant: string) => state.structure[tenant] ?? { groupIds: [], workspaceIds: [] }) };
});
vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: { verifySession: vi.fn(async () => null), can: vi.fn(async () => true), verifyApiKey: vi.fn(), getCurrentUser: vi.fn() },
}));
vi.mock('next/cache', () => ({ unstable_cache: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/server/sites/companyCommerce', () => ({ ensureCompanyCommerce: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/server/commerce/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/commerce/db')>()),
  commerceTenantDbChecked: async (tgId: string) => {
    const db = state.dbs[tgId];
    if (!db) throw Object.assign(new Error(`synthetic: no shop schema for ${tgId}`), { notProvisioned: true });
    return db;
  },
  isCommerceTenantNotProvisioned: (err: unknown) => Boolean((err as { notProvisioned?: boolean }).notProvisioned),
}));

import { getPrismaClient } from '@/server/db';
import { clearKeyCache } from '@/lib/auth-machine';
import { POST } from '@/app/api/mcp/route';
import { newTenantId, openBooksEnv, provisionAnotherGroup, type BooksEnv } from '@/server/books/__tests__/booksFixtures';
import { createProduct, getProduct } from '@/server/catalog/repository/products';
import { setOptions, updateVariant } from '@/server/catalog/repository/variants';
import { setVariantStock } from '@/server/catalog/repository/stock';
import { setHiddenSites } from '@/server/catalog/repository/sites';
import { catalogScope } from '@/server/catalog/scope';
import { getSiteBranchRepository } from '@/server/sites/branches/repository';

let prisma: PrismaClient;
let env: BooksEnv;
let groupOne: string;
let groupTwo: string;
let nextId = 1;

const COMPANY_A = newTenantId();
const COMPANY_B = newTenantId(); // same tenant group as A
const COMPANY_C = newTenantId(); // its own tenant group
const COMPANY_D = newTenantId(); // a tenant group without a shop schema
const KEY_A = fakeKey();
const KEY_B = fakeKey();
const KEY_C = fakeKey();
const KEY_D = fakeKey();
const KEY_MEMBER = fakeKey();
const WS = { a: `mcpcat_ws_a_${randomBytes(3).toString('hex')}`, b: `mcpcat_ws_b_${randomBytes(3).toString('hex')}`, c: `mcpcat_ws_c_${randomBytes(3).toString('hex')}`, d: `mcpcat_ws_d_${randomBytes(3).toString('hex')}` };
let groupD: string;

function verified(tenant: string, keyId: string, role: string) {
  return {
    principal: { type: 'service_account', id: `sa-${keyId}`, scope: { type: 'tenant', id: tenant, slug: `slug-${keyId}`, app_grants: ['sites'] }, role },
    key: { id: keyId, name: 'catalogue agent', expires_at: null },
    effective_roles: { tenant_groups: [], tenants: [{ id: tenant, role, source: 'direct' }], workspaces: [] },
  };
}

function post(key: string, body: unknown): Request {
  return new Request('https://app.lumitra.co/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}

type Result = { isError: boolean; structuredContent: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function tool(key: string, name: string, args: Record<string, unknown>): Promise<Result> {
  const res = await POST(post(key, { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }));
  expect(res.status).toBe(200);
  return ((await res.json()) as { result: Result }).result;
}

async function ok(key: string, name: string, args: Record<string, unknown>) {
  const result = await tool(key, name, args);
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.structuredContent)}`);
  return result.structuredContent;
}

async function refusal(key: string, name: string, args: Record<string, unknown>) {
  const result = await tool(key, name, args);
  expect(result.isError).toBe(true);
  return result.structuredContent.error as { code: string; message: string };
}

let shopSite: string;
let popupSite: string;
let branchSite: string;
let siteOfB: string;
let siteOfC: string;
let ring: string;
let necklace: string;
let sizing: string;

beforeAll(async () => {
  prisma = getPrismaClient();
  vi.stubEnv('PUBLIC_SITE_BASE_HOST', 'sites.itest');
  env = await openBooksEnv('mcp-catalog');
  groupOne = env.tgId;
  const other = await provisionAnotherGroup(env, 'mcp-catalog-2');
  groupTwo = other.tgId;
  groupD = '018f9c10-0000-7000-8000-00000000ca7d'.replace('ca7d', randomBytes(2).toString('hex'));
  state.dbs[groupOne] = env.appDb;
  state.dbs[groupTwo] = other.appDb;
  state.structure[COMPANY_A] = { groupIds: [groupOne], workspaceIds: [WS.a] };
  state.structure[COMPANY_B] = { groupIds: [groupOne], workspaceIds: [WS.b] };
  state.structure[COMPANY_C] = { groupIds: [groupTwo], workspaceIds: [WS.c] };
  state.structure[COMPANY_D] = { groupIds: [groupD], workspaceIds: [WS.d] };
  state.keys[KEY_A] = verified(COMPANY_A, 'cat-key-a', 'admin');
  state.keys[KEY_B] = verified(COMPANY_B, 'cat-key-b', 'admin');
  state.keys[KEY_C] = verified(COMPANY_C, 'cat-key-c', 'admin');
  state.keys[KEY_D] = verified(COMPANY_D, 'cat-key-d', 'admin');
  state.keys[KEY_MEMBER] = verified(COMPANY_A, 'cat-key-member', 'member');

  // The sites, made as an agent makes them (the site rows carry their company).
  shopSite = String((await ok(KEY_A, 'create_site', { name: 'Shop' })).siteId);
  popupSite = String((await ok(KEY_A, 'create_site', { name: 'Pop-up' })).siteId);
  siteOfB = String((await ok(KEY_B, 'create_site', { name: 'B shop' })).siteId);
  siteOfC = String((await ok(KEY_C, 'create_site', { name: 'C shop' })).siteId);
  // A branch of the shop site, made by the branch repository (its id is a site id).
  const main = await prisma.site.findUniqueOrThrow({ where: { id: shopSite }, select: { workspaceId: true, tenantGroupId: true } });
  branchSite = (
    await getSiteBranchRepository().createBranch({ workspaceId: main.workspaceId, tenantGroupId: main.tenantGroupId }, shopSite, {
      name: 'Try',
      actor: { kind: 'key', id: 'cat-key-a' },
    })
  ).branch.branchId;

  // Company A's catalogue, through the editor's own repository functions.
  const a = catalogScope(env.appDb, groupOne, COMPANY_A);
  const r = await createProduct(a, { title: 'Silver Ring', price: 4900, status: 'published', productType: 'Rings' });
  ring = r.id;
  const withOptions = await setOptions(a, ring, [{ title: 'Size', values: [{ value: '52' }, { value: '54' }] }]);
  for (const v of withOptions.variants) {
    await updateVariant(a, ring, v.id, { price: 5200 });
    await setVariantStock(a, ring, v.id, 3);
  }
  necklace = (await createProduct(a, { title: 'Gold Necklace', price: 12900 })).id;
  await setHiddenSites(a, necklace, [popupSite], new Set([shopSite, popupSite]));
  sizing = (await createProduct(a, { title: 'Ring sizing', kind: 'service', price: 1500 })).id;
  // Company B (same schema) has a product of its own.
  await createProduct(catalogScope(env.appDb, groupOne, COMPANY_B), { title: 'B Bracelet', price: 2000 });
}, 180_000);

beforeEach(() => clearKeyCache());

afterAll(async () => {
  for (const group of [groupOne, groupTwo, groupD].filter(Boolean)) {
    await prisma.siteOperationAudit.deleteMany({ where: { tenantGroupId: group } });
    await prisma.siteBranch.deleteMany({ where: { tenantGroupId: group } });
    await prisma.siteDomain.deleteMany({ where: { tenantGroupId: group } });
    await prisma.site.deleteMany({ where: { tenantGroupId: group, branchOfSiteId: { not: null } } });
    await prisma.site.deleteMany({ where: { tenantGroupId: group } });
  }
  vi.unstubAllEnvs();
  await env?.close();
  await prisma.$disconnect();
});

describe('catalogue read tools through the MCP endpoint', () => {
  it('lists and reads the site catalogue: variants, prices in cents, stock, filters and paging', async () => {
    const all = await ok(KEY_A, 'list_products', { siteId: shopSite, sort: 'title' });
    expect(all.siteId).toBe(shopSite);
    expect(all.items.map((p: { title: string }) => p.title)).toEqual(['Gold Necklace', 'Ring sizing', 'Silver Ring']);
    expect(all.total).toBe(3);
    const ringRow = all.items.find((p: { id: string }) => p.id === ring);
    expect(ringRow).toMatchObject({ kind: 'physical', status: 'published', variantCount: 2, priceMin: 5200, priceMax: 5200, stock: 6, productType: 'Rings' });
    expect(ringRow).not.toHaveProperty('collections');

    expect((await ok(KEY_A, 'list_products', { siteId: shopSite, status: 'published' })).items.map((p: { id: string }) => p.id)).toEqual([ring]);
    expect((await ok(KEY_A, 'list_products', { siteId: shopSite, stock: 'untracked' })).items.map((p: { id: string }) => p.id)).toEqual([sizing]);
    expect((await ok(KEY_A, 'list_products', { siteId: shopSite, q: 'silver' })).items.map((p: { id: string }) => p.id)).toEqual([ring]);
    const first = await ok(KEY_A, 'list_products', { siteId: shopSite, sort: 'title', limit: 2 });
    expect(first.items).toHaveLength(2);
    const second = await ok(KEY_A, 'list_products', { siteId: shopSite, sort: 'title', limit: 2, cursor: first.nextCursor });
    expect(second.items.map((p: { title: string }) => p.title)).toEqual(['Silver Ring']);
    expect(second.nextCursor).toBeNull();

    const read = await ok(KEY_A, 'get_product', { siteId: shopSite, productId: ring });
    expect(read.product).toMatchObject({ id: ring, title: 'Silver Ring', taxClass: 'standard', options: [{ title: 'Size' }] });
    expect(read.product.variants).toHaveLength(2);
    for (const v of read.product.variants) expect(v).toMatchObject({ price: 5200, manageInventory: true, stock: 3 });
    expect(read.product).not.toHaveProperty('collections');
    expect(read.product).not.toHaveProperty('hiddenSiteIds');
    // It is what the editor's repository reads.
    const stored = await getProduct(catalogScope(env.appDb, groupOne, COMPANY_A), ring);
    expect(read.product.variants.map((v: { id: string }) => v.id)).toEqual(stored.variants.map((v) => v.id));

    const invalid = await refusal(KEY_A, 'list_products', { siteId: shopSite, cursor: 'not-a-cursor' });
    expect(invalid.code).toBe('invalid_input');
  });

  it('a product switched off for a site is neither listed nor readable there, and stays on the other site', async () => {
    const popup = await ok(KEY_A, 'list_products', { siteId: popupSite });
    expect(popup.items.map((p: { id: string }) => p.id).sort()).toEqual([ring, sizing].sort());
    expect(popup.total).toBe(2);
    expect(await refusal(KEY_A, 'get_product', { siteId: popupSite, productId: necklace })).toMatchObject({ code: 'not_found' });
    expect((await ok(KEY_A, 'get_product', { siteId: shopSite, productId: necklace })).product.title).toBe('Gold Necklace');
  });

  it('a branch id reads the catalogue of its main site', async () => {
    const viaBranch = await ok(KEY_A, 'list_products', { siteId: branchSite });
    expect(viaBranch.siteId).toBe(shopSite);
    expect(viaBranch.total).toBe(3);
  });

  it('another company of the same tenant group sees nothing of company A', async () => {
    const own = await ok(KEY_B, 'list_products', { siteId: siteOfB });
    expect(own.items.map((p: { title: string }) => p.title)).toEqual(['B Bracelet']);
    expect(await refusal(KEY_B, 'list_products', { siteId: shopSite })).toMatchObject({ code: 'site_not_found' });
    expect(await refusal(KEY_B, 'get_product', { siteId: shopSite, productId: ring })).toMatchObject({ code: 'site_not_found' });
    // Its own site, company A's product id: not found, exactly like an unknown id.
    expect(await refusal(KEY_B, 'get_product', { siteId: siteOfB, productId: ring })).toMatchObject({ code: 'not_found' });
    expect(await refusal(KEY_B, 'get_product', { siteId: siteOfB, productId: 'no-such-product' })).toMatchObject({ code: 'not_found' });
  });

  it('a company of another tenant group (its own schema) sees nothing of company A', async () => {
    expect((await ok(KEY_C, 'list_products', { siteId: siteOfC })).items).toEqual([]);
    expect(await refusal(KEY_C, 'list_products', { siteId: shopSite })).toMatchObject({ code: 'site_not_found' });
    expect(await refusal(KEY_C, 'get_product', { siteId: siteOfC, productId: ring })).toMatchObject({ code: 'not_found' });
  });

  it('a key whose company role is member may not read the catalogue', async () => {
    expect(await refusal(KEY_MEMBER, 'list_products', { siteId: shopSite })).toMatchObject({ code: 'forbidden' });
    expect(await refusal(KEY_MEMBER, 'get_product', { siteId: shopSite, productId: ring })).toMatchObject({ code: 'forbidden' });
  });

  it('a company whose shop schema is not provisioned gets catalog_not_provisioned', async () => {
    const site = String((await ok(KEY_D, 'create_site', { name: 'D shop' })).siteId);
    expect(await refusal(KEY_D, 'list_products', { siteId: site })).toMatchObject({ code: 'catalog_not_provisioned' });
  });
});
