import 'server-only';

// src/server/sites/errors.ts
//
// Typed errors for the site-persistence tier. Mirrors the CMS write-error
// contract (src/server/cms/errors.ts): a machine-readable `code` plus the HTTP
// `status` a route should surface, so a route maps any subclass to the Track-0
// `{ error: { code, message } }` envelope with one `instanceof` check. Errors
// here are REAL and returned to the caller — a not-found or a cross-workspace
// access attempt is never swallowed into a silent null that reads as success.

import { jsonError } from '@/lib/api/respond';

/** Base class for every typed site-persistence failure. */
export class SiteRepositoryError extends Error {
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
 * The requested site does not exist WITHIN the caller's workspace. This is
 * returned for BOTH a genuinely missing site and a site that exists in another
 * workspace — the two are deliberately indistinguishable so the error never
 * leaks the existence of a cross-workspace resource. 404.
 */
export class SiteNotFoundError extends SiteRepositoryError {
  constructor(siteId: string) {
    super('site_not_found', `no site "${siteId}" in this workspace`, 404);
  }
}

/**
 * The caller passed an empty/blank workspace or tenant-group scope. A scope of
 * "" would match nothing (or, worse, be omitted from a query and match
 * everything), so it is rejected up front rather than silently widening a
 * query. 400.
 */
export class InvalidTenantScopeError extends SiteRepositoryError {
  constructor() {
    super(
      'invalid_tenant_scope',
      'workspaceId and tenantGroupId are required and must be non-empty',
      400,
    );
  }
}

/**
 * Subdomain allocation exhausted its bounded P2002 retries — every generated
 * label collided with an existing one. At length-12 over a 36-char alphabet
 * this is astronomically unlikely, so a real occurrence is a LOUD signal (a
 * broken generator, a poisoned index, or an attack) and must surface as a 500,
 * NEVER a silent success that publishes a site with no URL. 500.
 */
export class SubdomainAllocationError extends SiteRepositoryError {
  constructor(siteId: string, attempts: number) {
    super(
      'subdomain_allocation_failed',
      `could not allocate a unique subdomain for site "${siteId}" after ${attempts} attempts`,
      500,
    );
  }
}

/**
 * Map any {@link SiteRepositoryError} to its Track-0 error envelope. A route
 * matches `instanceof SiteRepositoryError` once and returns this.
 */
export function siteRepositoryErrorResponse(err: SiteRepositoryError): Response {
  return jsonError(err.code, err.message, err.status);
}
