// src/server/books/importInvoices.ts
//
// The historical import of invoices issued before the Books existed (Books plan,
// "Historical import build notes (2026-10-20)"), the domain half: what one
// already validated invoice becomes in the company's books. The operator CLI
// (importCli.ts, `pnpm books:import`) reads and validates the private input
// file, resolves the recipient and calls these functions; nothing here reads a
// file or a command line.
//
// An imported invoice is an issued document with `source = 'import'`:
//
//   - its number is the printed one (never allocated), and every imported
//     number must lie below the company's invoice counter, which is never moved
//     (IMPORT_COUNTER_TOO_LOW otherwise, COUNTER_MISSING without a counter);
//   - its customer and sender snapshots are built from the invoice's OWN printed
//     data, frozen as it was printed (the owner moved several times, so the
//     current company setting is never used for the sender);
//   - its lines and totals are the printed ones, small business (section 19
//     UStG) only, tax 0;
//   - its original PDF is stored in sales_document_file as the document of
//     record and pointed at by rendered_pdf_file_id; it is never rendered;
//   - one transaction per invoice writes the lines, the document, the file, the
//     pointer and an `issued` event, so a failure never leaves half a document
//     (009_books_import makes the lines-first order possible and refuses a
//     commit without the original, BK007);
//   - a number already present is `already_imported` when it is an import whose
//     stored file has the same SHA-256, and IMPORT_CONFLICT otherwise; nothing
//     is ever overwritten.
//
// No `server-only` imports: the CLI runs this under tsx.

import { randomUUID } from 'node:crypto';

import { sql, type Kysely, type Transaction } from 'kysely';
import { tenantSchemaRef } from '@marlinjai/tenant-db';

import type { CommerceDB, CustomerType } from '../commerce/db-types';
import { resolveTaxProfile } from '../tax/germanVat';
import { BooksError, constraintName, sqlState, withDbErrors } from './errors';
import { formatDocumentNumber } from './numbering';
import { insertEvent } from './repository/events';
import type { BooksScope } from './scope';
import {
  customerSnapshotV1Schema,
  senderSnapshotV1Schema,
  toJsonb,
  type CustomerSnapshotV1,
  type SenderSnapshotV1,
  type TaxSummary,
} from './snapshots';

type Db = Kysely<CommerceDB> | Transaction<CommerceDB>;

/** What the stored original is marked with in `sales_document_file.renderer`. */
export const IMPORT_RENDERER = 'import:original-pdf';

/** The largest amount a money column holds (INTEGER cents). */
export const MAX_CENTS = 2 ** 31 - 1;

/** One line as printed, in the units of the line table. */
export interface ImportLine {
  kind: 'service' | 'text';
  title: string;
  description: string | null;
  /** Thousandths (1.5 hours = 1500); 0 on a text line. */
  quantity: number;
  unitLabel: string;
  /** Cents. */
  unitPrice: number;
  /** Basis points, derived from the printed amounts (informational; the printed line total is the subtotal). */
  discountBp: number;
  /** Cents, the printed line total. */
  subtotal: number;
}

/** The recipient as printed on this invoice (frozen into the customer snapshot). */
export interface ImportRecipient {
  kind: 'person' | 'organization';
  name: string;
  addressLines: string[];
  addressLine1: string;
  addressLine2: string | null;
  postalCode: string;
  city: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  customerNumber: number | null;
  customerNumberText: string | null;
  /** Normalized, valid VAT id or null. */
  vatId: string | null;
}

/** The sender as printed on this invoice (frozen into the sender snapshot). */
export interface ImportSender {
  legalName: string;
  addressLines: string[];
  addressLine1: string;
  addressLine2: string | null;
  postalCode: string;
  city: string;
  countryCode: string;
}

/** One validated invoice, ready to be written. */
export interface ImportInvoice {
  numberValue: number;
  issueDate: string;
  serviceDate: string | null;
  servicePeriod: { start: string; end: string } | null;
  paymentTermsDays: number;
  dueDate: string | null;
  recipient: ImportRecipient;
  sender: ImportSender;
  lines: ImportLine[];
  /** Cents; equals the sum of the line subtotals. */
  total: number;
  /** The small-business note as printed. */
  taxNote: string;
  file: { bytes: Uint8Array; sha256: string };
  /** Non-personal facts recorded in the `issued` event (counts and flags only). */
  provenance: {
    otherFilesSkipped: number;
    senderTaxNumberPrinted: boolean;
    senderVatIdPrinted: boolean;
    serviceDateUnparsed: boolean;
    paidOnPresent: boolean;
    confidence: 'high' | 'medium' | 'low';
  };
}

