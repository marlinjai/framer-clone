// src/lib/ai/review/jobs.ts
//
// The layout review's runs (src/lib/ai/jobRegistry.ts): a review keeps running
// when the phone switches apps, and the editor collects it through
// GET /api/ai/review-page/[id].

import { createJobRegistry, type JobRegistry } from '@/lib/ai/jobRegistry';
import type { ReviewErrorPayload, ReviewProgress, ReviewResultPayload } from './protocol';

export type ReviewJobs = JobRegistry<ReviewProgress, ReviewResultPayload, ReviewErrorPayload>;

let _jobs: ReviewJobs | null = null;

export function getReviewJobs(): ReviewJobs {
  if (!_jobs) _jobs = createJobRegistry();
  return _jobs;
}

/** Test-only: start from an empty registry. */
export function __resetReviewJobsForTests(): void {
  _jobs = null;
}
