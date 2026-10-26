// src/server/catalog/http/errorResponse.ts
//
// The one mapping from a CatalogError to an HTTP answer. The envelope is the
// API's usual `{ error: { code, message, ...details } }` (src/lib/api/respond.ts),
// the code the domain code in lower case. Status by kind of refusal:
//
//   404  the thing does not exist FOR THIS COMPANY (another company's id reads
//        exactly like an unknown one, never 403), or a site that is not the
//        company's
//   409  a duplicate (handle, SKU, barcode, option, collection handle), stock
//        that open orders have reserved, or the image limit
//   413  an image over 2 MB; 415 not a PNG, JPEG or WebP
//   422  the input cannot be stored as sent (a field's problem, a shape the
//        product cannot take, stock on a variant that cannot hold it)

import { jsonError } from '@/lib/api/respond';

import { isCatalogError, type CatalogErrorCode } from '../errors';

const STATUS: Record<CatalogErrorCode, number> = {
  INVALID_INPUT: 422,
  NOT_FOUND: 404,
  DUPLICATE_HANDLE: 409,
  DUPLICATE_SKU: 409,
  DUPLICATE_BARCODE: 409,
  DUPLICATE_OPTION: 409,
  DUPLICATE_COLLECTION: 409,
  SHAPE: 422,
  KIND_LOCKED: 422,
  STOCK_NOT_TRACKED: 422,
  SKU_REQUIRED: 422,
  STOCK_BELOW_RESERVED: 409,
  IMAGE_TOO_LARGE: 413,
  UNSUPPORTED_IMAGE_TYPE: 415,
  IMAGE_INVALID: 422,
  IMAGE_LIMIT: 409,
  UNKNOWN_SITE: 404,
};

const MESSAGES: Partial<Record<CatalogErrorCode, string>> = {
  NOT_FOUND: 'not found for this company; it may have been removed (reload the list)',
  INVALID_INPUT: 'some fields cannot be saved as entered; nothing was saved',
  DUPLICATE_HANDLE: 'another product of this company uses this URL handle; choose another one (nothing was saved)',
  DUPLICATE_SKU: 'another variant uses this SKU; SKUs are unique across the organisation (nothing was saved)',
  DUPLICATE_BARCODE: 'another variant uses this barcode (nothing was saved)',
  DUPLICATE_OPTION: 'two options, or two values of one option, have the same name (nothing was saved)',
  DUPLICATE_COLLECTION: 'another live collection of this company uses this URL handle (nothing was saved)',
};

/** The HTTP answer for a CatalogError, or null for anything else (the caller logs and answers 500). */
export function catalogErrorResponse(err: unknown): Response | null {
  if (!isCatalogError(err)) return null;
  const extra: Record<string, unknown> = { ...(err.details ?? {}) };
  // A single field's own sentence is the most useful message.
  const issues = extra.issues as Array<{ path: string; message: string }> | undefined;
  const message = issues && issues.length === 1 ? issues[0].message : (MESSAGES[err.code] ?? err.message);
  return jsonError(err.code.toLowerCase(), message, STATUS[err.code] ?? 500, extra);
}
