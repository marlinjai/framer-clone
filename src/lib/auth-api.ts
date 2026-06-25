/**
 * auth-api.ts -- request-level authentication + authorization for the
 * framer-clone API route handlers, backed by auth-brain.
 *
 * Two guards, both fail-closed:
 *   - authenticateRequest(): require a valid session AND workspace access for an
 *     action (the per-resource write/read guard).
 *   - authenticateAccountRequest(): require only a valid session (account-level
 *     operations not yet scoped to a workspace, e.g. listing the caller's sites).
 *
 * These operate on the standard Web `Request` (the shape framer-clone's route
 * handlers already use) and read the `lumitra_session` cookie straight off the
 * request headers, so they work in both the Node and edge runtimes without
 * depending on `next/headers`.
 */

import type { SessionVerifyResponse } from '@marlinjai/auth-brain-sdk';
import { authBrainClient } from './auth-brain';
import { checkWorkspaceAccess } from './auth-check';
import type { FramerAction } from './permissions';

type AuthSuccess = {
  authenticated: true;
  userId: string;
};

type AuthFailure = {
  authenticated: false;
  error: string;
  status: 401 | 403;
};

export type AuthResult = AuthSuccess | AuthFailure;

const SESSION_COOKIE = 'lumitra_session';

/** Read a named cookie value off a raw request `Cookie` header. */
function readCookie(req: Request, name: string): string | null {
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

/**
 * Resolve the session user id from the `lumitra_session` cookie, or null when
 * there is no cookie or the session is invalid/expired (fail-closed).
 */
async function getSessionUserId(req: Request): Promise<string | null> {
  const cookie = readCookie(req, SESSION_COOKIE);
  if (!cookie) return null;
  const session = await authBrainClient.verifySession(cookie);
  return session?.user?.id ?? null;
}

/**
 * Resolve the FULL verified session from the `lumitra_session` cookie, or null
 * when there is no cookie or the session is invalid/expired (fail-closed).
 *
 * `authenticateRequest` only needs the user id, but a route that must derive the
 * tenant scope (workspace_id + tenant_group_id) needs the whole session graph
 * (workspaces + tenants + active_workspace). This exposes it from the single
 * place that already owns cookie parsing, so the scope is ALWAYS derived from
 * the server-verified session and never from anything the client sends.
 */
export async function getVerifiedSession(
  req: Request,
): Promise<SessionVerifyResponse | null> {
  const cookie = readCookie(req, SESSION_COOKIE);
  if (!cookie) return null;
  return authBrainClient.verifySession(cookie);
}

/**
 * Authenticate a request and authorize it against a workspace + action.
 *
 *   1. No session -> 401 Unauthorized.
 *   2. Session but no workspace access for `action` -> 403 Forbidden.
 *   3. Otherwise -> { authenticated: true, userId }.
 *
 * `action` defaults to `editSite` (the mutation guard) so a route that forgets
 * to pass one gets the SAFER, stricter check, never the weaker read check.
 */
export async function authenticateRequest(
  req: Request,
  workspaceId: string,
  action: FramerAction = 'editSite',
): Promise<AuthResult> {
  const userId = await getSessionUserId(req);
  if (!userId) return { authenticated: false, error: 'Unauthorized', status: 401 };

  const allowed = await checkWorkspaceAccess(userId, workspaceId, action);
  if (!allowed) return { authenticated: false, error: 'Forbidden', status: 403 };

  return { authenticated: true, userId };
}

/**
 * Authenticate a request that is not yet workspace-scoped (account-level): a
 * valid session is required, but no per-resource permission check runs. Use for
 * operations like "list the sites this user can see" where the per-row filter
 * happens in the query, not the guard.
 */
export async function authenticateAccountRequest(
  req: Request,
): Promise<AuthResult> {
  const userId = await getSessionUserId(req);
  if (!userId) return { authenticated: false, error: 'Unauthorized', status: 401 };
  return { authenticated: true, userId };
}
