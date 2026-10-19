import 'server-only';

// src/server/commerce/editorTenant.ts
//
// The EDITOR edge of commerce tenancy (CM-10 follow-up). The editor and its
// preview are not published storefronts: they run on the editor host (or
// localhost in dev), so the host-resolved storefront routes cannot serve them.
// They read through /api/projects/<projectId>/commerce/*, and this module
// decides the tenant for those requests:
//
//   0. the request must be on the EDITOR host (src/lib/editorHost.ts)
//                                                          -> else 404 not_found
//   1. a verified auth-brain session is required          -> else 401 unauthorized
//   2. the project (site row) is looked up by id
//   3. the session must contain the project's workspace as the editor
//      workspace of one of its companies holding the auth-brain app grant
//      `sites` (the editor is per company and only for granted companies,
//      2026-10-19) AND hold `viewSite` on it (the same auth-brain check every
//      other project route uses)
//                                                          -> else 403 forbidden
//      (OpenFGA failing to answer that check     -> 503 authz_unavailable)
//      An unknown project id answers the SAME 403, so a project's existence
//      never leaks to someone who cannot see it.
//   4. the project's site must carry a valid tenant group whose tg_<id> schema
//      exists                                              -> else 404
//      commerce_not_provisioned (fail closed, no shared-schema fallback)
//   5. that tenant group must be the one the session itself says the workspace
//      belongs to (a missing / malformed session group id is also a deny)
//                                                          -> else 403 forbidden
//      (a site row stamped with a foreign tenant group is never read on the
//      strength of a workspace membership alone)
//   6. reads run on commerceTenantDbChecked(site.tenantGroupId), THAT project's
//      schema (the startup backstop runs once before the first commerce use).
//
// This plane is separate from the storefront plane on purpose: the storefront
// routes never read a session (D2), and these routes never trust a host.

import { assertTenantGroupId, type TenantGroupId } from '@marlinjai/tenant-db';
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
import { getPrismaClient } from '@/server/db';
import { resolveScopeForCompanyWorkspace } from '@/server/sites/scope';
import { commerceTenantDbChecked, isCommerceTenantNotProvisioned } from './db';
import { isEditorHost } from '@/lib/editorHost';
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
  // Editor plane ONLY. On a published storefront host this route must not run
  // at all (the middleware already refuses /api/projects/* there; this is the
  // defense in depth): the apex session the browser sends to a storefront host
  // must never authorize anything on the published plane (D2). 404, as if the
  // route did not exist on that host, BEFORE the session is even read.
  if (!isEditorHost(req.headers.get('host'))) {
    return { ok: false, response: jsonError('not_found', 'not found', 404) };
  }

  let session: Awaited<ReturnType<typeof getVerifiedSession>> = null;
  try {
    session = await getVerifiedSession(req);
  } catch (err) {
    // auth-brain could not answer: a JSON 503, never "signed out" (which would
    // send a signed-in user to the login during an outage).
    if (err instanceof AuthUnavailableError) {
      return { ok: false, response: authUnavailableResponse() };
    }
    // Any other throw fails closed as no session.
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

  // A company without the `sites` grant answers the same 403 as a foreign one.
  const scope = resolveScopeForCompanyWorkspace(session, site.workspaceId);
  if (!scope.ok) return forbidden();
  let allowed: boolean;
  try {
    allowed = await checkWorkspaceAccess(session.user.id, site.workspaceId, 'viewSite');
  } catch (err) {
    // OpenFGA could not answer (cause logged in permissions.can): a JSON 503
    // `authz_unavailable`, never a 403 that reads as a deny.
    if (err instanceof AuthzUnavailableError) {
      return { ok: false, response: authzUnavailableResponse() };
    }
    throw err;
  }
  if (!allowed) return forbidden();

  const notProvisioned: CommerceReadContext = {
    ok: false,
    response: jsonError(COMMERCE_NOT_PROVISIONED, 'commerce is not provisioned for this project', 404),
  };

  let tenantGroupId: TenantGroupId;
  try {
    tenantGroupId = resolveTenantGroupForSite(site);
  } catch (err) {
    if (isTenantSchemaError(err)) return notProvisioned;
    throw err;
  }

  // The session's own tenant group for this workspace must be a valid id AND
  // the site's group. A missing or malformed group_id on the session is a deny
  // (403), never a crash.
  let sessionGroup: TenantGroupId;
  try {
    sessionGroup = assertTenantGroupId(scope.scope.tenantGroupId);
  } catch {
    return forbidden();
  }
  if (tenantGroupId !== sessionGroup) return forbidden();

  try {
    return { ok: true, db: await commerceTenantDbChecked(tenantGroupId) };
  } catch (err) {
    // A valid tenant group whose tg_<id> schema does not exist.
    if (isCommerceTenantNotProvisioned(err)) {
      console.error(`[commerce] project ${projectId}: ${(err as Error).message}`);
      return notProvisioned;
    }
    throw err;
  }
}
