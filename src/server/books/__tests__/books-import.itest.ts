// src/server/books/__tests__/books-import.itest.ts
//
// `pnpm books:import` end to end (Books plan, "Historical import build notes
// (2026-10-20)"): the real argument parsing, a temporary input file and
// synthetic originals on disk, the import as commerce_app against a provisioned
// tenant schema, the fake contacts database. The paths of the stateful-flow
// standard: forward, re-run (idempotence), a changed file refused, resume of a
// skipped invoice, and the whole-run refusals (counter missing or too low, dry
// run) that write nothing. Plus what 009_books_import guarantees at the
// database, proven as the owner (the role every other role is weaker than). The download, list and freeze through the real routes are in
// books-routes.itest.ts. Synthetic data only: invented names and addresses.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { exitCodeFor, runBooksImport, type Env, type ImportReport } from '../importCli';
import { issue } from '../issue';
import { createDraft } from '../repository/documents';
import { addLine } from '../repository/lines';
import { importHistoricalInvoice, newImportSession, type HistoricalInvoiceInput } from '../importInvoices';
import { readSettings } from '../settings';
import { getDocument, listDocuments } from '../repository/read';
import {
  ACTOR,
  FakeContactBook,
  FakeDirectory,
  initCompany,
  newCustomer,
  newTenantId,
  openBooksEnv,
  rejectionCode,
  scopeFor,
  type BooksEnv,
} from './booksFixtures';

let env: BooksEnv;
let work: string;

beforeAll(async () => {
  env = await openBooksEnv('books-import');
  work = mkdtempSync(join(tmpdir(), 'books-import-'));
}, 120_000);

afterAll(async () => {
  if (work) rmSync(work, { recursive: true, force: true });
  await env?.close();
});

const cliEnv = (): Env => ({ COMMERCE_APP_DATABASE_URL: process.env.COMMERCE_APP_DATABASE_URL });

/** A synthetic original: a PDF header, a label and a trailer (bytes unique per label). */
function pdfBytes(label: string): Buffer {
  return Buffer.from(`%PDF-1.4\n% synthetic original ${label}\n%%EOF\n`, 'latin1');
}

const SENDER_BERLIN = { name: 'Sample Studio', addressLines: ['Musterstrasse 1', '10115 Berlin'], country: 'DE', taxNumberPresent: true, vatIdPresent: false };
const SENDER_MUNICH = { name: 'Sample Studio', addressLines: ['Neue Allee 9', '80331 München'], country: 'DE', taxNumberPresent: true, vatIdPresent: false };

function invoice(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    file: `pdf/${number}.pdf`,
    fileRole: 'original',
    otherFiles: [],
    issueDate: '2019-02-01',
    serviceDate: null,
    servicePeriod: null,
    recipient: {
      name: 'Example Client GmbH',
      addressLines: ['Example Client GmbH', 'Beispielweg 2', '20095 Hamburg'],
      country: null,
      countryInferred: 'DE',
      customerNumber: '1001',
    },
    recipientVatId: null,
    sender: SENDER_BERLIN,
    lines: [{ description: 'Design work', quantity: 2, unit: 'h', unitPrice: 60, discount: null, lineTotal: 120 }],
    total: 120,
    currency: 'EUR',
    taxTreatment: 'small_business',
    taxAmounts: null,
    smallBusinessNote: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.',
    paymentTerms: 'zahlbar innerhalb von 14 Tagen',
    paidOn: '2019-02-10',
    paymentEvidence: null,
    declaredInReturn: true,
    notes: [],
    confidence: 'high',
    confidenceReason: 'synthetic',
    ...overrides,
  };
}

/** The synthetic series: two clients (one moved), a sender that moved, and number 60 still without its file. */
function series(): Array<Record<string, unknown>> {
  return [
    invoice(1),
    invoice(2, {
      issueDate: '2019-11-15',
      recipient: { name: 'Erika Beispiel', addressLines: ['Probeweg 5', '50667 Köln'], country: 'DE', countryInferred: 'DE', customerNumber: null },
      sender: SENDER_MUNICH,
      otherFiles: ['pdf/2-earlier.pdf'],
      lines: [
        { description: 'Workshop', quantity: 1, unit: 'Tag', unitPrice: 250, discount: null, lineTotal: 250 },
        { description: 'Travel', quantity: 1, unit: 'Stk', unitPrice: 50, discount: null, lineTotal: 50 },
      ],
      total: 300,
      paidOn: null,
    }),
    invoice(3, {
      issueDate: '2020-05-05',
      recipient: {
        name: 'Example Client GmbH',
        addressLines: ['Hafenstrasse 7', '20457 Hamburg'],
        country: 'DE',
        countryInferred: 'DE',
        customerNumber: '1001',
      },
      sender: SENDER_MUNICH,
      lines: [{ description: 'Website', quantity: 1, unit: 'Stk', unitPrice: 450.5, discount: null, lineTotal: 450.5 }],
      total: 450.5,
    }),
    invoice(60, { issueDate: '2026-06-01', file: null, fileRole: 'missing', recipient: null, sender: null, lines: [], total: 99 }),
  ];
}

