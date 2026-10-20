// src/server/books/importInvoices.ts
//
// The historical import of invoices issued before the Books existed (Books plan,
// "Historical import build notes (2026-10-20)"), the domain core. Its input is
// ONE historical invoice record, a typed and zod-validated shape that does not
// depend on where the data came from, plus the bytes of its original PDF:
//
//   - the operator CLI (importCli.ts, `pnpm books:import`) maps the owner's
//     private JSON extraction to records with origin `operator_file`;
//   - the planned in-editor upload maps the data extracted from each uploaded
//     PDF, after the user reviewed it, to records with origin
//     `upload_extracted`, its sender defaulting to the company's sender block.
//
// Nothing here reads a file or a command line. `importHistoricalInvoice` does
// every check and write for one record:
//
//   - the record is parsed (INVALID_INPUT naming the fields, never values), the
//     bytes must be a PDF, the issue date not in the future;
//   - its number is the printed one, stored as printed (never allocated, never
//     reformatted through the counter's format), and must lie below the
//     company's invoice counter, which is never moved (COUNTER_MISSING,
//     IMPORT_COUNTER_TOO_LOW);
//   - a number already present is `already_imported` when it is an import whose
//     stored original has the same SHA-256, and IMPORT_CONFLICT otherwise;
//     nothing is ever overwritten, and nothing is created for it;
//   - the recipient is found or created in the shared contacts database, and
//     the Books customer for that contact found or created
//     (`resolveImportRecipient`, the rule is written there);
//   - the customer and sender snapshots are the record's own data (the sender
//     is an INPUT: the CLI passes the sender printed on that invoice, since the
//     owner moved several times), frozen as given;
//   - lines and totals as given, small business (section 19 UStG) only, tax 0;
//   - one transaction writes the lines, the document, the original in
//     sales_document_file, the pointer rendered_pdf_file_id and an `issued`
//     event recording the origin, so a failure never leaves half a document
//     (009_books_import makes the lines-first order possible and refuses a
//     commit without the original, BK007). The original is never rendered.
//
// No `server-only` imports: the CLI runs this under tsx.

import { createHash, randomUUID } from 'node:crypto';

import { contactIdentityKey } from '@marlinjai/contacts-core';
import { sql, type Kysely, type Transaction } from 'kysely';
import { tenantSchemaRef } from '@marlinjai/tenant-db';
import { z } from 'zod';

import type { CommerceDB, CustomerType } from '../commerce/db-types';
import { resolveTaxProfile } from '../tax/germanVat';
import type { ContactBook } from './contactBook';
import { BooksError, constraintName, invalid, isBooksError, sqlState, withDbErrors } from './errors';
import { berlinToday, isIsoDate } from './numbering';
import { insertEvent } from './repository/events';
import { createCustomer, customersByContactIds } from './repository/customers';
import type { BooksScope } from './scope';
import {
  customerSnapshotV1Schema,
  senderBlockV1Schema,
  senderSnapshotV1Schema,
  toJsonb,
  type CustomerSnapshotV1,
  type RecipientContact,
  type SenderSnapshotV1,
  type TaxSummary,
} from './snapshots';

type Db = Kysely<CommerceDB> | Transaction<CommerceDB>;

/** What the stored original is marked with in `sales_document_file.renderer`. */
export const IMPORT_RENDERER = 'import:original-pdf';

/** The largest amount a money column holds (INTEGER cents). */
export const MAX_CENTS = 2 ** 31 - 1;

/** The largest original accepted (the bytes live in the tenant schema). */
export const MAX_ORIGINAL_BYTES = 25 * 1024 * 1024;

/** How an imported document's data was obtained, recorded in its `issued` event. */
export const IMPORT_ORIGINS = ['operator_file', 'upload_extracted'] as const;
export type ImportOrigin = (typeof IMPORT_ORIGINS)[number];

// --- the record ------------------------------------------------------------------

