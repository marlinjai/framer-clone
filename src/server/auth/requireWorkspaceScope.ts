import 'server-only';

// src/server/auth/requireWorkspaceScope.ts
//
// The next/headers session guard for framer-clone SERVER ACTIONS (the CMS
// editing grid's write path), the action-flavored sibling of the Route-Handler
// guard the API routes use (getVerifiedSession -> resolveActiveScope ->
// authenticateRequest). A server action has no `Request`, so it reads the
// `lumitra_session` cookie via next/headers, verifies it through auth-brain,
// derives the TenantScope from the SERVER-verified session's ACTIVE workspace,
// and authorizes the action against that workspace.
//
// HARD ISOLATION: the workspace a write lands in is derived ENTIRELY from the
// verified session, never from anything the client sends. There is NO fallback
// to a constant workspace — the interim single-secret super-admin this replaces
// (src/server/auth/guard.ts, removed in MT-14) wrote to ONE workspace regardless
// of who was logged in, which is a cross-tenant isolation hole.
//
// FAIL-CLOSED: no cookie, a failed/expired verify, a session with no resolvable
// active workspace, or a denied permission all THROW a typed AuthError carrying
// a 401/403 status; auth-brain or OpenFGA failing to answer throws a 503
// (`auth_unavailable` / `authz_unavailable`), never a 403. The failure surfaces to the grid (a rejected action), never
// a silent no-op that reads as success and never a silent widen to another
// workspace.

import { cookies } from 'next/headers';
import {
  AuthUnavailableError,
  AuthzUnavailableError,
  verifySessionOrThrowUnavailable,
} from '@/lib/authBrainAvailability';
import { checkWorkspaceAccess } from '@/lib/auth-check';
import type { FramerAction } from '@/lib/permissions';
import { ACTIVE_WORKSPACE_COOKIE } from '@/lib/activeWorkspaceCookie';
import { resolveActiveScope, type TenantScope } from '@/server/sites';

const SESSION_COOKIE = 'lumitra_session';

export type AuthErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'no_active_workspace'
  | 'auth_unavailable'
  | 'authz_unavailable';

/**
 * Thrown when a guarded server action is invoked without a valid session, with
 * no resolvable active workspace, or without permission for the requested
 * action, or when the service that decides one of those could not answer.
 * Carries the HTTP-style `status` (401 unauthenticated / 403 forbidden / 503
 * unavailable) and a typed `code` so a caller can map it to a response or
 * distinguish it from a data error. A 503 is `auth_unavailable` (auth-brain,
 * the session check) unless the caller names `authz_unavailable` (OpenFGA, the
 * permission check).
 */
export class AuthError extends Error {
  readonly status: 401 | 403 | 503;
  readonly code: AuthErrorCode;
  constructor(status: 401 | 403 | 503, message: string, code?: AuthErrorCode) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code =
      code ??
      (status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'auth_unavailable');
  }
}

/**
 * Resolve and authorize the TenantScope for the current server-action request.
 *
 *   1. No `lumitra_session` cookie / failed verify -> AuthError 401.
 *   2. Session but no resolvable active workspace -> AuthError 403
 *      `no_active_workspace`.
 *   3. Session + workspace but no permission for `action` -> AuthError 403.
 *   4. auth-brain cannot answer -> AuthError 503 `auth_unavailable`; OpenFGA
 *      cannot answer the permission check -> AuthError 503
 *      `authz_unavailable`. Neither is a deny, and neither is ever a grant.
 *   5. Otherwise -> the verified scope (workspaceId + tenantGroupId).
 *
 * `action` defaults to `editSite` (the mutation guard) so a caller that forgets
 * to pass one gets the SAFER, stricter check, never a weaker read check.
 */
export async function requireWorkspaceScope(
  action: FramerAction = 'editSite',
): Promise<TenantScope> {
  const jar = await cookies();
  const cookie = jar.get(SESSION_COOKIE)?.value;
  if (!cookie) throw new AuthError(401, 'authentication required');

  let session = null;
  try {
    session = await verifySessionOrThrowUnavailable(cookie);
  } catch (err) {
    // auth-brain could not answer: a 503, never "signed out". Never authorized.
    if (err instanceof AuthUnavailableError) {
      throw new AuthError(503, 'sign-in service unavailable, retry');
    }
    throw err;
  }
  if (!session) throw new AuthError(401, 'authentication required');

  // Scope is derived from the SERVER session only: the `framer_ws` selector is
  // honoured only when the verified session contains that workspace. No
  // resolvable workspace is a deny, never a guess at one.
  const scopeResult = resolveActiveScope(
    session,
    jar.get(ACTIVE_WORKSPACE_COOKIE)?.value ?? null,
  );
  if (!scopeResult.ok) throw new AuthError(403, 'no active workspace', 'no_active_workspace');
  const { scope } = scopeResult;

  let allowed: boolean;
  try {
    allowed = await checkWorkspaceAccess(session.user.id, scope.workspaceId, action);
  } catch (err) {
    // OpenFGA could not answer (cause logged in permissions.can): a 503, never
    // reported as "forbidden" and never authorized.
    if (err instanceof AuthzUnavailableError) {
      throw new AuthError(503, 'permission service unavailable, retry', 'authz_unavailable');
    }
    throw err;
  }
  if (!allowed) throw new AuthError(403, 'forbidden');

  return scope;
}