/** Every synthetic value that must never reach the output. */
const PRIVATE_VALUES = [
  'Example Client',
  'Erika',
  'Beispielweg',
  'Hafenstrasse',
  'Probeweg',
  'Hamburg',
  'Köln',
  'Sample Studio',
  'Musterstrasse',
  'Neue Allee',
  'Design work',
  'Workshop',
  'pdf/',
  '.pdf',
];

interface Fixture {
  root: string;
  input: string;
  files: string;
  invoices: Array<Record<string, unknown>>;
  write(): void;
}

function fixture(name: string, invoices = series()): Fixture {
  const root = join(work, name);
  const files = join(root, 'originals');
  mkdirSync(join(files, 'pdf'), { recursive: true });
  const f: Fixture = {
    root,
    input: join(root, 'input.json'),
    files,
    invoices,
    write() {
      writeFileSync(f.input, JSON.stringify({ meta: { note: 'synthetic' }, invoices: f.invoices }));
      for (const inv of f.invoices) {
        if (typeof inv.file === 'string') writeFileSync(join(files, inv.file), pdfBytes(`${name}-${inv.number}`));
      }
    },
  };
  f.write();
  return f;
}

async function run(f: Fixture, tenantId: string, book: FakeContactBook, dir: FakeDirectory, extra: string[] = []) {
  const lines: string[] = [];
  const report = await runBooksImport(
    ['--tenant-group', env.tgId, '--tenant', tenantId, '--input', f.input, '--files-dir', f.files, ...extra],
    cliEnv(),
    (l) => lines.push(l),
    { contactBook: book, recipients: dir, now: new Date('2026-10-20T10:00:00Z') },
  );
  return { report, lines, text: lines.join('\n') };
}

function statuses(report: ImportReport): Record<number, string> {
  return Object.fromEntries(report.rows.map((r) => [r.number, r.reason ? `${r.status}:${r.reason}` : r.status]));
}

async function countRows(tenantId: string) {
  const docs = await env.ownerDb.selectFrom('sales_document').select(sql<string>`count(*)`.as('n')).where('tenant_id', '=', tenantId).executeTakeFirstOrThrow();
  const files = await env.ownerDb.selectFrom('sales_document_file').select(sql<string>`count(*)`.as('n')).where('tenant_id', '=', tenantId).executeTakeFirstOrThrow();
  const customers = await env.ownerDb.selectFrom('customer').select(sql<string>`count(*)`.as('n')).where('tenant_id', '=', tenantId).executeTakeFirstOrThrow();
  return { docs: Number(docs.n), files: Number(files.n), customers: Number(customers.n) };
}

async function nextValue(tenantId: string): Promise<number> {
  const row = await env.ownerDb
    .selectFrom('document_number_counter')
    .select('next_value')
    .where('tenant_id', '=', tenantId)
    .where('doc_type', '=', 'invoice')
    .executeTakeFirstOrThrow();
  return Number(row.next_value);
}

