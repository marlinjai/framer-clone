// src/app/api/catalog/__tests__/catalog-routes.itest.ts
//
// The catalogue's API (src/app/api/catalog) through the REAL route handlers,
// against a real provisioned tenant schema (the repository connected as
// commerce_app). Only the auth-brain client (session and permission), the
// tenant handle factory (pointed at the test schema) and the site list (the
// company's sites, a Prisma table) are replaced. Proven here:
//
//   - the guard: the editor host only, a session, the `sites` grant (through
//     the active company), viewSite for reads and editSite for writes;
//   - the typed errors: 422 invalid input, 409 duplicate handle, 404 for
//     another company's id (never 403), 415 and 413 for images;
//   - the flow through HTTP: create, options and matrix, inline price and
//     stock, archive and unarchive (re-entry), a failed save followed by a
//     reload showing the stored state (resume), images with their ETag,
//     collections, sites, samples, and the empty list.
// All data is synthetic.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  db: null as unknown,
  session: null as unknown,
  allowed: new Set<string>(['viewSite', 'editSite']),
  sites: [] as Array<{ siteId: string; name: string }>,
  /** The company's tenant schema is not provisioned. */
  notProvisioned: false,
}));

vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    verifySession: async () => state.session,
    can: async () => true,
  },
}));
vi.mock('@/lib/auth-check', () => ({
  checkWorkspaceAccess: async (_user: string, _workspace: string, action: string) => state.allowed.has(action),
}));
vi.mock('@/server/commerce/db', () => ({
  commerceTenantDbChecked: async () => {
    if (state.notProvisioned) throw Object.assign(new Error('synthetic: no tenant schema'), { notProvisioned: true });
    return state.db;
  },
  isCommerceTenantNotProvisioned: (err: unknown) => Boolean((err as { notProvisioned?: boolean }).notProvisioned),
}));
vi.mock('@/server/sites', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/sites')>()),
  getSiteRepository: () => ({ listSites: async () => state.sites }),
}));

import { newTenantId, openBooksEnv, type BooksEnv } from '@/server/books/__tests__/booksFixtures';
import { png } from '@/server/catalog/__tests__/imageFixtures';

import * as productsRoute from '../products/route';
import * as productRoute from '../products/[id]/route';
import * as bulkRoute from '../products/bulk/route';
import * as samplesRoute from '../products/samples/route';
import * as optionsRoute from '../products/[id]/options/route';
import * as variantRoute from '../products/[id]/variants/[variantId]/route';
import * as stockRoute from '../products/[id]/variants/[variantId]/stock/route';
import * as productImagesRoute from '../products/[id]/images/route';
import * as productImageRoute from '../products/[id]/images/[imageId]/route';
import * as productCollectionsRoute from '../products/[id]/collections/route';
import * as productSitesRoute from '../products/[id]/sites/route';
import * as imagesRoute from '../images/route';
import * as imageRoute from '../images/[sha256]/route';
import * as collectionsRoute from '../collections/route';
import * as collectionRoute from '../collections/[id]/route';
import * as collectionProductsRoute from '../collections/[id]/products/route';
import * as metaRoute from '../meta/route';

let env: BooksEnv;

beforeAll(async () => {
  env = await openBooksEnv('catalog-routes');
  state.db = env.appDb;
}, 120_000);

afterAll(async () => {
  await env?.close();
});

function activate(id: string, grants: string[] = ['sites']) {
  state.session = {
    user: { id: 'user-catalog' },
    session: {},
    tenants: [{ id, app_grants: grants, group_id: env.tgId, name: 'Example', slug: 'example' }],
    workspaces: [{ id: `ws-${id}`, tenant_id: id, name: 'Main', slug: 'main' }],
    active_tenant: { id },
    active_workspace: null,
  };
}

