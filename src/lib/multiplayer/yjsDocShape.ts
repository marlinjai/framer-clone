// src/lib/multiplayer/yjsDocShape.ts
//
// Yjs document schema mirroring the persisted shape of ProjectModel /
// PageModel / ComponentModel. Once multiplayer ships, this Yjs doc is the
// canonical source of truth for canvas state — MST becomes a derived
// projection. This module is the contract every other multiplayer spec
// (sync server, MST binding, undo manager, presence) builds against.
//
// Design rationale
// ----------------
// 1. Flat ID-keyed node registry (`nodes: Y.Map<Y.Map>`).
//    Components in MST form a tree (children → children → ...). Mirroring
//    that tree as nested Y.Maps would force every move/reparent to flatten
//    and re-create deep subtrees, which is both slow and conflicts badly
//    under concurrent edits. Instead we keep a single flat map keyed by
//    component id, and store `children` as a `Y.Array<string>` of ids.
//    Re-parenting is a child-id swap between two arrays.
//
// 2. `children: Y.Array<string>` (id refs, not nested maps).
//    Y.Array gives us LWW-free ordering with concurrent inserts/moves —
//    exactly what we want for sibling order on the canvas. Storing ids
//    keeps the array cheap to update; the actual node data lives in the
//    flat registry.
//
// 3. `props.style` and responsive value maps as `Y.Map`s (not blobs).
//    Two users editing `padding` and `color` on the same node should not
//    overwrite each other. A whole-style blob would lose one of those
//    edits. Per-property Y.Maps give us per-property LWW.
//    Same reasoning applies one level deeper to responsive maps
//    (`{ base: '100%', mobile: '50%' }`): two users editing different
//    breakpoint values of the same style key shouldn't conflict.
//
// 4. Plain-JSON for SEO metadata, breakpoint list, and non-style
//    component props. These rarely have concurrent edits and atomic
//    replacement is fine.
//
// Out of scope (per spec)
// -----------------------
// - Y.Text for inline text content (deferred).
// - Live MST↔Yjs binding (separate spec: yjs-mst-binding-slice / -full).
// - Awareness/presence shape (separate spec).
// - Y.UndoManager wiring (separate spec).
// - Schema migrations beyond v1.

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as Y from 'yjs';
import type { ProjectSnapshotIn } from '@/models/ProjectModel';
import type {
  ComponentSnapshotIn,
  PropsRecord,
} from '@/models/ComponentModel';
import {
  ComponentTypeEnum,
  CanvasNodeType,
} from '@/models/ComponentModel';
import type { PageSnapshotIn } from '@/models/PageModel';

// ---------------------------------------------------------------------------
// Schema constants
// ---------------------------------------------------------------------------

export const YJS_DOC_SCHEMA_VERSION = 1 as const;

export const YJS_KEYS = {
  /** Top-level Y.Map of project-scope metadata (schema version, name, ...). */
  project: 'project',
  /** Top-level Y.Array<string> of page ids in display order. */
  pageOrder: 'pages',
  /** Top-level Y.Map<Y.Map>: pageId -> page meta map. */
  pagesById: 'pages_by_id',
  /** Top-level Y.Map<Y.Map>: componentId -> node map (flat registry). */
  nodes: 'nodes',
} as const;

export const YJS_PROJECT_KEYS = {
  schemaVersion: 'schemaVersion',
  projectId: 'projectId',
  name: 'name',
  description: 'description',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  primaryBreakpointId: 'primaryBreakpointId',
} as const;

export const YJS_PAGE_KEYS = {
  id: 'id',
  slug: 'slug',
  metadata: 'metadata',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  breakpoints: 'breakpoints',
  appTreeRootId: 'appTreeRootId',
  canvasNodeIds: 'canvasNodeIds',
} as const;

export const YJS_NODE_KEYS = {
  id: 'id',
  type: 'type',
  componentType: 'componentType',
  canvasNodeType: 'canvasNodeType',
  canvasX: 'canvasX',
  canvasY: 'canvasY',
  canvasScale: 'canvasScale',
  canvasRotation: 'canvasRotation',
  canvasZIndex: 'canvasZIndex',
  canvasVisible: 'canvasVisible',
  canvasLocked: 'canvasLocked',
  parentId: 'parentId',
  breakpointId: 'breakpointId',
  breakpointMinWidth: 'breakpointMinWidth',
  viewportWidth: 'viewportWidth',
  viewportHeight: 'viewportHeight',
  label: 'label',
  pageId: 'pageId',
  props: 'props',
  children: 'children',
} as const;

