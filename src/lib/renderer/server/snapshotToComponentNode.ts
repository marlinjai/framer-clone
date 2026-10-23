// snapshotToComponentNode: the pure, SSR-safe adaptor from a persisted page
// snapshot to the serializable `ComponentNode` shape the publish hydrator
// (`hydrateBindings`) and the server renderer (`renderComponentNode`) consume.
//
// A `SitePage.snapshot` is a full PageModel SnapshotOut. Its `appComponentTree`
// field is the renderable root (a ComponentModel SnapshotOut); `canvasNodes`
// holds the editor's viewport / floating canvas nodes and is INTENTIONALLY NOT
// rendered on the published page (those live on the editor canvas, never in the
// deployed app, exactly as HeadlessPageRenderer ignores them). The viewport
// nodes do carry the page's breakpoints (`breakpointId` / `breakpointMinWidth`),
// which the published stylesheet needs to turn responsive styles into media
// queries, so those two fields are lifted out. The page's `metadata`
// (title / description / og*) feeds SEO.
//
// This module is PURE: no React, no MST, no Prisma, no `server-only`. It maps a
// ComponentModel SnapshotOut onto `ComponentNode` field-for-field
// (type / props / bindings / children / id), dropping the editor-only canvas
// fields (componentType / canvasX / canvasY / viewport* / label / parentId /
// ...) that the renderer does not need. Empty `props` / `bindings` / `children`
// are omitted so the produced tree is minimal and round-trips cleanly in tests.

import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { PageSnapshotOut } from '@/models/PageModel';
import type { ComponentSnapshotOut } from '@/models/ComponentModel';
import type { BreakpointRef } from '@/lib/responsive/cascade';
import { CSS_PROP_SET } from '@/lib/styles/cssPropSet';

/**
 * SEO metadata lifted off the page snapshot. A plain, serializable subset of
 * PageMetadataModel: the fields the published `<head>` needs. Kept here (rather
 * than importing the MST model type) so this module stays MST-free.
 */
export interface PageSeoMetadata {
  title: string;
  description: string;
  keywords: string[];
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  canonicalUrl: string;
}

/**
 * The adaptor output: the renderable root as a ComponentNode plus the page slug
 * and SEO metadata. `root` is null when the snapshot carries no app component
 * tree (a malformed / empty page), so callers can 404 rather than render a
 * blank shell.
 */
export interface AdaptedPage {
  root: ComponentNode | null;
  slug: string;
  metadata: PageSeoMetadata;
  /** The page's breakpoints (one per viewport node), largest first; empty when none. */
  breakpoints: BreakpointRef[];
}

/**
 * A structural, MST-free view of a ComponentModel SnapshotOut. The real
 * SnapshotOut carries many editor-only fields; we read only the five that map
 * onto a ComponentNode. Declared loosely (optional) so a snapshot from an older
 * or newer ComponentModel shape still adapts without a type break.
 */
type ComponentSnapshotLike = Pick<
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
    node.children = children.map(componentSnapshotToNode);
  }

  return node;
}

const EMPTY_METADATA: PageSeoMetadata = {
  title: '',
  description: '',
  keywords: [],
  ogTitle: '',
  ogDescription: '',
  ogImage: '',
  canonicalUrl: '',
};

/** Lift the SEO metadata off the page snapshot, defaulting every field. */
function extractMetadata(snapshot: PageSnapshotOut): PageSeoMetadata {
  const meta = snapshot.metadata as Partial<PageSeoMetadata> | undefined;
  if (!meta) return { ...EMPTY_METADATA };
  return {
    title: meta.title ?? '',
    description: meta.description ?? '',
    keywords: Array.isArray(meta.keywords) ? [...meta.keywords] : [],
    ogTitle: meta.ogTitle ?? '',
    ogDescription: meta.ogDescription ?? '',
    ogImage: meta.ogImage ?? '',
    canonicalUrl: meta.canonicalUrl ?? '',
  };
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

/**
 * Adapt a persisted PageModel SnapshotOut into the renderer's input: the
 * `appComponentTree` mapped to a ComponentNode, the slug, the SEO metadata and
 * the breakpoints. `canvasNodes` are otherwise ignored (editor-only). A snapshot with no
 * `appComponentTree` yields `root: null` so the caller can 404.
 */
export function snapshotToComponentNode(snapshot: PageSnapshotOut): AdaptedPage {
  const tree = snapshot.appComponentTree as ComponentSnapshotLike | undefined;
  return {
    root: tree ? componentSnapshotToNode(tree) : null,
    slug: typeof snapshot.slug === 'string' ? snapshot.slug : '',
    metadata: extractMetadata(snapshot),
    breakpoints: extractBreakpoints(snapshot.canvasNodes),
  };
}
