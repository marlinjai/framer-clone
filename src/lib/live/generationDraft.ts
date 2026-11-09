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
//     replaces an older one that is still writing; one whose saved result is
//     still being fetched keeps the canvas until that result is adopted, and the
//     newer run is drawn in the same action.
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
//     still being fetched. While the stream is down (an error, a refusal, a
//     sign-out) events can be missed, the end among them, so the running run's
//     draft goes at once (`streamLost`), never to stand beside a result a poll
//     adopts; the reconnect's `state` draws it again if it still runs.
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
/** A persisted page or node id (an imported one can read `page.home` or `root:home`): up to 200 characters without whitespace or control characters, as the MCP tools take them. */
const PERSISTED_ID = /^[^\s\u0000-\u001f\u007f]{1,200}$/;

function validTarget(raw: unknown): GenDraftTarget | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as Record<string, unknown>;
  if (t.kind === 'newPage') {
    const title = sanitizePlanTitle(t.title);
    return title ? { kind: 'newPage', title } : { kind: 'newPage' };
  }
  if (typeof t.pageId !== 'string' || !PERSISTED_ID.test(t.pageId)) return undefined;
  if (t.kind === 'replace' && typeof t.nodeId === 'string' && PERSISTED_ID.test(t.nodeId)) return { kind: 'replace', pageId: t.pageId, nodeId: t.nodeId };
  if (t.kind === 'insert' && typeof t.parentId === 'string' && PERSISTED_ID.test(t.parentId)) return { kind: 'insert', pageId: t.pageId, parentId: t.parentId };
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
  /** Whether the draft's frames are visible in the canvas right now (the person is looking at them). */
  draftInView?: () => boolean;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/** What the adoption of the saved result does besides dropping the draft. */
export interface SettledDraft {
  /** Top-level ids of the result sections the canvas already drew exactly as saved: they and their subtrees do not reveal again. */
  stillIds: string[];
  /** The result's first top-level id when the draft was a new page on screen (the editor may show that page). */
  newPageNodeId?: string;
  /** Whether that new page's draft frames were visible in the canvas when the result was adopted. */
  inView?: boolean;
}

interface Remembered {
  runId: string;
  target: GenDraftTarget;
  outline: GenOutlineEvent['outline'];
  sections: GenDraftSection[];
}

/** A run whose result was saved: its draft stays drawn until this tab adopts `version`. */
interface Settling {
  runId: string;
  version: number;
  insertedIds: string[];
  /** For each result section, the preview sections identical to it (gen:done's drawnAs). */
  drawnAs: number[][];
  timer: ReturnType<typeof setTimeout>;
  /** What the run drew, so a run that saved while it waited behind an earlier one is still drawn once that one's result shows. */
  remembered: Remembered;
}

export class GenerationDraft {
  private readonly deps: GenerationDraftDeps;
  /** The run still sending events (at most one: a newer run supersedes it on the server). */
  private run: Remembered | undefined;
  /** Runs whose saved result this tab has not adopted yet, by run id. Kept apart from `run`, so a newer run never cancels an older one's ending. */
  private readonly settling = new Map<string, Settling>();
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  /** The stream went down: events may have been missed, so the next adoption drops the running draft. */
  private unsynced = false;

  constructor(deps: GenerationDraftDeps) {
    this.deps = deps;
  }

  private setTimer(fn: () => void, ms: number) {
    return (this.deps.setTimer ?? setTimeout)(fn, ms);
  }

  private clearTimer(timer: ReturnType<typeof setTimeout> | undefined) {
    if (timer !== undefined) (this.deps.clearTimer ?? clearTimeout)(timer);
  }

  /** The run being drawn or remembered, for tests. */
  get runId(): string | undefined {
    return this.run?.runId;
  }

