import 'server-only';

// src/server/auth/activeCompany.ts
//
// Write side of the editor's app-local active company (the `framer_company`
// selector cookie, see src/lib/activeCompanyCookie.ts). The read side is
// resolveActiveCompany in src/server/sites/scope.ts.
//
// The id the browser asks for is checked against the USABLE companies of the
// SERVER-verified session (in the session, holding the `sites` grant, with a
// workspace for this user) BEFORE the cookie is written, so a forged id or a
// company without the grant never even lands in the cookie. Every read
// re-checks anyway: revoking the grant or the membership makes a stale cookie
// fall back safely on the next request. Selecting a company grants nothing: the
// per-request authorization stays in resolveScopeForWorkspace +
// checkWorkspaceAccess on the company's workspace.
//
// Every successful write also deletes the retired `framer_ws` cookie, so the
// per-workspace selector of PR #99 disappears with the first company choice.

import { cookies } from 'next/headers';
import {
  AuthUnavailableError,
  verifySessionOrThrowUnavailable,
} from '@/lib/authBrainAvailability';
import {
  ACTIVE_COMPANY_COOKIE,
  LEGACY_WORKSPACE_COOKIE,
  activeCompanyCookieOptions,
  expiredCookieOptions,
} from '@/lib/activeCompanyCookie';
import { listCompanyChoices } from '@/server/sites/scope';

const SESSION_COOKIE = 'lumitra_session';

export type SelectCompanyResult =
  | { ok: true; companyId: string }
  | { ok: false; reason: 'unauthenticated' | 'not_available' | 'auth_unavailable' };

/**
 * Make `companyId` the editor's active company for this browser, iff it is a
 * usable company of the verified session. Fail-closed: no session is
 * `unauthenticated`, auth-brain failing to answer is `auth_unavailable`, a
 * company outside the session or without the `sites` grant is
 * `not_available`, and in every such case the cookies are left untouched.
 */
export async function selectActiveCompany(companyId: unknown): Promise<SelectCompanyResult> {
  const jar = await cookies();
  const sessionCookie = jar.get(SESSION_COOKIE)?.value;
  if (!sessionCookie) return { ok: false, reason: 'unauthenticated' };

  let session = null;
  try {
    session = await verifySessionOrThrowUnavailable(sessionCookie);
  } catch (err) {
    if (err instanceof AuthUnavailableError) return { ok: false, reason: 'auth_unavailable' };
    throw err;
  }
  if (!session) return { ok: false, reason: 'unauthenticated' };

  if (typeof companyId !== 'string' || companyId.length === 0) {
    return { ok: false, reason: 'not_available' };
  }
  const target = listCompanyChoices(session).find((c) => c.id === companyId);
  if (!target) return { ok: false, reason: 'not_available' };

  jar.set(ACTIVE_COMPANY_COOKIE, target.id, activeCompanyCookieOptions());
  jar.set(LEGACY_WORKSPACE_COOKIE, '', expiredCookieOptions());
  return { ok: true, companyId: target.id };
}

/**
 * The editor path to continue to after choosing a company. Only the
 * dashboard, a project's editor or its preview are accepted (a relative,
 * same-origin path of a fixed shape), so the field can never become an open
 * redirect. Anything else falls back to the dashboard, and so does the
 * migration handler, which must never be a continuation target.
 */
export function safeEditorReturnPath(raw: unknown): string {
  if (typeof raw !== 'string') return '/projects';
  // The one-time cookie migration handler is never a destination.
  if (raw.startsWith('/projects/migrate-company')) return '/projects';
  // `/` is the browser-only demo editor: "Save as a new project" sends a
  // person without a chosen company through the chooser and back to it.
  if (raw === '/') return '/';
  return /^\/projects(\/[A-Za-z0-9_-]+(\/preview)?)?$/.test(raw) ? raw : '/projects';
}
