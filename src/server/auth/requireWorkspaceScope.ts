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
// a 401/403 status. The failure surfaces to the grid (a rejected action), never
// a silent no-op that reads as success and never a silent widen to another
// workspace.

import { cookies } from 'next/headers';
import { authBrainClient } from '@/lib/auth-brain';
import { checkWorkspaceAccess } from '@/lib/auth-check';
import type { FramerAction } from '@/lib/permissions';
import { resolveActiveScope, type TenantScope } from '@/server/sites';

const SESSION_COOKIE = 'lumitra_session';

/**
 * Thrown when a guarded server action is invoked without a valid session, with
 * no resolvable active workspace, or without permission for the requested
 * action. Carries the HTTP-style `status` (401 unauthenticated / 403 forbidden)
 * and a typed `code` so a caller can map it to a response or distinguish it from
 * a data error.
 */
export class AuthError extends Error {
  readonly status: 401 | 403;
  readonly code: 'unauthorized' | 'forbidden';
  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = status === 401 ? 'unauthorized' : 'forbidden';
  }
}

/**
 * Resolve and authorize the TenantScope for the current server-action request.
 *
 *   1. No `lumitra_session` cookie / failed verify -> AuthError 401.
 *   2. Session but no resolvable active workspace -> AuthError 403.
 *   3. Session + workspace but no permission for `action` -> AuthError 403.
 *   4. Otherwise -> the verified scope (workspaceId + tenantGroupId).
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
    session = await authBrainClient.verifySession(cookie);
  } catch {
    // Fail-closed: a thrown verify is treated as no session, never authorized.
    session = null;
  }
  if (!session) throw new AuthError(401, 'authentication required');

  // Scope is derived from the SERVER session only; no active workspace is a
  // deny, never a guess at one.
  const scopeResult = resolveActiveScope(session);
  if (!scopeResult.ok) throw new AuthError(403, 'no active workspace');
  const { scope } = scopeResult;

  const allowed = await checkWorkspaceAccess(
    session.user.id,
    scope.workspaceId,
    action,
  );
  if (!allowed) throw new AuthError(403, 'forbidden');

  return scope;
}
