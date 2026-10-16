import 'server-only';

// src/server/commerce/editorTenant.ts
//
// The EDITOR edge of commerce tenancy (CM-10 follow-up). The editor and its
// preview are not published storefronts: they run on the editor host (or
// localhost in dev), so the host-resolved storefront routes cannot serve them.
// They read through /api/projects/<projectId>/commerce/*, and this module
// decides the tenant for those requests:
//
//   1. a verified auth-brain session is required          -> else 401 unauthorized
//   2. the project (site row) is looked up by id
//   3. the session must contain the project's workspace AND hold `viewSite`
//      on it (the same auth-brain check every other project route uses)
//                                                          -> else 403 forbidden
//      An unknown project id answers the SAME 403, so a project's existence
//      never leaks to someone who cannot see it.
//   4. the project's site must carry a valid tenant group  -> else 404
//      commerce_not_provisioned (fail closed, no shared-schema fallback)
//   5. that tenant group must be the one the session itself says the workspace
//      belongs to                                          -> else 403 forbidden
//      (a site row stamped with a foreign tenant group is never read on the
//      strength of a workspace membership alone)
//   6. reads run on commerceTenantDbChecked(site.tenantGroupId), THAT project's
//      schema (the startup backstop runs once before the first commerce use).
//
// This plane is separate from the storefront plane on purpose: the storefront
// routes never read a session (D2), and these routes never trust a host.

import type { TenantGroupId } from '@marlinjai/tenant-db';
import type { PrismaClient } from '@prisma/client';

import { jsonError } from '@/lib/api/respond';
import { getVerifiedSession } from '@/lib/auth-api';
import { checkWorkspaceAccess } from '@/lib/auth-check';
import { getPrismaClient } from '@/server/db';
import { resolveScopeForWorkspace } from '@/server/sites/scope';
import { commerceTenantDbChecked } from './db';
import type { CommerceReadContext } from './readHandlers';
import { COMMERCE_NOT_PROVISIONED } from './storefrontTenant';
import { isTenantSchemaError, resolveTenantGroupForSite } from './tenant';

function forbidden(): CommerceReadContext {
  return { ok: false, response: jsonError('forbidden', 'Forbidden', 403) };
}

/**
 * Resolve the commerce read context for an editor request on `projectId`.
 * Returns the project's scoped handle, or the ready 401 / 403 / 404 response.
 * A failure other than an auth or tenant decision (database down) THROWS so the
 * shared read handler surfaces it as its 500 envelope.
 */
export async function resolveEditorCommerce(
  req: Request,
  projectId: string,
  prisma: PrismaClient = getPrismaClient(),
): Promise<CommerceReadContext> {
  let session: Awaited<ReturnType<typeof getVerifiedSession>> = null;
  try {
    session = await getVerifiedSession(req);
  } catch {
    // Fail closed: a verify that throws is treated as no session.
    session = null;
  }
  if (!session) {
    return {
      ok: false,
      response: jsonError('unauthorized', 'authentication required', 401),
    };
  }

  const site = await prisma.site.findUnique({
    where: { id: projectId },
    select: { workspaceId: true, tenantGroupId: true },
  });
  if (!site) return forbidden();

  const scope = resolveScopeForWorkspace(session, site.workspaceId);
  if (!scope.ok) return forbidden();
  const allowed = await checkWorkspaceAccess(session.user.id, site.workspaceId, 'viewSite');
  if (!allowed) return forbidden();

  let tenantGroupId: TenantGroupId;
  try {
    tenantGroupId = resolveTenantGroupForSite(site);
  } catch (err) {
    if (isTenantSchemaError(err)) {
      return {
        ok: false,
        response: jsonError(
          COMMERCE_NOT_PROVISIONED,
          'commerce is not provisioned for this project',
          404,
        ),
      };
    }
    throw err;
  }

  if (tenantGroupId !== scope.scope.tenantGroupId.toLowerCase()) return forbidden();

  return { ok: true, db: await commerceTenantDbChecked(tenantGroupId) };
}