  /** A `state` event: its running generation replaces the run remembered (a saved result still being fetched keeps its draft). */
  applyState(raw: LiveGeneration | undefined): void {
    this.unsynced = false;
    if (!raw || !validRunId(raw.runId)) {
      this.dropRun();
      return;
    }
    if (this.settling.has(raw.runId)) return;
    const target = validTarget(raw.target);
    if (!target) {
      this.dropRun();
      return;
    }
    this.follow(raw.runId, target);
    if (Array.isArray(raw.outline)) this.run!.outline = raw.outline;
    for (const section of Array.isArray(raw.sections) ? raw.sections : []) this.remember(section);
    this.sync();
  }

  applyOutline(raw: GenOutlineEvent | undefined): void {
    if (!raw || !validRunId(raw.runId) || !Array.isArray(raw.outline) || this.settling.has(raw.runId)) return;
    const target = validTarget(raw.target);
    if (!target) return;
    this.follow(raw.runId, target);
    this.run!.outline = raw.outline;
    this.sync();
  }

  applySection(raw: GenSectionEvent | undefined): void {
    if (!raw || !validRunId(raw.runId) || this.settling.has(raw.runId)) return;
    const target = validTarget(raw.target);
    if (!target) return;
    this.follow(raw.runId, target);
    this.remember(raw);
    this.sync();
  }

  applyDone(raw: GenDoneEvent | undefined): void {
    if (!raw || !this.run || raw.runId !== this.run.runId) return;
    const runId = raw.runId;
    if (raw.status === 'saved' && typeof raw.version === 'number') {
      const known = this.deps.knownVersion();
      // This tab already holds the saved version (it cannot have adopted it from this run's announcement, which comes after).
      if (known !== undefined && known >= raw.version) {
        this.dropRun();
        return;
      }
      const insertedIds = Array.isArray(raw.insertedIds) ? raw.insertedIds.filter((id): id is string => typeof id === 'string') : [];
      const drawnAs = Array.isArray(raw.drawnAs)
        ? raw.drawnAs.map((d) => (Array.isArray(d) ? d.filter((i): i is number => Number.isInteger(i) && i >= 0) : []))
        : [];
      this.settling.set(runId, {
        runId,
        version: raw.version,
        insertedIds,
        drawnAs,
        remembered: this.run,
        // A copy held for the person (or a fetch that never comes): the draft goes anyway.
        timer: this.setTimer(() => {
          if (!this.settling.has(runId)) return;
          runInAction(() => {
            this.endSettling(runId);
            this.sync();
          });
        }, GEN_DRAFT_LIMITS.settleMs),
      });
      // The run sends nothing more; its draft stays drawn under its key until the adoption.
      this.clearTimer(this.watchdog);
      this.watchdog = undefined;
      this.run = undefined;
      // The person's Generate may have released the store meanwhile: draw what was remembered while the saved copy is pending.
      this.sync();
      return;
    }
    this.dropRun();
  }

  /**
   * This tab adopted `version`; call inside the adoption's MobX action. Every
   * run whose saved result this copy holds loses its draft now, and a run still
   * waiting behind it is drawn in the same action. Answers which result sections
   * stay still (undefined when no draft ended).
   */
  settle(version: number): SettledDraft | undefined {
    let answer: SettledDraft | undefined;
    // Events were missed while the stream was down: the running draft cannot know whether this copy holds its result.
    if (this.unsynced && this.run) {
      this.dropRun();
    }
    for (const s of [...this.settling.values()]) {
      if (version < s.version) continue;
      const draft = this.deps.draft();
      const key = agentDraftKey(s.runId);
      const ours = draft?.target?.requestKey === key;
      const stillIds: string[] = [];
      if (ours && draft) {
        // Each drawn preview stands for one result section at most.
        const used = new Set<number>();
        s.insertedIds.forEach((id, i) => {
          const match = (s.drawnAs[i] ?? []).find((index) => !used.has(index) && draft.isShown(index));
          if (match === undefined) return;
          used.add(match);
          stillIds.push(id);
        });
      }
      const onScreen = ours && draft?.target?.kind === 'newPage' && !!draft.targetOn(this.deps.currentPageId());
      // Read before the draft goes: the frames are still drawn inside this action.
      const inView = onScreen && (this.deps.draftInView?.() ?? false);
      this.endSettling(s.runId);
      if (ours) answer = { stillIds, ...(onScreen && s.insertedIds[0] ? { newPageNodeId: s.insertedIds[0], inView } : {}) };
    }
    // Also when nothing ended: a target this copy did not have before may exist after the adoption.
    this.sync();
    return answer;
  }

