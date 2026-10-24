// src/lib/ai/pageGen/editorBridge.ts
//
// The glue between the Generate page dialog and the live editor store:
//   - captureTarget: freeze WHERE a generation goes at the moment it starts
//     (page id, component id, breakpoints with their real ids). A result is
//     applied to that captured target or not at all, never to whatever is
//     selected when the model answers.
//   - buildRequest: the route body for a captured target.
//   - applyResult / undoGeneration: one MST action each (one history entry).

import type { ProjectModelType } from '@/models/ProjectModel';
import type { PageModelType } from '@/models/PageModel';
import type { ComponentInstance } from '@/models/ComponentModel';
import { serializeSubtree } from '@/lib/ai/serializers/subtree';
import { isVoidTag } from '@/lib/drag/voidTags';
import { DEFAULT_VIEWPORTS } from '@/lib/canvas/defaultViewports';
import { getHistoryStore } from '@/stores/RootStore';
import {
  breakpointKeyMap,
  toEditorSnapshot,
  type ApplyOutcome,
  type GenerationUndoRecord,
  type PageBreakpoint,
} from './apply';
import type { PageGenModel, PageGenRequest, PageGenResultPayload } from './protocol';
import { siteContextFromSettings } from './promptSections/siteContext';

export type TargetKind = 'newPage' | 'replace' | 'insert';

