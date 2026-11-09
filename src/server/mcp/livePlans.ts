import 'server-only';

// src/server/mcp/livePlans.ts
//
// The skeleton plans of the live agent canvas (plan
// docs/plans/2026-11-08-live-agent-canvas.md, section 3): the sections an agent
// announced with announce_sections before it writes them, which open editors
// draw as skeletons until a batch creates each section's ref.
//
// Kept in process memory, beside the MCP approvals (./approvals.ts), because
// production runs one container (the plan's section 7 says what moves with
// more than one). Nothing here is written to the document, saved or versioned.
//
// Tenant isolation: a plan is announced only after the site was loaded through
// the key's own scope (siteOps.checkPlanAnchor), and every plan keeps that
// scope. The editor's stream reads plans with the scope its own guard
// verified (plansSnapshot), so a site id another company names never shows
// its plans. Only the key that announced a plan may clear it, refresh it or
// fulfil it: a key is one company's, so another company's key never touches it.
//
// How a plan ends (each one sends `plan:update` with `ended`):
//   - fulfilled: every section's ref appeared in a committed batch of its key
//     (fulfilFromBatch, from apply_batch's `created`);
//   - cleared: clear_sections;
//   - replaced: a new announce named it in `replaces` (said by the new plan's own
//     update, which carries `replaces`, so the editor swaps the two in one step);
//   - expired: PLAN_LIMITS.idleMs after the key's last call on the site (every
//     call refreshes it, touchPlans), PLAN_LIMITS.maxMs after it was announced
//     at most;
//   - session_ended: the MCP client ended its session (DELETE /api/mcp);
//   - anchor_removed: a write of the working copy left its page, or its `after`
//     section as a top-level section of that page, out (checkPlanAnchors);
//   - evicted: a company holds plans on PLAN_SITES_PER_COMPANY sites and a new
//     one needs the room (its own least recently touched site goes first, never
//     another company's), or the process holds plans of PLAN_SITES_MAX sites
//     (the least recently touched site of any company goes).
//
// Expiry runs on one timer while any plan exists, and every read sweeps first,
// so a plan whose time ran out is never handed to a reconnecting editor. Kept
// on globalThis so a development hot reload does not split writers and readers.

import { randomUUID } from 'node:crypto';
import {
  LIVE_EVENTS,
  PLAN_LIMITS,
  PLAN_STOPPED_TOOL,
  stoppedPlanLineId,
  type LivePlan,
  type LivePlanSection,
  type PlanEndReason,
  type PlanSectionKind,
  type PlanUpdateEvent,
} from '@/lib/projects/liveEvents';
import type { TenantScope } from '@/server/sites/repository';
import { publishSiteEvent } from '@/server/sites/liveBus';
import { recordLiveFeedLine } from '@/server/sites/livePresence';
import { sanitizeLiveLabel } from '@/lib/projects/liveEvents';

/** Sites holding plans at once; past it the least recently touched site's plans end. */
export const PLAN_SITES_MAX = 2000;
/** Sites one company (tenant group) holds plans on at once; past it its own least recently touched site's plans end first. */
export const PLAN_SITES_PER_COMPANY = 200;
/** Sites whose last written version is remembered (to refuse an announcement checked against an older read). */
export const WRITTEN_VERSIONS_MAX = 5000;
/** How often expired plans are looked for while any plan exists. */
export const PLAN_SWEEP_MS = 5_000;

interface PlanEntry {
  plan: LivePlan;
  scope: TenantScope;
  /** The MCP session the plan was announced in (its id's random part), when the client sent one. */
  session?: string;
  createdAt: number;
  lastCallAt: number;
}

interface PlansState {
  /** Site id to its plans (plan id to entry), the most recently touched site last. */
  sites: Map<string, Map<string, PlanEntry>>;
  /** Site id to the newest version a write committed (the most recently written last). */
  written: Map<string, number>;
  /** When the newest of the entries `written` had to forget was written (ms), 0 when none was. */
  forgottenAt: number;
  timer?: ReturnType<typeof setInterval>;
}

const KEY = Symbol.for('lumitra.livePlans');

function state(): PlansState {
  const g = globalThis as unknown as Record<symbol, PlansState | undefined>;
  let s = g[KEY];
  if (!s) {
    s = { sites: new Map(), written: new Map(), forgottenAt: 0 };
    g[KEY] = s;
  }
  return s;
}

