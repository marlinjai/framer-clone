import 'server-only';

// src/server/forms/projectDelete.ts
//
// The project delete's reach into the company's tenant schema: the site row
// lives in Prisma's `public` schema while its form submissions live in
// `tg_<id>.form_submission` on another connection, so the database cascade of
// the site delete cannot reach them. DELETE /api/projects/<id> calls this right
// after the site row is gone (never before: a refused delete, a published
// project without the confirmation, must keep everything).

import { isTenantGroupId } from '@marlinjai/tenant-db';

import { commerceTenantDbChecked, isCommerceTenantNotProvisioned } from '@/server/commerce/db';
import { FormBusyError, deleteSiteSubmissions } from './repository';

/** A notification email being sent holds its row for seconds: the delete is tried again, since the site row is gone and nothing else would remove the submissions. */
const BUSY_ATTEMPTS = 6;
const BUSY_PAUSE_MS = 2_000;

/**
 * Delete every form submission of a deleted project. A tenant group without a
 * commerce schema (a legacy site) has no submissions: 0. Any other failure
 * throws, and the caller reports it. A submission whose notification email is being sent
 * is waited for a few times; if that stays so, `pending` is answered (rows may remain) and the durable `form_purge` job written before the
 * delete (src/server/forms/purge.ts) finishes it: no submission is ever left behind without a job that removes it.
 */
export interface ProjectSubmissionsResult {
  /** Rows removed now. */
  deleted: number;
  /** True when rows may remain because an email of the project is being sent: the purge job written before the delete removes them. */
  pending: boolean;
}

export async function deleteProjectSubmissions(
  tenantGroupId: string,
  siteId: string,
  options: { attempts?: number; pauseMs?: number; now?: () => Date } = {},
): Promise<ProjectSubmissionsResult> {
  const { attempts = BUSY_ATTEMPTS, pauseMs = BUSY_PAUSE_MS } = options;
  if (!isTenantGroupId(tenantGroupId)) return { deleted: 0, pending: false };
  let db;
  try {
    db = await commerceTenantDbChecked(tenantGroupId);
  } catch (err) {
    if (isCommerceTenantNotProvisioned(err)) return { deleted: 0, pending: false };
    throw err;
  }
  for (let attempt = 1; ; attempt += 1) {
    try {
      return { deleted: await deleteSiteSubmissions(db, { tenantId: tenantGroupId, siteId }), pending: false };
    } catch (err) {
      if (!(err instanceof FormBusyError)) throw err;
      if (attempt >= attempts) {
        console.warn(`[forms] the submissions of deleted project ${siteId} are left to the purge job (an email was being sent)`);
        return { deleted: 0, pending: true };
      }
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }
}
