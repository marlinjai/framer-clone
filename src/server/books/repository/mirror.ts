// src/server/books/repository/mirror.ts
//
// The read the receipts app mirrors its income from (Books plan, section
// "Phase 4" and roadmap line "4. Existing invoices and the suite"): the
// company's ISSUED invoices and credit notes, all in one answer, in exactly the
// shape receipt-ocr-app's `parseBooksDocuments` (src/lib/tax/books-mirror.ts
// there) reads. That parser is the contract; this file is its only producer.
//
// What it hands over, and what it never does:
//   - Only `invoice` and `credit_note` documents in a live status (`issued`,
//     `sent`, `paid`, `cancelled`). Offers and drafts are no issued invoices.
//   - Only the figures an income mirror needs: number, days, currency, the tax
//     treatment flags, the amounts in cents and the tax groups, and the links
//     between a credit note, its invoice and a replacement. Never a recipient's
//     name or address, never a snapshot, a text or a file: the receipts app
//     keeps no second copy of the customer.
//   - Amounts stay non-negative: a credit note states its own amount positive
//     (the document type carries the sign, src/server/books/cancel.ts).
//
// All of them in ONE statement, ordered by the moment of issue (`issued_at`),
// then id: one statement is one snapshot, so a pull is complete as of its start
// and a document committed meanwhile arrives with the next pull. There are no
// pages: pages read separate snapshots, and a document whose `issued_at` sorts
// before an earlier page's end can commit after that page was read and would be
// skipped. The answer is capped (MIRROR_MAX_DOCUMENTS) and refuses above it.

import { z } from 'zod';

import { invalid } from '../errors';
import type { TaxSummary } from '../snapshots';
import type { BooksScope } from '../scope';

/** The live statuses of an issued document. */
export const MIRROR_STATUSES = ['issued', 'sent', 'paid', 'cancelled'] as const;
/** The document types the mirror reads: offers are no issued invoices. */
export const MIRROR_DOC_TYPES = ['invoice', 'credit_note'] as const;

/** One issued document as the receipts app reads it (its `BooksDocument`). */
export interface MirrorDocument {
  id: string;
  docType: (typeof MIRROR_DOC_TYPES)[number];
  status: (typeof MIRROR_STATUSES)[number];
  /** The printed number (`document_number`). */
  number: string;
  /** ISO day. */
  issueDate: string;
  /** ISO day, or null when the document states none. */
  dueDate: string | null;
  currencyCode: string;
  kleinunternehmer: boolean;
  reverseCharge: boolean;
  /** Cents, never negative. */
  totalCents: number;
  taxCents: number;
  /** One group per rate and treatment; rates in basis points. */
  taxSummary: Array<{ rateBp: number; netCents: number; taxCents: number }>;
  correctsDocumentId: string | null;
  replacesDocumentId: string | null;
}

/** One answer of the mirror read: every document, and `nextCursor` always null (no pages). */
export interface MirrorPage {
  documents: MirrorDocument[];
  nextCursor: string | null;
}

/** The raw row the query selects (DATE columns as text, see columns.ts). */
export interface MirrorRow {
  id: string;
  doc_type: string;
  status: string;
  document_number: string | null;
  issue_date: string | null;
  due_date: string | null;
  currency_code: string;
  kleinunternehmer: boolean;
  reverse_charge: boolean;
  total: number;
  tax_amount: number;
  tax_summary: TaxSummary;
  corrects_document_id: string | null;
  replaces_document_id: string | null;
}

/**
 * The row in the mirror's shape. Pure. Throws on a row an issued document can
 * never be (no number or no issue day, a negative amount): such a row is a bug
 * in the Books, and handing it over silently would hide it.
 */
