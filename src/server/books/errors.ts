// src/server/books/errors.ts
//
// The one error type of the Books domain (Books plan P1.6). Every refusal is a
// BooksError with a stable code the routes of phase 2 map to HTTP answers.
// Details carry names and ids only, never a recipient's name, address or any
// other personal value.
//
// Trigger errors from 007_books, 009_books_import and 011_books_replacement are mapped by SQLSTATE
// (BK001 -> NOT_DRAFT, BK004 -> INVALID_TRANSITION, BK005 -> TOTALS_MISMATCH,
// BK007 -> IMPORT_INCOMPLETE, BK008 -> INVALID_LINE,
// BK009 -> CURRENCY_NOT_SUPPORTED, BK011 -> NOT_CORRECTABLE,
// BK013 -> REPLACEMENT_INCOMPLETE); every other database error propagates
// unchanged. Errors surface, never swallowed.

export type BooksErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'NOT_DRAFT'
  | 'CONCURRENT_EDIT'
  | 'DUPLICATE_CUSTOMER'
  | 'RECIPIENT_UNAVAILABLE'
  | 'RECIPIENT_NOT_FOUND'
  | 'RECIPIENT_ARCHIVED'
  | 'RECIPIENT_INCOMPLETE'
  | 'DOC_TYPE_NOT_SUPPORTED'
  | 'SETTINGS_MISSING'
  | 'CUSTOMER_NOT_FOUND'
  | 'CUSTOMER_ARCHIVED'
  | 'CUSTOMER_REQUIRED'
  | 'INVALID_LINE'
  | 'VARIANT_NOT_FOUND'
  | 'LINE_NOT_FOUND'
  | 'INVALID_POSITIONS'
  | 'NO_BILLABLE_LINES'
  | 'SENDER_INCOMPLETE'
  | 'COUNTER_MISSING'
  | 'COUNTER_EXISTS'
  | 'SERVICE_DATE_REQUIRED'
  | 'TAX_CASE_UNSUPPORTED'
  | 'REVERSE_CHARGE_NOT_ALLOWED'
  | 'ISSUE_DATE_OUT_OF_ORDER'
  | 'NOT_CANCELLABLE'
  | 'INVALID_TRANSITION'
  | 'TOTALS_MISMATCH'
  // Phase 2 and 3 (routes, templates, rendering).
  | 'DUPLICATE_CONTACT'
  | 'DUPLICATE_TEMPLATE'
  | 'TEMPLATE_NOT_FOUND'
  | 'TEMPLATE_IN_USE'
  | 'NOT_RENDERABLE'
  | 'RENDER_INCOMPLETE'
  | 'UNDRAWABLE_TEXT'
  // The historical import (009_books_import, importInvoices.ts).
  | 'IMPORT_CONFLICT'
  | 'IMPORT_INCOMPLETE'
  | 'IMPORT_COUNTER_TOO_LOW'
  | 'RECIPIENT_AMBIGUOUS'
  | 'IMPORT_FAILED'
  | 'CURRENCY_NOT_SUPPORTED'
  // The upload import (src/server/books/upload).
  | 'IMPORT_LIMIT'
  | 'IMPORT_NOT_READY'
  | 'EXTRACT_BUSY'
  | 'EXTRACTION_RUNNING'
  | 'STALE_EXTRACTION'
  | 'COUNTER_RAISE_UNCONFIRMED'
  | 'READING_WOULD_BE_REPLACED'
  // The Correct flow (011_books_replacement, correct.ts).
  | 'NOT_CORRECTABLE'
  | 'REPLACED_INVOICE_CANCELLED'
  | 'REPLACEMENT_INCOMPLETE';

export class BooksError extends Error {
  readonly code: BooksErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: BooksErrorCode,
    message?: string,
    details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message ?? code, options);
    this.name = 'BooksError';
    this.code = code;
    this.details = details;
  }
}

/** True for a BooksError, optionally of one code (also across module copies). */
export function isBooksError(err: unknown, code?: BooksErrorCode): err is BooksError {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; code?: unknown };
  if (!(err instanceof BooksError) && e.name !== 'BooksError') return false;
  return code === undefined || e.code === code;
}

/** The SQLSTATE of a postgres.js error, if any. */
export function sqlState(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** The violated constraint of a postgres.js error, if any. */
export function constraintName(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const name = (err as { constraint_name?: unknown }).constraint_name;
  return typeof name === 'string' ? name : undefined;
}

const TRIGGER_CODES: Record<string, BooksErrorCode> = {
  BK001: 'NOT_DRAFT',
  BK004: 'INVALID_TRANSITION',
  BK005: 'TOTALS_MISMATCH',
  BK007: 'IMPORT_INCOMPLETE',
  BK008: 'INVALID_LINE',
  BK009: 'CURRENCY_NOT_SUPPORTED',
  BK011: 'NOT_CORRECTABLE',
  BK013: 'REPLACEMENT_INCOMPLETE',
};

/**
 * Map a trigger error of 007_books or 009_books_import to its BooksError; return every other error
 * unchanged (the caller rethrows it).
 */
export function mapDbError(err: unknown): unknown {
  if (isBooksError(err)) return err;
  const state = sqlState(err);
  const code = state ? TRIGGER_CODES[state] : undefined;
  if (code) {
    return new BooksError(code, err instanceof Error ? err.message : code, { sqlState: state }, { cause: err });
  }
  return err;
}

/** Run `fn` and rethrow its error through {@link mapDbError}. */
export async function withDbErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw mapDbError(err);
  }
}

/** Turn zod issues into INVALID_INPUT (or another code) with the issue paths only. */
export function invalid(
  code: 'INVALID_INPUT' | 'INVALID_LINE',
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): BooksError {
  const paths = issues.map((i) => (i.path.length > 0 ? i.path.map(String).join('.') : '(root)'));
  return new BooksError(code, `${code}: ${paths.join(', ')}`, {
    issues: issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
  });
}
