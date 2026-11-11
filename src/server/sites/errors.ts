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
  /** `answer` lets a more specific "not here" (a closed site branch) keep its own code and status. */
  constructor(siteId: string, answer?: { code: string; message: string; status: number }) {
    super(answer?.code ?? 'site_not_found', answer?.message ?? `no site "${siteId}" in this workspace`, answer?.status ?? 404);
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
 * The saved theme breaks a cap (src/lib/site/theme.ts, THEME_LIMITS): more live or
 * deleted tokens than a site holds, or a token name longer than the limit. The editor
 * refuses the same before it ever saves, so this is the server's own guarantee against a
 * request built by hand. Nothing is written. 400.
 */
export class InvalidSiteThemeError extends SiteRepositoryError {
  readonly problems: string[];

  constructor(problems: string[]) {
    super('invalid_site_theme', `The site's colours and fonts cannot be saved: ${problems.join(' ')}`, 400);
    this.problems = problems;
  }
}

/**
 * The settings or a page name an uploaded image (`/site-images/<sha256>.<ext>`)
 * this site does not store: typed by hand, copied from another site, or deleted
 * since it was chosen. Nothing was written. 422.
 */
export class SiteImageMissingError extends SiteRepositoryError {
  readonly path: string;

  constructor(path: string) {
    super(
      'site_image_missing',
      `The image ${path} is not stored for this site (it may have been deleted). Upload the image again, or remove it from the settings, then save.`,
      422,
    );
    this.path = path;
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
 * The revision asked for does not exist on this site: never published, or
 * pruned as the oldest of the kept history. Nothing changed. 404.
 */
export class SiteRevisionNotFoundError extends SiteRepositoryError {
  constructor(siteId: string, revision: number) {
    super('revision_not_found', `site "${siteId}" has no published version ${revision}`, 404);
  }
}

/**
 * A Save or Publish from an editor tab loaded before personal data was erased
 * from this site (its erasure epoch is older than the site's): the tab may still
 * hold the erased value and would write it back. Nothing was written. 409.
 */
export class SiteErasedSinceLoadError extends SiteRepositoryError {
  constructor() {
    super(
      'erased_since_load',
      'Personal data was erased from this project after this tab loaded it. Reload the page to continue. Changes not saved in this tab cannot be saved, since they may still hold the erased data.',
      409,
    );
  }
}

/**
 * A Save or Publish based on an older version of the working copy than the one
 * stored: something else (another tab, an agent, an erase) wrote the project
 * after the caller loaded it, and writing now would overwrite that work unseen.
 * Nothing was written. Carries the stored version, so the caller can decide to
 * save over it explicitly by sending that number. 409.
 */
export class SiteChangedError extends SiteRepositoryError {
  readonly currentVersion: number;

  constructor(currentVersion: number) {
    super(
      'site_changed',
      'This project was changed somewhere else since this tab loaded it. Nothing was saved.',
      409,
    );
    this.currentVersion = currentVersion;
  }
}

/**
 * A Save or Publish that names no `expectedVersion` for a site that already
 * exists. Every write of an existing site's working copy must say which
 * version it was based on; there is no "newest wins" path. 400.
 */
export class SiteVersionRequiredError extends SiteRepositoryError {
  constructor() {
    super(
      'version_required',
      'This editor tab is older than the server and cannot save safely. Reload the page to continue.',
      400,
    );
  }
}

/**
 * An erase whose preview no longer matches what is stored: a publish, a save, a
 * rollback or another erase came in between. Nothing changed. 409.
 */
export class ErasePreviewStaleError extends SiteRepositoryError {
  constructor() {
    super('erase_preview_stale', 'The project changed since the search. Search again, then erase.', 409);
  }
}

/** An erase that found nothing it may rewrite. Nothing changed. 409. */
export class NothingToEraseError extends SiteRepositoryError {
  constructor() {
    super('nothing_to_erase', 'Nothing left to erase for this search.', 409);
  }
}

/**
 * Site branches (docs/plans/2026-11-10-site-branches.md). A branch, or the main site a branch call names, that
 * is not in the caller's workspace, or a branch id that is no branch of that main site. Indistinguishable from a
 * missing one, so existence never leaks. 404.
 */
export class BranchNotFoundError extends SiteRepositoryError {
  constructor(branchId: string) {
    super('branch_not_found', `no branch "${branchId}" of this site in this workspace`, 404);
  }
}

/**
 * A branch that was merged or discarded: its content is gone, nothing more can be written to it. 410
 * `branch_closed`, naming the main site. A kind of SiteNotFoundError, so every caller that already handles a
 * missing site (the editor page, the live stream, MCP approvals, site operations) handles a closed branch the
 * same way, failing closed, and only the places that know about branches say more.
 */
export class BranchClosedError extends SiteNotFoundError {
  readonly branchStatus: 'merged' | 'discarded';
  readonly mainSiteId: string;

  constructor(branchStatus: 'merged' | 'discarded', mainSiteId: string) {
    super(mainSiteId, {
      code: 'branch_closed',
      message:
        branchStatus === 'merged'
          ? 'This branch was merged into its site and is closed. Your changes were not saved.'
          : 'This branch was discarded. Your changes were not saved.',
      status: 410,
    });
    this.branchStatus = branchStatus;
    this.mainSiteId = mainSiteId;
  }
}

/** Publishing, rolling back, unpublishing or giving an address to a branch: only main is ever published. 409. */
export class BranchCannotPublishError extends SiteRepositoryError {
  constructor() {
    super('branch_cannot_publish', 'A branch is never published. Merge it into main, then publish main.', 409);
  }
}

/** An action that only a main site supports was asked of a branch (deleting it as a site, branching it). 409. */
export class SiteIsBranchError extends SiteRepositoryError {
  constructor(what: string) {
    super('site_is_branch', `This is a branch: ${what}`, 409);
  }
}

/** The site already has the most open branches allowed. 409. */
export class BranchLimitError extends SiteRepositoryError {
  readonly limit: number;

  constructor(limit: number) {
    super('branch_limit', `A site can have at most ${limit} open branches. Merge or discard one first.`, 409);
    this.limit = limit;
  }
}

/** Another open branch of the site already has this name (compared without case). 409. */
export class BranchNameTakenError extends SiteRepositoryError {
  constructor(name: string) {
    super('branch_name_taken', `An open branch named "${name}" already exists on this site.`, 409);
  }
}

/** A branch name that is empty or too long once cleaned. 400. */
export class InvalidBranchNameError extends SiteRepositoryError {
  constructor(message: string) {
    super('invalid_branch_name', message, 400);
  }
}

/**
 * A branch review request named a state that is no longer the stored one (main, the branch or its fork point
 * moved, or a name changed): nothing was written, the review reloads. 409 `branch_review_stale`.
 */
export class BranchReviewStaleError extends SiteRepositoryError {
  constructor() {
    super('branch_review_stale', 'Main or the branch changed since this review was loaded. Nothing was written; reload the review.', 409);
  }
}

/** Conflicts of an update from main still need an answer: nothing was written, the answers given were kept. 409. */
export class BranchConflictsError extends SiteRepositoryError {
  readonly conflicts: readonly unknown[];
  readonly token: string;
  /** Whether the answers that applied were stored; false when the branch or main moved meanwhile (give them again). */
  readonly answersKept: boolean;

  constructor(conflicts: readonly unknown[], token: string, answersKept: boolean) {
    super(
      'branch_conflicts',
      `${conflicts.length} conflict(s) with main need an answer before the branch can be updated.${answersKept ? '' : ' The answers given were not stored, because main or the branch changed meanwhile: reload the review.'}`,
      409,
    );
    this.conflicts = conflicts;
    this.token = token;
    this.answersKept = answersKept;
  }
}

/**
 * A merge into main on a branch that was behind main: the merge ran the update from main instead (or found it
 * needs answers), and stopped. The branch's version moved, so an approval must be given again. 409.
 */
export class BranchUpdatedFirstError extends SiteRepositoryError {
  readonly token: string;

  constructor(token: string) {
    super('branch_updated_from_main', 'Main had changed: the branch was updated from main first. Review it again, then merge.', 409);
    this.token = token;
  }
}

/** The merged or updated document would not be a valid site: nothing was written. 422 with the reasons. */
export class BranchMergeInvalidError extends SiteRepositoryError {
  readonly problems: ReadonlyArray<{ code: string; message: string; pageId?: string; componentId?: string }>;
  /** For an update: whether the answers given were stored; undefined for a merge, which takes none. */
  readonly answersKept: boolean | undefined;

  constructor(problems: ReadonlyArray<{ code: string; message: string; pageId?: string; componentId?: string }>, answersKept?: boolean) {
    super('branch_merge_invalid', `The result would not be a valid site: ${problems.map((p) => p.message).slice(0, 3).join('; ')}`, 422);
    this.problems = problems;
    this.answersKept = answersKept;
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
  if (err instanceof SiteChangedError) {
    return jsonError(err.code, err.message, err.status, { currentVersion: err.currentVersion });
  }
  if (err instanceof BranchClosedError) {
    return jsonError(err.code, err.message, err.status, { branchStatus: err.branchStatus, mainSiteId: err.mainSiteId });
  }
  if (err instanceof BranchConflictsError) {
    return jsonError(err.code, err.message, err.status, { conflicts: err.conflicts, token: err.token, answersKept: err.answersKept });
  }
  if (err instanceof BranchUpdatedFirstError) {
    return jsonError(err.code, err.message, err.status, { token: err.token });
  }
  if (err instanceof BranchMergeInvalidError) {
    return jsonError(err.code, err.message, err.status, {
      problems: err.problems,
      ...(err.answersKept === undefined ? {} : { answersKept: err.answersKept }),
    });
  }
  if (err instanceof BranchLimitError) {
    return jsonError(err.code, err.message, err.status, { limit: err.limit });
  }
  return jsonError(err.code, err.message, err.status);
}
