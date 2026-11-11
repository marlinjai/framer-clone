// src/app/api/projects/[projectId]/branch/send-back/route.ts
//
// POST /api/projects/<branchId>/branch/send-back { token, note } (reviewBranch) -> { branch }
// (docs/plans/2026-11-10-site-branches.md, section 7): sets the branch back to open with the reviewer's note
// and withdraws any approval. 409 `branch_review_stale` when the token no longer matches, 410 `branch_closed`
// after a merge or discard.
// Guards: src/server/sites/branches/routeGuard.ts.

import { z } from 'zod';
import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { getSiteBranchMergeService } from '@/server/sites/branches/merge';
import { noteSchema, reviewRoute, tokenSchema } from '@/server/sites/branches/reviewRoute';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withAuthAvailability(
  reviewRoute({
    action: 'reviewBranch',
    what: 'sending back',
    body: z.object({ token: tokenSchema, note: noteSchema }),
    run: async ({ scope, branchId, actor, body }) => ({ branch: await getSiteBranchMergeService().sendBack(scope, branchId, body, actor) }),
  }),
);
