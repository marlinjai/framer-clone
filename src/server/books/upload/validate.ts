// src/server/books/upload/validate.ts
//
// Validation of a staged row, as code, never by the model (plan decision 3):
// the printed invoice the row stands for (the user's correction of the current
// extraction, else the extraction) is mapped with the shared mapping
// (importPrinted.ts) and then PREVIEWED with the import core
// (previewHistoricalInvoice, counter policy `raise`), so the review table
// refuses exactly what the import would: the record's own rules (dates, totals,
// tax), the counter, a number already in the books, the same original under
// another number, an ambiguous recipient. On top of that, what only the staging
// table knows: the same number on two staged rows.
//
// The outcome is a list of named problems (codes, field paths and counts,
// never values) and the row's status: `ready` without a blocking problem,
// `needs_attention` otherwise. Warnings (the record's warnings, the counter it
// would raise, the fields the model was unsure about) never block.

import type { ContactBook } from '../contactBook';
import { isBooksError } from '../errors';
import {
  newImportSession,
  numberValueFor,
  previewHistoricalInvoice,
  type HistoricalInvoice,
} from '../importInvoices';
import { mapPrintedInvoice } from '../importPrinted';
import type { BooksScope } from '../scope';
import type { SenderBlockV1 } from '../snapshots';
import { effectivePrinted, type ImportItem, type Problem } from './staging';

const problem = (code: string, opts: { path?: string | null; blocking?: boolean; count?: number | null } = {}): Problem => ({
  code,
  path: opts.path ?? null,
  blocking: opts.blocking ?? true,
  count: opts.count ?? null,
});

