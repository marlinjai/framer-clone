import 'server-only';

// src/server/sites/liveGeneration.ts
//
// The draft of an MCP generate_page that is still running, for the site's open
// editors (plan docs/plans/2026-11-08-live-agent-canvas.md, section 3, "The MCP
// generate_page streams its draft to open editors"). siteOps.generatePage opens a
// run here once the site was loaded through the caller's own scope, forwards the
// generator's outline and preview sections, and ends the run exactly once:
// `saved` from the repository's pre-announcement step (so `gen:done` reaches an
// editor before the `site:version` that makes it fetch the result), anything
// else from the generation's way out. Each step goes to the site's streams
// (src/server/sites/liveBus.ts) as `gen:outline`, `gen:section` and `gen:done`.
//
// What is kept, in process memory (one container, like the bus, the presence
// and the skeleton plans; the plan's section 7 says what moves with more than
// one): the site's running generation, with the scope it was opened under, so
// the `state` event of an editor that opens or reloads mid-run draws the same
// draft. One run per site: a second generate_page on the site supersedes the
// first (its draft goes, `superseded`), and the first one's later steps are no
// longer sent. Its own end still frees its rate-limit slot as before.
//
// The preview sections are content (the model's output before it is saved).
// They reach only the site's streams, whose guard is the document route's own
// (`editSite` on the project in the caller's workspace), and they are never
// stored anywhere but here, for the length of the run. Bounded
// (GEN_DRAFT_LIMITS): a section over `sectionChars`, or past `runChars` or
// `sectionsPerRun`, is not sent and its skeleton stays until the result; at most
// `runsPerProcess` runs are kept (the least recently touched one is given up on
// first), and a run older than `runMaxMs` is given up on (`expired`).
//
// Kept on globalThis so a development hot reload does not split writers and readers.

import {
  GEN_DRAFT_LIMITS,
  LIVE_EVENTS,
  LIVE_LIST_MAX,
  sanitizePlanTitle,
  type GenDoneEvent,
  type GenDoneStatus,
  type GenDraftSection,
  type GenDraftTarget,
  type GenOutlineEvent,
  type GenSectionEvent,
  type LiveGeneration,
} from '@/lib/projects/liveEvents';
import { normalizeOutline, type OutlineEntry } from '@/lib/ai/pageGen/outline';
import type { PageGenOutline, PageGenSection } from '@/lib/ai/pageGen/protocol';
import { identicalPreviews } from '@/lib/ai/pageGen/sectionMatch';
import type { GeneratedNodeSnapshot } from '@/lib/ai/pageGen/validate';
import type { TenantScope } from './repository';
import { publishSiteEvent } from './liveBus';

interface RunEntry {
  runId: string;
  siteId: string;
  scope: TenantScope;
  target: GenDraftTarget;
  outline: OutlineEntry[];
  sections: GenDraftSection[];
  chars: number;
  startedAt: number;
  touchedAt: number;
}

interface GenerationState {
  /** Site id to its running generation; the least recently touched first. */
  sites: Map<string, RunEntry>;
}

const KEY = Symbol.for('lumitra.liveGeneration');

function state(): GenerationState {
  const g = globalThis as unknown as Record<symbol, GenerationState | undefined>;
  let s = g[KEY];
  if (!s) {
    s = { sites: new Map() };
    g[KEY] = s;
  }
  return s;
}

function sameScope(a: TenantScope, b: TenantScope): boolean {
  return a.workspaceId === b.workspaceId && a.tenantGroupId === b.tenantGroupId;
}

function announceEnd(entry: RunEntry, done: GenDoneEvent): void {
  publishSiteEvent(entry.siteId, LIVE_EVENTS.genDone, done);
}

/** Give up on runs past their time. */
function sweep(now: number): void {
  const { sites } = state();
  for (const [siteId, entry] of sites) {
    if (now - entry.startedAt > GEN_DRAFT_LIMITS.runMaxMs) {
      sites.delete(siteId);
      announceEnd(entry, { runId: entry.runId, status: 'expired' });
    }
  }
}

/** The target as it travels: ids, and a new page's title sanitised. */
export function draftTargetOf(target: GenDraftTarget): GenDraftTarget {
  if (target.kind === 'newPage') {
    const title = sanitizePlanTitle(target.title);
    return title ? { kind: 'newPage', title } : { kind: 'newPage' };
  }
  if (target.kind === 'replace') return { kind: 'replace', pageId: target.pageId, nodeId: target.nodeId };
  return { kind: 'insert', pageId: target.pageId, parentId: target.parentId };
}

/** One running generation, as siteOps.generatePage drives it. Every method is safe to call after the run ended (it then does nothing). */
export interface LiveGenerationRun {
  readonly runId: string;
  /** The generator's onOutline. */
  outline(payload: PageGenOutline): void;
  /** The generator's onSection. */
  section(payload: PageGenSection): void;
  /**
   * End the run, once: later calls do nothing. `saved` carries the version, the
   * ids of the result's top-level nodes and the result's sections as the model
   * wrote them (in the same order), so the editor learns which ones it already
   * drew exactly as they were saved.
   */
  end(status: GenDoneStatus, saved?: { version: number; insertedIds: readonly string[]; nodes: readonly GeneratedNodeSnapshot[] }): void;
}

