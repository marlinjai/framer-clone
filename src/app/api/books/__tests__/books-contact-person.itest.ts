// src/app/api/books/__tests__/books-contact-person.itest.ts
//
// The contact person ("z. Hd.") of an invoice and of a customer (migration 030, plan
// docs/plans/2026-11-11-contact-affiliations.md in the contacts repository, section 6), through the REAL route
// handlers against a real provisioned tenant schema. Only the auth-brain client, the tenant handle factory and the
// contacts database (a fake with affiliations) are replaced. The four stateful-flow paths of the knowledge-base
// standard stateful-flow-testing.md, named so, plus rights and the unhappy paths. All data is synthetic.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  db: null as unknown,
  session: null as unknown,
  directory: null as unknown,
  contactBook: null as unknown,
  can: true,
}));

vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    verifySession: async () => state.session,
    can: async () => state.can,
  },
}));
vi.mock('@/server/commerce/db', () => ({
  commerceTenantDbChecked: async () => state.db,
  isCommerceTenantNotProvisioned: () => false,
}));
vi.mock('@/server/books/http/dependencies', () => ({
  booksDependencies: () => ({ recipients: state.directory, contactBook: state.contactBook }),
}));

import { snapshotContactPerson } from '@/server/books/snapshots';
import { getDocument } from '@/server/books/repository/read';
import {
  FakeContactBook,
  FakeDirectory,
  initCompany,
  newTenantId,
  openBooksEnv,
  scopeFor,
  type BooksEnv,
} from '@/server/books/__tests__/booksFixtures';

import * as customersRoute from '../customers/route';
import * as customerRoute from '../customers/[id]/route';
import * as personsRoute from '../customers/[id]/contact-persons/route';
import * as personRoute from '../customers/[id]/contact-persons/[affiliationId]/route';
import * as defaultPersonRoute from '../customers/[id]/default-contact-person/route';
import * as documentsRoute from '../documents/route';
import * as documentRoute from '../documents/[id]/route';
import * as documentCustomerRoute from '../documents/[id]/customer/route';
import * as documentPersonRoute from '../documents/[id]/contact-person/route';
import * as linesRoute from '../documents/[id]/lines/route';
import * as issueRoute from '../documents/[id]/issue/route';

let env: BooksEnv;
let tenantId: string;
let dir: FakeDirectory;

beforeAll(async () => {
  env = await openBooksEnv('books-contact-person');
  state.db = env.appDb;
}, 120_000);

afterAll(async () => {
  await env?.close();
});

async function company() {
  tenantId = newTenantId();
  dir = new FakeDirectory();
  state.directory = dir;
  state.contactBook = new FakeContactBook(dir);
  state.session = {
    user: { id: 'user-books' },
    session: {},
    tenants: [{ id: tenantId, app_grants: ['sites', 'books'], group_id: env.tgId, name: 'Example', slug: 'example' }],
    workspaces: [{ id: 'ws-books', tenant_id: tenantId, name: 'Main', slug: 'main' }],
    active_tenant: { id: tenantId },
    active_workspace: null,
  };
  await initCompany(scopeFor(env.appDb, env.tgId, tenantId, dir), { taxStatus: 'small_business', invoiceNext: 62 });
}

