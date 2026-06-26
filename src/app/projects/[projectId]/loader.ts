import 'server-only';

// src/app/projects/[projectId]/loader.ts
//
// The server-side loader for the per-project editor route (MT-10), extracted
// from the page so the isolation + auth-bounce + 404 contract is unit-testable
// without rendering a server component.
//
// HARD ISOLATION: the workspace the project is loaded under is derived ENTIRELY
// from the SERVER-verified auth-brain session (the session's active workspace ->
// its tenant -> tenant_group), never from a client-supplied workspace or the
// loaded MST tree. `loadProject` filters by `workspace_id`, so a `projectId`
// that lives in ANOTHER workspace is indistinguishable from a missing one: it
// throws `SiteNotFoundError`, which this loader maps to a `not_found` result the
// page turns into `notFound()`. A foreign tenant's project is NEVER rendered.
//
// FAIL-CLOSED: a missing cookie, a failed/expired verify, or a session with no
// resolvable active workspace all resolve to the same `unauthenticated` result
// carrying the auth-brain login URL — the page then redirects, never throws a
// 500. The extra try/catch around verify is belt-and-suspenders so a thrown
// verify can never surface as a 500 editor.

import { cookies, headers } from 'next/headers';
import { getSnapshot } from 'mobx-state-tree';
import { authBrainClient } from '@/lib/auth-brain';
import {
  getSiteRepository,
  resolveActiveScope,
  SiteNotFoundError,
} from '@/server/sites';
import type { ProjectSnapshotOut } from '@/models/ProjectModel';

// Same default + cookie name the rest of the app uses (auth-brain.ts /
// auth-api.ts / the MT-09 dashboard loader). The build has no runtime env; this
// default keeps it green.
const AUTH_BRAIN_URL = process.env.AUTH_BRAIN_URL ?? 'https://auth.lumitra.co';
const SESSION_COOKIE = 'lumitra_session';

export type ProjectLoadResult =
  | { status: 'unauthenticated'; loginUrl: string }
  | { status: 'not_found' }
  | { status: 'ok'; snapshot: ProjectSnapshotOut };

/**
 * Build the auth-brain login URL whose `return_to` brings the user back to this
 * exact project editor after authenticating — consistent with the middleware
 * bounce contract (proto + forwarded host + path), and matching the MT-09
 * dashboard loader's shape.
 */
async function buildLoginUrl(
  projectId: string,
  returnPathSuffix: string,
): Promise<string> {
  const h = await headers();
  const proto = h.get('x-forwarded-proto') || 'https';
  const host = h.get('x-forwarded-host') || h.get('host') || '';
  const returnTo = `${proto}://${host}/projects/${projectId}${returnPathSuffix}`;

  const loginUrl = new URL('/login', AUTH_BRAIN_URL);
  loginUrl.searchParams.set('return_to', returnTo);
  return loginUrl.toString();
}

/**
 * Resolve the editor's data for `/projects/<projectId>`: the workspace-scoped
 * project serialized to a snapshot the client editor hydrates, OR a fail-closed
 * `unauthenticated`/`not_found` result. The page is the only thing that
 * performs the redirect / `notFound()`.
 *
 * `returnPathSuffix` is appended to the `return_to` so a consumer route deeper
 * than the editor (e.g. the MT-11 preview at `/projects/<id>/preview`) bounces
 * the user back to ITSELF after login, not the editor. Defaults to '' (editor).
 */
export async function loadProjectSnapshot(
  projectId: string,
  returnPathSuffix = '',
): Promise<ProjectLoadResult> {
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
  if (!session) {
    return { status: 'unauthenticated', loginUrl: await buildLoginUrl(projectId, returnPathSuffix) };
  }

  // Scope is derived from the SERVER session only. No active workspace ->
  // treat as unauthenticated (bounce to login), never guess a workspace.
  const scopeResult = resolveActiveScope(session);
  if (!scopeResult.ok) {
    return { status: 'unauthenticated', loginUrl: await buildLoginUrl(projectId, returnPathSuffix) };
  }

  try {
    // workspace_id is in loadProject's where-clause: a cross-workspace id throws
    // SiteNotFoundError here, indistinguishable from a missing site, so a
    // foreign tenant's existence never leaks and its project is never rendered.
    const project = await getSiteRepository().loadProject(
      scopeResult.scope,
      projectId,
    );
    const snapshot = getSnapshot(project) as ProjectSnapshotOut;
    return { status: 'ok', snapshot };
  } catch (err) {
    if (err instanceof SiteNotFoundError) return { status: 'not_found' };
    // Any other failure is a genuine 500 — do not swallow it into a 404.
    throw err;
  }
}
