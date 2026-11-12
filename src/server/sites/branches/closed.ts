import 'server-only';

// src/server/sites/branches/closed.ts
//
// One lookup shared by the site repository and the branch repository: a site id that no `sites` row of the
// caller's workspace holds may be a branch that was merged or discarded, whose record stays (plan
// docs/plans/2026-11-10-site-branches.md, section 6). Its editor tab, an agent holding its id and its old address
// then hear 410 `branch_closed` naming the main site, instead of a bare 404. Scoped by workspace like every read,
// so another workspace's closed branch reads as missing.

import type { Prisma, PrismaClient } from '@prisma/client';
import { BranchClosedError } from '../errors';

export async function closedBranchError(
  client: PrismaClient | Prisma.TransactionClient,
  workspaceId: string,
  siteId: string,
): Promise<BranchClosedError | null> {
  const record = await client.siteBranch.findFirst({
    where: { id: siteId, workspaceId, branchSiteId: null },
    select: { status: true, siteId: true, undoneIntoBranchId: true },
  });
  if (!record) return null;
  // A record whose content row went some other way still reads as open: its content is gone, so it is reported
  // as discarded.
  return new BranchClosedError(record.status === 'merged' ? 'merged' : 'discarded', record.siteId, record.status === 'merged' ? record.undoneIntoBranchId : null);
}
