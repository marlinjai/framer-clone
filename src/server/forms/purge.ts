import 'server-only';

// src/server/forms/purge.ts
//
// Removing the form submissions of a deleted project, durably (docs/plans/2026-10-23-published-site-essentials.md, "Form
// notification emails"). The site row (Prisma, `public`) and its submissions (the tenant schema) are two connections, so no
// transaction covers both, and a crash or a failure between the two used to leave visitors' words behind with nothing to
// remove them. The fix is a write-ahead intent: BEFORE the site row is deleted, a `form_purge` job is written in the tenant
// schema (`scheduleProjectSubmissionsPurge`), due ten minutes later. It survives a crash, a restart and any failure of the
// immediate cleanup, retries without ever giving up, and removes the submissions only when the site row is really gone, so a
// delete that was refused or never committed costs nothing (the job ends as a no-op).
//
// Tenant scope: the job's tenant is the tenant GROUP (the schema it deletes in), the handler is bound to that group's handle
// and refuses a job of another tenant, and every delete filters group, site AND the workspace the delete was made from (so a
// caller who names another workspace's site id can enqueue nothing that removes that workspace's rows).

import { isTenantGroupId } from '@marlinjai/tenant-db';
import type { PrismaClient } from '@prisma/client';
import type { Kysely } from 'kysely';

import type { CommerceDB } from '@/server/commerce/db-types';
import { commerceTenantDbChecked, isCommerceTenantNotProvisioned } from '@/server/commerce/db';
import { scheduleJob } from '@/server/commerce/jobs/schedule';
import { SITE_CLEANUP_DELAY_MS, SITE_CLEANUP_PATIENCE_MS, siteGoneOrLookAgain } from '@/server/commerce/jobs/siteGone';
import { JobRefused, JobRetryLater } from '@/server/commerce/jobs/types';
import { getPrismaClient } from '@/server/db';
import { CATALOGUE_RETIRE_JOB_KIND } from '@/server/catalog/siteRetireJob';
import { FORM_PURGE_JOB_KIND } from './purgeJob';
import { FormBusyError, deleteSiteSubmissions } from './repository';

/** A purge that has failed this many times in a row is no longer a busy email: a person should look (the first five retries span about an hour and a half). */
export const STUCK_PURGE_ATTEMPTS = 5;

/**
 * The cleanup jobs of deleted projects that keep failing, for the watchdog: the form purge and the catalogue retirement
 * (src/server/catalog/siteRetire.ts). No transient error kills them and they never give up (the data must go), so without this a
 * permanent fault (a permission or constraint error on the submissions or catalogue tables) would retry silently every six hours
 * and visitors' words, or a deleted shop's products, would stay with no alarm. A count, like the dead jobs.
 */
export async function countStuckPurges(db: Kysely<CommerceDB>): Promise<number> {
  const row = await db
    .selectFrom('commerce_job')
    .select((eb) => eb.fn.countAll<string>().as('jobs'))
    .where('kind', 'in', [FORM_PURGE_JOB_KIND, CATALOGUE_RETIRE_JOB_KIND])
    // Running included: a purge that keeps outliving its lease sits in `running` between claims.
    .where('status', 'in', ['pending', 'running'])
    .where('attempts', '>=', STUCK_PURGE_ATTEMPTS)
    .executeTakeFirstOrThrow();
  return Number(row.jobs);
}

/** How long past its first look a purge job keeps waiting for a delete that has not committed yet (a long lock wait on the site row). */
export const PURGE_PATIENCE_MS = SITE_CLEANUP_PATIENCE_MS;

const purgeJobKey = (siteId: string, workspaceId: string, at: Date) => `formpurge:${siteId}:${workspaceId}:${Math.floor(at.getTime() / PURGE_DELAY_MS)}`;

/** How long after the delete starts the job first looks: past the delete itself and its own retries, so it is a backstop. */
export const PURGE_DELAY_MS = SITE_CLEANUP_DELAY_MS;

/**
 * Write the intent to remove a project's submissions, before the project is deleted. A tenant group without a commerce
 * schema (a legacy site) has none: nothing is written and false is answered. True is the confirmation that a durable job now
 * exists; the caller may tell the owner that removal is pending only on that. Any other failure throws, and the caller must not
 * delete the project then (nothing would remove its submissions).
 */
export async function scheduleProjectSubmissionsPurge(
  tenantGroupId: string,
  workspaceId: string,
  siteId: string,
  now: Date = new Date(),
  dbFor: (tenantGroupId: string) => Promise<Kysely<CommerceDB>> = (id) => commerceTenantDbChecked(id as never),
): Promise<boolean> {
  if (!isTenantGroupId(tenantGroupId)) return false;
  let db: Kysely<CommerceDB>;
  try {
    db = await dbFor(tenantGroupId);
  } catch (err) {
    if (isCommerceTenantNotProvisioned(err)) return false;
    throw err;
  }
  await db.transaction().execute(async (trx) => {
    await scheduleJob(trx, {
      tenantId: tenantGroupId,
      kind: FORM_PURGE_JOB_KIND,
      // One per site, workspace and ten minutes: a refused earlier attempt's job has finished by the time a later delete is
      // asked for (it runs ten minutes after its own), and repeated deletes of a nonexistent project within the window share one row.
      dedupeKey: purgeJobKey(siteId, workspaceId, now),
      payload: { siteId, workspaceId, notAfter: new Date(now.getTime() + PURGE_DELAY_MS + PURGE_PATIENCE_MS).toISOString() },
      runAt: new Date(now.getTime() + PURGE_DELAY_MS),
      at: now,
    });
  });
  return true;
}

/**
 * The job's work. The site row still there: the delete was refused or has not committed, so nothing is purged and the job
 * ends. The row gone: every submission of the site goes (their emails with them, by the foreign key). A submission whose email
 * is being sent right now is a retry, any other failure is a retry too (the error is logged), and no transient error ever kills it. Only a corrupt job (another tenant's, `tenant_mismatch`, or an unreadable payload) is refused
 * and ends dead, which the dead-jobs monitor covers.
 */
export async function purgeSiteSubmissions(
  group: { id: string; db: Kysely<CommerceDB> },
  jobTenantId: string,
  siteId: string,
  workspaceId: string,
  prisma: PrismaClient = getPrismaClient(),
  options: { notAfter?: string | null; now?: Date } = {},
): Promise<'kept' | 'purged'> {
  // The job is written in its own tenant group: a payload cannot point the purge at another group's schema.
  if (jobTenantId !== group.id) throw new JobRefused('tenant_mismatch');
  const now = options.now ?? new Date();
  const gone = await siteGoneOrLookAgain(prisma, {
    db: group.db,
    tenantId: group.id,
    kind: FORM_PURGE_JOB_KIND,
    lookKeyPrefix: `formpurge:look:${siteId}:${workspaceId}`,
    siteId,
    payload: { siteId, workspaceId },
    notAfter: options.notAfter,
    now,
  });
  // The row is still there: the delete was refused, or it has not committed yet (src/server/commerce/jobs/siteGone.ts).
  if (!gone) return 'kept';
  try {
    await deleteSiteSubmissions(group.db, { tenantId: group.id, siteId, workspaceId });
  } catch (err) {
    if (err instanceof FormBusyError) throw new JobRetryLater('an email of the project is being sent');
    console.error(`[forms] purging the submissions of deleted project ${siteId} failed, will retry:`, err);
    throw new JobRetryLater('purge_failed');
  }
  return 'purged';
}