  /**
   * The stream is down (an error or a refusal): events of the running run can
   * be missed, its end among them. Its draft stays (a brief reconnect redraws
   * nothing) until the reconnect's `state` says whether the run still goes on,
   * or until this tab adopts a version first (a poll), which drops it in the
   * adoption's action, so it never stands beside a result. A saved result still
   * being fetched keeps its draft (its timer bounds it). Should neither come
   * within GEN_DRAFT_LIMITS.unsyncedMs (a run that failed while the stream
   * stays down, after a refusal), the draft goes then.
   */
  streamLost(): void {
    this.unsynced = true;
    // A run that failed meanwhile never brings an adoption: without a `state` soon, its draft goes.
    const runId = this.run?.runId;
    if (!runId) return;
    this.clearTimer(this.watchdog);
    this.watchdog = this.setTimer(() => {
      if (this.run?.runId === runId && this.unsynced) this.dropRun();
    }, GEN_DRAFT_LIMITS.unsyncedMs);
  }

  /** Forget everything (the editor closed the site, or the person was signed out). */
  reset(): void {
    this.unsynced = false;
    this.dropRun();
    for (const runId of [...this.settling.keys()]) this.endSettling(runId);
  }

  private follow(runId: string, target: GenDraftTarget): void {
    if (this.run?.runId !== runId) {
      // A newer run: whatever the earlier one still drew goes (it was superseded on the server).
      this.dropRun();
      this.run = { runId, target, outline: [], sections: [] };
    }
    this.clearTimer(this.watchdog);
    this.watchdog = this.setTimer(() => {
      if (this.run?.runId === runId) this.dropRun();
    }, GEN_DRAFT_LIMITS.runMaxMs);
  }

  private remember(raw: unknown): void {
    const run = this.run;
    const section = validSection(raw);
    if (!run || !section || run.sections.some((s) => s.index === section.index)) return;
    if (run.sections.length >= GEN_DRAFT_LIMITS.sectionsPerRun) return;
    run.sections = [...run.sections, section].sort((a, b) => a.index - b.index);
  }

  /**
   * Draw the run remembered, unless the person's own Generate holds the draft,
   * or an earlier run's draft waits there for its saved result (this one is
   * drawn in the action that adopts it).
   */
  private sync(): void {
    // The run still writing, else the newest run whose saved result waits and was never drawn (it saved behind an earlier one).
    const run = this.run ?? [...this.settling.values()].at(-1)?.remembered;
    const draft = this.deps.draft();
    if (!run || !draft) return;
    const key = agentDraftKey(run.runId);
    const holder = draft.target?.requestKey;
    if (holder !== undefined && holder !== key) {
      if (!isAgentDraftKey(holder)) return;
      if (this.settling.has(holder.slice(AGENT_KEY_PREFIX.length))) return;
    }
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

  private endSettling(runId: string): void {
    const s = this.settling.get(runId);
    if (!s) return;
    this.clearTimer(s.timer);
    this.settling.delete(runId);
    this.deps.draft()?.clear(agentDraftKey(runId));
  }

  /** Drop the run still sending events, and its draft. */
  private dropRun(): void {
    const run = this.run;
    this.clearTimer(this.watchdog);
    this.watchdog = undefined;
    this.run = undefined;
    if (run) this.deps.draft()?.clear(agentDraftKey(run.runId));
  }
}
