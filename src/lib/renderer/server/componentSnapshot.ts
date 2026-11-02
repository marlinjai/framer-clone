// componentSnapshot: a ComponentModel snapshot as a serializable `ComponentNode`,
// and a page's breakpoints from its canvas nodes. Separate from
// snapshotToComponentNode because expansion needs both for a definition's page,
// and that adaptor calls expansion.
//
// PURE: no React, no MST, no Prisma, no `server-only`.

import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { ComponentSnapshotOut } from '@/models/ComponentModel';
import type { BreakpointRef } from '@/lib/responsive/cascade';
import { CSS_PROP_SET } from '@/lib/styles/cssPropSet';

/**
 * A structural, MST-free view of a ComponentModel SnapshotOut. The real
 * SnapshotOut carries many editor-only fields; we read only the five that map
 * onto a ComponentNode. Declared loosely (optional) so a snapshot from an older
 * or newer ComponentModel shape still adapts without a type break.
 */
export type ComponentSnapshotLike = Pick<
  ComponentSnapshotOut,
  'id' | 'type'
> & {
  props?: Record<string, unknown>;
  bindings?: Record<string, unknown>;
  children?: ComponentSnapshotLike[];
};

function hasEntries(value: unknown): boolean {
  return !!value && typeof value === 'object' && Object.keys(value as object).length > 0;
}

/** Move top-level CSS keys into `style`; an existing `style` entry wins. Unchanged when there are none. */
export function foldCssProps(props: Record<string, unknown>): Record<string, unknown> {
  const cssKeys = Object.keys(props).filter(k => CSS_PROP_SET.has(k));
  if (cssKeys.length === 0) return props;
  const rest: Record<string, unknown> = {};
  const lifted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (CSS_PROP_SET.has(key)) lifted[key] = value;
    else rest[key] = value;
  }
  const style = props.style && typeof props.style === 'object' && !Array.isArray(props.style)
    ? (props.style as Record<string, unknown>)
    : {};
  return { ...rest, style: { ...lifted, ...style } };
}

/**
 * Map a single ComponentModel SnapshotOut node to a ComponentNode. Faithful on
 * the five shared fields; the editor-only canvas fields are dropped. Empty
 * `props` / `bindings` / `children` are omitted to keep the node minimal.
 */
export function componentSnapshotToNode(snapshot: ComponentSnapshotLike): ComponentNode {
  const node: ComponentNode = { type: snapshot.type };

  if (typeof snapshot.id === 'string' && snapshot.id.length > 0) {
    node.id = snapshot.id;
  }
  if (hasEntries(snapshot.props)) {
    // Props are passed through, except that a CSS key stored at the top level
    // moves into `style`, exactly as the editor's getResolvedProps routes it
    // (top-level first, `style` wins on a clash). Otherwise the live site would
    // render it as an HTML attribute. Binding resolution and responsive styles
    // happen downstream (hydrateBindings / applyResponsiveStyles).
    node.props = foldCssProps(snapshot.props as Record<string, unknown>) as ComponentNode['props'];
  }
  if (hasEntries(snapshot.bindings)) {
    node.bindings = snapshot.bindings as ComponentNode['bindings'];
  }
  const children = snapshot.children;
  if (Array.isArray(children) && children.length > 0) {
    node.children = children.filter((child) => typeof child === 'object' && child !== null).map(componentSnapshotToNode);
  }

  return node;
}

/** The shape of a viewport canvas node we read (MST-free, loosely typed). */
interface ViewportSnapshotLike {
  canvasNodeType?: unknown;
  breakpointId?: unknown;
  breakpointMinWidth?: unknown;
}

/**
 * The page's breakpoints from its viewport canvas nodes: every viewport with a
 * string id and a finite min width, deduplicated by id (first wins), sorted
 * largest first with ties by id so the order never depends on map order.
 */
export function extractBreakpoints(canvasNodes: unknown): BreakpointRef[] {
  if (!canvasNodes || typeof canvasNodes !== 'object') return [];
  const seen = new Set<string>();
  const out: BreakpointRef[] = [];
  for (const node of Object.values(canvasNodes as Record<string, ViewportSnapshotLike>)) {
    if (!node || node.canvasNodeType !== 'viewport') continue;
    const { breakpointId: id, breakpointMinWidth: minWidth } = node;
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    if (typeof minWidth !== 'number' || !Number.isFinite(minWidth)) continue;
    seen.add(id);
    out.push({ id, minWidth });
  }
  return out.sort((a, b) => b.minWidth - a.minWidth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
