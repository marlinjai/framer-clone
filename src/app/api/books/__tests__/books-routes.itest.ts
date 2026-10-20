// src/app/api/books/__tests__/books-routes.itest.ts
//
// Books phases 2 and 3 end to end through the REAL route handlers, against a
// real provisioned tenant schema (the repository connected as commerce_app).
// Only the auth-brain client (session and permission), the tenant handle
// factory (pointed at the test schema) and the contacts database (a fake) are
// replaced. The four stateful-flow paths of the knowledge-base standard
// stateful-flow-testing.md, named so:
//
//   1. forward: customer, draft, lines, preview totals, issue with confirmation,
//      the PDF stored once and downloaded;
//   2. backtrack and revise: the customer swap to an EU business flips every
//      line to reverse charge and back (regular taxation), and a swap that keeps
//      the tax profile touches no line;
//   3. resume: a reload (a fresh GET) returns the persisted draft, and a draft
//      whose customer's tax fields changed meanwhile comes back recomputed and
//      `stale`, and issues with the recomputed figures;
//   4. re-entry: "new invoice" after an issue starts clean, an abandoned draft
//      consumes no number, and a failed issue retried gets the same number.
//
// Plus phase 3: re-rendering an issued document after its customer and contact
// changed reproduces the stored PDF byte for byte; the stored file cannot be
// changed by any role; a draft preview is never stored; templates.
// All data is synthetic.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  db: null as unknown,
  session: null as unknown,
  directory: null as unknown,
  contactBook: null as unknown,
}));

vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    verifySession: async () => state.session,
    can: async () => true,
  },
}));
vi.mock('@/server/commerce/db', () => ({
  commerceTenantDbChecked: async () => state.db,
  isCommerceTenantNotProvisioned: () => false,
}));
vi.mock('@/server/books/http/dependencies', () => ({
  booksDependencies: () => ({ recipients: state.directory, contactBook: state.contactBook }),
}));

import type { ContactBook, NewContactInput } from '@/server/books/contactBook';
import { BooksError } from '@/server/books/errors';
import { getDocument } from '@/server/books/repository/read';
import { renderIssuedDocument } from '@/server/books/render/store';
import { extractPdfText } from '@/server/books/render/extractText';
import { missingFields } from '@/server/books/render/completeness';
import { REVERSE_CHARGE_NOTICE } from '@/server/tax/germanVat';
import type { RecipientContact } from '@/server/books/snapshots';
import {
  FakeDirectory,
  initCompany,
  newTenantId,
  openBooksEnv,
  rejectionCode,
  scopeFor,
  type BooksEnv,
} from '@/server/books/__tests__/booksFixtures';

import * as customersRoute from '../customers/route';
import * as customerRoute from '../customers/[id]/route';
import * as documentsRoute from '../documents/route';
import * as documentRoute from '../documents/[id]/route';
import * as documentCustomerRoute from '../documents/[id]/customer/route';
import * as linesRoute from '../documents/[id]/lines/route';
import * as lineRoute from '../documents/[id]/lines/[lineId]/route';
import * as reorderRoute from '../documents/[id]/lines/reorder/route';
import * as issueRoute from '../documents/[id]/issue/route';
import * as cancelRoute from '../documents/[id]/cancel/route';
import * as pdfRoute from '../documents/[id]/pdf/route';
import * as templatesRoute from '../templates/route';
import * as templateRoute from '../templates/[id]/route';
import * as settingsRoute from '../settings/route';

/** The contact book over the fake directory (create, getMany, search). */
class FakeContactBook implements ContactBook {
  constructor(private readonly dir: FakeDirectory) {}
  readonly created: RecipientContact[] = [];
  async search(tenantId: string): Promise<RecipientContact[]> {
    return this.created.filter((c) => (c as RecipientContact & { tenantId?: string }).tenantId === tenantId);
  }
  async getMany(tenantId: string, ids: readonly string[]): Promise<RecipientContact[]> {
    // As the production book does: any failure of the database is RECIPIENT_UNAVAILABLE.
    if (this.dir.failing) throw new BooksError('RECIPIENT_UNAVAILABLE', 'synthetic contacts outage');
    const out: RecipientContact[] = [];
    for (const id of ids) {
      const c = await this.dir.getContact(tenantId, id);
      if (c) out.push(c);
    }
    return out;
  }
  async create(tenantId: string, input: NewContactInput): Promise<RecipientContact> {
    const c = this.dir.add(tenantId, {
      kind: input.kind,
      name: input.name,
      companyOrRole: input.companyOrRole ?? '',
      legalForm: input.legalForm ?? null,
      addressLine1: input.addressLine1 ?? null,
      addressLine2: input.addressLine2 ?? null,
      postalCode: input.postalCode ?? null,
      city: input.city ?? null,
      country: input.country ?? null,
      vatId: input.vatId ?? null,
    });
    this.created.push({ ...c, tenantId } as RecipientContact);
    return c;
  }
}