export const YJS_PROPS_KEYS = {
  /** Nested Y.Map of style properties (per-property LWW). */
  style: 'style',
} as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface YProjectMeta {
  schemaVersion: number;
  projectId: string;
  name: string;
  primaryBreakpointId: string;
}

export interface YBreakpointInfo {
  id: string;
  label: string;
  minWidth: number;
  /** Optional: viewport-frame dimensions when the breakpoint was authored. */
  viewportWidth?: number;
  viewportHeight?: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build an empty Y.Doc with the four top-level shared types initialised and
 * project-scope metadata seeded. The doc has no pages, no nodes — those are
 * populated separately (via `mstSnapshotToYDoc` or by the live binding).
 */
export function createEmptyProjectYDoc(args: {
  projectId: string;
  name: string;
  primaryBreakpointId: string;
}): Y.Doc {
  const doc = new Y.Doc();
  const project = doc.getMap(YJS_KEYS.project);
  const pageOrder = doc.getArray<string>(YJS_KEYS.pageOrder);
  const pagesById = doc.getMap<Y.Map<unknown>>(YJS_KEYS.pagesById);
  const nodes = doc.getMap<Y.Map<unknown>>(YJS_KEYS.nodes);

  // Touch each shared type so it's part of the encoded state even if empty.
  // (yjs creates them lazily; reading is enough to register.)
  void pageOrder;
  void pagesById;
  void nodes;

  doc.transact(() => {
    project.set(YJS_PROJECT_KEYS.schemaVersion, YJS_DOC_SCHEMA_VERSION);
    project.set(YJS_PROJECT_KEYS.projectId, args.projectId);
    project.set(YJS_PROJECT_KEYS.name, args.name);
    project.set(YJS_PROJECT_KEYS.primaryBreakpointId, args.primaryBreakpointId);
  });

  return doc;
}

// ---------------------------------------------------------------------------
// Path helpers (used by the binding layer in subsequent specs)
// ---------------------------------------------------------------------------

export function getNodeMap(doc: Y.Doc, nodeId: string): Y.Map<any> | undefined {
  const nodes = doc.getMap<Y.Map<any>>(YJS_KEYS.nodes);
  return nodes.get(nodeId);
}

export function getChildrenArray(
  doc: Y.Doc,
  nodeId: string,
): Y.Array<string> | undefined {
  const node = getNodeMap(doc, nodeId);
  if (!node) return undefined;
  const children = node.get(YJS_NODE_KEYS.children);
  return children instanceof Y.Array ? (children as Y.Array<string>) : undefined;
}

export function getPageMap(doc: Y.Doc, pageId: string): Y.Map<any> | undefined {
  const pagesById = doc.getMap<Y.Map<any>>(YJS_KEYS.pagesById);
  return pagesById.get(pageId);
}

// ---------------------------------------------------------------------------
// MST snapshot -> Y.Doc
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Encode a `props` object into a `Y.Map`. Any plain-object value under the
 * top-level `style` key becomes a nested `Y.Map` (so two users editing the
 * same style key on different breakpoints get per-breakpoint LWW). Other
 * non-style keys are stored as plain JSON values.
 */
function encodePropsToYMap(props: PropsRecord | undefined): Y.Map<any> {
  const propsMap = new Y.Map<any>();
  if (!props) return propsMap;

  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (key === YJS_PROPS_KEYS.style && isPlainObject(value)) {
      propsMap.set(key, encodeStyleToYMap(value));
    } else {
      propsMap.set(key, value);
    }
  }
  return propsMap;
}

function encodeStyleToYMap(style: Record<string, unknown>): Y.Map<any> {
  const styleMap = new Y.Map<any>();
  for (const [key, value] of Object.entries(style)) {
    if (value === undefined) continue;
    if (isPlainObject(value)) {
      // Responsive map: { base: '100%', mobile: '50%', ... }.
      const inner = new Y.Map<any>();
      for (const [bpKey, bpValue] of Object.entries(value)) {
        if (bpValue === undefined) continue;
        inner.set(bpKey, bpValue);
      }
      styleMap.set(key, inner);
    } else {
      styleMap.set(key, value);
    }
  }
  return styleMap;
}

