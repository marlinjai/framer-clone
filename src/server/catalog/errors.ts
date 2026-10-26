// src/server/catalog/errors.ts
//
// The one error type of the catalogue area (docs/plans/2026-10-25-catalogue-design.md,
// slice 2). Every refusal is a CatalogError with a stable code the routes map to
// an HTTP answer (http/errorResponse.ts). Details carry names and ids only.
//
// Database errors the catalogue expects are mapped here: the unique indexes of
// 003 and 020 (a handle per company, a SKU or barcode per tenant group, an
// option title per product, a value per option, a collection handle per
// company) and the shape guard of 020 (BK017: a service has one variant and no
// options, a product at most three options). Every other database error
// propagates unchanged and becomes a logged 500: errors surface, never
// swallowed.

export type CatalogErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'DUPLICATE_HANDLE'
  | 'DUPLICATE_SKU'
  | 'DUPLICATE_BARCODE'
  | 'DUPLICATE_OPTION'
  | 'DUPLICATE_COLLECTION'
  | 'SHAPE'
  | 'KIND_LOCKED'
  | 'STOCK_NOT_TRACKED'
  | 'SKU_REQUIRED'
  | 'STOCK_BELOW_RESERVED'
  | 'IMAGE_TOO_LARGE'
  | 'UNSUPPORTED_IMAGE_TYPE'
  | 'IMAGE_INVALID'
  | 'IMAGE_LIMIT'
  | 'UNKNOWN_SITE';

export class CatalogError extends Error {
  readonly code: CatalogErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: CatalogErrorCode, message?: string, details?: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message ?? code, options);
    this.name = 'CatalogError';
    this.code = code;
    this.details = details;
  }
}

/** True for a CatalogError, optionally of one code (also across module copies). */
export function isCatalogError(err: unknown, code?: CatalogErrorCode): err is CatalogError {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; code?: unknown };
  if (!(err instanceof CatalogError) && e.name !== 'CatalogError') return false;
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

/** The unique indexes a person can run into, and what each means for them. */
const UNIQUE: Record<string, { code: CatalogErrorCode; field: string }> = {
  product_tenant_handle_active_key: { code: 'DUPLICATE_HANDLE', field: 'handle' },
  product_variant_sku_active_key: { code: 'DUPLICATE_SKU', field: 'sku' },
  inventory_item_sku_active_key: { code: 'DUPLICATE_SKU', field: 'sku' },
  product_variant_barcode_active_key: { code: 'DUPLICATE_BARCODE', field: 'barcode' },
  product_option_product_id_title_active_key: { code: 'DUPLICATE_OPTION', field: 'options' },
  product_option_value_option_id_value_active_key: { code: 'DUPLICATE_OPTION', field: 'options' },
  product_variant_option_signature_active_key: { code: 'DUPLICATE_OPTION', field: 'options' },
  collection_tenant_handle_live_key: { code: 'DUPLICATE_COLLECTION', field: 'handle' },
};

/** Map an expected database error to its CatalogError; return every other error unchanged. */
export function mapDbError(err: unknown): unknown {
  if (isCatalogError(err)) return err;
  const state = sqlState(err);
  if (state === '23505') {
    const hit = UNIQUE[constraintName(err) ?? ''];
    if (hit) return new CatalogError(hit.code, hit.code, { field: hit.field }, { cause: err });
  }
  if (state === 'BK017') {
    return new CatalogError('SHAPE', 'SHAPE: a service has one variant and no options; a product at most three options', {}, { cause: err });
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

/** Turn zod issues into INVALID_INPUT with the issue paths and messages only. */
export function invalid(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): CatalogError {
  const paths = issues.map((i) => (i.path.length > 0 ? i.path.map(String).join('.') : '(root)'));
  return new CatalogError('INVALID_INPUT', `INVALID_INPUT: ${paths.join(', ')}`, {
    issues: issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
  });
}

/** One field refused with a sentence. */
export function invalidField(path: string, message: string): CatalogError {
  return new CatalogError('INVALID_INPUT', `INVALID_INPUT: ${path}`, { issues: [{ path, message }] });
}

export function notFound(what: string, id: string | null): CatalogError {
  return new CatalogError('NOT_FOUND', `NOT_FOUND: ${what}`, { what, id });
}
