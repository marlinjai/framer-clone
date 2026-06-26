import 'server-only';

// src/app/projects/loader.ts
//
// The server-side data loader for the /projects dashboard (MT-09), extracted
// from the page so the isolation + auth-bounce contract is unit-testable
// without rendering a server component.
//
// HARD ISOLATION: the workspace the listing is scoped to is derived ENTIRELY
// from the SERVER-verified auth-brain session (the session's active workspace
// -> its tenant -> tenant_group), never from anything the client sends. There
// is no client-supplied workspace input here at all.
//
// FAIL-CLOSED: a missing cookie, a failed/expired verify, or a session with no
// resolvable active workspace all resolve to the same "unauthenticated" result
// carrying the auth-brain login URL — the page then redirects, never throws a
// 500. verifySession already maps 401/timeout/5xx to null (fail-closed); the
// extra try/catch is belt-and-suspenders so a thrown verify can never surface
// as a 500 dashboard.

import { cookies, headers } from 'next/headers';
import { authBrainClient } from '@/lib/auth-brain';
import {
  getSiteRepository,
  resolveActiveScope,
  type SiteSummary,
} from '@/server/sites';

// Same default + cookie name the rest of the app uses (auth-brain.ts /
// auth-api.ts). The build has no runtime env; this default keeps it green.
const AUTH_BRAIN_URL = process.env.AUTH_BRAIN_URL ?? 'https://auth.lumitra.co';
const SESSION_COOKIE = 'lumitra_session';

export type DashboardData =
  | { authenticated: false; loginUrl: string }
  | { authenticated: true; sites: SiteSummary[] };

/**
 * Build the auth-brain login URL whose `return_to` brings the user back to this
 * exact dashboard after authenticating — consistent with the middleware bounce
 * contract (proto + forwarded host + path). The absolute URL is first-party in
 * prod, which the auth-brain login open-redirect-validates.
 */
async function buildLoginUrl(): Promise<string> {
  const h = await headers();
  const proto = h.get('x-forwarded-proto') || 'https';
  const host = h.get('x-forwarded-host') || h.get('host') || '';
  const returnTo = `${proto}://${host}/projects`;

  const loginUrl = new URL('/login', AUTH_BRAIN_URL);
  loginUrl.searchParams.set('return_to', returnTo);
  return loginUrl.toString();
}

/**
 * Resolve the dashboard's data for the current request: the caller's own
 * workspace-scoped site list, or an unauthenticated result carrying the login
 * URL to redirect to. The page is the only thing that performs the redirect.
 */
export async function loadDashboard(): Promise<DashboardData> {
  const jar = await cookies();
  const cookie = jar.get(SESSION_COOKIE)?.value;

  let session = null;
  if (cookie) {
    try {
      session = await authBrainClient.verifySession(cookie);
    } catch {
      // Fail-closed: a thrown verify is treated as no session, never a 500.
      session = null;
    }
  }
  if (!session) return { authenticated: false, loginUrl: await buildLoginUrl() };

  // Scope is derived from the SERVER session only. No active workspace ->
  // treat as unauthenticated for the dashboard (bounce to login), never guess.
  const scopeResult = resolveActiveScope(session);
  if (!scopeResult.ok) {
    return { authenticated: false, loginUrl: await buildLoginUrl() };
  }

  const sites = await getSiteRepository().listSites(scopeResult.scope);
  return { authenticated: true, sites };
}