const isoDate = z.string().refine(isIsoDate, 'expected a calendar day YYYY-MM-DD');
const text = (max: number) => z.string().trim().min(1).max(max);
const cents = z.number().int().min(0).max(MAX_CENTS);
const printedLines = z.array(z.string().max(300)).max(12).optional();

const lineSchema = z
  .object({
    kind: z.enum(['service', 'text']),
    title: text(300),
    description: z.string().max(4000).nullable(),
    /** Thousandths (1.5 hours = 1500); 0 on a text line. */
    quantity: z.number().int().min(0).max(MAX_CENTS),
    unitLabel: text(40),
    /** Cents. */
    unitPrice: cents,
    /** Basis points (informational; `subtotal` is the printed line total). */
    discountBp: z.number().int().min(0).max(10000),
    /** Cents, the printed line total. */
    subtotal: cents,
  })
  .superRefine((l, ctx) => {
    if (l.kind === 'text' && (l.quantity !== 0 || l.unitPrice !== 0 || l.subtotal !== 0 || l.discountBp !== 0)) {
      ctx.addIssue({ code: 'custom', message: 'a text line carries no quantity or amount' });
    }
    if (l.kind === 'service' && l.quantity === 0) ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'a billable line has a quantity' });
  });

const recipientSchema = z
  .object({
  kind: z.enum(['person', 'organization']),
  name: text(160),
  /** The printed address lines, verbatim, when known. */
  addressLines: printedLines,
  addressLine1: text(300),
  addressLine2: z.string().trim().max(300).nullable(),
  postalCode: text(20),
  city: text(120),
  /** ISO 3166-1 alpha-2. */
  country: z.string().regex(/^[A-Z]{2}$/, 'expected an ISO 3166-1 alpha-2 code'),
  customerNumber: z.number().int().min(1).max(999_999_999).nullable(),
  customerNumberText: z.string().max(64).nullable(),
  /** Normalized (upper case, no spaces). */
  vatId: z.string().regex(/^[A-Z]{2}[A-Z0-9+*]{2,13}$/, 'expected a VAT id such as DE123456789').nullable(),
})
  .superRefine((r, ctx) => {
    // The contacts package's limit for a person's name (an organization's is 160).
    if (r.kind === 'person' && r.name.length > 120) ctx.addIssue({ code: 'custom', path: ['name'], message: 'a person name has at most 120 characters' });
  });

/** The issuer as printed on the invoice: the sender block's fields, plus the printed lines when known. */
const senderSchema = senderBlockV1Schema.extend({ addressLines: printedLines }).superRefine((s, ctx) => {
  for (const f of ['legalName', 'addressLine1', 'postalCode', 'city', 'countryCode'] as const) {
    if (s[f] == null || s[f]!.trim() === '') ctx.addIssue({ code: 'custom', path: [f], message: 'required on an issued invoice' });
  }
});

/** Non-personal facts about the source, recorded in the `issued` event (counts and flags only). */
const provenanceSchema = z
  .object({
    otherFilesSkipped: z.number().int().min(0).max(100),
    senderTaxNumberPrinted: z.boolean(),
    senderVatIdPrinted: z.boolean(),
    serviceDateUnparsed: z.boolean(),
    paidOnPresent: z.boolean(),
    /** The printed payment terms could not be read: `paymentTermsDays` 0 and no due date are a fallback, not the print. */
    paymentTermsUnparsed: z.boolean(),
    /** A recipient VAT id was printed but is not a valid one; the record carries none. */
    recipientVatIdUnparsed: z.boolean(),
    /** The recipient's country was not printed; the record's country was inferred. */
    recipientCountryInferred: z.boolean(),
    confidence: z.enum(['high', 'medium', 'low']),
  })
  .partial()
  .strict();

/**
 * One historical invoice, ready to be imported. Money in cents, quantities in
 * thousandths, dates `YYYY-MM-DD`. Only small-business invoices (section 19)
 * are supported; the lines must sum to the total.
 */