function sameScope(a: TenantScope, b: TenantScope): boolean {
  return a.workspaceId === b.workspaceId && a.tenantGroupId === b.tenantGroupId;
}

function expiresAt(entry: PlanEntry): number {
  return Math.min(entry.lastCallAt + PLAN_LIMITS.idleMs, entry.createdAt + PLAN_LIMITS.maxMs);
}

/** The plan as it travels: a copy, with its current expiry. */
function view(entry: PlanEntry): LivePlan {
  const p = entry.plan;
  return {
    ...p,
    ...(p.newPage ? { newPage: { ...p.newPage } } : {}),
    sections: p.sections.map((s) => ({ ...s })),
    expiresAt: new Date(expiresAt(entry)).toISOString(),
  };
}

function publish(siteId: string, event: PlanUpdateEvent): void {
  publishSiteEvent(siteId, LIVE_EVENTS.planUpdate, event);
}

/** End one plan: forget it, tell the site's editors, and leave a feed line when its agent stopped. */
function end(siteId: string, entry: PlanEntry, reason: PlanEndReason, now: number): void {
  const plans = state().sites.get(siteId);
  plans?.delete(entry.plan.planId);
  if (plans && plans.size === 0) state().sites.delete(siteId);
  if (reason === 'expired' || reason === 'session_ended') {
    recordLiveFeedLine(siteId, entry.scope.tenantGroupId, {
      id: stoppedPlanLineId(entry.plan.planId),
      agentId: entry.plan.agentId,
      label: entry.plan.label,
      actorKind: 'key',
      tool: PLAN_STOPPED_TOOL,
      outcome: 'ok',
      ...(entry.plan.pageId ? { pageId: entry.plan.pageId } : {}),
      at: new Date(now).toISOString(),
    });
  }
  publish(siteId, { plan: view(entry), ended: reason });
  stopTimerWhenIdle();
}

function sweep(now: number): void {
  for (const [siteId, plans] of [...state().sites]) {
    for (const entry of [...plans.values()]) {
      if (expiresAt(entry) <= now) end(siteId, entry, 'expired', now);
    }
  }
}

function ensureTimer(): void {
  const s = state();
  if (s.timer || s.sites.size === 0) return;
  s.timer = setInterval(() => {
    try {
      sweep(Date.now());
    } catch (err) {
      console.error('[live] the skeleton plans could not be swept', err);
    }
  }, PLAN_SWEEP_MS);
  // Never keeps the process alive on its own.
  (s.timer as { unref?: () => void }).unref?.();
}

function stopTimerWhenIdle(): void {
  const s = state();
  if (s.sites.size > 0 || !s.timer) return;
  clearInterval(s.timer);
  s.timer = undefined;
}

/** The site's plans, marked most recently touched (created when asked to). */
function sitePlans(siteId: string, create: boolean): Map<string, PlanEntry> | undefined {
  const { sites } = state();
  let plans = sites.get(siteId);
  if (plans) {
    sites.delete(siteId);
    sites.set(siteId, plans);
    return plans;
  }
  if (!create) return undefined;
  plans = new Map();
  sites.set(siteId, plans);
  return plans;
}

function endSite(siteId: string, now: number): void {
  for (const entry of [...(state().sites.get(siteId)?.values() ?? [])]) end(siteId, entry, 'evicted', now);
  state().sites.delete(siteId);
}

/**
 * Make room after `keep` got a plan: a company over its share loses its own least
 * recently touched site's plans first, so one company never pushes out another's;
 * past the process bound, the least recently touched site of any company goes.
 */
function evictSites(keep: string, group: string, now: number): void {
  const { sites } = state();
  const ofGroup = () => [...sites.entries()].filter(([, plans]) => [...plans.values()].some((e) => e.scope.tenantGroupId === group)).map(([id]) => id);
  let mine = ofGroup();
  while (mine.length > PLAN_SITES_PER_COMPANY) {
    const oldest = mine.find((id) => id !== keep);
    if (!oldest) break;
    endSite(oldest, now);
    mine = ofGroup();
  }
  while (sites.size > PLAN_SITES_MAX) {
    const oldest = [...sites.keys()].find((id) => id !== keep);
    if (!oldest) return;
    endSite(oldest, now);
  }
}

