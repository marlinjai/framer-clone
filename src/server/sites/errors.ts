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
 * A page slug in the saved snapshot breaks the slug rules (src/lib/pages/slug.ts):
 * a new or changed slug that is malformed, reserved or already used by another
 * page, or a change to the home page's slug. The editor checks the same rules
 * before it ever sends a slug, so this is the server's own guarantee against a
 * request built by hand. Nothing is written. 400.
 */
export class InvalidPageSlugError extends SiteRepositoryError {
  readonly pageId: string;
  readonly reason: string;

  constructor(pageId: string, reason: string, message: string) {
    super('invalid_page_slug', message, 400);
    this.pageId = pageId;
    this.reason = reason;
  }
}

/**
 * A rename lost a race: the caller named the project it expected to rename
 * (`expectedName`), and the stored name is different, because someone renamed
 * it in the meantime. Nothing was written. Carries the current name so the
 * caller can show it. 409.
 */
export class SiteNameConflictError extends SiteRepositoryError {
  readonly currentName: string;

  constructor(siteId: string, currentName: string) {
    super(
      'name_conflict',
      `site "${siteId}" was renamed in the meantime; reload to see the current name`,
      409,
    );
    this.currentName = currentName;
  }
}

/**
 * A save or publish of a project that no longer exists in the caller's
 * workspace (deleted, typically while an editor tab was still open). Save and
 * publish only ever UPDATE an existing site; creating one is the create
 * route's job. 404, with a message the editor shows as is.
 */
export class SiteGoneError extends SiteRepositoryError {
  constructor() {
    super(
      'site_not_found',
      'This project does not exist (any more): it may have been deleted. Your changes were not saved.',
      404,
    );
  }
}

/**
 * Deleting a PUBLISHED project needs its exact current name as confirmation
 * (`confirmName`). Missing or different (for example a dashboard that still
 * shows the name from before a rename): nothing is deleted. Carries the
 * current name. 409.
 */
export class SiteDeleteConfirmationError extends SiteRepositoryError {
  readonly currentName: string;

  constructor(currentName: string) {
    super(
      'confirmation_mismatch',
      'This project is published. Type its exact current name to confirm deleting it.',
      409,
    );
    this.currentName = currentName;
  }
}

/**
 * Map any {@link SiteRepositoryError} to its Track-0 error envelope. A route
 * matches `instanceof SiteRepositoryError` once and returns this.
 */
export function siteRepositoryErrorResponse(err: SiteRepositoryError): Response {
  if (err instanceof SiteNameConflictError || err instanceof SiteDeleteConfirmationError) {
    return jsonError(err.code, err.message, err.status, { currentName: err.currentName });
  }
  return jsonError(err.code, err.message, err.status);
}
