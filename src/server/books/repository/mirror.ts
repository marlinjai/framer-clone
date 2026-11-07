// src/server/books/repository/mirror.ts
//
// The read the receipts app mirrors its income from (Books plan, section
// "Phase 4" and roadmap line "4. Existing invoices and the suite"): the
// company's ISSUED invoices and credit notes, a page at a time, in exactly the
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
// Ordered by issue day, then id, with a keyset cursor, so a full pull walks
// every document once even while new ones are issued.

import { sql } from 'kysely';
import { z } from 'zod';

import { invalid, BooksError } from '../errors';
import { isIsoDate } from '../numbering';
import type { TaxSummary } from '../snapshots';
import type { BooksScope } from '../scope';

/** The live statuses of an issued document. */
export const MIRROR_STATUSES = ['issued', 'sent', 'paid', 'cancelled'] as const;
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

const cursorSchema = z.object({ issueDate: z.string().refine(isIsoDate), id: z.string().min(1).max(100) });
type Cursor = z.infer<typeof cursorSchema>;

export function encodeMirrorCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    throw new BooksError('INVALID_INPUT', 'INVALID_INPUT: cursor', {
      issues: [{ path: 'cursor', message: 'not a cursor this list returned' }],
    });
  }
}

export const MIRROR_PAGE_MAX = 200;
const listInput = z.object({
  limit: z.number().int().min(1).max(MIRROR_PAGE_MAX).default(100),
  cursor: z.string().min(1).max(500).optional(),
});
export type ListMirrorInput = z.input<typeof listInput>;

/** One page of the company's issued invoices and credit notes, oldest first. */
export async function listMirrorDocuments(scope: BooksScope, input: ListMirrorInput = {}): Promise<MirrorPage> {
  const parsed = listInput.safeParse(input);
  if (!parsed.success) throw invalid('INVALID_INPUT', parsed.error.issues);
  const { limit } = parsed.data;
  const cursor = parsed.data.cursor ? decodeCursor(parsed.data.cursor) : null;

  let q = scope.db
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
    .where('sales_document.status', 'in', [...MIRROR_STATUSES]);
  if (cursor) {
    // Sent as TEXT and cast in SQL, as listDocuments does (no local-time shift through a Date).
    const day = sql<string>`${cursor.issueDate}::text::date`;
    q = q.where((eb) =>
      eb.or([
        eb('sales_document.issue_date', '>', day),
        eb.and([eb('sales_document.issue_date', '=', day), eb('sales_document.id', '>', cursor.id)]),
      ]),
    );
  }
  const rows = (await q
    .orderBy('sales_document.issue_date', 'asc')
    .orderBy('sales_document.id', 'asc')
    .limit(limit + 1)
    .execute()) as unknown as MirrorRow[];

  const page = rows.slice(0, limit).map(toMirrorDocument);
  const last = page[page.length - 1];
  return {
    documents: page,
    nextCursor: rows.length > limit && last ? encodeMirrorCursor({ issueDate: last.issueDate, id: last.id }) : null,
  };
}
