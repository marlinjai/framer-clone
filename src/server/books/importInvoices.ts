// src/server/books/importInvoices.ts
//
// The historical import of invoices issued before the Books existed (Books plan,
// "Historical import build notes (2026-10-20)"), the domain core. Its input is
// ONE historical invoice record, a typed and zod-validated shape that does not
// depend on where the data came from, plus the bytes of its original PDF:
//
//   - the operator CLI (importCli.ts, `pnpm books:import`) maps the owner's
//     private JSON extraction to records with origin `operator_file`;
//   - the upload import (src/server/books/upload) maps the model's reading of
//     each uploaded PDF, after the user reviewed it, to records with origin
//     `upload_extracted`; its sender is the printed one, the company's sender
//     block filling only what the PDF does not show.
//
// Both go through the same mapping from a printed invoice (importPrinted.ts).
//
// Nothing here reads a file or a command line. `importHistoricalInvoice` does
// every check and write for one record:
//
//   - the record is parsed (INVALID_INPUT naming the fields, never values), the
//     bytes must be a PDF, the issue date not in the future;
//   - its number is the printed one, stored as printed (never allocated, never
//     reformatted through the counter's format); its counter value comes from
//     the company's number format (none for a number in another format). The
//     counter policy decides what a number at or above the counter does: the
//     CLI refuses it (IMPORT_COUNTER_TOO_LOW), the upload raises the counter
//     past it, upwards only and only to the value the user confirmed
//     (COUNTER_RAISE_UNCONFIRMED); COUNTER_MISSING without a counter;
//   - a number already present is `already_imported` when it is an import whose
//     stored original has the same SHA-256, and IMPORT_CONFLICT otherwise;
//     nothing is ever overwritten, and nothing is created for it;
//   - the recipient is found or created in the shared contacts database, and
//     the Books customer for that contact found or created
//     (`resolveImportRecipient`, the rule is written there);
//   - the customer and sender snapshots are the record's own data (the sender
//     is an INPUT: the CLI passes the sender printed on that invoice, since the
//     owner moved several times), frozen as given;
//   - lines and totals as given, under the printed tax treatment: small
//     business (section 19 UStG, tax 0), regular taxation (net lines with
//     their printed rate and VAT) or reverse charge (section 13b UStG for a
//     business in another EU country, tax 0);
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

/** The ISO 4217 codes this runtime knows (Intl's list of currencies in use). */
const ISO_CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

