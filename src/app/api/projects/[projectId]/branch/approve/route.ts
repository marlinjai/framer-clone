// src/app/api/projects/[projectId]/branch/approve/route.ts
//
// POST /api/projects/<branchId>/branch/approve { token } (reviewBranch) -> { branch }
// (docs/plans/2026-11-10-site-branches.md, section 7): approves the branch version the token names. A reviewer
// with only view rights may. Any later write to the branch withdraws it. 409 `branch_review_stale` when the
// token no longer matches, 410 `branch_closed` after a merge or discard.
// Guards: src/server/sites/branches/routeGuard.ts.

import { z } from 'zod';
import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { getSiteBranchMergeService } from '@/server/sites/branches/merge';
import { reviewRoute, tokenSchema } from '@/server/sites/branches/reviewRoute';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withAuthAvailability(
  reviewRoute({
    action: 'reviewBranch',
    what: 'approving',
    body: z.object({ token: tokenSchema }),
    run: async ({ scope, branchId, actor, body }) => ({ branch: await getSiteBranchMergeService().approve(scope, branchId, body, actor) }),
  }),
);