describe('books:import, the run in order: dry run, forward, re-run, changed file, resume', () => {
  const tenantId = newTenantId();
  const dir = new FakeDirectory();
  const book = new FakeContactBook(dir);
  let f: Fixture;

  beforeAll(async () => {
    await initCompany(scopeFor(env.appDb, env.tgId, tenantId, dir), { invoiceNext: 62 });
    // The person already is a contact, at an older address: reused, never changed.
    dir.add(tenantId, { kind: 'person', name: 'Erika Beispiel', legalForm: null, addressLine1: 'Alter Weg 1', postalCode: '50667', city: 'Köln' });
    f = fixture('main');
  });

  it('dry run: validates, reads every original, checks the counter and the contacts, writes nothing', async () => {
    const before = await countRows(tenantId);
    const contactsBefore = dir.contactsOf(tenantId).length;
    const { report, text } = await run(f, tenantId, book, dir, ['--dry-run']);
    expect(statuses(report)).toEqual({ 1: 'would_import', 2: 'would_import', 3: 'would_import', 60: 'skipped:file_missing' });
    expect(report.recipients).toMatchObject({ contactsCreated: 1, contactsReused: 1, addressDiffers: 1 });
    expect(await countRows(tenantId)).toEqual(before);
    expect(dir.contactsOf(tenantId)).toHaveLength(contactsBefore);
    expect(text).toContain('Dry run: nothing was written.');
    expect(text).toContain('2019:   2 invoice(s), 420.00 EUR');
    for (const v of PRIVATE_VALUES) expect(text).not.toContain(v);
  });

  it('forward: imports 1 to 3 as issued documents with their originals, skips 60 with the reason', async () => {
    const { report, text, lines } = await run(f, tenantId, book, dir);
    expect(statuses(report)).toEqual({ 1: 'imported', 2: 'imported', 3: 'imported', 60: 'skipped:file_missing' });
    expect(report.counts).toMatchObject({ imported: 3, skipped: 1, error: 0 });
    expect(report.years).toEqual([
      { year: '2019', count: 2, total: 42000 },
      { year: '2020', count: 1, total: 45050 },
    ]);
    expect(report.paidOnPresent).toBe(2);
    // One contact created for the company (the GmbH, at its latest printed address), the person reused.
    expect(report.recipients).toEqual({ contactsCreated: 1, contactsReused: 1, customersCreated: 2, addressDiffers: 1 });
    const gmbh = dir.contactsOf(tenantId).find((c) => c.name === 'Example Client GmbH');
    expect(gmbh).toMatchObject({ kind: 'organization', addressLine1: 'Hafenstrasse 7', postalCode: '20457' });
    expect(dir.contactsOf(tenantId).find((c) => c.name === 'Erika Beispiel')).toMatchObject({ addressLine1: 'Alter Weg 1' });

    // The output: numbers, dates, totals, statuses, sums. No name, address, text or file name.
    expect(lines).toContain('invoice    2  2019-11-15      300.00 EUR  imported (1 other file(s) not stored)');
    expect(lines).toContain('invoice   60  2026-06-01       99.00 EUR  skipped: file_missing');
    expect(text).toContain('invoice counter stays at 62');
    expect(text).toContain('payment day present on 2 of them; payment state stays in receipt-ocr-app');
    for (const v of PRIVATE_VALUES) expect(text).not.toContain(v);

    expect(await nextValue(tenantId)).toBe(62);
    const scope = scopeFor(env.appDb, env.tgId, tenantId, dir);
    const page = await listDocuments(scope, { docType: 'invoice' });
    expect(page.items.map((d) => [d.documentNumber, d.issueDate, d.total, d.status, d.source, d.recipientName])).toEqual([
      ['3', '2020-05-05', 45050, 'issued', 'import', 'Example Client GmbH'],
      ['2', '2019-11-15', 30000, 'issued', 'import', 'Erika Beispiel'],
      ['1', '2019-02-01', 12000, 'issued', 'import', 'Example Client GmbH'],
    ]);

    const byNumber = Object.fromEntries(page.items.map((d) => [d.documentNumber, d.id]));
    const one = await getDocument(scope, byNumber['1']);
    const two = await getDocument(scope, byNumber['2']);
    const three = await getDocument(scope, byNumber['3']);
    // The customer snapshot is the printed recipient of THAT invoice, not today's contact.
    expect(one.document.customerSnapshot).toMatchObject({ name: 'Example Client GmbH', addressLine1: 'Beispielweg 2', postalCode: '20095', customerNumber: 1001 });
    expect(three.document.customerSnapshot).toMatchObject({ addressLine1: 'Hafenstrasse 7', postalCode: '20457' });
    expect(one.document.customerId).toBe(three.document.customerId);
    expect(two.document.customerSnapshot).toMatchObject({ kind: 'person', addressLine1: 'Probeweg 5', customerType: 'b2c' });
    // Each document carries its own printed sender: the owner moved between 1 and 2.
    expect(one.document.senderSnapshot).toMatchObject({ legalName: 'Sample Studio', addressLine1: 'Musterstrasse 1', city: 'Berlin', taxNumber: null, vatId: null });
    expect(two.document.senderSnapshot).toMatchObject({ addressLine1: 'Neue Allee 9', city: 'München' });
    expect(one.document.senderSnapshot).not.toEqual(two.document.senderSnapshot);
    // Lines and totals as printed, small business, tax 0.
    expect(two.lines.map((l) => [l.position, l.title, l.quantity, l.unitPrice, l.subtotal, l.taxTreatment])).toEqual([
      [1, 'Workshop', 1000, 25000, 25000, 'kleinunternehmer'],
      [2, 'Travel', 1000, 5000, 5000, 'kleinunternehmer'],
    ]);
    expect(two.document).toMatchObject({ kleinunternehmer: true, taxAmount: 0, subtotal: 30000, total: 30000, paymentTermsDays: 14, dueDate: '2019-11-29' });
    expect(two.document.taxNote).toBe('Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.');
    expect(two.document.renderedPdfFileId).not.toBeNull();
    // The original is stored byte for byte, marked as an import.
    const stored = await env.ownerDb
      .selectFrom('sales_document_file')
      .select(['content', 'renderer', 'byte_size'])
      .where('tenant_id', '=', tenantId)
      .where('document_id', '=', byNumber['2'])
      .executeTakeFirstOrThrow();
    expect(Buffer.from(stored.content).equals(pdfBytes('main-2'))).toBe(true);
    expect(stored.renderer).toBe('import:original-pdf');
    // The audit event: issued by the import, counts and flags only.
    expect(two.events.map((e) => [e.eventType, e.fromStatus, e.toStatus, e.actorUserId])).toEqual([['issued', null, 'issued', null]]);
    expect(two.events[0].payload).toMatchObject({ source: 'import', importOrigin: 'operator_file', numberValue: 2, otherFilesSkipped: 1, paidOnPresent: false, senderTaxNumberPrinted: true });
    const payload = JSON.stringify(two.events[0].payload);
    for (const v of PRIVATE_VALUES) expect(payload).not.toContain(v);
  });

  it('re-run: every number already imported is skipped as such, nothing is added', async () => {
    const before = await countRows(tenantId);
    const contactsBefore = dir.contactsOf(tenantId).length;
    const { report } = await run(f, tenantId, book, dir);
    expect(statuses(report)).toEqual({ 1: 'already_imported', 2: 'already_imported', 3: 'already_imported', 60: 'skipped:file_missing' });
    expect(await countRows(tenantId)).toEqual(before);
    expect(dir.contactsOf(tenantId)).toHaveLength(contactsBefore);
    expect(report.years).toEqual([
      { year: '2019', count: 2, total: 42000 },
      { year: '2020', count: 1, total: 45050 },
    ]);
  });

  it('a changed original for an imported number is an error for that number; nothing is overwritten', async () => {
    writeFileSync(join(f.files, 'pdf', '2.pdf'), pdfBytes('main-2-changed'));
    const { report } = await run(f, tenantId, book, dir);
    expect(statuses(report)).toMatchObject({ 1: 'already_imported', 2: 'error:IMPORT_CONFLICT', 3: 'already_imported' });
    expect(report.counts.error).toBe(1);
    const stored = await env.ownerDb
      .selectFrom('sales_document_file')
      .innerJoin('sales_document', 'sales_document.id', 'sales_document_file.document_id')
      .select('sales_document_file.content')
      .where('sales_document.tenant_id', '=', tenantId)
      .where('sales_document.number_value', '=', '2')
      .executeTakeFirstOrThrow();
    expect(Buffer.from(stored.content).equals(pdfBytes('main-2'))).toBe(true);
    writeFileSync(join(f.files, 'pdf', '2.pdf'), pdfBytes('main-2'));
  });

  it('resume: 60 completed in the input is imported by the next run, the rest stays as it was', async () => {
    f.invoices[3] = invoice(60, {
      issueDate: '2026-06-01',
      lines: [{ description: 'Design work', quantity: 1, unit: 'Stk', unitPrice: 99, discount: null, lineTotal: 99 }],
      total: 99,
    });
    f.write();
    const { report } = await run(f, tenantId, book, dir);
    expect(statuses(report)).toEqual({ 1: 'already_imported', 2: 'already_imported', 3: 'already_imported', 60: 'imported' });
    expect((await countRows(tenantId)).docs).toBe(4);
    expect(await nextValue(tenantId)).toBe(62);
    expect(report.years.map((y) => y.year)).toEqual(['2019', '2020', '2026']);
  });

  it('a corrected total for an imported number is reported as differing, never written, and the yearly sums stay those of the books', async () => {
    const before = (await run(f, tenantId, book, dir)).report.years;
    f.invoices[0] = invoice(1, {
      lines: [{ description: 'Design work', quantity: 2, unit: 'h', unitPrice: 61, discount: null, lineTotal: 122 }],
      total: 122,
    });
    writeFileSync(f.input, JSON.stringify({ meta: {}, invoices: f.invoices }));
    const { report, lines, text } = await run(f, tenantId, book, dir);
    expect(statuses(report)[1]).toBe('already_imported:differs');
    expect(report.differing).toBe(1);
    expect(exitCodeFor(report)).toBe(1);
    expect(lines.find((l) => l.startsWith('invoice    1'))).toContain('already imported, BUT the stored total or issue date differs');
    expect(text).toContain('ATTENTION: 1 already imported invoice(s) differ from the input');
    expect(report.years).toEqual(before);
    const stored = await env.ownerDb
      .selectFrom('sales_document')
      .select('total')
      .where('tenant_id', '=', tenantId)
      .where('number_value', '=', '1')
      .executeTakeFirstOrThrow();
    expect(stored.total).toBe(12000);
  });
});

