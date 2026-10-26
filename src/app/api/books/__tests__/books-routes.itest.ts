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
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  db: null as unknown,
  session: null as unknown,
  directory: null as unknown,
  contactBook: null as unknown,
  /** The permission check's answer (a viewer without editBooks when false). */
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

import { getDocument } from '@/server/books/repository/read';
import { toJsonb } from '@/server/books/snapshots';
import { renderIssuedDocument, storeBeforeCommit } from '@/server/books/render/store';
import { planInvoice } from '@/server/books/importCli';
import { importHistoricalInvoice } from '@/server/books/importInvoices';
import { renderPdf } from '@/server/books/render/pdf';
import { issue as issueDocument } from '@/server/books/issue';
import * as contactsRoute from '../contacts/route';
import { extractDrawnText, extractPdfText } from '@/server/books/render/extractText';
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
import * as correctRoute from '../documents/[id]/correct/route';
import * as pdfRoute from '../documents/[id]/pdf/route';
import * as templatesRoute from '../templates/route';
import * as templateRoute from '../templates/[id]/route';
import * as previewRoute from '../templates/preview/route';
import * as versionsRoute from '../templates/[id]/versions/route';
import { preset } from '@/server/books/template/presets';
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
  correct: (id: string, body: unknown = {}) =>
    call(correctRoute.POST, 'POST', `/api/books/documents/${id}/correct`, { id }, body),
  remove: (id: string, expectedVersion?: number) =>
    call(
      documentRoute.DELETE,
      'DELETE',
      `/api/books/documents/${id}${expectedVersion === undefined ? '' : `?expectedVersion=${expectedVersion}`}`,
      { id },
    ),
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

