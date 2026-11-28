import 'server-only';

// src/server/commerce/jobs/siteGone.ts
//
// The one "is the deleted project really gone?" look that the cleanup jobs of a deleted project share (the form
// submissions, src/server/forms/purge.ts, and the shop catalogue, src/server/catalog/siteRetire.ts). Each cleanup writes
// its job BEFORE the site row is deleted, so the job must never act while the row is still there: the delete was
// refused, or it has not committed yet (it may be waiting on a lock for longer than the job waited). Until the job's
// patience (`notAfter`) runs out, the look is handed to a fresh job ten minutes on, a job of its own, so the retry count
// of a failing cleanup (the watchdog's "stuck") never moves for a refused delete.

import type { PrismaClient } from '@prisma/client';
import type { Kysely } from 'kysely';

import type { CommerceDB } from '../db-types';
import { scheduleJob } from './schedule';

/** How long after the delete starts a cleanup job first looks: past the delete itself and its own retries, so it is a backstop. */
export const SITE_CLEANUP_DELAY_MS = 10 * 60 * 1000;

/** How long past its first look a cleanup job keeps waiting for a delete that has not committed yet (a long lock wait on the site row). */
export const SITE_CLEANUP_PATIENCE_MS = 2 * 60 * 60 * 1000;

export interface SiteGoneLook {
  /** The tenant schema the job lives in. */
  db: Kysely<CommerceDB>;
  /** The job's own tenant (the tenant group for the form purge, the company for the catalogue). */
  tenantId: string;
  kind: string;
  /** Distinguishes one cleanup's follow-up keys from another's, e.g. `formpurge:look:<site>:<workspace>`. */
  lookKeyPrefix: string;
  siteId: string;
  /** The follow-up's payload, without `notAfter` (added here). */
  payload: Record<string, unknown>;
  notAfter: string | null | undefined;
  now: Date;
}

/**
 * True when the site row is gone and the cleanup may act. False when it is still there: then, inside the patience, a
 * follow-up job is written (keys of its own: `scheduleJob` ignores a key that has ANY job, a finished one too, so a
 * follow-up sharing the delete request's keys could swallow a later delete of the same window).
 */
export async function siteGoneOrLookAgain(prisma: PrismaClient, look: SiteGoneLook): Promise<boolean> {
  const site = await prisma.site.findUnique({ where: { id: look.siteId }, select: { id: true } });
  if (!site) return true;
  const notAfter = look.notAfter ? new Date(look.notAfter) : null;
  if (notAfter && !Number.isNaN(notAfter.getTime()) && look.now < notAfter) {
    const runAt = new Date(look.now.getTime() + SITE_CLEANUP_DELAY_MS);
    await look.db.transaction().execute(async (trx) => {
      await scheduleJob(trx, {
        tenantId: look.tenantId,
        kind: look.kind,
        dedupeKey: `${look.lookKeyPrefix}:${notAfter.getTime()}:${Math.floor(runAt.getTime() / SITE_CLEANUP_DELAY_MS)}`,
        payload: { ...look.payload, notAfter: notAfter.toISOString() },
        runAt,
        at: look.now,
      });
    });
  }
  return false;
}
