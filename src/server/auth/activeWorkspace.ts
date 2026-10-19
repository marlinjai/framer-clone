import 'server-only';

// src/server/auth/activeWorkspace.ts
//
// Write side of the editor's app-local active workspace (the `framer_ws`
// selector cookie, see src/lib/activeWorkspaceCookie.ts). The read side is
// resolveActiveWorkspaceId in src/server/sites/scope.ts.
//
// The id the browser asks for is checked against the workspaces of the
// SERVER-verified session BEFORE the cookie is written, so a forged id never
// even lands in the cookie. (Every read re-checks membership anyway: removing a
// user from a workspace makes a stale cookie fall back safely on the next
// request.) Selecting a workspace grants nothing: the per-request authorization
// stays in resolveScopeForWorkspace + checkWorkspaceAccess.

import { cookies } from 'next/headers';
import { authBrainClient } from '@/lib/auth-brain';
import {
  ACTIVE_WORKSPACE_COOKIE,
  activeWorkspaceCookieOptions,
} from '@/lib/activeWorkspaceCookie';

const SESSION_COOKIE = 'lumitra_session';

export type SelectWorkspaceResult =
  | { ok: true; workspaceId: string }
  | { ok: false; reason: 'unauthenticated' | 'not_a_member' };

/**
 * Make `workspaceId` the editor's active workspace for this browser, iff the
 * verified session contains it. Fail-closed: no session or a thrown verify is
 * `unauthenticated`, an id outside the session is `not_a_member`, and in both
 * cases the cookie is left untouched.
 */
export async function selectActiveWorkspace(
  workspaceId: unknown,
): Promise<SelectWorkspaceResult> {
  const jar = await cookies();
  const sessionCookie = jar.get(SESSION_COOKIE)?.value;
  if (!sessionCookie) return { ok: false, reason: 'unauthenticated' };

  let session = null;
  try {
    session = await authBrainClient.verifySession(sessionCookie);
  } catch {
    session = null;
  }
  if (!session) return { ok: false, reason: 'unauthenticated' };

  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    return { ok: false, reason: 'not_a_member' };
  }
  const workspaces = Array.isArray(session.workspaces) ? session.workspaces : [];
  const target = workspaces.find((w) => w.id === workspaceId);
  if (!target) return { ok: false, reason: 'not_a_member' };

  jar.set(ACTIVE_WORKSPACE_COOKIE, target.id, activeWorkspaceCookieOptions());
  return { ok: true, workspaceId: target.id };
}

/**
 * The editor path to continue to after choosing a workspace. Only the
 * dashboard, a project's editor or its preview are accepted (a relative,
 * same-origin path of a fixed shape), so the field can never become an open
 * redirect. Anything else falls back to the dashboard.
 */
export function safeEditorReturnPath(raw: unknown): string {
  if (typeof raw !== 'string') return '/projects';
  return /^\/projects(\/[A-Za-z0-9_-]+(\/preview)?)?$/.test(raw) ? raw : '/projects';
}