describe('books:import refuses the whole run and writes nothing', () => {
  it('without an invoice counter (the company was never initialised)', async () => {
    const tenantId = newTenantId();
    const dir = new FakeDirectory();
    const f = fixture('nocounter');
    await expect(run(f, tenantId, new FakeContactBook(dir), dir)).rejects.toMatchObject({ code: 'COUNTER_MISSING' });
    expect(await countRows(tenantId)).toEqual({ docs: 0, files: 0, customers: 0 });
    expect(dir.contactsOf(tenantId)).toHaveLength(0);
  });

  it('when the counter is not above every imported number', async () => {
    const tenantId = newTenantId();
    const dir = new FakeDirectory();
    await initCompany(scopeFor(env.appDb, env.tgId, tenantId, dir), { invoiceNext: 3 });
    const f = fixture('lowcounter');
    await expect(run(f, tenantId, new FakeContactBook(dir), dir)).rejects.toMatchObject({ code: 'IMPORT_COUNTER_TOO_LOW' });
    expect(await countRows(tenantId)).toEqual({ docs: 0, files: 0, customers: 0 });
    expect(dir.contactsOf(tenantId)).toHaveLength(0);
    expect(await nextValue(tenantId)).toBe(3);
  });

  it('when an original cannot be used, naming only the number', async () => {
    const tenantId = newTenantId();
    const dir = new FakeDirectory();
    await initCompany(scopeFor(env.appDb, env.tgId, tenantId, dir), { invoiceNext: 62 });
    const f = fixture('badfile');
    writeFileSync(join(f.files, 'pdf', '3.pdf'), Buffer.from('not a pdf'));
    await expect(run(f, tenantId, new FakeContactBook(dir), dir)).rejects.toThrow(
      'books:import: originals that cannot be used, by invoice number: 3 (file_not_pdf)',
    );
    expect(await countRows(tenantId)).toEqual({ docs: 0, files: 0, customers: 0 });
  });

  it('when the contacts database does not answer', async () => {
    const tenantId = newTenantId();
    const dir = new FakeDirectory();
    await initCompany(scopeFor(env.appDb, env.tgId, tenantId, dir), { invoiceNext: 62 });
    dir.failing = true;
    await expect(run(fixture('nocontacts'), tenantId, new FakeContactBook(dir), dir)).rejects.toMatchObject({ code: 'RECIPIENT_UNAVAILABLE' });
    expect(await countRows(tenantId)).toEqual({ docs: 0, files: 0, customers: 0 });
  });
});