/**
 * Walk one MST component snapshot subtree, registering each node into the
 * flat `nodes` registry and returning its id. `parentId` is propagated so
 * the registry preserves parent linkage even for nested children.
 */
function registerComponentTree(
  nodes: Y.Map<Y.Map<any>>,
  snapshot: ComponentSnapshotIn,
  pageId: string,
  parentId: string | undefined,
): string {
  const node = new Y.Map<any>();
  const id = snapshot.id;
  if (!id) {
    throw new Error(
      '[yjsDocShape] component snapshot is missing required `id` field',
    );
  }

  // Required scalars.
  node.set(YJS_NODE_KEYS.id, id);
  node.set(YJS_NODE_KEYS.type, snapshot.type);
  node.set(
    YJS_NODE_KEYS.componentType,
    snapshot.componentType ?? ComponentTypeEnum.HOST,
  );
  node.set(
    YJS_NODE_KEYS.canvasNodeType,
    snapshot.canvasNodeType ?? CanvasNodeType.COMPONENT,
  );
  node.set(YJS_NODE_KEYS.pageId, pageId);

  // Optional / defaulted scalars — only emit when source defined them, so
  // round-trips stay deepEqual against MST `getSnapshot()` output (which
  // fills defaults) and don't *invent* fields when the source omitted them.
  setIfDefined(node, YJS_NODE_KEYS.canvasX, snapshot.canvasX);
  setIfDefined(node, YJS_NODE_KEYS.canvasY, snapshot.canvasY);
  setIfDefined(node, YJS_NODE_KEYS.canvasScale, snapshot.canvasScale);
  setIfDefined(node, YJS_NODE_KEYS.canvasRotation, snapshot.canvasRotation);
  setIfDefined(node, YJS_NODE_KEYS.canvasZIndex, snapshot.canvasZIndex);
  setIfDefined(node, YJS_NODE_KEYS.canvasVisible, snapshot.canvasVisible);
  setIfDefined(node, YJS_NODE_KEYS.canvasLocked, snapshot.canvasLocked);
  setIfDefined(node, YJS_NODE_KEYS.label, snapshot.label);
  setIfDefined(node, YJS_NODE_KEYS.breakpointId, snapshot.breakpointId);
  setIfDefined(
    node,
    YJS_NODE_KEYS.breakpointMinWidth,
    snapshot.breakpointMinWidth,
  );
  setIfDefined(node, YJS_NODE_KEYS.viewportWidth, snapshot.viewportWidth);
  setIfDefined(node, YJS_NODE_KEYS.viewportHeight, snapshot.viewportHeight);

  // Parent linkage — prefer the snapshot's own parentId if present, else
  // the recursion-supplied one. (For top-level appTree root and canvas
  // nodes both will be undefined.)
  const resolvedParent = snapshot.parentId ?? parentId;
  setIfDefined(node, YJS_NODE_KEYS.parentId, resolvedParent);

  // Props (with nested style Y.Map).
  node.set(YJS_NODE_KEYS.props, encodePropsToYMap(snapshot.props));

  // Children: register the child subtree first so `nodes` is fully populated
  // before any binding observer sees the parent's children array.
  const childArr = new Y.Array<string>();
  const sourceChildren = (snapshot.children ?? []) as ComponentSnapshotIn[];
  const childIds: string[] = [];
  for (const child of sourceChildren) {
    childIds.push(registerComponentTree(nodes, child, pageId, id));
  }
  if (childIds.length > 0) childArr.push(childIds);
  node.set(YJS_NODE_KEYS.children, childArr);

  nodes.set(id, node);
  return id;
}

function setIfDefined(map: Y.Map<any>, key: string, value: unknown): void {
  if (value === undefined) return;
  map.set(key, value);
}

function toEpochMs(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }
  return Date.now();
}

/**
 * Convert a full ProjectSnapshotIn into a fresh Y.Doc shaped per the
 * schema above. Pure function — no MST instance is created.
 */