/** The value at a dotted path (`lines.2.lineTotal`) of a printed invoice. */
export function valueAt(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * The printed sender with the company's current sender block filling what the
 * PDF does not show (plan decision 6): the name, the address lines, the
 * country, the tax number and the VAT id, each only when the print has none.
 * Returns how many fields were filled (warned: sender_from_company).
 */
export function withCompanySender(
  printed: Record<string, unknown>,
  company: SenderBlockV1 | null,
): { printed: Record<string, unknown>; filled: number } {
  if (!company) return { printed, filled: 0 };
  const blank = (v: unknown) => v == null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
  const raw = (printed.sender ?? {}) as Record<string, unknown>;
  const companyLines = [
    company.addressLine1,
    company.addressLine2,
    [company.postalCode, company.city].filter((x) => x && x.trim() !== '').join(' '),
  ].filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  const fill: Record<string, unknown> = {
    name: company.legalName,
    addressLines: companyLines,
    country: company.countryCode,
    taxNumber: company.taxNumber,
    vatId: company.vatId,
  };
  const sender: Record<string, unknown> = { ...raw };
  // What the PDF itself showed, before the company fills anything in (recorded as printed or not).
  sender.taxNumberPresent ??= !blank(raw.taxNumber);
  sender.vatIdPresent ??= !blank(raw.vatId);
  let filled = 0;
  for (const [field, value] of Object.entries(fill)) {
    if (blank(sender[field]) && !blank(value)) {
      sender[field] = value;
      filled += 1;
    }
  }
  if (!sender.addressLines) sender.addressLines = [];
  // Neither the PDF nor the company settings name a sender: left absent (sender_missing).
  if (sender.name == null) return { printed, filled: 0 };
  return { printed: { ...printed, sender }, filled };
}

/**
 * When the row's number jumps too far ahead (see NUMBER_JUMP_LIMIT): the
 * reference it jumps from (the counter's next value, or the highest number of
 * the other staged rows); null when it does not.
 */
async function numberJump(
  scope: BooksScope,
  item: ImportItem,
  numberValue: number | null,
  raiseTo: number | null,
  others: readonly ImportItem[],
): Promise<number | null> {
  if (numberValue === null) return null;
  const counter = await scope.db
    .selectFrom('document_number_counter')
    .select(['next_value', 'format'])
    .where('tenant_id', '=', scope.tenantId)
    .where('doc_type', '=', 'invoice')
    .executeTakeFirst();
  if (!counter) return null;
  const next = Number(counter.next_value);
  if (raiseTo !== null && raiseTo - next > NUMBER_JUMP_LIMIT) return next;
  const batch = others
    .filter((o) => o.id !== item.id && o.status !== 'discarded')
    .map((o) => stagedNumber(o))
    .map((n) => (n === null ? null : numberValueFor(n, counter.format)))
    .filter((v): v is number => v !== null);
  if (batch.length === 0) return null;
  const highest = Math.max(...batch);
  return numberValue - highest > NUMBER_JUMP_LIMIT ? highest : null;
}

/** A number for comparing staged rows: "0062" and "62" are the same invoice number. */
function numberKey(n: string | null): string | null {
  if (n === null) return null;
  return /^\d+$/.test(n) ? String(Number(n)) : n;
}

/** The printed number of a staged row now (for the duplicate check among staged rows). */
export function stagedNumber(item: ImportItem): string | null {
  const n = valueAt(effectivePrinted(item), 'number');
  return typeof n === 'string' && n.trim() !== '' ? n.trim() : typeof n === 'number' ? String(n) : null;
}

/**
 * How far ahead a number may jump before the user must confirm it: a number
 * that raises the invoice counter more than this above its current next value,
 * or lies more than this above the highest number of the other staged rows, is
 * a blocking `number_jump` (a misread "9999" for "99" would otherwise push the
 * company's next invoice number up for good; the counter is never lowered).
 */
export const NUMBER_JUMP_LIMIT = 50;

export interface Validation {
  status: 'ready' | 'needs_attention';
  problems: Problem[];
  /** The record the row would import, when it maps. */
  record: HistoricalInvoice | null;
}

/**
 * Validate one staged row. `bytes` are its uploaded bytes; `others` the
 * company's other staged rows (for the duplicate number check).
 */
export async function validateItem(
  scope: BooksScope,
  book: ContactBook,
  item: ImportItem,
  ctx: { bytes: Uint8Array; others: readonly ImportItem[]; companySender: SenderBlockV1 | null; now?: Date },
): Promise<Validation> {
  const done = (problems: Problem[], record: HistoricalInvoice | null): Validation => ({
    status: problems.some((p) => p.blocking) ? 'needs_attention' : 'ready',
    problems,
    record,
  });
  const printed = effectivePrinted(item);
  if (!printed) return done([problem(item.extractionError ? `extraction_failed:${item.extractionError}` : 'not_read')], null);

  const sender = withCompanySender(printed, ctx.companySender);
  const mapped = mapPrintedInvoice(sender.printed, { origin: 'upload_extracted', now: ctx.now });
  if (!mapped.ok) {
    const reason = mapped.issue.reason;
    if (reason.startsWith('invalid_record:') || reason.startsWith('invalid_field:')) {
      const paths = reason.slice(reason.indexOf(':') + 1).split(',').filter((p) => p !== '' && p !== 'record' && p !== 'entry');
      return done(paths.length > 0 ? paths.map((p) => problem('invalid_field', { path: p })) : [problem('invalid_field')], null);
    }
    return done([problem(reason)], null);
  }
  const record: HistoricalInvoice = { ...mapped.record, provenance: { ...mapped.record.provenance, senderFieldsFromCompany: sender.filled } };

  const problems: Problem[] = [];
  const number = record.documentNumber;
  const key = numberKey(number);
  if (ctx.others.some((o) => o.id !== item.id && o.status !== 'imported' && o.status !== 'discarded' && numberKey(stagedNumber(o)) === key)) {
    problems.push(problem('number_staged_twice', { path: 'number' }));
  }

  try {
    const preview = await previewHistoricalInvoice(scope, book, record, ctx.bytes, newImportSession(), {
      now: ctx.now,
      counterPolicy: 'raise',
    });
    if (preview.status === 'already_imported') {
      // The same number with these exact bytes is in the books (imported meanwhile by another
      // path): not a problem to fix; confirming marks the row imported and creates nothing.
      problems.push(problem('already_imported', { blocking: false }));
    } else {
      for (const w of preview.warnings) problems.push(problem(w.code, { blocking: false, count: 'count' in w ? w.count : null }));
      if (preview.counterRaisedTo !== null) problems.push(problem('counter_raised', { blocking: false, count: preview.counterRaisedTo }));
      const jump = await numberJump(scope, item, preview.numberValue, preview.counterRaisedTo, ctx.others);
      if (jump !== null && item.numberConfirmed !== number) problems.push(problem('number_jump', { path: 'number', count: jump }));
    }
  } catch (err) {
    if (!isBooksError(err)) throw err;
    if (err.code === 'IMPORT_CONFLICT') {
      const sameOriginal = typeof (err.details as { otherDocumentNumber?: unknown } | undefined)?.otherDocumentNumber === 'string';
      problems.push(problem(sameOriginal ? 'same_original_imported' : 'number_taken', { path: sameOriginal ? null : 'number' }));
    } else if (err.code === 'INVALID_INPUT') {
      const issues = (err.details?.issues as Array<{ path: string }> | undefined) ?? [];
      for (const i of issues) problems.push(problem('invalid_field', { path: i.path || null }));
    } else if (err.code === 'RECIPIENT_UNAVAILABLE') {
      // The contacts database could not be read: nothing can be confirmed until it can.
      problems.push(problem('contacts_unavailable'));
    } else {
      problems.push(problem(err.code.toLowerCase(), { path: err.code === 'RECIPIENT_AMBIGUOUS' ? 'recipient.name' : null }));
    }
  }

  // The fields the model was unsure about, unless the user has changed them since.
  const extracted = item.extracted;
  if (extracted) {
    for (const [path, confidence] of Object.entries(extracted.confidence)) {
      const changed = item.corrected !== null && JSON.stringify(valueAt(item.corrected, path)) !== JSON.stringify(valueAt(extracted.printed, path));
      if (!changed) problems.push(problem(`unsure_${confidence}`, { path, blocking: false }));
    }
  }
  return done(problems, record);
}
