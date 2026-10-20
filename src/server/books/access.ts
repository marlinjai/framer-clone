// src/server/books/access.ts
//
// Who may open the Books (Books plan section 3, phase 2). Pure functions over
// the verified auth-brain session, so the rule is unit-testable without a
// request.
//
// The Books belong to a COMPANY (an auth-brain tenant), and the company is the
// editor's ACTIVE company (src/server/sites/scope.ts, resolveActiveCompany):
// the Books area lives inside the editor, so it inherits the editor's company
// choice and its `sites` gate. On top of that the company must hold the
// auth-brain app grant `books` (plan section 3: "framer-clone's document-tier
// routes require `books`"). Same reading rules as the `sites` grant:
//
//   - only the session's DIRECT `tenants[]` count (never `inherited_tenants`),
//   - an entry without an `app_grants` field (an older auth-brain build) fails
//     closed like "not granted" (the version skew is already logged by the
//     `sites` resolution that runs first),
//   - the grant is re-read from the verified session on every request, so
//     revoking it takes effect on the next request.
//
// Consequence, written down because no screen explains it: a company holding
// `books` but not `sites` cannot reach the Books, because there is no editor
// for it to open. Acceptable while the Books live in the editor.

import type { SessionVerifyResponse } from '@marlinjai/auth-brain-sdk';

/** The auth-brain app grant a company needs to use the Books. */
export const BOOKS_APP = 'books';

/** True when the session's direct company `companyId` holds the `books` grant. */
export function companyHasBooksGrant(session: SessionVerifyResponse, companyId: string): boolean {
  if (typeof companyId !== 'string' || companyId.length === 0) return false;
  const tenants = Array.isArray(session.tenants) ? session.tenants : [];
  const tenant = tenants.find((t) => t && t.id === companyId);
  if (!tenant) return false;
  const grants = (tenant as { app_grants?: unknown }).app_grants;
  return Array.isArray(grants) && grants.includes(BOOKS_APP);
}

/** The tenant group of the session's direct company `companyId`, or null. */
export function companyTenantGroupId(session: SessionVerifyResponse, companyId: string): string | null {
  const tenants = Array.isArray(session.tenants) ? session.tenants : [];
  const tenant = tenants.find((t) => t && t.id === companyId);
  const group = tenant?.group_id;
  return typeof group === 'string' && group.length > 0 ? group : null;
}
