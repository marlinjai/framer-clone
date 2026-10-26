import 'server-only';

// src/server/sites/siteCompany.ts
//
// The company a site belongs to (sites.company_id, docs/plans/2026-10-25-catalogue-design.md). A published
// storefront has no session, so the catalogue reads of a site find the company in this column. It is stamped
// from the server-verified session wherever the editor acts on a site under a resolved company: creating it,
// saving it, publishing it, and every editor commerce read. A company never changes its workspace, so the
// stamp only fills an empty column and never overwrites one (a mismatch is logged, not "fixed").

import type { PrismaClient } from '@prisma/client';

import { getPrismaClient } from '@/server/db';
import type { TenantScope } from './repository';

/**
 * Record `companyId` as the company of `siteId` when the site has none yet. Scoped to the site's workspace and
 * tenant group, so a site of another company is never touched. Never throws for a site that is not there (the
 * caller already answered for it); a database failure propagates.
 */
export async function stampSiteCompany(
  scope: Pick<TenantScope, 'workspaceId' | 'tenantGroupId'>,
  siteId: string,
  companyId: string,
  prisma: PrismaClient = getPrismaClient(),
): Promise<void> {
  const stamped = await prisma.site.updateMany({
    where: {
      id: siteId,
      workspaceId: scope.workspaceId,
      tenantGroupId: scope.tenantGroupId,
      companyId: null,
    },
    data: { companyId },
  });
  if (stamped.count > 0) return;
  const site = await prisma.site.findFirst({
    where: { id: siteId, workspaceId: scope.workspaceId, tenantGroupId: scope.tenantGroupId },
    select: { companyId: true },
  });
  if (site && site.companyId !== companyId) {
    console.error(`[sites] site ${siteId} belongs to company ${site.companyId}, not ${companyId}; left as it is`);
  }
}
