import 'server-only';

// src/server/domains/guard.ts
//
// The authorization gate for the editor's custom-domain routes
// (/api/projects/<projectId>/domains/*). The same chain as every other
// per-project editor route (src/server/commerce/editorTenant.ts):
//
//   0. the request must be on the EDITOR host               -> else 404 not_found
//      (the published plane never reads a session, decision D2; the
//      middleware already refuses /api/projects/* on a published host, this is
//      the defense in depth, before the session is even read)
//   1. a verified auth-brain session                         -> else 401
//      (auth-brain not answering                -> 503 auth_unavailable)
//   2. the project (site row) is looked up by id
//   3. the project's workspace must be the editor workspace of one of the
//      session's companies holding the `sites` app grant, and the session's
//      tenant group for it must be the site's                -> else 403
//   4. the auth-brain permission on that workspace: `viewSite` to read,
//      `manageDomain` (workspace admin) to change            -> else 403
//      (OpenFGA not answering                   -> 503 authz_unavailable)
//   An unknown project answers the same 403 as a foreign one, so a project's
//   existence never leaks.

import type { FramerAction } from '@/lib/permissions';
import { jsonError } from '@/lib/api/respond';
import { getVerifiedSession } from '@/lib/auth-api';
import { checkWorkspaceAccess } from '@/lib/auth-check';
import {
  AuthUnavailableError,
  AuthzUnavailableError,
  authUnavailableResponse,
  authzUnavailableResponse,
} from '@/lib/authBrainAvailability';
import { isEditorHost } from '@/lib/editorHost';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '@/server/db';
import { resolveScopeForCompanyWorkspace } from '@/server/sites/scope';

export interface DomainProject {
  id: string;
  workspaceId: string;
  tenantGroupId: string;
}

export type DomainProjectResult =
  | { ok: true; project: DomainProject }
  | { ok: false; response: Response };

function forbidden(): DomainProjectResult {
  return { ok: false, response: jsonError('forbidden', 'Forbidden', 403) };
}

export async function authorizeDomainProject(
  req: Request,
  projectId: string,
  action: Extract<FramerAction, 'viewSite' | 'manageDomain'>,
  prisma: PrismaClient = getPrismaClient(),
): Promise<DomainProjectResult> {
  if (!isEditorHost(req.headers.get('host'))) {
    return { ok: false, response: jsonError('not_found', 'not found', 404) };
  }

  let session: Awaited<ReturnType<typeof getVerifiedSession>> = null;
  try {
    session = await getVerifiedSession(req);
  } catch (err) {
    if (err instanceof AuthUnavailableError) {
      return { ok: false, response: authUnavailableResponse() };
    }
    session = null;
  }
  if (!session) {
    return { ok: false, response: jsonError('unauthorized', 'authentication required', 401) };
  }

  const site = await prisma.site.findUnique({
    where: { id: projectId },
    select: { id: true, workspaceId: true, tenantGroupId: true },
  });
  if (!site) return forbidden();

  const scope = resolveScopeForCompanyWorkspace(session, site.workspaceId);
  if (!scope.ok) return forbidden();
  // The site row must carry the tenant group the session itself names for its
  // workspace: a row stamped with a foreign group is never touched on the
  // strength of a workspace membership alone.
  if (scope.scope.tenantGroupId !== site.tenantGroupId) return forbidden();

  let allowed: boolean;
  try {
    allowed = await checkWorkspaceAccess(session.user.id, site.workspaceId, action);
  } catch (err) {
    if (err instanceof AuthzUnavailableError) {
      return { ok: false, response: authzUnavailableResponse() };
    }
    throw err;
  }
  if (!allowed) return forbidden();

  return { ok: true, project: site };
}
