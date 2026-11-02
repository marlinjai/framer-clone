import 'server-only';

// src/server/siteOps/audit.ts
//
// One row per write of the site operations (site_operation_audits): the actor (a
// user or an API key, with extra non-secret ids), the site in the caller's scope,
// the operation and the operations of a batch by name and id, never content.

import type { PrismaClient, Prisma } from '@prisma/client';
import type { SiteOpsCaller } from '@/lib/siteOps/types';

export interface AuditedOp {
  op: string;
  nodeId?: string;
  pageId?: string;
}

export interface AuditEntry {
  siteId: string;
  operation: 'batch' | 'create_site' | 'generate_page' | 'publish' | 'rollback';
  ops?: AuditedOp[];
  versionBefore?: number;
  versionAfter?: number;
  revision?: number;
}

export async function recordSiteOperation(prisma: PrismaClient, caller: SiteOpsCaller, entry: AuditEntry): Promise<void> {
  await prisma.siteOperationAudit.create({
    data: {
      siteId: entry.siteId,
      workspaceId: caller.scope.workspaceId,
      tenantGroupId: caller.scope.tenantGroupId,
      actorKind: caller.actor.kind,
      actorId: caller.actor.id,
      ...(caller.actorDetail ? { actorDetail: caller.actorDetail as Prisma.InputJsonValue } : {}),
      operation: entry.operation,
      ...(entry.ops ? { ops: entry.ops as unknown as Prisma.InputJsonValue } : {}),
      versionBefore: entry.versionBefore ?? null,
      versionAfter: entry.versionAfter ?? null,
      revision: entry.revision ?? null,
    },
  });
}