export function mstSnapshotToYDoc(snapshot: ProjectSnapshotIn): Y.Doc {
  if (!snapshot.id) {
    throw new Error('[yjsDocShape] project snapshot missing `id`');
  }

  const projectId = snapshot.id;
  const projectName = snapshot.metadata?.title ?? '';
  const projectDescription = snapshot.metadata?.description ?? '';
  const projectCreatedAt = toEpochMs(snapshot.metadata?.createdAt);
  const projectUpdatedAt = toEpochMs(snapshot.metadata?.updatedAt);

  // Pick a sensible primaryBreakpointId default: first viewport node we
  // find in the first page. Live wiring will let users override.
  let primaryBreakpointId = '';
  const pagesEntries = pagesEntriesFromSnapshot(snapshot.pages);
  for (const [, page] of pagesEntries) {
    const found = firstViewportBreakpointId(page);
    if (found) {
      primaryBreakpointId = found;
      break;
    }
  }

  const doc = createEmptyProjectYDoc({
    projectId,
    name: projectName,
    primaryBreakpointId,
  });

  const project = doc.getMap(YJS_KEYS.project);
  const pageOrder = doc.getArray<string>(YJS_KEYS.pageOrder);
  const pagesById = doc.getMap<Y.Map<any>>(YJS_KEYS.pagesById);
  const nodes = doc.getMap<Y.Map<any>>(YJS_KEYS.nodes);

  doc.transact(() => {
    project.set(YJS_PROJECT_KEYS.description, projectDescription);
    project.set(YJS_PROJECT_KEYS.createdAt, projectCreatedAt);
    project.set(YJS_PROJECT_KEYS.updatedAt, projectUpdatedAt);

    for (const [pageId, page] of pagesEntries) {
      const pageMap = new Y.Map<any>();
      pageMap.set(YJS_PAGE_KEYS.id, pageId);
      pageMap.set(YJS_PAGE_KEYS.slug, page.slug ?? '');

      // Page metadata stored as a plain JSON blob — atomic LWW is fine for
      // SEO fields, none of which are co-edited.
      pageMap.set(YJS_PAGE_KEYS.metadata, normalisePageMetadata(page.metadata));
      pageMap.set(YJS_PAGE_KEYS.createdAt, toEpochMs(page.createdAt));
      pageMap.set(YJS_PAGE_KEYS.updatedAt, toEpochMs(page.updatedAt));

      // App tree — single root, register subtree.
      let appTreeRootId: string | undefined;
      if (page.appComponentTree) {
        appTreeRootId = registerComponentTree(
          nodes,
          page.appComponentTree as ComponentSnapshotIn,
          pageId,
          undefined,
        );
      }
      if (appTreeRootId) {
        pageMap.set(YJS_PAGE_KEYS.appTreeRootId, appTreeRootId);
      }

      // Top-level canvas nodes (viewports + floating elements). Each may
      // itself have a subtree of children which gets flattened into nodes.
      const canvasNodeIds = new Y.Array<string>();
      const canvasEntries = canvasNodesEntries(page.canvasNodes);
      const collectedIds: string[] = [];
      const breakpoints: YBreakpointInfo[] = [];
      for (const node of canvasEntries) {
        const id = registerComponentTree(
          nodes,
          node,
          pageId,
          undefined,
        );
        collectedIds.push(id);
        if (
          node.canvasNodeType === CanvasNodeType.VIEWPORT &&
          node.breakpointId
        ) {
          breakpoints.push({
            id: node.breakpointId,
            label: node.label ?? '',
            minWidth: node.breakpointMinWidth ?? 0,
            viewportWidth: node.viewportWidth,
            viewportHeight: node.viewportHeight,
          });
        }
      }
      if (collectedIds.length > 0) canvasNodeIds.push(collectedIds);
      pageMap.set(YJS_PAGE_KEYS.canvasNodeIds, canvasNodeIds);

      // Plain-JSON breakpoints array — duplicated info we maintain so the
      // sync server (and presence layer) can reason about breakpoints
      // without walking every node.
      const bpArr = new Y.Array<YBreakpointInfo>();
      if (breakpoints.length > 0) bpArr.push(breakpoints);
      pageMap.set(YJS_PAGE_KEYS.breakpoints, bpArr);

      pagesById.set(pageId, pageMap);
      pageOrder.push([pageId]);
    }
  });

  return doc;
}

function pagesEntriesFromSnapshot(
  pages: ProjectSnapshotIn['pages'] | undefined,
): Array<[string, PageSnapshotIn]> {
  if (!pages) return [];
  // MST `types.map` snapshots come through as `{ [id]: pageSnapshot }`.
  return Object.entries(pages as Record<string, PageSnapshotIn>);
}

