// src/lib/cms/actionResult.ts
//
// The result shape of the CMS grid's guarded server actions (reads and writes)
// (src/server/cms/actions.ts). Client-safe: no server imports.
//
// Why a result instead of a throw: in production Next.js replaces the message
// of an error thrown from a server action with an opaque digest, so a thrown
// AuthError reached the grid as "An error occurred in the Server Components
// render" and the user could not tell a permission-service outage from a real
// deny. EXPECTED failures (the auth and permission decisions) therefore come
// back as `{ ok: false, code, message }`; unexpected errors (a database
// failure, a bug) still throw. The client adapter
// (src/components/cms/grid/cmsServerActionsAdapter.ts) turns a failed result
// into a CmsActionError thrown on the CLIENT, where the message survives, and
// the grid shows it.

export type CmsActionErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'no_active_company'
  | 'sites_not_enabled'
  | 'auth_unavailable'
  | 'authz_unavailable';

export type CmsActionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: CmsActionErrorCode; message: string };

const MESSAGES: Record<CmsActionErrorCode, string> = {
  unauthorized: 'Your session has expired. Sign in again to keep editing.',
  forbidden: 'You do not have permission to open or change this collection.',
  no_active_company: 'No company is selected. Reload the page and choose a company.',
  sites_not_enabled: 'Lumitra Sites is not enabled for this company.',
  auth_unavailable:
    'The sign-in service is temporarily unavailable, so nothing was loaded or saved.',
  authz_unavailable:
    'The permission service is temporarily unavailable, so nothing was loaded or saved.',
};

/** The readable, user-facing message for an expected CMS action failure. */
export function cmsActionErrorMessage(code: CmsActionErrorCode): string {
  return MESSAGES[code];
}

/** The retry hint the grid shows under a retryable (outage) failure. */
export const CMS_RETRY_HINT = 'Please try again in a moment.';

/** True for the outage codes, where retrying later can succeed. */
export function isRetryableCmsActionError(code: CmsActionErrorCode): boolean {
  return code === 'auth_unavailable' || code === 'authz_unavailable';
}

/** An expected CMS action failure, rethrown on the client with its code. */
export class CmsActionError extends Error {
  readonly code: CmsActionErrorCode;
  readonly retryable: boolean;
  constructor(code: CmsActionErrorCode, message: string = cmsActionErrorMessage(code)) {
    super(message);
    this.name = 'CmsActionError';
    this.code = code;
    this.retryable = isRetryableCmsActionError(code);
  }
}

/** The value of a successful result; throws CmsActionError for a failed one. */
export function unwrapCmsActionResult<T>(result: CmsActionResult<T>): T {
  if (result.ok) return result.value;
  throw new CmsActionError(result.code, result.message);
}