/**
 * A write of the site's working copy committed at `version` (the repository
 * calls this for every write, before it is announced). Bounded: the least
 * recently written site is forgotten first.
 */
export function noteSiteWrite(siteId: string, version: number, now: number = Date.now()): void {
  const s = state();
  const before = s.written.get(siteId) ?? 0;
  s.written.delete(siteId);
  s.written.set(siteId, Math.max(before, version));
  // A forgotten entry was written at most now: an announcement read before this moment cannot be vouched for.
  while (s.written.size > WRITTEN_VERSIONS_MAX) {
    s.written.delete(s.written.keys().next().value as string);
    s.forgottenAt = now;
  }
}

export interface AnnounceInput {
  siteId: string;
  /** The scope the site was confirmed in (the key's own). */
  scope: TenantScope;
  agentId: string;
  label: string;
  session?: string;
  pageId?: string;
  newPage?: { ref: string; title: string };
  after?: string;
  replaces?: string;
  /**
   * The site version the anchor was checked on. A write committed since (it may
   * have removed the page or the after section before this plan existed to be
   * checked) refuses the announcement with `site_changed`.
   */
  checkedVersion?: number;
  /** When that read started (ms): with the site's entry forgotten, a read older than the newest forgotten write is refused too. */
  checkedAt?: number;
  /** Titles sanitised already (sanitizePlanTitle). */
  sections: Array<{ ref: string; title: string; kind: PlanSectionKind }>;
}

export type AnnounceOutcome =
  | { ok: true; plan: LivePlan }
  | { ok: false; code: 'plan_not_found' | 'too_many_plans' | 'site_changed'; message: string; currentVersion?: number };

/**
 * Announce a plan (or replace one of the same key in the same step). A
 * section re-announced with a ref the replaced plan already saw created stays
 * fulfilled, so no skeleton ever stands over a real section.
 */
export function announcePlan(input: AnnounceInput, now: number = Date.now()): AnnounceOutcome {
  sweep(now);
  const lastWrite = state().written.get(input.siteId);
  const unknown = lastWrite === undefined && input.checkedAt !== undefined && state().forgottenAt >= input.checkedAt;
  if ((input.checkedVersion !== undefined && lastWrite !== undefined && lastWrite > input.checkedVersion) || unknown) {
    return {
      ok: false,
      code: 'site_changed',
      message: 'the site was written while the announcement was checked; read the page again (get_page) and announce on its current sections',
      ...(lastWrite !== undefined ? { currentVersion: lastWrite } : {}),
    };
  }
  const existing = sitePlans(input.siteId, false);
  let replaced: PlanEntry | undefined;
  if (input.replaces) {
    replaced = existing?.get(input.replaces);
    if (!replaced || replaced.plan.agentId !== input.agentId || !sameScope(replaced.scope, input.scope)) {
      return { ok: false, code: 'plan_not_found', message: 'replaces names no live plan of this key on this site (it ended, was cleared, or never existed); announce without replaces' };
    }
  }
  const others = [...(existing?.values() ?? [])].filter((e) => e !== replaced);
  if (others.filter((e) => e.plan.agentId === input.agentId).length >= PLAN_LIMITS.plansPerKeyPerSite) {
    return {
      ok: false,
      code: 'too_many_plans',
      message: `one key holds at most ${PLAN_LIMITS.plansPerKeyPerSite} announced plans on a site; clear one with clear_sections, replace it (replaces), or write its sections first`,
    };
  }
  const live = others.length;
  if (live >= PLAN_LIMITS.plansPerSite) {
    return {
      ok: false,
      code: 'too_many_plans',
      message: `a site holds at most ${PLAN_LIMITS.plansPerSite} announced plans at once; clear one of yours with clear_sections, replace it (replaces), or write the sections first`,
    };
  }
  const before = new Map((replaced?.plan.sections ?? []).filter((s) => s.fulfilledAt !== undefined).map((s) => [s.ref, s]));
  const sections: LivePlanSection[] = input.sections.map((s) => {
    const done = before.get(s.ref);
    return { ref: s.ref, title: s.title, kind: s.kind, ...(done ? { fulfilledAt: done.fulfilledAt, nodeId: done.nodeId } : {}) };
  });
  // A new page the replaced plan already saw created keeps it, so its skeletons never go back into a ghost frame.
  const madePage =
    input.newPage && replaced?.plan.newPage?.ref === input.newPage.ref && replaced.plan.pageId !== undefined
      ? { pageId: replaced.plan.pageId, ...(replaced.plan.pageAt !== undefined ? { pageAt: replaced.plan.pageAt } : {}) }
      : undefined;
  const plan: LivePlan = {
    planId: randomUUID(),
    agentId: input.agentId,
    label: sanitizeLiveLabel(input.label) ?? 'Agent',
    ...(input.pageId ? { pageId: input.pageId } : {}),
    ...(input.newPage ? { newPage: { ...input.newPage } } : {}),
    ...(madePage ?? {}),
    ...(input.after ? { after: input.after } : {}),
    sections,
    expiresAt: '',
  };
  // A replace is the same work revised: it keeps the replaced plan's start, so replacing never outlasts the cap.
  const entry: PlanEntry = {
    plan,
    scope: { ...input.scope },
    ...(input.session ? { session: input.session } : {}),
    createdAt: replaced ? replaced.createdAt : now,
    lastCallAt: now,
  };
  const plans = sitePlans(input.siteId, true)!;
  if (replaced) plans.delete(replaced.plan.planId);
  plans.set(plan.planId, entry);
  evictSites(input.siteId, input.scope.tenantGroupId, now);
  ensureTimer();
  const out = view(entry);
  publish(input.siteId, { plan: out, ...(replaced ? { replaces: replaced.plan.planId } : {}) });
  // Every section already created (a replace that kept only done sections): nothing left to draw.
  if (sections.every((s) => s.fulfilledAt !== undefined)) end(input.siteId, entry, 'fulfilled', now);
  return { ok: true, plan: out };
}