describe('importHistoricalInvoice: the core the planned upload calls', () => {
  it('takes the sender as an input (here the company sender block), records the origin, and creates nothing for a conflict', async () => {
    const tenantId = newTenantId();
    const dir = new FakeDirectory();
    const book = new FakeContactBook(dir);
    const scope = scopeFor(env.appDb, env.tgId, tenantId, dir);
    await initCompany(scope, { invoiceNext: 62 });
    const settings = await readSettings(scope.db, scope);
    const record: HistoricalInvoiceInput = {
      origin: 'upload_extracted',
      numberValue: 40,
      issueDate: '2025-04-01',
      serviceDate: null,
      servicePeriod: null,
      paymentTermsDays: 0,
      dueDate: null,
      recipient: {
        kind: 'organization',
        name: 'Example Client GmbH',
        addressLine1: 'Beispielweg 2',
        addressLine2: null,
        postalCode: '20095',
        city: 'Hamburg',
        country: 'DE',
        customerNumber: null,
        customerNumberText: null,
        vatId: null,
      },
      sender: settings!.senderBlock,
      lines: [{ kind: 'service', title: 'Design work', description: null, quantity: 1000, unitLabel: 'Stk', unitPrice: 5000, discountBp: 0, subtotal: 5000 }],
      total: 5000,
      taxTreatment: 'small_business',
      taxNote: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.',
    };
    const session = newImportSession();
    const pdf = new Uint8Array(pdfBytes(`upload-${tenantId}`));
    const first = await importHistoricalInvoice(scope, book, record, pdf, session);
    expect(first.status).toBe('imported');
    const view = await getDocument(scope, first.documentId);
    expect(view.document.senderSnapshot).toMatchObject({ ...settings!.senderBlock, v: 1 });
    expect(view.events[0].payload).toMatchObject({ source: 'import', importOrigin: 'upload_extracted', numberValue: 40 });
    expect(session.stats).toEqual({ contactsCreated: 1, contactsReused: 0, customersCreated: 1, addressDiffers: 0 });

    // The same original again: already imported, nothing looked up or created.
    expect((await importHistoricalInvoice(scope, book, record, pdf, session)).status).toBe('already_imported');
    // Another original under the same number, for a client never seen: refused before any contact is created.
    const other = { ...record, recipient: { ...record.recipient, name: 'Another Example AG' } };
    await expect(importHistoricalInvoice(scope, book, other, new Uint8Array(pdfBytes('different')), newImportSession())).rejects.toMatchObject({
      code: 'IMPORT_CONFLICT',
    });
    expect(dir.contactsOf(tenantId).map((c) => c.name)).toEqual(['Example Client GmbH']);
    // An invalid record or a non-PDF is refused before anything is read or written.
    await expect(importHistoricalInvoice(scope, book, { ...record, total: 1 }, pdf)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(importHistoricalInvoice(scope, book, { ...record, numberValue: 41 }, new Uint8Array(Buffer.from('no pdf')))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(importHistoricalInvoice(scope, book, { ...record, numberValue: 62 }, pdf)).rejects.toMatchObject({ code: 'IMPORT_COUNTER_TOO_LOW' });
    expect((await countRows(tenantId)).docs).toBe(1);
  });
});

describe('importHistoricalInvoice against what is already in the books', () => {
  function record(numberValue: number, name = 'Example Client GmbH', kind: 'person' | 'organization' = 'organization'): HistoricalInvoiceInput {
    return {
      origin: 'upload_extracted',
      numberValue,
      issueDate: '2025-04-01',
      serviceDate: null,
      servicePeriod: null,
      paymentTermsDays: 0,
      dueDate: null,
      recipient: {
        kind,
        name,
        addressLine1: 'Beispielweg 2',
        addressLine2: null,
        postalCode: '20095',
        city: 'Hamburg',
        country: 'DE',
        customerNumber: null,
        customerNumberText: null,
        vatId: null,
      },
      sender: {
        legalName: 'Sample Studio', addressLine1: 'Musterstrasse 1', addressLine2: null, postalCode: '10115', city: 'Berlin', countryCode: 'DE',
        taxNumber: null, vatId: null, smallBusinessId: null, email: null, phone: null, website: null, bankName: null, iban: null, bic: null,
        registerCourt: null, registerNumber: null, managingDirector: null,
      },
      lines: [{ kind: 'service', title: 'Design work', description: null, quantity: 1000, unitLabel: 'Stk', unitPrice: 5000, discountBp: 0, subtotal: 5000 }],
      total: 5000,
      taxTreatment: 'small_business',
      taxNote: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.',
    };
  }

  async function freshCompany() {
    const tenantId = newTenantId();
    const dir = new FakeDirectory();
    const scope = scopeFor(env.appDb, env.tgId, tenantId, dir);
    await initCompany(scope, { invoiceNext: 62 });
    return { tenantId, dir, book: new FakeContactBook(dir), scope };
  }

  it('a number the editor issued is a conflict, and no contact is created for it', async () => {
    const { tenantId, dir, book, scope } = await freshCompany();
    const { customer } = await newCustomer(scope, dir);
    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });
    await addLine(scope, draft.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });
    await issue(scope, draft.document.id, { actorUserId: ACTOR });
    const contactsBefore = dir.contactsOf(tenantId).length;
    await expect(importHistoricalInvoice(scope, book, record(62, 'Brand New Client AG'), new Uint8Array(pdfBytes('editor-62')))).rejects.toMatchObject({
      code: 'IMPORT_CONFLICT',
    });
    expect(dir.contactsOf(tenantId)).toHaveLength(contactsBefore);
  });

  it('two imports of the same invoice at once: one writes it, the other reports it as already imported', async () => {
    const { tenantId, book, scope } = await freshCompany();
    const pdf = new Uint8Array(pdfBytes(`race-${tenantId}`));
    const results = await Promise.all([
      importHistoricalInvoice(scope, book, record(30), pdf, newImportSession()),
      importHistoricalInvoice(scope, book, record(30), pdf, newImportSession()),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['already_imported', 'imported']);
    expect((await countRows(tenantId)).docs).toBe(1);
  });

  it('a person is matched whatever their company or role, and two persons of one name are never guessed between', async () => {
    const { tenantId, dir, book, scope } = await freshCompany();
    const one = dir.add(tenantId, { kind: 'person', name: 'Erika Beispiel', companyOrRole: 'Studio A', legalForm: null });
    const session = newImportSession();
    const first = await importHistoricalInvoice(scope, book, record(31, 'Erika Beispiel', 'person'), new Uint8Array(pdfBytes(`p-${tenantId}-31`)), session);
    expect(first.status).toBe('imported');
    expect((await getDocument(scope, first.documentId)).document.customerSnapshot?.contactId).toBe(one.id);
    expect(session.stats.contactsCreated).toBe(0);

    dir.add(tenantId, { kind: 'person', name: 'Max Beispiel', companyOrRole: 'Studio A', legalForm: null });
    dir.add(tenantId, { kind: 'person', name: 'Max Beispiel', companyOrRole: 'Studio B', legalForm: null });
    await expect(
      importHistoricalInvoice(scope, book, record(32, 'Max Beispiel', 'person'), new Uint8Array(pdfBytes(`p-${tenantId}-32`))),
    ).rejects.toMatchObject({ code: 'RECIPIENT_AMBIGUOUS' });
    expect((await countRows(tenantId)).docs).toBe(1);
  });

  it('the frozen tax fields are those printed on the invoice, not those of the reused customer today', async () => {
    const { tenantId, dir, book, scope } = await freshCompany();
    const { customer } = await newCustomer(scope, dir, { customerType: 'b2b', vatId: 'DE999999999', contact: { name: 'Example Client GmbH' } });
    const r = { ...record(33), recipient: { ...record(33).recipient, vatId: null } };
    const result = await importHistoricalInvoice(scope, book, r, new Uint8Array(pdfBytes(`tax-${tenantId}`)));
    const doc = (await getDocument(scope, result.documentId)).document;
    expect(doc.customerId).toBe(customer.id);
    expect(doc.vatId).toBeNull();
    expect(doc.customerSnapshot?.vatId).toBeNull();
    expect(doc.documentNumber).toBe('33');
  });
});