/** The customer the import attaches the invoice to (resolved by the caller from the contacts database). */
export interface ImportCustomerRef {
  customerId: string;
  contactId: string;
  customerType: CustomerType;
  /** The customer row's tax fields, from which the tax profile key is derived. */
  vatId: string | null;
  countryCode: string;
}

// --- the counter -----------------------------------------------------------------

export interface ImportCounter {
  format: string;
  nextValue: number;
}

/**
 * The company's invoice counter, checked against every number of the run: each
 * must be below `next_value` (the counter is set past the historical series by
 * `books:init-company` before the import). Never moves the counter.
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
  | { state: 'imported'; documentId: string; sha256: string | null }
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
    .select(['sales_document.id', 'sales_document.source', 'sales_document_file.sha256'])
    .where('sales_document.tenant_id', '=', scope.tenantId)
    .where('sales_document.doc_type', '=', 'invoice')
    .where('sales_document.number_value', '=', String(numberValue))
    .executeTakeFirst();
  if (!row) return { state: 'absent' };
  if (row.source !== 'import') return { state: 'other', documentId: row.id };
  return { state: 'imported', documentId: row.id, sha256: row.sha256 ?? null };
}

/** The outcome of one invoice; `conflict` and every BooksError are reported by the caller as errors. */
export type ImportResult =
  | { status: 'imported'; documentId: string }
  | { status: 'already_imported'; documentId: string };

function conflict(numberValue: number, documentId: string, why: string): BooksError {
  return new BooksError('IMPORT_CONFLICT', `IMPORT_CONFLICT: invoice ${numberValue} ${why}; nothing was changed`, {
    numberValue,
    documentId,
  });
}

/** Decide what an existing number means for this invoice. */
export function judgeExisting(existing: ExistingNumber, invoice: Pick<ImportInvoice, 'numberValue' | 'file'>): ImportResult | null {
  if (existing.state === 'absent') return null;
  if (existing.state === 'other') {
    throw conflict(invoice.numberValue, existing.documentId, 'already exists as a document of this system');
  }
  if (existing.sha256 !== invoice.file.sha256) {
    throw conflict(invoice.numberValue, existing.documentId, 'was imported with a different file');
  }
  return { status: 'already_imported', documentId: existing.documentId };
}

// --- the snapshots ---------------------------------------------------------------

export function importCustomerSnapshot(invoice: ImportInvoice, customer: ImportCustomerRef): CustomerSnapshotV1 {
  const r = invoice.recipient;
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
    customerType: customer.customerType,
    vatId: r.vatId,
    taxNumber: null,
    addressLines: r.addressLines,
    ...(r.customerNumberText !== null ? { customerNumberText: r.customerNumberText } : {}),
  });
}

/**
 * The sender as printed. The input carries no tax number or VAT id values (only
 * whether they were printed, recorded in the event), so both are null here: the
 * stored original is the document of record for them.
 */
export function importSenderSnapshot(invoice: ImportInvoice): SenderSnapshotV1 {
  const s = invoice.sender;
  return senderSnapshotV1Schema.parse({
    v: 1,
    legalName: s.legalName,
    addressLine1: s.addressLine1,
    addressLine2: s.addressLine2,
    postalCode: s.postalCode,
    city: s.city,
    countryCode: s.countryCode,
    taxNumber: null,
    vatId: null,
    smallBusinessId: null,
    email: null,
    phone: null,
    website: null,
    bankName: null,
    iban: null,
    bic: null,
    registerCourt: null,
    registerNumber: null,
    managingDirector: null,
    addressLines: s.addressLines,
  });
}

/** `issued_at` of an imported invoice: noon UTC of its issue date, the same calendar day in every European time zone. */
export function importIssuedAt(issueDate: string): Date {
  return new Date(`${issueDate}T12:00:00.000Z`);
}

// --- the write ---------------------------------------------------------------------

