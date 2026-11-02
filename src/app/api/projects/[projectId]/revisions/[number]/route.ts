// src/app/api/projects/[projectId]/revisions/[number]/route.ts
//
// GET /api/projects/<projectId>/revisions/<number>   the publish warnings for one
//     published version (missing Impressum, placeholders), which the Published
//     versions dialog shows before making it live (viewSite). A warning, never a
//     gate. Checked on the frozen version, not on the editor's draft.
//
// Guarded like the list beside it (src/server/domains/guard.ts). A number that
// could not be a version answers the same 404 as one this site does not have.

import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { jsonError } from '@/lib/api/respond';
import { authorizeDomainProject } from '@/server/domains/guard';
import {
  getSiteRepository,
  siteRepositoryErrorResponse,
  SiteRepositoryError,
  SiteRevisionNotFoundError,
} from '@/server/sites';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ projectId: string; number: string }> };

const MAX_REVISION_NUMBER = 2147483647;

async function handleGET(req: Request, { params }: Ctx): Promise<Response> {
  const { projectId, number: raw } = await params;
  const auth = await authorizeDomainProject(req, projectId, 'viewSite');
  if (!auth.ok) return auth.response;

  const { id, workspaceId, tenantGroupId } = auth.project;
  const number = /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : 0;
  if (number < 1 || number > MAX_REVISION_NUMBER) {
    return siteRepositoryErrorResponse(new SiteRevisionNotFoundError(id, number));
  }
  try {
    const check = await getSiteRepository().checkRevision({ workspaceId, tenantGroupId }, id, number);
    return Response.json({ number, check }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    if (err instanceof SiteRepositoryError) return siteRepositoryErrorResponse(err);
    return jsonError(
      'revision_check_failed',
      err instanceof Error ? err.message : 'failed to check this version',
      500,
    );
  }
}

export const GET = withAuthAvailability(handleGET);
