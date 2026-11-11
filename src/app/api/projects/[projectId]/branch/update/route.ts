// src/app/api/projects/[projectId]/branch/update/route.ts
//
// POST /api/projects/<branchId>/branch/update { token, resolutions? } (editSite) -> { updated, branch, token }
// (docs/plans/2026-11-10-site-branches.md, section 6): brings main's changes into the branch. `resolutions`
// answers conflicts, by conflict id with the fingerprint the review showed; they are laid over the answers
// given before. Writes only when no conflict is left: otherwise 409 `branch_conflicts` with what is left (the
// answers that apply are kept), 422 `branch_merge_invalid` when the result would not be a valid site, 409
// `branch_review_stale` when the token no longer matches, 410 `branch_closed` after a merge or discard.
// Guards: src/server/sites/branches/routeGuard.ts.

import { z } from 'zod';
import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { getSiteBranchMergeService } from '@/server/sites/branches/merge';
import { resolutionsSchema, reviewRoute, tokenSchema } from '@/server/sites/branches/reviewRoute';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withAuthAvailability(
  reviewRoute({
    action: 'editSite',
    what: 'updating from main',
    body: z.object({ token: tokenSchema, resolutions: resolutionsSchema.optional() }),
    run: ({ scope, branchId, actor, body }) => getSiteBranchMergeService().update(scope, branchId, body, actor),
  }),
);