/**
 * Import one validated invoice in ONE transaction: lines, document, original
 * file, the file pointer and the `issued` event. Re-checks the counter and the
 * number inside the transaction. Returns `already_imported` for the same
 * number with the same file; throws IMPORT_CONFLICT for the same number with
 * anything else, and every other refusal as a BooksError.
 */
export async function importInvoice(
  scope: BooksScope,
  invoice: ImportInvoice,
  customer: ImportCustomerRef,
): Promise<ImportResult> {
  if (invoice.lines.length === 0) throw new BooksError('NO_BILLABLE_LINES', 'NO_BILLABLE_LINES: an imported invoice carries its lines');
  const sum = invoice.lines.reduce((acc, l) => acc + l.subtotal, 0);
  if (sum !== invoice.total || invoice.total > MAX_CENTS) {
    throw new BooksError('TOTALS_MISMATCH', `TOTALS_MISMATCH: invoice ${invoice.numberValue}: the lines do not sum to the total`, {
      numberValue: invoice.numberValue,
    });
  }

  const customerSnapshot = importCustomerSnapshot(invoice, customer);
  const senderSnapshot = importSenderSnapshot(invoice);
  const profile = resolveTaxProfile({
    companyTaxStatus: 'small_business',
    exemptionNote: invoice.taxNote,
    customerType: customer.customerType,
    vatId: customer.vatId,
    countryCode: customer.countryCode,
  });
  const taxSummary: TaxSummary = [{ taxRate: 0, taxTreatment: 'kleinunternehmer', net: invoice.total, tax: 0 }];

  try {
    return await withDbErrors(() =>
      scope.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx) => {
          // The counter row FOR SHARE: the number check holds until commit (the
          // counter only ever moves up, and an issue would wait for this lock).
          const counter = await checkImportCounter(trx, scope, [invoice.numberValue], { forShare: true });
          const judged = judgeExisting(await existingInvoice(trx, scope, invoice.numberValue), invoice);
          if (judged) return judged;

          const documentId = randomUUID();
          const now = new Date();
          // Lines first, then the document (009: the line's foreign key is deferred
          // for this transaction only and checked at commit).
          await sql`SET CONSTRAINTS ${tenantSchemaRef(scope.tgId)}.${sql.ref('sales_document_line_document_fkey')} DEFERRED`.execute(trx);
          for (const [index, line] of invoice.lines.entries()) {
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
              document_number: formatDocumentNumber(counter.format, invoice.numberValue),
              number_value: String(invoice.numberValue),
              issue_date: invoice.issueDate,
              service_date: invoice.serviceDate,
              service_period_start: invoice.servicePeriod?.start ?? null,
              service_period_end: invoice.servicePeriod?.end ?? null,
              due_date: invoice.dueDate,
              payment_terms_days: invoice.paymentTermsDays,
              currency_code: 'EUR',
              tax_region: 'DE',
              customer_type: customer.customerType,
              vat_id: customer.vatId,
              reverse_charge: false,
              net_or_gross: 'net',
              kleinunternehmer: true,
              tax_note: invoice.taxNote,
              tax_profile_key: profile.key,
              subtotal: invoice.total,
              tax_amount: 0,
              total: invoice.total,
              tax_summary: toJsonb(taxSummary),
              customer_snapshot: toJsonb(customerSnapshot),
              sender_snapshot: toJsonb(senderSnapshot),
              // No template: the stored original carries its own layout.
              template_snapshot: null,
              issued_at: importIssuedAt(invoice.issueDate),
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
              byte_size: invoice.file.bytes.byteLength,
              sha256: invoice.file.sha256,
              renderer: IMPORT_RENDERER,
              content: Buffer.from(invoice.file.bytes),
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
              numberValue: invoice.numberValue,
              fileSha256: invoice.file.sha256,
              lineCount: invoice.lines.length,
              ...invoice.provenance,
            },
          });
          return { status: 'imported' as const, documentId };
        }),
    );
  } catch (err) {
    // Two runs racing on one number: the loser sees the winner's row.
    if (sqlState(err) === '23505' && String(constraintName(err)).startsWith('sales_document_number')) {
      const judged = judgeExisting(await existingInvoice(scope.db, scope, invoice.numberValue), invoice);
      if (judged) return judged;
    }
    throw err;
  }
}
