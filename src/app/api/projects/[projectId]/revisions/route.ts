// src/app/api/projects/[projectId]/revisions/route.ts
//
// GET  /api/projects/<projectId>/revisions   the site's published versions,
//      newest first, without their documents (viewSite)
// POST /api/projects/<projectId>/revisions   { number } -> make that version
//      live again (publishSite, the same gate as publish)
//
// Rollback moves the pointer visitors are served from and changes nothing else:
// the editor's working copy stays as it is, so the next Publish publishes that.
// Plan: docs/plans/2026-11-01-immutable-published-copy.md.
//
// Guarded like every per-project editor route (src/server/domains/guard.ts):
// editor host only (404 elsewhere), a verified session (401), the project's
// workspace in a company with the `sites` grant plus the permission (403),
// auth-brain or OpenFGA outages as 503. Failures surface as the Track-0
// `{ error: { code, message } }` envelope: 400 malformed body, 404 unknown
// version, 500 otherwise.

import { z } from 'zod';
import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { jsonError, parseBody } from '@/lib/api/respond';
import { authorizeDomainProject } from '@/server/domains/guard';
import {
  getSiteRepository,
  siteRepositoryErrorResponse,
  SiteRepositoryError,
} from '@/server/sites';
import {
  revalidateCustomHostsForSiteId,
  revalidateSiteCache,
} from '@/server/sites/cachedResolver';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ projectId: string }> };

// The column is a 32 bit integer: a larger number could not be a version.
const rollbackBodySchema = z.object({ number: z.number().int().positive().max(2147483647) });

async function handleGET(req: Request, { params }: Ctx): Promise<Response> {
  const { projectId } = await params;
  const auth = await authorizeDomainProject(req, projectId, 'viewSite');
  if (!auth.ok) return auth.response;

  const { id, workspaceId, tenantGroupId } = auth.project;
  try {
    const list = await getSiteRepository().listRevisions({ workspaceId, tenantGroupId }, id);
    return Response.json(list, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    if (err instanceof SiteRepositoryError) return siteRepositoryErrorResponse(err);
    return jsonError(
      'revisions_failed',
      err instanceof Error ? err.message : 'failed to list published versions',
      500,
    );
  }
}

async function handlePOST(req: Request, { params }: Ctx): Promise<Response> {
  const { projectId } = await params;
  const auth = await authorizeDomainProject(req, projectId, 'publishSite');
  if (!auth.ok) return auth.response;

  const body = await parseBody(req, rollbackBodySchema);
  if (!body.ok) return body.response;

  const { id, workspaceId, tenantGroupId } = auth.project;
  const scope = { workspaceId, tenantGroupId };
  const { number } = body.data;
  try {
    const repo = getSiteRepository();
    await repo.rollbackToRevision(scope, id, number);
    // Idempotent, so a site unpublished before the rollback gets its address back too.
    const { subdomain } = await repo.ensureSiteDomain(scope, id);
    revalidateSiteCache(subdomain);
    // Cached custom-host hits never expire on their own, so a failure here would
    // leave the bad version live on the custom domains. A rollback is idempotent:
    // surface the failure so the caller retries, as unpublish does.
    await revalidateCustomHostsForSiteId(id);
  } catch (err) {
    if (err instanceof SiteRepositoryError) return siteRepositoryErrorResponse(err);
    return jsonError(
      'rollback_failed',
      err instanceof Error ? err.message : 'failed to make this version live',
      500,
    );
  }
  return Response.json({ siteId: id, status: 'published', live: number });
}

// An auth-brain outage during session verify answers JSON 503 `auth_unavailable`,
// and OpenFGA failing a permission check answers JSON 503 `authz_unavailable`
// (src/lib/authBrainAvailability.ts), never a 500 and never "signed out".
export const GET = withAuthAvailability(handleGET);
export const POST = withAuthAvailability(handlePOST);
