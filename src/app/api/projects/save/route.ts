// src/app/api/projects/save/route.ts
//
// POST /api/projects/save  (WRITE, admin-guarded via auth-brain `editSite`)
//
// The NON-DESTRUCTIVE persistence path. It serializes the editor's live
// ProjectModel (sent as a snapshot in the body) into the canonical Site +
// SitePage rows via the P1 site repository — and STOPS there. Unlike
// /api/projects/publish, it NEVER transitions the Site status: saveProject
// preserves `Site.status` on update, so saving a draft keeps it draft and
// saving a published site keeps it published. This is the path that lets a
// loaded real project be edited and persisted without going live.
//
// HARD ISOLATION (the whole point of P1): the TenantScope this writes under is
// resolved from the SERVER-VERIFIED auth-brain session (the session's active
// company -> its workspace -> tenant_group), NEVER from anything the client
// sends. The client supplies only the project snapshot; which workspace/tenant
// it lands in is the server's decision. Authorization is the real auth-brain
// `editSite` permission (workspace.admin), not the interim admin-secret stub.
//
// Failures surface loudly as the Track-0 `{ error: { code, message } }`
// envelope: 401 unauthenticated, 403 not a workspace admin / no resolvable
// company (`no_active_company`) / no company with Sites (`sites_not_enabled`), 400 malformed body, 404 cross-workspace site id, 500 otherwise. A
// save failure is never swallowed into a silent success.
//
// Runs on the Node runtime because the repository reaches Postgres through
// adapter-prisma.

import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { readCompanySelectors } from '@/lib/activeCompanyCookie';
import { getVerifiedSession, authenticateRequest } from '@/lib/auth-api';
import {
  getSiteRepository,
  activeScopeDenial,
  resolveActiveScope,
  siteRepositoryErrorResponse,
  SiteRepositoryError,
} from '@/server/sites';
import type { ProjectSnapshotOut } from '@/models/ProjectModel';
import { jsonError, parseBody, PROJECT_BODY_MAX_BYTES } from '@/lib/api/respond';
import { projectBodySchema as saveBodySchema } from '../_schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handlePOST(req: Request): Promise<Response> {
  // 1. The verified session. No valid session -> 401. This is also the ONLY
  //    source of the tenant scope below.
  const session = await getVerifiedSession(req);
  if (!session) {
    return jsonError('unauthorized', 'authentication required', 401);
  }

  // 2. Resolve the tenant scope from the request's active company (the
  //    `framer_company` selector, else the session's active_tenant, else its
  //    only company; only companies with the `sites` grant count), mapped to
  //    that company's workspace. No granted company -> 403 `sites_not_enabled`;
  //    none resolvable -> 403 `no_active_company`. Nothing is saved.
  const scopeResult = resolveActiveScope(session, readCompanySelectors(req));
  if (!scopeResult.ok) {
    const denial = activeScopeDenial(scopeResult.error);
    return jsonError(denial.code, denial.message, 403);
  }
  const { scope, companyId } = scopeResult;

  // 3. Admin guard: the real auth-brain `editSite` permission (workspace.admin)
  //    on the resolved workspace. 401 (no session) / 403 (not an admin).
  const auth = await authenticateRequest(req, scope.workspaceId, 'editSite');
  if (!auth.authenticated) {
    return jsonError(
      auth.status === 401 ? 'unauthorized' : 'forbidden',
      auth.error,
      auth.status,
    );
  }

  // 4. Validate the snapshot body. Malformed -> 400.
  const body = await parseBody(req, saveBodySchema, { maxBytes: PROJECT_BODY_MAX_BYTES });
  if (!body.ok) return body.response;

  // 5. Persist the snapshot — and ONLY that. saveProject preserves the site's
  //    status, so this never publishes. A cross-workspace site id is rejected
  //    (SiteNotFoundError -> 404) inside the repository; any other failure is a
  //    loud 500.
  const project = body.data.project as unknown as ProjectSnapshotOut;
  try {
    const repo = getSiteRepository();
    await repo.saveProject(scope, project, { mustExist: true, companyId });
  } catch (err) {
    if (err instanceof SiteRepositoryError) return siteRepositoryErrorResponse(err);
    return jsonError(
      'save_failed',
      err instanceof Error ? err.message : 'failed to save site',
      500,
    );
  }

  const savedPages = Object.values(body.data.project.pages).map(
    (page) => page.slug ?? '',
  );
  return Response.json({
    siteId: project.id,
    savedPages,
  });
}

// An auth-brain outage during session verify answers JSON 503 `auth_unavailable`,
// and OpenFGA failing a permission check answers JSON 503 `authz_unavailable`
// (src/lib/authBrainAvailability.ts), never a 500 and never "signed out".
export const POST = withAuthAvailability(handlePOST);