/**
 * Open the running generation of a site. Call only after the site was loaded
 * through `scope` (the caller's own): what is opened here is sent to every
 * stream of the site. A run already open on the site is superseded.
 */
export function openLiveGeneration(siteId: string, scope: TenantScope, runId: string, target: GenDraftTarget, now: number = Date.now()): LiveGenerationRun {
  const s = state();
  sweep(now);
  const earlier = s.sites.get(siteId);
  if (earlier) {
    s.sites.delete(siteId);
    announceEnd(earlier, { runId: earlier.runId, status: 'superseded' });
  }
  const entry: RunEntry = {
    runId,
    siteId,
    scope: { workspaceId: scope.workspaceId, tenantGroupId: scope.tenantGroupId },
    target: draftTargetOf(target),
    outline: [],
    sections: [],
    chars: 0,
    startedAt: now,
    touchedAt: now,
  };
  s.sites.set(siteId, entry);
  while (s.sites.size > GEN_DRAFT_LIMITS.runsPerProcess) {
    const [oldestSite, oldest] = s.sites.entries().next().value as [string, RunEntry];
    s.sites.delete(oldestSite);
    announceEnd(oldest, { runId: oldest.runId, status: 'expired' });
  }

  let ended = false;
  /** Whether this run still holds the site (not superseded, expired or evicted). */
  const current = (): boolean => !ended && s.sites.get(siteId) === entry;
  const touch = () => {
    entry.touchedAt = Date.now();
    // Most recently touched last, so the first key is the one to give up on.
    s.sites.delete(siteId);
    s.sites.set(siteId, entry);
  };

  return {
    runId,
    outline(payload) {
      try {
        if (!current() || !payload || !Array.isArray(payload.outline)) return;
        // Sanitised again here, whatever produced it.
        entry.outline = normalizeOutline(payload.outline);
        touch();
        const event: GenOutlineEvent = { runId, target: entry.target, outline: entry.outline };
        publishSiteEvent(siteId, LIVE_EVENTS.genOutline, event);
      } catch (err) {
        console.error(`[live] the outline of generation ${runId} on site ${siteId} could not be sent`, err);
      }
    },
    section(payload) {
      try {
        if (!current() || !payload || !Number.isInteger(payload.index) || payload.index < 0) return;
        if (entry.sections.some((existing) => existing.index === payload.index)) return;
        if (entry.sections.length >= GEN_DRAFT_LIMITS.sectionsPerRun) return;
        const chars = JSON.stringify(payload.node ?? null).length;
        // Too large to send: its skeleton stays until the result lands. Never a failure of the run.
        if (chars > GEN_DRAFT_LIMITS.sectionChars || entry.chars + chars > GEN_DRAFT_LIMITS.runChars) return;
        const slot = Number.isInteger(payload.slot) && payload.slot >= 0 ? payload.slot : payload.index;
        const section: GenDraftSection = { index: payload.index, slot, node: payload.node };
        entry.sections = [...entry.sections, section].sort((a, b) => a.index - b.index);
        entry.chars += chars;
        touch();
        const event: GenSectionEvent = { runId, target: entry.target, ...section };
        publishSiteEvent(siteId, LIVE_EVENTS.genSection, event);
      } catch (err) {
        console.error(`[live] a section of generation ${runId} on site ${siteId} could not be sent`, err);
      }
    },
    end(status, saved) {
      if (ended) return;
      const held = current();
      ended = true;
      // Superseded, expired or evicted: its end was already announced.
      if (!held) return;
      s.sites.delete(siteId);
      const done: GenDoneEvent = { runId, status };
      if (status === 'saved' && saved) {
        // The extras never cost the end itself: without them the editor still drops the draft.
        try {
          const nodes = saved.nodes.slice(0, LIVE_LIST_MAX);
          const indexes = entry.sections.map((section) => section.index);
          const drawnAs = identicalPreviews(
            entry.sections.map((section) => section.node),
            nodes,
          ).map((positions) => positions.map((position) => indexes[position]));
          done.version = saved.version;
          done.insertedIds = saved.insertedIds.slice(0, LIVE_LIST_MAX);
          done.drawnAs = drawnAs;
        } catch (err) {
          done.version = saved.version;
          console.error(`[live] the end of generation ${runId} on site ${siteId} lost its details`, err);
        }
      }
      announceEnd(entry, done);
    },
  };
}

/** The running generation of a site for a newly opened stream, if it was opened under the same scope. */
export function generationSnapshot(siteId: string, scope: TenantScope, now: number = Date.now()): LiveGeneration | undefined {
  sweep(now);
  const entry = state().sites.get(siteId);
  if (!entry || !sameScope(entry.scope, scope)) return undefined;
  return { runId: entry.runId, target: entry.target, outline: [...entry.outline], sections: [...entry.sections] };
}

/** Tests only: forget every run. */
export function resetLiveGenerationForTests(): void {
  state().sites.clear();
}
