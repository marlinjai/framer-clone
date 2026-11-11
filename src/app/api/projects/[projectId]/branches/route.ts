// src/app/api/projects/[projectId]/branches/route.ts
//
// Site branches (docs/plans/2026-11-10-site-branches.md, section 6).
//
// GET  /api/projects/<mainId>/branches                     (viewSite) -> { mainSiteId, mainVersion, open, closed }
// POST /api/projects/<mainId>/branches { name, branchId? } (editSite) -> 201 { branch } (200 for a retry)
//
// POST makes a branch: a hidden copy of the site's working copy as stored now (not of what is published), in one
// transaction under the site's row lock, with the site's version and document kept as the fork point. `branchId`
// (a UUID the caller chose) makes a retry after a lost answer safe: the same id from the same person answers the
// branch it made instead of a second one. A site has at most 10 open branches (409 `branch_limit`); a name is
// unique among them, compared without case (409 `branch_name_taken`). A branch id given as the site answers 409
// `site_is_branch`.
//
// Guards: src/server/sites/branches/routeGuard.ts (editor host, session, active company, the per-company switch,
// the permission); a site of another company answers the same 404 as a missing one.

import { z } from 'zod';
import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { jsonError, parseBody } from '@/lib/api/respond';
import { SiteRepositoryError, siteRepositoryErrorResponse } from '@/server/sites';
import { getSiteBranchRepository } from '@/server/sites/branches/repository';
import { guardBranchRoute } from '@/server/sites/branches/routeGuard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ projectId: string }> };

const createBodySchema = z.object({
  // Checked and cleaned by the repository (validateBranchName), so the message is the shared one.
  name: z.string().max(1_000),
  branchId: z.string().uuid().optional(),
});

const NO_STORE = { 'cache-control': 'no-store' } as const;

async function handleGET(req: Request, { params }: Ctx): Promise<Response> {
  const guarded = await guardBranchRoute(req, 'viewSite');
  if (!guarded.ok) return guarded.response;
  const { projectId } = await params;
  try {
    const list = await getSiteBranchRepository().listBranches(guarded.scope, projectId);
    return Response.json(list, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof SiteRepositoryError) return siteRepositoryErrorResponse(err);
    console.error(`[branches] listing the branches of ${projectId} failed:`, err);
    return jsonError('branches_failed', 'listing the branches failed, try again', 500);
  }
}

async function handlePOST(req: Request, { params }: Ctx): Promise<Response> {
  const guarded = await guardBranchRoute(req, 'editSite');
  if (!guarded.ok) return guarded.response;
  const body = await parseBody(req, createBodySchema);
  if (!body.ok) return body.response;
  const { projectId } = await params;
  try {
    const { branch, created } = await getSiteBranchRepository().createBranch(guarded.scope, projectId, {
      name: body.data.name,
      branchId: body.data.branchId,
      actor: { kind: 'user', id: guarded.userId },
    });
    return Response.json({ branch, created }, { status: created ? 201 : 200, headers: NO_STORE });
  } catch (err) {
    if (err instanceof SiteRepositoryError) return siteRepositoryErrorResponse(err);
    console.error(`[branches] creating a branch of ${projectId} failed:`, err);
    return jsonError('branch_create_failed', 'creating the branch failed; nothing was created, try again', 500);
  }
}

export const GET = withAuthAvailability(handleGET);
export const POST = withAuthAvailability(handlePOST);