/** Clear a plan of this key; false when the site has no such live plan of it. */
export function clearPlan(siteId: string, agentId: string, planId: string, now: number = Date.now()): boolean {
  sweep(now);
  const entry = sitePlans(siteId, false)?.get(planId);
  if (!entry || entry.plan.agentId !== agentId) return false;
  end(siteId, entry, 'cleared', now);
  return true;
}

/**
 * A call of the key: its plans on the site the call names live
 * PLAN_LIMITS.idleMs from now (never past their cap). A call that names no
 * site (a stock photo search, list_sites) between two batches is part of the
 * same work, so it refreshes the key's plans on every site. Creates nothing.
 */
export function touchPlans(siteId: string | undefined, agentId: string, now: number = Date.now()): void {
  const { sites } = state();
  const targets = siteId === undefined ? [...sites.values()] : [sites.get(siteId)].filter((p): p is Map<string, PlanEntry> => !!p);
  for (const plans of targets) {
    for (const entry of plans.values()) if (entry.plan.agentId === agentId && expiresAt(entry) > now) entry.lastCallAt = now;
  }
}

/**
 * A batch of the key committed at `version` and created these refs (ref to id):
 * a plan's new page is fulfilled by a createPage ref (`pageIds` holds the pages
 * the batch created), a section by a node ref created on the plan's own page
 * (`refPages`, ref to the page it landed on). A plan with every section
 * created ends. Refs another key created, or created on another page, fulfil
 * nothing here. Runs before the write is announced (siteOps.applyBatch).
 */
export function fulfilFromBatch(
  siteId: string,
  agentId: string,
  created: Record<string, unknown>,
  version: number,
  refPages: Readonly<Record<string, string>>,
  pageIds: readonly string[],
  now: number = Date.now(),
): void {
  sweep(now);
  const plans = state().sites.get(siteId);
  if (!plans) return;
  for (const entry of [...plans.values()]) {
    if (entry.plan.agentId !== agentId) continue;
    const plan = entry.plan;
    let changed = false;
    if (plan.newPage && plan.pageId === undefined) {
      const pageId = created[plan.newPage.ref];
      if (typeof pageId === 'string' && pageIds.includes(pageId)) {
        plan.pageId = pageId;
        plan.pageAt = version;
        changed = true;
      }
    }
    for (const section of plan.sections) {
      if (section.fulfilledAt !== undefined) continue;
      const nodeId = created[section.ref];
      if (typeof nodeId !== 'string' || plan.pageId === undefined || refPages[section.ref] !== plan.pageId) continue;
      section.fulfilledAt = version;
      section.nodeId = nodeId;
      changed = true;
    }
    if (!changed) continue;
    if (plan.sections.every((s) => s.fulfilledAt !== undefined)) end(siteId, entry, 'fulfilled', now);
    else publish(siteId, { plan: view(entry) });
  }
}