let env: BooksEnv;
let tenantId: string;
let dir: FakeDirectory;

beforeAll(async () => {
  env = await openBooksEnv('books-routes');
  state.db = env.appDb;
}, 120_000);

afterAll(async () => {
  await env?.close();
});

/** A fresh company per test: its own settings, counters and fake contacts. */
async function company(taxStatus: 'small_business' | 'regular' = 'small_business') {
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
  await initCompany(scopeFor(env.appDb, env.tgId, tenantId, dir), { taxStatus, invoiceNext: 62 });
}

beforeEach(async () => {
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
  listCustomers: () => call(customersRoute.GET, 'GET', '/api/books/customers'),
  patchCustomer: (id: string, body: unknown) => call(customerRoute.PATCH, 'PATCH', `/api/books/customers/${id}`, { id }, body),
  createDraft: (body: unknown = {}) => call(documentsRoute.POST, 'POST', '/api/books/documents', {}, body),
  listDocuments: () => call(documentsRoute.GET, 'GET', '/api/books/documents'),
  get: (id: string) => call(documentRoute.GET, 'GET', `/api/books/documents/${id}`, { id }),
  patch: (id: string, body: unknown) => call(documentRoute.PATCH, 'PATCH', `/api/books/documents/${id}`, { id }, body),
  setCustomer: (id: string, body: unknown) =>
    call(documentCustomerRoute.PUT, 'PUT', `/api/books/documents/${id}/customer`, { id }, body),
  addLine: (id: string, body: unknown) => call(linesRoute.POST, 'POST', `/api/books/documents/${id}/lines`, { id }, body),
  editLine: (id: string, lineId: string, body: unknown) =>
    call(lineRoute.PATCH, 'PATCH', `/api/books/documents/${id}/lines/${lineId}`, { id, lineId }, body),
  removeLine: (id: string, lineId: string) =>
    call(lineRoute.DELETE, 'DELETE', `/api/books/documents/${id}/lines/${lineId}`, { id, lineId }),
  reorder: (id: string, body: unknown) =>
    call(reorderRoute.POST, 'POST', `/api/books/documents/${id}/lines/reorder`, { id }, body),
  issue: (id: string, body: unknown = {}) => call(issueRoute.POST, 'POST', `/api/books/documents/${id}/issue`, { id }, body),
  cancel: (id: string, body: unknown) => call(cancelRoute.POST, 'POST', `/api/books/documents/${id}/cancel`, { id }, body),
};

async function pdf(id: string): Promise<Response> {
  return pdfRoute.GET(request('GET', `/api/books/documents/${id}/pdf`), { params: Promise.resolve({ id }) });
}

async function newCustomer(opts: { customerType: 'b2c' | 'b2b'; country?: string; vatId?: string | null; name?: string }) {
  const res = await api.createCustomer({
    contact: {
      kind: opts.customerType === 'b2b' ? 'organization' : 'person',
      name: opts.name ?? (opts.customerType === 'b2b' ? 'Sample Customer GmbH' : 'Alex Example'),
      addressLine1: 'Beispielweg 2',
      postalCode: opts.country === 'FR' ? '75001' : '20095',
      city: opts.country === 'FR' ? 'Paris' : 'Hamburg',
      country: opts.country ?? 'DE',
    },
    customerType: opts.customerType,
    vatId: opts.vatId ?? null,
    countryCode: opts.country ?? 'DE',
  });
  expect(res.status).toBe(201);
  return res.json;
}

async function counter(docType: 'invoice' | 'credit_note' = 'invoice'): Promise<number> {
  const row = await env.ownerDb
    .selectFrom('document_number_counter')
    .select('next_value')
    .where('tenant_id', '=', tenantId)
    .where('doc_type', '=', docType)
    .executeTakeFirstOrThrow();
  return Number(row.next_value);
}

describe('Books routes: the four stateful-flow paths', () => {
  it('forward: customer, draft, three lines, preview totals, issue with confirmation, stored PDF', async () => {
    const customer = await newCustomer({ customerType: 'b2b' });
    expect(customer.contact.name).toBe('Sample Customer GmbH');
    expect(customer.contactStatus).toBe('ok');

    const draft = await api.createDraft({ customerId: customer.id });
    expect(draft.status).toBe(201);
    const id = draft.json.document.id as string;
    expect(draft.json.document.documentNumber).toBeNull();

    await api.addLine(id, { kind: 'service', title: 'Workshop', quantity: 1500, unitLabel: 'Std', unitPrice: 8000 });
    await api.addLine(id, { kind: 'text', title: 'Note for the record' });
    const added = await api.addLine(id, { kind: 'product', title: 'Handout', quantity: 2000, unitPrice: 1250 });
    expect(added.status).toBe(201);
    // Preview totals: the server's figures, small business, no tax.
    expect(added.json.document.total).toBe(14500);
    expect(added.json.document.taxAmount).toBe(0);
    expect(added.json.lines).toHaveLength(3);

    const issued = await api.issue(id, { expectedVersion: added.json.document.version });
    expect(issued.status).toBe(200);
    expect(issued.json.alreadyIssued).toBe(false);
    expect(issued.json.document.document.documentNumber).toBe('62');
    expect(issued.json.document.document.status).toBe('issued');
    expect(issued.json.render.stored).toBe(true);
    expect(await counter()).toBe(63);

    // A second click: same number, nothing allocated.
    const again = await api.issue(id, {});
    expect(again.json.alreadyIssued).toBe(true);
    expect(again.json.document.document.documentNumber).toBe('62');
    expect(await counter()).toBe(63);

    // The download is the stored document of record, and it is complete.
    const res = await pdf(id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('x-books-of-record')).toBe('true');
    expect(res.headers.get('content-disposition')).toContain('Rechnung-62.pdf');
    const bytes = new Uint8Array(await res.arrayBuffer());
    const view = await getDocument(scopeFor(env.appDb, env.tgId, tenantId, dir), id);
    expect(view.document.renderedPdfFileId).toBe(issued.json.render.fileId);
    expect(missingFields(view.document, view.lines, extractPdfText(bytes))).toEqual([]);

    // The list shows number, status and the customer's name.
    const listed = await api.listDocuments();
    expect(listed.json.items[0]).toMatchObject({ id, documentNumber: '62', status: 'issued', customerName: 'Sample Customer GmbH' });
  });

  it('forward: an issue with a stale confirmation is refused and issues nothing', async () => {
    const customer = await newCustomer({ customerType: 'b2b' });
    const draft = await api.createDraft({ customerId: customer.id });
    const id = draft.json.document.id;
    const v1 = await api.addLine(id, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 5000 });
    await api.addLine(id, { kind: 'service', title: 'Added elsewhere', quantity: 1000, unitPrice: 5000 });
    const res = await api.issue(id, { expectedVersion: v1.json.document.version });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('concurrent_edit');
    expect(await counter()).toBe(62);
  });

  it('backtrack and revise: customer swap to an EU business flips every line to reverse charge, and back', async () => {
    await company('regular');
    const consumer = await newCustomer({ customerType: 'b2c' });
    const euBusiness = await newCustomer({ customerType: 'b2b', country: 'FR', vatId: 'FR12345678901', name: 'Société Exemple' });
    const draft = await api.createDraft({ customerId: consumer.id, serviceDate: '2026-10-01' });
    const id = draft.json.document.id;
    await api.addLine(id, { kind: 'service', title: 'Consulting', quantity: 1000, unitPrice: 10000, taxClass: 'standard' });
    const before = await api.addLine(id, { kind: 'product', title: 'Book', quantity: 1000, unitPrice: 2000, taxClass: 'reduced' });
    expect(before.json.lines.map((l: Json) => l.taxRate)).toEqual([1900, 700]);
    expect(before.json.document.taxAmount).toBe(1900 + 140);

    const swapped = await api.setCustomer(id, { customerId: euBusiness.id, expectedVersion: before.json.document.version });
    expect(swapped.status).toBe(200);
    expect(swapped.json.lines.map((l: Json) => [l.taxTreatment, l.taxRate, l.taxAmount])).toEqual([
      ['reverse_charge', 0, 0],
      ['reverse_charge', 0, 0],
    ]);
    expect(swapped.json.document.taxAmount).toBe(0);
    expect(swapped.json.document.total).toBe(12000);
    expect(swapped.json.document.taxNote).toBe(REVERSE_CHARGE_NOTICE);
    expect(swapped.json.document.reverseCharge).toBe(true);

    const back = await api.setCustomer(id, { customerId: consumer.id });
    expect(back.json.lines.map((l: Json) => l.taxRate)).toEqual([1900, 700]);
    expect(back.json.document.taxNote).toBeNull();
    expect(back.json.document.total).toBe(12000 + 2040);
  });

  it('backtrack and revise counter-case: a swap to another German consumer touches no line', async () => {
    await company('regular');
    const a = await newCustomer({ customerType: 'b2c', name: 'Alex Example' });
    const b = await newCustomer({ customerType: 'b2c', name: 'Robin Example' });
    const draft = await api.createDraft({ customerId: a.id });
    const id = draft.json.document.id;
    const withLine = await api.addLine(id, { kind: 'service', title: 'Consulting', quantity: 1000, unitPrice: 10000 });
    const swapped = await api.setCustomer(id, { customerId: b.id });
    expect(swapped.json.lines[0].updatedAt).toBe(withLine.json.lines[0].updatedAt);
    expect(swapped.json.document.taxProfileKey).toBe(withLine.json.document.taxProfileKey);
    expect(swapped.json.customer.contact.name).toBe('Robin Example');
    expect(swapped.json.document.version).toBe(withLine.json.document.version + 1);
  });

  it('backtrack and revise: a line edit, a reorder and a removal recompute the totals', async () => {
    const customer = await newCustomer({ customerType: 'b2b' });
    const id = (await api.createDraft({ customerId: customer.id })).json.document.id;
    const one = await api.addLine(id, { kind: 'service', title: 'A', quantity: 1000, unitPrice: 1000 });
    const two = await api.addLine(id, { kind: 'service', title: 'B', quantity: 1000, unitPrice: 2000 });
    const [la, lb] = two.json.lines;
    const edited = await api.editLine(id, la.id, { quantity: 3000 });
    expect(edited.json.document.total).toBe(3000 + 2000);
    const reordered = await api.reorder(id, { lineIds: [lb.id, la.id] });
    expect(reordered.json.lines.map((l: Json) => l.title)).toEqual(['B', 'A']);
    const removed = await api.removeLine(id, lb.id);
    expect(removed.json.lines.map((l: Json) => [l.title, l.position])).toEqual([['A', 1]]);
    expect(removed.json.document.total).toBe(3000);
    expect(one.status).toBe(201);
    const bad = await api.reorder(id, { lineIds: [la.id, la.id] });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('invalid_positions');
  });

  it('resume: a reload returns the persisted draft, and a stale one comes back recomputed', async () => {
    await company('regular');
    const customer = await newCustomer({ customerType: 'b2b', vatId: null });
    const draft = await api.createDraft({ customerId: customer.id, serviceDate: '2026-10-02' });
    const id = draft.json.document.id;
    const saved = await api.addLine(id, { kind: 'service', title: 'Consulting', quantity: 1000, unitPrice: 10000 });

    const reloaded = await api.get(id);
    expect(reloaded.json.stale).toBe(false);
    expect(reloaded.json.document.total).toBe(saved.json.document.total);
    expect(reloaded.json.lines).toEqual(saved.json.lines);

    // The customer becomes a French business with a VAT id meanwhile.
    const patched = await api.patchCustomer(customer.id, { countryCode: 'FR', vatId: 'FR12345678901' });
    expect(patched.status).toBe(200);
    const stale = await api.get(id);
    expect(stale.json.stale).toBe(true);
    expect(stale.json.lines[0].taxTreatment).toBe('reverse_charge');
    expect(stale.json.document.total).toBe(10000);

    const issued = await api.issue(id, { expectedVersion: stale.json.document.version });
    expect(issued.status).toBe(200);
    expect(issued.json.document.document.total).toBe(10000);
    expect(issued.json.document.document.reverseCharge).toBe(true);
  });

  it('re-entry: a new draft after an issue starts clean and an abandoned draft consumes no number', async () => {
    const customer = await newCustomer({ customerType: 'b2b' });
    const first = (await api.createDraft({ customerId: customer.id })).json.document.id;
    await api.addLine(first, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 5000 });
    expect((await api.issue(first)).json.document.document.documentNumber).toBe('62');

    const fresh = await api.createDraft({});
    expect(fresh.json.document.id).not.toBe(first);
    expect(fresh.json.document.documentNumber).toBeNull();
    expect(fresh.json.document.customerSnapshot).toBeNull();
    expect(fresh.json.document.senderSnapshot).toBeNull();
    expect(fresh.json.lines).toEqual([]);
    expect(fresh.json.events.map((e: Json) => e.eventType)).toEqual(['draft_created']);
    // Abandoned: never issued.
    await api.addLine(fresh.json.document.id, { kind: 'service', title: 'Never billed', quantity: 1000, unitPrice: 100 });

    const third = (await api.createDraft({ customerId: customer.id })).json.document.id;
    await api.addLine(third, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 5000 });
    expect((await api.issue(third)).json.document.document.documentNumber).toBe('63');
    const abandoned = await api.get(fresh.json.document.id);
    expect(abandoned.json.document.status).toBe('draft');
    expect(abandoned.json.document.documentNumber).toBeNull();
  });

  it('re-entry after a failed issue: the contacts database down writes nothing, the retry gets the number', async () => {
    const customer = await newCustomer({ customerType: 'b2b' });
    const id = (await api.createDraft({ customerId: customer.id })).json.document.id;
    await api.addLine(id, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 5000 });
    dir.failing = true;
    const failed = await api.issue(id);
    expect(failed.status).toBe(503);
    expect(failed.json.error.code).toBe('recipient_unavailable');
    expect(await counter()).toBe(62);
    // The editor still loads the draft; only the label says the contacts are unreachable.
    const during = await api.get(id);
    expect(during.json.document.status).toBe('draft');
    expect(during.json.customer.contactStatus).toBe('unavailable');
    dir.failing = false;
    expect((await api.issue(id)).json.document.document.documentNumber).toBe('62');
  });

  it('issue refusals name what to fix: no customer, no billable line', async () => {
    const id = (await api.createDraft({})).json.document.id;
    const noCustomer = await api.issue(id);
    expect(noCustomer.status).toBe(422);
    expect(noCustomer.json.error.code).toBe('customer_required');
    const customer = await newCustomer({ customerType: 'b2b' });
    await api.setCustomer(id, { customerId: customer.id });
    const noLines = await api.issue(id);
    expect(noLines.status).toBe(422);
    expect(noLines.json.error.code).toBe('no_billable_lines');
  });
});

