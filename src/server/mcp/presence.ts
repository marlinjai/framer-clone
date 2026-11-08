import 'server-only';

// src/server/mcp/presence.ts
//
// An open editor sees where an agent works (plan docs/plans/2026-11-08-live-agent-canvas.md,
// section 2): every MCP tool call that names a site reports `agent:activity`
// on that site's stream, once when it starts and once when it ends
// (src/server/sites/livePresence.ts). Calls without a site (list_sites,
// find_images, create_site) report nothing.
//
// The site id comes from the tool's arguments, which the key holder writes, and
// the site's stream is keyed by it alone. So nothing is reported before the
// site is confirmed to be in the key's own scope (the repository's scoped
// version read): a key of one company naming another company's site id paints
// nothing into that company's editor, not even an end. Confirmed sites are
// remembered for a few minutes (sites never change workspace; a deleted one only
// costs a report nobody hears).
//
// What travels: ids (the call's random id, a hash of the key id, page and node
// ids from the arguments and the answer), the tool's name, the outcome, the
// agent's label (sanitised and capped) and the first summary line of a write.
// Never the key id, never the arguments' content.

import { randomUUID } from 'node:crypto';
import {
  LIVE_LIST_MAX,
  capLiveText,
  type AgentActivity,
  type AgentOutcome,
  type LiveFeedLine,
} from '@/lib/projects/liveEvents';
import type { SiteRepository } from '@/server/sites';
import type { TenantScope } from '@/server/sites/repository';
import { liveAgentId } from '@/server/siteOps/audit';
import { reportAgentActivity } from '@/server/sites/livePresence';
import type { ToolResult } from './tools';

/** How long a site confirmed in a scope is trusted without asking the repository again. */
export const SCOPE_CONFIRM_TTL_MS = 5 * 60_000;
/** Confirmed (workspace, site) pairs kept at once; the oldest goes first. */
export const SCOPE_CONFIRM_MAX = 5000;

/** Tools whose successful answer means a write committed (and left an audit row). */
const WRITE_TOOLS = new Set(['apply_batch', 'generate_page', 'publish', 'rollback']);

const confirmed = new Map<string, number>();

function confirmKey(scope: TenantScope, siteId: string): string {
  return `${scope.tenantGroupId}\u0000${scope.workspaceId}\u0000${siteId}`;
}

/** Whether the site is in the scope: from the cache, else the repository's scoped read. Never throws. */
export async function siteInScope(repository: SiteRepository, scope: TenantScope, siteId: string, now: number = Date.now()): Promise<boolean> {
  const key = confirmKey(scope, siteId);
  const until = confirmed.get(key);
  if (until !== undefined && until > now) return true;
  confirmed.delete(key);
  try {
    await repository.getSiteVersion(scope, siteId);
  } catch {
    // Not found in this scope, or the database could not answer: report nothing.
    return false;
  }
  confirmed.set(key, now + SCOPE_CONFIRM_TTL_MS);
  while (confirmed.size > SCOPE_CONFIRM_MAX) confirmed.delete(confirmed.keys().next().value as string);
  return true;
}

/** Tests only. */
export function resetPresenceScopeCacheForTests(): void {
  confirmed.clear();
}

const ID_MAX = 200;

function idOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  // A `ref:` names something the same batch creates: its real id comes with the answer.
  if (!id || id.length > ID_MAX || id.startsWith('ref:')) return undefined;
  return id;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The site a call names, when it names one. */
export function siteIdOf(args: unknown): string | undefined {
  return idOf(record(args).siteId);
}

/** The page and nodes a call's arguments name (ids only), in the order they appear. */
export function focusOf(args: unknown): { pageId?: string; nodeIds: string[] } {
  const a = record(args);
  const target = record(a.target);
  const nodeIds: string[] = [];
  const add = (value: unknown) => {
    const id = idOf(value);
    if (id && !nodeIds.includes(id) && nodeIds.length < LIVE_LIST_MAX) nodeIds.push(id);
  };
  let pageId = idOf(a.pageId) ?? idOf(target.pageId);
  add(target.nodeId);
  add(target.parentId);
  if (Array.isArray(a.ops)) {
    for (const raw of a.ops) {
      const op = record(raw);
      pageId ??= idOf(op.pageId);
      add(op.nodeId);
      add(op.parentId);
      const to = record(op.to);
      add(to.parentId);
      add(to.siblingId);
    }
  }
  return pageId ? { pageId, nodeIds } : { nodeIds };
}

