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
// agent's label (sanitised and capped) and a count of operations. Never the key
// id, never the arguments' content (ids pass a strict shape check, and an end
// repeats the arguments' ids only for a call the site accepted), never a summary line (those name page
// titles, which are content).
//
// Bounded per key: a site id not in scope is remembered as such for a short
// while, a key causes at most MISSES_PER_KEY lookups that miss per minute (a key
// sending a new made-up id on every call costs no database read per call), and
// a key reports at most REPORTS_PER_KEY calls per minute; calls beyond that run
// unreported and look nothing up, so a runaway agent cannot flood its own
// company's editors. Hits and misses are cached apart, so a flood of misses
// never evicts another company's confirmed sites.
//
// A write tool's start is reported only once the call passed its permission
// check (the caller's `can` answered yes for the action the tool needs, see
// START_AFTER), so a key without the right paints no "working here" frame into
// the editor for a call that is refused; its end (with the refusal as the
// outcome and the feed line) still travels. A read reports its start at once.
//
// The call id travels into the write's audit row (`SiteOpsCaller.liveCallId`),
// so a reloaded editor's feed line for a write has the same id as the line it
// added live, and the two never both show.

import { randomUUID } from 'node:crypto';
import {
  LIVE_LIST_MAX,
  type AgentActivity,
  type AgentOutcome,
  type LiveFeedLine,
} from '@/lib/projects/liveEvents';
import type { SiteRepository } from '@/server/sites';
import type { TenantScope } from '@/server/sites/repository';
import { splitCreated } from '@/lib/siteOps/createdIds';
import { liveAgentId } from '@/server/siteOps/audit';
import { reportAgentActivity } from '@/server/sites/livePresence';
import { sectionRefFor } from './livePlans';
import type { ToolResult } from './tools';
import type { SiteOpsAction } from '@/lib/siteOps/types';

/** How long a site confirmed in a scope is trusted without asking the repository again. */
export const SCOPE_CONFIRM_TTL_MS = 5 * 60_000;
/** Confirmed (workspace, site) pairs kept at once; the oldest goes first. */
export const SCOPE_CONFIRM_MAX = 5000;
/** How long a site found outside a scope (or unreadable) is not asked about again. */
export const SCOPE_MISS_TTL_MS = 30_000;
/** Calls one key reports per minute, at most; the rest run unreported. */
export const REPORTS_PER_KEY = 120;
const REPORT_WINDOW_MS = 60_000;
/** Keys tracked by the report budget at once. */
const REPORT_KEYS_MAX = 5000;

/** Tools whose successful answer means a write committed (and left an audit row). */
const WRITE_TOOLS = new Set(['apply_batch', 'generate_page', 'publish', 'rollback']);

/**
 * The tools whose start waits for their permission check: the action the
 * caller's `can` must allow before the start is reported. Every other tool
 * that names a site reports its start at once: the reads, and clear_sections,
 * which asks no permission (it only ever ends the calling key's own plans).
 */
export const START_AFTER: Readonly<Record<string, SiteOpsAction>> = {
  apply_batch: 'editSite',
  generate_page: 'editSite',
  announce_sections: 'editSite',
  publish: 'publishSite',
  rollback: 'publishSite',
};

/** Lookups that found no site one key may cause per minute; beyond that it is not asked about new ids. */
export const MISSES_PER_KEY = 20;

/** (scope, site) found in scope, to until when that holds. */
const confirmed = new Map<string, number>();
/** (scope, site) found outside it (or unreadable), to until when that holds: kept apart, so misses never evict hits. */
const missed = new Map<string, number>();
/** Agent id to its window of lookups that missed. */
const missBudgets = new Map<string, { windowStart: number; count: number }>();
/** Agent id to its report window. */
const budgets = new Map<string, { windowStart: number; count: number }>();

function remember(map: Map<string, number>, key: string, until: number): void {
  map.delete(key);
  map.set(key, until);
  while (map.size > SCOPE_CONFIRM_MAX) map.delete(map.keys().next().value as string);
}

/** A fixed one-minute window per key: its count now, started afresh when the window passed. */
function windowOf(map: Map<string, { windowStart: number; count: number }>, agentId: string, now: number) {
  let budget = map.get(agentId);
  if (!budget || now - budget.windowStart >= REPORT_WINDOW_MS) {
    map.delete(agentId);
    budget = { windowStart: now, count: 0 };
    map.set(agentId, budget);
    while (map.size > REPORT_KEYS_MAX) map.delete(map.keys().next().value as string);
  }
  return budget;
}

/** Whether the key has a report left this minute (without spending it). */
export function hasReportLeft(agentId: string, now: number = Date.now()): boolean {
  return windowOf(budgets, agentId, now).count < REPORTS_PER_KEY;
}