describe('Books routes: cancellation, rendering, templates', () => {
  it('cancel: a credit note from its own series, both PDFs stored', async () => {
    const customer = await newCustomer({ customerType: 'b2b' });
    const id = (await api.createDraft({ customerId: customer.id })).json.document.id;
    await api.addLine(id, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 5000 });
    await api.issue(id);
    const res = await api.cancel(id, { reason: 'issued in error' });
    expect(res.status).toBe(200);
    expect(res.json.invoice.document.status).toBe('cancelled');
    expect(res.json.creditNote.document.documentNumber).toBe('GS-1');
    expect(res.json.render.stored).toBe(true);
    const credit = await pdf(res.json.creditNote.document.id);
    expect(credit.headers.get('x-books-of-record')).toBe('true');
    const text = extractPdfText(new Uint8Array(await credit.arrayBuffer()));
    expect(text).toContain('Storno der Rechnung 62');
    const again = await api.cancel(id, { reason: 'issued in error' });
    expect(again.json.alreadyCancelled).toBe(true);
  });

  it('re-rendering an issued document after its customer and contact changed is byte-identical', async () => {
    const customer = await newCustomer({ customerType: 'b2b' });
    const id = (await api.createDraft({ customerId: customer.id })).json.document.id;
    await api.addLine(id, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 5000 });
    await api.issue(id);
    const stored = new Uint8Array(await (await pdf(id)).arrayBuffer());

    dir.update(customer.contactId, { name: 'Renamed Customer AG', addressLine1: 'Neue Strasse 9' });
    await api.patchCustomer(customer.id, { vatId: 'DE999999999', taxNumber: '99/999/99999' });

    const scope = scopeFor(env.appDb, env.tgId, tenantId, dir);
    const rerendered = await renderIssuedDocument(scope, await getDocument(scope, id));
    expect(Buffer.from(rerendered).equals(Buffer.from(stored))).toBe(true);
    expect(extractPdfText(rerendered)).not.toContain('Renamed Customer AG');
  });

  it('a stored document of record cannot be changed or removed by any role', async () => {
    const customer = await newCustomer({ customerType: 'b2b' });
    const id = (await api.createDraft({ customerId: customer.id })).json.document.id;
    await api.addLine(id, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 5000 });
    const issued = await api.issue(id);
    const fileId = issued.json.render.fileId as string;
    const tamper = (db: typeof env.ownerDb) =>
      db.updateTable('sales_document_file').set({ renderer: 'x' }).where('id', '=', fileId).execute();
    expect(await rejectionCode(tamper(env.ownerDb))).toBe('BK006');
    expect(await rejectionCode(tamper(env.appDb))).toBe('42501');
    expect(
      await rejectionCode(env.ownerDb.deleteFrom('sales_document_file').where('id', '=', fileId).execute()),
    ).toBe('BK006');
    // And the document cannot be re-pointed at another file.
    expect(
      await rejectionCode(
        env.ownerDb.updateTable('sales_document').set({ rendered_pdf_file_id: randomUUID() }).where('id', '=', id).execute(),
      ),
    ).toBe('BK001');
  });

  it('a draft preview is marked and never stored', async () => {
    const customer = await newCustomer({ customerType: 'b2b' });
    const id = (await api.createDraft({ customerId: customer.id })).json.document.id;
    await api.addLine(id, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 5000 });
    const res = await pdf(id);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-books-of-record')).toBe('false');
    expect(extractPdfText(new Uint8Array(await res.arrayBuffer()))).toContain('ENTWURF');
    const files = await env.ownerDb.selectFrom('sales_document_file').select('id').where('document_id', '=', id).execute();
    expect(files).toEqual([]);
  });

  it('templates: the first is the default, new drafts get it, one in use cannot be deleted', async () => {
    const created = await call(templatesRoute.POST, 'POST', '/api/books/templates', {}, {
      name: 'Standard',
      accentColor: '#2b4c7e',
      footerBlocks: [{ heading: 'Hinweis', text: 'Synthetic small print.' }],
    });
    expect(created.status).toBe(201);
    expect(created.json.isDefault).toBe(true);
    const second = await call(templatesRoute.POST, 'POST', '/api/books/templates', {}, { name: 'Alt' });
    expect(second.json.isDefault).toBe(false);
    const dup = await call(templatesRoute.POST, 'POST', '/api/books/templates', {}, { name: 'Standard' });
    expect(dup.status).toBe(409);

    const draft = await api.createDraft({});
    expect(draft.json.document.templateId).toBe(created.json.id);
    const inUse = await call(templateRoute.DELETE, 'DELETE', `/api/books/templates/${created.json.id}`, { id: created.json.id });
    expect(inUse.status).toBe(409);
    expect(inUse.json.error.code).toBe('template_in_use');

    const promoted = await call(templateRoute.PATCH, 'PATCH', `/api/books/templates/${second.json.id}`, { id: second.json.id }, { isDefault: true });
    expect(promoted.json.isDefault).toBe(true);
    const list = await call(templatesRoute.GET, 'GET', '/api/books/templates');
    expect(list.json.items.map((t: Json) => [t.name, t.isDefault])).toEqual([['Alt', true], ['Standard', false]]);
    const removed = await call(templateRoute.DELETE, 'DELETE', `/api/books/templates/${second.json.id}`, { id: second.json.id });
    expect(removed.status).toBe(204);
  });

  it('settings: the company configuration and the next number', async () => {
    const res = await call(settingsRoute.GET, 'GET', '/api/books/settings');
    expect(res.json.initialised).toBe(true);
    expect(res.json.settings.taxStatus).toBe('small_business');
    expect(res.json.counters.find((c: Json) => c.docType === 'invoice').nextNumber).toBe('62');
  });

  it('customers: the list carries contact labels; a duplicate contact customer is a 409', async () => {
    const c = await newCustomer({ customerType: 'b2b' });
    const listed = await api.listCustomers();
    expect(listed.json.items.map((x: Json) => x.contact?.name)).toEqual(['Sample Customer GmbH']);
    const dup = await api.createCustomer({ contactId: c.contactId, customerType: 'b2b' });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe('duplicate_customer');
  });
});
