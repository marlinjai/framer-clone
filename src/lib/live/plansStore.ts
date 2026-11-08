// src/lib/live/plansStore.ts
//
// The skeleton plans an open editor draws (plan docs/plans/2026-11-08-live-agent-canvas.md,
// section 3): the sections agents announced with announce_sections, fed by the
// live stream (src/lib/projects/liveSync.ts) from the `state` event and every
// `plan:update`, and drawn by src/components/live/SkeletonLayer.tsx.
//
// When a skeleton goes is decided by VERSION, never by when an event arrives.
// A batch that creates a section commits, the server announces `site:version`
// and then `plan:update` with the section's `fulfilledAt` (the version of that
// batch), and only after that does the editor fetch and adopt the copy holding
// the real section. So a section is drawn while it is unfulfilled or fulfilled at
// a version the tab does not hold yet, and `version` moves inside the adoption's
// own MobX action (`noteVersion`), the same action that starts the section's
// reveal: the skeleton is replaced by the real node in one frame, never a gap
// and never both. The same rule covers a held copy waiting for the person
// ("Keep mine" moves the version with the tab's own save), a catch-up after a
// reconnect, and a page created by the plan's own batch (`pageAt`).
//
// `anchor_removed` arrives BEFORE the `site:version` of the write that removed the
// anchor (the server checks anchors while it commits, then announces the
// write); that order is fine and must not be "fixed": the skeleton goes, then
// the copy without its anchor arrives. The layer also resolves the anchor
// against the open copy on every draw, so a section the person deleted stops
// carrying skeletons at once, even before the save that tells the server.
//
// How a plan leaves: fulfilled, it stays until every section it still draws is
// in the tab's copy (FULFILLED_SETTLE_MAX_MS at most); expired or its session
// ended (the agent stopped), it fades for PLAN_FADE_MS and leaves the feed line
// the server also keeps; cleared, evicted or its anchor gone, at once. A
// replace swaps the two plans in one action. A plan is never held longer than
// PLAN_HELD_MAX_MS after it was last heard, whatever the server's clock says.
//
// Volatile: never in the project, a save or the history; reset when the site
// is closed.

import { action, makeObservable, observable } from 'mobx';
import {
  PLAN_LIMITS,
  PLAN_SECTION_KINDS,
  PLAN_STOPPED_TOOL,
  sanitizePlanTitle,
  stoppedPlanLineId,
  type LiveFeedLine,
  type LivePlan,
  type LivePlanSection,
  type PlanUpdateEvent,
} from '@/lib/projects/liveEvents';

/** The fade of a plan whose agent stopped, in milliseconds (ease-out, under 300). */
export const PLAN_FADE_MS = 200;
/** A fulfilled plan waits at most this long for the tab to hold its last sections. */
export const FULFILLED_SETTLE_MAX_MS = 15_000;
/** A plan is dropped this long after it was last heard, should its end never arrive. */
export const PLAN_HELD_MAX_MS = PLAN_LIMITS.maxMs + 60_000;

export interface HeldPlan {
  plan: LivePlan;
  /** Fading out (its agent stopped). */
  leaving: boolean;
}

/** Where a skeleton group stands on its page: after a top-level section, or at the end. */
export interface SkeletonSlot {
  plan: LivePlan;
  section: LivePlanSection;
  leaving: boolean;
}

const ID = /^[A-Za-z0-9_-]{1,200}$/;
const REF = /^[A-Za-z0-9_-]{1,64}$/;

function str(value: unknown): value is string {
  return typeof value === 'string';
}

