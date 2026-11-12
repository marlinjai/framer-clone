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
 * throws, and the caller reports it.
 */
export async function deleteProjectSubmissions(tenantGroupId: string, siteId: string): Promise<number> {
  if (!isTenantGroupId(tenantGroupId)) return 0;
  let db;
  try {
    db = await commerceTenantDbChecked(tenantGroupId);
  } catch (err) {
    if (isCommerceTenantNotProvisioned(err)) return 0;
    throw err;
  }
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await deleteSiteSubmissions(db, { tenantId: tenantGroupId, siteId });
    } catch (err) {
      if (!(err instanceof FormBusyError) || attempt >= BUSY_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, BUSY_PAUSE_MS));
    }
  }
}
