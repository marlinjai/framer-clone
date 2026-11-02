// src/lib/components/editorCommands.ts
//
// The editor's ways in to the component actions, shared by the Layers menu, the
// right panel, the Components panel, a drop and a key: what Create component acts
// on, and placing a definition with the result selected or the refusal shown. The
// actions themselves are ProjectModel's, one history entry each.
//
// Contract: docs/plans/2026-11-02-reusable-components.md, "Editing on the canvas".

import type { ComponentInstance } from '@/models/ComponentModel';
import type { InsertTarget } from '@/models/PageModel';
import type { EditorUIType } from '@/stores/EditorUIStore';
import { formKindOf } from '@/lib/forms/definition';
import { detachLosesFormHistory } from './detach';
import type { InputDefinition } from './inputs';

/** What Create component would act on now, or why it cannot. */
export type ComponentSelection =
  | { ok: true; pageId: string; nodeIds: string[] }
  | { ok: false; message: string };

/** The selected nodes that Create component takes, the page root and frames never. */
export function componentSelection(editorUI: EditorUIType): ComponentSelection {
  const page = editorUI.currentPage;
  if (!page) return { ok: false, message: 'Open a page first.' };
  const selected = editorUI.selectedComponentList.filter((node: ComponentInstance) => !node.isViewportNode);
  if (selected.length === 0) return { ok: false, message: 'Select the elements to make a component from.' };
  if (selected.some((node: ComponentInstance) => node === page.appComponentTree)) {
    return { ok: false, message: 'The page itself cannot become a component. Select elements inside it.' };
  }
  if (selected.some((node: ComponentInstance) => !node.hasParent)) {
    return { ok: false, message: 'An element beside the page cannot become a component yet. Move it into the page first.' };
  }
  return { ok: true, pageId: page.id, nodeIds: selected.map((node: ComponentInstance) => node.id) };
}

/** Opens the naming dialog for the selection, or says why it cannot. */
export function requestCreateComponent(editorUI: EditorUIType): void {
  const selection = componentSelection(editorUI);
  if (!selection.ok) {
    editorUI.setEditorNotice({ kind: 'refused', message: selection.message });
    return;
  }
  editorUI.setComponentRequest({ kind: 'create', pageId: selection.pageId, nodeIds: selection.nodeIds });
}

/** True when the node or anything inside it is a form or one of its parts, whose id a component changes. */
export function holdsForm(node: ComponentInstance): boolean {
  if (node.type === 'form' || formKindOf(node.props as Record<string, unknown>)) return true;
  return node.children.some((child: ComponentInstance) => holdsForm(child));
}

/** Places a definition on the current page, selects it, or shows why not. */
export function placeDefinition(editorUI: EditorUIType, definitionId: string, target: InsertTarget, breakpointId?: string): ComponentInstance | undefined {
  const project = editorUI.currentProject;
  const page = editorUI.currentPage;
  if (!project || !page) return undefined;
  const result = project.placeComponent(page.id, definitionId, target);
  if (!result.ok) {
    editorUI.setEditorNotice({ kind: 'refused', message: result.message });
    return undefined;
  }
  if (editorUI.editorNotice?.kind === 'refused') editorUI.setEditorNotice(undefined);
  editorUI.selectComponent(result.placement, breakpointId);
  return result.placement;
}

/**
 * A new type or new options for an input. What the change takes with it (placement
 * values the new input refuses, connections to fields it may not set, a default it
 * refuses) is said first in a dialog; a change that takes nothing runs at once, as
 * one undoable step.
 */
export function requestInputEdit(editorUI: EditorUIType, definitionId: string, next: InputDefinition, defaultDropped: boolean): void {
  const project = editorUI.currentProject;
  if (!project) return;
  const takes = defaultDropped
    || project.inputTypeChangeLoss(definitionId, next) > 0
    || project.inputTypeChangeBindingLoss(definitionId, next) > 0;
  if (takes) {
    editorUI.setComponentRequest({ kind: 'editInput', definitionId, next, defaultDropped });
    return;
  }
  const result = project.changeInputType(definitionId, next);
  if (!result.ok) editorUI.setEditorNotice({ kind: 'refused', message: result.message });
}

/** Runs Detach, selecting the plain copy, or shows why not. */
export function runDetach(editorUI: EditorUIType, pageId: string, placementId: string, breakpointId?: string): boolean {
  const project = editorUI.currentProject;
  if (!project) return false;
  const result = project.detachPlacement(pageId, placementId);
  if (!result.ok) {
    editorUI.setEditorNotice({ kind: 'refused', message: result.message });
    return false;
  }
  if (result.root) editorUI.selectComponent(result.root, breakpointId);
  return true;
}

/**
 * Detach from a menu or the panel. A plain copy takes a form inside to a new id, and
 * past submissions stay with the old one, so that is said first in a dialog; any
 * other detach is one undoable step and runs at once.
 */
export function requestDetach(editorUI: EditorUIType, pageId: string, placementId: string, breakpointId?: string): void {
  const project = editorUI.currentProject;
  const node = project?.findPageById(pageId)?.findComponent(placementId);
  const definitionId = (node?.props as { component?: unknown } | undefined)?.component;
  const stored = typeof definitionId === 'string' ? project?.definitions[definitionId] : undefined;
  if (stored && detachLosesFormHistory(stored)) {
    editorUI.setComponentRequest({ kind: 'detach', pageId, placementId });
    return;
  }
  runDetach(editorUI, pageId, placementId, breakpointId);
}
