// src/lib/activeWorkspaceCookie.ts
//
// The editor's app-local ACTIVE WORKSPACE selector: the `framer_ws` cookie.
//
// Why it exists: auth-brain's session carries a global `active_workspace`, but
// it is null for users who belong to several companies and never picked one
// (the real case on 2026-10-19: eight companies, eight workspaces, no active
// workspace). The editor used to treat that as "unauthenticated" and bounced to
// the login, which saw a valid session and bounced straight back: an endless
// redirect loop. The editor now keeps its OWN selection, like the receipts app
// does with `receipts_ws`.
//
// The cookie is a SELECTOR, never a credential: every request re-checks the id
// against the workspaces of the server-verified session
// (resolveActiveWorkspaceId in src/server/sites/scope.ts), and the real
// authorization stays in resolveScopeForWorkspace + checkWorkspaceAccess.
//
// Dependency-free on purpose (no next/headers, no server-only), so the route
// handlers, the loaders and the server actions can all share it.

/** The cookie name. Host-only on the editor host (no Domain attribute). */
export const ACTIVE_WORKSPACE_COOKIE = 'framer_ws';

/** One year: the value is only a selector, re-validated on every request. */
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * The attributes the cookie is written with. No `domain`, so the browser keeps
 * it host-only on the editor host and never sends it to `*.sites.lumitra.co`.
 * `secure` is on in production (the editor is https-only there) and off in
 * local development, where the app runs on plain http://localhost.
 */
export function activeWorkspaceCookieOptions(): {
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

/** The `framer_ws` value carried by a route-handler request, or null. */
export function readActiveWorkspaceCookie(req: Request): string | null {
  return readRequestCookie(req, ACTIVE_WORKSPACE_COOKIE);
}