describe('Books routes: deleting a draft (019_books_draft_delete)', () => {
  /** The rows a document leaves behind, read as the owner (nothing hides them). */
  async function leftovers(id: string) {
    const count = async (table: 'sales_document' | 'sales_document_line' | 'sales_document_event', column: 'id' | 'document_id') =>
      Number(
        (
          await env.ownerDb
            .selectFrom(table)
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .where('tenant_id', '=', tenantId)
            .where(column, '=', id)
            .executeTakeFirstOrThrow()
        ).n,
      );
    return {
      document: await count('sales_document', 'id'),
      lines: await count('sales_document_line', 'document_id'),
      events: await count('sales_document_event', 'document_id'),
    };
  }

  it('forward: a draft with lines goes with its lines and events, and the number series is untouched', async () => {
    const customer = await newCustomer({ customerType: 'b2b' });
    const created = await api.createDraft({ customerId: customer.id });
    const id = created.json.document.id as string;
    await api.addLine(id, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 5000 });
    const before = await api.get(id);
    expect((await leftovers(id)).lines).toBe(1);

    const removed = await api.remove(id, before.json.document.version);
    expect(removed.status).toBe(204);
    expect(await leftovers(id)).toEqual({ document: 0, lines: 0, events: 0 });
    expect((await api.get(id)).status).toBe(404);
    expect(await counter()).toBe(62);
    // The next invoice still takes the next number: a deleted draft consumed nothing.
    const next = (await api.createDraft({ customerId: customer.id })).json.document.id;
    await api.addLine(next, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 5000 });
    expect((await api.issue(next)).json.document.document.documentNumber).toBe('62');
  });

  it('backtrack and revise: a delete with a stale version is refused and deletes nothing; the fresh one goes', async () => {
    const id = (await api.createDraft({})).json.document.id as string;
    const read = await api.get(id);
    await api.addLine(id, { kind: 'service', title: 'Changed meanwhile', quantity: 1000, unitPrice: 100 });
    const stale = await api.remove(id, read.json.document.version);
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('concurrent_edit');
    expect(await leftovers(id)).toEqual({ document: 1, lines: 1, events: 1 });

    const fresh = await api.get(id);
    expect((await api.remove(id, fresh.json.document.version)).status).toBe(204);
  });

  it('resume: after a delete, a reload of the list and of the draft no longer finds it; other drafts stay', async () => {
    const kept = (await api.createDraft({})).json.document.id as string;
    const gone = (await api.createDraft({})).json.document.id as string;
    expect((await api.remove(gone)).status).toBe(204);
    const ids = ((await api.listDocuments()).json.items as Json[]).map((d) => d.id);
    expect(ids).toContain(kept);
    expect(ids).not.toContain(gone);
    expect((await api.get(gone)).status).toBe(404);
    expect((await api.get(kept)).json.document.status).toBe('draft');
  });

  it('re-entry: a second delete is a 404, an issued document is refused for every role and keeps everything', async () => {
    const draft = (await api.createDraft({})).json.document.id as string;
    expect((await api.remove(draft)).status).toBe(204);
    const again = await api.remove(draft);
    expect(again.status).toBe(404);

    const customer = await newCustomer({ customerType: 'b2b' });
    const id = (await api.createDraft({ customerId: customer.id })).json.document.id as string;
    await api.addLine(id, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 5000 });
    await api.issue(id);
    const before = await leftovers(id);
    const refused = await api.remove(id);
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('not_draft');
    // Below the application: the trigger refuses the owner too, and the app role may not touch an event row.
    expect(await rejectionCode(env.ownerDb.deleteFrom('sales_document').where('id', '=', id).execute())).toBe('BK001');
    expect(
      await rejectionCode(env.appDb.deleteFrom('sales_document_event').where('document_id', '=', id).execute()),
    ).toBe('42501');
    expect(
      await rejectionCode(env.ownerDb.deleteFrom('sales_document_event').where('document_id', '=', id).execute()),
    ).toBe('BK002');
    expect(await leftovers(id)).toEqual(before);
  });

  it('a draft that was issued once (an offer gone back to draft) keeps its spent number and is not deleted', async () => {
    const id = (await api.createDraft({})).json.document.id as string;
    // The trail an offer leaves when it is issued and taken back while unsent (007's issued>draft).
    await env.ownerDb
      .insertInto('sales_document_event')
      .values({
        id: randomUUID(),
        tenant_id: tenantId,
        document_id: id,
        event_type: 'issued',
        from_status: 'draft',
        to_status: 'issued',
        actor_user_id: 'user-books',
        payload: toJsonb({}),
        created_at: new Date(),
      })
      .execute();
    const refused = await api.remove(id);
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('not_deletable');
    expect(await rejectionCode(env.ownerDb.deleteFrom('sales_document').where('id', '=', id).execute())).toBe('BK016');
    expect((await leftovers(id)).document).toBe(1);
  });

  it('a draft another document refers to stays, with its lines and events, until that document goes', async () => {
    const id = (await api.createDraft({})).json.document.id as string;
    await api.addLine(id, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 5000 });
    const row = await env.ownerDb.selectFrom('sales_document').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    const creditId = randomUUID();
    await env.ownerDb
      .insertInto('sales_document')
      .values({ ...row, id: creditId, doc_type: 'credit_note', corrects_document_id: id, version: 0 } as never)
      .execute();
    const before = await leftovers(id);
    const refused = await api.remove(id);
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('not_deletable');
    expect(await leftovers(id)).toEqual(before);
    // Once the referencing draft is gone, the draft can go too.
    expect((await api.remove(creditId)).status).toBe(204);
    expect((await api.remove(id)).status).toBe(204);
  });

  it('another company cannot delete a draft by its id', async () => {
    const id = (await api.createDraft({})).json.document.id as string;
    const owner = tenantId;
    await company();
    expect((await api.remove(id)).status).toBe(404);
    tenantId = owner;
    expect((await leftovers(id)).document).toBe(1);
  });

  it('a malformed expectedVersion is a 400 and deletes nothing', async () => {
    const id = (await api.createDraft({})).json.document.id as string;
    const res = await documentRoute.DELETE(request('DELETE', `/api/books/documents/${id}?expectedVersion=-1`), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(400);
    expect((await leftovers(id)).document).toBe(1);
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

  it('the subject: saved as one line, refused with a line break or past 200 characters, frozen at issue', async () => {
    const customer = await newCustomer({ customerType: 'b2b' });
    const draft = await api.createDraft({ customerId: customer.id, subject: 'Website-Relaunch' });
    const id = draft.json.document.id as string;
    expect(draft.json.document.subject).toBe('Website-Relaunch');
    // The built-in Klassisch layout (no template of the company's own yet) prints the subject.
    expect((await api.get(id)).json.printsSubject).toBe(true);
    const v = draft.json.document.version as number;

    const broken = await api.patch(id, { subject: 'Zeile eins\nZeile zwei', expectedVersion: v });
    expect(broken.status).toBe(400);
    expect(broken.json.error.code).toBe('invalid_input');
    const long = await api.patch(id, { subject: 'x'.repeat(201), expectedVersion: v });
    expect(long.json.error.code).toBe('invalid_input');
    // The column's CHECK holds for every writer, the owner included.
    expect(
      await rejectionCode(env.ownerDb.updateTable('sales_document').set({ subject: 'x'.repeat(201) }).where('id', '=', id).execute()),
    ).toBe('23514');

    const changed = await api.patch(id, { subject: 'Website-Relaunch, Phase 1', expectedVersion: v });
    expect(changed.status).toBe(200);
    expect(changed.json.document.subject).toBe('Website-Relaunch, Phase 1');
    await api.addLine(id, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 5000 });
    expect((await api.issue(id)).status).toBe(200);
    expect(
      await rejectionCode(env.ownerDb.updateTable('sales_document').set({ subject: 'nachträglich' }).where('id', '=', id).execute()),
    ).toBe('BK001');
    expect((await api.get(id)).json.document.subject).toBe('Website-Relaunch, Phase 1');
  });

  it('a subject the document font cannot print is refused at issue, naming the subject', async () => {
    const customer = await newCustomer({ customerType: 'b2b' });
    const id = (await api.createDraft({ customerId: customer.id, subject: '中文 Betreff' })).json.document.id;
    await api.addLine(id, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 5000 });
    const res = await api.issue(id);
    expect(res.status).toBe(422);
    expect(res.json.error.fields).toEqual(['subject']);
    expect((await api.get(id)).json.document.status).toBe('draft');
  });

  it('formatted texts: the server derives the plain words, keeps a format only when it is needed, and freezes it at issue', async () => {
    const customer = await newCustomer({ customerType: 'b2b' });
    const id = (await api.createDraft({ customerId: customer.id })).json.document.id as string;
    let v = (await api.get(id)).json.document.version as number;
    const intro = {
      v: 1,
      blocks: [
        { kind: 'paragraph', runs: [{ text: 'Vielen ' }, { text: 'Dank', bold: true }, { text: ' für' }, { text: ' Ihren ' }, { text: 'Auftrag', italic: true }] },
        { kind: 'bullet', runs: [{ text: 'Konzeption' }] },
        { kind: 'paragraph', runs: [] },
      ],
    };
    const formatted = await api.patch(id, { introFormat: intro, expectedVersion: v });
    expect(formatted.status).toBe(200);
    // Plain words from the runs, one line per block; the format normalised (runs of one style merged, the trailing
    // blank line gone).
    expect(formatted.json.document.introText).toBe('Vielen Dank für Ihren Auftrag\nKonzeption');
    expect(formatted.json.document.introFormat).toEqual({
      v: 1,
      blocks: [
        { kind: 'paragraph', runs: [{ text: 'Vielen ' }, { text: 'Dank', bold: true }, { text: ' für Ihren ' }, { text: 'Auftrag', italic: true }] },
        { kind: 'bullet', runs: [{ text: 'Konzeption' }] },
      ],
    });
    v = formatted.json.document.version;

    // One unformatted line needs no format; a plain text with line breaks keeps them as paragraphs.
    const oneLine = await api.patch(id, { introFormat: { v: 1, blocks: [{ kind: 'paragraph', runs: [{ text: 'Nur eine Zeile.' }] }] }, expectedVersion: v });
    expect(oneLine.json.document).toMatchObject({ introText: 'Nur eine Zeile.', introFormat: null });
    v = oneLine.json.document.version;
    const typed = await api.patch(id, { outroText: 'Mit freundlichen Grüßen\nIhr Team', expectedVersion: v });
    expect(typed.json.document.outroFormat).toEqual({
      v: 1,
      blocks: [
        { kind: 'paragraph', runs: [{ text: 'Mit freundlichen Grüßen' }] },
        { kind: 'paragraph', runs: [{ text: 'Ihr Team' }] },
      ],
    });
    v = typed.json.document.version;

    // A pasted text of many lines, and a lone carriage return: stored in a shape that reads back, and the document
    // list (which reads every row) still loads.
    const pasted = Array.from({ length: 250 }, (_, i) => `Zeile ${i + 1}`).join('\n');
    const long = await api.patch(id, { introText: pasted, expectedVersion: v });
    expect(long.status).toBe(200);
    expect((await api.get(id)).json.document.introText).toBe(pasted);
    const cr = await api.patch(id, { introText: 'Eins\rZwei', expectedVersion: long.json.document.version });
    expect(cr.json.document.introText).toBe('Eins\nZwei');
    expect((await api.listDocuments()).status).toBe(200);
    v = cr.json.document.version;

    // Never both, never a shape the engine cannot draw; the database refuses a stray shape from any writer.
    const both = await api.patch(id, { introText: 'x', introFormat: intro, expectedVersion: v });
    expect(both.status).toBe(400);
    expect(both.json.error.code).toBe('invalid_input');
    const broken = await api.patch(id, { introFormat: { v: 1, blocks: [{ kind: 'paragraph', runs: [{ text: 'a\nb' }] }] }, expectedVersion: v });
    expect(broken.status).toBe(400);
    expect(
      await rejectionCode(env.ownerDb.updateTable('sales_document').set({ intro_format: sql`'"x"'::jsonb` as never }).where('id', '=', id).execute()),
    ).toBe('23514');

    // Issued with an italic run: the stored PDF embeds an italic face, and the format is frozen.
    const italic = await api.patch(id, { introFormat: intro, expectedVersion: v });
    await api.addLine(id, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 5000 });
    expect(italic.status).toBe(200);
    const issuedRes = await api.issue(id);
    expect(issuedRes.status, JSON.stringify(issuedRes.json)).toBe(200);
    const bytes = new Uint8Array(await (await pdf(id)).arrayBuffer());
    expect((await extractDrawnText(bytes)).some((d) => /Oblique|Italic/.test(d.font) && d.text.includes('Auftrag'))).toBe(true);
    expect(
      await rejectionCode(env.ownerDb.updateTable('sales_document').set({ intro_format: null }).where('id', '=', id).execute()),
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

  it('templates: the first is the default, new drafts get it, one a draft uses cannot be removed, removing archives', async () => {
    const created = await call(templatesRoute.POST, 'POST', '/api/books/templates', {}, {
      name: 'Standard',
      document: layout({ accent: '#2b4c7e', smallPrint: [{ heading: 'Hinweis', text: 'Synthetic small print.' }] }),
    });
    expect(created.status).toBe(201);
    expect(created.json.isDefault).toBe(true);
    expect(created.json).toMatchObject({ version: 1, accentColor: '#2b4c7e' });
    expect(created.json.document.regions.body.at(-1)).toMatchObject({ heading: 'Hinweis', text: 'Synthetic small print.' });
    expect(created.json.document).toMatchObject({ v: 2, theme: { accent: '#2b4c7e' } });
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
    // Archived: gone from the list and the picker, no longer the default, its name free again, its versions kept.
    const after = await call(templatesRoute.GET, 'GET', '/api/books/templates');
    expect(after.json.items.map((t: Json) => t.name)).toEqual(['Standard']);
    expect((await call(templateRoute.GET, 'GET', `/api/books/templates/${second.json.id}`, { id: second.json.id })).status).toBe(404);
    const again = await call(templatesRoute.POST, 'POST', '/api/books/templates', {}, { name: 'Alt' });
    expect(again.status).toBe(201);
    const versions = await env.ownerDb.selectFrom('document_template_version').select('id').where('template_id', '=', second.json.id).execute();
    expect(versions).toHaveLength(1);
    const pick = await api.createDraft({ templateId: second.json.id });
    expect(pick.status).toBe(404);
    expect(pick.json.error.code).toBe('template_not_found');
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
    expect(listed.json).toMatchObject({ total: 1, nextCursor: null });
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
      document: layout({ accent: '#2b4c7e', smallPrint: [{ heading: 'Hinweis', text: 'Original small print.' }] }),
    });
    const customer = await newCustomer({ customerType: 'b2b' });
    const id = (await api.createDraft({ customerId: customer.id })).json.document.id;
    await api.addLine(id, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 5000 });
    await api.issue(id);
    const stored = new Uint8Array(await (await pdf(id)).arrayBuffer());
    expect(await extractPdfText(stored)).toContain('Original small print.');

    await call(templateRoute.PATCH, 'PATCH', `/api/books/templates/${tpl.json.id}`, { id: tpl.json.id }, {
      document: layout({ from: tpl.json.document, accent: '#aa0000', smallPrint: [{ text: 'Changed small print.' }] }),
    });
    const scope = scopeFor(env.appDb, env.tgId, tenantId, dir);
    const view = await getDocument(scope, id);
    expect(view.document.templateSnapshot).toMatchObject({
      v: 2,
      templateId: tpl.json.id,
      templateVersionId: tpl.json.currentVersionId,
      document: { theme: { accent: '#2b4c7e' } },
    });
    const files = await env.ownerDb.selectFrom('sales_document_file').select('renderer').where('document_id', '=', id).execute();
    expect(files).toEqual([{ renderer: 'books-pdf-lib-3' }]);
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


describe('Books routes: template versions and the preview', () => {
  const tplPath = (id: string) => `/api/books/templates/${id}`;
  const patchTemplate = (id: string, body: unknown) => call(templateRoute.PATCH, 'PATCH', tplPath(id), { id }, body);
  const versionsOf = (id: string) =>
    env.ownerDb
      .selectFrom('document_template_version')
      .select(['version', 'created_by'])
      .where('template_id', '=', id)
      .orderBy('version')
      .execute();

  it('saves a changed layout as the next version, and nothing for an unchanged one', async () => {
    const created = await call(templatesRoute.POST, 'POST', '/api/books/templates', {}, { name: 'Modern', preset: 'modern' });
    expect(created.status).toBe(201);
    expect(created.json.document).toEqual(preset('modern'));
    const id = created.json.id as string;

    const same = await patchTemplate(id, { document: created.json.document });
    expect(same.json.version).toBe(1);
    const renamed = await patchTemplate(id, { name: 'Modern blau' });
    expect(renamed.json).toMatchObject({ name: 'Modern blau', version: 1 });

    const changed = await patchTemplate(id, { document: layout({ from: created.json.document, accent: '#1f4e79', smallPrint: [{ text: 'Neue Hinweise.' }] }) });
    expect(changed.json).toMatchObject({ version: 2, accentColor: '#1f4e79' });
    expect(changed.json.document.regions.body.at(-1)).toMatchObject({ heading: null, text: 'Neue Hinweise.' });
    expect(changed.json.currentVersionId).not.toBe(created.json.currentVersionId);
    expect(await versionsOf(id)).toEqual([
      { version: 1, created_by: 'user-books' },
      { version: 2, created_by: 'user-books' },
    ]);

    // A whole document from the composer, made on the current version.
    const doc = structuredClone(changed.json.document);
    doc.page.addressLayout = 'din5008-a';
    const saved = await patchTemplate(id, { document: doc, baseVersionId: changed.json.currentVersionId });
    expect(saved.status).toBe(200);
    expect(saved.json.version).toBe(3);
  });

  it('two first templates created at once: both saved, exactly one default', async () => {
    const [a, b] = await Promise.all([
      call(templatesRoute.POST, 'POST', '/api/books/templates', {}, { name: 'Eins' }),
      call(templatesRoute.POST, 'POST', '/api/books/templates', {}, { name: 'Zwei' }),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect([a.json.isDefault, b.json.isDefault].filter(Boolean)).toHaveLength(1);
  });

  it('refuses an edit made on an older version, and a layout the gate refuses; the working version stays', async () => {
    const created = await call(templatesRoute.POST, 'POST', '/api/books/templates', {}, { name: 'Standard' });
    const id = created.json.id as string;
    await patchTemplate(id, { document: layout({ from: created.json.document, accent: '#1f4e79' }) });

    const stale = await patchTemplate(id, { document: created.json.document, baseVersionId: created.json.currentVersionId });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('concurrent_edit');

    const broken = structuredClone(created.json.document);
    broken.regions.body = broken.regions.body.filter((b: Json) => b.type !== 'totals');
    const refused = await patchTemplate(id, { document: broken });
    expect(refused.status).toBe(422);
    expect(refused.json.error.code).toBe('template_invalid');
    expect(refused.json.error.problems).toContainEqual(expect.objectContaining({ code: 'REQUIRED_BLOCK_MISSING', field: 'totals' }));

    const pale = await patchTemplate(id, { document: layout({ from: created.json.document, accent: '#ffee00' }) });
    expect(pale.status).toBe(422);
    expect(pale.json.error.problems).toContainEqual(expect.objectContaining({ code: 'CONTRAST_TOO_LOW', field: 'theme.accent' }));
    expect((await versionsOf(id)).map((v) => v.version)).toEqual([1, 2]);

    const malformed = await patchTemplate(id, { document: { v: 2 } });
    expect(malformed.status).toBe(400);
    expect(malformed.json.error.code).toBe('invalid_input');
  });

  it('a draft previews the current version of its template', async () => {
    const created = await call(templatesRoute.POST, 'POST', '/api/books/templates', {}, { name: 'Standard', document: layout({ smallPrint: [{ text: 'Erste Fassung.' }] }) });
    const customer = await newCustomer({ customerType: 'b2b' });
    const id = (await api.createDraft({ customerId: customer.id })).json.document.id;
    await api.addLine(id, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 5000 });
    expect(await extractPdfText(new Uint8Array(await (await pdf(id)).arrayBuffer()))).toContain('Erste Fassung.');
    await patchTemplate(created.json.id, { document: layout({ from: created.json.document, smallPrint: [{ text: 'Zweite Fassung.' }] }) });
    const text = await extractPdfText(new Uint8Array(await (await pdf(id)).arrayBuffer()));
    expect(text).toContain('Zweite Fassung.');
    expect(text).not.toContain('Erste Fassung.');
  });

  it('a document frozen with a version 1 template is still drawn by the version 1 renderer', async () => {
    const customer = await newCustomer({ customerType: 'b2b' });
    const id = (await api.createDraft({ customerId: customer.id })).json.document.id;
    await api.addLine(id, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 5000 });
    await api.issue(id);
    // Turn it into a document issued before the template model version 2 and before 008 (no stored file yet).
    const owner = env.fx.owner;
    const s = owner(env.schema);
    await owner`ALTER TABLE ${s}.sales_document DISABLE TRIGGER USER`;
    await owner`ALTER TABLE ${s}.sales_document_file DISABLE TRIGGER USER`;
    try {
      await owner`UPDATE ${s}.sales_document SET rendered_pdf_file_id = NULL,
                    template_snapshot = ${owner.json({ v: 1, templateId: null, name: 'Alt', accentColor: '#2b4c7e', footerBlocks: [{ heading: null, text: 'Kleingedrucktes von früher.' }] })}
                  WHERE id = ${id}`;
      await owner`DELETE FROM ${s}.sales_document_file WHERE document_id = ${id}`;
    } finally {
      await owner`ALTER TABLE ${s}.sales_document ENABLE TRIGGER USER`;
      await owner`ALTER TABLE ${s}.sales_document_file ENABLE TRIGGER USER`;
    }
    const res = await pdf(id);
    expect(res.status).toBe(200);
    expect(await extractPdfText(new Uint8Array(await res.arrayBuffer()))).toContain('Kleingedrucktes von früher.');
    const files = await env.ownerDb.selectFrom('sales_document_file').select('renderer').where('document_id', '=', id).execute();
    expect(files).toEqual([{ renderer: 'books-pdf-lib-2' }]);
  });

  it('previews an unsaved template against a sample and a real document, stamped and never stored', async () => {
    const doc = preset('kompakt');
    const sample = await previewCall({ document: doc, subject: { kind: 'sample', variant: 'longInvoice' } });
    expect(sample.status).toBe(200);
    expect(sample.headers.get('cache-control')).toBe('no-store');
    const body = (await sample.json()) as Json;
    const bytes = new Uint8Array(Buffer.from(body.pdf, 'base64'));
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
    expect(body.layout.pageCount).toBeGreaterThanOrEqual(2);
    expect(body.layout.blocks.some((r: Json) => r.blockId === 'lineTable')).toBe(true);
    expect(typeof body.renderMs).toBe('number');
    expect(await extractPdfText(bytes)).toContain('VORSCHAU, KEIN BELEG');

    const customer = await newCustomer({ customerType: 'b2b' });
    const id = (await api.createDraft({ customerId: customer.id })).json.document.id;
    await api.addLine(id, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 5000 });
    await api.issue(id);
    const filesBefore = await env.ownerDb.selectFrom('sales_document_file').select('id').execute();
    // An incomplete layout previews as it is, with its problems in the map.
    const incomplete = structuredClone(doc);
    incomplete.regions.firstPageHeader = Array.from({ length: 5 }, (_, i) => ({ id: `h${i}`, type: 'spacer' as const, style: {}, heightPt: 32 as const }));
    const real = await previewCall({ document: incomplete, subject: { kind: 'document', documentId: id } });
    expect(real.status).toBe(200);
    const realBody = (await real.json()) as Json;
    expect(realBody.layout.issues).toContainEqual(expect.objectContaining({ code: 'HEADER_TOO_TALL' }));
    const realText = await extractPdfText(new Uint8Array(Buffer.from(realBody.pdf, 'base64')));
    expect(realText).toContain('VORSCHAU, KEIN BELEG');
    expect(realText).toContain('Workshop');
    expect(await env.ownerDb.selectFrom('sales_document_file').select('id').execute()).toEqual(filesBefore);
  });

  it('refuses malformed and oversized previews, a document of another company, and anyone without editBooks', async () => {
    const malformed = await previewCall({ document: { v: 2 }, subject: { kind: 'sample', variant: 'regular' } });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as Json).error.code).toBe('invalid_input');
    const unknown = await previewCall({ document: preset('klassisch'), subject: { kind: 'sample', variant: 'nope' } });
    expect(unknown.status).toBe(400);
    const huge = await previewCall({ document: preset('klassisch'), subject: { kind: 'sample', variant: 'regular' }, pad: 'x'.repeat(300 * 1024) });
    expect(huge.status).toBe(413);
    // A streamed body without Content-Length is bounded too.
    const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= 10) return c.close();
        sent += 1;
        c.enqueue(chunk);
      },
    });
    const streamed = await previewRoute.POST(
      new Request('http://localhost:3000/api/books/templates/preview', {
        method: 'POST',
        headers: { host: 'localhost:3000', cookie: 'lumitra_session=s', 'content-type': 'application/json' },
        body: stream,
        duplex: 'half',
      } as RequestInit),
      { params: Promise.resolve({}) },
    );
    expect(streamed.status).toBe(413);
    expect(sent).toBeLessThan(10);

    const customer = await newCustomer({ customerType: 'b2b' });
    const id = (await api.createDraft({ customerId: customer.id })).json.document.id;
    const mine = tenantId;
    await company();
    const foreign = await previewCall({ document: preset('klassisch'), subject: { kind: 'document', documentId: id } });
    expect(foreign.status).toBe(404);
    expect(mine).not.toBe(tenantId);

    state.can = false;
    const viewer = await previewCall({ document: preset('klassisch'), subject: { kind: 'sample', variant: 'regular' } });
    expect(viewer.status).toBe(403);
    state.can = true;
    state.session = null;
    const anonymous = await previewCall({ document: preset('klassisch'), subject: { kind: 'sample', variant: 'regular' } });
    expect(anonymous.status).toBe(401);
  });
  it('lists the versions newest first, each with the issued documents frozen with it', async () => {
    const created = await call(templatesRoute.POST, 'POST', '/api/books/templates', {}, { name: 'Standard' });
    const id = created.json.id as string;
    const customer = await newCustomer({ customerType: 'b2b' });
    const issued = (await api.createDraft({ customerId: customer.id })).json.document.id;
    await api.addLine(issued, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 5000 });
    await api.issue(issued);
    // A draft is not counted: it freezes a version only at issue.
    const draft = (await api.createDraft({ customerId: customer.id })).json.document.id;
    await api.addLine(draft, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 5000 });
    await patchTemplate(id, { document: layout({ from: created.json.document, accent: '#1f4e79' }) });

    const res = await call(versionsRoute.GET, 'GET', `${tplPath(id)}/versions`, { id });
    expect(res.status).toBe(200);
    expect(res.json.items).toEqual([
      expect.objectContaining({ version: 2, current: true, documentCount: 0 }),
      expect.objectContaining({ id: created.json.currentVersionId, version: 1, current: false, documentCount: 1 }),
    ]);
    expect(Number.isNaN(Date.parse(res.json.items[0].createdAt))).toBe(false);

    const mine = tenantId;
    await company();
    const foreign = await call(versionsRoute.GET, 'GET', `${tplPath(id)}/versions`, { id });
    expect(foreign.status).toBe(404);
    expect(foreign.json.error.code).toBe('template_not_found');
    expect(mine).not.toBe(tenantId);
  });

  it('an archived template has no version list', async () => {
    await call(templatesRoute.POST, 'POST', '/api/books/templates', {}, { name: 'Standard' });
    const second = await call(templatesRoute.POST, 'POST', '/api/books/templates', {}, { name: 'Zweite' });
    const id = second.json.id as string;
    expect((await call(templateRoute.DELETE, 'DELETE', tplPath(id), { id })).status).toBe(204);
    const res = await call(versionsRoute.GET, 'GET', `${tplPath(id)}/versions`, { id });
    expect(res.status).toBe(404);
  });

  it('a preview carries the structural problems of the unsaved layout, and none for a preset', async () => {
    const clean = await previewCall({ document: preset('modern'), subject: { kind: 'sample', variant: 'regular' } });
    expect(((await clean.json()) as Json).problems).toEqual([]);
    const broken = structuredClone(preset('klassisch'));
    broken.regions.body = broken.regions.body.filter((b) => b.type !== 'totals');
    const res = await previewCall({ document: broken, subject: { kind: 'sample', variant: 'regular' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(body.problems).toContainEqual(expect.objectContaining({ code: 'REQUIRED_BLOCK_MISSING', field: 'totals' }));
    // It still renders: the composer shows the incomplete layout with what is wrong.
    expect(body.layout.pageCount).toBeGreaterThanOrEqual(1);
  });
});

async function previewCall(body: unknown): Promise<Response> {
  return previewRoute.POST(request('POST', '/api/books/templates/preview', body), { params: Promise.resolve({}) });
}

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

  it('the documents list reaches every document page by page, counts them all, and finds by number and year', async () => {
    // Not UTC: a timestamp parameter the driver converted through a local Date shifted the cursor by
    // the offset and dropped rows sharing the last row's date (the servers in CI run in UTC, so pin it).
    const tz = process.env.TZ;
    process.env.TZ = 'Europe/Berlin';
    // The pin must take effect (it does not inside a worker thread): otherwise this test proves nothing.
    expect(new Date('2021-01-01 00:00:00').getTimezoneOffset()).not.toBe(0);
    try {
      // 61 imported invoices, 1 to 61 (55 in 2021, 6 in 2022), and 3 drafts, which come first and have no issue date.
      for (let n = 1; n <= 61; n += 1) {
        const year = n <= 55 ? 2021 : 2022;
        await importOne(n, { issueDate: `${year}-03-${String(((n - 1) % 28) + 1).padStart(2, '0')}` });
      }
      const drafts: string[] = [];
      for (let i = 0; i < 3; i += 1) drafts.push(((await api.createDraft()).json.document as Json).id as string);

      /** Every page of a query, with each page's total. */
      const walk = async (filters: string) => {
        const seen: Json[] = [];
        const totals: number[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const sep: string = filters ? '&' : '?';
          const res = await call(documentsRoute.GET, 'GET', `/api/books/documents${filters ? `?${filters}` : ''}${cursor ? `${sep}cursor=${encodeURIComponent(cursor)}` : ''}`);
          expect(res.status).toBe(200);
          totals.push(res.json.total as number);
          seen.push(...(res.json.items as Json[]));
          cursor = res.json.nextCursor as string | null;
          pages += 1;
        } while (cursor && pages < 5);
        return { seen, totals, pages };
      };

      // All 64 over two pages: the drafts first, then the issued ones, each once.
      const all = await walk('');
      expect(all.pages).toBe(2);
      expect(all.totals).toEqual([64, 64]);
      expect(new Set(all.seen.map((d) => d.id)).size).toBe(64);
      expect(all.seen.slice(0, 3).map((d) => d.id).sort()).toEqual([...drafts].sort());
      expect(all.seen.map((d) => d.documentNumber)).toContain('1');

      // A filter with more than one page of matches pages too, and this page boundary splits two invoices
      // of the same date (31 and 3, 2021-03-03): the cursor must keep the second. A year never includes a draft.
      const y2021 = await walk('year=2021');
      expect(y2021.pages).toBe(2);
      expect(y2021.totals).toEqual([55, 55]);
      expect(new Set(y2021.seen.map((d) => d.id)).size).toBe(55);
      expect(y2021.seen.every((d) => String(d.issueDate).startsWith('2021'))).toBe(true);
      expect(y2021.seen.some((d) => drafts.includes(d.id as string))).toBe(false);

      const byNumber = await walk('number=17');
      expect(byNumber.seen.map((d) => d.documentNumber)).toEqual(['17']);
      expect(byNumber.totals).toEqual([1]);
      const both = await walk('number=6&year=2022');
      expect(both.seen.map((d) => d.documentNumber).sort()).toEqual(['56', '60', '61']);
      // LIKE wildcards and the escape character in the search are taken literally.
      for (const literal of ['%25', '_', '%5C']) {
        expect((await call(documentsRoute.GET, 'GET', `/api/books/documents?number=${literal}`)).json.total).toBe(0);
      }
      expect((await call(documentsRoute.GET, 'GET', '/api/books/documents?year=22')).status).toBe(400);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  }, 120_000);

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

describe('POST /documents/:id/correct and the replacement issue (the Correct flow)', () => {
  async function issuedInvoice(): Promise<string> {
    const customer = await newCustomer({ customerType: 'b2b' });
    const draft = await api.createDraft({ customerId: customer.id });
    expect(draft.status).toBe(201);
    const id = draft.json.document.id as string;
    expect((await api.addLine(id, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 9000 })).status).toBe(201);
    expect((await api.issue(id)).status).toBe(200);
    return id;
  }

  it('creates the replacement draft (201), reopens it (200), and its issue cancels the old invoice with stored PDFs', async () => {
    const invoiceId = await issuedInvoice();
    const created = await api.correct(invoiceId);
    expect(created.status).toBe(201);
    expect(created.json.existing).toBe(false);
    const draftId = created.json.document.document.id as string;
    expect(created.json.document.document.replacesDocumentId).toBe(invoiceId);
    expect(created.json.document.related.replaces).toMatchObject({ id: invoiceId, documentNumber: '62' });
    expect(created.json.document.customer).not.toBeNull();

    const again = await api.correct(invoiceId);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ existing: true, document: { document: { id: draftId } } });

    const issued = await api.issue(draftId, { expectedVersion: created.json.document.document.version });
    expect(issued.status).toBe(200);
    expect(issued.json.document.document.documentNumber).toBe('63');
    expect(issued.json.replaced.invoiceId).toBe(invoiceId);
    expect(issued.json.render.stored).toBe(true);
    const creditNoteId = issued.json.replaced.creditNoteId as string;
    const old = await api.get(invoiceId);
    expect(old.json.document.status).toBe('cancelled');
    expect(old.json.related).toMatchObject({ correctedBy: { id: creditNoteId }, replacedBy: { id: draftId, documentNumber: '63' } });
    for (const id of [draftId, creditNoteId]) {
      const res = await pdf(id);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-books-of-record')).toBe('true');
    }
    expect(await counter('invoice')).toBe(64);
    expect(await counter('credit_note')).toBe(2);
  });

  it('refuses what cannot be corrected (409 not_correctable), unknown fields (400), and a replaced invoice cancelled meanwhile (409)', async () => {
    const invoiceId = await issuedInvoice();
    expect((await api.correct(invoiceId, { reason: 'x' })).status).toBe(400);
    const draft = await api.createDraft();
    const refused = await api.correct(draft.json.document.id);
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('not_correctable');

    const created = await api.correct(invoiceId);
    const draftId = created.json.document.document.id as string;
    expect((await api.cancel(invoiceId, { reason: 'Wrong recipient' })).status).toBe(200);
    const late = await api.issue(draftId);
    expect(late.status).toBe(409);
    expect(late.json.error.code).toBe('replaced_invoice_cancelled');
    // The way forward: issue it as an ordinary invoice.
    const detached = await api.patch(draftId, { replacesDocumentId: null });
    expect(detached.status).toBe(200);
    expect(detached.json.document.replacesDocumentId).toBeNull();
    expect((await api.issue(draftId)).json.document.document.documentNumber).toBe('63');
    // PATCH never sets a link, it only removes one.
    expect((await api.patch(draftId, { replacesDocumentId: invoiceId })).status).toBe(400);
  });
});

/**
 * A layout as the composer would send it: a document (Klassisch, or the given
 * one) with another accent colour and small print at the end of the body.
 */
function layout(opts: { from?: Json; accent?: string; smallPrint?: Array<{ heading?: string | null; text: string }> } = {}): Json {
  const doc = structuredClone(opts.from ?? preset('klassisch')) as Json;
  if (opts.accent) doc.theme.accent = opts.accent;
  if (opts.smallPrint) {
    doc.regions.body = [
      ...doc.regions.body.filter((b: Json) => !(b.type === 'freeText' && b.variant === 'smallPrint')),
      ...opts.smallPrint.map((b, i) => ({ id: `smallPrint${i + 1}`, type: 'freeText', style: {}, heading: b.heading ?? null, text: b.text, variant: 'smallPrint' })),
    ];
  }
  return doc;
}