/** A plan from the stream, checked: anything malformed is dropped rather than drawn. Titles are cleaned again. */
export function readPlan(raw: unknown): LivePlan | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const p = raw as Record<string, unknown>;
  if (!str(p.planId) || !ID.test(p.planId) || !str(p.agentId) || !Array.isArray(p.sections)) return undefined;
  const sections: LivePlanSection[] = [];
  for (const s of p.sections.slice(0, PLAN_LIMITS.sectionsPerPlan) as unknown[]) {
    const x = (typeof s === 'object' && s !== null ? s : {}) as Record<string, unknown>;
    if (!str(x.ref) || !REF.test(x.ref)) continue;
    const kind = (PLAN_SECTION_KINDS as readonly string[]).includes(x.kind as string) ? (x.kind as LivePlanSection['kind']) : 'generic';
    sections.push({
      ref: x.ref,
      title: sanitizePlanTitle(x.title) ?? '',
      kind,
      ...(typeof x.fulfilledAt === 'number' ? { fulfilledAt: x.fulfilledAt } : {}),
      ...(str(x.nodeId) && ID.test(x.nodeId) ? { nodeId: x.nodeId } : {}),
    });
  }
  const newPage = typeof p.newPage === 'object' && p.newPage !== null ? (p.newPage as Record<string, unknown>) : undefined;
  return {
    planId: p.planId,
    agentId: p.agentId,
    label: sanitizePlanTitle(p.label) ?? 'Agent',
    ...(str(p.pageId) && ID.test(p.pageId) ? { pageId: p.pageId } : {}),
    ...(newPage && str(newPage.ref) ? { newPage: { ref: newPage.ref, title: sanitizePlanTitle(newPage.title) ?? '' } } : {}),
    ...(typeof p.pageAt === 'number' ? { pageAt: p.pageAt } : {}),
    ...(str(p.after) && ID.test(p.after) ? { after: p.after } : {}),
    sections,
    expiresAt: str(p.expiresAt) ? p.expiresAt : '',
  };
}

