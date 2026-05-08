// Pure(-ish) drop target resolver.
//
// Reads the DOM under the pointer, walks up to the first relevant drop marker,
// and returns a (target, indicator) pair the DragManager can commit on release
// and the DropIndicatorLayer can paint this frame.
//
// The function has no side effects: no DOM mutation, no MST action. Reading
// `elementsFromPoint` and `getBoundingClientRect` is idempotent for a given DOM
// state, which makes this testable via jsdom fixtures without mounting the
// editor.
//
// Marker precedence at each level of the walk-up:
//   1. data-editor-ui       → null (cancel silently)
//   2. data-inner-component-id → tree target (before / after / inside)
//   3. data-floating-root-id   → nest inside the floating element
//   4. data-viewport-id        → append to the app component tree
//   5. data-ground             → empty canvas → floating coords
// Any level where none match, we go up one parent.
//
// Source-skip: when the gesture is a `moveNode`, the source's own rendered DOM
// is excluded from the hit scan. Without this, a live-mode drag of a floating
// element over a viewport would resolve to the source itself (the floating
// wrapper follows the cursor). Viewports are DOM siblings of floating wrappers,
// so a naive walk-up from the source's ancestor chain would never reach the
// viewport behind it. elementsFromPoint lets us see past the source.

import type { ComponentInstance } from '@/models/ComponentModel';
import {
  DATA_EDITOR_UI,
  DATA_FLOATING_ROOT_ID,
  DATA_GROUND,
  DATA_GROUND_WRAPPER_ID,
  DATA_INNER_COMPONENT_ID,
  DATA_VIEWPORT_ID,
} from './markers';
import { classifyZone } from './zoneClassify';
import { isVoidTag } from './voidTags';
import type { DragSource, ResolveDropTargetOutput } from './types';

export interface ResolveDropTargetInput {
  pointer: { clientX: number; clientY: number };
  transform: { panX: number; panY: number; zoom: number };
  source: DragSource;
  // Pass the MST node for `moveNode` sources so we can do self / descendant
  // rejection here. `create` sources don't have an existing node.
  sourceNode?: ComponentInstance;
}

