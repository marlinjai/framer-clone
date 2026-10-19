// src/lib/activeCompanyCookie.ts
//
// The editor's app-local ACTIVE COMPANY selector: the `framer_company` cookie,
// holding an auth-brain tenant id.
//
// Why it exists: the editor works per company (decided 2026-10-19), and
// auth-brain's session-wide `active_tenant` is only the suite default: a user
// of several companies must be able to pick the one they edit sites for here
// without changing it everywhere else. Like Lumitra Studio, only companies that
// hold the auth-brain app grant `sites` can be selected.
//
// The cookie is a SELECTOR, never a credential: every request re-checks the id
// against the companies of the server-verified session AND their `sites` grant
// (resolveActiveCompany in src/server/sites/scope.ts), and the real
// authorization stays in resolveScopeForWorkspace + checkWorkspaceAccess on the
// company's workspace.
//
// The retired `framer_ws` cookie (a workspace id, PR #99) is still READ as a
// fallback selector, mapped to its workspace's company, until the dashboard
// migrates it once (src/app/projects/migrate-company/route.ts) and deletes it.
//
// Dependency-free on purpose (no next/headers, no server-only), so the route
// handlers, the loaders and the server actions can all share it.

import type { CompanySelectors } from '@/server/sites/scope';

/** The cookie name. Host-only on the editor host (no Domain attribute). */
export const ACTIVE_COMPANY_COOKIE = 'framer_company';

/** The retired per-workspace selector, read only to migrate it. */
export const LEGACY_WORKSPACE_COOKIE = 'framer_ws';

/** One year: the value is only a selector, re-validated on every request. */
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * The attributes the cookie is written with. No `domain`, so the browser keeps
 * it host-only on the editor host and never sends it to `*.sites.lumitra.co`.
 * `secure` is on in production (the editor is https-only there) and off in
 * local development, where the app runs on plain http://localhost.
 */
export function activeCompanyCookieOptions(): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: ONE_YEAR_SECONDS,
  };
}

/**
 * The attributes that DELETE the retired `framer_ws` cookie: same name, path
 * `/` and host-only scope it was written with, an empty value and `maxAge: 0`.
 * Spelled out instead of a bare `delete(name)`, whose path default is not
 * guaranteed to match the `/` the cookie was set on.
 */
export function expiredCookieOptions(): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  maxAge: 0;
} {
  return { ...activeCompanyCookieOptions(), maxAge: 0 };
}

/** Read a named cookie value off a raw request `Cookie` header, or null. */
export function readRequestCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

/** The company selectors carried by a route-handler request. */
export function readCompanySelectors(req: Request): CompanySelectors {
  return {
    companyCookie: readRequestCookie(req, ACTIVE_COMPANY_COOKIE),
    legacyWorkspaceCookie: readRequestCookie(req, LEGACY_WORKSPACE_COOKIE),
  };
}

/** Anything with a next/headers-style `get(name)` (the cookie jar). */
export interface CookieReader {
  get(name: string): { value: string } | undefined;
}

/** The company selectors carried by a next/headers cookie jar. */
export function companySelectorsFromJar(jar: CookieReader): CompanySelectors {
  return {
    companyCookie: jar.get(ACTIVE_COMPANY_COOKIE)?.value ?? null,
    legacyWorkspaceCookie: jar.get(LEGACY_WORKSPACE_COOKIE)?.value ?? null,
  };
}