export const historicalInvoiceSchema = z
  .object({
    origin: z.enum(IMPORT_ORIGINS),
    numberValue: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    issueDate: isoDate,
    serviceDate: isoDate.nullable(),
    servicePeriod: z.object({ start: isoDate, end: isoDate }).nullable(),
    paymentTermsDays: z.number().int().min(0).max(365),
    dueDate: isoDate.nullable(),
    recipient: recipientSchema,
    sender: senderSchema,
    lines: z.array(lineSchema).min(1).max(500),
    total: cents,
    taxTreatment: z.literal('small_business'),
    /** The small-business note as printed. */
    taxNote: text(500),
    provenance: provenanceSchema.default({}),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (!r.lines.some((l) => l.kind !== 'text')) ctx.addIssue({ code: 'custom', path: ['lines'], message: 'at least one billable line' });
    if (r.lines.reduce((acc, l) => acc + l.subtotal, 0) !== r.total) {
      ctx.addIssue({ code: 'custom', path: ['total'], message: 'the lines do not sum to the total' });
    }
    if (r.servicePeriod && r.servicePeriod.start > r.servicePeriod.end) {
      ctx.addIssue({ code: 'custom', path: ['servicePeriod'], message: 'the period ends before it starts' });
    }
    if (r.dueDate && r.dueDate < r.issueDate) ctx.addIssue({ code: 'custom', path: ['dueDate'], message: 'due before it was issued' });
  });
export type HistoricalInvoice = z.output<typeof historicalInvoiceSchema>;
export type HistoricalInvoiceInput = z.input<typeof historicalInvoiceSchema>;
export type HistoricalRecipient = HistoricalInvoice['recipient'];
export type HistoricalLine = HistoricalInvoice['lines'][number];

/** Parse a record; INVALID_INPUT names the fields, never the values. */
export function parseHistoricalInvoice(input: unknown, now: Date = new Date()): HistoricalInvoice {
  const parsed = historicalInvoiceSchema.safeParse(input);
  if (!parsed.success) throw invalid('INVALID_INPUT', parsed.error.issues);
  if (parsed.data.issueDate > berlinToday(now)) {
    throw invalid('INVALID_INPUT', [{ path: ['issueDate'], message: 'in the future' }]);
  }
  return parsed.data;
}

/** The original's bytes checked (a non-empty PDF within the size limit) and digested. */
export function checkOriginal(pdf: Uint8Array): { bytes: Uint8Array; sha256: string } {
  const head = Buffer.from(pdf.subarray(0, 5)).toString('latin1');
  if (pdf.byteLength === 0 || pdf.byteLength > MAX_ORIGINAL_BYTES || head !== '%PDF-') {
    throw invalid('INVALID_INPUT', [{ path: ['pdf'], message: `expected a PDF of at most ${MAX_ORIGINAL_BYTES} bytes` }]);
  }
  return { bytes: pdf, sha256: createHash('sha256').update(pdf).digest('hex') };
}

// --- the counter -----------------------------------------------------------------

export interface ImportCounter {
  format: string;
  nextValue: number;
}

/**
 * The company's invoice counter, checked against the given numbers: each must
 * be below `next_value` (set past the historical series by
 * `books:init-company`). Never moves the counter.
 */
export async function checkImportCounter(
  db: Db,
  scope: BooksScope,
  numbers: readonly number[],
  opts: { forShare?: boolean } = {},
): Promise<ImportCounter> {
  let q = db
    .selectFrom('document_number_counter')
    .select(['next_value', 'format'])
    .where('tenant_id', '=', scope.tenantId)
    .where('doc_type', '=', 'invoice');
  if (opts.forShare) q = q.forShare();
  const counter = await q.executeTakeFirst();
  if (!counter) {
    throw new BooksError('COUNTER_MISSING', 'COUNTER_MISSING: no invoice counter for this company (run books:init-company first)', {
      docType: 'invoice',
    });
  }
  const nextValue = Number(counter.next_value);
  const tooHigh = numbers.filter((n) => n >= nextValue);
  if (tooHigh.length > 0) {
    throw new BooksError(
      'IMPORT_COUNTER_TOO_LOW',
      `IMPORT_COUNTER_TOO_LOW: the invoice counter is at ${nextValue}, but the import holds ${tooHigh.length} number(s) at or above it (highest ${Math.max(...tooHigh)})`,
      { nextValue, highest: Math.max(...tooHigh), count: tooHigh.length },
    );
  }
  return { format: counter.format, nextValue };
}