// Escape an arbitrary id for use in an attribute selector. CSS.escape is
// available in real browsers but absent in jsdom, so fall back to a minimal
// escape of the characters that matter inside a double-quoted attribute value.
// Our ids are UUIDs today (alphanumeric + hyphen), so the fallback is only
// defensive against future id-shape changes.
function attrSel(attr: string, value: string): string {
  const escape =
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS?.escape === 'function'
      ? (globalThis as { CSS: { escape: (v: string) => string } }).CSS.escape
      : (v: string) => v.replace(/(["\\])/g, '\\$1');
  return `[${attr}="${escape(value)}"]`;
}

// Returns true if `candidateId` equals `node.id` or is the id of any descendant.
// Used to reject moves that would create a cycle. `moveTreeComponent` also
// enforces this, but short-circuiting here also suppresses the drop indicator
// so the user doesn't see a false affordance.
function isDescendant(node: ComponentInstance, candidateId: string): boolean {
  for (const child of node.children) {
    if (child.id === candidateId) return true;
    if (isDescendant(child as ComponentInstance, candidateId)) return true;
  }
  return false;
}

// Collect every rendered DOM element that IS the source (any of its instances
// across viewports), is the source's floating wrapper, or is the outermost
// GroundWrapper div around a floating/viewport source. During the walk-up we
// treat any ancestor matching one of these as "inside the source subtree" and
// keep looking past it. `data-inner-component-id` can appear multiple times if
// the source is rendered in multiple viewports; all of them are source roots.
//
// The GroundWrapper outer div (data-ground-wrapper-id) is the important one
// for live-mode drags: it's position: fixed with a CSS transform that tracks
// the cursor, so elementsFromPoint puts it at the top of the hit stack. Without
// excluding it, the walk-up climbs through the camera/ground instead of seeing
// past to the viewport behind, and floating→viewport adoption silently fails.
function collectSourceRoots(source: DragSource): Element[] {
  if (source.kind !== 'moveNode') return [];
  const id = source.nodeId;
  const selectors = [
    attrSel(DATA_INNER_COMPONENT_ID, id),
    attrSel(DATA_FLOATING_ROOT_ID, id),
    attrSel(DATA_GROUND_WRAPPER_ID, id),
  ];
  const out: Element[] = [];
  for (const sel of selectors) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      out.push(el);
    }
  }
  return out;
}

function isInsideAnyRoot(el: Element, roots: Element[]): boolean {
  for (const root of roots) {
    if (root === el || root.contains(el)) return true;
  }
  return false;
}

export function resolveDropTarget(input: ResolveDropTargetInput): ResolveDropTargetOutput {
  const { pointer, transform, source, sourceNode } = input;

  const sourceRoots = collectSourceRoots(source);
  const stack = document.elementsFromPoint(pointer.clientX, pointer.clientY);
  // Skip past anything inside the source's rendered DOM. For live-mode drags
  // the source is at the cursor; without this filter the walk-up would stall
  // on the source's own inner-component-id and never see the viewport behind.
  const under = stack.find(el => !isInsideAnyRoot(el, sourceRoots)) ?? null;
  if (!under) return { target: null, indicator: null };

  for (let el: Element | null = under; el; el = el.parentElement) {
    // Defensive: should not happen since we entered at a non-source element,
    // but guards against the edge case where a source root is itself an
    // ancestor of a viewport / floating / ground marker (not the case today,
    // but cheap to keep correct).
    if (isInsideAnyRoot(el, sourceRoots)) return { target: null, indicator: null };

    // 1. UI chrome cancels the drop silently.
    if (el.hasAttribute(DATA_EDITOR_UI)) {
      return { target: null, indicator: null };
    }

    // 2. An inner component id is a concrete tree drop target.
    const innerId = el.getAttribute(DATA_INNER_COMPONENT_ID);
    if (innerId) {
      return resolveInnerTarget(el as HTMLElement, innerId, pointer, source, sourceNode);
    }

    // 3. A floating root wrapper without a nested inner-id hit (unusual but
    //    possible at the edges of the wrapper) resolves to the floating root.
    const floatingId = el.getAttribute(DATA_FLOATING_ROOT_ID);
    if (floatingId) {
      return resolveFloatingRootTarget(el as HTMLElement, floatingId, source, sourceNode);
    }

    // 4. A viewport frame with no inner hit appends to the app component tree.
    const viewportId = el.getAttribute(DATA_VIEWPORT_ID);
    if (viewportId) {
      return resolveViewportTarget(el as HTMLElement);
    }

    // 5. The ground fills the canvas. Pointer coords convert to canvas space.
    if (el.hasAttribute(DATA_GROUND)) {
      return resolveGroundTarget(el as HTMLElement, pointer, transform);
    }
  }

  return { target: null, indicator: null };
}

// Tags we treat as containers: an empty one is still a valid 'inside' drop
// target. Covers every registry div-based layout component (Container, Stack,
// Grid, Flex, Card) plus the semantic block containers the seeded app tree
// uses. Text-leaf tags (p, h1-h6, button, span, a, ...) are deliberately
// excluded so dropping into them doesn't clobber their string children.
const CONTAINER_TAGS = new Set([
  'div',
  'section',
  'article',
  'main',
  'header',
  'footer',
  'nav',
  'aside',
  'ul',
  'ol',
  'figure',
  'details',
  'form',
  'fieldset',
]);

function resolveInnerTarget(
  targetEl: HTMLElement,
  targetId: string,
  pointer: { clientX: number; clientY: number },
  source: DragSource,
  sourceNode?: ComponentInstance,
): ResolveDropTargetOutput {
  // Self-drop: pointer is over the source node's own rendered element.
  if (source.kind === 'moveNode' && targetId === source.nodeId) {
    return { target: null, indicator: null };
  }
  // Cycle: pointer is over a descendant of the source.
  if (source.kind === 'moveNode' && sourceNode && isDescendant(sourceNode, targetId)) {
    return { target: null, indicator: null };
  }

  const rect = targetEl.getBoundingClientRect();
  const tagName = targetEl.tagName.toLowerCase();
  const targetCanNest = !isVoidTag(tagName);
  // Allow 'inside' when the tag is a recognised container (even if empty) OR
  // when any tag already has element children. The container allowlist unlocks
  // dropping into freshly-created empty Containers; the child-count fallback
  // keeps the existing "element host that happens to contain stuff" behaviour
  // for anything outside the allowlist. Text-leaf hosts (p / button / h1 with
  // string-only children) stay protected from accidental clobber.
  const isContainerTag = CONTAINER_TAGS.has(tagName);
  const hasElementChildren = targetEl.childElementCount > 0;
  const canAcceptInside = targetCanNest && (isContainerTag || hasElementChildren);

  let kind = classifyZone(rect, pointer.clientY, canAcceptInside);
  // Defensive collapse for void tags in case classifier was misconfigured.
  if (kind === 'inside' && !targetCanNest) {
    kind = pointer.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  }

  if (kind === 'inside') {
    return {
      target: { kind: 'parent', parentId: targetId },
      indicator: { kind: 'inside', rect, targetId },
    };
  }

  return {
    target: { kind: 'sibling', siblingId: targetId, position: kind },
    indicator: { kind, rect, targetId },
  };
}

function resolveFloatingRootTarget(
  rootEl: HTMLElement,
  floatingId: string,
  source: DragSource,
  sourceNode?: ComponentInstance,
): ResolveDropTargetOutput {
  if (source.kind === 'moveNode' && floatingId === source.nodeId) {
    return { target: null, indicator: null };
  }
  if (source.kind === 'moveNode' && sourceNode && isDescendant(sourceNode, floatingId)) {
    return { target: null, indicator: null };
  }
  const rect = rootEl.getBoundingClientRect();
  return {
    target: { kind: 'parent', parentId: floatingId },
    indicator: { kind: 'inside', rect, targetId: floatingId },
  };
}

function resolveViewportTarget(viewportEl: HTMLElement): ResolveDropTargetOutput {
  const rect = viewportEl.getBoundingClientRect();
  const id = viewportEl.getAttribute(DATA_VIEWPORT_ID) ?? '';
  return {
    target: { kind: 'appTree' },
    indicator: { kind: 'inside', rect, targetId: id },
  };
}

function resolveGroundTarget(
  groundEl: HTMLElement,
  pointer: { clientX: number; clientY: number },
  transform: { panX: number; panY: number; zoom: number },
): ResolveDropTargetOutput {
  const rect = groundEl.getBoundingClientRect();
  const canvasX = (pointer.clientX - rect.left - transform.panX) / transform.zoom;
  const canvasY = (pointer.clientY - rect.top - transform.panY) / transform.zoom;
  return {
    target: { kind: 'floating', x: canvasX, y: canvasY },
    // No indicator for floating drops: the source element follows the cursor
    // in live mode, and the ghost pill follows it in ghost mode; an extra
    // overlay rectangle on empty canvas would be noise.
    indicator: null,
  };
}

// Helper that a future caller (tests / DragManager) might want.
export { attrSel };
