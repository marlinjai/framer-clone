// src/app/api/projects/[projectId]/branch/answers/route.ts
//
// POST: store conflict answers on a site branch without bringing main in (docs/plans/2026-11-10-site-branches.md,
// slice S5, decision 52). The review saves each answer as it is given; Update applies them. Answers the review.
// `editSite`: conflicts are settled on the branch, by whoever may edit it. A viewer reads the review only.

import { z } from 'zod';
import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { getSiteBranchMergeService } from '@/server/sites/branches/merge';
import { resolutionsSchema, reviewRoute, tokenSchema } from '@/server/sites/branches/reviewRoute';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withAuthAvailability(
  reviewRoute({
    answers: true,
    action: 'editSite',
    what: 'saving the answers',
    body: z.object({ token: tokenSchema, resolutions: resolutionsSchema }),
    run: ({ scope, branchId, body }) => getSiteBranchMergeService().answer(scope, branchId, body),
  }),
);
