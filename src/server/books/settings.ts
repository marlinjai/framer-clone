// src/server/books/settings.ts
//
// Company initialisation and the company setting (Books plan P1.8). A company
// is ready for the Books once it has a settings row (tax status, exemption note,
// sender block, default payment terms) and one number counter per document type
// it issues. `initBooksCompany` writes both in one transaction and is safe to
// run again:
//
//   - the settings row is inserted (tax status required the first time), or on
//     a re-run only the given fields change: an omitted tax status, exemption
//     note or payment terms keeps the stored value, the sender block is replaced
//     (it is configuration, not a record: issued documents carry their own
//     frozen sender snapshot, so changing it never alters an issued document);
//   - a missing counter row is inserted; an existing counter is never lowered
//     and never reformatted. A different `format`, or a `nextValue` above the
//     counter's current value (which would skip numbers), is COUNTER_EXISTS. A
//     `nextValue` at or below the current value is the normal state of a re-run
//     after documents were issued, and leaves the counter as it is.
//
// No `server-only` and no import of the request-edge modules: the operator
// script (scripts/books-init-company.ts) runs this under tsx.

import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';

import type { CommerceDB, CompanyTaxStatus, SalesDocType } from '../commerce/db-types';
import { BooksError, invalid, withDbErrors } from './errors';
import { NUMBER_FORMAT, formatDocumentNumber } from './numbering';
import type { BooksScope } from './scope';
import { senderBlockV1Schema, toJsonb, type SenderBlockV1 } from './snapshots';

type Db = Kysely<CommerceDB> | Transaction<CommerceDB>;

/** The default note printed while a company is under Section 19 (editable per company). */
export const DEFAULT_EXEMPTION_NOTE =
  'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).';

export interface CompanySettings {
  tenantId: string;
  taxStatus: CompanyTaxStatus;
  exemptionNote: string;
  senderBlock: SenderBlockV1;
  defaultPaymentTermsDays: number;
}

/** The company's settings row, or null when the company was never initialised. */
export async function readSettings(db: Db, scope: BooksScope): Promise<CompanySettings | null> {
  const row = await db
    .selectFrom('books_company_settings')
    .select(['tenant_id', 'tax_status', 'exemption_note', 'sender_block', 'default_payment_terms_days'])
    .where('tenant_id', '=', scope.tenantId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    tenantId: row.tenant_id,
    taxStatus: row.tax_status,
    exemptionNote: row.exemption_note,
    senderBlock: senderBlockV1Schema.parse(row.sender_block),
    defaultPaymentTermsDays: row.default_payment_terms_days,
  };
}

/** {@link readSettings}, or SETTINGS_MISSING. */
export async function requireSettings(db: Db, scope: BooksScope): Promise<CompanySettings> {
  const settings = await readSettings(db, scope);
  if (!settings) throw new BooksError('SETTINGS_MISSING', 'SETTINGS_MISSING: run books:init-company for this company');
  return settings;
}

// The sender's country is an ISO 3166-1 alpha-2 code (normalized to upper case).
const initSenderBlock = senderBlockV1Schema.extend({
  countryCode: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine((v) => /^[A-Z]{2}$/.test(v), 'expected an ISO 3166-1 alpha-2 country code such as DE')
    .nullable(),
});