// --- what is there already ---------------------------------------------------------

export type ExistingNumber =
  | { state: 'absent' }
  | { state: 'imported'; documentId: string; sha256: string | null; total: number; issueDate: string | null }
  | { state: 'other'; documentId: string };

/** What the company's books hold under an invoice number. */
export async function existingInvoice(db: Db, scope: BooksScope, numberValue: number): Promise<ExistingNumber> {
  const row = await db
    .selectFrom('sales_document')
    .leftJoin('sales_document_file', (join) =>
      join
        .onRef('sales_document_file.tenant_id', '=', 'sales_document.tenant_id')
        .onRef('sales_document_file.document_id', '=', 'sales_document.id'),
    )
    .select((eb) => [
      'sales_document.id',
      'sales_document.source',
      'sales_document.total',
      eb.cast<string | null>('sales_document.issue_date', 'text').as('issue_date'),
      'sales_document_file.sha256',
    ])
    .where('sales_document.tenant_id', '=', scope.tenantId)
    .where('sales_document.doc_type', '=', 'invoice')
    .where('sales_document.number_value', '=', String(numberValue))
    .executeTakeFirst();
  if (!row) return { state: 'absent' };
  if (row.source !== 'import') return { state: 'other', documentId: row.id };
  return { state: 'imported', documentId: row.id, sha256: row.sha256 ?? null, total: row.total, issueDate: row.issue_date };
}

/**
 * What the import holds in the company's books, per issue year: the count and
 * the sum of the totals (cents) of every invoice with `source = 'import'`. The
 * figures to compare with the filed returns, read from the books themselves.
 */
export async function importedYearTotals(db: Db, scope: BooksScope): Promise<Array<{ year: string; count: number; total: number }>> {
  const rows = await db
    .selectFrom('sales_document')
    .select((eb) => [
      sql<string>`to_char(${eb.ref('sales_document.issue_date')}, 'YYYY')`.as('year'),
      sql<string>`count(*)`.as('count'),
      sql<string>`coalesce(sum(${eb.ref('sales_document.total')}), 0)`.as('total'),
    ])
    .where('sales_document.tenant_id', '=', scope.tenantId)
    .where('sales_document.doc_type', '=', 'invoice')
    .where('sales_document.source', '=', 'import')
    .groupBy(sql`1`)
    .orderBy(sql`1`)
    .execute();
  return rows.map((r) => ({ year: r.year, count: Number(r.count), total: Number(r.total) }));
}

export type ImportResult =
  | { status: 'imported'; documentId: string }
  | {
      status: 'already_imported';
      documentId: string;
      /**
       * True when the stored document's total or issue date differs from the
       * record (same original, data corrected since). Nothing is changed: the
       * caller reports it, so the difference is never silent.
       */
      differs: boolean;
    };

function conflict(numberValue: number, documentId: string, why: string): BooksError {
  return new BooksError('IMPORT_CONFLICT', `IMPORT_CONFLICT: invoice ${numberValue} ${why}; nothing was changed`, {
    numberValue,
    documentId,
  });
}

/** Decide what an existing number means for an original with this digest (and, given the record, whether its data still agrees). */
export function judgeExisting(
  existing: ExistingNumber,
  numberValue: number,
  sha256: string,
  record?: Pick<HistoricalInvoice, 'total' | 'issueDate'>,
): ImportResult | null {
  if (existing.state === 'absent') return null;
  if (existing.state === 'other') throw conflict(numberValue, existing.documentId, 'already exists as a document of this system');
  if (existing.sha256 !== sha256) throw conflict(numberValue, existing.documentId, 'was imported with a different file');
  const differs = record !== undefined && (existing.total !== record.total || existing.issueDate !== record.issueDate);
  return { status: 'already_imported', documentId: existing.documentId, differs };
}

