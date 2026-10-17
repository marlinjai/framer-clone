// src/server/books/numbering.ts
//
// Document numbers and issue dates (Books plan P1.3).
//
//   - One counter row per company and document type (document_number_counter),
//     no yearly reset. Allocated at ISSUE, inside the issue transaction, never at
//     draft creation: a rollback anywhere in the transaction restores the
//     counter (no gap), and an abandoned draft never touches it.
//   - Lock order, identical in issue and cancel so two transactions can never
//     deadlock: (1) the document row FOR UPDATE, (2) the counter row FOR UPDATE.
//     The counter row lock serializes concurrent issues of one company;
//     different companies never contend.
//   - A missing counter row is COUNTER_MISSING (the company was not
//     initialised), never an implicit insert: an implicit row would start at 1
//     and collide with the historical series.
//   - Formats are company configuration in the counter row (`{n}` the plain
//     number, `{n:4}` zero-padded to 4 digits, literal text around it), never
//     constants in the code.
//   - The issue date must not be in the future (Europe/Berlin calendar day) and
//     must not be earlier than the issue date of the highest-numbered document of
//     the same company and type, so numbers and dates never run against each
//     other. Checked AFTER the counter lock, where concurrent issues are already
//     serialized.

import type { Transaction } from 'kysely';

import type { CommerceDB, SalesDocType } from '../commerce/db-types';
import { BooksError } from './errors';
import type { BooksScope } from './scope';

/** The format shape the database CHECK enforces (document_number_counter_format_check). */
export const NUMBER_FORMAT = /^[A-Za-z0-9/._ -]{0,16}\{n(:[1-9])?\}[A-Za-z0-9/._ -]{0,16}$/;

/** Render a counter value through its format: `{n}` 62 = `62`, `GS-{n}` 1 = `GS-1`, `{n:4}` 7 = `0007`. */
export function formatDocumentNumber(format: string, value: number): string {
  if (!NUMBER_FORMAT.test(format)) throw new Error(`numbering: invalid number format ${JSON.stringify(format)}`);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`numbering: invalid counter value ${value}`);
  return format.replace(/\{n(?::([1-9]))?\}/, (_m, width?: string) =>
    width ? String(value).padStart(Number(width), '0') : String(value),
  );
}

// --- calendar days -------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar day written `YYYY-MM-DD`. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Today's calendar day in Europe/Berlin, `YYYY-MM-DD`. */
export function berlinToday(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** `date` plus `days` calendar days. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// --- allocation (inside the issue / cancel transaction) -------------------------

export interface AllocatedNumber {
  numberValue: number;
  documentNumber: string;
}

/**
 * Lock the company's counter row for `docType`, check the issue date against the
 * highest-numbered document of the type, allocate the next number and advance
 * the counter. Must run inside the transaction that also writes the issued
 * document, AFTER the document row is locked.
 */
export async function allocateNumber(
  trx: Transaction<CommerceDB>,
  scope: BooksScope,
  docType: SalesDocType,
  issueDate: string,
): Promise<AllocatedNumber> {
  const counter = await trx
    .selectFrom('document_number_counter')
    .select(['next_value', 'format'])
    .where('tenant_id', '=', scope.tenantId)
    .where('doc_type', '=', docType)
    .forUpdate()
    .executeTakeFirst();
  if (!counter) {
    throw new BooksError('COUNTER_MISSING', `COUNTER_MISSING: no ${docType} counter for this company`, { docType });
  }

  const last = await trx
    .selectFrom('sales_document')
    .select((eb) => eb.cast<string>('issue_date', 'text').as('issue_date'))
    .where('tenant_id', '=', scope.tenantId)
    .where('doc_type', '=', docType)
    .where('number_value', 'is not', null)
    .orderBy('number_value', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (last?.issue_date && issueDate < last.issue_date) {
    throw new BooksError(
      'ISSUE_DATE_OUT_OF_ORDER',
      `ISSUE_DATE_OUT_OF_ORDER: ${issueDate} is earlier than the last ${docType} (${last.issue_date})`,
      { issueDate, lastIssueDate: last.issue_date, docType },
    );
  }

  const numberValue = Number(counter.next_value);
  const documentNumber = formatDocumentNumber(counter.format, numberValue);
  await trx
    .updateTable('document_number_counter')
    .set({ next_value: numberValue + 1, updated_at: new Date() })
    .where('tenant_id', '=', scope.tenantId)
    .where('doc_type', '=', docType)
    .execute();
  return { numberValue, documentNumber };
}

/**
 * Validate an issue date (argument or today in Europe/Berlin): a real calendar
 * day, not in the future.
 */
export function resolveIssueDate(requested: string | undefined, now: Date = new Date()): string {
  const today = berlinToday(now);
  const date = requested ?? today;
  if (!isIsoDate(date)) {
    throw new BooksError('INVALID_INPUT', 'INVALID_INPUT: issueDate', {
      issues: [{ path: 'issueDate', message: 'expected YYYY-MM-DD' }],
    });
  }
  if (date > today) {
    throw new BooksError('ISSUE_DATE_OUT_OF_ORDER', `ISSUE_DATE_OUT_OF_ORDER: ${date} is in the future`, {
      issueDate: date,
      today,
    });
  }
  return date;
}
