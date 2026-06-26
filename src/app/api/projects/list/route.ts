// src/app/api/projects/list/route.ts
//
// GET /api/projects/list  (READ, session-guarded via auth-brain)
//
// Lists the sites the caller can see — the data behind the TopBar workspace
// switcher's client fetch. A valid session is required (account-level guard:
// authenticateAccountRequest), but the per-row isolation is NOT done by the
// guard; it is done by deriving the TenantScope from the SERVER-VERIFIED
// session and scoping the query to that workspace. The client can only ever
// read sites in a workspace its session actually contains.
//
// Workspace selection: an optional `?workspace=<id>` re-scopes via
// resolveScopeForWorkspace (membership-checked — a workspace not in the session
// is a 403, never a silent fallback to another workspace). With no param we use
// the session's active workspace (resolveActiveScope), mirroring the dashboard.
//
// Failures surface as the Track-0 `{ error: { code, message } }` envelope: 401
// unauthenticated, 403 no resolvable / non-member workspace, 500 otherwise.
//
// Node runtime because the repository reaches Postgres through adapter-prisma.

import {
  authenticateAccountRequest,
  getVerifiedSession,
} from '@/lib/auth-api';
import {
  getSiteRepository,
  resolveActiveScope,
  resolveScopeForWorkspace,
} from '@/server/sites';
import { jsonError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  // 1. Session-only guard: no valid session -> 401.
  const auth = await authenticateAccountRequest(req);
  if (!auth.authenticated) {
    return jsonError('unauthorized', auth.error, auth.status);
  }

  // 2. The full verified session is the ONLY source of the tenant scope below.
  const session = await getVerifiedSession(req);
  if (!session) {
    return jsonError('unauthorized', 'authentication required', 401);
  }

  // 3. Resolve scope: an explicit, membership-checked workspace when asked for,
  //    else the session's active workspace. Either way the scope is derived
  //    server-side and never trusted from the client.
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get('workspace');
  const scopeResult = workspaceId
    ? resolveScopeForWorkspace(session, workspaceId)
    : resolveActiveScope(session);
  if (!scopeResult.ok) {
    return jsonError(
      'no_active_workspace',
      'no resolvable workspace for this session',
      403,
    );
  }

  try {
    const sites = await getSiteRepository().listSites(scopeResult.scope);
    return Response.json({ sites });
  } catch (err) {
    return jsonError(
      'list_failed',
      err instanceof Error ? err.message : 'failed to list sites',
      500,
    );
  }
}
