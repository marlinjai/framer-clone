// src/lib/ai/pageGen/jobs.ts
//
// The page generator's runs (src/lib/ai/jobRegistry.ts): a generation keeps
// running when the phone switches apps, and the editor collects it through
// GET /api/ai/generate-page/[id].

import { createJobRegistry, type JobRegistry } from '@/lib/ai/jobRegistry';
import type { PageGenErrorPayload, PageGenProgress, PageGenResultPayload } from './protocol';

export type PageGenJobs = JobRegistry<PageGenProgress, PageGenResultPayload, PageGenErrorPayload>;

let _jobs: PageGenJobs | null = null;

export function getPageGenJobs(): PageGenJobs {
  if (!_jobs) _jobs = createJobRegistry();
  return _jobs;
}

/** Test-only: start from an empty registry. */
export function __resetPageGenJobsForTests(): void {
  _jobs = null;
}
