// src/app/api/projects/[projectId]/branches/[branchId]/undo-merge/route.ts
//
// Site branches (docs/plans/2026-11-10-site-branches.md, section 6, slice S7).
//
// POST /api/projects/<mainId>/branches/<branchId>/undo-merge (mergeBranch)
//   -> { undone, branch, merged, mainVersion }
//
// Undoes the site's latest merge: the site goes back to what it was just before `branchId` was merged, as a new
// version, and what the site holds now (the merged work and anything changed since) becomes a new open branch,
// `branch`, based on that earlier copy. Nothing is published. A second request for the same merge answers the
// first result (`undone: false`). 409 `merge_undo_unavailable` when the branch was not merged, the 30 days ran
// out or a later merge replaced the kept copy; 409 `branch_limit` when the site is at its limit of open branches.
// Nothing is written by a refused request.
//
// Guards: src/server/sites/branches/routeGuard.ts (editor host, session, active company, the per-company switch,
// the permission); a site or branch of another company answers the same 404 as a missing one.

import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { jsonError } from '@/lib/api/respond';
import { SiteRepositoryError, siteRepositoryErrorResponse } from '@/server/sites';
import { getSiteBranchMergeService } from '@/server/sites/branches/merge';
import { guardBranchRoute } from '@/server/sites/branches/routeGuard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ projectId: string; branchId: string }> };

async function handlePOST(req: Request, { params }: Ctx): Promise<Response> {
  const guarded = await guardBranchRoute(req, 'mergeBranch');
  if (!guarded.ok) return guarded.response;
  const { projectId, branchId } = await params;
  try {
    const outcome = await getSiteBranchMergeService().undoMerge(guarded.scope, projectId, branchId, { kind: 'user', id: guarded.userId });
    return Response.json(outcome, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    if (err instanceof SiteRepositoryError) return siteRepositoryErrorResponse(err);
    console.error(`[branches] undoing the merge of ${branchId} into ${projectId} failed:`, err);
    return jsonError('merge_undo_failed', 'undoing the merge failed; nothing was changed, try again', 500);
  }
}

export const POST = withAuthAvailability(handlePOST);
