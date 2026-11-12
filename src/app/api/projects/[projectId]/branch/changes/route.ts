// src/app/api/projects/[projectId]/branch/changes/route.ts
//
// GET /api/projects/<branchId>/branch/changes (viewSite) -> the review of a branch
// (docs/plans/2026-11-10-site-branches.md, section 6): what the branch changed, what main changed meanwhile,
// the conflicts of bringing main in with the answers given so far, whether the result is a valid site, and a
// `token` over the versions it was computed from. Computed on request, never stored.
//
// GET ...?ifState=<state> : `state` is the key a review carries over everything it was computed from. When it is
// still current the answer is `{ current: true, state }`, from three small rows and without a document read.
// The review page asks this way every 30 seconds, so an open page costs a full computation only when
// something moved.
//
// A closed branch answers 410 `branch_closed`; a branch of another company, or missing, 404.
// Guards: src/server/sites/branches/routeGuard.ts.

import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { getSiteBranchMergeService } from '@/server/sites/branches/merge';
import { reviewRoute } from '@/server/sites/branches/reviewRoute';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuthAvailability(
  reviewRoute({
    action: 'viewSite',
    what: 'reading the review',
    run: ({ scope, branchId, query }) => {
      const ifState = query.get('ifState');
      // A key is 32 characters; anything else is no key and gets the review.
      return getSiteBranchMergeService().changes(scope, branchId, ifState && ifState.length <= 64 ? ifState : undefined);
    },
  }),
);
