// src/app/api/projects/list/route.ts
//
// GET /api/projects/list  (READ, session-guarded via auth-brain)
//
// Lists the sites of the caller's active company. A valid session is required (account-level guard:
// authenticateAccountRequest), but the per-row isolation is NOT done by the
// guard; it is done by deriving the TenantScope from the SERVER-VERIFIED
// session and scoping the query to that workspace. The client can only ever
// read sites in a workspace its session actually contains.
//
// Scope selection: an optional `?workspace=<id>` re-scopes via
// resolveScopeForCompanyWorkspace (it must be the editor workspace of a company
// of the session holding the `sites` grant; anything else is a 403, never a
// silent fallback). With no param we use the request's active company
// (resolveActiveScope: the `framer_company` selector, else the session's
// active_tenant, else its only granted company), exactly like the dashboard.
//
// Failures surface as the Track-0 `{ error: { code, message } }` envelope: 401
// unauthenticated, 403 `sites_not_enabled` / `no_active_company`, 500 otherwise.
//
// Node runtime because the repository reaches Postgres through adapter-prisma.

import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { readCompanySelectors } from '@/lib/activeCompanyCookie';
import {
  authenticateAccountRequest,
  getVerifiedSession,
} from '@/lib/auth-api';
import {
  activeScopeDenial,
  getSiteRepository,
  resolveActiveScope,
  resolveScopeForCompanyWorkspace,
} from '@/server/sites';
import { jsonError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handleGET(req: Request): Promise<Response> {
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
  //    else the request's active workspace. Either way the scope is derived
  //    server-side and never trusted from the client.
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get('workspace');
  const scopeResult = workspaceId
    ? resolveScopeForCompanyWorkspace(session, workspaceId)
    : resolveActiveScope(session, readCompanySelectors(req));
  if (!scopeResult.ok) {
    const denial = activeScopeDenial(scopeResult.error);
    return jsonError(denial.code, denial.message, 403);
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

// An auth-brain outage during session verify answers JSON 503 `auth_unavailable`
// (src/lib/authBrainAvailability.ts), never a 500 and never "signed out".
export const GET = withAuthAvailability(handleGET);
