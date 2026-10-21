// src/server/books/repository/read.ts
//
// The read side of the Books (Books plan P1.6) and the ONE column list per table
// every Books query selects through. DATE columns are selected cast to text,
// because the base handle carries no custom parser and postgres.js would parse
// a DATE into a JavaScript Date at UTC midnight (a time-zone shift waiting to
// happen); BIGINT columns arrive as strings and are converted here. Never
// `selectAll()` on a Books table.
//
// Every query filters `tenant_id = scope.tenantId`: a row of another company in
// the same schema reads as NOT_FOUND.

import { sql, type ExpressionBuilder, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';

import type {
  CommerceDB,
  CustomerType,
  NetOrGross,
  SalesDocEventType,
  SalesDocLineKind,
  SalesDocSource,
  SalesDocStatus,
  SalesDocType,
  TaxTreatment,
  VariantRefSource,
} from '../../commerce/db-types';
import { BooksError, invalid } from '../errors';
import { isIsoDate } from '../numbering';
import { documentColumns, documentColumnsWithSnapshots, EVENT_COLUMNS, LINE_COLUMNS } from './columns';
import { readSettings } from '../settings';
import { documentTaxFields, profileFor, recomputeLines, selectCustomerRow } from './taxState';
import type { BooksScope } from '../scope';
import {
  customerSnapshotV1Schema,
  templateSnapshotV1Schema,
  senderSnapshotV1Schema,
  taxSummarySchema,
  type CustomerSnapshotV1,
  type EventPayload,
  type SenderSnapshotV1,
  type TemplateSnapshotV1,
  type TaxSummary,
} from '../snapshots';

type Db = Kysely<CommerceDB> | Transaction<CommerceDB>;
type DocEb = ExpressionBuilder<CommerceDB, 'sales_document'>;

// --- domain shapes -----------------------------------------------------------------

export interface SalesDocument {
  id: string;
  tenantId: string;
  docType: SalesDocType;
  status: SalesDocStatus;
  source: SalesDocSource;
  version: number;
  customerId: string | null;
  templateId: string | null;
  correctsDocumentId: string | null;
  sourceOrderId: string | null;
  documentNumber: string | null;
  numberValue: number | null;
  issueDate: string | null;
  serviceDate: string | null;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  dueDate: string | null;
  validUntil: string | null;
  paymentTermsDays: number;
  paymentReference: string | null;
  contractReference: string | null;
  currencyCode: string;
  taxRegion: string;
  customerType: CustomerType | null;
  vatId: string | null;
  reverseCharge: boolean;
  netOrGross: NetOrGross;
  kleinunternehmer: boolean;
  taxNote: string | null;
  taxProfileKey: string | null;
  subtotal: number;
  taxAmount: number;
  total: number;
  taxSummary: TaxSummary;
  introText: string | null;
  outroText: string | null;
  renderedPdfFileId: string | null;
  issuedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A document with its frozen snapshots (null until issued). */
export interface SalesDocumentWithSnapshots extends SalesDocument {
  customerSnapshot: CustomerSnapshotV1 | null;
  /** The template layout frozen at issue (null on a draft, and on documents issued before 008). */
  templateSnapshot: TemplateSnapshotV1 | null;
  senderSnapshot: SenderSnapshotV1 | null;
}

export interface SalesDocumentLine {
  id: string;
  documentId: string;
  position: number;
  kind: SalesDocLineKind;
  title: string;
  description: string | null;
  quantity: number;
  unitLabel: string;
  unitPrice: number;
  discountBp: number;
  subtotal: number;
  taxClass: 'standard' | 'reduced' | 'zero' | null;
  taxRateOverride: number | null;
  taxRate: number;
  taxAmount: number;
  taxTreatment: TaxTreatment | null;
  variantRef: string | null;
  variantRefSource: VariantRefSource;
  createdAt: Date;
  updatedAt: Date;
}

export interface SalesDocumentEvent {
  id: string;
  documentId: string;
  eventType: SalesDocEventType;
  fromStatus: SalesDocStatus | null;
  toStatus: SalesDocStatus | null;
  actorUserId: string | null;
  payload: EventPayload;
  createdAt: Date;
}

/** A document with its lines (by position) and events (by time). */
export interface DocumentView {
  document: SalesDocumentWithSnapshots;
  lines: SalesDocumentLine[];
  events: SalesDocumentEvent[];
  /**
   * True when the stored figures of a draft were computed under a tax profile
   * key that no longer matches the customer and company setting (or were never
   * computed). The returned figures are then the in-memory recomputation; the
   * next mutation or the issue persists it.
   */
  stale: boolean;
}

// --- row mapping --------------------------------------------------------------------

/** The selected document row (documentColumns), as the mappers read it. */
export type DocumentRow = {
  id: string;
  tenant_id: string;
  doc_type: SalesDocType;
  status: SalesDocStatus;
  source: SalesDocSource;
  version: number;
  customer_id: string | null;
  template_id: string | null;
  corrects_document_id: string | null;
  source_order_id: string | null;
  document_number: string | null;
  number_value: string | null;
  issue_date: string | null;
  service_date: string | null;
  service_period_start: string | null;
  service_period_end: string | null;
  due_date: string | null;
  valid_until: string | null;
  payment_terms_days: number;
  payment_reference: string | null;
  contract_reference: string | null;
  currency_code: string;
  tax_region: string;
  customer_type: CustomerType | null;
  vat_id: string | null;
  reverse_charge: boolean;
  net_or_gross: NetOrGross;
  kleinunternehmer: boolean;
  tax_note: string | null;
  tax_profile_key: string | null;
  subtotal: number;
  tax_amount: number;
  total: number;
  tax_summary: TaxSummary;
  intro_text: string | null;
  outro_text: string | null;
  rendered_pdf_file_id: string | null;
  issued_at: Date | null;
  created_at: Date;
  updated_at: Date;
  created_at_text: string;
};
export type DocumentRowWithSnapshots = DocumentRow & {
  customer_snapshot: CustomerSnapshotV1 | null;
  sender_snapshot: SenderSnapshotV1 | null;
  template_snapshot: TemplateSnapshotV1 | null;
};

export function mapDocument(row: DocumentRow): SalesDocument {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    docType: row.doc_type,
    status: row.status,
    source: row.source,
    version: row.version,
    customerId: row.customer_id,
    templateId: row.template_id,
    correctsDocumentId: row.corrects_document_id,
    sourceOrderId: row.source_order_id,
    documentNumber: row.document_number,
    numberValue: row.number_value === null ? null : Number(row.number_value),
    issueDate: row.issue_date,
    serviceDate: row.service_date,
    servicePeriodStart: row.service_period_start,
    servicePeriodEnd: row.service_period_end,
    dueDate: row.due_date,
    validUntil: row.valid_until,
    paymentTermsDays: row.payment_terms_days,
    paymentReference: row.payment_reference,
    contractReference: row.contract_reference,
    currencyCode: row.currency_code,
    taxRegion: row.tax_region,
    customerType: row.customer_type,
    vatId: row.vat_id,
    reverseCharge: row.reverse_charge,
    netOrGross: row.net_or_gross,
    kleinunternehmer: row.kleinunternehmer,
    taxNote: row.tax_note,
    taxProfileKey: row.tax_profile_key,
    subtotal: row.subtotal,
    taxAmount: row.tax_amount,
    total: row.total,
    taxSummary: taxSummarySchema.parse(row.tax_summary),
    introText: row.intro_text,
    outroText: row.outro_text,
    renderedPdfFileId: row.rendered_pdf_file_id,
    issuedAt: row.issued_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapDocumentWithSnapshots(row: DocumentRowWithSnapshots): SalesDocumentWithSnapshots {
  return {
    ...mapDocument(row),
    customerSnapshot: row.customer_snapshot === null ? null : customerSnapshotV1Schema.parse(row.customer_snapshot),
    senderSnapshot: row.sender_snapshot === null ? null : senderSnapshotV1Schema.parse(row.sender_snapshot),
    templateSnapshot:
      row.template_snapshot == null ? null : templateSnapshotV1Schema.parse(row.template_snapshot),
  };
}

export type LineRow = {
  id: string;
  tenant_id: string;
  document_id: string;
  position: number;
  kind: SalesDocLineKind;
  title: string;
  description: string | null;
  quantity: number;
  unit_label: string;
  unit_price: number;
  discount_bp: number;
  subtotal: number;
  tax_class: string | null;
  tax_rate_override: number | null;
  tax_rate: number;
  tax_amount: number;
  tax_treatment: TaxTreatment | null;
  variant_ref: string | null;
  variant_ref_source: VariantRefSource;
  created_at: Date;
  updated_at: Date;
};

const TAX_CLASSES = new Set(['standard', 'reduced', 'zero']);

export function mapLine(row: LineRow): SalesDocumentLine {
  return {
    id: row.id,
    documentId: row.document_id,
    position: row.position,
    kind: row.kind,
    title: row.title,
    description: row.description,
    quantity: row.quantity,
    unitLabel: row.unit_label,
    unitPrice: row.unit_price,
    discountBp: row.discount_bp,
    subtotal: row.subtotal,
    taxClass: row.tax_class !== null && TAX_CLASSES.has(row.tax_class)
      ? (row.tax_class as 'standard' | 'reduced' | 'zero')
      : null,
    taxRateOverride: row.tax_rate_override,
    taxRate: row.tax_rate,
    taxAmount: row.tax_amount,
    taxTreatment: row.tax_treatment,
    variantRef: row.variant_ref,
    variantRefSource: row.variant_ref_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type EventRow = {
  id: string;
  tenant_id: string;
  document_id: string;
  event_type: SalesDocEventType;
  from_status: SalesDocStatus | null;
  to_status: SalesDocStatus | null;
  actor_user_id: string | null;
  payload: EventPayload;
  created_at: Date;
};

export function mapEvent(row: EventRow): SalesDocumentEvent {
  return {
    id: row.id,
    documentId: row.document_id,
    eventType: row.event_type,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    actorUserId: row.actor_user_id,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

// --- low-level readers (used by the write side inside its transaction) --------------

/** One document row of the company, optionally locked FOR UPDATE. */
export async function selectDocumentRow(
  db: Db,
  scope: BooksScope,
  id: string,
  opts: { forUpdate?: boolean } = {},
): Promise<DocumentRowWithSnapshots | undefined> {
  let q = db
    .selectFrom('sales_document')
    .select((eb) => documentColumnsWithSnapshots(eb))
    .where('sales_document.tenant_id', '=', scope.tenantId)
    .where('sales_document.id', '=', id);
  if (opts.forUpdate) q = q.forUpdate();
  return (await q.executeTakeFirst()) as DocumentRowWithSnapshots | undefined;
}

/** The lines of one document of the company, by position. */
export async function selectLineRows(db: Db, scope: BooksScope, documentId: string): Promise<LineRow[]> {
  return db
    .selectFrom('sales_document_line')
    .select(LINE_COLUMNS)
    .where('tenant_id', '=', scope.tenantId)
    .where('document_id', '=', documentId)
    .orderBy('position')
    .execute();
}

/** The events of one document of the company, by time. */
export async function selectEventRows(db: Db, scope: BooksScope, documentId: string): Promise<EventRow[]> {
  return db
    .selectFrom('sales_document_event')
    .select(EVENT_COLUMNS)
    .where('tenant_id', '=', scope.tenantId)
    .where('document_id', '=', documentId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

/**
 * Run a multi-statement read in ONE snapshot: inside a caller's transaction as
 * is, otherwise in a REPEATABLE READ transaction, so a document, its lines and
 * its events are never read from different moments.
 */
export function inReadSnapshot<T>(db: Db, fn: (db: Db) => Promise<T>): Promise<T> {
  if (db.isTransaction) return fn(db);
  return db.transaction().setIsolationLevel('repeatable read').execute((trx) => fn(trx));
}

/** Read the full view as persisted (no stale check), from one snapshot. */
export function readPersistedView(db: Db, scope: BooksScope, id: string): Promise<DocumentView> {
  return inReadSnapshot(db, (snap) => readPersistedViewIn(snap, scope, id));
}

async function readPersistedViewIn(db: Db, scope: BooksScope, id: string): Promise<DocumentView> {
  const row = await selectDocumentRow(db, scope, id);
  if (!row) throw new BooksError('NOT_FOUND', 'NOT_FOUND: document', { documentId: id });
  const lines = await selectLineRows(db, scope, id);
  const events = await selectEventRows(db, scope, id);
  return {
    document: mapDocumentWithSnapshots(row),
    lines: lines.map(mapLine),
    events: events.map(mapEvent),
    stale: false,
  };
}

// --- getDocument -----------------------------------------------------------------------

/**
 * One document of the company with its lines (by position), events (by time)
 * and snapshots. The resume rule: when a draft's stored `tax_profile_key` does
 * not equal the key computed from the current customer and company setting (or
 * is NULL, as an older writer would leave it), the returned figures are the
 * in-memory recomputation with `stale: true`; the persisted figures are never
 * returned as current. The next mutation or the issue persists them.
 */
export function getDocument(scope: BooksScope, id: string): Promise<DocumentView> {
  return inReadSnapshot(scope.db, (db) => getDocumentIn(db, scope, id));
}

async function getDocumentIn(db: Db, scope: BooksScope, id: string): Promise<DocumentView> {
  const row = await selectDocumentRow(db, scope, id);
  if (!row) throw new BooksError('NOT_FOUND', 'NOT_FOUND: document', { documentId: id });
  const lineRows = await selectLineRows(db, scope, id);
  const eventRows = await selectEventRows(db, scope, id);
  const view: DocumentView = {
    document: mapDocumentWithSnapshots(row),
    lines: lineRows.map(mapLine),
    events: eventRows.map(mapEvent),
    stale: false,
  };
  if (row.status !== 'draft') return view;

  const settings = await readSettings(db, scope);
  if (!settings) return { ...view, stale: row.tax_profile_key === null };
  const customer = row.customer_id ? ((await selectCustomerRow(db, scope, row.customer_id)) ?? null) : null;
  const profile = profileFor(settings, customer);
  if (profile.key === row.tax_profile_key) return view;

  const recomputed = recomputeLines(lineRows, profile, row.net_or_gross);
  const fields = documentTaxFields(
    profile,
    customer,
    recomputed.map((l) => ({ kind: l.row.kind, derived: l.derived })),
  );
  return {
    document: {
      ...view.document,
      customerType: fields.customer_type,
      vatId: fields.vat_id,
      reverseCharge: fields.reverse_charge,
      kleinunternehmer: fields.kleinunternehmer,
      taxNote: fields.tax_note,
      taxProfileKey: fields.tax_profile_key,
      subtotal: fields.subtotal,
      taxAmount: fields.tax_amount,
      total: fields.total,
      taxSummary: fields.tax_summary,
    },
    lines: recomputed.map((l) => ({
      ...mapLine(l.row),
      subtotal: l.derived.subtotal,
      taxRate: l.derived.taxRate,
      taxAmount: l.derived.taxAmount,
      taxTreatment: l.derived.taxTreatment,
    })),
    events: view.events,
    stale: true,
  };
}

// --- listDocuments ---------------------------------------------------------------------

const listInput = z.object({
  docType: z.enum(['offer', 'invoice', 'credit_note']).optional(),
  status: z.enum(['draft', 'issued', 'sent', 'accepted', 'rejected', 'paid', 'cancelled']).optional(),
  issuedFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  issuedTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  customerId: z.string().min(1).optional(),
  /** Documents whose number contains this text (case-insensitive): "17" finds 17, 117 and RE-2017-3. */
  numberContains: z.string().trim().min(1).max(40).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});
export type ListDocumentsInput = z.input<typeof listInput>;

interface Cursor {
  issueDate: string | null;
  createdAt: string;
  id: string;
}

const cursorSchema = z.object({
  issueDate: z.string().refine(isIsoDate).nullable(),
  // The text form of a TIMESTAMP(3) column, as listDocuments wrote it.
  createdAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/)
    .refine((v) => isIsoDate(v.slice(0, 10)) && !Number.isNaN(Date.parse(`${v.replace(' ', 'T').slice(0, 23)}Z`))),
  id: z.string().min(1).max(100),
});

function encodeCursor(c: Cursor): string {
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

/** A list item: the document plus, once issued, the recipient's NAME from its frozen snapshot. */
export interface SalesDocumentListItem extends SalesDocument {
  /**
   * `customer_snapshot->>'name'` for an issued document (the name the document
   * was issued to), null for a draft. Only the name: the address and the rest
   * of the snapshot never leave getDocument (P1.5).
   */
  recipientName: string | null;
}

export interface DocumentPage {
  items: SalesDocumentListItem[];
  nextCursor: string | null;
  /** How many documents the filters match in all (every page), so a list can say "50 of 61". */
  total: number;
}

/** A LIKE pattern matching `text` anywhere, its own %, _ and backslash taken literally. */
function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The company's documents, ordered issue_date DESC NULLS FIRST (drafts first),
 * then created_at DESC, then id DESC, with a keyset cursor. Returns no snapshot,
 * only the frozen recipient name of an issued document.
 */
export async function listDocuments(scope: BooksScope, input: ListDocumentsInput = {}): Promise<DocumentPage> {
  const parsed = listInput.safeParse(input);
  if (!parsed.success) throw invalid('INVALID_INPUT', parsed.error.issues);
  const args = parsed.data;
  const cursor = args.cursor ? decodeCursor(args.cursor) : null;

  // The filters, shared by the page and its total.
  const filters = (eb: DocEb) => {
    const c = [eb('sales_document.tenant_id', '=', scope.tenantId)];
    if (args.docType) c.push(eb('sales_document.doc_type', '=', args.docType));
    if (args.status) c.push(eb('sales_document.status', '=', args.status));
    if (args.customerId) c.push(eb('sales_document.customer_id', '=', args.customerId));
    if (args.issuedFrom) c.push(eb('sales_document.issue_date', '>=', sql<string>`${args.issuedFrom}::date`));
    if (args.issuedTo) c.push(eb('sales_document.issue_date', '<=', sql<string>`${args.issuedTo}::date`));
    if (args.numberContains) c.push(eb('sales_document.document_number', 'ilike', containsPattern(args.numberContains)));
    return eb.and(c);
  };
  let q = scope.db
    .selectFrom('sales_document')
    .select((eb) => [...documentColumns(eb), sql<string | null>`customer_snapshot->>'name'`.as('recipient_name')])
    .where(filters);
  if (cursor) {
    const after = (eb: DocEb) =>
      eb.or([
        eb('sales_document.created_at', '<', sql<Date>`${cursor.createdAt}::timestamp`),
        eb.and([
          eb('sales_document.created_at', '=', sql<Date>`${cursor.createdAt}::timestamp`),
          eb('sales_document.id', '<', cursor.id),
        ]),
      ]);
    q = cursor.issueDate === null
      ? q.where((eb) =>
          eb.or([
            eb('sales_document.issue_date', 'is not', null),
            eb.and([eb('sales_document.issue_date', 'is', null), after(eb)]),
          ]),
        )
      : q.where((eb) =>
          eb.or([
            eb('sales_document.issue_date', '<', sql<string>`${cursor.issueDate}::date`),
            eb.and([eb('sales_document.issue_date', '=', sql<string>`${cursor.issueDate}::date`), after(eb)]),
          ]),
        );
  }
  const rows = (await q
    .orderBy(sql`issue_date DESC NULLS FIRST`)
    .orderBy('sales_document.created_at', 'desc')
    .orderBy('sales_document.id', 'desc')
    .limit(args.limit + 1)
    .execute()) as Array<DocumentRow & { recipient_name: string | null }>;

  const counted = await scope.db
    .selectFrom('sales_document')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where(filters)
    .executeTakeFirstOrThrow();

  const page = rows.slice(0, args.limit);
  const last = page[page.length - 1];
  return {
    total: Number(counted.n),
    items: page.map((r) => ({ ...mapDocument(r), recipientName: r.recipient_name })),
    nextCursor:
      rows.length > args.limit && last
        ? encodeCursor({ issueDate: last.issue_date, createdAt: last.created_at_text, id: last.id })
        : null,
  };
}
