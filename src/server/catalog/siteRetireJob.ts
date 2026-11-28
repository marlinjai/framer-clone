import 'server-only';

// src/server/catalog/siteRetireJob.ts
//
// The durable retirement of a deleted project's shop catalogue (src/server/catalog/siteRetire.ts says why and how): a job
// written BEFORE the project is deleted, in the company's name (the job's tenant is the company whose catalogue it is), payload
// the site id only, that retires the site's products and collections once the site row is gone, retries without ever giving up
// on a transient error, and does nothing if the delete never happened.

import { z } from 'zod';

import { defineJobKind } from '@/server/commerce/jobs/types';

export const CATALOGUE_RETIRE_JOB_KIND = 'catalogue_retire';

export const catalogueRetireKind = defineJobKind({
  policy: {
    deadlineMs: 60 * 1000,
    backoffMinutes: [1, 5, 15, 60],
    laterMinutes: 6 * 60,
    // Never dies on a transient error: a deleted shop's products must not stay sellable or block their SKUs.
    giveUpAfterMs: null,
  },
  payload: z.object({ siteId: z.string().min(1).max(100), notAfter: z.string().max(40).optional() }).strict(),
  async run({ catalogue, payload: { siteId, notAfter } }) {
    await catalogue.retireSite(siteId, notAfter ?? null);
  },
});
