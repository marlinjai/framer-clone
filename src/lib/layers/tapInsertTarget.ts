// src/lib/layers/tapInsertTarget.ts
//
// Where a component goes when it is added with a tap instead of a drag (the
// Components list in the phone layout's Pages and layers sheet, plan
// docs/plans/2026-10-24-editor-on-phones.md): a phone has no free space to
// drag onto while the sheet covers the canvas, so a tap adds the component
// relative to the selection, by the same rules a drop uses:
//
// - nothing selected, or a breakpoint frame: at the end of the page;
// - a container (a layout tag, or any element that already has element
//   children), not a void tag, not a text holder, not a component with its own
//   rendering (`data-component-kind`): inside it, at the end;
// - anything else inside the page tree: right after it;
// - anything else that has no parent (a floating element): at the end of the page.
import type { InsertTarget } from '@/models/PageModel';
import { CONTAINER_TAGS } from '@/lib/drag/resolveDropTarget';
import { isVoidTag } from '@/lib/drag/voidTags';

/** The parts of a component the rule reads. */
export interface TapInsertSelection {
  id: string;
  type: string;
  isViewportNode?: boolean;
  hasParent?: boolean;
  props?: Record<string, unknown>;
  children?: ArrayLike<unknown>;
}

export function canHoldChildren(node: TapInsertSelection): boolean {
  if (isVoidTag(node.type)) return false;
  if (node.props?.['data-component-kind']) return false;
  if (typeof node.props?.children === 'string') return false;
  return CONTAINER_TAGS.has(node.type.toLowerCase()) || (node.children?.length ?? 0) > 0;
}

export function tapInsertTarget(selected: TapInsertSelection | undefined): InsertTarget {
  if (!selected || selected.isViewportNode) return { kind: 'appTree' };
  if (canHoldChildren(selected)) return { kind: 'parent', parentId: selected.id };
  if (selected.hasParent) return { kind: 'sibling', siblingId: selected.id, position: 'after' };
  return { kind: 'appTree' };
}
