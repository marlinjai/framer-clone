// src/lib/live/generationDraft.ts
//
// The draft of an agent's generate_page in the open editor (plan
// docs/plans/2026-11-08-live-agent-canvas.md, section 3, "The MCP generate_page
// streams its draft to open editors"). The site's stream (src/lib/projects/liveSync.ts)
// hands this module `gen:outline`, `gen:section`, `gen:done` and the `state`
// event's running generation; it draws them with the editor's own Generate draft
// (src/lib/ai/pageGen/draft.ts, src/components/ai/PageGenDraftLayer.tsx),
// skeletons and all, keyed `agent:<runId>`.
//
// The rules:
//   - **One draft at a time, the person's own Generate first.** The draft store is
//     shared with the Generate dialog. While the person's own run holds it, the
//     agent's events are only remembered here; the next one after that run ended
//     draws the agent's draft from what was remembered. A newer agent run
//     replaces an older one.
//   - **The draft ends by version, never by when an event arrives.** `gen:done`
//     with status `saved` comes before the `site:version` of the save; the draft
//     stays until this tab adopts that version and goes in the same MobX action
//     as the adoption (`settle`, called by LiveSync.adopt), so the draft and the
//     saved result never show together, nor neither. A copy held for the person
//     (unsaved edits) leaves the draft at most GEN_DRAFT_LIMITS.settleMs.
//   - **Any other end drops the draft at once** (stopped, failed, rejected, site
//     changed, expired, superseded): nothing was written. The activity feed
//     already says why, from the generate_page call's own end (slice 2).
//   - **Resume:** a `state` event replaces what is remembered: its running
//     generation draws the same draft again (the store ignores sections it holds),
//     and a `state` without one drops the draft unless a saved result is
//     still being fetched.
//   - **Where it is drawn** is resolved against this tab's copy: in place of, or
//     inside, the named node with the page's own breakpoints; a new page as draft
//     frames beside whichever page is on screen. A target this copy does not
//     have yet (a node a newer version made) draws nothing until the next event.
//   - A run that sends nothing for GEN_DRAFT_LIMITS.runMaxMs is given up on.

import { runInAction } from 'mobx';
import type { ProjectModelType } from '@/models/ProjectModel';
import type { ComponentInstance } from '@/models/ComponentModel';
import { DEFAULT_VIEWPORTS } from '@/lib/canvas/defaultViewports';
import { shopLocaleOf } from '@/lib/commerce/parts';
import type { PageGenDraftStore, PageGenDraftTarget } from '@/lib/ai/pageGen/draft';
import {
  GEN_DRAFT_LIMITS,
  sanitizePlanTitle,
  type GenDoneEvent,
  type GenDraftSection,
  type GenDraftTarget,
  type GenOutlineEvent,
  type GenSectionEvent,
  type LiveGeneration,
} from '@/lib/projects/liveEvents';

const AGENT_KEY_PREFIX = 'agent:';

/** The draft store's request key of an agent's run. */
export function agentDraftKey(runId: string): string {
  return `${AGENT_KEY_PREFIX}${runId}`;
}

/** Whether a draft key belongs to an agent's run (else to the person's own Generate). */
export function isAgentDraftKey(key: string | undefined): boolean {
  return !!key && key.startsWith(AGENT_KEY_PREFIX);
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

function validTarget(raw: unknown): GenDraftTarget | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as Record<string, unknown>;
  if (t.kind === 'newPage') {
    const title = sanitizePlanTitle(t.title);
    return title ? { kind: 'newPage', title } : { kind: 'newPage' };
  }
  if (typeof t.pageId !== 'string' || !ID.test(t.pageId)) return undefined;
  if (t.kind === 'replace' && typeof t.nodeId === 'string' && ID.test(t.nodeId)) return { kind: 'replace', pageId: t.pageId, nodeId: t.nodeId };
  if (t.kind === 'insert' && typeof t.parentId === 'string' && ID.test(t.parentId)) return { kind: 'insert', pageId: t.pageId, parentId: t.parentId };
  return undefined;
}

function validRunId(raw: unknown): raw is string {
  return typeof raw === 'string' && ID.test(raw);
}

function validSection(raw: unknown): GenDraftSection | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Record<string, unknown>;
  if (!Number.isInteger(s.index) || (s.index as number) < 0 || !s.node || typeof s.node !== 'object') return undefined;
  const slot = Number.isInteger(s.slot) && (s.slot as number) >= 0 ? (s.slot as number) : (s.index as number);
  return { index: s.index as number, slot, node: s.node as GenDraftSection['node'] };
}