/** How a tool's answer ended, from its error code. */
export function outcomeOf(result: ToolResult | undefined): AgentOutcome {
  if (!result) return 'failed';
  if (!result.isError) return 'ok';
  const code = record(record(result.structuredContent).error).code;
  if (code === 'rejected') return 'rejected';
  if (code === 'site_changed') return 'site_changed';
  return 'failed';
}

/** Whether the answer reports a committed write (then the audit row carries the feed line). */
function wroteOf(tool: string, result: ToolResult | undefined): boolean {
  if (!result || !WRITE_TOOLS.has(tool)) return false;
  const s = record(result.structuredContent);
  if (result.isError) return typeof record(s.error).writtenVersion === 'number';
  return tool === 'rollback' ? typeof s.live === 'number' : typeof s.version === 'number';
}

/** The ids an answer created or inserted, and the page it names. */
function answerFocus(result: ToolResult | undefined): { pageId?: string; nodeIds: string[]; summary?: string } {
  if (!result || result.isError) return { nodeIds: [] };
  const s = record(result.structuredContent);
  const nodeIds = [
    ...Object.values(record(s.created)),
    ...(Array.isArray(s.insertedIds) ? s.insertedIds : []),
  ]
    .map(idOf)
    .filter((id): id is string => !!id);
  const first = Array.isArray(s.summary) && typeof s.summary[0] === 'string' ? capLiveText(s.summary[0]) : undefined;
  const pageId = idOf(s.pageId);
  return { ...(pageId ? { pageId } : {}), nodeIds, ...(first ? { summary: first } : {}) };
}

export interface PresenceCall {
  tool: string;
  args: unknown;
  /** The verified key's id: hashed here, never sent. */
  keyId: string;
  /** Sanitised already (the key's name, else the client's), or undefined for "Agent". */
  label?: string;
  scope: TenantScope;
  repository: SiteRepository;
}

/**
 * Run a tool call and report it on its site's stream: a start before, an end
 * after (also when the call throws). A call without a site, or naming a site
 * outside the key's scope, runs unreported.
 */
export async function withPresence(call: PresenceCall, run: () => Promise<ToolResult>): Promise<ToolResult> {
  const siteId = siteIdOf(call.args);
  if (!siteId || !(await siteInScope(call.repository, call.scope, siteId))) return run();

  const focus = focusOf(call.args);
  const base = {
    callId: randomUUID(),
    agentId: liveAgentId(call.keyId),
    label: call.label ?? 'Agent',
    tool: call.tool,
  };
  const start: AgentActivity = {
    ...base,
    phase: 'start',
    ...(focus.pageId ? { pageId: focus.pageId } : {}),
    ...(focus.nodeIds.length > 0 ? { nodeIds: focus.nodeIds } : {}),
    at: new Date().toISOString(),
  };
  reportAgentActivity(siteId, start);

  let result: ToolResult | undefined;
  try {
    result = await run();
    return result;
  } finally {
    const answered = answerFocus(result);
    const outcome = outcomeOf(result);
    const nodeIds = [...new Set([...focus.nodeIds, ...answered.nodeIds])].slice(0, LIVE_LIST_MAX);
    const pageId = focus.pageId ?? answered.pageId;
    const ops = record(call.args).ops;
    const changes = Array.isArray(ops) ? ops.length : undefined;
    const end: AgentActivity = {
      ...base,
      phase: 'end',
      outcome,
      ...(pageId ? { pageId } : {}),
      ...(nodeIds.length > 0 ? { nodeIds } : {}),
      ...(answered.summary ? { summary: answered.summary } : {}),
      ...(changes !== undefined ? { changes } : {}),
      at: new Date().toISOString(),
    };
    // A committed write is in the audit table, which backs the feed after a reload;
    // everything else is a live line only.
    const line: LiveFeedLine | undefined = wroteOf(call.tool, result)
      ? undefined
      : {
          id: base.callId,
          agentId: base.agentId,
          label: base.label,
          actorKind: 'key',
          tool: call.tool,
          outcome,
          ...(pageId ? { pageId } : {}),
          ...(nodeIds.length > 0 ? { nodeIds } : {}),
          ...(changes !== undefined ? { changes } : {}),
          at: end.at,
        };
    reportAgentActivity(siteId, end, line);
  }
}
