import 'server-only';

// src/server/sites/branches/routeGuard.ts
//
// The guard chain of every site branch route (plan docs/plans/2026-11-10-site-branches.md, section 6), the same
// as the project routes' (save, publish, rename), plus the per-company switch:
//   0. editor host only                                   -> else 404 not_found
//   1. a verified auth-brain session                      -> else 401
//      (auth-brain not answering                          -> 503 auth_unavailable, via withAuthAvailability)
//   2. the request's active company with the `sites` grant, mapped to its workspace -> else 403
//   3. site branches switched on for that company          -> else 404 not_found (as if the route did not exist)
//      (skipped for the two requests that only end something, `endsOnly`: discarding a branch and revoking its
//      public preview link. With the switch off a link is hidden, not gone, and would show again the day the
//      switch returns; a person who wants it gone must be able to end it, plan decision 86.)
//   4. the action's permission on that workspace           -> else 401/403
//      (OpenFGA not answering                             -> 503 authz_unavailable)
// The repository then resolves every id through that workspace: a site or branch of another company answers the
// same 404 as a missing one.

import { readCompanySelectors } from '@/lib/activeCompanyCookie';
import { authenticateRequest, getVerifiedSession } from '@/lib/auth-api';
import { isEditorHost } from '@/lib/editorHost';
import { jsonError } from '@/lib/api/respond';
import type { FramerAction } from '@/lib/permissions';
import { activeScopeDenial, resolveActiveScope } from '../scope';
import type { TenantScope } from '../repository';
import { siteBranchesEnabled } from './switch';

export type BranchGuardResult =
  | { ok: true; scope: TenantScope; companyId: string; userId: string }
  | { ok: false; response: Response };

export async function guardBranchRoute(
  req: Request,
  action: FramerAction,
  options: { endsOnly?: boolean } = {},
): Promise<BranchGuardResult> {
  if (!isEditorHost(req.headers.get('host'))) {
    return { ok: false, response: jsonError('not_found', 'not found', 404) };
  }
  const session = await getVerifiedSession(req);
  if (!session) {
    return { ok: false, response: jsonError('unauthorized', 'authentication required', 401) };
  }
  const scopeResult = resolveActiveScope(session, readCompanySelectors(req));
  if (!scopeResult.ok) {
    const denial = activeScopeDenial(scopeResult.error);
    return { ok: false, response: jsonError(denial.code, denial.message, 403) };
  }
  if (!options.endsOnly && !siteBranchesEnabled(scopeResult.companyId)) {
    return { ok: false, response: jsonError('not_found', 'not found', 404) };
  }
  const auth = await authenticateRequest(req, scopeResult.scope.workspaceId, action);
  if (!auth.authenticated) {
    return {
      ok: false,
      response: jsonError(auth.status === 401 ? 'unauthorized' : 'forbidden', auth.error, auth.status),
    };
  }
  return { ok: true, scope: scopeResult.scope, companyId: scopeResult.companyId, userId: auth.userId };
}
