import 'server-only';

// src/server/siteOps/audit.ts
//
// One row per write of the site operations (site_operation_audits): the actor (a
// user or an API key, with extra non-secret ids), the site in the caller's scope,
// the operation and the operations of a batch by name and id, never content.
//
// The rows also back the editor's activity feed after a reload (plan
// docs/plans/2026-11-08-live-agent-canvas.md, section 2): recentSiteOperations
// reads a site's last rows, in the caller's scope only, as feed lines.

import { createHash } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { SiteOpsCaller } from '@/lib/siteOps/types';
import type { TenantScope } from '@/server/sites/repository';
import { LIVE_FEED_MAX, LIVE_LIST_MAX, sanitizeLiveLabel, type LiveFeedLine } from '@/lib/projects/liveEvents';

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

/**
 * The audit row's actor detail: the caller's extra ids and, when it has one,
 * its display label (a key's name), so the editor's activity feed names the
 * agent again after a reload. A name, never a secret.
 */
function actorDetailOf(caller: SiteOpsCaller): Record<string, string> | undefined {
  const detail = { ...(caller.actorDetail ?? {}), ...(caller.actorLabel ? { label: caller.actorLabel } : {}) };
  return Object.keys(detail).length > 0 ? detail : undefined;
}

export async function recordSiteOperation(prisma: PrismaClient, caller: SiteOpsCaller, entry: AuditEntry): Promise<void> {
  const actorDetail = actorDetailOf(caller);
  await prisma.siteOperationAudit.create({
    data: {
      siteId: entry.siteId,
      workspaceId: caller.scope.workspaceId,
      tenantGroupId: caller.scope.tenantGroupId,
      actorKind: caller.actor.kind,
      actorId: caller.actor.id,
      ...(actorDetail ? { actorDetail: actorDetail as Prisma.InputJsonValue } : {}),
      operation: entry.operation,
      ...(entry.ops ? { ops: entry.ops as unknown as Prisma.InputJsonValue } : {}),
      versionBefore: entry.versionBefore ?? null,
      versionAfter: entry.versionAfter ?? null,
      revision: entry.revision ?? null,
    },
  });
}

/**
 * How an open editor tells actors apart without learning who they are: a
 * hash of the actor's id (a key id or a user id), never the id itself. The MCP
 * endpoint's live activity uses the same hash, so live and stored lines of one
 * agent group together.
 */
export function liveAgentId(actorId: string): string {
  return createHash('sha256').update(`lumitra-live-agent:${actorId}`).digest('base64url').slice(0, 16);
}

/** The tool an audited operation came from, as the feed names it. */
const TOOL_OF_OPERATION: Record<string, string> = {
  batch: 'apply_batch',
  create_site: 'create_site',
  generate_page: 'generate_page',
  publish: 'publish',
  rollback: 'rollback',
};

/**
 * The last `limit` writes of a site as feed lines, newest first. Scoped like
 * every site read: the site id AND the caller's workspace and tenant group, so
 * a site id of another company reads nothing.
 */
export async function recentSiteOperations(
  prisma: PrismaClient,
  scope: TenantScope,
  siteId: string,
  limit: number = LIVE_FEED_MAX,
): Promise<LiveFeedLine[]> {
  const rows = await prisma.siteOperationAudit.findMany({
    where: { siteId, workspaceId: scope.workspaceId, tenantGroupId: scope.tenantGroupId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, actorKind: true, actorId: true, actorDetail: true, operation: true, ops: true, createdAt: true },
  });
  return rows.map((row) => {
    const actorKind = row.actorKind === 'user' ? 'user' : 'key';
    const detail = (row.actorDetail ?? {}) as Record<string, unknown>;
    const ops = Array.isArray(row.ops) ? (row.ops as unknown as AuditedOp[]) : [];
    const nodeIds = [...new Set(ops.map((o) => o?.nodeId).filter((id): id is string => typeof id === 'string'))].slice(0, LIVE_LIST_MAX);
    const pageId = ops.find((o) => typeof o?.pageId === 'string')?.pageId;
    const line: LiveFeedLine = {
      id: row.id,
      agentId: liveAgentId(row.actorId),
      label: sanitizeLiveLabel(detail.label) ?? (actorKind === 'key' ? 'Agent' : 'Someone'),
      actorKind,
      tool: TOOL_OF_OPERATION[row.operation] ?? row.operation,
      outcome: 'ok',
      at: row.createdAt.toISOString(),
    };
    if (pageId) line.pageId = pageId;
    if (nodeIds.length > 0) line.nodeIds = nodeIds;
    if (row.operation === 'batch') line.changes = ops.length;
    return line;
  });
}