const initInput = z.object({
  // Required the first time; on a re-run, omitted means "keep what is stored".
  taxStatus: z.enum(['small_business', 'regular']).optional(),
  exemptionNote: z.string().trim().min(1).max(500).optional(),
  senderBlock: initSenderBlock,
  defaultPaymentTermsDays: z.number().int().min(0).max(365).optional(),
  counters: z
    .array(
      z.object({
        docType: z.enum(['offer', 'invoice', 'credit_note']),
        format: z.string().regex(NUMBER_FORMAT),
        nextValue: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .refine((cs) => new Set(cs.map((c) => c.docType)).size === cs.length, 'one counter per document type'),
});
export type InitBooksCompanyInput = z.input<typeof initInput>;

export interface InitBooksCompanyResult {
  settings: CompanySettings;
  counters: Array<{ docType: SalesDocType; format: string; nextValue: number; created: boolean }>;
}

/** Initialise (or re-run the initialisation of) one company. One transaction. */
export async function initBooksCompany(
  scope: BooksScope,
  input: InitBooksCompanyInput,
): Promise<InitBooksCompanyResult> {
  const parsed = initInput.safeParse(input);
  if (!parsed.success) throw invalid('INVALID_INPUT', parsed.error.issues);
  const args = parsed.data;

  return withDbErrors(() =>
    scope.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        const now = new Date();
        const stored = await trx
          .selectFrom('books_company_settings')
          .select('tenant_id')
          .where('tenant_id', '=', scope.tenantId)
          .forUpdate()
          .executeTakeFirst();
        if (!stored) {
          if (!args.taxStatus) {
            throw invalid('INVALID_INPUT', [
              { path: ['taxStatus'], message: 'required when the company is initialised for the first time' },
            ]);
          }
          await trx
            .insertInto('books_company_settings')
            .values({
              tenant_id: scope.tenantId,
              tax_status: args.taxStatus,
              exemption_note: args.exemptionNote ?? DEFAULT_EXEMPTION_NOTE,
              sender_block: toJsonb(args.senderBlock),
              default_payment_terms_days: args.defaultPaymentTermsDays ?? 14,
              updated_at: now,
            })
            .execute();
        } else {
          // A re-run changes only what it was given; the sender block is always
          // given and replaces the stored one.
          await trx
            .updateTable('books_company_settings')
            .set({
              ...(args.taxStatus !== undefined ? { tax_status: args.taxStatus } : {}),
              ...(args.exemptionNote !== undefined ? { exemption_note: args.exemptionNote } : {}),
              ...(args.defaultPaymentTermsDays !== undefined
                ? { default_payment_terms_days: args.defaultPaymentTermsDays }
                : {}),
              sender_block: toJsonb(args.senderBlock),
              updated_at: now,
            })
            .where('tenant_id', '=', scope.tenantId)
            .execute();
        }

        const counters: InitBooksCompanyResult['counters'] = [];
        for (const c of args.counters) {
          const existing = await trx
            .selectFrom('document_number_counter')
            .select(['next_value', 'format'])
            .where('tenant_id', '=', scope.tenantId)
            .where('doc_type', '=', c.docType)
            .forUpdate()
            .executeTakeFirst();
          if (!existing) {
            await trx
              .insertInto('document_number_counter')
              .values({
                tenant_id: scope.tenantId,
                doc_type: c.docType,
                next_value: c.nextValue,
                format: c.format,
                updated_at: now,
              })
              .execute();
            counters.push({ ...c, created: true });
            continue;
          }
          const current = Number(existing.next_value);
          if (existing.format !== c.format || c.nextValue > current) {
            throw new BooksError(
              'COUNTER_EXISTS',
              `COUNTER_EXISTS: the ${c.docType} counter exists with another format or a lower value`,
              { docType: c.docType, format: existing.format, nextValue: current },
            );
          }
          counters.push({ docType: c.docType, format: existing.format, nextValue: current, created: false });
        }

        const settings = await requireSettings(trx, scope);
        return { settings, counters };
      }),
  );
}

/** One number series of the company, as the editor shows it. */
export interface CounterView {
  docType: SalesDocType;
  format: string;
  nextValue: number;
  /** The number the next issue of this type receives, formatted. */
  nextNumber: string;
}

/** The company's number series (read only; the init script sets them up). */
export async function readCounters(db: Db, scope: BooksScope): Promise<CounterView[]> {
  const rows = await db
    .selectFrom('document_number_counter')
    .select(['doc_type', 'format', 'next_value'])
    .where('tenant_id', '=', scope.tenantId)
    .orderBy('doc_type')
    .execute();
  return rows.map((r) => {
    const nextValue = Number(r.next_value);
    return { docType: r.doc_type, format: r.format, nextValue, nextNumber: formatDocumentNumber(r.format, nextValue) };
  });
}
