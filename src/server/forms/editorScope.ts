import 'server-only';

// src/server/forms/editorScope.ts
//
// The guard of the editor's form submission routes
// (/api/projects/<projectId>/forms/submissions*). Submissions are personal data
// visitors sent, so reading them needs what editing the site needs: `editSite`
// (workspace admin), not `viewSite`. Otherwise the chain is the commerce
// editor read's (src/server/commerce/editorTenant.ts), first failure wins:
//
//   0. editor host only                         -> else 404 not_found
//   1. a verified auth-brain session            -> else 401 (503 when auth-brain
//                                                  does not answer)
//   2. the project exists and belongs to one of the session's companies with
//      the `sites` grant                        -> else 403 (a foreign project
//                                                  answers like a missing one)
//   3. `editSite` on that workspace             -> else 403 (503 when OpenFGA
//                                                  does not answer)
//   4. the session's tenant group for that workspace is the project's
//                                               -> else 403
//   5. the tenant group's schema exists         -> else 404 forms_not_provisioned
//
// Nothing comes from the client except the project id in the path.

import { assertTenantGroupId, type TenantGroupId } from '@marlinjai/tenant-db';
import type { Kysely } from 'kysely';
import type { PrismaClient } from '@prisma/client';

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
import { getPrismaClient } from '@/server/db';
import { resolveScopeForCompanyWorkspace } from '@/server/sites/scope';
import { commerceTenantDbChecked, isCommerceTenantNotProvisioned } from '@/server/commerce/db';
import type { CommerceDB } from '@/server/commerce/db-types';
import { isTenantSchemaError, resolveTenantGroupForSite } from '@/server/commerce/tenant';

export interface EditorFormsScope {
  db: Kysely<CommerceDB>;
  tenantGroupId: TenantGroupId;
  siteId: string;
  workspaceId: string;
}

export type EditorFormsContext = { ok: true; scope: EditorFormsScope } | { ok: false; response: Response };

const forbidden = (): EditorFormsContext => ({ ok: false, response: jsonError('forbidden', 'Forbidden', 403) });

export async function resolveEditorForms(
  req: Request,
  projectId: string,
  prisma: PrismaClient = getPrismaClient(),
): Promise<EditorFormsContext> {
  if (!isEditorHost(req.headers.get('host'))) {
    return { ok: false, response: jsonError('not_found', 'not found', 404) };
  }

  let session: Awaited<ReturnType<typeof getVerifiedSession>> = null;
  try {
    session = await getVerifiedSession(req);
  } catch (err) {
    if (err instanceof AuthUnavailableError) return { ok: false, response: authUnavailableResponse() };
    session = null;
  }
  if (!session) return { ok: false, response: jsonError('unauthorized', 'authentication required', 401) };

  const site = await prisma.site.findUnique({
    where: { id: projectId },
    select: { id: true, workspaceId: true, tenantGroupId: true },
  });
  if (!site) return forbidden();

  const scope = resolveScopeForCompanyWorkspace(session, site.workspaceId);
  if (!scope.ok) return forbidden();

  let allowed: boolean;
  try {
    allowed = await checkWorkspaceAccess(session.user.id, site.workspaceId, 'editSite');
  } catch (err) {
    if (err instanceof AuthzUnavailableError) return { ok: false, response: authzUnavailableResponse() };
    throw err;
  }
  if (!allowed) return forbidden();

  const notProvisioned: EditorFormsContext = {
    ok: false,
    response: jsonError('forms_not_provisioned', 'form submissions are not available for this project', 404),
  };

  let tenantGroupId: TenantGroupId;
  try {
    tenantGroupId = resolveTenantGroupForSite(site);
  } catch (err) {
    if (isTenantSchemaError(err)) return notProvisioned;
    throw err;
  }
  let sessionGroup: TenantGroupId;
  try {
    sessionGroup = assertTenantGroupId(scope.scope.tenantGroupId);
  } catch {
    return forbidden();
  }
  if (tenantGroupId !== sessionGroup) return forbidden();

  try {
    const db = await commerceTenantDbChecked(tenantGroupId);
    return { ok: true, scope: { db, tenantGroupId, siteId: site.id, workspaceId: site.workspaceId } };
  } catch (err) {
    if (isCommerceTenantNotProvisioned(err)) {
      console.error(`[forms] project ${projectId}: ${(err as Error).message}`);
      return notProvisioned;
    }
    throw err;
  }
}