export function toMirrorDocument(row: MirrorRow): MirrorDocument {
  if (!row.document_number || !row.issue_date) {
    throw new Error(`books mirror: issued document ${row.id} has no number or issue day`);
  }
  if (row.total < 0 || row.tax_amount < 0) {
    throw new Error(`books mirror: issued document ${row.id} has a negative amount`);
  }
  return {
    id: row.id,
    docType: row.doc_type as MirrorDocument['docType'],
    status: row.status as MirrorDocument['status'],
    number: row.document_number,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    currencyCode: row.currency_code,
    kleinunternehmer: row.kleinunternehmer,
    reverseCharge: row.reverse_charge,
    totalCents: row.total,
    taxCents: row.tax_amount,
    taxSummary: (row.tax_summary ?? []).map((g) => ({ rateBp: g.taxRate, netCents: g.net, taxCents: g.tax })),
    correctsDocumentId: row.corrects_document_id,
    replacesDocumentId: row.replaces_document_id,
  };
}

/**
 * The most documents one answer holds. A document is about 400 bytes of JSON,
 * so 10,000 is a few megabytes: far above any company today (the largest has
 * about 60). Above it the read refuses (`TooManyMirrorDocumentsError`) instead
 * of handing over a cut list as if it were complete.
 */
export const MIRROR_MAX_DOCUMENTS = 10_000;

/** The company holds more issued documents than one answer may carry. */
export class TooManyMirrorDocumentsError extends Error {
  /** The cap that was exceeded. */
  readonly max: number;
  /** @param max the cap that was exceeded */
  constructor(max: number) {
    super(`books mirror: more than ${max} issued documents`);
    this.name = 'TooManyMirrorDocumentsError';
    this.max = max;
  }
}

const listInput = z.object({
  /** Tests only: a smaller cap, to prove the refusal without thousands of rows. */
  max: z.number().int().min(1).max(MIRROR_MAX_DOCUMENTS).default(MIRROR_MAX_DOCUMENTS),
});
/** What `listMirrorDocuments` takes: nothing in production, a smaller cap in tests. */
export type ListMirrorInput = z.input<typeof listInput>;

/**
 * Every issued invoice and credit note of the company, in the order they were
 * issued (`issued_at`, then id), in ONE statement. One statement reads one
 * snapshot, so the answer is complete as of the moment it started: a document
 * whose issue commits while the read runs is in the next pull, never skipped
 * by a page boundary (pages read different snapshots, and a document whose
 * `issued_at` sorts before an earlier page's end could commit after it).
 */
export async function listMirrorDocuments(scope: BooksScope, input: ListMirrorInput = {}): Promise<MirrorPage> {
  const parsed = listInput.safeParse(input);
  if (!parsed.success) throw invalid('INVALID_INPUT', parsed.error.issues);
  const { max } = parsed.data;

  const rows = (await scope.db
    .selectFrom('sales_document')
    .select((eb) => [
      'sales_document.id',
      'sales_document.doc_type',
      'sales_document.status',
      'sales_document.document_number',
      eb.cast<string | null>('sales_document.issue_date', 'text').as('issue_date'),
      eb.cast<string | null>('sales_document.due_date', 'text').as('due_date'),
      'sales_document.currency_code',
      'sales_document.kleinunternehmer',
      'sales_document.reverse_charge',
      'sales_document.total',
      'sales_document.tax_amount',
      'sales_document.tax_summary',
      'sales_document.corrects_document_id',
      'sales_document.replaces_document_id',
    ])
    .where('sales_document.tenant_id', '=', scope.tenantId)
    .where('sales_document.doc_type', 'in', [...MIRROR_DOC_TYPES])
    .where('sales_document.status', 'in', [...MIRROR_STATUSES])
    .orderBy('sales_document.issued_at', 'asc')
    .orderBy('sales_document.id', 'asc')
    .limit(max + 1)
    .execute()) as unknown as MirrorRow[];

  if (rows.length > max) throw new TooManyMirrorDocumentsError(max);
  // The envelope keeps `nextCursor` (always null: everything is in this answer), the shape the receipts client reads.
  return { documents: rows.map(toMirrorDocument), nextCursor: null };
}
