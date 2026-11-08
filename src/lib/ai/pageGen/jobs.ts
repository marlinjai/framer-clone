// src/lib/ai/pageGen/jobs.ts
//
// The page generator's runs (src/lib/ai/jobRegistry.ts): a generation keeps
// running when the phone switches apps, and the editor collects it through
// GET /api/ai/generate-page/[id], preview sections included while it runs.

import { createJobRegistry, type JobRegistry } from '@/lib/ai/jobRegistry';
import type { PageGenErrorPayload, PageGenProgress, PageGenResultPayload, PageGenSection } from './protocol';

/** A running generation also keeps its preview sections, so a client that collects it rebuilds the draft. */
export type PageGenJobs = JobRegistry<PageGenProgress, PageGenResultPayload, PageGenErrorPayload, PageGenSection>;

let _jobs: PageGenJobs | null = null;

export function getPageGenJobs(): PageGenJobs {
  if (!_jobs) _jobs = createJobRegistry();
  return _jobs;
}

/** Test-only: start from an empty registry. */
export function __resetPageGenJobsForTests(): void {
  _jobs = null;
}
