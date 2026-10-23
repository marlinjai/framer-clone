// src/app/api/books/__tests__/books-products.itest.ts
//
// The product and service list (invoice editor plan, phase 4; migration
// 015_books_products) through the REAL route handlers, against a real
// provisioned tenant schema (the repository connected as commerce_app). Only
// the auth-brain client (session and permission), the tenant handle factory
// (pointed at the test schema) and the contacts database (a fake) are
// replaced. Proven here:
//
//   - the guard: reading needs viewBooks, every change editBooks;
//   - company scoping: another company's item answers 404 and never shows in
//     the list, and both companies may use the same name;
//   - a name is unique among the LIVE items, case and accents ignored, on
//     create, rename and restore; archiving frees it;
//   - the search: name and description, case and accents ignored, every word,
//     LIKE metacharacters taken literally; live first; paging with a cursor
//     that holds even when the row it ended on is renamed;
//   - a line filled from an item (lineFromProduct, through the real line
//     route) keeps its values when the item is changed and archived afterwards.
// All data is synthetic.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  db: null as unknown,
  session: null as unknown,
  directory: null as unknown,
  contactBook: null as unknown,
  /** The relations the user holds on the workspace. */
  allowed: new Set<string>(['viewBooks', 'editBooks']),
}));

vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    verifySession: async () => state.session,
    can: async () => true,
  },
}));
// The action each route asks for (viewBooks or editBooks; both map to one relation today,
// so the action itself is what proves reads and writes are guarded apart).
vi.mock('@/lib/auth-check', () => ({
  checkWorkspaceAccess: async (_user: string, _workspace: string, action: string) => state.allowed.has(action),
}));
vi.mock('@/server/commerce/db', () => ({
  commerceTenantDbChecked: async () => state.db,
  isCommerceTenantNotProvisioned: () => false,
}));
vi.mock('@/server/books/http/dependencies', () => ({
  booksDependencies: () => ({ recipients: state.directory, contactBook: state.contactBook }),
}));

import { lineFromProduct } from '@/lib/books/products';
import { listProducts, updateProduct } from '@/server/books/repository/products';
import {
  FakeContactBook,
  FakeDirectory,
  initCompany,
  newCustomer,
  newTenantId,
  openBooksEnv,
  scopeFor,
  type BooksEnv,
} from '@/server/books/__tests__/booksFixtures';

import * as productsRoute from '../products/route';
import * as productRoute from '../products/[id]/route';
import * as documentsRoute from '../documents/route';
import * as documentRoute from '../documents/[id]/route';
import * as linesRoute from '../documents/[id]/lines/route';
import * as documentCustomerRoute from '../documents/[id]/customer/route';

let env: BooksEnv;
let tenantId: string;
let dir: FakeDirectory;

beforeAll(async () => {
  env = await openBooksEnv('books-products');
  state.db = env.appDb;
}, 120_000);

afterAll(async () => {
  await env?.close();
});

/** Make `id` the active company (its own fake contacts). */
function activate(id: string) {
  tenantId = id;
  dir = new FakeDirectory();
  state.directory = dir;
  state.contactBook = new FakeContactBook(dir);
  state.session = {
    user: { id: 'user-books' },
    session: {},
    tenants: [{ id, app_grants: ['sites', 'books'], group_id: env.tgId, name: 'Example', slug: 'example' }],
    workspaces: [{ id: 'ws-books', tenant_id: id, name: 'Main', slug: 'main' }],
    active_tenant: { id },
    active_workspace: null,
  };
}