/** True for an ISO 4217 currency code in use (EUR, CHF, USD, ...). */
export function isIsoCurrency(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) && ISO_CURRENCIES.has(value);
}
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
    /** Cents; negative on a printed discount line. */
    unitPrice: z.number().int().min(-MAX_CENTS).max(MAX_CENTS),
    /** Basis points as printed (0 when none); `subtotal` is the printed line total, authoritative even when it is not the arithmetic of the three. */
    discountBp: z.number().int().min(0).max(10000),
    /** Cents, the printed line total (net); negative on a printed discount line. */
    subtotal: z.number().int().min(-MAX_CENTS).max(MAX_CENTS),
    /** Basis points as printed (1900 = 19 %); 0 under section 19 and reverse charge. */
    taxRate: z.number().int().min(0).max(10000).default(0),
    /** Cents of VAT on the line as printed (or as derived from the printed tax groups); negative on a discount line. */
    taxAmount: z.number().int().min(-MAX_CENTS).max(MAX_CENTS).default(0),
  })
  .superRefine((l, ctx) => {
    if (
      l.kind === 'text' &&
      (l.quantity !== 0 || l.unitPrice !== 0 || l.subtotal !== 0 || l.discountBp !== 0 || l.taxRate !== 0 || l.taxAmount !== 0)
    ) {
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
    /** Empty when the print carries no street (warned: recipient_address_incomplete). */
    addressLine1: z.string().trim().max(300),
    addressLine2: z.string().trim().max(300).nullable(),
    /** Empty when the print carries none (abroad, or an incomplete print; warned). */
    postalCode: z.string().trim().max(20),
    city: z.string().trim().max(120),
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

/**
 * The issuer as printed on the invoice: the sender block's fields, plus the
 * printed lines when known. The name is required; an address the extraction
 * did not carry stays empty (warned: sender_address_missing), never invented:
 * the stored original is the document of record for it.
 */
const senderSchema = senderBlockV1Schema.extend({ addressLines: printedLines }).superRefine((s, ctx) => {
  if (s.legalName == null || s.legalName.trim() === '') ctx.addIssue({ code: 'custom', path: ['legalName'], message: 'required' });
  if (s.countryCode != null && !/^[A-Z]{2}$/.test(s.countryCode)) ctx.addIssue({ code: 'custom', path: ['countryCode'], message: 'expected an ISO 3166-1 alpha-2 code' });
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
    /** Neither a printed nor an inferred recipient country: DE was assumed (warned). */
    recipientCountryAssumed: z.boolean(),
    /** No sender country printed: DE, since only a German business can invoice under section 19 UStG. */
    senderCountryInferred: z.boolean(),
    /** Billable lines printed without a unit price (and maybe without a quantity): derived from the printed line total (warned). */
    linesPriceDerived: z.number().int().min(0).max(500),
    /** Lines whose printed discount could not be read: kept at 0, the printed line total stands (warned). */
    linesDiscountUnparsed: z.number().int().min(0).max(500),
    /** Billable lines whose VAT amount was derived from their rate and the printed tax groups (regular taxation). */
    linesTaxDerived: z.number().int().min(0).max(500),
    /** Sender fields the PDF does not show, filled from the company's current sender block (upload). */
    senderFieldsFromCompany: z.number().int().min(0).max(30),
    confidence: z.enum(['high', 'medium', 'low']),
  })
  .partial()
  .strict();

/** How the invoice was taxed, as printed. */
export const HISTORICAL_TAX_TREATMENTS = ['small_business', 'regular', 'reverse_charge'] as const;
export type HistoricalTaxTreatment = (typeof HISTORICAL_TAX_TREATMENTS)[number];

/**
 * The German VAT rates an imported line may carry (basis points): 19 and 7 %,
 * the 16 and 5 % of the second half of 2020, and 0. Another rate is a named
 * problem, never guessed.
 */
export const HISTORICAL_VAT_RATES: ReadonlySet<number> = new Set([0, 500, 700, 1600, 1900]);

/**
 * One historical invoice, ready to be imported. Money in cents, quantities in
 * thousandths, dates `YYYY-MM-DD`. Small business (section 19), regular
 * taxation (net lines with their printed rate and tax) and reverse charge
 * (section 13b, tax 0) are supported; the lines' net plus their tax must equal
 * the printed total.
 */
export const historicalInvoiceSchema = z
  .object({
    origin: z.enum(IMPORT_ORIGINS),
    /** The number exactly as printed ("62", "RE-2021-0012"). */
    documentNumber: z.string().trim().min(1).max(40).regex(/^[^\u0000-\u001f]+$/, 'printable characters only'),
    issueDate: isoDate,
    serviceDate: isoDate.nullable(),
    servicePeriod: z.object({ start: isoDate, end: isoDate }).nullable(),
    paymentTermsDays: z.number().int().min(0).max(365),
    dueDate: isoDate.nullable(),
    recipient: recipientSchema,
    sender: senderSchema,
    lines: z.array(lineSchema).min(1).max(500),
    total: cents,
    /**
     * The currency printed (ISO 4217). Kept as printed, never converted: EUR
     * for nearly all; the EUR value of another currency belongs to the
     * receipts app's income mirror, which matches the payment.
     */
    // Required, never defaulted: a missed extraction must not become a wrong currency.
    currency: z.string().refine(isIsoCurrency, 'expected an ISO 4217 currency code'),
    taxTreatment: z.enum(HISTORICAL_TAX_TREATMENTS),
    /** The tax note as printed (the section 19 or the reverse-charge notice); null when none is printed (warned where the law wants one). */
    taxNote: z.string().trim().min(1).max(500).nullable(),
    provenance: provenanceSchema.default({}),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (!r.lines.some((l) => l.kind !== 'text')) ctx.addIssue({ code: 'custom', path: ['lines'], message: 'at least one billable line' });
    const net = r.lines.reduce((acc, l) => acc + l.subtotal, 0);
    const tax = r.lines.reduce((acc, l) => acc + l.taxAmount, 0);
    if (net + tax !== r.total) {
      ctx.addIssue({ code: 'custom', path: ['total'], message: 'the lines (net plus tax) do not sum to the total' });
    }
    if (net < 0 || tax < 0) ctx.addIssue({ code: 'custom', path: ['total'], message: 'the net or the tax of the invoice is negative' });
    r.lines.forEach((l, i) => {
      if (l.kind === 'text') return;
      if (r.taxTreatment !== 'regular' && (l.taxRate !== 0 || l.taxAmount !== 0)) {
        ctx.addIssue({ code: 'custom', path: ['lines', i, 'taxRate'], message: 'no VAT under section 19 or reverse charge' });
      }
      if (r.taxTreatment === 'regular' && !HISTORICAL_VAT_RATES.has(l.taxRate)) {
        ctx.addIssue({ code: 'custom', path: ['lines', i, 'taxRate'], message: 'not a German VAT rate (19, 16, 7, 5 or 0 %)' });
      }
    });
    if (r.taxTreatment === 'reverse_charge') {
      // The database twin refuses it too (sales_document_reverse_charge_check).
      if (r.recipient.vatId === null) ctx.addIssue({ code: 'custom', path: ['recipient', 'vatId'], message: 'reverse charge needs the recipient VAT id' });
      if (r.recipient.kind !== 'organization') ctx.addIssue({ code: 'custom', path: ['recipient', 'kind'], message: 'reverse charge applies to a business' });
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

/** The counter row as the import reads it (FOR SHARE to hold a check, FOR UPDATE to raise it). */
async function readCounter(db: Db, scope: BooksScope, lock: 'none' | 'share' | 'update'): Promise<ImportCounter> {
  let q = db
    .selectFrom('document_number_counter')
    .select(['next_value', 'format'])
    .where('tenant_id', '=', scope.tenantId)
    .where('doc_type', '=', 'invoice');
  if (lock === 'share') q = q.forShare();
  if (lock === 'update') q = q.forUpdate();
  const counter = await q.executeTakeFirst();
  if (!counter) {
    throw new BooksError('COUNTER_MISSING', 'COUNTER_MISSING: no invoice counter for this company (run books:init-company first)', {
      docType: 'invoice',
    });
  }
  return { format: counter.format, nextValue: Number(counter.next_value) };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The counter value a printed number stands for, when it is written in the
 * company's own number format (`{n}` the number, `{n:4}` at least four
 * digits, literal text around it): "62" under `{n}`, "RE-0012" under
 * `RE-{n:4}`. null for a number in another format ("2021-0012" under `{n}`):
 * it is imported with its printed text and takes no part in the counter.
 */
export function numberValueFor(documentNumber: string, format: string): number | null {
  const m = /^(.*)\{n(?::([1-9]))?\}(.*)$/.exec(format);
  if (!m) return null;
  const digits = m[2] ? `(\\d{${m[2]},})` : '(\\d+)';
  const re = new RegExp(`^${escapeRegExp(m[1])}${digits}${escapeRegExp(m[3])}$`);
  const hit = re.exec(documentNumber.trim());
  if (!hit) return null;
  const value = Number(hit[1]);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/** How an import treats the invoice counter: the CLI refuses a number at or above it, the upload raises it. */
export type CounterPolicy = 'refuse' | 'raise';

// --- what is there already ---------------------------------------------------------

export type ExistingNumber =
  | { state: 'absent' }
  | { state: 'imported'; documentId: string; sha256: string | null; total: number; issueDate: string | null; currency: string }
  | { state: 'other'; documentId: string };

/**
 * What the company's books hold under an invoice number: the printed text, and
 * (given) the counter value it stands for. Accepts a plain integer for the
 * operator import's whole-run checks (its numbers are printed as integers).
 */
export async function existingInvoice(
  db: Db,
  scope: BooksScope,
  number: number | { documentNumber: string; numberValue: number | null },
): Promise<ExistingNumber> {
  const n = typeof number === 'number' ? { documentNumber: String(number), numberValue: number } : number;
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
      'sales_document.currency_code',
      eb.cast<string | null>('sales_document.issue_date', 'text').as('issue_date'),
      'sales_document_file.sha256',
    ])
    .where('sales_document.tenant_id', '=', scope.tenantId)
    .where('sales_document.doc_type', '=', 'invoice')
    .where((eb) =>
      n.numberValue === null
        ? eb('sales_document.document_number', '=', n.documentNumber)
        : eb.or([
            eb('sales_document.document_number', '=', n.documentNumber),
            eb('sales_document.number_value', '=', String(n.numberValue)),
          ]),
    )
    .executeTakeFirst();
  if (!row) return { state: 'absent' };
  if (row.source !== 'import') return { state: 'other', documentId: row.id };
  return {
    state: 'imported',
    documentId: row.id,
    sha256: row.sha256 ?? null,
    total: row.total,
    issueDate: row.issue_date,
    currency: row.currency_code,
  };
}

/**
 * What the import holds in the company's books, per issue year: the count and
 * the sum of the totals (cents) of every invoice with `source = 'import'` that
 * is not cancelled (cancelled ones: importedCancelled). The figures to compare
 * with the filed returns, read from the books themselves.
 */
export async function importedYearTotals(
  db: Db,
  scope: BooksScope,
): Promise<Array<{ year: string; currency: string; count: number; total: number }>> {
  // Per year AND currency: amounts of different currencies are never added up.
  const rows = await db
    .selectFrom('sales_document')
    .select((eb) => [
      sql<string>`to_char(${eb.ref('sales_document.issue_date')}, 'YYYY')`.as('year'),
      'sales_document.currency_code as currency',
      sql<string>`count(*)`.as('count'),
      sql<string>`coalesce(sum(${eb.ref('sales_document.total')}), 0)`.as('total'),
    ])
    .where('sales_document.tenant_id', '=', scope.tenantId)
    .where('sales_document.doc_type', '=', 'invoice')
    .where('sales_document.source', '=', 'import')
    .where('sales_document.status', '<>', 'cancelled')
    .groupBy(sql`1, 2`)
    .orderBy(sql`1, 2`)
    .execute();
  return rows.map((r) => ({ year: r.year, currency: r.currency, count: Number(r.count), total: Number(r.total) }));
}

/** Imported invoices cancelled since (through a credit note): left out of the yearly totals, reported apart. */
export async function importedCancelled(db: Db, scope: BooksScope): Promise<Array<{ currency: string; count: number; total: number }>> {
  const rows = await db
    .selectFrom('sales_document')
    .select(['currency_code as currency', sql<string>`count(*)`.as('count'), sql<string>`coalesce(sum(total), 0)`.as('total')])
    .where('tenant_id', '=', scope.tenantId)
    .where('doc_type', '=', 'invoice')
    .where('source', '=', 'import')
    .where('status', '=', 'cancelled')
    .groupBy('currency_code')
    .orderBy('currency_code')
    .execute();
  return rows.map((r) => ({ currency: r.currency, count: Number(r.count), total: Number(r.total) }));
}

export type ImportResult =
  | {
      status: 'imported';
      documentId: string;
      warnings: ImportWarning[];
      /** The counter value of the printed number, null when it is not in the company's format. */
      numberValue: number | null;
      /** The counter's new next value when the import raised it (counter policy `raise`), else null. */
      counterRaisedTo: number | null;
    }
  | {
      status: 'already_imported';
      documentId: string;
      /**
       * True when the stored document's total, issue date or currency differs from the
       * record (same original, data corrected since). Nothing is changed: the
       * caller reports it, so the difference is never silent.
       */
      differs: boolean;
    };

function conflict(number: string | number, documentId: string, why: string): BooksError {
  return new BooksError('IMPORT_CONFLICT', `IMPORT_CONFLICT: invoice ${number} ${why}; nothing was changed`, {
    documentNumber: String(number),
    documentId,
  });
}

/** Decide what an existing number means for an original with this digest (and, given the record, whether its data still agrees). */
export function judgeExisting(
  existing: ExistingNumber,
  numberValue: string | number,
  sha256: string,
  record?: Pick<HistoricalInvoice, 'total' | 'issueDate' | 'currency'>,
): ImportResult | null {
  if (existing.state === 'absent') return null;
  if (existing.state === 'other') throw conflict(numberValue, existing.documentId, 'already exists as a document of this system');
  if (existing.sha256 !== sha256) throw conflict(numberValue, existing.documentId, 'was imported with a different file');
  const differs =
    record !== undefined &&
    (existing.total !== record.total || existing.issueDate !== record.issueDate || existing.currency !== record.currency);
  return { status: 'already_imported', documentId: existing.documentId, differs };
}

// --- recipients ----------------------------------------------------------------------

/** The contact and customer the import attaches an invoice to. */
export interface ImportCustomerRef {
  customerId: string;
  contactId: string;
}

/** How a run met its recipients (counts only). */
export interface RecipientStats {
  contactsCreated: number;
  contactsReused: number;
  /** Customers created by committed imports. */
  customersCreated: number;
  /** Reused contacts whose current address differs from the printed one (the snapshot keeps the printed one). */
  addressDiffers: number;
}

/**
 * What a batch of imports shares: the contacts already found or created (one
 * lookup per client), the counts, and per client the recipient data a NEW
 * contact is created with (the CLI passes the client's highest-numbered invoice
 * in the input; without it the invoice's own recipient is used).
 */
export interface ImportSession {
  readonly contacts: Map<string, RecipientContact>;
  readonly previewed: Set<string>;
  readonly stats: RecipientStats;
  readonly newContactData: Map<string, HistoricalRecipient>;
}

export function newImportSession(): ImportSession {
  return {
    contacts: new Map(),
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
  const persons = await book.personsNamed(scope.tenantId, name);
  if (persons.length > 1) {
    throw new BooksError('RECIPIENT_AMBIGUOUS', 'RECIPIENT_AMBIGUOUS: more than one person contact carries this name', {
      contactIds: persons.map((c) => c.id),
    });
  }
  return persons[0] ?? null;
}

function countFound(session: ImportSession, contact: RecipientContact, recipient: HistoricalRecipient): void {
  session.stats.contactsReused += 1;
  if (!sameAddress(contact, recipient)) session.stats.addressDiffers += 1;
}

/**
 * Find or create the recipient's contact in the shared contacts database.
 *
 * The rule (decided in the plan): a contact is the same client when the
 * contacts package's own identity matches (name, case and repeated whitespace
 * ignored; an organization is looked up first, then a person, see
 * findContact). That package holds one contact per identity, so a matching name
 * with a different address is the same client at another address: the contact
 * is reused unchanged and counted. A new contact gets the session's data for
 * that client (its highest-numbered invoice) or this invoice's.
 *
 * This runs OUTSIDE the Books transaction (another database; a network call
 * must not hold the document locks). Every refusal that can be known before is
 * checked before it, so the only way to leave a contact without a document is
 * a failure of the write itself; the contact then stays (a contact without
 * invoices is harmless and a retry reuses it), the customer row does not (it is
 * written inside the transaction).
 */
export async function resolveImportContact(
  scope: BooksScope,
  book: ContactBook,
  recipient: HistoricalRecipient,
  session: ImportSession,
  opts: { countryAssumed?: boolean } = {},
): Promise<RecipientContact> {
  const key = recipientKey(recipient);
  const cached = session.contacts.get(key);
  if (cached) return cached;
  const latest = session.newContactData.get(key) ?? recipient;

  let contact = await findContact(scope, book, recipient.name);
  if (contact) countFound(session, contact, recipient);
  else {
    try {
      contact = await book.create(scope.tenantId, {
        kind: latest.kind,
        name: latest.name,
        addressLine1: latest.addressLine1 === '' ? null : latest.addressLine1,
        addressLine2: latest.addressLine2,
        postalCode: latest.postalCode === '' ? null : latest.postalCode,
        city: latest.city === '' ? null : latest.city,
        // An assumed country stays in the Books; the shared contacts database gets none rather than a guess.
        country: opts.countryAssumed && latest === recipient ? null : latest.country,
        vatId: latest.vatId,
      });
      session.stats.contactsCreated += 1;
    } catch (err) {
      // Created meanwhile by someone else: take that one.
      if (!isBooksError(err, 'DUPLICATE_CONTACT')) throw err;
      contact = await findContact(scope, book, latest.name);
      if (!contact) throw err;
      countFound(session, contact, recipient);
    }
  }
  session.contacts.set(key, contact);
  return contact;
}

/**
 * Inside the import transaction: the company's customer for the contact, or a
 * new one (business for an organization, the printed VAT id and country of the
 * client's highest-numbered invoice). Rolled back with the document.
 */
async function ensureCustomerIn(
  trx: Transaction<CommerceDB>,
  scope: BooksScope,
  contact: RecipientContact,
  latest: HistoricalRecipient,
): Promise<{ customerId: string; created: boolean }> {
  const find = () =>
    trx
      .selectFrom('customer')
      .select('id')
      .where('tenant_id', '=', scope.tenantId)
      .where('contact_id', '=', contact.id)
      .executeTakeFirst();
  const existing = await find();
  if (existing) return { customerId: existing.id, created: false };
  const inserted = await trx
    .insertInto('customer')
    .values({
      id: randomUUID(),
      tenant_id: scope.tenantId,
      contact_id: contact.id,
      customer_type: contact.kind === 'organization' ? 'b2b' : 'b2c',
      vat_id: latest.vatId,
      country_code: latest.country,
      tax_number: null,
      updated_at: new Date(),
    })
    .onConflict((oc) => oc.columns(['tenant_id', 'contact_id']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted) return { customerId: inserted.id, created: true };
  const raced = await find();
  if (!raced) throw new BooksError('CUSTOMER_NOT_FOUND', 'CUSTOMER_NOT_FOUND: the customer of the contact vanished');
  return { customerId: raced.id, created: false };
}

// --- the snapshots ---------------------------------------------------------------

export function importCustomerSnapshot(record: HistoricalInvoice, contactId: string): CustomerSnapshotV1 {
  const r = record.recipient;
  return customerSnapshotV1Schema.parse({
    v: 1,
    contactId,
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

/** The sender exactly as the record gives it (as printed; the upload fills what the PDF does not show from the company's sender block). */
export function importSenderSnapshot(record: HistoricalInvoice): SenderSnapshotV1 {
  return senderSnapshotV1Schema.parse({ v: 1, ...record.sender });
}

/** Business or consumer as printed: an organization is a business. */
export function printedCustomerType(record: HistoricalInvoice): CustomerType {
  return record.recipient.kind === 'organization' ? 'b2b' : 'b2c';
}

/**
 * The document's frozen tax fields, from THIS invoice's print (never from
 * today's customer row, which may have changed since): business or consumer,
 * VAT id, the treatment flags and the profile key they give, and the tax
 * summary grouped by rate and treatment from the printed lines.
 */
export function importTaxFields(record: HistoricalInvoice) {
  const customerType = printedCustomerType(record);
  const profile = resolveTaxProfile({
    companyTaxStatus: record.taxTreatment === 'small_business' ? 'small_business' : 'regular',
    exemptionNote: record.taxNote ?? '',
    customerType,
    vatId: record.recipient.vatId,
    countryCode: record.recipient.country,
  });
  const groups = new Map<string, TaxSummary[number]>();
  for (const l of record.lines) {
    if (l.kind === 'text') continue;
    const treatment = lineTreatment(record.taxTreatment, l.taxRate);
    const key = `${l.taxRate}|${treatment}`;
    const g = groups.get(key) ?? { taxRate: l.taxRate, taxTreatment: treatment, net: 0, tax: 0 };
    g.net += l.subtotal;
    g.tax += l.taxAmount;
    groups.set(key, g);
  }
  return {
    customerType,
    vatId: record.recipient.vatId,
    taxProfileKey: profile.key,
    kleinunternehmer: record.taxTreatment === 'small_business',
    reverseCharge: record.taxTreatment === 'reverse_charge',
    subtotal: record.lines.reduce((acc, l) => acc + l.subtotal, 0),
    taxAmount: record.lines.reduce((acc, l) => acc + l.taxAmount, 0),
    taxSummary: [...groups.values()].sort((a, b) => b.taxRate - a.taxRate),
  };
}

/** The stored treatment of a billable line: section 19, reverse charge, or the rate's class (5 and 7 % reduced). */
export function lineTreatment(treatment: HistoricalTaxTreatment, rate: number): TaxSummary[number]['taxTreatment'] {
  if (treatment === 'small_business') return 'kleinunternehmer';
  if (treatment === 'reverse_charge') return 'reverse_charge';
  if (rate === 0) return 'zero';
  return rate === 500 || rate === 700 ? 'reduced' : 'standard';
}

/** `issued_at` of an imported invoice: noon UTC of its issue date, the same calendar day in every European time zone. */
export function importIssuedAt(issueDate: string): Date {
  return new Date(`${issueDate}T12:00:00.000Z`);
}

// --- warnings ------------------------------------------------------------------------

/**
 * What an import takes as given but reports: the printed figures are
 * authoritative for a historical invoice, so these never refuse it.
 *   - `line_not_quantity_times_price`: billable lines whose printed total is not
 *     quantity times unit price less the discount (a fixed fee of 3 x 1166.67
 *     printed as 3500.00, a discount the extraction did not carry). Stored as
 *     printed; `count` lines.
 *   - `issue_date_out_of_number_order`: the issue date lies before an imported
 *     lower number's date or after an imported higher number's (a swapped day
 *     and month, typically). Stored as given.
 *   - `line_price_derived`, `discount_unparsed`: the source said so in the
 *     record's provenance (a unit price taken from the line total, a printed
 *     discount that could not be read).
 *   - `sender_address_missing`, `recipient_address_incomplete`: an address the
 *     record does not carry in full; stored empty, never invented.
 *   - `recipient_country_assumed`: neither printed nor inferred, DE assumed.
 *   - `line_tax_not_rate_times_net`: a line's printed VAT is more than a cent
 *     off its rate times its net. Stored as printed.
 *   - `tax_note_missing`: a section 19 or reverse-charge invoice without its
 *     printed notice. A historical record: reported, never blocking.
 *   - `line_tax_derived`: lines without a printed VAT amount, derived from their
 *     rate and adjusted to the printed tax group.
 *   - `sender_from_company`: sender fields the PDF did not show, taken from
 *     the company's current sender block;
 *   - `service_date_unparsed`, `payment_terms_unparsed`,
 *     `recipient_vat_id_unparsed`: printed, but not readable as a date or
 *     period, a number of days, or a valid VAT id; the record carries none
 *     (the stored original shows them).
 */
export type ImportWarning =
  | { code: 'line_not_quantity_times_price'; count: number }
  | { code: 'line_tax_not_rate_times_net'; count: number }
  | { code: 'tax_note_missing' }
  | { code: 'line_tax_derived'; count: number }
  | { code: 'sender_from_company'; count: number }
  | { code: 'line_price_derived'; count: number }
  | { code: 'discount_unparsed'; count: number }
  | { code: 'issue_date_out_of_number_order' }
  | { code: 'sender_address_missing' }
  | { code: 'recipient_address_incomplete' }
  | { code: 'recipient_country_assumed' }
  | { code: 'service_date_unparsed' }
  | { code: 'payment_terms_unparsed' }
  | { code: 'recipient_vat_id_unparsed' };

/** The lines whose printed total is not their arithmetic (any difference, a rounding cent included). */
export function linesNotQuantityTimesPrice(record: Pick<HistoricalInvoice, 'lines'>): number {
  return record.lines.filter(
    (l) =>
      l.kind !== 'text' &&
      Math.round((l.quantity * l.unitPrice * (10000 - l.discountBp)) / (1000 * 10000)) !== l.subtotal,
  ).length;
}

/** Lines whose printed VAT is more than a cent off their rate times their net. */
export function linesTaxNotRateTimesNet(record: Pick<HistoricalInvoice, 'lines'>): number {
  return record.lines.filter(
    (l) => l.kind !== 'text' && Math.abs(Math.round((l.subtotal * l.taxRate) / 10000) - l.taxAmount) > 1,
  ).length;
}

async function issueDateOutOfOrder(db: Db, scope: BooksScope, record: HistoricalInvoice, numberValue: number | null): Promise<boolean> {
  // Only a number in the company's format has neighbours in the series.
  if (numberValue === null) return false;
  const row = await db
    .selectFrom('sales_document')
    .select([
      sql<string | null>`max(issue_date) FILTER (WHERE number_value < ${String(numberValue)})::text`.as('before'),
      sql<string | null>`min(issue_date) FILTER (WHERE number_value > ${String(numberValue)})::text`.as('after'),
    ])
    .where('tenant_id', '=', scope.tenantId)
    .where('doc_type', '=', 'invoice')
    .where('source', '=', 'import')
    .executeTakeFirst();
  return (row?.before != null && record.issueDate < row.before) || (row?.after != null && record.issueDate > row.after);
}

/** The warnings that follow from the record alone (no database). */
export function recordWarnings(record: HistoricalInvoice): ImportWarning[] {
  const out: ImportWarning[] = [];
  const lines = linesNotQuantityTimesPrice(record);
  if (lines > 0) out.push({ code: 'line_not_quantity_times_price', count: lines });
  const derived = record.provenance.linesPriceDerived ?? 0;
  if (derived > 0) out.push({ code: 'line_price_derived', count: derived });
  const discounts = record.provenance.linesDiscountUnparsed ?? 0;
  if (discounts > 0) out.push({ code: 'discount_unparsed', count: discounts });
  const blank = (v: string | null | undefined) => v == null || v.trim() === '';
  if (blank(record.sender.addressLine1) || blank(record.sender.city)) out.push({ code: 'sender_address_missing' });
  const r = record.recipient;
  if (blank(r.addressLine1) || blank(r.postalCode) || blank(r.city)) out.push({ code: 'recipient_address_incomplete' });
  if (record.provenance.recipientCountryAssumed) out.push({ code: 'recipient_country_assumed' });
  const taxOff = linesTaxNotRateTimesNet(record);
  if (taxOff > 0) out.push({ code: 'line_tax_not_rate_times_net', count: taxOff });
  if (record.taxTreatment !== 'regular' && record.taxNote === null) out.push({ code: 'tax_note_missing' });
  const taxDerived = record.provenance.linesTaxDerived ?? 0;
  if (taxDerived > 0) out.push({ code: 'line_tax_derived', count: taxDerived });
  const fromCompany = record.provenance.senderFieldsFromCompany ?? 0;
  if (fromCompany > 0) out.push({ code: 'sender_from_company', count: fromCompany });
  // Printed but not readable: the record carries none, the stored original has it.
  if (record.provenance.serviceDateUnparsed) out.push({ code: 'service_date_unparsed' });
  if (record.provenance.paymentTermsUnparsed) out.push({ code: 'payment_terms_unparsed' });
  if (record.provenance.recipientVatIdUnparsed) out.push({ code: 'recipient_vat_id_unparsed' });
  return out;
}

async function warningsFor(db: Db, scope: BooksScope, record: HistoricalInvoice, numberValue: number | null): Promise<ImportWarning[]> {
  const out = recordWarnings(record);
  if (await issueDateOutOfOrder(db, scope, record, numberValue)) out.push({ code: 'issue_date_out_of_number_order' });
  return out;
}

// --- the same original under another number -------------------------------------------

/** The printed number of another imported invoice that already holds these exact bytes, if any. */
async function otherNumberWithOriginal(db: Db, scope: BooksScope, sha256: string, documentNumber: string): Promise<string | null> {
  const row = await db
    .selectFrom('sales_document_file')
    .innerJoin('sales_document', (join) =>
      join
        .onRef('sales_document.tenant_id', '=', 'sales_document_file.tenant_id')
        .onRef('sales_document.id', '=', 'sales_document_file.document_id'),
    )
    .select('sales_document.document_number')
    .where('sales_document_file.tenant_id', '=', scope.tenantId)
    .where('sales_document_file.renderer', '=', IMPORT_RENDERER)
    .where('sales_document_file.sha256', '=', sha256)
    .where('sales_document.document_number', '<>', documentNumber)
    .executeTakeFirst();
  return row?.document_number ?? null;
}

function sameOriginalConflict(documentNumber: string, other: string): BooksError {
  return new BooksError(
    'IMPORT_CONFLICT',
    `IMPORT_CONFLICT: invoice ${documentNumber}: the same original is already stored as invoice ${other}; nothing was changed`,
    { documentNumber, otherDocumentNumber: other },
  );
}

// --- preview and import ------------------------------------------------------------

export type PreviewResult =
  | {
      status: 'would_import';
      record: HistoricalInvoice;
      warnings: ImportWarning[];
      numberValue: number | null;
      /** The counter's next value after this import under the `raise` policy, when it would move; else null. */
      counterRaisedTo: number | null;
    }
  | { status: 'already_imported'; differs: boolean; record: HistoricalInvoice };

/** Options of the preview and the import. */
export interface ImportOptions {
  now?: Date;
  /** `refuse` (default, the operator import) or `raise` (the upload: the counter moves past the number, upwards only). */
  counterPolicy?: CounterPolicy;
  /**
   * Runs inside the import's transaction after the document and its original
   * are written, before the commit (the upload marks its staging row imported
   * here); a throw rolls the whole import back.
   */
  inTransaction?: (trx: Transaction<CommerceDB>, documentId: string) => Promise<void>;
  /**
   * Counter policy `raise` only: the one raise the caller confirmed (the new
   * next value). A raise to any other value, or a raise when none was
   * confirmed (`null`), is COUNTER_RAISE_UNCONFIRMED and nothing is written:
   * raising the counter cannot be undone (BK003). Undefined: no confirmation
   * is asked (tests and callers that decide themselves).
   */
  confirmedCounterRaiseTo?: number | null;
}

/** A raise of the counter that was not confirmed for exactly this value. */
export function counterRaiseUnconfirmed(raiseTo: number, confirmed: number | null): BooksError {
  return new BooksError(
    'COUNTER_RAISE_UNCONFIRMED',
    `COUNTER_RAISE_UNCONFIRMED: importing raises the invoice counter to ${raiseTo}${confirmed === null ? '' : ` (confirmed: ${confirmed})`}; confirm that value`,
    { raiseTo, confirmed },
  );
}

/** The counter value of the record's number and what the counter policy makes of it. */
/**
 * The counter value of a record's number: by the company's number format; for
 * the operator's file (`pnpm books:import`, whose numbers are integers) a plain
 * integer is its own value under any format, so the counter refusal and the
 * date-order warning hold whatever the format.
 */
export function recordNumberValue(record: Pick<HistoricalInvoice, 'documentNumber' | 'origin'>, format: string): number | null {
  const byFormat = numberValueFor(record.documentNumber, format);
  if (byFormat !== null || record.origin !== 'operator_file' || !/^\d{1,15}$/.test(record.documentNumber)) return byFormat;
  const value = Number(record.documentNumber);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function counterEffect(
  counter: ImportCounter,
  record: HistoricalInvoice,
  policy: CounterPolicy,
): { numberValue: number | null; raiseTo: number | null } {
  const numberValue = recordNumberValue(record, counter.format);
  if (numberValue === null || numberValue < counter.nextValue) return { numberValue, raiseTo: null };
  if (policy === 'refuse') {
    throw new BooksError(
      'IMPORT_COUNTER_TOO_LOW',
      `IMPORT_COUNTER_TOO_LOW: the invoice counter is at ${counter.nextValue}, but the import holds number ${numberValue}`,
      { nextValue: counter.nextValue, highest: numberValue, count: 1 },
    );
  }
  return { numberValue, raiseTo: numberValue + 1 };
}

/** The checks both the preview and the import make before anything is created. */
async function checkBefore(
  scope: BooksScope,
  record: HistoricalInvoice,
  sha256: string,
  policy: CounterPolicy,
): Promise<{ done: ImportResult | null; numberValue: number | null; raiseTo: number | null }> {
  const counter = await readCounter(scope.db, scope, 'none');
  const effect = counterEffect(counter, record, policy);
  const number = { documentNumber: record.documentNumber, numberValue: effect.numberValue };
  const existing = judgeExisting(await existingInvoice(scope.db, scope, number), record.documentNumber, sha256, record);
  if (existing) return { done: existing, ...effect };
  const other = await otherNumberWithOriginal(scope.db, scope, sha256, record.documentNumber);
  if (other !== null) throw sameOriginalConflict(record.documentNumber, other);
  return { done: null, ...effect };
}

/**
 * What importing this record would do, writing nothing: `would_import` (with
 * the warnings the import would report) or `already_imported`. Every refusal
 * the import would make before writing is made here the same way (the record,
 * the PDF, the counter, a conflicting number or original, an ambiguous
 * recipient, the snapshots). Counts, once per client, whether its contact
 * would be created or reused.
 */
export async function previewHistoricalInvoice(
  scope: BooksScope,
  book: ContactBook,
  input: unknown,
  pdf: Uint8Array,
  session: ImportSession,
  opts: ImportOptions = {},
): Promise<PreviewResult> {
  const record = parseHistoricalInvoice(input, opts.now);
  const original = checkOriginal(pdf);
  const before = await checkBefore(scope, record, original.sha256, opts.counterPolicy ?? 'refuse');
  if (before.done?.status === 'already_imported') return { status: 'already_imported', differs: before.done.differs, record };
  importSenderSnapshot(record);
  importCustomerSnapshot(record, 'preview');
  const key = recipientKey(record.recipient);
  if (!session.contacts.has(key) && !session.previewed.has(key)) {
    session.previewed.add(key);
    const contact = await findContact(scope, book, record.recipient.name);
    if (!contact) session.stats.contactsCreated += 1;
    else countFound(session, contact, record.recipient);
  }
  return {
    status: 'would_import',
    record,
    warnings: await warningsFor(scope.db, scope, record, before.numberValue),
    numberValue: before.numberValue,
    counterRaisedTo: before.raiseTo,
  };
}

/**
 * The write's own database errors, without their detail: postgres reports a
 * failing row (snapshots, names, addresses) in the message and detail, which
 * must never reach a log. The SQLSTATE and the constraint name are kept; the
 * original error is deliberately NOT attached as the cause.
 */
function writeFailed(err: unknown): BooksError {
  const state = sqlState(err) ?? null;
  const constraint = constraintName(err) ?? null;
  return new BooksError('IMPORT_FAILED', `IMPORT_FAILED: SQLSTATE ${state ?? 'unknown'}${constraint ? ` (${constraint})` : ''}`, {
    sqlState: state,
    constraint,
  });
}

/**
 * Import one historical invoice with its original PDF: every check above, the
 * contact found or created, then ONE transaction for the customer (when new),
 * the lines, the document, the original, the pointer and the `issued` event. A
 * number already imported with the same original is `already_imported` (and
 * creates nothing); any other number already present, or the same original
 * stored under another number, is IMPORT_CONFLICT.
 */
export async function importHistoricalInvoice(
  scope: BooksScope,
  book: ContactBook,
  input: unknown,
  pdf: Uint8Array,
  session: ImportSession = newImportSession(),
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const policy = opts.counterPolicy ?? 'refuse';
  const record = parseHistoricalInvoice(input, opts.now);
  const original = checkOriginal(pdf);
  const before = await checkBefore(scope, record, original.sha256, policy);
  if (before.done) return before.done;
  // Both snapshots are built before any contact is created, so a record they refuse creates nothing.
  importCustomerSnapshot(record, 'probe');
  const senderSnapshot = importSenderSnapshot(record);
  const tax = importTaxFields(record);

  const contact = await resolveImportContact(scope, book, record.recipient, session, {
    countryAssumed: record.provenance.recipientCountryAssumed === true,
  });
  const latest = session.newContactData.get(recipientKey(record.recipient)) ?? record.recipient;
  const customerSnapshot = importCustomerSnapshot(record, contact.id);

  let outcome: { result: ImportResult; customerCreated: boolean };
  try {
    outcome = await withDbErrors(() =>
      scope.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx) => {
          // One import of these bytes at a time for the company, so two numbers can
          // never both store the same original (there is no unique index on it).
          await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`books-import:${scope.tenantId}:${original.sha256}`}, 0))`.execute(trx);
          // The counter row: FOR SHARE holds the number check until commit (the
          // counter only ever moves up, and an issue would wait for this lock);
          // FOR UPDATE when this import may raise it.
          const counter = await readCounter(trx, scope, policy === 'raise' ? 'update' : 'share');
          const effect = counterEffect(counter, record, policy);
          if (opts.confirmedCounterRaiseTo !== undefined && effect.raiseTo !== null && effect.raiseTo !== opts.confirmedCounterRaiseTo) {
            throw counterRaiseUnconfirmed(effect.raiseTo, opts.confirmedCounterRaiseTo);
          }
          const number = { documentNumber: record.documentNumber, numberValue: effect.numberValue };
          const judged = judgeExisting(await existingInvoice(trx, scope, number), record.documentNumber, original.sha256, record);
          if (judged) return { result: judged, customerCreated: false };
          const other = await otherNumberWithOriginal(trx, scope, original.sha256, record.documentNumber);
          if (other !== null) throw sameOriginalConflict(record.documentNumber, other);
          const warnings = await warningsFor(trx, scope, record, effect.numberValue);

          const customer = await ensureCustomerIn(trx, scope, contact, latest);
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
                tax_rate: line.taxRate,
                tax_amount: line.taxAmount,
                tax_treatment: line.kind === 'text' ? null : lineTreatment(record.taxTreatment, line.taxRate),
                variant_ref: null,
                variant_ref_source: 'none',
                updated_at: now,
              })
              .execute();
          }

          const documentNumber = record.documentNumber;
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
              // The number exactly as printed; its counter value only when it is in
              // the company's format (else it takes no part in the series, 010).
              document_number: documentNumber,
              number_value: effect.numberValue === null ? null : String(effect.numberValue),
              issue_date: record.issueDate,
              service_date: record.serviceDate,
              service_period_start: record.servicePeriod?.start ?? null,
              service_period_end: record.servicePeriod?.end ?? null,
              due_date: record.dueDate,
              payment_terms_days: record.paymentTermsDays,
              currency_code: record.currency,
              tax_region: 'DE',
              customer_type: tax.customerType,
              vat_id: tax.vatId,
              reverse_charge: tax.reverseCharge,
              net_or_gross: 'net',
              kleinunternehmer: tax.kleinunternehmer,
              tax_note: record.taxNote,
              tax_profile_key: tax.taxProfileKey,
              subtotal: tax.subtotal,
              tax_amount: tax.taxAmount,
              total: record.total,
              tax_summary: toJsonb(tax.taxSummary),
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

          // The counter past the number (policy `raise`), upwards only: BK003 refuses a lowering.
          let counterRaisedTo: number | null = null;
          if (effect.raiseTo !== null) {
            const raised = await trx
              .updateTable('document_number_counter')
              .set({ next_value: String(effect.raiseTo), updated_at: now })
              .where('tenant_id', '=', scope.tenantId)
              .where('doc_type', '=', 'invoice')
              .where('next_value', '<', String(effect.raiseTo))
              .executeTakeFirst();
            if (Number(raised.numUpdatedRows) > 0) counterRaisedTo = effect.raiseTo;
          }

          // The editor's `issued` event fields, plus how the import came about.
          await insertEvent(trx, scope, {
            documentId,
            eventType: 'issued',
            fromStatus: null,
            toStatus: 'issued',
            actorUserId: null,
            payload: {
              documentNumber,
              issueDate: record.issueDate,
              total: record.total,
              taxProfileKey: tax.taxProfileKey,
              source: 'import',
              importOrigin: record.origin,
              numberValue: effect.numberValue,
              counterRaisedTo,
              fileSha256: original.sha256,
              lineCount: record.lines.length,
              warnings: warnings.map((w) => w.code),
              linesNotQuantityTimesPrice: linesNotQuantityTimesPrice(record),
              ...record.provenance,
            },
          });
          if (opts.inTransaction) await opts.inTransaction(trx, documentId);
          return {
            result: { status: 'imported' as const, documentId, warnings, numberValue: effect.numberValue, counterRaisedTo },
            customerCreated: customer.created,
          };
        }),
    );
  } catch (err) {
    // Two runs racing on one number: the loser sees the winner's row.
    if (sqlState(err) === '23505' && String(constraintName(err)).startsWith('sales_document_number')) {
      const number = { documentNumber: record.documentNumber, numberValue: before.numberValue };
      const judged = judgeExisting(await existingInvoice(scope.db, scope, number), record.documentNumber, original.sha256, record);
      if (judged) return judged;
    }
    if (isBooksError(err)) throw err;
    throw writeFailed(err);
  }
  if (outcome.customerCreated) session.stats.customersCreated += 1;
  return outcome.result;
}
