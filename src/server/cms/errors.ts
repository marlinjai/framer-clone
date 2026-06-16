import 'server-only';

// src/server/cms/errors.ts
//
// Typed write-error contract for the CMS write tier.
//
// WHY this exists (the spec's open question, answered against the package):
// adapter-prisma has NO specific collision error type. `createTable` is a plain
// `dtTable.create` with no name-uniqueness constraint, and the underlying DDL is
// `CREATE TABLE IF NOT EXISTS`, so a duplicate collection NAME never surfaces as
// a distinct adapter error: it would silently create a second look-alike table.
// "Table not found" / "Row not found" are thrown as OPAQUE `Error` instances
// with no machine-readable code. Per the spec ("if it throws an opaque error,
// add a typed wrapper in src/server/cms and surface that"), the write repository
// detects these conditions itself and throws the typed errors below. The write
// routes match on `instanceof CmsWriteError` and surface `code`/`status` as the
// Track-0 error envelope, so a collision is a real 409 the UI renders inline,
// never a swallowed success.

import { jsonError } from '@/lib/api/respond';

/**
 * Base class for every typed CMS write failure. Carries a machine-readable
 * `code` and the HTTP `status` the route should surface, so the route layer can
 * map any subclass to an envelope with one `instanceof CmsWriteError` check.
 */
export class CmsWriteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
  }
}

/**
 * A collection with the requested name already exists. This is the specific
 * collision contract the spec calls for: the write repository enforces
 * name-uniqueness (which the adapter does NOT) and throws this so the route can
 * return the documented 409 `{ error: { code: 'collection_exists', ... } }`.
 */
export class CollectionExistsError extends CmsWriteError {
  constructor(name: string) {
    super('collection_exists', `a collection named "${name}" already exists`, 409);
  }
}

/**
 * The target collection / column / row does not exist. The adapter throws an
 * opaque `Error('Table not found: ...')` (or none at all for a missing column);
 * the repository checks existence up front and throws this typed 404 instead.
 */
export class CmsNotFoundError extends CmsWriteError {
  constructor(kind: 'collection' | 'column' | 'row', id: string) {
    super('not_found', `${kind} ${id} not found`, 404);
  }
}

/**
 * A DDL / persistence operation failed (for example an ALTER TABLE the adapter
 * could not apply). Wraps the opaque adapter/Prisma throw into a typed 400 so
 * the failure surfaces loudly with a code instead of a bare 500 stack.
 */
export class CmsDdlError extends CmsWriteError {
  constructor(message: string) {
    super('ddl_failed', message, 400);
  }
}

/**
 * Map a thrown value to a ready-to-return error envelope when it is a typed
 * CmsWriteError; otherwise return null so the route falls back to its generic
 * 500 branch. Keeps the six write routes DRY and consistent.
 */
export function cmsWriteErrorResponse(err: unknown): Response | null {
  if (err instanceof CmsWriteError) {
    return jsonError(err.code, err.message, err.status);
  }
  return null;
}
