import 'server-only';

// src/app/projects/loader.ts
//
// The server-side data loader for the /projects dashboard (MT-09), extracted
// from the page so the isolation + auth contract is unit-testable without
// rendering a server component.
//
// HARD ISOLATION: the workspace the listing is scoped to is derived from the
// SERVER-verified auth-brain session. The app-local `framer_ws` selector cookie
// only CHOOSES among the workspaces that session already contains
// (resolveActiveScope -> resolveActiveWorkspaceId); a forged or stale id is
// ignored and the scope still goes through resolveScopeForWorkspace.
//
// FOUR OUTCOMES, and only one of them goes to the login:
//   - no cookie / an invalid or expired session (verify -> null) ->
//     `unauthenticated` with the auth-brain login URL (the page redirects),
//   - auth-brain could not answer (network error, 5xx) -> `auth_unavailable`
//     (the page renders a retry notice, no redirect),
//   - a VALID session with no resolvable workspace (several workspaces, none
//     picked; or none at all) -> `choose_workspace` with the session's
//     workspaces (the page renders the chooser, never a redirect),
//   - otherwise -> `ok` with the active workspace's sites.
//
// A valid session must NEVER be sent to the login: auth-brain sees the valid
// session and sends the user straight back, which is the endless redirect loop
// of 2026-10-19 (`active_workspace` null for a user with eight companies).

import { cookies, headers } from 'next/headers';
import {
  AuthUnavailableError,
  verifySessionOrThrowUnavailable,
} from '@/lib/authBrainAvailability';
import { ACTIVE_WORKSPACE_COOKIE } from '@/lib/activeWorkspaceCookie';
import {
  getSiteRepository,
  listWorkspaceChoices,
  resolveActiveScope,
  type SiteSummary,
  type WorkspaceChoice,
} from '@/server/sites';

// Same default + cookie name the rest of the app uses (auth-brain.ts /
// auth-api.ts). The build has no runtime env; this default keeps it green.
const AUTH_BRAIN_URL = process.env.AUTH_BRAIN_URL ?? 'https://auth.lumitra.co';
const SESSION_COOKIE = 'lumitra_session';

export type DashboardData =
  | { status: 'unauthenticated'; loginUrl: string }
  | { status: 'auth_unavailable' }
  | {
      status: 'choose_workspace';
      workspaces: WorkspaceChoice[];
      /** The workspace already active, when the chooser was opened to switch. */
      activeWorkspaceId: string | null;
    }
  | {
      status: 'ok';
      sites: SiteSummary[];
      workspaces: WorkspaceChoice[];
      activeWorkspace: WorkspaceChoice;
    };

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
 * Resolve the dashboard's data for the current request. The page is the only
 * thing that performs a redirect, and it does so only for `unauthenticated`.
 *
 * `opts.forceChooser` renders the chooser even when a workspace is active (the
 * "Switch workspace" link in the dashboard chrome); it never changes the scope.
 */
export async function loadDashboard(
  opts: { forceChooser?: boolean } = {},
): Promise<DashboardData> {
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
  if (!session) return { status: 'unauthenticated', loginUrl: await buildLoginUrl() };

  const workspaces = listWorkspaceChoices(session);
  const scopeResult = resolveActiveScope(
    session,
    jar.get(ACTIVE_WORKSPACE_COOKIE)?.value ?? null,
  );
  // A valid session with no resolvable workspace picks one; it is NOT sent to
  // the login (that is the redirect loop this contract exists to prevent).
  if (!scopeResult.ok) {
    return { status: 'choose_workspace', workspaces, activeWorkspaceId: null };
  }
  if (opts.forceChooser) {
    return {
      status: 'choose_workspace',
      workspaces,
      activeWorkspaceId: scopeResult.scope.workspaceId,
    };
  }

  const activeWorkspace = workspaces.find((w) => w.id === scopeResult.scope.workspaceId);
  if (!activeWorkspace) {
    // Unreachable: resolveActiveScope only returns a workspace of this session.
    return { status: 'choose_workspace', workspaces, activeWorkspaceId: null };
  }

  const sites = await getSiteRepository().listSites(scopeResult.scope);
  return { status: 'ok', sites, workspaces, activeWorkspace };
}
