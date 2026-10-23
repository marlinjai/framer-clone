// src/server/books/http/errorResponse.ts
//
// The one mapping from a BooksError to an HTTP answer (Books plan phase 2). The
// envelope is the API's usual `{ error: { code, message, ...details } }`
// (src/lib/api/respond.ts). The code is the domain code in lower case, so a
// client can tell `customer_required` from `no_billable_lines` and say what to
// do; details carry names and ids only (the BooksError contract), never a
// recipient's name or address.
//
// Status by kind of refusal:
//   400  the request itself is malformed (input, line, positions)
//   404  the thing does not exist FOR THIS COMPANY (another company's id reads
//        exactly like an unknown one, never 403, so existence never leaks)
//   409  the state moved on (stale version, no longer a draft, a duplicate,
//        an invalid transition), or the company is not initialised for the
//        Books yet (`books_not_initialised`: run `pnpm books:init-company`)
//   413  an uploaded logo is larger than 1 MB; 415 it is not a PNG or a JPEG
//   422  the document cannot be issued or rendered as it stands (a missing
//        customer, no billable line, an incomplete sender or recipient, a tax
//        case outside the supported scope, a logo the company does not have):
//        the user fixes the document; or an uploaded logo cannot be decoded,
//        embedded, or has more than 2000 px on its longer side
//   503  the shared contacts database could not be read; nothing was written,
//        retrying is safe

import { jsonError } from '@/lib/api/respond';

import { isBooksError, type BooksErrorCode } from '../errors';

const STATUS: Record<BooksErrorCode, number> = {
  INVALID_INPUT: 400,
  INVALID_LINE: 400,
  INVALID_POSITIONS: 400,
  NOT_FOUND: 404,
  LINE_NOT_FOUND: 404,
  CUSTOMER_NOT_FOUND: 404,
  TEMPLATE_NOT_FOUND: 404,
  VARIANT_NOT_FOUND: 404,
  RECIPIENT_NOT_FOUND: 422,
  CONCURRENT_EDIT: 409,
  NOT_DRAFT: 409,
  DUPLICATE_CUSTOMER: 409,
  DUPLICATE_CONTACT: 409,
  DUPLICATE_TEMPLATE: 409,
  TEMPLATE_IN_USE: 409,
  INVALID_TRANSITION: 409,
  NOT_CANCELLABLE: 409,
  NOT_CORRECTABLE: 409,
  REPLACED_INVOICE_CANCELLED: 409,
  REPLACEMENT_INCOMPLETE: 409,
  COUNTER_EXISTS: 409,
  SETTINGS_MISSING: 409,
  COUNTER_MISSING: 409,
  NOT_RENDERABLE: 409,
  IMPORT_CONFLICT: 409,
  IMPORT_COUNTER_TOO_LOW: 409,
  RECIPIENT_AMBIGUOUS: 409,
  CUSTOMER_ARCHIVED: 422,
  CUSTOMER_REQUIRED: 422,
  NO_BILLABLE_LINES: 422,
  RECIPIENT_ARCHIVED: 422,
  RECIPIENT_INCOMPLETE: 422,
  SENDER_INCOMPLETE: 422,
  SERVICE_DATE_REQUIRED: 422,
  TAX_CASE_UNSUPPORTED: 422,
  REVERSE_CHARGE_NOT_ALLOWED: 422,
  ISSUE_DATE_OUT_OF_ORDER: 422,
  DOC_TYPE_NOT_SUPPORTED: 422,
  TOTALS_MISMATCH: 422,
  RENDER_INCOMPLETE: 422,
  UNDRAWABLE_TEXT: 422,
  TEMPLATE_INVALID: 422,
  IMPORT_INCOMPLETE: 422,
  CURRENCY_NOT_SUPPORTED: 422,
  RECIPIENT_UNAVAILABLE: 503,
  IMPORT_FAILED: 500,
  IMPORT_LIMIT: 429,
  EXTRACT_BUSY: 429,
  EXTRACTION_RUNNING: 409,
  STALE_EXTRACTION: 409,
  COUNTER_RAISE_UNCONFIRMED: 409,
  READING_WOULD_BE_REPLACED: 409,
  IMPORT_NOT_READY: 422,
  ASSET_TOO_LARGE: 413,
  UNSUPPORTED_ASSET_TYPE: 415,
  ASSET_INVALID: 422,
  ASSET_NOT_FOUND: 404,
  LOGO_ASSET_MISSING: 422,
};

/** The two codes that mean "this company was never set up for the Books". */
const NOT_INITIALISED: ReadonlySet<BooksErrorCode> = new Set(['SETTINGS_MISSING', 'COUNTER_MISSING']);

const MESSAGES: Partial<Record<BooksErrorCode, string>> = {
  SETTINGS_MISSING:
    'the Books are not set up for this company yet (an operator runs pnpm books:init-company)',
  COUNTER_MISSING:
    'the number series for this document type is not set up (an operator runs pnpm books:init-company)',
  RECIPIENT_UNAVAILABLE: 'the contacts database could not be read; nothing was changed, retry shortly',
  CONCURRENT_EDIT: 'the document was changed elsewhere; reload it and apply your change again',
  NOT_DRAFT: 'the document is no longer a draft and cannot be changed',
  CUSTOMER_REQUIRED: 'pick a customer before issuing',
  NO_BILLABLE_LINES: 'add at least one line with a quantity before issuing',
  SERVICE_DATE_REQUIRED: 'enter a service date or a service period before issuing',
  UNDRAWABLE_TEXT:
    'some characters cannot be printed in the document font; change the named fields (nothing was issued)',
  NOT_CORRECTABLE:
    'only an issued invoice made in the editor that is not cancelled can be corrected; cancel an imported invoice and create a new one',
  REPLACED_INVOICE_CANCELLED:
    'the invoice this draft replaces was cancelled in the meantime; issue the draft as an ordinary invoice instead',
  REPLACEMENT_INCOMPLETE:
    'the corrected invoice could not be issued together with the cancellation of the invoice it replaces; nothing was issued',
  RENDER_INCOMPLETE: 'the PDF would lack a legally required field; nothing was issued or stored',
  TEMPLATE_INVALID: 'the template cannot be saved; fix the named problems (nothing was saved)',
  LOGO_ASSET_MISSING: "the template's logo is not stored for this company; choose the logo in the template again (nothing was issued)",
};

/** Lower snake case of a domain code, as the API answers it. */
export function apiCode(code: BooksErrorCode): string {
  return NOT_INITIALISED.has(code) ? 'books_not_initialised' : code.toLowerCase();
}

/**
 * The HTTP answer for a BooksError, or null for anything else (the caller
 * answers its own 500 and logs it: errors surface, never swallowed).
 */
export function booksErrorResponse(err: unknown): Response | null {
  if (!isBooksError(err)) return null;
  const status = STATUS[err.code] ?? 500;
  const message = MESSAGES[err.code] ?? err.message;
  const extra: Record<string, unknown> = { reason: err.code.toLowerCase() };
  if (err.details) {
    for (const [k, v] of Object.entries(err.details)) {
      // The raw SQLSTATE of a trigger error is internal; everything else is
      // names and ids by contract.
      if (k !== 'sqlState') extra[k] = v;
    }
  }
  return jsonError(apiCode(err.code), message, status, extra);
}
