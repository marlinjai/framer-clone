// src/lib/ai/pageGen/draft.ts
//
// The page that builds itself while the model writes it: the preview sections
// of a running generation (gen:section, ./protocol.ts) as a DRAFT the canvas
// draws in place of the target, never as part of the project.
//
// Why a draft and not live nodes: the undo history records MobX-State-Tree
// patches with array indices (src/stores/HistoryStore.ts). Draft nodes inserted
// into the page would shift those indices for any edit made during the run, and
// later undos would misapply; they would also be saved and published with the
// project. So each section is its own detached tree (ComponentModel.create, no
// parent), held here on the editor UI store and drawn by the canvas through
// HeadlessComponentRenderer, which needs no parent. When the final result
// arrives the dialog applies it exactly as before (one undo step) and drops the
// draft in the same handler; cancel, failure and expiry only drop the draft.
//
// Before the sections, the outline (gen:outline, ./outline.ts): one skeleton
// per section the model is about to write, in the shapes of the live agent
// canvas (src/components/live/SkeletonLayer.tsx). The section of slot i takes
// the place of skeleton i the moment it arrives; a skeleton nobody fills stays
// until the result lands (the apply drops the whole draft, so outline entries
// beyond the real sections go with it), and a section past the outline appears
// as before. The outline is part of the draft, so a new run, a cancel, a
// failure or a refusal drops it with the sections.
//
// What the draft does not show, by design: stock photos (the placeholders stay
// until the result places them), and anything drawn from the page's expansion
// (props.rules such as hover states, the page's web font faces): those read the
// page itself, which the draft is not part of. It is a visual approximation that
// lasts until the result lands.

import { action, computed, makeObservable, observable } from 'mobx';
import ComponentModel, { type ComponentInstance, type ComponentSnapshotIn } from '@/models/ComponentModel';
import { shopLocaleOf, withShopParts, type ShopLocale, type ShopTreeNode } from '@/lib/commerce/parts';
import { breakpointKeyMap, toEditorSnapshot, type PageBreakpoint } from './apply';
import type { CapturedTarget, TargetKind } from './editorBridge';
import type { PageGenOutline, PageGenSection } from './protocol';
import { normalizeOutline, type OutlineEntry } from './outline';
import type { GeneratedNodeSnapshot } from './validate';

/** Where a draft is drawn: the run's captured target, frozen when it started. */
export interface PageGenDraftTarget {
  /** The run it belongs to (flow.ts makeRequestKey); events for another key are dropped. */
  requestKey: string;
  kind: TargetKind;
  /** The page the run started on: the draft is drawn only while it is on screen (unless followsCurrentPage). */
  pageId: string;
  /**
   * A new page an agent generates (the MCP generate_page, src/lib/live/generationDraft.ts):
   * no page of this tab started it, so its draft frames show beside whichever page is on screen.
   */
  followsCurrentPage?: boolean;
  /** replace / insert: the component the draft stands in for, or is appended to. */
  componentId?: string;
  /** Whether the target is the page's root (replace then swaps its children, as the apply does). */
  targetIsRoot: boolean;
  /** A new page: the frames' title on the canvas. */
  title: string;
  breakpoints: PageBreakpoint[];
  /** A new page: the frames the page will get (geometry and breakpoint ids). */
  viewports: CapturedTarget['viewports'];
  /** The site language's shop locale, so a shop control gets its parts as the apply gives them. */
  locale: ShopLocale;
}

/** One drawn section: its place in the page and its detached tree. */
export interface DraftSection {
  index: number;
  /** Its position in the model's "nodes": the skeleton it replaces. */
  slot: number;
  tree: ComponentInstance;
  /** The section as the model wrote it: what the apply matches a final section against. */
  source: GeneratedNodeSnapshot;
}

/** A skeleton of the outline still waiting for its section. */
export interface DraftSkeleton extends OutlineEntry {
  slot: number;
}

/** One thing the draft draws, in page order: a section, or the skeleton of one still coming. */
export type DraftItem = { kind: 'section'; slot: number; section: DraftSection } | { kind: 'skeleton'; slot: number; skeleton: DraftSkeleton };

/** What the canvas says about the section still being written. */
export type DraftPhase = 'writing' | 'checking' | 'polishing';

/** The draft target of a run that starts now. */
export function draftTargetFor(input: {
  requestKey: string;
  target: CapturedTarget;
  title?: string;
  rootId?: string;
  siteLanguage?: string | null;
}): PageGenDraftTarget {
  const { target } = input;
  return {
    requestKey: input.requestKey,
    kind: target.kind,
    pageId: target.pageId,
    ...(target.componentId ? { componentId: target.componentId } : {}),
    targetIsRoot: !!target.componentId && target.componentId === input.rootId,
    title: input.title?.trim() || 'New page',
    breakpoints: target.breakpoints,
    viewports: target.viewports,
    locale: shopLocaleOf(input.siteLanguage),
  };
}

/**
 * A preview section as a detached tree, keyed to the target's real breakpoint
 * ids and with shop parts, the same steps applyResult takes. Undefined when the
 * editor model refuses it (the server validated it, so this is belt and braces).
 */
