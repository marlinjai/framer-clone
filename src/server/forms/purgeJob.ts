import 'server-only';

// src/server/forms/purgeJob.ts
//
// The durable cleanup of a deleted project's form submissions (src/server/forms/purge.ts says why and how): a job written
// BEFORE the project is deleted, payload the site id only, that removes the submissions once the site row is gone, retries
// without ever giving up on a transient error (a busy email row and any other failure are retries; only a corrupt job dies, and the
// dead-jobs monitor covers that), and does nothing if the delete never happened.

import { z } from 'zod';

import { defineJobKind } from '@/server/commerce/jobs/types';

export const FORM_PURGE_JOB_KIND = 'form_purge';

export const formPurgeKind = defineJobKind({
  policy: {
    deadlineMs: 60 * 1000,
    backoffMinutes: [1, 5, 15, 60],
    laterMinutes: 6 * 60,
    // Never dies on a transient error: the data must go.
    giveUpAfterMs: null,
  },
  payload: z.object({ siteId: z.string().min(1).max(200), workspaceId: z.string().min(1).max(200) }).strict(),
  async run({ forms, payload: { siteId, workspaceId } }) {
    await forms.purgeSite(siteId, workspaceId);
  },
});