beforeEach(async () => {
  state.can = true;
  await company();
});

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function request(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: { host: 'localhost:3000', cookie: 'lumitra_session=s', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call(
  handler: (req: Request, route: { params: Promise<any> }) => Promise<Response>, // eslint-disable-line @typescript-eslint/no-explicit-any
  method: string,
  path: string,
  params: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const res = await handler(request(method, path, body), { params: Promise.resolve(params) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

const api = {
  createCustomer: (body: unknown) => call(customersRoute.POST, 'POST', '/api/books/customers', {}, body),
  getCustomer: (id: string) => call(customerRoute.GET, 'GET', `/api/books/customers/${id}`, { id }),
  persons: (id: string) => call(personsRoute.GET, 'GET', `/api/books/customers/${id}/contact-persons`, { id }),
  addPerson: (id: string, body: unknown) => call(personsRoute.POST, 'POST', `/api/books/customers/${id}/contact-persons`, { id }, body),
  endPerson: (id: string, affiliationId: string) =>
    call(personRoute.DELETE, 'DELETE', `/api/books/customers/${id}/contact-persons/${affiliationId}`, { id, affiliationId }),
  setDefault: (id: string, contactPersonId: string | null) =>
    call(defaultPersonRoute.PUT, 'PUT', `/api/books/customers/${id}/default-contact-person`, { id }, { contactPersonId }),
  createDraft: (body: unknown = {}) => call(documentsRoute.POST, 'POST', '/api/books/documents', {}, body),
  get: (id: string) => call(documentRoute.GET, 'GET', `/api/books/documents/${id}`, { id }),
  setCustomer: (id: string, body: unknown) => call(documentCustomerRoute.PUT, 'PUT', `/api/books/documents/${id}/customer`, { id }, body),
  setPerson: (id: string, body: unknown) => call(documentPersonRoute.PUT, 'PUT', `/api/books/documents/${id}/contact-person`, { id }, body),
  addLine: (id: string, body: unknown) => call(linesRoute.POST, 'POST', `/api/books/documents/${id}/lines`, { id }, body),
  issue: (id: string, body: unknown = {}) => call(issueRoute.POST, 'POST', `/api/books/documents/${id}/issue`, { id }, body),
};

async function business(name = 'Sample Customer GmbH') {
  const res = await api.createCustomer({
    contact: { kind: 'organization', name, addressLine1: 'Beispielweg 2', postalCode: '20095', city: 'Hamburg', country: 'DE' },
    customerType: 'b2b',
    countryCode: 'DE',
  });
  expect(res.status).toBe(201);
  return res.json as { id: string; contactId: string };
}

async function person(customerId: string, name: string, role?: string) {
  const res = await api.addPerson(customerId, { person: { name }, role });
  expect(res.status).toBe(201);
  return res.json as { affiliationId: string; contactId: string; name: string; role: string };
}

async function draftFor(customerId: string) {
  const res = await api.createDraft({ customerId });
  expect(res.status).toBe(201);
  const id = res.json.document.id as string;
  await api.addLine(id, { kind: 'service', title: 'Workshop', quantity: 1000, unitLabel: 'Std', unitPrice: 8000 });
  return id;
}

async function nextInvoiceNumber(): Promise<number> {
  const row = await env.ownerDb
    .selectFrom('document_number_counter')
    .select('next_value')
    .where('tenant_id', '=', tenantId)
    .where('doc_type', '=', 'invoice')
    .executeTakeFirstOrThrow();
  return Number(row.next_value);
}

describe('contact persons: the customer screen routes', () => {
  it('adds a new person with a role and an existing person, lists them, ends one, and refuses the unhappy cases', async () => {
    const customer = await business();
    const anna = await person(customer.id, 'Anna Beispiel', 'Einkauf');
    expect(anna).toMatchObject({ name: 'Anna Beispiel', role: 'Einkauf' });
    // An existing person of the company (not yet affiliated) becomes one too.
    const loose = dir.add(tenantId, { kind: 'person', name: 'Ben Muster' });
    const ben = await api.addPerson(customer.id, { contactId: loose.id, role: null });
    expect(ben.status).toBe(201);
    expect(ben.json.role).toBe('');
    expect((await api.persons(customer.id)).json.items.map((p: Json) => p.name)).toEqual(['Anna Beispiel', 'Ben Muster']);

    // Twice is refused; a new person with an existing name is refused; a stranger's id is not a person of the company.
    expect((await api.addPerson(customer.id, { contactId: loose.id })).json.error.code).toBe('duplicate_contact_person');
    const dup = await api.addPerson(customer.id, { person: { name: 'Anna Beispiel' } });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe('duplicate_contact');
    expect((await api.addPerson(customer.id, { contactId: randomUUID() })).json.error.code).toBe('recipient_not_found');
    expect((await api.addPerson(customer.id, {})).status).toBe(400);

    // Ending removes them from the list; ending twice is harmless; another customer's affiliation id is not found.
    const after = await api.endPerson(customer.id, anna.affiliationId);
    expect(after.json.items.map((p: Json) => p.name)).toEqual(['Ben Muster']);
    expect((await api.endPerson(customer.id, anna.affiliationId)).status).toBe(200);
    const other = await business('Other GmbH');
    expect((await api.endPerson(other.id, ben.json.affiliationId)).json.error.code).toBe('recipient_not_found');
  });

  it('a private-person customer has no contact persons', async () => {
    const res = await api.createCustomer({
      contact: { kind: 'person', name: 'Alex Example', addressLine1: 'Weg 1', postalCode: '20095', city: 'Hamburg', country: 'DE' },
      customerType: 'b2c',
      countryCode: 'DE',
    });
    const refused = await api.addPerson(res.json.id, { person: { name: 'Someone' } });
    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe('invalid_input');
  });

  it('the default contact person: only one with an open affiliation, cleared when they leave, shown on the customer', async () => {
    const customer = await business();
    const anna = await person(customer.id, 'Anna Beispiel', 'Einkauf');
    const set = await api.setDefault(customer.id, anna.contactId);
    expect(set.status).toBe(200);
    expect(set.json.defaultContactPersonId).toBe(anna.contactId);
    expect((await api.getCustomer(customer.id)).json.defaultContactPersonId).toBe(anna.contactId);
    // A person of another company, an unknown id and a person without an affiliation are all "not found".
    const stranger = new FakeDirectory().add(newTenantId(), { kind: 'person', name: 'Stranger' });
    expect((await api.setDefault(customer.id, stranger.id)).json.error.code).toBe('contact_person_not_found');
    const loose = dir.add(tenantId, { kind: 'person', name: 'Loose Person' });
    expect((await api.setDefault(customer.id, loose.id)).status).toBe(404);
    // Leaving clears the default.
    await api.endPerson(customer.id, anna.affiliationId);
    expect((await api.getCustomer(customer.id)).json.defaultContactPersonId).toBeNull();
    expect((await api.setDefault(customer.id, null)).status).toBe(200);
  });

  it('leaving never clears another person\'s default, and a retry after a half-done leave still clears the leaver\'s', async () => {
    const customer = await business();
    const anna = await person(customer.id, 'Anna Beispiel', 'Einkauf');
    const ben = await person(customer.id, 'Ben Muster', 'Leitung');
    await api.setDefault(customer.id, ben.contactId);
    // Anna leaves while Ben is the default: Ben stays.
    await api.endPerson(customer.id, anna.affiliationId);
    expect((await api.getCustomer(customer.id)).json.defaultContactPersonId).toBe(ben.contactId);
    // Ben's affiliation ended but the clear never happened (a failed second write): ending again finishes it.
    dir.endAffiliation(ben.affiliationId);
    expect((await api.getCustomer(customer.id)).json.defaultContactPersonId).toBe(ben.contactId);
    expect((await api.endPerson(customer.id, ben.affiliationId)).status).toBe(200);
    expect((await api.getCustomer(customer.id)).json.defaultContactPersonId).toBeNull();
  });

  it('rights: reading needs viewBooks, every change needs editBooks', async () => {
    const customer = await business();
    const anna = await person(customer.id, 'Anna Beispiel');
    state.can = false;
    expect((await api.persons(customer.id)).status).toBe(403);
    expect((await api.addPerson(customer.id, { person: { name: 'Nope' } })).status).toBe(403);
    expect((await api.endPerson(customer.id, anna.affiliationId)).status).toBe(403);
    expect((await api.setDefault(customer.id, anna.contactId)).status).toBe(403);
    const draft = await draftForWhileAllowed(customer.id);
    state.can = false;
    expect((await api.setPerson(draft, { contactPersonId: anna.contactId })).status).toBe(403);
    state.can = true;
    // Nothing was changed by the refusals.
    expect((await api.persons(customer.id)).json.items).toHaveLength(1);
    expect((await api.get(draft)).json.document.contactPersonId).toBeNull();
  });
});

async function draftForWhileAllowed(customerId: string): Promise<string> {
  state.can = true;
  return draftFor(customerId);
}

describe('contact persons on an invoice: forward', () => {
  it('chooses a person, shows them with their role, issues, and freezes name and role in the snapshot', async () => {
    const customer = await business();
    const anna = await person(customer.id, 'Anna Beispiel', 'Einkauf');
    const id = await draftFor(customer.id);

    const set = await api.setPerson(id, { contactPersonId: anna.contactId });
    expect(set.status).toBe(200);
    expect(set.json.document.contactPersonId).toBe(anna.contactId);
    expect(set.json.contactPerson).toMatchObject({ contactId: anna.contactId, status: 'ok', name: 'Anna Beispiel', role: 'Einkauf' });
    expect(set.json.contactPersons.map((p: Json) => p.name)).toEqual(['Anna Beispiel']);

    const issued = await api.issue(id, { expectedVersion: set.json.document.version });
    expect(issued.status).toBe(200);
    const view = await getDocument(scopeFor(env.appDb, env.tgId, tenantId, dir), id);
    expect(view.document.customerSnapshot).toMatchObject({ v: 2, contactPerson: { contactId: anna.contactId, name: 'Anna Beispiel', role: 'Einkauf' } });
    expect(snapshotContactPerson(view.document.customerSnapshot!)).toMatchObject({ affiliationId: anna.affiliationId });
    // The issued document answers from its snapshot.
    const read = await api.get(id);
    expect(read.json.contactPerson).toMatchObject({ status: 'ok', name: 'Anna Beispiel', role: 'Einkauf' });
    expect(read.json.contactPersons).toBeNull();
  });

  it('an invoice without a contact person freezes a version 1 snapshot (readable by the build before contact persons)', async () => {
    const customer = await business();
    const id = await draftFor(customer.id);
    expect((await api.issue(id)).status).toBe(200);
    const view = await getDocument(scopeFor(env.appDb, env.tgId, tenantId, dir), id);
    expect(view.document.customerSnapshot).toMatchObject({ v: 1 });
    expect(view.document.customerSnapshot).not.toHaveProperty('contactPerson');
    expect((await api.get(id)).json.contactPerson).toBeNull();
  });

  it('only a person with an open affiliation to THIS customer\'s business can be chosen', async () => {
    const customer = await business();
    const otherCustomer = await business('Other GmbH');
    const outsider = await person(otherCustomer.id, 'Olga Other');
    const archived = await person(customer.id, 'Archie Archived');
    const id = await draftFor(customer.id);

    // Another business's person, a person of another company, an unknown id: "not found" every time.
    expect((await api.setPerson(id, { contactPersonId: outsider.contactId })).json.error.code).toBe('contact_person_not_found');
    const stranger = new FakeDirectory().add(newTenantId(), { kind: 'person', name: 'Stranger' });
    expect((await api.setPerson(id, { contactPersonId: stranger.id })).status).toBe(404);
    expect((await api.setPerson(id, { contactPersonId: randomUUID() })).status).toBe(404);
    // An archived person is unavailable, a bad value is a bad body.
    dir.update(archived.contactId, { archived: true });
    expect((await api.setPerson(id, { contactPersonId: archived.contactId })).json.error.code).toBe('contact_person_unavailable');
    expect((await api.setPerson(id, { contactPersonId: 'not-a-contact-id' })).status).toBe(400);
    expect((await api.get(id)).json.document.contactPersonId).toBeNull();
  });

  it('a draft without a customer cannot get a contact person', async () => {
    const draft = await api.createDraft({});
    const res = await api.setPerson(draft.json.document.id, { contactPersonId: randomUUID() });
    expect(res.status).toBe(422);
    expect(res.json.error.code).toBe('customer_required');
  });
});

describe('contact persons on an invoice: backtrack and revise', () => {
  it('changing the customer clears the person, the same customer keeps them, the default prefills', async () => {
    const a = await business('A GmbH');
    const b = await business('B GmbH');
    const annaAtA = await person(a.id, 'Anna A', 'Einkauf');
    const berndAtB = await person(b.id, 'Bernd B', 'Leitung');
    await api.setDefault(b.id, berndAtB.contactId);
    const id = await draftFor(a.id);

    let doc = (await api.setPerson(id, { contactPersonId: annaAtA.contactId })).json;
    // The same customer again keeps the person (and does not even bump the version).
    const same = await api.setCustomer(id, { customerId: a.id, expectedVersion: doc.document.version });
    expect(same.json.document.contactPersonId).toBe(annaAtA.contactId);
    expect(same.json.document.version).toBe(doc.document.version);

    // Another customer: Anna is not Bernd's colleague, so she goes; B's default takes her place.
    doc = (await api.setCustomer(id, { customerId: b.id, expectedVersion: doc.document.version })).json;
    expect(doc.document.contactPersonId).toBe(berndAtB.contactId);
    // And back to A, which has no default: no person, never B's.
    doc = (await api.setCustomer(id, { customerId: a.id, expectedVersion: doc.document.version })).json;
    expect(doc.document.contactPersonId).toBeNull();
    expect(doc.contactPerson).toBeNull();
  });

  it('a role change follows the draft but never an issued invoice', async () => {
    const customer = await business();
    const anna = await person(customer.id, 'Anna Beispiel', 'Einkauf');
    const id = await draftFor(customer.id);
    await api.setPerson(id, { contactPersonId: anna.contactId });

    dir.setRole(anna.affiliationId, 'Leitung');
    expect((await api.get(id)).json.contactPerson.role).toBe('Leitung');

    await api.issue(id);
    dir.setRole(anna.affiliationId, 'Beirat');
    const frozen = await api.get(id);
    expect(frozen.json.contactPerson).toMatchObject({ name: 'Anna Beispiel', role: 'Leitung' });
  });

  it('removing the contact person (null) works and repeating it changes nothing', async () => {
    const customer = await business();
    const anna = await person(customer.id, 'Anna Beispiel');
    const id = await draftFor(customer.id);
    const set = (await api.setPerson(id, { contactPersonId: anna.contactId })).json;
    const cleared = (await api.setPerson(id, { contactPersonId: null, expectedVersion: set.document.version })).json;
    expect(cleared.document.contactPersonId).toBeNull();
    const again = (await api.setPerson(id, { contactPersonId: null })).json;
    expect(again.document.version).toBe(cleared.document.version);
    // A stale version is refused and nothing changes.
    const stale = await api.setPerson(id, { contactPersonId: anna.contactId, expectedVersion: set.document.version });
    expect(stale.json.error.code).toBe('concurrent_edit');
    expect((await api.get(id)).json.document.contactPersonId).toBeNull();
  });
});

describe('contact persons on an invoice: resume', () => {
  it('a person who has left is shown as unavailable, issuing is refused with nothing consumed, and both ways forward work', async () => {
    const customer = await business();
    const anna = await person(customer.id, 'Anna Beispiel', 'Einkauf');
    const ben = await person(customer.id, 'Ben Muster', 'Leitung');
    const id = await draftFor(customer.id);
    await api.setPerson(id, { contactPersonId: anna.contactId });
    const before = await nextInvoiceNumber();

    dir.endAffiliation(anna.affiliationId);
    // Reload: the stored pointer is re-verified, not trusted.
    const resumed = await api.get(id);
    expect(resumed.json.document.contactPersonId).toBe(anna.contactId);
    expect(resumed.json.contactPerson).toMatchObject({ status: 'unavailable', name: null });
    expect(resumed.json.contactPersons.map((p: Json) => p.name)).toEqual(['Ben Muster']);

    const refused = await api.issue(id);
    expect(refused.status).toBe(422);
    expect(refused.json.error.code).toBe('contact_person_unavailable');
    expect(await nextInvoiceNumber()).toBe(before);
    expect((await api.get(id)).json.document.status).toBe('draft');

    // Way forward 1: another person of the customer.
    const other = await api.setPerson(id, { contactPersonId: ben.contactId });
    expect(other.json.contactPerson).toMatchObject({ status: 'ok', name: 'Ben Muster' });
    expect((await api.issue(id)).status).toBe(200);
  });

  it('way forward 2: removing the contact person lets the invoice issue without one', async () => {
    const customer = await business();
    const anna = await person(customer.id, 'Anna Beispiel');
    const id = await draftFor(customer.id);
    await api.setPerson(id, { contactPersonId: anna.contactId });
    dir.endAffiliation(anna.affiliationId);
    expect((await api.issue(id)).json.error.code).toBe('contact_person_unavailable');
    await api.setPerson(id, { contactPersonId: null });
    expect((await api.issue(id)).status).toBe(200);
    const view = await getDocument(scopeFor(env.appDb, env.tgId, tenantId, dir), id);
    expect(view.document.customerSnapshot).toMatchObject({ v: 1 });
  });

  it('an archived person (and an erased one) also stops the issue', async () => {
    const customer = await business();
    const anna = await person(customer.id, 'Anna Beispiel');
    const id = await draftFor(customer.id);
    await api.setPerson(id, { contactPersonId: anna.contactId });
    dir.update(anna.contactId, { archived: true });
    expect((await api.issue(id)).json.error.code).toBe('contact_person_unavailable');
    dir.update(anna.contactId, { archived: false });
    dir.endAffiliation(anna.affiliationId); // erased: the affiliation is gone with the contact
    expect((await api.issue(id)).json.error.code).toBe('contact_person_unavailable');
  });

  it('while the contacts database is down the draft still opens, the person reads as unreadable, and issuing says retry', async () => {
    const customer = await business();
    const anna = await person(customer.id, 'Anna Beispiel');
    const id = await draftFor(customer.id);
    await api.setPerson(id, { contactPersonId: anna.contactId });
    dir.failing = true;
    const read = await api.get(id);
    expect(read.status).toBe(200);
    expect(read.json.contactPerson).toMatchObject({ status: 'unreadable', name: null });
    expect(read.json.contactPersons).toBeNull();
    expect((await api.issue(id)).json.error.code).toBe('recipient_unavailable');
    dir.failing = false;
  });

  it('a draft written before contact persons existed has none', async () => {
    const customer = await business();
    const id = await draftFor(customer.id);
    // The column was never written: exactly a legacy row.
    await env.ownerDb.updateTable('sales_document').set({ contact_person_id: null }).where('tenant_id', '=', tenantId).where('id', '=', id).execute();
    const read = await api.get(id);
    expect(read.json.document.contactPersonId).toBeNull();
    expect(read.json.contactPerson).toBeNull();
    expect((await api.issue(id)).status).toBe(200);
  });
});

describe('contact persons on an invoice: re-entry', () => {
  it('a new draft after an issue starts from the customer\'s default, never from the last invoice\'s person', async () => {
    const customer = await business();
    const anna = await person(customer.id, 'Anna Beispiel', 'Einkauf');
    const ben = await person(customer.id, 'Ben Muster', 'Leitung');
    const first = await draftFor(customer.id);
    await api.setPerson(first, { contactPersonId: anna.contactId });
    await api.issue(first);

    // No default: a clean start.
    const second = await api.createDraft({ customerId: customer.id });
    expect(second.json.document.contactPersonId).toBeNull();
    // With a default: that one, and it is checked again when issued.
    await api.setDefault(customer.id, ben.contactId);
    const third = await api.createDraft({ customerId: customer.id });
    expect(third.json.document.contactPersonId).toBe(ben.contactId);
    expect(third.json.contactPerson).toMatchObject({ status: 'ok', name: 'Ben Muster' });
    // The earlier invoice is untouched by the new default.
    expect((await api.get(first)).json.contactPerson.name).toBe('Anna Beispiel');
  });

  it('an erased default contact person leaves the next draft clean, not broken', async () => {
    const customer = await business();
    const ben = await person(customer.id, 'Ben Muster');
    await api.setDefault(customer.id, ben.contactId);
    dir.endAffiliation(ben.affiliationId); // gone behind the customer's back (an erasure in the contacts app)
    const draft = await api.createDraft({ customerId: customer.id });
    // The stale default is copied (no network read inside a transaction) and shown as unavailable ...
    expect(draft.json.contactPerson).toMatchObject({ status: 'unavailable' });
    // ... and the user's way forward is the same as for any person who left.
    const cleared = await api.setPerson(draft.json.document.id, { contactPersonId: null });
    expect(cleared.json.contactPerson).toBeNull();
  });
});

describe('contact persons: the schema', () => {
  it('030 adds two nullable uuid-shaped columns, with no foreign key, and no existing row got a value', async () => {
    const customer = await business();
    const id = await draftFor(customer.id);
    const row = await env.ownerDb.selectFrom('sales_document').select(['contact_person_id']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.contact_person_id).toBeNull();
    const cust = await env.ownerDb.selectFrom('customer').select(['default_contact_person_id']).where('id', '=', customer.id).executeTakeFirstOrThrow();
    expect(cust.default_contact_person_id).toBeNull();
    await expect(
      env.ownerDb.updateTable('sales_document').set({ contact_person_id: 'not-a-uuid' }).where('id', '=', id).execute(),
    ).rejects.toThrow(/sales_document_contact_person_id_check/);
    await expect(
      env.ownerDb.updateTable('customer').set({ default_contact_person_id: 'nope' }).where('id', '=', customer.id).execute(),
    ).rejects.toThrow(/customer_default_contact_person_id_check/);
    // A well-formed id of a contact that does not exist is accepted (another database: no foreign key).
    await env.ownerDb.updateTable('sales_document').set({ contact_person_id: randomUUID() }).where('id', '=', id).execute();
  });

  it('an issued document\'s contact_person_id is frozen like every other column', async () => {
    const customer = await business();
    const id = await draftFor(customer.id);
    await api.issue(id);
    await expect(
      env.appDb.updateTable('sales_document').set({ contact_person_id: randomUUID() }).where('id', '=', id).execute(),
    ).rejects.toThrow();
  });
});