beforeEach(async () => {
  state.allowed = new Set(['viewBooks', 'editBooks']);
  activate(newTenantId());
  await initCompany(scopeFor(env.appDb, env.tgId, tenantId, dir), { taxStatus: 'regular' });
});

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(
  handler: (req: Request, route: { params: Promise<any> }) => Promise<Response>, // eslint-disable-line @typescript-eslint/no-explicit-any
  method: string,
  path: string,
  params: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const req = new Request(`http://localhost:3000${path}`, {
    method,
    headers: { host: 'localhost:3000', cookie: 'lumitra_session=s', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handler(req, { params: Promise.resolve(params) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

const api = {
  list: (query = '') => call(productsRoute.GET, 'GET', `/api/books/products${query}`),
  create: (body: unknown) => call(productsRoute.POST, 'POST', '/api/books/products', {}, body),
  get: (id: string) => call(productRoute.GET, 'GET', `/api/books/products/${id}`, { id }),
  patch: (id: string, body: unknown) => call(productRoute.PATCH, 'PATCH', `/api/books/products/${id}`, { id }, body),
  archive: (id: string) => call(productRoute.DELETE, 'DELETE', `/api/books/products/${id}`, { id }),
};

async function created(body: Json): Promise<Json> {
  const res = await api.create({ unitPrice: 8000, ...body });
  expect(res.status).toBe(201);
  return res.json;
}

const names = (res: { json: Json }) => (res.json.items as Json[]).map((i) => i.name);

describe('the guard', () => {
  it('reads with viewBooks, changes only with editBooks, nothing without either', async () => {
    const p = await created({ name: 'Beratung' });
    state.allowed = new Set(['viewBooks']);
    expect((await api.list()).status).toBe(200);
    expect((await api.get(p.id)).status).toBe(200);
    expect((await api.create({ name: 'Neu', unitPrice: 1 })).status).toBe(403);
    expect((await api.patch(p.id, { unitPrice: 1 })).status).toBe(403);
    expect((await api.archive(p.id)).status).toBe(403);
    state.allowed = new Set();
    expect((await api.list()).status).toBe(403);
    state.allowed = new Set(['viewBooks', 'editBooks']);
    expect((await api.get(p.id)).json).toMatchObject({ name: 'Beratung', unitPrice: 8000, archivedAt: null });
  });
});

describe('create, change, validation', () => {
  it('creates with defaults, answers the view without the folded columns, and refuses invalid values', async () => {
    const p = await created({ name: '  Beratung  ' });
    expect(p).toMatchObject({
      kind: 'service',
      name: 'Beratung',
      description: null,
      unitLabel: 'Stk',
      unitPrice: 8000,
      priceBasis: 'net',
      taxClass: 'standard',
      discountBp: 0,
      archivedAt: null,
    });
    expect(Object.keys(p).sort()).toEqual(
      ['archivedAt', 'createdAt', 'description', 'discountBp', 'id', 'kind', 'name', 'priceBasis', 'taxClass', 'unitLabel', 'unitPrice', 'updatedAt'].sort(),
    );

    const refused = async (body: Json) => {
      const res = await api.create({ name: 'X', unitPrice: 100, ...body });
      expect(res.status).toBe(400);
      return res.json.error;
    };
    expect((await refused({ unitPrice: -1 })).code).toBe('invalid_input');
    expect((await refused({ unitPrice: 2_147_483_648 })).code).toBe('invalid_input');
    expect((await refused({ unitPrice: 1.5 })).code).toBe('invalid_input');
    expect((await refused({ name: '   ' })).code).toBe('invalid_input');
    expect((await refused({ name: '́' })).code).toBe('invalid_input');
    expect((await refused({ name: 'x'.repeat(301) })).code).toBe('invalid_input');
    // The form's rule: a letter or digit, and a fold that fits the stored bound (never a 500).
    expect((await refused({ name: '-' })).code).toBe('invalid_input');
    expect((await refused({ name: 'ﷺ'.repeat(300) })).code).toBe('invalid_input');
    expect((await refused({ discountBp: 10001 })).code).toBe('invalid_input');
    expect((await refused({ kind: 'text' })).code).toBe('invalid_input');
    expect((await refused({ taxClass: 'luxury' })).code).toBe('invalid_input');
    expect((await refused({ unitLabel: 'x'.repeat(21) })).code).toBe('invalid_input');
    expect((await refused({ productId: 'smuggled' })).code).toBe('invalid_input');

    const changed = await api.patch(p.id, { unitPrice: 9500, priceBasis: 'gross', taxClass: 'reduced', discountBp: 250, description: 'Vor Ort' });
    expect(changed.status).toBe(200);
    expect(changed.json).toMatchObject({ name: 'Beratung', unitPrice: 9500, priceBasis: 'gross', taxClass: 'reduced', discountBp: 250, description: 'Vor Ort' });
    // A blank description is none; the search follows every change.
    expect((await api.patch(p.id, { description: '   ' })).json.description).toBeNull();
    expect((await api.patch(p.id, { unitPrice: -5 })).status).toBe(400);
    expect((await api.patch(p.id, { archived: false, unitPrice: 5 })).status).toBe(400);
    expect((await api.get(p.id)).json.unitPrice).toBe(9500);
  });
});

describe('company scoping', () => {
  it("another company's item answers 404 and never shows; the same name is fine in each company", async () => {
    const mine = await created({ name: 'Beratung' });
    const firstCompany = tenantId;
    activate(newTenantId());
    expect((await api.get(mine.id)).status).toBe(404);
    expect((await api.patch(mine.id, { unitPrice: 1 })).status).toBe(404);
    expect((await api.patch(mine.id, { archived: false })).status).toBe(404);
    expect((await api.archive(mine.id)).status).toBe(404);
    expect((await api.list()).json).toMatchObject({ items: [], total: 0 });
    const theirs = await created({ name: 'beratung' });
    expect(theirs.id).not.toBe(mine.id);
    activate(firstCompany);
    expect(names(await api.list())).toEqual(['Beratung']);
    expect((await api.get(mine.id)).json.unitPrice).toBe(8000);
  });
});

describe('a name is unique among the live items', () => {
  it('on create, rename and restore, case and accents ignored; archiving frees the name', async () => {
    const old = await created({ name: 'Beratung' });
    const other = await created({ name: 'Wartung' });
    const dup = await api.create({ name: 'BERATÚNG', unitPrice: 1 });
    expect(dup.status).toBe(409);
    expect(dup.json.error).toMatchObject({ code: 'duplicate_product', field: 'name' });
    expect((await api.create({ name: 'beratung  ', unitPrice: 1 })).status).toBe(409);
    expect((await api.patch(other.id, { name: 'beratung' })).status).toBe(409);
    expect((await api.get(other.id)).json.name).toBe('Wartung');
    // Renaming an item to another spelling of its own name is fine.
    expect((await api.patch(old.id, { name: 'beratung' })).json.name).toBe('beratung');

    const archived = await api.archive(old.id);
    expect(archived.status).toBe(200);
    expect(archived.json.archivedAt).not.toBeNull();
    // Archiving again changes nothing (idempotent, the first date stays).
    expect((await api.archive(old.id)).json.archivedAt).toBe(archived.json.archivedAt);
    const fresh = await created({ name: 'Beratung' });

    const restore = await api.patch(old.id, { archived: false });
    expect(restore.status).toBe(409);
    expect(restore.json.error.code).toBe('duplicate_product');
    expect((await api.get(old.id)).json.archivedAt).not.toBeNull();

    expect((await api.archive(fresh.id)).status).toBe(200);
    const back = await api.patch(old.id, { archived: false });
    expect(back.status).toBe(200);
    expect(back.json.archivedAt).toBeNull();
    // Restoring a live item is a no-op; archiving through PATCH works as DELETE.
    expect((await api.patch(old.id, { archived: false })).status).toBe(200);
    expect((await api.patch(other.id, { archived: true })).json.archivedAt).not.toBeNull();
  });

  it('the database enforces it too: a second live row of one folded name is refused', async () => {
    const p = await created({ name: 'Druck' });
    const row = await env.ownerDb
      .selectFrom('books_product')
      .select(['name_key', 'search_text'])
      .where('id', '=', p.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ name_key: 'druck', search_text: 'druck' });
    await expect(
      env.appDb
        .insertInto('books_product')
        .values({ id: 'raw-1', tenant_id: tenantId, name: 'DRUCK', name_key: 'druck', search_text: 'druck', unit_price: 1, updated_at: new Date() })
        .execute(),
    ).rejects.toMatchObject({ code: '23505', constraint_name: 'books_product_tenant_id_name_key_live_key' });
    await expect(
      env.appDb
        .insertInto('books_product')
        .values({ id: 'raw-2', tenant_id: tenantId, name: 'Neg', name_key: 'neg', search_text: 'neg', unit_price: -1, updated_at: new Date() })
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('the search and the order', () => {
  it('matches name and description, case and accents ignored, every word; metacharacters literally; live first', async () => {
    await created({ name: 'Beratúng', description: 'Strategie und Konzept' });
    await created({ name: 'Druck A4', kind: 'product', description: 'Farbig' });
    await created({ name: '100% Service' });
    const archived = await created({ name: 'Alte Beratung' });
    await api.archive(archived.id);

    expect(names(await api.list('?q=beratung'))).toEqual(['Beratúng']);
    expect(names(await api.list('?q=BERATUNG%20konzept'))).toEqual(['Beratúng']);
    expect(names(await api.list('?q=beratung%20farbig'))).toEqual([]);
    expect(names(await api.list('?q=farbig'))).toEqual(['Druck A4']);
    expect(names(await api.list('?q=0%25'))).toEqual(['100% Service']);
    expect(names(await api.list('?q=_'))).toEqual([]);
    expect((await api.list('?q=beratung')).json.total).toBe(1);
    expect(names(await api.list('?q=beratung&includeArchived=1'))).toEqual(['Beratúng', 'Alte Beratung']);
    expect(names(await api.list())).toEqual(['100% Service', 'Beratúng', 'Druck A4']);
    expect(names(await api.list('?includeArchived=1'))).toEqual(['100% Service', 'Beratúng', 'Druck A4', 'Alte Beratung']);

    expect((await api.list(`?q=${'x'.repeat(101)}`)).status).toBe(400);
    expect((await api.list('?cursor=not-a-cursor')).status).toBe(400);
  });

  it('pages with a cursor that holds when the row it ended on is renamed', async () => {
    const scope = scopeFor(env.appDb, env.tgId, tenantId, dir);
    for (const name of ['Anton', 'Berta', 'Caesar', 'Dora', 'Emil']) await created({ name });
    const first = await listProducts(scope, { limit: 2 });
    expect(first.items.map((i) => i.name)).toEqual(['Anton', 'Berta']);
    expect(first.total).toBe(5);
    // The last row of the page moves to the end of the order meanwhile.
    await updateProduct(scope, first.items[1].id, { name: 'Zacharias' });
    const second = await listProducts(scope, { limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((i) => i.name)).toEqual(['Caesar', 'Dora']);
    const third = await listProducts(scope, { limit: 2, cursor: second.nextCursor! });
    expect(third.items.map((i) => i.name)).toEqual(['Emil', 'Zacharias']);
    expect(third.nextCursor).toBeNull();
  });

  it('pages across the border between live and archived items without a gap or a repeat', async () => {
    const scope = scopeFor(env.appDb, env.tgId, tenantId, dir);
    const made: Json[] = [];
    for (const name of ['Anton', 'Berta', 'Caesar', 'Dora', 'Emil']) made.push(await created({ name }));
    // Anton and Dora archived: live Berta, Caesar, Emil, then archived Anton, Dora.
    await api.archive(made[0].id);
    await api.archive(made[3].id);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i += 1) {
      const page = await listProducts(scope, { limit: 2, includeArchived: true, cursor });
      seen.push(...page.items.map((p) => `${p.name}${p.archivedAt ? ' (archived)' : ''}`));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(['Berta', 'Caesar', 'Emil', 'Anton (archived)', 'Dora (archived)']);
  });

  it('answers 100 items a page through the route, the cursor fetching the rest', async () => {
    const now = new Date();
    await env.appDb
      .insertInto('books_product')
      .values(
        Array.from({ length: 101 }, (_, i) => {
          const name = `Posten ${String(i).padStart(3, '0')}`;
          return { id: `bulk-${tenantId}-${i}`, tenant_id: tenantId, name, name_key: name.toLowerCase(), search_text: name.toLowerCase(), unit_price: 100, updated_at: now };
        }),
      )
      .execute();
    const first = await api.list();
    expect(first.json.items).toHaveLength(100);
    expect(first.json.total).toBe(101);
    expect(first.json.nextCursor).toEqual(expect.any(String));
    const second = await api.list(`?cursor=${encodeURIComponent(first.json.nextCursor)}`);
    expect(names(second)).toEqual(['Posten 100']);
    expect(second.json.nextCursor).toBeNull();
  });
});

describe('a line filled from an item is a copy', () => {
  it('keeps its values when the item is changed and archived afterwards', async () => {
    const product = await created({
      name: 'Workshop',
      description: 'Ganztägig',
      unitLabel: 'Tag',
      unitPrice: 120000,
      taxClass: 'reduced',
      discountBp: 500,
      kind: 'service',
    });
    const draft = await call(documentsRoute.POST, 'POST', '/api/books/documents', {}, {});
    expect(draft.status).toBe(201);
    const docId = draft.json.document.id as string;
    const line = lineFromProduct(product as Parameters<typeof lineFromProduct>[0]);
    expect(line.priceBasis).toBe(draft.json.document.netOrGross);
    const added = await call(linesRoute.POST, 'POST', `/api/books/documents/${docId}/lines`, { id: docId }, {
      ...line,
      expectedVersion: draft.json.document.version,
    });
    expect(added.status).toBe(201);
    const before = added.json.lines[0];
    expect(before).toMatchObject({
      kind: 'service',
      title: 'Workshop',
      description: 'Ganztägig',
      unitLabel: 'Tag',
      unitPrice: 120000,
      taxClass: 'reduced',
      discountBp: 500,
      quantity: 1000,
    });

    expect((await api.patch(product.id, { name: 'Workshop XL', unitPrice: 1, taxClass: 'zero', description: null, unitLabel: 'Std', discountBp: 0 })).status).toBe(200);
    expect((await api.archive(product.id)).status).toBe(200);

    const after = await call(documentRoute.GET, 'GET', `/api/books/documents/${docId}`, { id: docId });
    expect(after.json.lines).toEqual([before]);
    expect(after.json.document.version).toBe(added.json.document.version);
    expect(after.json.document.total).toBe(added.json.document.total);
    // No reference was stored: the line names no catalog item.
    const row = await env.ownerDb
      .selectFrom('sales_document_line')
      .select(['variant_ref', 'variant_ref_source'])
      .where('document_id', '=', docId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ variant_ref: null, variant_ref_source: 'none' });
  });
});

describe('a price quoted in the other basis is converted by the server', () => {
  async function addTo(docId: string, version: number, product: Json) {
    const res = await call(linesRoute.POST, 'POST', `/api/books/documents/${docId}/lines`, { id: docId }, {
      ...lineFromProduct(product as Parameters<typeof lineFromProduct>[0]),
      expectedVersion: version,
    });
    expect(res.status).toBe(201);
    return res.json;
  }

  it('net item into a gross draft and gross item into a net draft, under a regular company', async () => {
    const netItem = await created({ name: 'Netto', unitPrice: 10000, priceBasis: 'net', taxClass: 'standard' });
    const grossItem = await created({ name: 'Brutto', unitPrice: 10700, priceBasis: 'gross', taxClass: 'reduced' });

    const gross = await call(documentsRoute.POST, 'POST', '/api/books/documents', {}, { netOrGross: 'gross' });
    expect(gross.json.document.netOrGross).toBe('gross');
    const inGross = await addTo(gross.json.document.id, gross.json.document.version, netItem);
    expect(inGross.lines[0]).toMatchObject({ unitPrice: 11900, subtotal: 10000, taxAmount: 1900, taxRate: 1900 });

    const net = await call(documentsRoute.POST, 'POST', '/api/books/documents', {}, { netOrGross: 'net' });
    const inNet = await addTo(net.json.document.id, net.json.document.version, grossItem);
    expect(inNet.lines[0]).toMatchObject({ unitPrice: 10000, subtotal: 10000, taxAmount: 700, taxRate: 700 });

    // The same basis is stored as it is.
    const inNetToo = await addTo(net.json.document.id, inNet.document.version, netItem);
    expect(inNetToo.lines[1]).toMatchObject({ unitPrice: 10000 });
  });

  it('under reverse charge a gross quote loses its VAT, and a priceBasis without its price is refused', async () => {
    const grossItem = await created({ name: 'Brutto', unitPrice: 11900, priceBasis: 'gross', taxClass: 'standard' });
    const scope = scopeFor(env.appDb, env.tgId, tenantId, dir);
    const { customer } = await newCustomer(scope, dir, { customerType: 'b2b', vatId: 'FR12345678901', countryCode: 'FR' });
    const draft = await call(documentsRoute.POST, 'POST', '/api/books/documents', {}, { netOrGross: 'net' });
    const docId = draft.json.document.id as string;
    const withCustomer = await call(documentCustomerRoute.PUT, 'PUT', `/api/books/documents/${docId}/customer`, { id: docId }, {
      customerId: customer.id,
      expectedVersion: draft.json.document.version,
    });
    expect(withCustomer.status).toBe(200);
    expect(withCustomer.json.document.reverseCharge).toBe(true);
    const added = await addTo(docId, withCustomer.json.document.version, grossItem);
    expect(added.lines[0]).toMatchObject({ unitPrice: 10000, subtotal: 10000, taxAmount: 0, taxTreatment: 'reverse_charge' });

    // The same in a GROSS draft: the basis matches the item's, and still the VAT comes off.
    const grossDraft = await call(documentsRoute.POST, 'POST', '/api/books/documents', {}, { netOrGross: 'gross' });
    const grossId = grossDraft.json.document.id as string;
    const grossWithCustomer = await call(documentCustomerRoute.PUT, 'PUT', `/api/books/documents/${grossId}/customer`, { id: grossId }, {
      customerId: customer.id,
      expectedVersion: grossDraft.json.document.version,
    });
    expect(grossWithCustomer.json.document.reverseCharge).toBe(true);
    const inGross = await addTo(grossId, grossWithCustomer.json.document.version, grossItem);
    expect(inGross.lines[0]).toMatchObject({ unitPrice: 10000, taxAmount: 0, taxTreatment: 'reverse_charge' });
    expect(inGross.document.total).toBe(10000);

    const refused = await call(linesRoute.POST, 'POST', `/api/books/documents/${docId}/lines`, { id: docId }, {
      title: 'Ohne Preis',
      priceBasis: 'gross',
      expectedVersion: added.document.version,
    });
    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe('invalid_line');
  });

  it('a small business stores the price as it is (net and gross are the same)', async () => {
    activate(newTenantId());
    await initCompany(scopeFor(env.appDb, env.tgId, tenantId, dir), { taxStatus: 'small_business' });
    const netItem = await created({ name: 'Netto', unitPrice: 10000, priceBasis: 'net' });
    const gross = await call(documentsRoute.POST, 'POST', '/api/books/documents', {}, { netOrGross: 'gross' });
    const added = await addTo(gross.json.document.id, gross.json.document.version, netItem);
    expect(added.lines[0]).toMatchObject({ unitPrice: 10000, taxAmount: 0 });
  });
});
