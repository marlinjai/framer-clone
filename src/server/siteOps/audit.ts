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
  /** The ids the write created (the server's own, never the caller's words): so the feed can open them after a reload. */
  created?: { nodeIds: string[]; pageIds: string[] };
}

/**
 * The audit row's actor detail: the caller's extra ids and, when it has one,
 * its display label (a key's name) and the call's live id, so the editor's
 * activity feed names the agent again after a reload and shows the write under
 * the id it had live. A name and a random id, never a secret.
 */
function actorDetailOf(caller: SiteOpsCaller, entry: AuditEntry): Record<string, unknown> | undefined {
  const created = entry.created;
  const detail: Record<string, unknown> = {
    ...(caller.actorDetail ?? {}),
    ...(caller.actorLabel ? { label: caller.actorLabel } : {}),
    ...(caller.liveCallId ? { callId: caller.liveCallId } : {}),
    // Kept apart from `ops`, so the count of operations a line shows stays the batch's.
    ...(created && created.nodeIds.length > 0 ? { createdNodeIds: created.nodeIds.slice(0, LIVE_LIST_MAX) } : {}),
    ...(created && created.pageIds.length > 0 ? { createdPageIds: created.pageIds.slice(0, LIVE_LIST_MAX) } : {}),
  };
  return Object.keys(detail).length > 0 ? detail : undefined;
}

export async function recordSiteOperation(prisma: PrismaClient, caller: SiteOpsCaller, entry: AuditEntry): Promise<void> {
  const actorDetail = actorDetailOf(caller, entry);
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

/** A live call id (a random UUID). */
const CALL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
    const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);
    const nodeIds = [
      ...new Set([...ops.map((o) => o?.nodeId).filter((id): id is string => typeof id === 'string'), ...strings(detail.createdNodeIds)]),
    ].slice(0, LIVE_LIST_MAX);
    const pageId = ops.find((o) => typeof o?.pageId === 'string')?.pageId ?? strings(detail.createdPageIds)[0];
    const callId = typeof detail.callId === 'string' && CALL_ID_PATTERN.test(detail.callId) ? detail.callId : undefined;
    const line: LiveFeedLine = {
      // The id the line had live, when the write came through the MCP endpoint, else the row's.
      id: callId ?? row.id,
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
