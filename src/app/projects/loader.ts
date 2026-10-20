import 'server-only';

// src/app/projects/loader.ts
//
// The server-side data loader for the /projects dashboard (MT-09), extracted
// from the page so the isolation + auth contract is unit-testable without
// rendering a server component.
//
// HARD ISOLATION: the company (and so the workspace) the listing is scoped to
// is derived from the SERVER-verified auth-brain session. The app-local
// `framer_company` selector cookie only CHOOSES among the session's companies
// that hold the auth-brain app grant `sites` (resolveActiveScope ->
// resolveActiveCompany); a forged id, a company outside the session or one
// without the grant is ignored, and the scope still goes through
// resolveScopeForWorkspace on that company's workspace.
//
// SIX OUTCOMES, and only one of them goes to the login:
//   - no cookie / an invalid or expired session (verify -> null) ->
//     `unauthenticated` with the auth-brain login URL (the page redirects),
//   - auth-brain could not answer (network error, 5xx) -> `auth_unavailable`
//     (the page renders a retry notice, no redirect),
//   - a VALID session that still carries the retired `framer_ws` cookie ->
//     `migrate_legacy`, ONCE: the page redirects to the migration handler,
//     which deletes that cookie in the same response and comes back with
//     `migrated=1`, on which this outcome is never produced again,
//   - a VALID session none of whose companies can use the editor ->
//     `not_enabled` (the page explains it and links the auth-brain portal),
//   - a VALID session with several usable companies and none picked ->
//     `choose_company` (the page renders the chooser, never a redirect),
//   - otherwise -> `ok` with the active company's sites.
//
// A valid session must NEVER be sent to the login: auth-brain sees the valid
// session and sends the user straight back, which is the endless redirect loop
// of 2026-10-19 (`active_workspace` null for a user with eight companies).

import { cookies, headers } from 'next/headers';
import {
  AuthUnavailableError,
  verifySessionOrThrowUnavailable,
} from '@/lib/authBrainAvailability';
import { companySelectorsFromJar } from '@/lib/activeCompanyCookie';
import { safeEditorReturnPath } from '@/server/auth/activeCompany';
import { companyHasBooksGrant } from '@/server/books/access';
import {
  getSiteRepository,
  grantedCompaniesWithoutWorkspace,
  listCompanyChoices,
  resolveActiveScope,
  type CompanyChoice,
  type SiteSummary,
} from '@/server/sites';

// Same default + cookie name the rest of the app uses (auth-brain.ts /
// auth-api.ts). The build has no runtime env; this default keeps it green.
const AUTH_BRAIN_URL = process.env.AUTH_BRAIN_URL ?? 'https://auth.lumitra.co';
const SESSION_COOKIE = 'lumitra_session';

export type DashboardData =
  | { status: 'unauthenticated'; loginUrl: string }
  | { status: 'auth_unavailable' }
  | { status: 'migrate_legacy'; migrateUrl: string }
  | {
      status: 'not_enabled';
      /** Granted companies the user has no workspace in (named, not offered). */
      grantedWithoutWorkspace: string[];
    }
  | {
      status: 'choose_company';
      companies: CompanyChoice[];
      /** The company already active, when the chooser was opened to switch. */
      activeCompanyId: string | null;
    }
  | {
      status: 'ok';
      sites: SiteSummary[];
      companies: CompanyChoice[];
      activeCompany: CompanyChoice;
      /** The active company holds the auth-brain app grant `books` (shows the Books link). */
      booksEnabled: boolean;
    };

/**
 * Build the auth-brain login URL whose `return_to` brings the user back to this
 * exact dashboard after authenticating — consistent with the middleware bounce
 * contract (proto + forwarded host + path). The absolute URL is first-party in
 * prod, which the auth-brain login open-redirect-validates.
 */
