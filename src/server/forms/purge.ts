import 'server-only';

// src/server/forms/purge.ts
//
// Removing the form submissions of a deleted project, durably (docs/plans/2026-10-23-published-site-essentials.md, "Form
// notification emails"). The site row (Prisma, `public`) and its submissions (the tenant schema) are two connections, so no
// transaction covers both, and a crash or a failure between the two used to leave visitors' words behind with nothing to
// remove them. The fix is a write-ahead intent: BEFORE the site row is deleted, a `form_purge` job is written in the tenant
// schema (`scheduleProjectSubmissionsPurge`), due a few minutes later. It survives a crash, a restart and any failure of the
// immediate cleanup, retries without ever giving up, and removes the submissions only when the site row is really gone, so a
// delete that was refused or never committed costs nothing (the job ends as a no-op).
//
// Tenant scope: the job's tenant is the tenant GROUP (the schema it deletes in), the handler is bound to that group's handle
// and refuses a job of another tenant, and every delete filters group, site AND the workspace the delete was made from (so a
// caller who names another workspace's site id can enqueue nothing that removes that workspace's rows).

import { randomUUID } from 'node:crypto';

import { isTenantGroupId } from '@marlinjai/tenant-db';
import type { PrismaClient } from '@prisma/client';
import type { Kysely } from 'kysely';

import type { CommerceDB } from '@/server/commerce/db-types';
import { commerceTenantDbChecked, isCommerceTenantNotProvisioned } from '@/server/commerce/db';
import { scheduleJob } from '@/server/commerce/jobs/schedule';
import { JobRefused, JobRetryLater } from '@/server/commerce/jobs/types';
import { getPrismaClient } from '@/server/db';
import { FORM_PURGE_JOB_KIND } from './purgeJob';
import { FormBusyError, deleteSiteSubmissions } from './repository';

/** How long after the delete starts the job first looks: past the delete itself and its own retries, so it is a backstop. */
export const PURGE_DELAY_MS = 10 * 60 * 1000;

/**
 * Write the intent to remove a project's submissions, before the project is deleted. A tenant group without a commerce
 * schema (a legacy site) has none: nothing is written. Any other failure throws, and the caller must not delete the project
 * then (nothing would remove its submissions).
 */
export async function scheduleProjectSubmissionsPurge(
  tenantGroupId: string,
  workspaceId: string,
  siteId: string,
  now: Date = new Date(),
  dbFor: (tenantGroupId: string) => Promise<Kysely<CommerceDB>> = (id) => commerceTenantDbChecked(id as never),
): Promise<void> {
  if (!isTenantGroupId(tenantGroupId)) return;
  let db: Kysely<CommerceDB>;
  try {
    db = await dbFor(tenantGroupId);
  } catch (err) {
    if (isCommerceTenantNotProvisioned(err)) return;
    throw err;
  }
  await db.transaction().execute(async (trx) => {
    await scheduleJob(trx, {
      tenantId: tenantGroupId,
      kind: FORM_PURGE_JOB_KIND,
      // One per delete attempt: an earlier attempt that was refused leaves a finished no-op job that must not swallow this one.
      dedupeKey: `formpurge:${siteId}:${randomUUID()}`,
      payload: { siteId, workspaceId },
      runAt: new Date(now.getTime() + PURGE_DELAY_MS),
      at: now,
    });
  });
}

/**
 * The job's work. The site row still there: the delete was refused or has not committed, so nothing is purged and the job
 * ends. The row gone: every submission of the site goes (their emails with them, by the foreign key). A submission whose email
 * is being sent right now is a retry, any other failure is a retry too (the error is logged), and nothing here ever dies.
 */
export async function purgeSiteSubmissions(
  group: { id: string; db: Kysely<CommerceDB> },
  jobTenantId: string,
  siteId: string,
  workspaceId: string,
  prisma: PrismaClient = getPrismaClient(),
): Promise<'kept' | 'purged'> {
  // The job is written in its own tenant group: a payload cannot point the purge at another group's schema.
  if (jobTenantId !== group.id) throw new JobRefused('tenant_mismatch');
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { id: true } });
  if (site) return 'kept';
  try {
    await deleteSiteSubmissions(group.db, { tenantId: group.id, siteId, workspaceId });
  } catch (err) {
    if (err instanceof FormBusyError) throw new JobRetryLater('an email of the project is being sent');
    console.error(`[forms] purging the submissions of deleted project ${siteId} failed, will retry:`, err);
    throw new JobRetryLater('purge_failed');
  }
  return 'purged';
}
