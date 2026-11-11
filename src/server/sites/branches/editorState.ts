import 'server-only';

// src/server/sites/branches/editorState.ts
//
// What the editor's page tells the client about branches (docs/plans/2026-11-10-site-branches.md, slice S4):
// for an open site, whether it is main or a branch; for a site id with no content row, whether it is a merged
// or discarded branch whose old address explains itself. Both read through the caller's workspace only, and
// both answer nothing while site branches are off for the company, so the editor looks as it always did.

import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '@/server/db';
import type { BranchSummaryJson, ClosedBranchNotice, EditorBranchState } from '@/lib/sites/branches';
import type { TenantScope } from '../repository';
import { SiteNotFoundError } from '../errors';
import { getSiteBranchRepository, type BranchSummary } from './repository';
import { siteBranchesEnabled } from './switch';

export function summaryJson(summary: BranchSummary): BranchSummaryJson {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    ...summary,
    createdAt: summary.createdAt.toISOString(),
    updatedAt: summary.updatedAt.toISOString(),
    readyAt: iso(summary.readyAt),
    mergedAt: iso(summary.mergedAt),
    discardedAt: iso(summary.discardedAt),
  };
}

async function siteName(prisma: PrismaClient, scope: TenantScope, siteId: string): Promise<string> {
  const row = await prisma.site.findFirst({
    where: { id: siteId, workspaceId: scope.workspaceId, tenantGroupId: scope.tenantGroupId },
    select: { name: true },
  });
  if (!row) throw new SiteNotFoundError(siteId);
  return row.name;
}

/**
 * Main or branch, for a site the caller's workspace holds. With branches off for the company: null for a main
 * site (the editor looks as it always did) and `hidden` for a branch, whose address then answers 404 like the
 * branch routes do (section 9: turning the switch off hides branches without deleting them).
 */
export async function editorBranchState(
  scope: TenantScope,
  companyId: string,
  siteId: string,
  prisma: PrismaClient = getPrismaClient(),
): Promise<EditorBranchState | null | 'hidden'> {
  if (!siteBranchesEnabled(companyId)) {
    const row = await prisma.site.findFirst({
      where: { id: siteId, workspaceId: scope.workspaceId, tenantGroupId: scope.tenantGroupId },
      select: { branchOfSiteId: true },
    });
    return row?.branchOfSiteId ? 'hidden' : null;
  }
  const context = await getSiteBranchRepository().siteBranchContext(scope, siteId);
  if (context.kind === 'main') {
    return { kind: 'main', siteId, siteName: await siteName(prisma, scope, siteId), openBranches: context.openBranches };
  }
  return {
    kind: 'branch',
    siteId,
    mainSiteId: context.mainSiteId,
    mainName: await siteName(prisma, scope, context.mainSiteId),
    branch: summaryJson(context.branch),
  };
}

/** The notice for a merged or discarded branch's old address; null for anything else, or with branches off. */
export async function closedBranchNotice(
  scope: TenantScope,
  companyId: string,
  siteId: string,
  prisma: PrismaClient = getPrismaClient(),
): Promise<ClosedBranchNotice | null> {
  if (!siteBranchesEnabled(companyId)) return null;
  const record = await prisma.siteBranch.findFirst({
    where: { id: siteId, workspaceId: scope.workspaceId, tenantGroupId: scope.tenantGroupId, branchSiteId: null },
    select: { id: true, status: true, name: true, siteId: true, mergedAt: true, discardedAt: true, updatedAt: true },
  });
  if (!record) return null;
  const main = await prisma.site.findFirst({
    where: { id: record.siteId, workspaceId: scope.workspaceId, tenantGroupId: scope.tenantGroupId },
    select: { name: true },
  });
  if (!main) return null;
  const status = record.status === 'merged' ? 'merged' : 'discarded';
  const closedAt = (status === 'merged' ? record.mergedAt : record.discardedAt) ?? record.updatedAt;
  return { branchId: record.id, status, name: record.name, mainSiteId: record.siteId, mainName: main.name, closedAt: closedAt.toISOString() };
}
