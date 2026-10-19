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
import { checkWorkspaceAccess } from './auth-check';
import type { FramerAction } from './permissions';
import { readRequestCookie as readCookie } from './activeWorkspaceCookie';
import { verifySessionOrThrowUnavailable } from './authBrainAvailability';

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

/**
 * Resolve the session user id from the `lumitra_session` cookie, or null when
 * there is no cookie or the session is invalid/expired (fail-closed). Throws
 * AuthUnavailableError when auth-brain cannot answer (never "signed out").
 */
async function getSessionUserId(req: Request): Promise<string | null> {
  const cookie = readCookie(req, SESSION_COOKIE);
  if (!cookie) return null;
  const session = await verifySessionOrThrowUnavailable(cookie);
  return session?.user?.id ?? null;
}

/**
 * Resolve the FULL verified session from the `lumitra_session` cookie, or null
 * when there is no cookie or the session is invalid/expired (fail-closed).
 * Throws AuthUnavailableError when auth-brain cannot answer: wrap the route in
 * withAuthAvailability so that becomes the JSON 503 `auth_unavailable`.
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
  return verifySessionOrThrowUnavailable(cookie);
}

/**
 * Authenticate a request and authorize it against a workspace + action.
 *
 *   1. No session -> 401 Unauthorized.
 *   2. Session but no workspace access for `action` -> 403 Forbidden.
 *   3. Otherwise -> { authenticated: true, userId }.
 *
 * When OpenFGA cannot answer the permission check this THROWS
 * AuthzUnavailableError rather than returning a 403: wrap the route in
 * withAuthAvailability so that becomes the JSON 503 `authz_unavailable`.
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
