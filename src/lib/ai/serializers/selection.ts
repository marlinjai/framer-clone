// src/lib/ai/serializers/selection.ts
//
// Selection serializer. Compact list of the components the user has
// selected. Volatile — sits AFTER the cache breakpoint in the prompt
// because it changes on every click.
//
// Signature accepts both the editor UI store and the current project so
// future expansion can resolve ids through the project tree if needed
// (e.g. to attach parent / breakpoint context). For Phase 1 the
// `safeReference`s on the UI store already hand us the live component
// instances, so the project argument is unused — kept on the signature
// for API stability per the spec.

import type { EditorUIType } from '@/stores/EditorUIStore';
import type { ProjectModelType } from '@/models/ProjectModel';
import type { ComponentInstance } from '@/models/ComponentModel';
import { normalize } from './normalize';

export type SerializedSelectionItem = {
  id: string;
  label?: string;
  type: string;
};

/**
 * Build a stable list of {id, type, label?} for every selected component
 * on the editor UI store. Today that's a single component plus an
 * optional viewport node; if the editor grows multi-select in the
 * future, this signature already returns an array.
 */
export function serializeSelection(
  ui: EditorUIType,
  project: ProjectModelType,
): SerializedSelectionItem[] {
  // `project` is accepted on the signature per the spec (lets future
  // expansions resolve component ids against the project tree without a
  // breaking API change). Phase 1 reads everything off the UI store's
  // safeReferences directly, so the project arg is just acknowledged.
  void project;

  const items: SerializedSelectionItem[] = [];
  const seen = new Set<string>();

  const push = (c: ComponentInstance | undefined): void => {
    if (!c) return;
    if (seen.has(c.id)) return;
    seen.add(c.id);
    const item: SerializedSelectionItem = { id: c.id, type: c.type };
    if (c.label !== undefined) item.label = c.label;
    items.push(item);
  };

  push(ui.selectedComponent as ComponentInstance | undefined);
  push(ui.selectedViewportNode as ComponentInstance | undefined);

  items.sort((a, b) => a.id.localeCompare(b.id));
  return normalize(items) as SerializedSelectionItem[];
}