/** Spend one report of the key; false when its minute is used up. */
export function takeReport(agentId: string, now: number = Date.now()): boolean {
  const budget = windowOf(budgets, agentId, now);
  if (budget.count >= REPORTS_PER_KEY) return false;
  budget.count += 1;
  return true;
}

function confirmKey(scope: TenantScope, siteId: string): string {
  return `${scope.tenantGroupId}\u0000${scope.workspaceId}\u0000${siteId}`;
}

/** Whether the site is in the scope: from the cache, else the repository's scoped read. Never throws. */
export async function siteInScope(
  repository: SiteRepository,
  scope: TenantScope,
  siteId: string,
  now: number = Date.now(),
  agentId?: string,
): Promise<boolean> {
  const key = confirmKey(scope, siteId);
  if ((confirmed.get(key) ?? 0) > now) return true;
  if ((missed.get(key) ?? 0) > now) return false;
  // A key whose lookups keep missing (made-up ids) is not asked about new ids for the rest of its minute.
  const misses = agentId ? windowOf(missBudgets, agentId, now) : undefined;
  if (misses && misses.count >= MISSES_PER_KEY) return false;
  try {
    await repository.getSiteVersion(scope, siteId);
  } catch {
    // Not found in this scope, or the database could not answer: report nothing for a while.
    remember(missed, key, now + SCOPE_MISS_TTL_MS);
    if (misses) misses.count += 1;
    return false;
  }
  missed.delete(key);
  remember(confirmed, key, now + SCOPE_CONFIRM_TTL_MS);
  return true;
}

/** Tests only. */
export function resetPresenceScopeCacheForTests(): void {
  confirmed.clear();
  missed.clear();
  budgets.clear();
  missBudgets.clear();
}

const ID_MAX = 100;
/** What an id looks like (generated ids are letters, digits, `-` and `_`): prose or a pasted secret does not pass. */
const ID_SHAPE = /^[A-Za-z0-9_-]+$/;

function idOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  // A `ref:` names something the same batch creates: its real id comes with the answer.
  if (!id || id.length > ID_MAX || !ID_SHAPE.test(id)) return undefined;
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

/**
 * The refs a batch puts on the root nodes it inserts (insertNodes nodes[].ref),
 * in order: the sections it may be writing for an announced plan.
 */
export function sectionRefsOf(args: unknown): string[] {
  const refs: string[] = [];
  const ops = record(args).ops;
  if (!Array.isArray(ops)) return refs;
  for (const raw of ops) {
    const op = record(raw);
    if (op.op !== 'insertNodes' || !Array.isArray(op.nodes)) continue;
    for (const node of op.nodes) {
      const ref = idOf(record(node).ref);
      if (ref && !refs.includes(ref) && refs.length < LIVE_LIST_MAX) refs.push(ref);
    }
  }
  return refs;
}

/**
 * The pages a batch's deletePage operations name: the ids in order, once each, at most
 * LIVE_LIST_MAX, and how many operations there were, uncapped. Only vouched for once the site
 * accepted the batch.
 */
export function deletedPagesOf(args: unknown): { ids: string[]; count: number } {
  const ids: string[] = [];
  let count = 0;
  const ops = record(args).ops;
  if (!Array.isArray(ops)) return { ids, count };
  for (const raw of ops) {
    const op = record(raw);
    if (op.op !== 'deletePage') continue;
    count += 1;
    const id = idOf(op.pageId);
    if (id && !ids.includes(id) && ids.length < LIVE_LIST_MAX) ids.push(id);
  }
  return { ids, count };
}

/** How a tool's answer ended, from its error code. A rate limit is a refusal: nothing was written. */
export function outcomeOf(result: ToolResult | undefined): AgentOutcome {
  if (!result) return 'failed';
  if (!result.isError) {
    // A publish or rollback the person has not approved (or declined) wrote nothing: not "ok".
    const s = record(result.structuredContent);
    if (s.declined === true) return 'declined';
    if (s.approvalRequired === true || s.approvalPending === true) return 'awaiting_approval';
    return 'ok';
  }
  const code = record(record(result.structuredContent).error).code;
  // Refusals that wrote nothing (a skeleton plan refused or already gone, a page that is not there).
  if (code === 'rejected' || code === 'rate_limited' || code === 'too_many_plans' || code === 'plan_not_found' || code === 'page_not_found') return 'rejected';
  if (code === 'site_changed') return 'site_changed';
  return 'failed';
}

/**
 * Whether the answer reports a committed write that its audit row will carry
 * (then the audit row is the feed line). An error answer never counts, even one
 * carrying `writtenVersion`: the publish committed but a later step failed,
 * possibly the audit row itself, so the live line stays as the fallback.
 */
