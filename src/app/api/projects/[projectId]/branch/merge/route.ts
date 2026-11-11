// src/app/api/projects/[projectId]/branch/merge/route.ts
//
// POST /api/projects/<branchId>/branch/merge { token } (mergeBranch) -> { merged, branch, mainVersion }
// (docs/plans/2026-11-10-site-branches.md, sections 5 and 6): main becomes the branch's content in one new
// version of its working copy, never published by this. A branch behind main is updated from main instead and
// the merge stops there: 409 `branch_updated_from_main` (review it again) or 409 `branch_conflicts` (answers
// needed). A repeat on a merged branch answers the first merge's result with `merged: false`; a discarded one
// 410 `branch_closed`. 409 `branch_review_stale` when the token no longer matches, 422 `branch_merge_invalid`
// when the result would not be a valid site; either way nothing was written.
// Guards: src/server/sites/branches/routeGuard.ts.

import { z } from 'zod';
import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { getSiteBranchMergeService } from '@/server/sites/branches/merge';
import { reviewRoute, tokenSchema } from '@/server/sites/branches/reviewRoute';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withAuthAvailability(
  reviewRoute({
    action: 'mergeBranch',
    what: 'merging',
    body: z.object({ token: tokenSchema }),
    run: ({ scope, branchId, actor, body }) => getSiteBranchMergeService().merge(scope, branchId, body, actor),
  }),
);
