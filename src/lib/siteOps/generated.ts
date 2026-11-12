// src/lib/siteOps/generated.ts
//
// The two ends of generatePage around the shared model loop
// (src/lib/ai/pageGen/runPageGeneration.ts), without the editor's stores:
//
//   - generationTarget: where a generation goes on a loaded project (a new page,
//     inside a container, or in place of a node), its breakpoints and, for a
//     section, the target's subtree as context. A page without frames gets the
//     default three first, exactly as the Generate dialog does
//     (src/lib/ai/pageGen/editorBridge.ts captureTarget).
//   - applyGenerated: the validated result on the project as one write, through
//     the editor's own actions (ProjectModel.addGeneratedPage,
//     PageModel.applyGeneratedNodes), then the same gates as a batch
//     (projectGateProblem). A refused result leaves the project as it was.
//
// Unlike a batch, a generation keeps the generator's repairs: the result lists
// every dropped or changed thing as a warning, which generatePage hands back.

import { recordPatches } from 'mobx-state-tree';
import type { ProjectModelType } from '@/models/ProjectModel';
import type { PageModelType } from '@/models/PageModel';
import type { ComponentInstance } from '@/models/ComponentModel';
import { serializeSubtree } from '@/lib/ai/serializers/subtree';
import { DEFAULT_VIEWPORTS } from '@/lib/canvas/defaultViewports';
import { isVoidTag } from '@/lib/drag/voidTags';
import { breakpointKeyMap, toEditorSnapshot, type PageBreakpoint } from '@/lib/ai/pageGen/apply';
import type { PageGenResultPayload, PageGenTarget } from '@/lib/ai/pageGen/protocol';
import { closedAncestorOf } from '@/lib/ai/pageGen/promptSections/behaviour';
import { holdsFxScene } from '@/lib/fxScene/marker';
import { projectGateProblem } from './applyOps';

/** Where a generation goes, as a caller names it. */
export type GenerateTarget =
  | { kind: 'newPage'; title?: string }
  | { kind: 'insert'; pageId: string; parentId?: string }
  | { kind: 'replace'; pageId: string; nodeId: string };

interface Viewport {
  breakpointId: string;
  label: string;
  minWidth: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ResolvedTarget {
  kind: GenerateTarget['kind'];
  /** The route's target, with the context the model reads. */
  wire: PageGenTarget;
  pageId?: string;
  componentId?: string;
  breakpoints: PageBreakpoint[];
  viewports: Viewport[];
}

/** ~8k tokens of context, the same budget the Generate dialog sends. */
const CONTEXT_TOKENS = 8000;

/** Resolve a target on the project, or the reason it cannot take a generation. */
export function generationTarget(
  project: ProjectModelType,
  target: GenerateTarget,
): { ok: true; value: ResolvedTarget } | { ok: false; reason: string } {
  if (target.kind === 'newPage') {
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
      ok: true,
      value: {
        kind: 'newPage',
        wire: { kind: 'newPage', ...(target.title?.trim() ? { title: target.title.trim() } : {}) },
        breakpoints: viewports.map((v) => ({ id: v.breakpointId, label: v.label, minWidth: v.minWidth })),
        viewports,
      },
    };
  }
  const page = project.pages.get(target.pageId) as PageModelType | undefined;
  if (!page) return { ok: false, reason: `unknown page id ${JSON.stringify(target.pageId)}` };
  const root = page.appComponentTree as ComponentInstance;
  const componentId = target.kind === 'insert' ? target.parentId ?? root.id : target.nodeId;
  const component = findInTree(root, componentId);
  if (!component) return { ok: false, reason: `unknown node id ${JSON.stringify(componentId)} on this page` };
  if (target.kind === 'insert') {
    if (typeof component.props?.children === 'string' || isVoidTag(component.type) || component.props?.['data-component-kind']) {
      return { ok: false, reason: `<${component.type}> cannot contain other nodes; pick a container` };
    }
  }
  // No preset under a button, link or the like the result would stand in (validate.ts).
  const closedAncestor = closedAncestorOf(root, componentId, target.kind);
  // A page draws one FX scene (src/lib/fxScene): say when it keeps one outside what is replaced.
  const pageHasFxScene = holdsFxScene([root], target.kind === 'replace' ? componentId : undefined);
  // Generating into a page without frames: the default three first, so the
  // breakpoint ids the styles are keyed to are ids real frames carry.
  page.ensureDefaultViewports();
  const viewports: Viewport[] = (page.viewportNodes as ComponentInstance[])
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
  return {
    ok: true,
    value: {
      kind: target.kind,
      wire: {
        kind: target.kind,
        context: serializeSubtree(component, { maxTokens: CONTEXT_TOKENS }),
        ...(closedAncestor ? { closedAncestor } : {}),
        ...(pageHasFxScene ? { pageHasFxScene } : {}),
      },
      pageId: page.id,
      componentId,
      breakpoints: viewports.map((v) => ({ id: v.breakpointId, label: v.label, minWidth: v.minWidth })),
      viewports,
    },
  };
}

function findInTree(node: ComponentInstance, id: string): ComponentInstance | undefined {
  if (node.id === id) return node;
  for (const child of node.children as ComponentInstance[]) {
    const hit = findInTree(child, id);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Put a generation's result on the project. Returns the page it landed on and
 * the ids of its top-level nodes, or the reason it was refused (nothing changed).
 */
export function applyGenerated(
  project: ProjectModelType,
  target: ResolvedTarget,
  result: PageGenResultPayload,
  title?: string,
): { ok: true; pageId: string; insertedIds: string[] } | { ok: false; reason: string } {
  const keyMap = breakpointKeyMap(target.breakpoints);
  const snapshots = result.nodes.map((n) => toEditorSnapshot(n, keyMap));
  const insertedIds = snapshots.map((s) => s.id as string);
  const recorder = recordPatches(project);
  let pageId: string;
  if (target.kind === 'newPage') {
    const page = project.addGeneratedPage({
      title: title?.trim() || result.title || 'Generated page',
      description: result.description,
      sections: snapshots,
      viewports: target.viewports,
    });
    pageId = page.id;
  } else {
    const page = project.pages.get(target.pageId!) as PageModelType | undefined;
    const applied = page?.applyGeneratedNodes(target.kind, target.componentId!, snapshots, result.generationId);
    if (!page || !applied || !applied.ok) {
      recorder.stop();
      recorder.undo();
      return { ok: false, reason: applied && !applied.ok ? applied.reason : 'the page no longer exists' };
    }
    pageId = page.id;
  }
  const page = project.pages.get(pageId) as PageModelType;
  const problem = projectGateProblem(project, insertedIds.map((nodeId) => ({ page, nodeId })));
  recorder.stop();
  if (problem) {
    recorder.undo();
    return { ok: false, reason: problem };
  }
  return { ok: true, pageId, insertedIds };
}