function canvasNodesEntries(
  canvasNodes: PageSnapshotIn['canvasNodes'] | undefined,
): ComponentSnapshotIn[] {
  if (!canvasNodes) return [];
  const record = canvasNodes as Record<string, ComponentSnapshotIn>;
  return Object.values(record);
}

function firstViewportBreakpointId(page: PageSnapshotIn): string | undefined {
  if (!page.canvasNodes) return undefined;
  for (const node of canvasNodesEntries(page.canvasNodes)) {
    if (
      node.canvasNodeType === CanvasNodeType.VIEWPORT &&
      typeof node.breakpointId === 'string' &&
      node.breakpointId.length > 0
    ) {
      return node.breakpointId;
    }
  }
  return undefined;
}

function normalisePageMetadata(
  metadata: PageSnapshotIn['metadata'] | undefined,
): Record<string, unknown> {
  const m = (metadata ?? {}) as Record<string, unknown>;
  return {
    title: typeof m.title === 'string' ? m.title : '',
    description: typeof m.description === 'string' ? m.description : '',
    keywords: Array.isArray(m.keywords) ? [...(m.keywords as string[])] : [],
    ogTitle: typeof m.ogTitle === 'string' ? m.ogTitle : '',
    ogDescription:
      typeof m.ogDescription === 'string' ? m.ogDescription : '',
    ogImage: typeof m.ogImage === 'string' ? m.ogImage : '',
    canonicalUrl:
      typeof m.canonicalUrl === 'string' ? m.canonicalUrl : '',
  };
}

// ---------------------------------------------------------------------------
// Y.Doc -> MST snapshot
// ---------------------------------------------------------------------------

function decodeStyleFromYMap(styleMap: Y.Map<any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  styleMap.forEach((value, key) => {
    if (value instanceof Y.Map) {
      const inner: Record<string, unknown> = {};
      (value as Y.Map<any>).forEach((bpVal, bpKey) => {
        inner[bpKey] = bpVal;
      });
      out[key] = inner;
    } else {
      out[key] = value;
    }
  });
  return out;
}

function decodePropsFromYMap(propsMap: Y.Map<any>): PropsRecord {
  const out: PropsRecord = {};
  propsMap.forEach((value, key) => {
    if (key === YJS_PROPS_KEYS.style && value instanceof Y.Map) {
      out[key] = decodeStyleFromYMap(value);
    } else {
      out[key] = value;
    }
  });
  return out;
}

/**
 * Recursively rebuild a ComponentSnapshotIn from the flat Yjs node registry,
 * starting at `nodeId`. `visited` guards against accidental cycles in
 * malformed data — a node can't be its own descendant.
 */
function buildComponentSnapshot(
  nodes: Y.Map<Y.Map<any>>,
  nodeId: string,
  visited: Set<string>,
): ComponentSnapshotIn {
  if (visited.has(nodeId)) {
    throw new Error(
      `[yjsDocShape] cycle detected while decoding node ${nodeId}`,
    );
  }
  visited.add(nodeId);

  const node = nodes.get(nodeId);
  if (!node) {
    throw new Error(`[yjsDocShape] node ${nodeId} not found in registry`);
  }

  const snap: Record<string, unknown> = {
    id: node.get(YJS_NODE_KEYS.id),
    type: node.get(YJS_NODE_KEYS.type),
    componentType: node.get(YJS_NODE_KEYS.componentType),
    canvasNodeType: node.get(YJS_NODE_KEYS.canvasNodeType),
  };

  // Optional fields — only set when present on the node.
  copyIfPresent(node, snap, YJS_NODE_KEYS.canvasX);
  copyIfPresent(node, snap, YJS_NODE_KEYS.canvasY);
  copyIfPresent(node, snap, YJS_NODE_KEYS.canvasScale);
  copyIfPresent(node, snap, YJS_NODE_KEYS.canvasRotation);
  copyIfPresent(node, snap, YJS_NODE_KEYS.canvasZIndex);
  copyIfPresent(node, snap, YJS_NODE_KEYS.canvasVisible);
  copyIfPresent(node, snap, YJS_NODE_KEYS.canvasLocked);
  copyIfPresent(node, snap, YJS_NODE_KEYS.label);
  copyIfPresent(node, snap, YJS_NODE_KEYS.breakpointId);
  copyIfPresent(node, snap, YJS_NODE_KEYS.breakpointMinWidth);
  copyIfPresent(node, snap, YJS_NODE_KEYS.viewportWidth);
  copyIfPresent(node, snap, YJS_NODE_KEYS.viewportHeight);
  copyIfPresent(node, snap, YJS_NODE_KEYS.parentId);

  const propsMap = node.get(YJS_NODE_KEYS.props);
  snap.props = propsMap instanceof Y.Map ? decodePropsFromYMap(propsMap) : {};

  const childrenArr = node.get(YJS_NODE_KEYS.children);
  if (childrenArr instanceof Y.Array) {
    const ids = childrenArr.toArray() as string[];
    snap.children = ids.map((cid) =>
      buildComponentSnapshot(nodes, cid, new Set(visited)),
    );
  } else {
    snap.children = [];
  }

  return snap as ComponentSnapshotIn;
}