function findIn(node: ComponentInstance, id: string): ComponentInstance | undefined {
  if (node.id === id) return node;
  for (const child of node.children as ComponentInstance[]) {
    const hit = findIn(child, id);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Where this tab draws an agent's draft, or undefined when its copy has no such
 * place (yet). Pure apart from the fresh breakpoint ids of a new page's frames.
 */
export function resolveAgentDraftTarget(
  runId: string,
  target: GenDraftTarget,
  project: ProjectModelType | undefined,
  currentPageId: string | undefined,
): PageGenDraftTarget | undefined {
  if (!project) return undefined;
  const locale = shopLocaleOf(project.siteSettings?.language);
  const requestKey = agentDraftKey(runId);
  if (target.kind === 'newPage') {
    // The server made the same three frames (src/lib/siteOps/generated.ts); the
    // styles are keyed by breakpoint label, so ids of this tab's own fit them.
    const viewports = DEFAULT_VIEWPORTS.map((v) => ({
      breakpointId: globalThis.crypto.randomUUID(),
      label: v.label,
      minWidth: v.minWidth,
      x: v.x,
      y: v.y,
      width: v.width,
      height: v.height,
    }));
    return {
      requestKey,
      kind: 'newPage',
      pageId: currentPageId ?? '',
      followsCurrentPage: true,
      targetIsRoot: false,
      title: target.title || 'New page',
      breakpoints: viewports.map((v) => ({ id: v.breakpointId, label: v.label, minWidth: v.minWidth })),
      viewports,
      locale,
    };
  }
  const page = project.getPage(target.pageId);
  if (!page) return undefined;
  const root = page.appComponentTree as ComponentInstance;
  const componentId = target.kind === 'replace' ? target.nodeId : target.parentId;
  if (!findIn(root, componentId)) return undefined;
  const viewports = (page.viewportNodes as ComponentInstance[])
    .filter((v) => v.breakpointId)
    .map((v) => ({
      breakpointId: v.breakpointId as string,
      label: (v.label as string | undefined) ?? '',
      minWidth: (v.breakpointMinWidth as number | undefined) ?? 0,
      x: (v.canvasX as number | undefined) ?? 0,
      y: (v.canvasY as number | undefined) ?? 0,
      width: (v.viewportWidth as number | undefined) ?? 400,
      height: (v.viewportHeight as number | undefined) ?? 600,
    }));
  // No frames, nothing to draw in (the result adds the default three).
  if (viewports.length === 0) return undefined;
  return {
    requestKey,
    kind: target.kind,
    pageId: page.id,
    componentId,
    targetIsRoot: componentId === root.id,
    title: '',
    breakpoints: viewports.map((v) => ({ id: v.breakpointId, label: v.label, minWidth: v.minWidth })),
    viewports,
    locale,
  };
}

export interface GenerationDraftDeps {
  draft: () => PageGenDraftStore | undefined;
  project: () => ProjectModelType | undefined;
  currentPageId: () => string | undefined;
  /** The version this tab's copy holds. */
  knownVersion: () => number | undefined;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/** What the adoption of the saved result does besides dropping the draft. */
export interface SettledDraft {
  /** Top-level ids of the result sections the canvas already drew exactly as saved: they and their subtrees do not reveal again. */
  stillIds: string[];
  /** The result's first top-level id when the draft was a new page on screen (the editor may show that page). */
  newPageNodeId?: string;
}

interface Remembered {
  runId: string;
  target: GenDraftTarget;
  outline: GenOutlineEvent['outline'];
  sections: GenDraftSection[];
}

interface Settling {
  runId: string;
  version: number;
  insertedIds: string[];
  drawnAs: Array<number | null>;
  timer: ReturnType<typeof setTimeout>;
}

export class GenerationDraft {
  private readonly deps: GenerationDraftDeps;
  private run: Remembered | undefined;
  private settling: Settling | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: GenerationDraftDeps) {
    this.deps = deps;
  }

  private setTimer(fn: () => void, ms: number) {
    return (this.deps.setTimer ?? setTimeout)(fn, ms);
  }

  private clearTimer(timer: ReturnType<typeof setTimeout> | undefined) {
    if (timer !== undefined) (this.deps.clearTimer ?? clearTimeout)(timer);
  }

  /** The run being drawn or remembered, for tests and the layer's wording. */
  get runId(): string | undefined {
    return this.run?.runId;
  }

  /** A `state` event: its running generation replaces what was remembered. */
  applyState(raw: LiveGeneration | undefined): void {
    if (!raw || !validRunId(raw.runId)) {
      // No run on the server: a saved result still being fetched keeps its draft until it is adopted.
      if (!this.settling) this.drop();
      return;
    }
    if (this.settling?.runId === raw.runId) return;
    const target = validTarget(raw.target);
    if (!target) return;
    this.follow(raw.runId, target);
    if (Array.isArray(raw.outline)) this.run!.outline = raw.outline;
    for (const section of Array.isArray(raw.sections) ? raw.sections : []) this.remember(section);
    this.sync();
  }

  applyOutline(raw: GenOutlineEvent | undefined): void {
    if (!raw || !validRunId(raw.runId) || !Array.isArray(raw.outline)) return;
    const target = validTarget(raw.target);
    if (!target || this.settling?.runId === raw.runId) return;
    this.follow(raw.runId, target);
    this.run!.outline = raw.outline;
    this.sync();
  }

  applySection(raw: GenSectionEvent | undefined): void {
    if (!raw || !validRunId(raw.runId)) return;
    const target = validTarget(raw.target);
    if (!target || this.settling?.runId === raw.runId) return;
    this.follow(raw.runId, target);
    this.remember(raw);
    this.sync();
  }

  applyDone(raw: GenDoneEvent | undefined): void {
    if (!raw || !this.run || raw.runId !== this.run.runId || this.settling) return;
    if (raw.status === 'saved' && typeof raw.version === 'number') {
      const known = this.deps.knownVersion();
      // This tab already holds the saved version (it cannot have adopted it from this run's announcement, which comes after).
      if (known !== undefined && known >= raw.version) {
        this.drop();
        return;
      }
      this.clearTimer(this.watchdog);
      this.watchdog = undefined;
      const insertedIds = Array.isArray(raw.insertedIds) ? raw.insertedIds.filter((id): id is string => typeof id === 'string') : [];
      const drawnAs = Array.isArray(raw.drawnAs) ? raw.drawnAs.map((d) => (Number.isInteger(d) ? (d as number) : null)) : [];
      const runId = raw.runId;
      this.settling = {
        runId,
        version: raw.version,
        insertedIds,
        drawnAs,
        // A copy held for the person (or a fetch that never comes): the draft goes anyway.
        timer: this.setTimer(() => {
          if (this.settling?.runId === runId) this.drop();
        }, GEN_DRAFT_LIMITS.settleMs),
      };
      return;
    }
    this.drop();
  }

  /**
   * This tab adopted `version`; call inside the adoption's MobX action. When it
   * holds the saved result of the run being drawn, the draft goes now and the
   * answer says which result sections stay still. Undefined otherwise.
   */
  settle(version: number): SettledDraft | undefined {
    const s = this.settling;
    if (!s || version < s.version) return undefined;
    const draft = this.deps.draft();
    const key = agentDraftKey(s.runId);
    const ours = draft?.target?.requestKey === key;
    const stillIds: string[] = [];
    if (ours && draft) {
      s.insertedIds.forEach((id, i) => {
        const drawn = s.drawnAs[i];
        if (drawn !== null && drawn !== undefined && draft.isShown(drawn)) stillIds.push(id);
      });
    }
    const onScreen = ours && draft?.target?.kind === 'newPage' && !!draft.targetOn(this.deps.currentPageId());
    this.drop();
    return { stillIds, ...(onScreen && s.insertedIds[0] ? { newPageNodeId: s.insertedIds[0] } : {}) };
  }

  /** Forget everything (the editor closed the site). */
  reset(): void {
    this.drop();
  }

  private follow(runId: string, target: GenDraftTarget): void {
    if (this.run?.runId !== runId) {
      this.clearSettling();
      this.run = { runId, target, outline: [], sections: [] };
    }
    this.clearTimer(this.watchdog);
    this.watchdog = this.setTimer(() => {
      if (this.run?.runId === runId && !this.settling) this.drop();
    }, GEN_DRAFT_LIMITS.runMaxMs);
  }

  private remember(raw: unknown): void {
    const run = this.run;
    const section = validSection(raw);
    if (!run || !section || run.sections.some((s) => s.index === section.index)) return;
    if (run.sections.length >= GEN_DRAFT_LIMITS.sectionsPerRun) return;
    run.sections = [...run.sections, section].sort((a, b) => a.index - b.index);
  }

  /** Draw what is remembered, unless the person's own Generate holds the draft. */
  private sync(): void {
    const run = this.run;
    const draft = this.deps.draft();
    if (!run || !draft) return;
    const key = agentDraftKey(run.runId);
    const holder = draft.target?.requestKey;
    if (holder !== undefined && holder !== key && !isAgentDraftKey(holder)) return;
    runInAction(() => {
      if (draft.target?.requestKey !== key) {
        const target = resolveAgentDraftTarget(run.runId, run.target, this.deps.project(), this.deps.currentPageId());
        if (!target) return;
        draft.begin(target);
      }
      draft.setOutline(key, { generationId: run.runId, attempt: 1, outline: run.outline });
      for (const section of run.sections) draft.add(key, { generationId: run.runId, attempt: 1, ...section });
    });
  }

  private clearSettling(): void {
    if (this.settling) this.clearTimer(this.settling.timer);
    this.settling = undefined;
  }

  private drop(): void {
    const run = this.run;
    this.clearSettling();
    this.clearTimer(this.watchdog);
    this.watchdog = undefined;
    this.run = undefined;
    if (run) this.deps.draft()?.clear(agentDraftKey(run.runId));
  }
}