// --- recipients ----------------------------------------------------------------------

/** The customer the import attaches an invoice to. */
export interface ImportCustomerRef {
  customerId: string;
  contactId: string;
  customerType: CustomerType;
  /** The customer row's tax fields, from which the tax profile key is derived. */
  vatId: string | null;
  countryCode: string;
}

/** How a run met its recipients (counts only). */
export interface RecipientStats {
  contactsCreated: number;
  contactsReused: number;
  customersCreated: number;
  /** Reused contacts whose current address differs from the printed one (the snapshot keeps the printed one). */
  addressDiffers: number;
}

/**
 * What a batch of imports shares: the customers already resolved (one lookup
 * per client), the counts, and per client the recipient data a NEW contact is
 * created with (the CLI passes the client's highest-numbered invoice in the
 * input; without it the invoice's own recipient is used).
 */
export interface ImportSession {
  readonly customers: Map<string, ImportCustomerRef>;
  readonly previewed: Set<string>;
  readonly stats: RecipientStats;
  readonly newContactData: Map<string, HistoricalRecipient>;
}

export function newImportSession(): ImportSession {
  return {
    customers: new Map(),
    previewed: new Set(),
    stats: { contactsCreated: 0, contactsReused: 0, customersCreated: 0, addressDiffers: 0 },
    newContactData: new Map(),
  };
}

/** The key that makes two recipients the same client (the contacts package's identity, kind aside). */
export function recipientKey(recipient: Pick<HistoricalRecipient, 'name'>): string {
  return contactIdentityKey('organization', recipient.name, '');
}

