// src/app/api/ai/generate-page/[id]/route.ts
//
// GET    /api/ai/generate-page/:id  -> the run's state or outcome
// DELETE /api/ai/generate-page/:id  -> stop the run
//
// How the editor collects a generation it lost the stream of (the phone went
// to another app, iOS reloaded the tab) and how it cancels one: a dropped
// connection no longer stops a generation, only this DELETE does. Contract in
// src/lib/ai/jobRoute.ts.

import { jobRouteHandlers } from '@/lib/ai/jobRoute';
import { getPageGenJobs } from '@/lib/ai/pageGen/jobs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const { GET, DELETE } = jobRouteHandlers(getPageGenJobs);