export class LivePlansStore {
  /** Plan id to the plan as last heard. */
  plans = new Map<string, HeldPlan>();
  /** The site version the tab's copy holds: a section fulfilled at or below it is drawn by the real node. */
  version = 0;

  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private held = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    makeObservable<LivePlansStore, 'drop' | 'prune'>(this, {
      plans: observable.shallow,
      version: observable,
      applyState: action,
      applyUpdate: action,
      noteVersion: action,
      reset: action,
      drop: action,
      prune: action,
    });
  }

  /** Whether a section still draws a skeleton (unfulfilled, or fulfilled in a version the tab does not hold yet). */
  drawsSection(section: LivePlanSection): boolean {
    return section.fulfilledAt === undefined || section.fulfilledAt > this.version;
  }

  /** Whether a plan's sections stand in a ghost page frame (a new page the tab does not hold yet). */
  inGhostFrame(plan: LivePlan): boolean {
    return !!plan.newPage && (plan.pageId === undefined || plan.pageAt === undefined || plan.pageAt > this.version);
  }

  /** The skeletons to draw on a page, in plan order: sections still drawn, of plans standing on that page. */
  onPage(pageId: string | undefined): Array<{ plan: LivePlan; leaving: boolean; sections: LivePlanSection[] }> {
    if (!pageId) return [];
    const out: Array<{ plan: LivePlan; leaving: boolean; sections: LivePlanSection[] }> = [];
    for (const { plan, leaving } of this.plans.values()) {
      if (plan.pageId !== pageId || this.inGhostFrame(plan)) continue;
      const sections = plan.sections.filter((s) => this.drawsSection(s));
      if (sections.length > 0) out.push({ plan, leaving, sections });
    }
    return out;
  }

  /** New pages being planned, each drawn in its ghost frame. */
  get ghostPlans(): Array<{ plan: LivePlan; leaving: boolean; sections: LivePlanSection[] }> {
    const out: Array<{ plan: LivePlan; leaving: boolean; sections: LivePlanSection[] }> = [];
    for (const { plan, leaving } of this.plans.values()) {
      if (!this.inGhostFrame(plan)) continue;
      out.push({ plan, leaving, sections: plan.sections.filter((s) => this.drawsSection(s)) });
    }
    return out;
  }

  /** The skeleton an agent fills (for the presence frame): its plan and section, while it is drawn. */
  skeletonOf(agentId: string, ref: string | undefined): { plan: LivePlan; section: LivePlanSection } | undefined {
    if (!ref) return undefined;
    for (const { plan, leaving } of this.plans.values()) {
      if (leaving || plan.agentId !== agentId) continue;
      const section = plan.sections.find((s) => s.ref === ref);
      if (section && this.drawsSection(section)) return { plan, section };
    }
    return undefined;
  }

  /** The `state` event of a (re)connect: the live plans replace what this tab held. `version` is the tab's own. */
  applyState(plans: unknown, version: number | undefined): void {
    this.clearTimers();
    this.plans.clear();
    if (version !== undefined && version > this.version) this.version = version;
    for (const raw of Array.isArray(plans) ? plans : []) {
      const plan = readPlan(raw);
      if (plan) this.set(plan);
    }
    this.prune();
  }

  /**
   * One `plan:update`. Answers the feed line to add when the plan ended
   * because its agent stopped (the server keeps the same line, same id).
   */
  applyUpdate(raw: unknown): LiveFeedLine | undefined {
    const event = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<PlanUpdateEvent>;
    const plan = readPlan(event.plan);
    if (!plan) return undefined;
    if (event.replaces) this.drop(event.replaces);
    switch (event.ended) {
      case undefined:
        this.set(plan);
        this.prune();
        return undefined;
      case 'fulfilled':
        // Kept until the tab holds every section it still draws.
        this.set(plan);
        this.prune();
        if (this.plans.has(plan.planId)) this.later(plan.planId, FULFILLED_SETTLE_MAX_MS);
        return undefined;
      case 'expired':
      case 'session_ended': {
        if (this.plans.has(plan.planId)) {
          this.plans.set(plan.planId, { plan: this.plans.get(plan.planId)!.plan, leaving: true });
          this.later(plan.planId, PLAN_FADE_MS);
        }
        return {
          id: stoppedPlanLineId(plan.planId),
          agentId: plan.agentId,
          label: plan.label,
          actorKind: 'key',
          tool: PLAN_STOPPED_TOOL,
          outcome: 'ok',
          ...(plan.pageId ? { pageId: plan.pageId } : {}),
          at: new Date().toISOString(),
        };
      }
      default:
        this.drop(plan.planId);
        return undefined;
    }
  }

  /** The tab holds this version now (an adoption, its own save): sections fulfilled up to it are drawn by the real nodes. */
  noteVersion(version: number): void {
    if (version <= this.version) return;
    this.version = version;
    this.prune();
  }

  reset(): void {
    this.clearTimers();
    this.plans.clear();
    this.version = 0;
  }

  private set(plan: LivePlan): void {
    this.plans.set(plan.planId, { plan, leaving: false });
    const old = this.held.get(plan.planId);
    if (old) clearTimeout(old);
    this.held.set(
      plan.planId,
      setTimeout(() => this.drop(plan.planId), PLAN_HELD_MAX_MS),
    );
  }

  private later(planId: string, ms: number): void {
    const old = this.timers.get(planId);
    if (old) clearTimeout(old);
    this.timers.set(
      planId,
      setTimeout(() => this.drop(planId), ms),
    );
  }

  private drop(planId: string): void {
    this.plans.delete(planId);
    for (const map of [this.timers, this.held]) {
      const timer = map.get(planId);
      if (timer) clearTimeout(timer);
      map.delete(planId);
    }
  }

  /** A fulfilled plan with nothing left to draw goes (a live one with sections left stays). */
  private prune(): void {
    for (const [planId, { plan }] of [...this.plans]) {
      const allDone = plan.sections.every((s) => s.fulfilledAt !== undefined);
      if (allDone && !plan.sections.some((s) => this.drawsSection(s)) && !this.inGhostFrame(plan)) this.drop(planId);
    }
  }

  private clearTimers(): void {
    for (const timer of [...this.timers.values(), ...this.held.values()]) clearTimeout(timer);
    this.timers.clear();
    this.held.clear();
  }
}