/** The ref of a live, unfulfilled section of the key's plans on the site among `refs` (the first that matches), for the presence frame. */
export function sectionRefFor(siteId: string, agentId: string, refs: readonly string[], now: number = Date.now()): string | undefined {
  const plans = state().sites.get(siteId);
  if (!plans || refs.length === 0) return undefined;
  for (const ref of refs) {
    for (const entry of plans.values()) {
      if (entry.plan.agentId !== agentId || expiresAt(entry) <= now) continue;
      if (entry.plan.sections.some((s) => s.ref === ref && s.fulfilledAt === undefined)) return ref;
    }
  }
  return undefined;
}

/** The key's MCP session ended: its plans of that session end on every site. */
export function endSessionPlans(agentId: string, session: string, now: number = Date.now()): number {
  let ended = 0;
  for (const [siteId, plans] of [...state().sites]) {
    for (const entry of [...plans.values()]) {
      if (entry.plan.agentId === agentId && entry.session === session) {
        end(siteId, entry, 'session_ended', now);
        ended += 1;
      }
    }
  }
  return ended;
}

/** Whether the site holds any plan (a cheap check before reading a written document). */
export function hasPlans(siteId: string): boolean {
  return (state().sites.get(siteId)?.size ?? 0) > 0;
}

/** The part of a page snapshot the anchor check reads. */
interface AnchorNode {
  id?: unknown;
  children?: unknown;
}

/** The ids of a page's top-level sections (the page root's children), from a stored page snapshot. */
export function topLevelSectionIds(pageSnapshot: unknown): Set<string> {
  const root = (pageSnapshot as { appComponentTree?: AnchorNode } | null)?.appComponentTree;
  const children = Array.isArray(root?.children) ? (root.children as AnchorNode[]) : [];
  return new Set(children.map((c) => c?.id).filter((id): id is string => typeof id === 'string'));
}

/**
 * A write of the working copy committed: plans whose page is gone, or whose
 * `after` is no longer a top-level section of that page, end (the plan is
 * derived state of its anchor). A new page's plan before its page exists has no
 * anchor yet. Never throws.
 */
export function checkPlanAnchors(siteId: string, pages: ReadonlyArray<{ pageId: string; snapshot: unknown }>, now: number = Date.now()): void {
  try {
    const plans = state().sites.get(siteId);
    if (!plans) return;
    const byId = new Map(pages.map((p) => [p.pageId, p.snapshot]));
    for (const entry of [...plans.values()]) {
      const { pageId, after } = entry.plan;
      if (!pageId) continue;
      const snapshot = byId.get(pageId);
      const gone = snapshot === undefined || (after !== undefined && !topLevelSectionIds(snapshot).has(after));
      if (gone) end(siteId, entry, 'anchor_removed', now);
    }
  } catch (err) {
    console.error(`[live] the skeleton plans of site ${siteId} could not be checked against a write`, err);
  }
}

/**
 * The live plans of a site, for the `state` event of a stream whose guard
 * verified `scope`: expired ones are swept first and never handed out, and a
 * plan announced under another scope is never shown.
 */
export function plansSnapshot(siteId: string, scope: TenantScope, now: number = Date.now()): LivePlan[] {
  sweep(now);
  const plans = state().sites.get(siteId);
  if (!plans) return [];
  return [...plans.values()].filter((e) => sameScope(e.scope, scope)).map(view);
}

/** Tests only: forget every plan and stop the timer. */
export function resetLivePlansForTests(): void {
  const s = state();
  s.sites.clear();
  s.written.clear();
  s.forgottenAt = 0;
  if (s.timer) clearInterval(s.timer);
  s.timer = undefined;
}

/** Tests only: run the expiry sweep now. */
export function sweepLivePlansForTests(now: number): void {
  sweep(now);
}
