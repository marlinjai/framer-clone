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

import { createHash, randomUUID } from 'node:crypto';
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

import { getDocument } from '@/server/books/repository/read';
import { renderIssuedDocument, storeBeforeCommit } from '@/server/books/render/store';
import { planInvoice } from '@/server/books/importCli';
import { importHistoricalInvoice } from '@/server/books/importInvoices';
import { renderPdf } from '@/server/books/render/pdf';
import { issue as issueDocument } from '@/server/books/issue';
import * as contactsRoute from '../contacts/route';
import { extractPdfText } from '@/server/books/render/extractText';
import { missingFields } from '@/server/books/render/completeness';
import { REVERSE_CHARGE_NOTICE } from '@/server/tax/germanVat';
import {
  FakeContactBook,
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
    expect(missingFields(view.document, view.lines, await extractPdfText(bytes))).toEqual([]);

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
    const text = await extractPdfText(new Uint8Array(await credit.arrayBuffer()));
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
    expect(await extractPdfText(rerendered)).not.toContain('Renamed Customer AG');
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
    expect(await extractPdfText(new Uint8Array(await res.arrayBuffer()))).toContain('ENTWURF');
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

describe('Books routes: review fixes', () => {
  it('a document of record that fails its check rolls the issue back: still a draft, no number taken', async () => {
    const customer = await newCustomer({ customerType: 'b2b' });
    const id = (await api.createDraft({ customerId: customer.id })).json.document.id;
    await api.addLine(id, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 5000 });
    const scope = scopeFor(env.appDb, env.tgId, tenantId, dir);
    // A writer that drops the recipient's address: the real completeness check refuses it.
    const broken = storeBeforeCommit(scope, { renderPdf: (model) => renderPdf({ ...model, recipientBlock: [] }) });
    const err = await issueDocument(scope, id, { actorUserId: 'user-books' }, { beforeCommit: broken }).catch((e) => e);
    expect(err.code).toBe('RENDER_INCOMPLETE');
    expect(err.details.missing).toEqual(expect.arrayContaining(['recipient.name', 'recipient.addressLine1']));
    const after = await api.get(id);
    expect(after.json.document.status).toBe('draft');
    expect(after.json.document.documentNumber).toBeNull();
    expect(after.json.events.map((e: Json) => e.eventType)).not.toContain('issued');
    expect(await counter()).toBe(62);
    const files = await env.ownerDb.selectFrom('sales_document_file').select('id').where('document_id', '=', id).execute();
    expect(files).toEqual([]);
    // The real route then issues it as 62, PDF stored in the same transaction.
    const issued = await api.issue(id);
    expect(issued.json.document.document.documentNumber).toBe('62');
    expect(issued.json.render.stored).toBe(true);
  });

  it('text the document font cannot print is refused at issue, naming the field; nothing is issued', async () => {
    const customer = await newCustomer({ customerType: 'b2b', name: '中文公司' });
    const id = (await api.createDraft({ customerId: customer.id })).json.document.id;
    await api.addLine(id, { kind: 'service', title: 'Łódź Дмитрий workshop', quantity: 1000, unitPrice: 5000 });
    const res = await api.issue(id);
    expect(res.status).toBe(422);
    expect(res.json.error.code).toBe('undrawable_text');
    expect(res.json.error.fields).toEqual(['recipient.name']);
    expect((await api.get(id)).json.document.status).toBe('draft');
    expect(await counter()).toBe(62);
  });

  it('a name in Polish and Cyrillic is issued and printed exactly as written', async () => {
    const customer = await newCustomer({ customerType: 'b2b', name: 'Żółć Дмитрий Sp. z o.o.' });
    const id = (await api.createDraft({ customerId: customer.id })).json.document.id;
    await api.addLine(id, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 5000 });
    expect((await api.issue(id)).status).toBe(200);
    const text = await extractPdfText(new Uint8Array(await (await pdf(id)).arrayBuffer()));
    expect(text).toContain('Żółć Дмитрий Sp. z o.o.');
  });

  it('the template is frozen at issue: editing it afterwards leaves the re-render byte-identical', async () => {
    const tpl = await call(templatesRoute.POST, 'POST', '/api/books/templates', {}, {
      name: 'Standard',
      accentColor: '#2b4c7e',
      footerBlocks: [{ heading: 'Hinweis', text: 'Original small print.' }],
    });
    const customer = await newCustomer({ customerType: 'b2b' });
    const id = (await api.createDraft({ customerId: customer.id })).json.document.id;
    await api.addLine(id, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 5000 });
    await api.issue(id);
    const stored = new Uint8Array(await (await pdf(id)).arrayBuffer());
    expect(await extractPdfText(stored)).toContain('Original small print.');

    await call(templateRoute.PATCH, 'PATCH', `/api/books/templates/${tpl.json.id}`, { id: tpl.json.id }, {
      accentColor: '#aa0000',
      footerBlocks: [{ text: 'Changed small print.' }],
    });
    const scope = scopeFor(env.appDb, env.tgId, tenantId, dir);
    const view = await getDocument(scope, id);
    expect(view.document.templateSnapshot).toMatchObject({ templateId: tpl.json.id, accentColor: '#2b4c7e' });
    const rerendered = await renderIssuedDocument(scope, view);
    expect(Buffer.from(rerendered).equals(Buffer.from(stored))).toBe(true);
    // And the snapshot is frozen for every role.
    expect(
      await rejectionCode(
        env.ownerDb.updateTable('sales_document').set({ template_snapshot: null }).where('id', '=', id).execute(),
      ),
    ).toBe('BK001');
  });

  it('the document list shows the name an issued document was issued to, not the renamed contact', async () => {
    const customer = await newCustomer({ customerType: 'b2b', name: 'Original Name GmbH' });
    const id = (await api.createDraft({ customerId: customer.id })).json.document.id;
    await api.addLine(id, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 5000 });
    const draftId = (await api.createDraft({ customerId: customer.id })).json.document.id;
    await api.issue(id);
    dir.update(customer.contactId, { name: 'Renamed Later AG' });
    const items = (await api.listDocuments()).json.items as Json[];
    expect(items.find((d) => d.id === id)!.customerName).toBe('Original Name GmbH');
    expect(items.find((d) => d.id === draftId)!.customerName).toBe('Renamed Later AG');
  });

  it('the contact picker marks contacts that are already customers', async () => {
    const existing = await newCustomer({ customerType: 'b2b', name: 'Existing GmbH' });
    const loose = await (state.contactBook as FakeContactBook).create(tenantId, { kind: 'organization', name: 'Loose GmbH' });
    const res = await call(contactsRoute.GET, 'GET', '/api/books/contacts?search=');
    const byId = new Map((res.json.items as Json[]).map((c) => [c.id, c.customerId]));
    expect(byId.get(existing.contactId)).toBe(existing.id);
    expect(byId.get(loose.id)).toBeNull();
  });
});


