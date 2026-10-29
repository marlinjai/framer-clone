// src/app/api/ai/review-page/[id]/route.ts
//
// GET    /api/ai/review-page/:id  -> the review's state or outcome
// DELETE /api/ai/review-page/:id  -> stop the review
//
// How the editor collects a review it lost the stream of (the phone went to
// another app) and how it cancels one: a dropped connection no longer stops a
// review, only this DELETE does. Contract in src/lib/ai/jobRoute.ts.

import { jobRouteHandlers } from '@/lib/ai/jobRoute';
import { getReviewJobs } from '@/lib/ai/review/jobs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const { GET, DELETE } = jobRouteHandlers(getReviewJobs);