export function buildDraftTree(section: PageGenSection, target: PageGenDraftTarget): ComponentInstance | undefined {
  try {
    const snapshot = toEditorSnapshot(section.node, breakpointKeyMap(target.breakpoints));
    const withParts = withShopParts(snapshot as ShopTreeNode, target.locale, 'snapshot') as ComponentSnapshotIn;
    return ComponentModel.create(withParts) as ComponentInstance;
  } catch {
    return undefined;
  }
}

/**
 * The draft of the generation running now, if any. Observable, held on the
 * editor UI store (never under the project store, so the history never sees
 * it). `target` changes only when a run starts or ends, `sections` on each new
 * section: the canvas nodes observe the first, only the draft layer the second.
 */
export class PageGenDraftStore {
  target: PageGenDraftTarget | undefined = undefined;
  sections: readonly DraftSection[] = [];
  /** The run's outline, the latest the server sent (empty until one arrives, or when the model wrote none). */
  outline: readonly OutlineEntry[] = [];
  phase: DraftPhase = 'writing';
  /** Indexes of the sections the canvas actually drew (not merely received). Not observable: read once, at the apply. */
  private shown = new Set<number>();

  constructor() {
    makeObservable(this, {
      target: observable.ref,
      sections: observable.ref,
      outline: observable.ref,
      phase: observable,
      skeletons: computed,
      items: computed,
      begin: action,
      add: action,
      setOutline: action,
      setPhase: action,
      clear: action,
    });
  }

  /** Start the draft of a run; replaces any earlier one. */
  begin(target: PageGenDraftTarget): void {
    this.target = target;
    this.sections = [];
    this.outline = [];
    this.shown = new Set();
    this.phase = 'writing';
  }

  /** Record that the canvas drew the section `index` (the run's page was on screen). */
  markShown(index: number): void {
    this.shown.add(index);
  }

  /** Whether the canvas drew the section `index` of the draft held now. */
  isShown(index: number): boolean {
    return this.shown.has(index);
  }

  /**
   * The sources of the sections the canvas really drew, as the model wrote them.
   * A section stored while another page was on screen is not among them.
   */
  shownSources(): GeneratedNodeSnapshot[] {
    return this.sections.filter((s) => this.shown.has(s.index)).map((s) => s.source);
  }

  /**
   * Add a section of the run `requestKey`. A section of another run, one that
   * is already drawn (a collected run repeats them all on every poll) or one
   * the model refuses is ignored. Returns whether it was added.
   */
  add(requestKey: string, section: PageGenSection): boolean {
    const target = this.target;
    if (!target || target.requestKey !== requestKey) return false;
    if (!Number.isInteger(section.index) || section.index < 0) return false;
    if (this.sections.some((s) => s.index === section.index)) return false;
    const tree = buildDraftTree(section, target);
    if (!tree) return false;
    const slot = Number.isInteger(section.slot) && section.slot >= 0 ? section.slot : section.index;
    this.sections = [...this.sections, { index: section.index, slot, tree, source: section.node }].sort((a, b) => a.index - b.index);
    return true;
  }

  /**
   * Take the outline of the run `requestKey` (the latest replaces the earlier
   * one; a collected run repeats it on every poll). Entries are sanitised again
   * here, whatever sent them. Returns whether the outline changed.
   */
  setOutline(requestKey: string, payload: PageGenOutline): boolean {
    if (!this.target || this.target.requestKey !== requestKey) return false;
    if (!payload || !Array.isArray(payload.outline)) return false;
    const next = normalizeOutline(payload.outline);
    if (JSON.stringify(next) === JSON.stringify(this.outline)) return false;
    this.outline = next;
    return true;
  }

  /** The outline's skeletons whose section has not arrived (or was refused by the editor), in page order. */
  get skeletons(): DraftSkeleton[] {
    const filled = new Set(this.sections.map((s) => s.slot));
    return this.outline.map((entry, slot) => ({ ...entry, slot })).filter((s) => !filled.has(s.slot));
  }

  /** Sections and skeletons together, in page order (by slot, then by index). */
  get items(): DraftItem[] {
    const items: DraftItem[] = [
      ...this.sections.map((section) => ({ kind: 'section' as const, slot: section.slot, section })),
      ...this.skeletons.map((skeleton) => ({ kind: 'skeleton' as const, slot: skeleton.slot, skeleton })),
    ];
    const order = (item: DraftItem) => (item.kind === 'section' ? item.section.index : -1);
    return items.sort((a, b) => a.slot - b.slot || order(a) - order(b));
  }

  setPhase(requestKey: string, phase: DraftPhase): void {
    if (this.target?.requestKey === requestKey && this.phase !== phase) this.phase = phase;
  }

  /**
   * Drop the draft (all of it, or only when it belongs to `requestKey`). The
   * trees are not destroyed: React may still hold them for the frame being
   * unmounted, and a detached tree has nothing to clean up.
   */
  clear(requestKey?: string): void {
    if (requestKey !== undefined && this.target?.requestKey !== requestKey) return;
    this.target = undefined;
    this.sections = [];
    this.outline = [];
    this.shown = new Set();
    this.phase = 'writing';
  }

  /** The draft to draw on this page, if any. */
  targetOn(pageId: string | undefined): PageGenDraftTarget | undefined {
    if (!pageId || !this.target) return undefined;
    return this.target.pageId === pageId || (this.target.followsCurrentPage && this.target.kind === 'newPage') ? this.target : undefined;
  }
}