async function buildLoginUrl(next: string): Promise<string> {
  const h = await headers();
  const proto = h.get('x-forwarded-proto') || 'https';
  const host = h.get('x-forwarded-host') || h.get('host') || '';
  // Keep a deep link (a validated editor path) through the login.
  const nextQuery = next === '/projects' ? '' : `?next=${encodeURIComponent(next)}`;
  const returnTo = `${proto}://${host}/projects${nextQuery}`;

  const loginUrl = new URL('/login', AUTH_BRAIN_URL);
  loginUrl.searchParams.set('return_to', returnTo);
  return loginUrl.toString();
}

/** The one-time legacy-cookie migration handler, continuing to `next`. */
function migrateUrlFor(next: string): string {
  return next === '/projects'
    ? '/projects/migrate-company'
    : `/projects/migrate-company?next=${encodeURIComponent(next)}`;
}

/**
 * Resolve the dashboard's data for the current request. The page is the only
 * thing that performs a redirect: to the login for `unauthenticated`, and once
 * to the migration handler for `migrate_legacy`.
 *
 * `opts.forceChooser` renders the chooser even when a company is active (the
 * "Switch company" link in the dashboard chrome); it never changes the scope.
 * `opts.next` is a deep link to keep through the login (validated here with
 * safeEditorReturnPath, so it can never point off-site). `opts.legacyMigrated`
 * is the `migrated=1` marker the migration handler returns with: with it the
 * legacy cookie is only read, never migrated again, so even a browser that
 * refuses to drop the cookie cannot loop.
 */
export async function loadDashboard(
  opts: { forceChooser?: boolean; next?: unknown; legacyMigrated?: boolean } = {},
): Promise<DashboardData> {
  const next = safeEditorReturnPath(opts.next);
  const jar = await cookies();
  const cookie = jar.get(SESSION_COOKIE)?.value;

  let session = null;
  if (cookie) {
    try {
      session = await verifySessionOrThrowUnavailable(cookie);
    } catch (err) {
      // auth-brain could not answer. NOT "signed out": sending the user to the
      // login would loop (auth-brain, once back, sees the valid session). The
      // page renders a retry notice instead.
      if (err instanceof AuthUnavailableError) {
        console.error('[auth] auth-brain unavailable during session verify', err.cause);
        return { status: 'auth_unavailable' };
      }
      throw err;
    }
  }
  if (!session) return { status: 'unauthenticated', loginUrl: await buildLoginUrl(next) };

  const selectors = companySelectorsFromJar(jar);
  if (selectors.legacyWorkspaceCookie && !opts.legacyMigrated && !opts.forceChooser) {
    return { status: 'migrate_legacy', migrateUrl: migrateUrlFor(next) };
  }

  const companies = listCompanyChoices(session);
  if (companies.length === 0) {
    // No company of this session can use the editor (none holds `sites`, or
    // the granted ones have no workspace for this user). A page, not a
    // redirect: there is nothing to choose and nothing to log in to.
    return {
      status: 'not_enabled',
      grantedWithoutWorkspace: grantedCompaniesWithoutWorkspace(session),
    };
  }

  const scopeResult = resolveActiveScope(session, selectors);
  // A valid session with no resolvable company picks one; it is NOT sent to
  // the login (that is the redirect loop this contract exists to prevent).
  if (!scopeResult.ok) {
    return { status: 'choose_company', companies, activeCompanyId: null };
  }
  if (opts.forceChooser) {
    return { status: 'choose_company', companies, activeCompanyId: scopeResult.companyId };
  }

  const activeCompany = companies.find((c) => c.id === scopeResult.companyId);
  if (!activeCompany) {
    // Unreachable: resolveActiveScope only returns a usable company.
    return { status: 'choose_company', companies, activeCompanyId: null };
  }

  const sites = await getSiteRepository().listSites(scopeResult.scope);
  return {
    status: 'ok',
    sites,
    companies,
    activeCompany,
    booksEnabled: companyHasBooksGrant(session, activeCompany.id),
  };
}