function copyIfPresent(
  source: Y.Map<any>,
  target: Record<string, unknown>,
  key: string,
): void {
  if (source.has(key)) {
    target[key] = source.get(key);
  }
}

/**
 * Convert a Yjs project doc back into a `ProjectSnapshotIn` suitable for
 * `ProjectModel.create(...)`. The pages map and component trees are
 * reconstituted by walking the flat node registry from each page's
 * `appTreeRootId` and `canvasNodeIds` entries.
 */
export function yDocToMstSnapshot(doc: Y.Doc): ProjectSnapshotIn {
  const project = doc.getMap<any>(YJS_KEYS.project);
  const pageOrder = doc.getArray<string>(YJS_KEYS.pageOrder);
  const pagesById = doc.getMap<Y.Map<any>>(YJS_KEYS.pagesById);
  const nodes = doc.getMap<Y.Map<any>>(YJS_KEYS.nodes);

  const projectId = project.get(YJS_PROJECT_KEYS.projectId) as string;
  const name =
    (project.get(YJS_PROJECT_KEYS.name) as string | undefined) ?? '';
  const description =
    (project.get(YJS_PROJECT_KEYS.description) as string | undefined) ?? '';
  const createdAt = project.get(YJS_PROJECT_KEYS.createdAt) as
    | number
    | undefined;
  const updatedAt = project.get(YJS_PROJECT_KEYS.updatedAt) as
    | number
    | undefined;

  const pagesSnapshot: Record<string, PageSnapshotIn> = {};
  for (const pageId of pageOrder.toArray()) {
    const pageMap = pagesById.get(pageId);
    if (!pageMap) continue;

    const slug = (pageMap.get(YJS_PAGE_KEYS.slug) as string | undefined) ?? '';
    const metadata = pageMap.get(YJS_PAGE_KEYS.metadata) as
      | Record<string, unknown>
      | undefined;
    const pageCreatedAt = pageMap.get(YJS_PAGE_KEYS.createdAt) as
      | number
      | undefined;
    const pageUpdatedAt = pageMap.get(YJS_PAGE_KEYS.updatedAt) as
      | number
      | undefined;

    const appTreeRootId = pageMap.get(YJS_PAGE_KEYS.appTreeRootId) as
      | string
      | undefined;
    const canvasNodeIdsArr = pageMap.get(YJS_PAGE_KEYS.canvasNodeIds);
    const canvasNodeIds =
      canvasNodeIdsArr instanceof Y.Array
        ? (canvasNodeIdsArr.toArray() as string[])
        : [];

    const appComponentTree = appTreeRootId
      ? buildComponentSnapshot(nodes, appTreeRootId, new Set())
      : undefined;

    const canvasNodes: Record<string, ComponentSnapshotIn> = {};
    for (const cid of canvasNodeIds) {
      canvasNodes[cid] = buildComponentSnapshot(nodes, cid, new Set());
    }

    const pageSnap: Record<string, unknown> = {
      id: pageId,
      slug,
      metadata: metadata ?? { title: '' },
      canvasNodes,
    };
    if (appComponentTree) pageSnap.appComponentTree = appComponentTree;
    if (pageCreatedAt !== undefined) pageSnap.createdAt = pageCreatedAt;
    if (pageUpdatedAt !== undefined) pageSnap.updatedAt = pageUpdatedAt;

    pagesSnapshot[pageId] = pageSnap as PageSnapshotIn;
  }

  const snapshot: Record<string, unknown> = {
    id: projectId,
    metadata: {
      title: name,
      description,
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    },
    pages: pagesSnapshot,
  };

  return snapshot as ProjectSnapshotIn;
}
