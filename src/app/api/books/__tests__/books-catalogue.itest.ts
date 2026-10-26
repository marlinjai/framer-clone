// src/app/api/books/__tests__/books-catalogue.itest.ts
//
// Invoice lines picked from the company's catalogue (catalogue design,
// docs/plans/2026-10-25-catalogue-design.md, "The Books' own list is
// replaced") through the REAL route handlers, against a real provisioned
// tenant schema (the repository connected as commerce_app). Only the
// auth-brain client (session and permission), the tenant handle factory
// (pointed at the test schema) and the contacts database (a fake) are
// replaced. Catalogue rows are made with the commerce repositories
// (catalogRepository, pricingRepository), as the Catalog area does. The four
// stateful-flow paths, plus the guard and company isolation:
//
//   1. forward: the search offers each sellable variant (a service once, a
//      physical product per priced live variant, drafts included), folded like
//      search_text or by title; a picked service and a picked variant become
//      lines with the copied values (a gross price converted for a net draft)
//      and the variant as their only reference;
//   2. backtrack and revise: editing, re-pricing and renaming the catalogue
//      product afterwards leaves the lines as they were; picking another item
//      into the same line replaces its values and its reference;
//   3. resume: a reload answers the stored lines, reference included;
//   4. re-entry: an archived product is no longer offered, a line already on a
//      draft keeps working and the draft issues;
//   isolation: another company of the same tenant group never sees the
//   products, and adding its variant id answers 404 variant_not_found.
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

import type { CatalogueItemView } from '@/lib/books/api';
import { foldKey } from '@/lib/books/searchKey';
import { lineFromProduct } from '@/lib/books/products';
import { catalogRepository } from '@/server/commerce/repository/catalog';
import { pricingRepository } from '@/server/commerce/repository/pricing';
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

import * as catalogueRoute from '../catalogue/route';
import * as documentsRoute from '../documents/route';
import * as documentRoute from '../documents/[id]/route';
import * as documentCustomerRoute from '../documents/[id]/customer/route';
import * as linesRoute from '../documents/[id]/lines/route';
import * as lineRoute from '../documents/[id]/lines/[lineId]/route';
import * as issueRoute from '../documents/[id]/issue/route';

let env: BooksEnv;
let tenantId: string;
let dir: FakeDirectory;