describe('Books routes: imported historical invoices', () => {
  /** A synthetic original: PDF header, label, trailer. Never a render of this system. */
  function original(label: string): Buffer {
    return Buffer.from(`%PDF-1.4\n% synthetic historical original ${label}\n%%EOF\n`, 'latin1');
  }

  /** Import one synthetic invoice through the domain core the CLI and the planned upload use. */
  async function importOne(
    number: number,
    opts: {
      sender?: string[];
      issueDate?: string;
      lines?: Array<Record<string, unknown>>;
      total?: number;
      currency?: string;
      recipientLines?: string[];
    } = {},
  ) {
    const bytes = original(`${tenantId}-${number}`);
    const plan = planInvoice(
      number,
      {
        number,
        file: `${number}.pdf`,
        otherFiles: [],
        issueDate: opts.issueDate ?? '2021-03-04',
        recipient: { name: 'Example Client GmbH', addressLines: opts.recipientLines ?? ['Beispielweg 2', '20095 Hamburg'], country: 'DE', customerNumber: null },
        recipientVatId: null,
        sender: { name: 'Sample Studio', addressLines: opts.sender ?? ['Musterstrasse 1', '10115 Berlin'], country: 'DE' },
        lines: opts.lines ?? [{ description: 'Design work', quantity: 2, unit: 'h', unitPrice: 60, discount: null, lineTotal: 120 }],
        total: opts.total ?? 120,
        currency: opts.currency ?? 'EUR',
        taxTreatment: 'small_business',
        taxAmounts: null,
        smallBusinessNote: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.',
        paymentTerms: null,
        paidOn: null,
        confidence: 'high',
      },
      new Uint8Array(bytes),
    );
    if (plan.issue !== null) throw new Error(`synthetic invoice not importable: ${plan.issue.reason}`);
    const scope = scopeFor(env.appDb, env.tgId, tenantId, dir);
    const result = await importHistoricalInvoice(scope, state.contactBook as FakeContactBook, plan.record, plan.pdf);
    expect(result.status).toBe('imported');
    return { id: result.documentId, bytes };
  }

  it('the download serves the stored original byte for byte and never renders one', async () => {
    const { id, bytes } = await importOne(12);
    const res = await pdf(id);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-books-of-record')).toBe('true');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Rechnung-12.pdf"');
    expect(res.headers.get('x-books-sha256')).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
    // Asked to render one, the pipeline refuses: the original is the only document of record.
    const scope = scopeFor(env.appDb, env.tgId, tenantId, dir);
    await expect(renderIssuedDocument(scope, await getDocument(scope, id))).rejects.toMatchObject({ code: 'NOT_RENDERABLE' });
    const files = await env.ownerDb.selectFrom('sales_document_file').select('renderer').where('document_id', '=', id).execute();
    expect(files).toEqual([{ renderer: 'import:original-pdf' }]);
  });

  it('the lists and the document show number, date, total, the printed recipient and the import marker', async () => {
    const { id } = await importOne(12);
    dir.update((await getDocument(scopeFor(env.appDb, env.tgId, tenantId, dir), id)).document.customerSnapshot!.contactId, { name: 'Renamed Later AG' });
    const items = (await api.listDocuments()).json.items as Json[];
    expect(items.find((d) => d.id === id)).toMatchObject({
      documentNumber: '12',
      issueDate: '2021-03-04',
      total: 12000,
      status: 'issued',
      source: 'import',
      customerName: 'Example Client GmbH',
      contactStatus: 'ok',
    });
    const detail = await api.get(id);
    expect(detail.status).toBe(200);
    expect(detail.json.document).toMatchObject({ source: 'import', documentNumber: '12', status: 'issued' });
    expect(detail.json.document.customerSnapshot.name).toBe('Example Client GmbH');
    expect(detail.json.lines).toHaveLength(1);
  });

  it('an imported document cannot be edited, given lines, re-numbered or re-pointed; its own sender stays', async () => {
    const first = await importOne(12);
    const second = await importOne(13, { sender: ['Neue Allee 9', '80331 München'], issueDate: '2022-01-10' });
    const before = await api.get(first.id);
    const lineId = before.json.lines[0].id as string;
    for (const res of [
      await api.patch(first.id, { introText: 'changed', expectedVersion: before.json.document.version }),
      await api.addLine(first.id, { kind: 'service', title: 'Extra', quantity: 1000, unitPrice: 100 }),
      await api.editLine(first.id, lineId, { title: 'Changed' }),
      await api.removeLine(first.id, lineId),
      await api.setCustomer(first.id, { customerId: before.json.document.customerId }),
    ]) {
      expect(res.status).toBe(409);
    }
    // Issue answers as for any issued document: already issued, same number, nothing allocated.
    const reissue = await api.issue(first.id);
    expect(reissue.status).toBe(200);
    expect(reissue.json.alreadyIssued).toBe(true);
    expect(reissue.json.document.document.documentNumber).toBe('12');
    expect(await counter()).toBe(62);
    expect(
      await rejectionCode(
        env.ownerDb.updateTable('sales_document').set({ rendered_pdf_file_id: randomUUID() }).where('id', '=', first.id).execute(),
      ),
    ).toBe('BK001');
    const after = await api.get(first.id);
    expect(after.json.document).toEqual(before.json.document);
    expect(after.json.lines).toEqual(before.json.lines);
    // Each imported document keeps the sender printed on it.
    expect(after.json.document.senderSnapshot).toMatchObject({ addressLine1: 'Musterstrasse 1', city: 'Berlin' });
    expect((await api.get(second.id)).json.document.senderSnapshot).toMatchObject({ addressLine1: 'Neue Allee 9', city: 'München' });
  });

  it('an imported invoice with a printed discount line (a minus amount) is cancelled through a credit note too', async () => {
    const { id } = await importOne(14, {
      lines: [
        { description: 'Design work', quantity: 2, unit: 'h', unitPrice: 60, discount: null, lineTotal: 120 },
        { description: 'Rabatt 10 %', quantity: null, unitPrice: null, discount: '10 %', lineTotal: -12 },
      ],
      total: 108,
    });
    expect((await api.get(id)).json.lines.map((l: Json) => l.subtotal)).toEqual([12000, -1200]);
    const res = await api.cancel(id, { reason: 'issued in error' });
    expect(res.status).toBe(200);
    expect(res.json.creditNote.document.total).toBe(10800);
    expect(res.json.creditNote.lines.map((l: Json) => l.subtotal)).toEqual([12000, -1200]);
    const credit = await pdf(res.json.creditNote.document.id);
    expect(credit.headers.get('x-books-of-record')).toBe('true');
    expect(await extractPdfText(new Uint8Array(await credit.arrayBuffer()))).toContain('Storno der Rechnung 14');
  });

  it('an imported invoice printed in CHF keeps CHF in the list, the document and its credit note', async () => {
    const { id, bytes } = await importOne(15, { currency: 'CHF' });
    await importOne(16);
    const items = (await api.listDocuments()).json.items as Json[];
    expect(items.find((d) => d.id === id)).toMatchObject({ currencyCode: 'CHF', total: 12000 });
    expect(items.filter((d) => d.currencyCode === 'EUR').map((d) => d.documentNumber)).toEqual(['16']);
    expect((await api.get(id)).json.document.currencyCode).toBe('CHF');
    expect(Buffer.from(await (await pdf(id)).arrayBuffer()).equals(bytes)).toBe(true);
    const res = await api.cancel(id, { reason: 'issued in error' });
    expect(res.status).toBe(200);
    expect(res.json.creditNote.document).toMatchObject({ currencyCode: 'CHF', total: 12000 });
    const text = await extractPdfText(new Uint8Array(await (await pdf(res.json.creditNote.document.id)).arrayBuffer()));
    expect(text).toContain('CHF');
    expect(text).not.toContain('€');
  });

  it('an import printed without a recipient address can still be cancelled: the credit note takes it from the contact', async () => {
    const { id } = await importOne(17, { recipientLines: [] });
    const snapshot = (await api.get(id)).json.document.customerSnapshot as Json;
    expect(snapshot).toMatchObject({ addressLine1: '', postalCode: '', city: '' });
    // The contact has no address either: refused, naming what is missing, nothing written.
    const refused = await api.cancel(id, { reason: 'issued in error' });
    expect(refused.status).toBe(422);
    expect(refused.json.error.code).toBe('render_incomplete');
    expect((await api.get(id)).json.document.status).toBe('issued');
    // Once the contact has the address, the cancellation goes through with it.
    dir.update(snapshot.contactId, { addressLine1: 'Neue Strasse 9', postalCode: '20095', city: 'Hamburg' });
    const res = await api.cancel(id, { reason: 'issued in error' });
    expect(res.status).toBe(200);
    expect(res.json.creditNote.document.customerSnapshot).toMatchObject({ addressLine1: 'Neue Strasse 9', postalCode: '20095', city: 'Hamburg' });
    // The imported invoice keeps what was printed.
    expect((await api.get(id)).json.document.customerSnapshot).toMatchObject({ addressLine1: '' });
  });

  it('an editor draft cannot be put into another currency', async () => {
    const id = (await api.createDraft({})).json.document.id as string;
    expect(
      await rejectionCode(env.appDb.updateTable('sales_document').set({ currency_code: 'CHF' }).where('id', '=', id).execute()),
    ).toBe('BK009');
  });

  it('an imported invoice is cancelled through a credit note like any other', async () => {
    const { id, bytes } = await importOne(12);
    const res = await api.cancel(id, { reason: 'issued in error' });
    expect(res.status).toBe(200);
    expect(res.json.invoice.document.status).toBe('cancelled');
    expect(res.json.creditNote.document.documentNumber).toBe('GS-1');
    const credit = await pdf(res.json.creditNote.document.id);
    expect(credit.headers.get('x-books-of-record')).toBe('true');
    expect(await extractPdfText(new Uint8Array(await credit.arrayBuffer()))).toContain('Storno der Rechnung 12');
    // The cancelled original is still served unchanged.
    expect(Buffer.from(await (await pdf(id)).arrayBuffer()).equals(bytes)).toBe(true);
  });
});