describe('009_books_import: what holds for every role', () => {
  const tenantId = newTenantId();

  /** Insert, as the OWNER, a document of the given shape in one transaction; returns the SQLSTATE or 'ok'. */
  async function ownerImport(opts: { lines: number[]; total: number; withFile: boolean }): Promise<string> {
    const id = randomUUID();
    const snapshot = { v: 1 };
    try {
      await env.ownerDb.transaction().execute(async (trx) => {
        await sql`SET CONSTRAINTS ALL DEFERRED`.execute(trx);
        for (const [i, amount] of opts.lines.entries()) {
          await trx
            .insertInto('sales_document_line')
            .values({
              id: randomUUID(), tenant_id: tenantId, document_id: id, position: i + 1, kind: 'service', title: 'Synthetic line',
              quantity: 1000, unit_price: amount, subtotal: amount, tax_rate: 0, tax_amount: 0, tax_treatment: 'kleinunternehmer', updated_at: new Date(),
            })
            .execute();
        }
        await trx
          .insertInto('sales_document')
          .values({
            id, tenant_id: tenantId, doc_type: 'invoice', status: 'issued', source: 'import', document_number: String(900 + opts.lines.length + opts.total),
            number_value: String(900 + opts.lines.length + opts.total), issue_date: '2020-01-01', issued_at: new Date('2020-01-01T12:00:00Z'),
            payment_terms_days: 0, subtotal: opts.total, total: opts.total,
            customer_snapshot: sql`${JSON.stringify(snapshot)}::text::jsonb`, sender_snapshot: sql`${JSON.stringify(snapshot)}::text::jsonb`, updated_at: new Date(),
          } as never)
          .execute();
        if (opts.withFile) {
          const fileId = randomUUID();
          const bytes = pdfBytes(id);
          await trx
            .insertInto('sales_document_file')
            .values({ id: fileId, tenant_id: tenantId, document_id: id, content_type: 'application/pdf', byte_size: bytes.byteLength, sha256: 'b'.repeat(64), renderer: 'import:original-pdf', content: bytes })
            .execute();
          await trx.updateTable('sales_document').set({ rendered_pdf_file_id: fileId }).where('id', '=', id).execute();
        }
      });
      return 'ok';
    } catch (err) {
      return String((err as { code?: unknown }).code);
    }
  }

  it('an import commits only with its lines summing to the totals and with its original', async () => {
    expect(await ownerImport({ lines: [100, 200], total: 301, withFile: true })).toBe('BK005');
    expect(await ownerImport({ lines: [], total: 0, withFile: true })).toBe('BK005');
    expect(await ownerImport({ lines: [100], total: 100, withFile: false })).toBe('BK007');
    expect(await ownerImport({ lines: [100, 200], total: 300, withFile: true })).toBe('ok');
  });

  it('once committed, an imported document takes no new line, no change and no delete, for the owner too', async () => {
    const doc = await env.ownerDb
      .selectFrom('sales_document')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('source', '=', 'import')
      .executeTakeFirstOrThrow();
    const line = {
      id: randomUUID(), tenant_id: tenantId, document_id: doc.id, position: 9, kind: 'service' as const, title: 'Late line',
      quantity: 1000, unit_price: 1, subtotal: 1, tax_rate: 0, tax_amount: 0, tax_treatment: 'kleinunternehmer' as const, updated_at: new Date(),
    };
    expect(await rejectionCode(env.ownerDb.insertInto('sales_document_line').values(line).execute())).toBe('BK001');
    expect(
      await rejectionCode(
        env.ownerDb.transaction().execute(async (trx) => {
          await sql`SET CONSTRAINTS ALL DEFERRED`.execute(trx);
          await trx.insertInto('sales_document_line').values({ ...line, id: randomUUID() }).execute();
        }),
      ),
    ).toBe('BK001');
    expect(await rejectionCode(env.ownerDb.updateTable('sales_document').set({ total: 1, subtotal: 1 }).where('id', '=', doc.id).execute())).toBe('BK001');
    expect(await rejectionCode(env.ownerDb.updateTable('sales_document').set({ status: 'draft' }).where('id', '=', doc.id).execute())).toBe('BK004');
    expect(await rejectionCode(env.ownerDb.deleteFrom('sales_document').where('id', '=', doc.id).execute())).toBe('BK001');
    expect(await rejectionCode(env.ownerDb.updateTable('sales_document_line').set({ title: 'x' }).where('document_id', '=', doc.id).execute())).toBe('BK001');
  });

  it('a deferred line whose document never arrives is refused at commit (23503)', async () => {
    const code = await rejectionCode(
      env.ownerDb.transaction().execute(async (trx) => {
        await sql`SET CONSTRAINTS ALL DEFERRED`.execute(trx);
        await trx
          .insertInto('sales_document_line')
          .values({
            id: randomUUID(), tenant_id: tenantId, document_id: randomUUID(), position: 1, kind: 'service', title: 'Orphan line',
            quantity: 1000, unit_price: 1, subtotal: 1, tax_rate: 0, tax_amount: 0, tax_treatment: 'kleinunternehmer', updated_at: new Date(),
          })
          .execute();
      }),
    );
    expect(code).toBe('23503');
  });

  it('an import pointing at the original of another document does not commit (BK007)', async () => {
    const other = await env.ownerDb
      .selectFrom('sales_document')
      .select(['id', 'rendered_pdf_file_id'])
      .where('tenant_id', '=', tenantId)
      .where('source', '=', 'import')
      .executeTakeFirstOrThrow();
    const id = randomUUID();
    const code = await rejectionCode(
      env.ownerDb.transaction().execute(async (trx) => {
        await sql`SET CONSTRAINTS ALL DEFERRED`.execute(trx);
        await trx
          .insertInto('sales_document_line')
          .values({
            id: randomUUID(), tenant_id: tenantId, document_id: id, position: 1, kind: 'service', title: 'Synthetic line',
            quantity: 1000, unit_price: 100, subtotal: 100, tax_rate: 0, tax_amount: 0, tax_treatment: 'kleinunternehmer', updated_at: new Date(),
          })
          .execute();
        await trx
          .insertInto('sales_document')
          .values({
            id, tenant_id: tenantId, doc_type: 'invoice', status: 'issued', source: 'import', document_number: '990', number_value: '990',
            issue_date: '2020-01-01', issued_at: new Date('2020-01-01T12:00:00Z'), payment_terms_days: 0, subtotal: 100, total: 100,
            customer_snapshot: sql`${'{"v":1}'}::text::jsonb`, sender_snapshot: sql`${'{"v":1}'}::text::jsonb`, updated_at: new Date(),
          } as never)
          .execute();
        await trx.updateTable('sales_document').set({ rendered_pdf_file_id: other.rendered_pdf_file_id }).where('id', '=', id).execute();
      }),
    );
    expect(code).toBe('BK007');
  });

  it('an editor document is still born a draft (BK004), deferred foreign key or not', async () => {
    const code = await rejectionCode(
      env.ownerDb.transaction().execute(async (trx) => {
        await sql`SET CONSTRAINTS ALL DEFERRED`.execute(trx);
        await trx
          .insertInto('sales_document')
          .values({ id: randomUUID(), tenant_id: tenantId, doc_type: 'invoice', status: 'issued', source: 'editor', payment_terms_days: 0, updated_at: new Date() } as never)
          .execute();
      }),
    );
    expect(code).toBe('BK004');
  });
});
