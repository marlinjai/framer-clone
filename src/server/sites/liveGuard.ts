import 'server-only';

// src/server/sites/liveGuard.ts
//
// The guard of the live sync routes (plan docs/plans/2026-11-08-live-agent-canvas.md,
// section 1): GET /api/projects/<id>/events and GET /api/projects/<id>/document.
// Both hand the open editor what its save writes, so they take the save route's
// chain, plus the editor-host check of the per-project routes:
//   0. editor host only                              -> else 404 not_found
//   1. a verified auth-brain session cookie          -> else 401
//      (auth-brain not answering                     -> 503 auth_unavailable, thrown
//       for withAuthAvailability)
//   2. the request's active company with the `sites` grant, mapped to its
//      workspace                                     -> else 403
//      (no_active_company / sites_not_enabled)
//   3. `editSite` on that workspace                  -> else 403
//      (OpenFGA not answering                        -> 503 authz_unavailable, thrown)
//   4. the project in that workspace                 -> else 404 site_not_found
// A project of another company or workspace answers the same 404 as a missing
// one, so existence never leaks. This follows the save and rename routes (404),
// not the domain routes' shared guard (src/server/domains/guard.ts, 403 for both),
// because the editor that calls these already treats a 404 as "this project is gone".
//
// `EventSource` cannot set headers, so the session cookie is the only credential;
// the request is same-origin, so the browser sends it.

import type { SessionVerifyResponse } from '@marlinjai/auth-brain-sdk';
import { readCompanySelectors } from '@/lib/activeCompanyCookie';
import { getVerifiedSession } from '@/lib/auth-api';
import { checkWorkspaceAccess } from '@/lib/auth-check';
import { isEditorHost } from '@/lib/editorHost';
import { jsonError } from '@/lib/api/respond';
import { getSiteRepository, type SiteRepository } from './repository';
import { activeScopeDenial, resolveActiveScope } from './scope';
import { SiteNotFoundError } from './errors';
import type { TenantScope } from './repository';

export type LiveProjectResult =
  | { ok: true; scope: TenantScope; session: SessionVerifyResponse; version: number }
  | { ok: false; response: Response };

/**
 * Run the chain for a project. Throws AuthUnavailableError or AuthzUnavailableError
 * when auth-brain or OpenFGA cannot answer (the route's withAuthAvailability turns
 * them into a 503); every other refusal is a response.
 */
export async function authorizeLiveProject(
  req: Request,
  projectId: string,
  repository: SiteRepository = getSiteRepository(),
): Promise<LiveProjectResult> {
  if (!isEditorHost(req.headers.get('host'))) {
    return { ok: false, response: jsonError('not_found', 'not found', 404) };
  }
  const session = await getVerifiedSession(req);
  if (!session) return { ok: false, response: jsonError('unauthorized', 'authentication required', 401) };

  const scopeResult = resolveActiveScope(session, readCompanySelectors(req));
  if (!scopeResult.ok) {
    const denial = activeScopeDenial(scopeResult.error);
    return { ok: false, response: jsonError(denial.code, denial.message, 403) };
  }
  const { scope } = scopeResult;

  const allowed = await checkWorkspaceAccess(session.user.id, scope.workspaceId, 'editSite');
  if (!allowed) return { ok: false, response: jsonError('forbidden', 'Forbidden', 403) };

  try {
    const version = await repository.getSiteVersion(scope, projectId);
    return { ok: true, scope, session, version };
  } catch (err) {
    if (err instanceof SiteNotFoundError) {
      return { ok: false, response: jsonError('site_not_found', 'no such project', 404) };
    }
    throw err;
  }
}