beforeEach(() => {
  state.allowed = new Set(['viewSite', 'editSite']);
  state.notProvisioned = false;
  state.sites = [
    { siteId: 'site-shop', name: 'Shop' },
    { siteId: 'site-popup', name: 'Pop-up' },
  ];
  activate(newTenantId());
});

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Handler = (req: Request, route: { params: Promise<any> }) => Promise<Response>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(
  handler: Handler,
  method: string,
  path: string,
  params: Record<string, string> = {},
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Json; res: Response }> {
  const raw = body instanceof Uint8Array;
  const req = new Request(`http://localhost:3000${path.startsWith("/") ? path : "/api/catalog"}`, {
    method,
    headers: {
      host: 'localhost:3000',
      cookie: 'lumitra_session=s',
      'content-type': raw ? 'application/octet-stream' : 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : raw ? Buffer.from(body) : JSON.stringify(body),
  });
  const res = await handler(req, { params: Promise.resolve(params) });
  const text = await res.clone().text();
  let json: Json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  return { status: res.status, json, res };
}

async function create(title: string, extra: Json = {}): Promise<Json> {
  const r = await call(productsRoute.POST, 'POST', '/api/catalog/products', {}, { title, ...extra });
  expect(r.status).toBe(201);
  return r.json;
}

describe('the guard', () => {
  it('refuses a published host, a missing session, a company without sites, and the wrong permission', async () => {
    const onShop = new Request('http://shop.example.com/api/catalog/products', { headers: { host: 'shop.example.com', cookie: 'lumitra_session=s' } });
    process.env.EDITOR_HOST = 'app.example.test';
    try {
      expect((await productsRoute.GET(onShop, { params: Promise.resolve({}) })).status).toBe(404);
    } finally {
      delete process.env.EDITOR_HOST;
    }

    state.session = null;
    expect((await call(productsRoute.GET, 'GET', '/api/catalog/products')).status).toBe(401);

    activate(newTenantId(), ['books']);
    const noSites = await call(productsRoute.GET, 'GET', '/api/catalog/products');
    expect([noSites.status, noSites.json.error.code]).toEqual([403, 'sites_not_enabled']);

    activate(newTenantId());
    state.allowed = new Set(['viewSite']);
    expect((await call(productsRoute.GET, 'GET', '/api/catalog/products')).status).toBe(200);
    const write = await call(productsRoute.POST, 'POST', '/api/catalog/products', {}, { title: 'Ring' });
    expect([write.status, write.json.error.code]).toEqual([403, 'forbidden']);
    state.allowed = new Set();
    expect((await call(productsRoute.GET, 'GET', '/api/catalog/products')).status).toBe(403);

    state.allowed = new Set(['viewSite', 'editSite']);
    state.notProvisioned = true;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const missing = await call(productsRoute.GET, 'GET', '/api/catalog/products');
    expect([missing.status, missing.json.error.code]).toEqual([404, 'catalog_not_provisioned']);
  });
});

describe('products through HTTP', () => {
  it('the empty state, then forward, backtrack, resume and re-entry', async () => {
    const empty = await call(productsRoute.GET, 'GET', '/api/catalog/products');
    expect(empty.json).toEqual({ items: [], total: 0, nextCursor: null });

    // Forward.
    const ring = await create('Signet ring', { price: 9900 });
    const opts = await call(optionsRoute.PUT, 'PUT', `/api/catalog/products/${ring.id}/options`, { id: ring.id }, {
      options: [{ title: 'Size', values: [{ value: '52' }, { value: '54' }] }],
    });
    expect(opts.status).toBe(200);
    expect(opts.json.variants.map((v: Json) => v.title)).toEqual(['52', '54']);
    const v54 = opts.json.variants[1];
    const stocked = await call(stockRoute.PUT, 'PUT', 'x', { id: ring.id, variantId: v54.id }, { available: 6 });
    expect(stocked.json.variants[1].stock).toBe(6);
    const priced = await call(variantRoute.PATCH, 'PATCH', 'x', { id: ring.id, variantId: v54.id }, { price: 11900 });
    expect(priced.json.variants[1].price).toBe(11900);

    // Backtrack and revise: rename 54 to 54 mm and drop 52; the kept variant keeps price and stock.
    const size = opts.json.options[0];
    const revised = await call(optionsRoute.PUT, 'PUT', 'x', { id: ring.id }, {
      options: [{ id: size.id, title: 'Size', values: [{ id: size.values[1].id, value: '54 mm' }] }],
    });
    expect(revised.json.variants).toEqual([expect.objectContaining({ id: v54.id, title: '54 mm', price: 11900, stock: 6 })]);
    const four = await call(optionsRoute.PUT, 'PUT', 'x', { id: ring.id }, {
      options: ['A', 'B', 'C', 'D'].map((t) => ({ title: t, values: [{ value: 'x' }] })),
    });
    expect([four.status, four.json.error.code]).toEqual([422, 'invalid_input']);

    // A failed save (a handle another product has) changes nothing; the reload (resume) shows the stored state.
    const other = await create('Chain');
    const dup = await call(productRoute.PATCH, 'PATCH', 'x', { id: ring.id }, { handle: other.handle });
    expect([dup.status, dup.json.error.code]).toEqual([409, 'duplicate_handle']);
    const bad = await call(productRoute.PATCH, 'PATCH', 'x', { id: ring.id }, { title: '' });
    expect([bad.status, bad.json.error.code, bad.json.error.message]).toEqual([422, 'invalid_input', 'enter a title']);
    const reloaded = await call(productRoute.GET, 'GET', 'x', { id: ring.id });
    expect(reloaded.json).toMatchObject({ title: 'Signet ring', handle: 'signet-ring', variants: [{ id: v54.id, stock: 6 }] });

    // Formatted description, tags, search engine fields.
    const described = await call(productRoute.PATCH, 'PATCH', 'x', { id: ring.id }, {
      descriptionFormat: { v: 1, blocks: [{ kind: 'paragraph', runs: [{ text: 'Solid ' }, { text: 'gold', bold: true }] }] },
    });
    expect(described.json).toMatchObject({ description: 'Solid gold', descriptionFormat: { v: 1 } });
    const tagged = await call(productRoute.PATCH, 'PATCH', 'x', { id: ring.id }, { tags: ['gold', 'Gold', 'signet'], seoTitle: 'Signet ring in gold' });
    expect(tagged.json.tags).toEqual(['gold', 'signet']);

    // Re-entry: archive, the list leaves it out, unarchive brings it back as it was.
    expect((await call(productRoute.PATCH, 'PATCH', 'x', { id: ring.id }, { archived: true })).json.status).toBe('archived');
    expect((await call(productsRoute.GET, 'GET', '/api/catalog/products')).json.items.map((i: Json) => i.id)).toEqual([other.id]);
    expect((await call(productsRoute.GET, 'GET', '/api/catalog/products?status=archived')).json.items.map((i: Json) => i.id)).toEqual([ring.id]);
    const back = await call(productRoute.PATCH, 'PATCH', 'x', { id: ring.id }, { archived: false });
    expect(back.json).toMatchObject({ status: 'draft', variants: [{ id: v54.id, price: 11900, stock: 6 }] });

    // Inline edits of a one-variant product, and the list's figures.
    const chainVariant = other.variants[0].id;
    expect((await call(productRoute.PATCH, 'PATCH', 'x', { id: other.id }, { price: 2500 })).status).toBe(200);
    expect((await call(stockRoute.PUT, 'PUT', 'x', { id: other.id, variantId: chainVariant }, { available: 3 })).status).toBe(200);
    expect((await call(productRoute.PATCH, 'PATCH', 'x', { id: other.id }, { status: 'published' })).json.status).toBe('published');
    const list = await call(productsRoute.GET, 'GET', '/api/catalog/products?sort=price&dir=desc');
    expect(list.json.items.map((i: Json) => [i.title, i.priceMin, i.stock])).toEqual([
      ['Signet ring', 11900, 6],
      ['Chain', 2500, 3],
    ]);
    expect(list.json.items[1].single).toMatchObject({ id: chainVariant, price: 2500, stock: 3 });
    expect((await call(productsRoute.GET, 'GET', '/api/catalog/products?sort=sideways')).status).toBe(422);
    expect((await call(productsRoute.GET, 'GET', '/api/catalog/products?stock=in_stock&q=chain')).json.total).toBe(1);

    // Bulk.
    const bulk = await call(bulkRoute.POST, 'POST', 'x', {}, { action: 'archive', ids: [ring.id, other.id] });
    expect(bulk.json).toEqual({ changed: 2 });
    expect((await call(productsRoute.GET, 'GET', '/api/catalog/products')).json.total).toBe(0);
    expect((await call(bulkRoute.POST, 'POST', 'x', {}, { action: 'explode', ids: [ring.id] })).status).toBe(422);
  });

  it("another company's product answers 404 on every route, never 403", async () => {
    const theirs = await create('Their ring');
    activate(newTenantId());
    const id = theirs.id;
    const variantId = theirs.variants[0].id;
    const answers = await Promise.all([
      call(productRoute.GET, 'GET', 'x', { id }),
      call(productRoute.PATCH, 'PATCH', 'x', { id }, { title: 'Mine' }),
      call(productRoute.PATCH, 'PATCH', 'x', { id }, { archived: true }),
      call(optionsRoute.PUT, 'PUT', 'x', { id }, { options: [] }),
      call(variantRoute.PATCH, 'PATCH', 'x', { id, variantId }, { price: 1 }),
      call(stockRoute.PUT, 'PUT', 'x', { id, variantId }, { available: 1 }),
      call(productImagesRoute.POST, 'POST', 'x', { id }, png(2, 2)),
      call(productCollectionsRoute.PUT, 'PUT', 'x', { id }, { collectionIds: [] }),
      call(productSitesRoute.PUT, 'PUT', 'x', { id }, { hiddenSiteIds: [] }),
      call(bulkRoute.POST, 'POST', 'x', {}, { action: 'archive', ids: [id] }),
    ]);
    expect(answers.map((a) => a.status)).toEqual(Array(answers.length).fill(404));
    expect(answers[0].json.error.code).toBe('not_found');
  });
});

describe('images, collections, sites, samples', () => {
  it('uploads, serves with the hash as ETag, reorders and removes images', async () => {
    const p = await create('Cuff');
    const first = await call(productImagesRoute.POST, 'POST', 'x', { id: p.id }, png(3, 3, [10, 20, 30]));
    expect(first.status).toBe(201);
    const second = await call(productImagesRoute.POST, 'POST', 'x', { id: p.id }, png(5, 4));
    const [a, b] = second.json.images;
    const served = await call(imageRoute.GET, 'GET', 'x', { sha256: a.sha256 });
    expect(served.status).toBe(200);
    expect(served.res.headers.get('etag')).toBe(`"${a.sha256}"`);
    expect(served.res.headers.get('content-type')).toBe('image/png');
    expect((await call(imageRoute.GET, 'GET', 'x', { sha256: a.sha256 }, undefined, { 'if-none-match': `"${a.sha256}"` })).status).toBe(304);
    expect((await call(imageRoute.GET, 'GET', 'x', { sha256: 'nope' })).status).toBe(404);

    const reordered = await call(productImagesRoute.PUT, 'PUT', 'x', { id: p.id }, { imageIds: [b.id, a.id] });
    expect(reordered.json.images.map((i: Json) => i.id)).toEqual([b.id, a.id]);
    const alt = await call(productImageRoute.PATCH, 'PATCH', 'x', { id: p.id, imageId: b.id }, { alt: 'The cuff from above' });
    expect(alt.json.images[0].alt).toBe('The cuff from above');
    const removed = await call(productImageRoute.DELETE, 'DELETE', 'x', { id: p.id, imageId: b.id });
    expect(removed.json.images.map((i: Json) => i.id)).toEqual([a.id]);

    const svg = await call(productImagesRoute.POST, 'POST', 'x', { id: p.id }, new TextEncoder().encode('<svg/>'));
    expect([svg.status, svg.json.error.code]).toEqual([415, 'unsupported_image_type']);
    const huge = await call(productImagesRoute.POST, 'POST', 'x', { id: p.id }, new Uint8Array(2 * 1024 * 1024 + 10));
    expect(huge.status).toBe(413);

    // Another company cannot read the image.
    activate(newTenantId());
    expect((await call(imageRoute.GET, 'GET', 'x', { sha256: a.sha256 })).status).toBe(404);
    expect((await call(imageRoute.GET, 'GET', 'x', { sha256: a.sha256 }, undefined, { 'if-none-match': `"${a.sha256}"` })).status).toBe(404);
  });

  it('collections with ordered products, a collection image, sites and samples', async () => {
    const a = await create('Anklet');
    const b = await create('Brooch');
    const col = await call(collectionsRoute.POST, 'POST', 'x', {}, { title: 'Summer' });
    expect(col.status).toBe(201);
    const ordered = await call(collectionProductsRoute.PUT, 'PUT', 'x', { id: col.json.id }, { productIds: [b.id, a.id] });
    expect(ordered.json.products.map((p: Json) => p.title)).toEqual(['Brooch', 'Anklet']);
    const img = await call(imagesRoute.POST, 'POST', 'x', {}, png(6, 6));
    expect(img.status).toBe(201);
    const withImage = await call(collectionRoute.PATCH, 'PATCH', 'x', { id: col.json.id }, { imageSha256: img.json.sha256, description: 'Light pieces' });
    expect(withImage.json).toMatchObject({ image: { sha256: img.json.sha256 }, description: 'Light pieces' });
    expect((await call(collectionsRoute.GET, 'GET', '/api/catalog/collections')).json.items.map((c: Json) => c.productCount)).toEqual([2]);
    const left = await call(productCollectionsRoute.PUT, 'PUT', 'x', { id: a.id }, { collectionIds: [] });
    expect(left.json.collections).toEqual([]);
    const dupCollection = await call(collectionsRoute.POST, 'POST', 'x', {}, { title: '' });
    expect(dupCollection.status).toBe(422);

    const meta = await call(metaRoute.GET, 'GET', 'x');
    expect(meta.json.sites).toEqual([
      { id: 'site-shop', name: 'Shop' },
      { id: 'site-popup', name: 'Pop-up' },
    ]);
    const hidden = await call(productSitesRoute.PUT, 'PUT', 'x', { id: b.id }, { hiddenSiteIds: ['site-popup'] });
    expect(hidden.json.hiddenSiteIds).toEqual(['site-popup']);
    const foreign = await call(productSitesRoute.PUT, 'PUT', 'x', { id: b.id }, { hiddenSiteIds: ['site-of-someone-else'] });
    expect([foreign.status, foreign.json.error.code]).toEqual([404, 'unknown_site']);

    const samples = await call(samplesRoute.POST, 'POST', 'x');
    expect(samples.json.items.map((p: Json) => p.title)).toEqual(['Stacking ring', 'Pearl necklace', 'Ring sizing']);
    const again = await call(samplesRoute.POST, 'POST', 'x');
    expect(again.json.items.map((p: Json) => p.id)).toEqual(samples.json.items.map((p: Json) => p.id));
  });

  it('answers 400 for a body that is not JSON', async () => {
    const req = new Request('http://localhost:3000/api/catalog/products', {
      method: 'POST',
      headers: { host: 'localhost:3000', cookie: 'lumitra_session=s', 'content-type': 'application/json' },
      body: '{nope',
    });
    expect((await productsRoute.POST(req, { params: Promise.resolve({}) })).status).toBe(400);
  });
});