function sameAddress(a: { addressLine1: string | null; postalCode: string | null; city: string | null }, b: HistoricalRecipient): boolean {
  const n = (v: string | null) => (v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  return n(a.addressLine1) === n(b.addressLine1) && n(a.postalCode) === n(b.postalCode) && n(a.city) === n(b.city);
}

/**
 * The company's contact for a printed name: the organization of that name, else
 * the person of that name without a company or role, else the ONE person of
 * that name whatever their company or role (a person's identity includes it,
 * which the print does not tell). Two or more such persons are
 * RECIPIENT_AMBIGUOUS: the import never guesses between clients.
 */
async function findContact(scope: BooksScope, book: ContactBook, name: string): Promise<RecipientContact | null> {
  const exact =
    (await book.findSame(scope.tenantId, { kind: 'organization', name })) ??
    (await book.findSame(scope.tenantId, { kind: 'person', name, companyOrRole: '' }));
  if (exact) return exact;
  const key = contactIdentityKey('person', name, '');
  const persons = (await book.search(scope.tenantId, { search: name, limit: 50 })).filter(
    (c) => c.kind === 'person' && contactIdentityKey('person', c.name, '') === key,
  );
  if (persons.length > 1) {
    throw new BooksError('RECIPIENT_AMBIGUOUS', 'RECIPIENT_AMBIGUOUS: more than one person contact carries this name', {
      contactIds: persons.map((c) => c.id),
    });
  }
  return persons[0] ?? null;
}

/**
 * Find or create the recipient's contact and the company's customer for it.
 *
 * The rule (decided in the plan): a contact is the same client when the
 * contacts package's own identity matches (name, case and repeated whitespace
 * ignored; an organization is looked up first, then a person). That package
 * holds one contact per identity, so a matching name with a different address
 * is the same client at another address: the contact is reused unchanged and
 * counted. A new contact gets the session's data for that client (its
 * highest-numbered invoice) or this invoice's. A person is also matched
 * whatever their company or role when exactly one person carries the name;
 * two or more are RECIPIENT_AMBIGUOUS. The customer row is the existing one for
 * that contact, else a new one (business for an organization) with the
 * printed VAT id.
 */
export async function resolveImportRecipient(
  scope: BooksScope,
  book: ContactBook,
  recipient: HistoricalRecipient,
  session: ImportSession,
): Promise<ImportCustomerRef> {
  const key = recipientKey(recipient);
  const cached = session.customers.get(key);
  if (cached) return cached;
  const latest = session.newContactData.get(key) ?? recipient;

  let contact = await findContact(scope, book, recipient.name);
  if (contact) {
    session.stats.contactsReused += 1;
    if (!sameAddress(contact, recipient)) session.stats.addressDiffers += 1;
  } else {
    try {
      contact = await book.create(scope.tenantId, {
        kind: latest.kind,
        name: latest.name,
        addressLine1: latest.addressLine1,
        addressLine2: latest.addressLine2,
        postalCode: latest.postalCode,
        city: latest.city,
        country: latest.country,
        vatId: latest.vatId,
      });
      session.stats.contactsCreated += 1;
    } catch (err) {
      if (!isBooksError(err, 'DUPLICATE_CONTACT')) throw err;
      contact = await findContact(scope, book, latest.name);
      if (!contact) throw err;
      session.stats.contactsReused += 1;
    }
  }

  let [customer] = await customersByContactIds(scope, [contact.id]);
  if (!customer) {
    try {
      customer = await createCustomer(scope, {
        contactId: contact.id,
        customerType: contact.kind === 'organization' ? 'b2b' : 'b2c',
        vatId: latest.vatId,
        countryCode: latest.country,
      });
      session.stats.customersCreated += 1;
    } catch (err) {
      if (!isBooksError(err, 'DUPLICATE_CUSTOMER')) throw err;
      [customer] = await customersByContactIds(scope, [contact.id]);
      if (!customer) throw err;
    }
  }
  const ref: ImportCustomerRef = {
    customerId: customer.id,
    contactId: contact.id,
    customerType: customer.customerType,
    vatId: customer.vatId,
    countryCode: customer.countryCode,
  };
  session.customers.set(key, ref);
  return ref;
}

// --- the snapshots ---------------------------------------------------------------

export function importCustomerSnapshot(record: HistoricalInvoice, customer: ImportCustomerRef): CustomerSnapshotV1 {
  const r = record.recipient;
  return customerSnapshotV1Schema.parse({
    v: 1,
    contactId: customer.contactId,
    kind: r.kind,
    name: r.name,
    companyOrRole: '',
    legalForm: null,
    addressLine1: r.addressLine1,
    addressLine2: r.addressLine2,
    postalCode: r.postalCode,
    city: r.city,
    country: r.country,
    customerNumber: r.customerNumber,
    customerType: printedCustomerType(record),
    vatId: r.vatId,
    taxNumber: null,
    ...(r.addressLines ? { addressLines: r.addressLines } : {}),
    ...(r.customerNumberText !== null ? { customerNumberText: r.customerNumberText } : {}),
  });
}

/** The sender exactly as the record gives it (the CLI: as printed; the upload: the company's sender block). */
export function importSenderSnapshot(record: HistoricalInvoice): SenderSnapshotV1 {
  return senderSnapshotV1Schema.parse({ v: 1, ...record.sender });
}

/** Business or consumer as printed: an organization is a business. */
export function printedCustomerType(record: HistoricalInvoice): CustomerType {
  return record.recipient.kind === 'organization' ? 'b2b' : 'b2c';
}

/**
 * The document's frozen tax fields, from THIS invoice's printed recipient (never
 * from today's customer row, which may have changed since): business or
 * consumer, VAT id, country, and the small-business profile key they give.
 */
export function importTaxFields(record: HistoricalInvoice) {
  const customerType = printedCustomerType(record);
  const profile = resolveTaxProfile({
    companyTaxStatus: 'small_business',
    exemptionNote: record.taxNote,
    customerType,
    vatId: record.recipient.vatId,
    countryCode: record.recipient.country,
  });
  return { customerType, vatId: record.recipient.vatId, taxProfileKey: profile.key };
}

/** `issued_at` of an imported invoice: noon UTC of its issue date, the same calendar day in every European time zone. */
export function importIssuedAt(issueDate: string): Date {
  return new Date(`${issueDate}T12:00:00.000Z`);
}

// --- preview and import ------------------------------------------------------------

/**
 * What importing this record would do, writing nothing: `would_import` or
 * `already_imported` (IMPORT_CONFLICT and the counter refusals are thrown as
 * the import would throw them). Counts, once per client, whether its contact
 * would be created or reused.
 */
export async function previewHistoricalInvoice(
  scope: BooksScope,
  book: ContactBook,
  input: unknown,
  pdf: Uint8Array,
  session: ImportSession,
  opts: { now?: Date } = {},
): Promise<
  | { status: 'would_import'; record: HistoricalInvoice }
  | { status: 'already_imported'; differs: boolean; record: HistoricalInvoice }
> {
  const record = parseHistoricalInvoice(input, opts.now);
  const original = checkOriginal(pdf);
  await checkImportCounter(scope.db, scope, [record.numberValue]);
  const existing = judgeExisting(await existingInvoice(scope.db, scope, record.numberValue), record.numberValue, original.sha256, record);
  if (existing?.status === 'already_imported') return { status: 'already_imported', differs: existing.differs, record };
  // Build what the write would build, so a preview refuses what the import would.
  importSenderSnapshot(record);
  importCustomerSnapshot(record, { customerId: 'preview', contactId: 'preview', customerType: printedCustomerType(record), vatId: null, countryCode: record.recipient.country });
  const key = recipientKey(record.recipient);
  if (!session.customers.has(key) && !session.previewed.has(key)) {
    session.previewed.add(key);
    const contact = await findContact(scope, book, record.recipient.name);
    if (!contact) session.stats.contactsCreated += 1;
    else {
      session.stats.contactsReused += 1;
      if (!sameAddress(contact, record.recipient)) session.stats.addressDiffers += 1;
    }
  }
  return { status: 'would_import', record };
}

/**
 * Import one historical invoice with its original PDF: every check above, the
 * recipient found or created, then ONE transaction for the lines, the
 * document, the original, the pointer and the `issued` event. A number already
 * imported with the same original is `already_imported` (and creates nothing);
 * any other number already present is IMPORT_CONFLICT.
 */
export async function importHistoricalInvoice(
  scope: BooksScope,
  book: ContactBook,
  input: unknown,
  pdf: Uint8Array,
  session: ImportSession = newImportSession(),
  opts: { now?: Date } = {},
): Promise<ImportResult> {
  const record = parseHistoricalInvoice(input, opts.now);
  const original = checkOriginal(pdf);

  // Cheap refusals before anything is created in the contacts database.
  await checkImportCounter(scope.db, scope, [record.numberValue]);
  const before = judgeExisting(await existingInvoice(scope.db, scope, record.numberValue), record.numberValue, original.sha256, record);
  if (before) return before;

  const customer = await resolveImportRecipient(scope, book, record.recipient, session);
  const customerSnapshot = importCustomerSnapshot(record, customer);
  const senderSnapshot = importSenderSnapshot(record);
  const tax = importTaxFields(record);
  const taxSummary: TaxSummary = [{ taxRate: 0, taxTreatment: 'kleinunternehmer', net: record.total, tax: 0 }];

  try {
    return await withDbErrors(() =>
      scope.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx) => {
          // The counter row FOR SHARE: the number check holds until commit (the
          // counter only ever moves up, and an issue would wait for this lock).
          await checkImportCounter(trx, scope, [record.numberValue], { forShare: true });
          const judged = judgeExisting(await existingInvoice(trx, scope, record.numberValue), record.numberValue, original.sha256, record);
          if (judged) return judged;

          const documentId = randomUUID();
          const now = new Date();
          // Lines first, then the document (009: the line's foreign key is deferred
          // for this transaction only and checked at commit).
          await sql`SET CONSTRAINTS ${tenantSchemaRef(scope.tgId)}.${sql.ref('sales_document_line_document_fkey')} DEFERRED`.execute(trx);
          for (const [index, line] of record.lines.entries()) {
            await trx
              .insertInto('sales_document_line')
              .values({
                id: randomUUID(),
                tenant_id: scope.tenantId,
                document_id: documentId,
                position: index + 1,
                kind: line.kind,
                title: line.title,
                description: line.description,
                quantity: line.quantity,
                unit_label: line.unitLabel,
                unit_price: line.unitPrice,
                discount_bp: line.discountBp,
                subtotal: line.subtotal,
                tax_class: null,
                tax_rate_override: null,
                tax_rate: 0,
                tax_amount: 0,
                tax_treatment: line.kind === 'text' ? null : 'kleinunternehmer',
                variant_ref: null,
                variant_ref_source: 'none',
                updated_at: now,
              })
              .execute();
          }

          await trx
            .insertInto('sales_document')
            .values({
              id: documentId,
              tenant_id: scope.tenantId,
              doc_type: 'invoice',
              status: 'issued',
              source: 'import',
              customer_id: customer.customerId,
              template_id: null,
              // The number exactly as printed (the historical series is plain integers).
              document_number: String(record.numberValue),
              number_value: String(record.numberValue),
              issue_date: record.issueDate,
              service_date: record.serviceDate,
              service_period_start: record.servicePeriod?.start ?? null,
              service_period_end: record.servicePeriod?.end ?? null,
              due_date: record.dueDate,
              payment_terms_days: record.paymentTermsDays,
              currency_code: 'EUR',
              tax_region: 'DE',
              customer_type: tax.customerType,
              vat_id: tax.vatId,
              reverse_charge: false,
              net_or_gross: 'net',
              kleinunternehmer: true,
              tax_note: record.taxNote,
              tax_profile_key: tax.taxProfileKey,
              subtotal: record.total,
              tax_amount: 0,
              total: record.total,
              tax_summary: toJsonb(taxSummary),
              customer_snapshot: toJsonb(customerSnapshot),
              sender_snapshot: toJsonb(senderSnapshot),
              // No template: the stored original carries its own layout.
              template_snapshot: null,
              issued_at: importIssuedAt(record.issueDate),
              updated_at: now,
            })
            .execute();

          const fileId = randomUUID();
          await trx
            .insertInto('sales_document_file')
            .values({
              id: fileId,
              tenant_id: scope.tenantId,
              document_id: documentId,
              content_type: 'application/pdf',
              byte_size: original.bytes.byteLength,
              sha256: original.sha256,
              renderer: IMPORT_RENDERER,
              content: Buffer.from(original.bytes),
            })
            .execute();
          await trx
            .updateTable('sales_document')
            .set({ rendered_pdf_file_id: fileId, updated_at: now })
            .where('tenant_id', '=', scope.tenantId)
            .where('id', '=', documentId)
            .execute();

          await insertEvent(trx, scope, {
            documentId,
            eventType: 'issued',
            fromStatus: null,
            toStatus: 'issued',
            actorUserId: null,
            payload: {
              source: 'import',
              importOrigin: record.origin,
              numberValue: record.numberValue,
              fileSha256: original.sha256,
              lineCount: record.lines.length,
              ...record.provenance,
            },
          });
          return { status: 'imported' as const, documentId };
        }),
    );
  } catch (err) {
    // Two runs racing on one number: the loser sees the winner's row.
    if (sqlState(err) === '23505' && String(constraintName(err)).startsWith('sales_document_number')) {
      const judged = judgeExisting(await existingInvoice(scope.db, scope, record.numberValue), record.numberValue, original.sha256, record);
      if (judged) return judged;
    }
    throw err;
  }
}