/** Viewport geometry copied onto a generated page (same breakpoint ids). */
interface ViewportSpec {
  breakpointId: string;
  label: string;
  minWidth: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CapturedTarget {
  kind: TargetKind;
  pageId: string;
  /** replace / insert: the component the result goes into or replaces. */
  componentId?: string;
  componentLabel?: string;
  breakpoints: PageBreakpoint[];
  viewports: ViewportSpec[];
}


/** What the dialog shows as "where this goes", or why it cannot go there. */
export function describeTargetAvailability(
  kind: TargetKind,
  page: PageModelType | undefined,
  selected: ComponentInstance | undefined,
): { ok: true; label: string } | { ok: false; reason: string } {
  if (!page) return { ok: false, reason: 'Open a page first.' };
  if (kind === 'newPage') return { ok: true, label: 'A new page' };
  if (!selected) return { ok: false, reason: 'Select a component on the canvas first.' };
  if (selected.isViewportNode) return { ok: false, reason: 'Select a component inside a breakpoint frame, not the frame itself.' };
  const inAppTree = isInTree(page.appComponentTree as ComponentInstance, selected.id);
  if (!inAppTree) return { ok: false, reason: 'Select a component inside the page (floating canvas elements are not supported).' };
  const name = selected.displayName ?? selected.type;
  if (kind === 'replace') {
    return selected.id === page.appComponentTree.id
      ? { ok: true, label: 'Everything on this page' }
      : { ok: true, label: `Replace "${name}"` };
  }
  if (typeof selected.props?.children === 'string' || isVoidTag(selected.type) || selected.props?.['data-component-kind']) {
    return { ok: false, reason: `"${name}" cannot contain components; select a container.` };
  }
  return { ok: true, label: `Inside "${name}"` };
}

function isInTree(root: ComponentInstance, id: string): boolean {
  if (root.id === id) return true;
  return root.children.some((c: ComponentInstance) => isInTree(c, id));
}

export function captureTarget(
  kind: TargetKind,
  page: PageModelType,
  selected: ComponentInstance | undefined,
): CapturedTarget {
  // Generating INTO a page without frames: the page first gets the default
  // three, so the breakpoint ids the model's styles are keyed to are ids real
  // frames carry. (They used to be invented here, so every Desktop/Tablet/
  // Mobile style of such a generation was keyed to ids no frame had and only
  // base styles rendered.) Not an undo step: it is a repair, like the one on
  // load, and undoing the generation must not take the frames away again.
  // A NEW page never touches the page that is open: its frames are created
  // with the page (addGeneratedPage).
  if (kind !== 'newPage') {
    const history = getHistoryStore();
    if (history) history.runUntracked(() => page.ensureDefaultViewports());
    else page.ensureDefaultViewports();
  }
  const viewportNodes = page.viewportNodes as ComponentInstance[];
  let viewports: ViewportSpec[] = viewportNodes
    .filter(v => v.breakpointId)
    .map(v => ({
      breakpointId: v.breakpointId as string,
      label: v.label ?? '',
      minWidth: v.breakpointMinWidth ?? 0,
      x: v.canvasX ?? 0,
      y: v.canvasY ?? 0,
      width: v.viewportWidth ?? 400,
      height: v.viewportHeight ?? 600,
    }));
  if (viewports.length === 0) {
    // A new page generated while a frameless page is open: the defaults.
    viewports = DEFAULT_VIEWPORTS.map((v) => ({
      breakpointId: globalThis.crypto.randomUUID(),
      label: v.label,
      minWidth: v.minWidth,
      x: v.x,
      y: v.y,
      width: v.width,
      height: v.height,
    }));
  }
  return {
    kind,
    pageId: page.id,
    ...(kind !== 'newPage' && selected
      ? { componentId: selected.id, componentLabel: selected.displayName ?? selected.type }
      : {}),
    breakpoints: viewports.map(v => ({ id: v.breakpointId, label: v.label, minWidth: v.minWidth })),
    viewports,
  };
}

export function buildRequest(input: {
  brief: string;
  model: PageGenModel;
  pageTitle?: string;
  target: CapturedTarget;
  project: ProjectModelType;
}): PageGenRequest {
  const { target, project } = input;
  const breakpoints = target.breakpoints.map(({ label, minWidth }) => ({ label, minWidth }));
  const base = {
    brief: input.brief.trim(),
    model: input.model,
    breakpoints,
    projectName: project.metadata.title,
    siteContext: siteContextFromSettings(project.site, project.metadata.title, project.pagesArray),
  };
  if (target.kind === 'newPage') {
    return {
      ...base,
      target: { kind: 'newPage', ...(input.pageTitle?.trim() ? { title: input.pageTitle.trim() } : {}) },
      existingPageTitles: project.pagesArray.map(p => p.metadata.title).slice(0, 100),
    };
  }
  const page = project.getPage(target.pageId);
  const component = page && target.componentId ? findInPage(page, target.componentId) : undefined;
  // ~8k tokens of context, the same budget the edit route's page serializer uses.
  const context = component ? serializeSubtree(component, { maxTokens: 8000 }) : null;
  return { ...base, target: { kind: target.kind, context } };
}

function findInPage(page: PageModelType, id: string): ComponentInstance | undefined {
  const walk = (n: ComponentInstance): ComponentInstance | undefined => {
    if (n.id === id) return n;
    for (const c of n.children) {
      const hit = walk(c as ComponentInstance);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(page.appComponentTree as ComponentInstance);
}

export interface AppliedGeneration {
  record: GenerationUndoRecord;
  /** The page to show and the component to select afterwards. */
  pageId: string;
  selectId?: string;
}

/** Apply a validated result to the CAPTURED target. Never touches anything else. */
export function applyResult(
  project: ProjectModelType,
  target: CapturedTarget,
  result: PageGenResultPayload,
  fallbackTitle?: string,
): ApplyOutcome<AppliedGeneration> {
  const keyMap = breakpointKeyMap(target.breakpoints);
  const snapshots = result.nodes.map(n => toEditorSnapshot(n, keyMap));
  if (target.kind === 'newPage') {
    const page = project.addGeneratedPage({
      title: fallbackTitle?.trim() || result.title || 'Generated page',
      description: result.description,
      sections: snapshots,
      viewports: target.viewports,
    });
    return {
      ok: true,
      value: {
        record: { kind: 'newPage', generationId: result.generationId, pageId: page.id, previousPageId: target.pageId },
        pageId: page.id,
        selectId: snapshots[0]?.id as string | undefined,
      },
    };
  }
  const page = project.getPage(target.pageId);
  if (!page) return { ok: false, reason: 'The page this was generated for no longer exists.' };
  if (!target.componentId) return { ok: false, reason: 'No component was selected.' };
  const outcome = page.applyGeneratedNodes(target.kind, target.componentId, snapshots, result.generationId);
  if (!outcome.ok) return outcome;
  return { ok: true, value: { record: outcome.value, pageId: page.id, selectId: snapshots[0]?.id as string | undefined } };
}

/**
 * Reverse one applied generation (the dialog's Undo). Refuses with a reason
 * instead of guessing when the editor changed underneath it.
 */
export function undoGeneration(
  project: ProjectModelType,
  record: GenerationUndoRecord,
  onPageRemoved?: (fallbackPageId: string | undefined) => void,
): ApplyOutcome<null> {
  if (record.kind === 'newPage') {
    if (!project.getPage(record.pageId)) return { ok: false, reason: 'The generated page was already removed.' };
    if (project.pages.size <= 1) return { ok: false, reason: 'A project needs at least one page.' };
    const fallback =
      record.previousPageId && project.getPage(record.previousPageId)
        ? record.previousPageId
        : project.pagesArray.find(p => p.id !== record.pageId)?.id;
    onPageRemoved?.(fallback);
    project.removePage(record.pageId);
    return { ok: true, value: null };
  }
  const page = project.getPage(record.pageId);
  if (!page) return { ok: false, reason: 'The page was removed.' };
  return page.revertGeneration(record);
}