function wroteOf(tool: string, result: ToolResult | undefined): boolean {
  if (!result || !WRITE_TOOLS.has(tool) || result.isError) return false;
  const s = record(result.structuredContent);
  return tool === 'rollback' ? typeof s.live === 'number' : typeof s.version === 'number';
}

/**
 * The ids an answer created or inserted, and the page it names (or the first
 * page the batch created: a `createPage` op's ref maps to a page id, not a node's).
 * These come from the server's own answer, never from the arguments.
 */
function answerFocus(result: ToolResult | undefined, args: unknown): { pageId?: string; nodeIds: string[] } {
  if (!result || result.isError) return { nodeIds: [] };
  const s = record(result.structuredContent);
  const created = splitCreated(record(args).ops, s.created);
  const nodeIds = [...created.nodeIds, ...(Array.isArray(s.insertedIds) ? s.insertedIds : [])].map(idOf).filter((id): id is string => !!id);
  const pageId = idOf(s.pageId) ?? created.pageIds.map(idOf).find((id): id is string => !!id);
  return { ...(pageId ? { pageId } : {}), nodeIds };
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
 * Told by the call's permission checks that `action` was allowed. The caller
 * wraps its `can` with it (handler.ts), so the start of a write tool goes out
 * only after the check it needs passed.
 */
export type PermittedFn = (action: SiteOpsAction) => void;

/**
 * Run a tool call and report it on its site's stream: a start (before a read,
 * after the permission check of a write, START_AFTER), an end after (also when
 * the call throws). A call without a site, or naming a site outside the key's
 * scope, runs unreported.
 */
export async function withPresence(
  call: PresenceCall,
  run: (liveCallId?: string, permitted?: PermittedFn) => Promise<ToolResult>,
): Promise<ToolResult> {
  const siteId = siteIdOf(call.args);
  if (!siteId) return run();
  const agentId = liveAgentId(call.keyId);
  // Over its report budget, a key causes no lookup at all.
  if (!hasReportLeft(agentId) || !(await siteInScope(call.repository, call.scope, siteId, Date.now(), agentId)) || !takeReport(agentId)) {
    return run();
  }

  const focus = focusOf(call.args);
  // A batch writing a section this key announced: the frame goes on that section's skeleton.
  const sectionRef = call.tool === 'apply_batch' ? sectionRefFor(siteId, agentId, sectionRefsOf(call.args)) : undefined;
  const base = {
    callId: randomUUID(),
    agentId,
    label: call.label ?? 'Agent',
    tool: call.tool,
    ...(sectionRef ? { sectionRef } : {}),
  };
  const company = call.scope.tenantGroupId;
  let started = false;
  const reportStart = () => {
    if (started) return;
    started = true;
    const start: AgentActivity = {
      ...base,
      phase: 'start',
      ...(focus.pageId ? { pageId: focus.pageId } : {}),
      ...(focus.nodeIds.length > 0 ? { nodeIds: focus.nodeIds } : {}),
      at: new Date().toISOString(),
    };
    reportAgentActivity(siteId, company, start);
  };
  const needs = START_AFTER[call.tool];
  if (!needs) reportStart();
  const permitted: PermittedFn = (action) => {
    if (action === needs) reportStart();
  };

  let result: ToolResult | undefined;
  try {
    result = await run(base.callId, needs ? permitted : undefined);
    return result;
  } finally {
    const answered = answerFocus(result, call.args);
    const outcome = outcomeOf(result);
    // The ids in the arguments are the caller's words: only a call the site accepted vouches for them
    // (a rejected or failed one may name anything), so only then do they travel again in the end and
    // the feed line. The answer's own ids always can.
    const named = outcome === 'ok' ? focus : { nodeIds: [] as string[] };
    const nodeIds = [...new Set([...named.nodeIds, ...answered.nodeIds])].slice(0, LIVE_LIST_MAX);
    const pageId = ('pageId' in named ? named.pageId : undefined) ?? answered.pageId;
    const ops = record(call.args).ops;
    const changes = Array.isArray(ops) ? ops.length : undefined;
    // Like the named ids: a refused batch deleted nothing, whatever it names.
    const deleted = outcome === 'ok' ? deletedPagesOf(call.args) : { ids: [] as string[], count: 0 };
    const deletion = deleted.count > 0 ? { deletedPages: deleted.count, ...(deleted.ids.length > 0 ? { deletedPageIds: deleted.ids } : {}) } : {};
    const end: AgentActivity = {
      ...base,
      phase: 'end',
      outcome,
      ...(pageId ? { pageId } : {}),
      ...(nodeIds.length > 0 ? { nodeIds } : {}),
      ...(changes !== undefined ? { changes } : {}),
      ...deletion,
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
          ...deletion,
          at: end.at,
        };
    // Nothing after the end may draw the frame again.
    started = true;
    reportAgentActivity(siteId, company, end, line);
  }
}