beforeAll(async () => {
  env = await openBooksEnv('books-catalogue');
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

async function newCompany(): Promise<string> {
  const id = newTenantId();
  activate(id);
  await initCompany(scopeFor(env.appDb, env.tgId, id, dir), { taxStatus: 'regular' });
  return id;
}

beforeEach(async () => {
  state.allowed = new Set(['viewBooks', 'editBooks']);
  await newCompany();
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
  search: (q?: string) => call(catalogueRoute.GET, 'GET', `/api/books/catalogue${q === undefined ? '' : `?q=${encodeURIComponent(q)}`}`),
  createDraft: (body: Json = {}) => call(documentsRoute.POST, 'POST', '/api/books/documents', {}, body),
  get: (id: string) => call(documentRoute.GET, 'GET', `/api/books/documents/${id}`, { id }),
  addLine: (id: string, body: Json) => call(linesRoute.POST, 'POST', `/api/books/documents/${id}/lines`, { id }, body),
  patchLine: (id: string, lineId: string, body: Json) =>
    call(lineRoute.PATCH, 'PATCH', `/api/books/documents/${id}/lines/${lineId}`, { id, lineId }, body),
  setCustomer: (id: string, body: Json) => call(documentCustomerRoute.PUT, 'PUT', `/api/books/documents/${id}/customer`, { id }, body),
  issue: (id: string, body: Json) => call(issueRoute.POST, 'POST', `/api/books/documents/${id}/issue`, { id }, body),
};

interface CatalogueSpec {
  title: string;
  kind?: 'physical' | 'service';
  status?: 'draft' | 'published';
  description?: string | null;
  unitLabel?: string;
  priceBasis?: 'net' | 'gross';
  taxClass?: 'standard' | 'reduced' | 'zero' | null;
  discountBp?: number;
  /** Writes the folded search text, as the Catalog area does; false leaves it unset (found by title only). */
  searchText?: boolean;
  /** One per variant; `amount` null leaves the variant without a price. */
  variants: Array<{ title?: string | null; amount: number | null }>;
}

let handles = 0;

/** A catalogue product of the active company, through the commerce repositories. */
async function catalogue(spec: CatalogueSpec): Promise<{ productId: string; variantIds: string[] }> {
  const db = env.appDb;
  handles += 1;
  const product = await catalogRepository.createProduct(db, {
    tenantId,
    title: spec.title,
    handle: `item-${handles}`,
    description: spec.description ?? null,
    status: spec.status ?? 'draft',
    kind: spec.kind ?? 'physical',
  });
  await db
    .updateTable('product')
    .set({
      unit_label: spec.unitLabel ?? 'Stk',
      price_basis: spec.priceBasis ?? 'gross',
      tax_class: spec.taxClass === undefined ? 'standard' : spec.taxClass,
      discount_bp: spec.discountBp ?? 0,
      search_text: spec.searchText === false ? null : foldKey(`${spec.title} ${spec.description ?? ''}`),
      updated_at: new Date(),
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', product.id)
    .execute();
  const variantIds: string[] = [];
  for (const v of spec.variants) {
    const variant = await catalogRepository.addVariant(db, { tenantId, productId: product.id, title: v.title ?? null });
    variantIds.push(variant.id);
    if (v.amount === null) continue;
    const set = await pricingRepository.createPriceSet(db, { tenantId, variantId: variant.id });
    await pricingRepository.addPrice(db, { tenantId, priceSetId: set.id, currency: 'EUR', amount: v.amount });
  }
  return { productId: product.id, variantIds };
}

async function changeProduct(productId: string, values: { title?: string; description?: string | null; archived?: boolean; deleted?: boolean }) {
  const now = new Date();
  await env.appDb
    .updateTable('product')
    .set({
      ...(values.title !== undefined ? { title: values.title, search_text: foldKey(values.title) } : {}),
      ...(values.description !== undefined ? { description: values.description } : {}),
      ...(values.archived ? { archived_at: now } : {}),
      ...(values.deleted ? { deleted_at: now } : {}),
      updated_at: now,
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', productId)
    .execute();
}

async function reprice(variantId: string, amount: number) {
  const set = await env.appDb
    .selectFrom('price_set')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('variant_id', '=', variantId)
    .executeTakeFirstOrThrow();
  await env.appDb
    .updateTable('price')
    .set({ amount, updated_at: new Date() })
    .where('tenant_id', '=', tenantId)
    .where('price_set_id', '=', set.id)
    .execute();
}

async function search(q?: string): Promise<CatalogueItemView[]> {
  const res = await api.search(q);
  expect(res.status).toBe(200);
  return res.json.items as CatalogueItemView[];
}

const titles = (items: CatalogueItemView[]) => items.map((i) => i.title);

async function storedRefs(docId: string) {
  return env.ownerDb
    .selectFrom('sales_document_line')
    .select(['title', 'variant_ref', 'variant_ref_source'])
    .where('document_id', '=', docId)
    .orderBy('position')
    .execute();
}

/** The usual sample: a service quoted gross and a ring with two priced variants and one without a price. */
async function sample() {
  const service = await catalogue({
    title: 'Beratung vor Ort',
    kind: 'service',
    description: 'Termin beim Kunden',
    unitLabel: 'Std',
    priceBasis: 'gross',
    taxClass: 'standard',
    discountBp: 500,
    variants: [{ amount: 11900 }],
  });
  const ring = await catalogue({
    title: 'Ring',
    kind: 'physical',
    status: 'published',
    description: 'Handgeschmiedet',
    priceBasis: 'net',
    taxClass: 'reduced',
    variants: [{ title: 'Gold', amount: 20000 }, { title: 'Silber', amount: 9000 }, { title: 'Platin', amount: null }],
  });
  return { service, ring };
}

describe('the guard and the query', () => {
  it('reads with viewBooks, nothing without it, and refuses a search longer than 100 characters', async () => {
    await sample();
    state.allowed = new Set(['viewBooks']);
    expect((await api.search()).status).toBe(200);
    state.allowed = new Set();
    expect((await api.search()).status).toBe(403);
    state.allowed = new Set(['viewBooks', 'editBooks']);
    const long = await api.search('x'.repeat(101));
    expect(long.status).toBe(400);
    expect(long.json.error.code).toBe('bad_query');
  });
});

describe('forward: search and pick', () => {
  it('offers each sellable variant with what a line copies, drafts included, unpriced and deleted variants not', async () => {
    const { service, ring } = await sample();
    const deleted = await catalogue({ title: 'Alter Katalog', variants: [{ amount: 100 }] });
    await changeProduct(deleted.productId, { deleted: true });
    // A price only in another currency, or only on a price list, is no base price in EUR.
    const usd = await catalogue({ title: 'Dollar Ding', variants: [{ amount: null }] });
    const usdSet = await pricingRepository.createPriceSet(env.appDb, { tenantId, variantId: usd.variantIds[0] });
    await pricingRepository.addPrice(env.appDb, { tenantId, priceSetId: usdSet.id, currency: 'USD', amount: 500 });

    const items = await search();
    expect(titles(items)).toEqual(['Beratung vor Ort', 'Ring (Gold)', 'Ring (Silber)']);
    expect(items[0]).toEqual({
      variantId: service.variantIds[0],
      productId: service.productId,
      kind: 'service',
      title: 'Beratung vor Ort',
      description: 'Termin beim Kunden',
      unitLabel: 'Std',
      unitPrice: 11900,
      priceBasis: 'gross',
      taxClass: 'standard',
      discountBp: 500,
      status: 'draft',
    });
    expect(items[1]).toMatchObject({ variantId: ring.variantIds[0], kind: 'product', unitPrice: 20000, priceBasis: 'net', taxClass: 'reduced', status: 'published' });
  });

  it('matches every word, folded like search_text, by the title when no search text was written, and LIKE characters literally', async () => {
    await sample();
    await catalogue({ title: 'Ölwechsel Spezial', searchText: false, variants: [{ amount: 4900 }] });
    await catalogue({ title: '100% Wolle', variants: [{ amount: 3000 }] });
    expect(titles(await search('BERATÚNG  ort'))).toEqual(['Beratung vor Ort']);
    expect(titles(await search('handgeschmiedet'))).toEqual(['Ring (Gold)', 'Ring (Silber)']);
    expect(titles(await search('silber'))).toEqual(['Ring (Silber)']);
    expect(titles(await search('spezial'))).toEqual(['Ölwechsel Spezial']);
    expect(titles(await search('100%'))).toEqual(['100% Wolle']);
    expect(titles(await search('_'))).toEqual([]);
    expect(await search('nichts davon')).toEqual([]);
  });

  it('answers at most 50 items, by title', async () => {
    for (let i = 0; i < 52; i += 1) {
      await catalogue({ title: `Posten ${String(i).padStart(2, '0')}`, kind: 'service', variants: [{ amount: 100 + i }] });
    }
    const items = await search('posten');
    expect(items).toHaveLength(50);
    expect(items[0].title).toBe('Posten 00');
    expect(items[49].title).toBe('Posten 49');
  });

  it('a picked service and a picked variant become lines with the copied values and the variant as reference', async () => {
    const { service, ring } = await sample();
    const draft = await api.createDraft({ netOrGross: 'net' });
    expect(draft.status).toBe(201);
    const docId = draft.json.document.id as string;
    const [beratung, gold] = await search();

    const first = await api.addLine(docId, { ...lineFromProduct(beratung), quantity: 1000, expectedVersion: draft.json.document.version });
    expect(first.status).toBe(201);
    const second = await api.addLine(docId, { ...lineFromProduct(gold), quantity: 2000, expectedVersion: first.json.document.version });
    expect(second.status).toBe(201);
    expect(second.json.lines).toHaveLength(2);
    // The gross service price is stored net in the net draft (19 %: 119.00 -> 100.00).
    expect(second.json.lines[0]).toMatchObject({
      kind: 'service',
      title: 'Beratung vor Ort',
      description: 'Termin beim Kunden',
      unitLabel: 'Std',
      unitPrice: 10000,
      discountBp: 500,
      taxClass: 'standard',
      quantity: 1000,
      variantRef: service.variantIds[0],
      variantRefSource: 'owned',
    });
    expect(second.json.lines[1]).toMatchObject({
      kind: 'product',
      title: 'Ring (Gold)',
      description: 'Handgeschmiedet',
      unitPrice: 20000,
      taxClass: 'reduced',
      subtotal: 40000,
      variantRef: ring.variantIds[0],
    });
    expect(await storedRefs(docId)).toEqual([
      { title: 'Beratung vor Ort', variant_ref: service.variantIds[0], variant_ref_source: 'owned' },
      { title: 'Ring (Gold)', variant_ref: ring.variantIds[0], variant_ref_source: 'owned' },
    ]);

    // A net catalogue price on a gross draft goes the other way (7 %: 200.00 -> 214.00).
    const gross = await api.createDraft({ netOrGross: 'gross' });
    const inGross = await api.addLine(gross.json.document.id, { ...lineFromProduct(gold), quantity: 1000, expectedVersion: gross.json.document.version });
    expect(inGross.json.lines[0]).toMatchObject({ unitPrice: 21400, subtotal: 20000, taxAmount: 1400 });
  });
});

describe('backtrack and revise', () => {
  it('editing the catalogue afterwards leaves the line; picking another item into it replaces its values and reference', async () => {
    const { service, ring } = await sample();
    const draft = await api.createDraft({ netOrGross: 'net' });
    const docId = draft.json.document.id as string;
    const [beratung, gold, silber] = await search();
    const added = await api.addLine(docId, { ...lineFromProduct(gold), quantity: 1000, expectedVersion: draft.json.document.version });
    const before = added.json.lines[0];

    await changeProduct(ring.productId, { title: 'Ring XL', description: null });
    await reprice(ring.variantIds[0], 1);
    await changeProduct(service.productId, { archived: true });
    const unchanged = await api.get(docId);
    expect(unchanged.json.lines).toEqual([before]);
    expect(unchanged.json.document.total).toBe(added.json.document.total);
    expect(unchanged.json.document.version).toBe(added.json.document.version);

    // Another item into the same line: every copied value and the reference follow the new pick.
    const replaced = await api.patchLine(docId, before.id, { ...lineFromProduct(silber), expectedVersion: added.json.document.version });
    expect(replaced.status).toBe(200);
    expect(replaced.json.lines).toHaveLength(1);
    expect(replaced.json.lines[0]).toMatchObject({
      id: before.id,
      title: 'Ring (Silber)',
      unitPrice: 9000,
      quantity: 1000,
      variantRef: ring.variantIds[1],
      variantRefSource: 'owned',
    });
    // A gross pick into a net draft converts, as on add. The service was archived after the search answered it:
    // the reference is informational, so an archived (not deleted) item still goes in.
    const toService = await api.patchLine(docId, before.id, { ...lineFromProduct(beratung), expectedVersion: replaced.json.document.version });
    expect(toService.status).toBe(200);
    expect(toService.json.lines[0]).toMatchObject({
      kind: 'service',
      title: 'Beratung vor Ort',
      description: 'Termin beim Kunden',
      unitLabel: 'Std',
      unitPrice: 10000,
      discountBp: 500,
      taxClass: 'standard',
      variantRef: service.variantIds[0],
    });

    // Edited by hand afterwards: the values change, the reference stays until it is dropped.
    const edited = await api.patchLine(docId, before.id, { title: 'Beratung (verlängert)', expectedVersion: toService.json.document.version });
    expect(edited.json.lines[0]).toMatchObject({ title: 'Beratung (verlängert)', variantRef: service.variantIds[0] });
    const dropped = await api.patchLine(docId, before.id, { variantRef: null, expectedVersion: edited.json.document.version });
    expect(dropped.status).toBe(200);
    expect(dropped.json.lines[0]).toMatchObject({ title: 'Beratung (verlängert)', variantRef: null, variantRefSource: 'none' });
    expect(await storedRefs(docId)).toEqual([{ title: 'Beratung (verlängert)', variant_ref: null, variant_ref_source: 'none' }]);
  });

  it('refuses a price basis without its price, on add and on change, and changes nothing', async () => {
    await sample();
    const draft = await api.createDraft({ netOrGross: 'net' });
    const docId = draft.json.document.id as string;
    const [, gold] = await search();
    const withoutPrice: Json = { ...lineFromProduct(gold) };
    delete withoutPrice.unitPrice;
    const add = await api.addLine(docId, { ...withoutPrice, expectedVersion: draft.json.document.version });
    expect(add.status).toBe(400);
    expect(add.json.error.code).toBe('invalid_line');
    const added = await api.addLine(docId, { ...lineFromProduct(gold), expectedVersion: draft.json.document.version });
    const patch = await api.patchLine(docId, added.json.lines[0].id, { priceBasis: 'gross', expectedVersion: added.json.document.version });
    expect(patch.status).toBe(400);
    expect(patch.json.error.code).toBe('invalid_line');
    expect((await api.get(docId)).json.document.version).toBe(added.json.document.version);
  });
});

describe('resume', () => {
  it('a reload answers the stored lines with their copied values and reference', async () => {
    const { ring } = await sample();
    const draft = await api.createDraft({ netOrGross: 'net' });
    const docId = draft.json.document.id as string;
    const [, gold] = await search();
    const added = await api.addLine(docId, { ...lineFromProduct(gold), quantity: 1500, expectedVersion: draft.json.document.version });
    const reloaded = await api.get(docId);
    expect(reloaded.status).toBe(200);
    expect(reloaded.json.lines).toEqual(added.json.lines);
    expect(reloaded.json.lines[0]).toMatchObject({ title: 'Ring (Gold)', quantity: 1500, variantRef: ring.variantIds[0] });
    expect(reloaded.json.document.version).toBe(added.json.document.version);
  });
});

describe('re-entry', () => {
  it('an archived product is no longer offered; its line on a draft keeps working and the draft issues', async () => {
    const { ring } = await sample();
    const scope = scopeFor(env.appDb, env.tgId, tenantId, dir);
    const { customer } = await newCustomer(scope, dir, { customerType: 'b2b', vatId: 'DE123456789' });
    const draft = await api.createDraft({ netOrGross: 'net', serviceDate: '2026-10-01' });
    const docId = draft.json.document.id as string;
    const withCustomer = await api.setCustomer(docId, { customerId: customer.id, expectedVersion: draft.json.document.version });
    expect(withCustomer.status).toBe(200);
    const [, gold] = await search();
    const added = await api.addLine(docId, { ...lineFromProduct(gold), expectedVersion: withCustomer.json.document.version });
    expect(added.status).toBe(201);

    await changeProduct(ring.productId, { archived: true });
    expect(titles(await search())).toEqual(['Beratung vor Ort']);
    expect(await search('ring')).toEqual([]);

    // The line still changes (a quantity), keeps its reference, and the draft issues with it.
    const changed = await api.patchLine(docId, added.json.lines[0].id, { quantity: 3000, expectedVersion: added.json.document.version });
    expect(changed.status).toBe(200);
    expect(changed.json.lines[0]).toMatchObject({ title: 'Ring (Gold)', unitPrice: 20000, subtotal: 60000, variantRef: ring.variantIds[0] });
    const issued = await api.issue(docId, { expectedVersion: changed.json.document.version });
    expect(issued.json.error ?? null).toBeNull();
    expect(issued.status).toBe(200);
    expect(issued.json.document.document.status).toBe('issued');
    expect(issued.json.document.lines[0]).toMatchObject({ title: 'Ring (Gold)', unitPrice: 20000, variantRef: ring.variantIds[0] });
    expect(await storedRefs(docId)).toEqual([{ title: 'Ring (Gold)', variant_ref: ring.variantIds[0], variant_ref_source: 'owned' }]);

    // Restored in the catalogue, it is offered again; a deleted one never is, and cannot be picked.
    await env.appDb.updateTable('product').set({ archived_at: null, updated_at: new Date() }).where('tenant_id', '=', tenantId).where('id', '=', ring.productId).execute();
    expect(titles(await search('ring'))).toEqual(['Ring (Gold)', 'Ring (Silber)']);
    await changeProduct(ring.productId, { deleted: true });
    expect(await search('ring')).toEqual([]);
    const next = await api.createDraft({ netOrGross: 'net' });
    const refused = await api.addLine(next.json.document.id, { ...lineFromProduct(gold), expectedVersion: next.json.document.version });
    expect(refused.status).toBe(404);
    expect(refused.json.error.code).toBe('variant_not_found');
  });
});

describe('company isolation', () => {
  it("another company's products never appear, and its variant id is not found on add or change", async () => {
    const companyA = tenantId;
    const dirA = dir;
    const own = await catalogue({ title: 'Eigenes Teil', kind: 'service', variants: [{ amount: 500 }] });
    const draft = await api.createDraft({ netOrGross: 'net' });
    const docId = draft.json.document.id as string;
    const [mine] = await search();
    const added = await api.addLine(docId, { ...lineFromProduct(mine), expectedVersion: draft.json.document.version });
    expect(added.status).toBe(201);

    // Company B, in the same tenant group, with a product of the same title.
    await newCompany();
    const theirs = await catalogue({ title: 'Eigenes Teil', kind: 'service', variants: [{ amount: 999 }] });
    const theirItems = await search();
    expect(theirItems.map((i) => i.variantId)).toEqual([theirs.variantIds[0]]);

    activate(companyA);
    dir = dirA;
    state.directory = dirA;
    state.contactBook = new FakeContactBook(dirA);
    const items = await search('eigenes');
    expect(items.map((i) => i.variantId)).toEqual([own.variantIds[0]]);

    const foreign = { ...lineFromProduct(theirItems[0]), expectedVersion: added.json.document.version };
    const refused = await api.addLine(docId, foreign);
    expect(refused.status).toBe(404);
    expect(refused.json.error.code).toBe('variant_not_found');
    const refusedChange = await api.patchLine(docId, added.json.lines[0].id, foreign);
    expect(refusedChange.status).toBe(404);
    expect(refusedChange.json.error.code).toBe('variant_not_found');
    const after = await api.get(docId);
    expect(after.json.lines).toEqual(added.json.lines);
    expect(after.json.document.version).toBe(added.json.document.version);
  });
});
