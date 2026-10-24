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
import { deleteSiteSubmissions } from './repository';

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
  return deleteSiteSubmissions(db, { tenantId: tenantGroupId, siteId });
}
