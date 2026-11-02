// src/models/PageModel.ts
import { defaultViewportSnapshots, hasViewport, repairBreakpointIds } from '@/lib/canvas/defaultViewports';
import {
  types,
  Instance,
  SnapshotIn,
  SnapshotOut,
  IAnyModelType,
  detach,
  getRoot,
  getParent,
  getSnapshot,
  hasParent,
} from 'mobx-state-tree';
import { v4 as uuidv4 } from 'uuid';
import ComponentModel, {
  ComponentInstance,
  ComponentSnapshotIn,
  CanvasNodeType,
  ComponentTypeEnum,
  type PropsRecord,
  createIntrinsicComponent,
  createFloatingCanvasComponent,
} from './ComponentModel';
import { isStickyCta } from '@/lib/stickyCta/stickyCta';
import { remapBehaviourRefs } from '@/lib/behaviour/format';
import { PRESETS, type PresetNode } from '@/lib/behaviour/presets';
import { renewCopyIds } from '@/lib/renderer/idRefs';
import {
  contentModelRefusal,
  placedDefinitionIds,
  placementRefusal,
  type ComponentDefinitions,
} from '@/lib/components/definition';
import { PLACEMENT_TYPE, isPlacementType } from '@/lib/components/placement';
import type { InputDefinition } from '@/lib/components/inputs';
import { expandPage, literalPageRoots, type PageExpansion } from '@/lib/components/pageExpansion';
import { extractBreakpoints, type ComponentSnapshotLike } from '@/lib/renderer/server/componentSnapshot';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { getComponentEntry } from '@/lib/componentRegistry';
import type { ApplyOutcome, GenerationUndoRecord } from '@/lib/ai/pageGen/apply';
import { isVoidTag } from '@/lib/drag/voidTags';
import { bareTextRefusal, isTextNodeType } from '@/lib/renderer/textNode';

export type InsertTarget =
  | { kind: 'appTree' }
  // `index` (optional) inserts at a specific position in parent.children.
  // Omitted => append. Out-of-range => clamped.
  | { kind: 'parent'; parentId: string; index?: number }
  // Sibling-relative insertion. Resolves to the sibling's parent + sibling's
  // index (+1 for after). Keeps call sites that only know "put me next to X"
  // from having to look up the parent themselves.
  | { kind: 'sibling'; siblingId: string; position: 'before' | 'after' }
  | { kind: 'floating'; x: number; y: number };

// Walk a component tree to find a node by id.
function findComponentById(
  root: ComponentInstance | undefined,
  id: string,
): ComponentInstance | undefined {
  if (!root) return undefined;
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findComponentById(child as ComponentInstance, id);
    if (found) return found;
  }
  return undefined;
}

// Returns true if `candidateId` equals `node.id` or is the id of any descendant of `node`.
// Used to reject moves that would create a cycle (dropping a parent into its own child).
function isSelfOrDescendant(node: ComponentInstance, candidateId: string): boolean {
  if (node.id === candidateId) return true;
  for (const child of node.children) {
    if (isSelfOrDescendant(child as ComponentInstance, candidateId)) return true;
  }
  return false;
}

// Find a component anywhere on the page: the app tree, any floating element subtree,
// or a top-level canvasNodes entry (viewport / floating). Floating containers must be
// searchable as drop targets for nested-into-floating behaviour.
type PageLike = {
  appComponentTree: ComponentInstance;
  canvasNodes: { values: () => Iterable<ComponentInstance> };
};
function findComponentInPage(page: PageLike, id: string): ComponentInstance | undefined {
  const fromAppTree = findComponentById(page.appComponentTree, id);
  if (fromAppTree) return fromAppTree;
  for (const node of page.canvasNodes.values()) {
    const hit = findComponentById(node, id);
    if (hit) return hit;
  }
  return undefined;
}

/** The project around a page, whichever of its pages or definitions this is. */
function projectOf(page: object): { definitions: ComponentDefinitions } | undefined {
  let node: object = page;
  while (hasParent(node)) {
    node = getParent(node);
    if ('definitions' in node) return node as { definitions: ComponentDefinitions };
  }
  return undefined;
}

/** The id of the definition this page belongs to, when it is one's. */
function owningDefinition(page: object): string | undefined {
  if (!hasParent(page)) return undefined;
  const parent: object = getParent(page);
  return 'page' in parent && parent.page === page ? (parent as unknown as { id: string }).id : undefined;
}

/** The tags from `parent` up to the root, the parent's first. */
function tagsUpFrom(page: PageLike, parent: ComponentInstance): string[] {
  const tags: string[] = [];
  let node: ComponentInstance | undefined = parent;
  while (node) {
    tags.push(node.type);
    node = node.parentId ? findComponentInPage(page, node.parentId) : undefined;
  }
  return tags;
}

/** Why a placement of this definition may not land inside `parent` on this page. */
function placementDropRefusal(page: PageLike, definitionId: string, parent: ComponentInstance): string | undefined {
  const definitions = projectOf(page)?.definitions;
  if (!definitions) return undefined;
  return placementRefusal(definitions, owningDefinition(page), definitionId)
    ?? contentModelRefusal(definitions, definitionId, tagsUpFrom(page, parent))
    ?? undefined;
}

/** Where an insert lands, the app tree when the target is gone. */
function insertPlace(page: PageLike, target: InsertTarget): { parent: ComponentInstance; index?: number } {
  let parent: ComponentInstance | undefined;
  let index: number | undefined;
  if (target.kind === 'appTree') {
    parent = page.appComponentTree;
  } else if (target.kind === 'parent') {
    parent = findComponentInPage(page, target.parentId);
    index = target.index;
  } else if (target.kind === 'sibling') {
    const sibling = findComponentInPage(page, target.siblingId);
    if (sibling?.parentId) {
      parent = findComponentInPage(page, sibling.parentId);
      if (parent) {
        const siblingIdx = parent.children.findIndex((c: ComponentInstance) => c.id === sibling.id);
        index = target.position === 'before' ? siblingIdx : siblingIdx + 1;
      }
    }
  }
  if (parent) return { parent, index };
  console.warn('[PageModel] Insert target parent not found, falling back to appTree');
  return { parent: page.appComponentTree };
}

/** The element `target` would place a node inside; undefined for the canvas or a target that is gone. */
function targetParent(page: PageLike, target: InsertTarget): ComponentInstance | undefined {
  if (target.kind === 'appTree') return page.appComponentTree;
  if (target.kind === 'parent') return findComponentInPage(page, target.parentId);
  if (target.kind === 'sibling') {
    const parentId = findComponentInPage(page, target.siblingId)?.parentId;
    return parentId ? findComponentInPage(page, parentId) : undefined;
  }
  return undefined;
}

/** Why `component` may not go to `target`, in words for the person dragging it. */
function dropRefusalFor(page: PageLike, component: ComponentInstance, target: InsertTarget): string | undefined {
  const isText = isTextNodeType(component.type);
  if (isText && target.kind === 'floating') return 'Text stays inside an element. Drop it next to other content.';
  const parent = targetParent(page, target);
  if (!parent) return undefined;
  if (isTextNodeType(parent.type)) return 'Text cannot hold other elements. Drop this next to it instead.';
  if (isPlacementType(parent.type)) return 'A component holds no children. Edit it, or drop this next to it instead.';
  if (isText) return bareTextRefusal(parent.type);
  for (const definitionId of placedDefinitionIds(getSnapshot(component))) {
    const refusal = placementDropRefusal(page, definitionId, parent);
    if (refusal) return refusal;
  }
  return undefined;
}


// SEO and metadata model
const PageMetadataModel = types.model('PageMetadata', {
  title: types.string,
  description: types.optional(types.string, ''),
  keywords: types.optional(types.array(types.string), []),
  ogTitle: types.optional(types.string, ''),
  ogDescription: types.optional(types.string, ''),
  ogImage: types.optional(types.string, ''),
  canonicalUrl: types.optional(types.string, ''),
  // Keep this page out of search engines: a robots noindex meta tag on the
  // published page, and left out of the site's sitemap.xml.
  noIndex: types.optional(types.boolean, false),
  // Set when the page was created from a legal page template
  // (src/lib/legal/templates.ts): 'impressum', 'privacy' or 'terms'. The
  // editor then shows a "template, not legal advice" banner above it (never
  // published), and the Site settings, the publish warning and the consent
  // banner find the page by it. Empty for every other page.
  legalTemplate: types.optional(types.enumeration('LegalTemplate', ['', 'impressum', 'privacy', 'terms']), ''),
});

// Stage 1 (base) – fields without circular references
const PageBase = types.model('Page', {
  // Identity
  id: types.identifier,
  slug: "",

  // Metadata
  metadata: PageMetadataModel,

  // Timestamps
  createdAt: types.optional(types.Date, () => new Date()),
  updatedAt: types.optional(types.Date, () => new Date()),
});

// Stage 2 – add late-bound / potentially circular fields
// Framer-style unified node architecture
const PageWithComponents = PageBase.props({
  // Single responsive app component tree (deployable)
  appComponentTree: types.late((): IAnyModelType => ComponentModel),
  
  // All canvas nodes - unified collection (Framer-style)
  // Includes viewport nodes, floating elements, etc.
  canvasNodes: types.optional(types.map(ComponentModel), {}),
});


/**
 * The registry entry's default children (a Form arrives with its fields and
 * submit button), created fresh with their own ids, one level deep per entry
 * and recursively for entries that declare their own.
 */
function addRegistryDefaultChildren(parent: ComponentInstance, ids: readonly string[] | undefined, depth = 0): void {
  if (!ids || depth > 4) return;
  for (const childId of ids) {
    const childEntry = getComponentEntry(childId);
    if (!childEntry) continue;
    const child = createIntrinsicComponent(`${childEntry.id}-${uuidv4()}`, childEntry.htmlType, childEntry.defaultProps);
    child.setLabel(childEntry.label);
    addRegistryDefaultChildren(child, childEntry.defaultChildren, depth + 1);
    parent.addChild(child);
  }
}

/** A preset's nodes as one snapshot, each child knowing its parent: a subtree created whole bypasses addChild. */
function presetSnapshot(node: PresetNode, parentId?: string): ComponentSnapshotIn {
  return {
    id: node.id,
    type: node.type as ComponentSnapshotIn['type'],
    componentType: ComponentTypeEnum.HOST,
    props: node.props as PropsRecord,
    ...(node.label ? { label: node.label } : {}),
    ...(parentId ? { parentId } : {}),
    ...(node.children ? { children: node.children.map((child) => presetSnapshot(child, node.id)) } : {}),
  };
}

/**
 * A fresh use of a preset, named after its palette entry. The seed is short because it
 * starts every id the preset writes, and lower case because it starts state ids.
 */
const presetSeed = (entryId: string): string => `${entryId.toLowerCase()}-${uuidv4().slice(0, 8)}`;

/** The page's sticky call to action bar, if it has one (depth first). */
function findStickyCta(node: ComponentInstance): ComponentInstance | undefined {
  if (isStickyCta(node.props)) return node;
  for (const child of node.children as ComponentInstance[]) {
    const found = findStickyCta(child);
    if (found) return found;
  }
  return undefined;
}

const PageModel = PageWithComponents
  .views(self => ({
  /** True for a definition's page, which is never a document of its own. */
  get isDefinitionPage(): boolean {
    return owningDefinition(self) !== undefined;
  },

  /** Why a moved node may not land on `target`, or undefined when it may. */
  dropRefusal(componentId: string, target: InsertTarget): string | undefined {
    const component = findComponentInPage(self, componentId);
    return component ? dropRefusalFor(self, component, target) : undefined;
  },

  /** Why a placement of this definition may not go to `target`, or undefined. */
  placementRefusal(definitionId: string, target: InsertTarget): string | undefined {
    const parent = targetParent(self, target);
    if (parent && (isTextNodeType(parent.type) || isPlacementType(parent.type))) {
      return 'Text and components hold no children. Drop this next to them instead.';
    }
    const page: PageLike = self as unknown as PageLike;
    return placementDropRefusal(page, definitionId, parent ?? page.appComponentTree);
  },
  }))
  .actions(self => ({
  // Update page metadata
  updateMetadata(metadata: Partial<SnapshotIn<typeof PageMetadataModel>>) {
    Object.assign(self.metadata, metadata);
    self.updatedAt = new Date();
  },

  // Set the URL slug. Caller is responsible for the slug rules and collision
  // checks within the project: ProjectModel.setPageSlug and
  // ProjectModel.updatePageSettings wrap this with that guarantee.
  setSlug(slug: string) {
    self.slug = slug;
    self.updatedAt = new Date();
  },
  
  // Set app component tree (deployable responsive app)
  setAppComponentTree(component: ComponentInstance | SnapshotIn<typeof ComponentModel>) {
    // A failed placement at the root would leave the page with no root at all.
    if (String(component.type).startsWith('#')) {
      console.warn('[PageModel] a page or definition root is an element');
      return;
    }
    self.appComponentTree = component;
    self.updatedAt = new Date();
  },
  
  // Unified canvas node management (Framer-style)
  /**
   * Give a page without breakpoint frames the three default ones
   * (src/lib/canvas/defaultViewports.ts). No-op when it has any frame.
   * Returns true when frames were added.
   */
  ensureDefaultViewports(): boolean {
    if (hasViewport(self.canvasNodes.values() as Iterable<{ canvasNodeType?: unknown }>)) return false;
    for (const [id, node] of Object.entries(defaultViewportSnapshots(repairBreakpointIds(self.id)))) {
      self.canvasNodes.set(id, node);
    }
    self.updatedAt = new Date();
    return true;
  },

  addCanvasNode(node: ComponentInstance | ComponentSnapshotIn) {
    self.canvasNodes.set(node.id, node);
    self.updatedAt = new Date();
    return self.canvasNodes.get(node.id)!;
  },
  
  removeCanvasNode(nodeId: string) {
    self.canvasNodes.delete(nodeId);
    self.updatedAt = new Date();
  },
  
  updateCanvasNode(nodeId: string, updates: Partial<ComponentSnapshotIn>) {
    const node = self.canvasNodes.get(nodeId);
    if (node) {
      Object.assign(node, updates);
      self.updatedAt = new Date();
    }
  },

  // Create a new component from the registry and insert it at the requested target.
  // Returns the created component so callers can select it.
  insertRegistryComponent(componentId: string, target: InsertTarget): ComponentInstance | undefined {
    const entry = getComponentEntry(componentId);
    if (!entry) {
      console.warn(`[PageModel] Unknown component id: ${componentId}`);
      return undefined;
    }

    // The sticky call to action is a page-level bar (src/lib/stickyCta): at
    // most one per page, always at the end of the page, wherever it was
    // dropped. A second drop selects the existing bar instead.
    if (isStickyCta(entry.defaultProps)) {
      if (owningDefinition(self)) {
        console.warn('[PageModel] a sticky bar is one per page, so a definition cannot hold it');
        return undefined;
      }
      const appTree = self.appComponentTree as ComponentInstance | undefined;
      if (!appTree) return undefined;
      const existing = findStickyCta(appTree);
      if (existing) return existing;
      const bar = createIntrinsicComponent(`${entry.id}-${uuidv4()}`, entry.htmlType, entry.defaultProps);
      bar.setLabel(entry.label);
      appTree.addChild(bar);
      self.updatedAt = new Date();
      return bar;
    }

    const preset = entry.preset ? presetSnapshot(PRESETS[entry.preset](presetSeed(entry.id))) : undefined;

    if (preset && target.kind === 'floating') {
      const floating = ComponentModel.create({
        ...preset,
        label: entry.label,
        canvasNodeType: CanvasNodeType.FLOATING_ELEMENT,
        canvasX: Math.round(target.x),
        canvasY: Math.round(target.y),
        canvasScale: 1,
      });
      self.canvasNodes.set(floating.id, floating);
      self.updatedAt = new Date();
      return self.canvasNodes.get(floating.id);
    }

    if (target.kind === 'floating') {
      const floating = createFloatingCanvasComponent(
        `${entry.id}-${uuidv4()}`,
        entry.htmlType,
        entry.defaultProps,
        Math.round(target.x),
        Math.round(target.y),
      );
      floating.setLabel(entry.label);
      addRegistryDefaultChildren(floating, entry.defaultChildren);
      self.canvasNodes.set(floating.id, floating);
      self.updatedAt = new Date();
      return self.canvasNodes.get(floating.id);
    }

    const child = preset
      ? ComponentModel.create({ ...preset, label: entry.label })
      : createIntrinsicComponent(`${entry.id}-${uuidv4()}`, entry.htmlType, entry.defaultProps);
    if (!preset) {
      child.setLabel(entry.label);
      addRegistryDefaultChildren(child, entry.defaultChildren);
    }

    const { parent, index } = insertPlace(self, target);
    if (isTextNodeType(parent.type) || isPlacementType(parent.type)) {
      console.warn('[PageModel] Insert target is a text node or a placement, which hold no children');
      return undefined;
    }

    parent.addChild(child, index);
    self.updatedAt = new Date();
    return child;
  },

  // Place a reusable component. The caller, ProjectModel.placeComponent, has the
  // definition and gives the reason for a refusal; this writes the node.
  insertPlacement(definitionId: string, target: InsertTarget): ComponentInstance | undefined {
    const id = `component-${uuidv4()}`;
    if (target.kind === 'floating') {
      const floating = createFloatingCanvasComponent(id, PLACEMENT_TYPE as never, { component: definitionId }, Math.round(target.x), Math.round(target.y));
      self.canvasNodes.set(floating.id, floating);
      self.updatedAt = new Date();
      return self.canvasNodes.get(floating.id);
    }
    const { parent, index } = insertPlace(self, target);
    const placement = createIntrinsicComponent(id, PLACEMENT_TYPE as never, { component: definitionId });
    parent.addChild(placement, index);
    self.updatedAt = new Date();
    return placement;
  },

  // ---------- AI PAGE GENERATION (one action = one history entry) ----------
  //
  // Apply validated, breakpoint-id-keyed snapshots from /api/ai/generate-page.
  // `replace` swaps the target for the generated nodes at the same position
  // (the app-tree root keeps itself and swaps its children instead); `insert`
  // appends them inside the target. Returns the record revertGeneration needs.
  // Fails without mutating anything when the target is gone or unsuitable,
  // so a selection that changed while the model was working can never
  // receive nodes meant for another component.
  applyGeneratedNodes(
    mode: 'replace' | 'insert',
    targetId: string,
    snapshots: ComponentSnapshotIn[],
    generationId: string,
  ): ApplyOutcome<GenerationUndoRecord> {
    if (snapshots.length === 0) return { ok: false, reason: 'Nothing to insert.' };
    const target = findComponentInPage(self, targetId);
    if (!target) {
      return { ok: false, reason: 'The selected component no longer exists on this page.' };
    }
    if (target.isViewportNode) {
      return { ok: false, reason: 'Select a component inside the page, not a breakpoint frame.' };
    }
    const appTree = self.appComponentTree as ComponentInstance;
    const insertedIds = snapshots.map(s => s.id as string);

    const createAll = (parentId: string) =>
      snapshots.map(s => ComponentModel.create({ ...s, parentId }) as ComponentInstance);

    if (mode === 'insert') {
      if (isVoidTag(target.type) || isTextNodeType(target.type) || target.props?.['data-component-kind']) {
        return { ok: false, reason: 'The selected component cannot contain other components.' };
      }
      if (typeof target.props?.children === 'string') {
        return { ok: false, reason: 'The selected component holds text; select a container instead.' };
      }
      createAll(target.id).forEach(child => target.addChild(child));
      self.updatedAt = new Date();
      return { ok: true, value: { kind: 'insert', generationId, pageId: self.id, parentId: target.id, insertedIds } };
    }

    if (target.id === appTree.id) {
      const previousChildren = appTree.children.map(
        (c: ComponentInstance) => getSnapshot(c) as ComponentSnapshotIn,
      );
      appTree.clearChildren();
      createAll(appTree.id).forEach(child => appTree.addChild(child));
      self.updatedAt = new Date();
      return {
        ok: true,
        value: { kind: 'replaceRootChildren', generationId, pageId: self.id, rootId: appTree.id, previousChildren, insertedIds },
      };
    }

    const parent = target.parentId ? findComponentInPage(self, target.parentId) : undefined;
    if (!parent) {
      return { ok: false, reason: 'Only components inside the page can be replaced; select one in a breakpoint frame.' };
    }
    const index = parent.children.findIndex((c: ComponentInstance) => c.id === target.id);
    const previous = getSnapshot(target) as ComponentSnapshotIn;
    parent.removeChild(target.id);
    createAll(parent.id).forEach((child, i) => parent.addChild(child, index + i));
    self.updatedAt = new Date();
    return {
      ok: true,
      value: { kind: 'replace', generationId, pageId: self.id, parentId: parent.id, index, previous, insertedIds },
    };
  },

  // Reverse applyGeneratedNodes. Refuses (and changes nothing) when the
  // generated nodes are no longer where they were put, e.g. after Cmd+Z or a
  // manual move: guessing would destroy the user's later work.
  revertGeneration(record: GenerationUndoRecord): ApplyOutcome<null> {
    if (record.kind === 'newPage') return { ok: false, reason: 'Use the project to remove a generated page.' };
    const parentId = record.kind === 'replaceRootChildren' ? record.rootId : record.parentId;
    const parent = findComponentInPage(self, parentId);
    if (!parent) return { ok: false, reason: 'The generated components were already removed.' };
    const childIds = parent.children.map((c: ComponentInstance) => c.id);
    const missing = record.insertedIds.filter(id => !childIds.includes(id));
    if (missing.length === record.insertedIds.length) {
      return { ok: false, reason: 'This generation was already undone.' };
    }
    if (missing.length > 0) {
      return { ok: false, reason: 'Some generated components were moved or deleted since; undo them by hand or with Cmd+Z.' };
    }
    if (record.kind === 'replaceRootChildren') {
      const others = childIds.filter((id: string) => !record.insertedIds.includes(id));
      if (others.length > 0) {
        return { ok: false, reason: 'Components were added to the page since; undo them first or use Cmd+Z.' };
      }
    }
    const insertAt = record.kind === 'replace'
      ? parent.children.findIndex((c: ComponentInstance) => c.id === record.insertedIds[0])
      : -1;
    for (const id of record.insertedIds) parent.removeChild(id);
    if (record.kind === 'replace') {
      parent.addChild(ComponentModel.create({ ...record.previous, parentId: parent.id }), insertAt);
    } else if (record.kind === 'replaceRootChildren') {
      record.previousChildren.forEach(c => parent.addChild(ComponentModel.create({ ...c, parentId: parent.id })));
    }
    self.updatedAt = new Date();
    return { ok: true, value: null };
  },

  // Delete any component on the page — tree child (removeChild on its parent) or
  // floating / viewport node (removeCanvasNode). Clears editorUI selections so no
  // safeReference is left dangling on a destroyed node. Viewport nodes are skipped:
  // we don't want Backspace to nuke entire breakpoint frames.
  /**
   * Duplicate a node and its whole subtree as one history entry. Every id in
   * the copy is fresh and every child's parentId follows it, and so does
   * behaviour: a reference to a node in the copy takes its new id, a reference
   * to one outside stays. The same goes for an element `id` and what points at
   * it, so a duplicated tab list does not point at the first one's panels. A tree child is inserted right after the original; a
   * floating element is placed 24px down and right of it on the canvas. The page
   * root and breakpoint frames are not duplicable. Returns the copy, or undefined
   * when nothing was duplicated.
   */
  duplicateComponent(componentId: string): ComponentInstance | undefined {
    const component = findComponentInPage(self, componentId);
    if (!component) {
      console.warn(`[PageModel] duplicateComponent: ${componentId} not found`);
      return undefined;
    }
    const appTree = self.appComponentTree as ComponentInstance;
    if (component.id === appTree.id || component.isViewportNode) return undefined;

    const freshIds = new Map<string, string>();
    const renewIds = (snap: ComponentSnapshotIn, parentId: string | undefined): ComponentSnapshotIn => {
      const id = uuidv4();
      freshIds.set(snap.id, id);
      return {
        ...snap,
        id,
        parentId,
        children: (snap.children ?? []).map((c: ComponentSnapshotIn) => renewIds(c, id)),
      };
    };
    // A second pass, because a reference can point at a node later in the walk. An
    // element `id` something in the copy points at moves too: it would repeat otherwise.
    const withFreshIds = (snap: ComponentSnapshotIn, parentId: string | undefined): ComponentSnapshotIn =>
      renewCopyIds(remapBehaviourRefs(renewIds(snap, parentId), freshIds), uuidv4().slice(0, 8));

    if (component.hasParent && component.parentId) {
      const parent = findComponentInPage(self, component.parentId);
      if (!parent) return undefined;
      const index = parent.children.findIndex((c: ComponentInstance) => c.id === component.id);
      const copy = ComponentModel.create(withFreshIds(getSnapshot(component) as ComponentSnapshotIn, parent.id));
      parent.addChild(copy, index + 1);
      self.updatedAt = new Date();
      return copy;
    }

    if (self.canvasNodes.has(component.id)) {
      const snap = withFreshIds(getSnapshot(component) as ComponentSnapshotIn, undefined);
      const copy = ComponentModel.create({
        ...snap,
        canvasX: (component.canvasX ?? 0) + 24,
        canvasY: (component.canvasY ?? 0) + 24,
      });
      self.canvasNodes.set(copy.id, copy);
      self.updatedAt = new Date();
      return self.canvasNodes.get(copy.id);
    }

    console.warn(`[PageModel] duplicateComponent: could not locate owner for ${componentId}`);
    return undefined;
  },

  deleteComponent(componentId: string): boolean {
    const component = findComponentInPage(self, componentId);
    if (!component) {
      console.warn(`[PageModel] deleteComponent: ${componentId} not found`);
      return false;
    }

    // Never destroy the app tree root or a viewport node via this action.
    const appTree = self.appComponentTree as ComponentInstance;
    if (component.id === appTree.id || component.isViewportNode) {
      return false;
    }

    // Clear editor-UI selections pointing at this node before destroying it.
    try {
      const root = getRoot<{ editorUI?: { selectComponent: (c?: ComponentInstance) => void; setSelectedViewportNode: (n?: ComponentInstance) => void; selectedComponent?: ComponentInstance; selectedViewportNode?: ComponentInstance } }>(self);
      const editorUI = root.editorUI;
      if (editorUI) {
        if (editorUI.selectedComponent?.id === component.id) {
          editorUI.selectComponent(undefined);
        }
        if (editorUI.selectedViewportNode?.id === component.id) {
          editorUI.setSelectedViewportNode(undefined);
        }
      }
    } catch {
      // No root / editorUI in this tree — fine, safeReference will null itself.
    }

    // Tree child: tell parent to remove it. Floating / top-level node: remove from map.
    if (component.hasParent && component.parentId) {
      const parent = findComponentInPage(self, component.parentId);
      if (parent) {
        parent.removeChild(component.id);
        parent.collapseTextChild();
        self.updatedAt = new Date();
        return true;
      }
    }

    if (self.canvasNodes.has(component.id)) {
      self.canvasNodes.delete(component.id);
      self.updatedAt = new Date();
      return true;
    }

    console.warn(`[PageModel] deleteComponent: could not locate owner for ${componentId}`);
    return false;
  },

  // Move an existing component (tree child OR floating canvas node) to a new target.
  // Rejects cycles (dropping into self/descendant). Returns the moved component.
  moveTreeComponent(componentId: string, target: InsertTarget): ComponentInstance | undefined {
    const appTree = self.appComponentTree as ComponentInstance;
    // Search everywhere the component might live: the app tree, or nested inside any
    // floating element's subtree, or as a top-level canvasNodes entry (viewport / floating).
    const component: ComponentInstance | undefined = findComponentInPage(self, componentId);
    if (!component) {
      console.warn(`[PageModel] moveTreeComponent: component ${componentId} not found`);
      return undefined;
    }

    // Don't move the tree root or any viewport node
    if (component.id === appTree.id || component.isViewportNode) {
      return undefined;
    }

    // Resolve sibling targets to (parent, index) first — so the cycle check
    // can run against the resolved parent and we can use one shared insert path.
    let resolvedParentId: string | undefined;
    let resolvedIndex: number | undefined;
    if (target.kind === 'sibling') {
      const sibling = findComponentInPage(self, target.siblingId);
      if (!sibling || !sibling.parentId) {
        console.warn('[PageModel] moveTreeComponent: sibling has no parent');
        return undefined;
      }
      const siblingParent = findComponentInPage(self, sibling.parentId);
      if (!siblingParent) return undefined;
      resolvedParentId = siblingParent.id;
      const siblingIdx = siblingParent.children.findIndex((c: ComponentInstance) => c.id === sibling.id);
      resolvedIndex = target.position === 'before' ? siblingIdx : siblingIdx + 1;
    } else if (target.kind === 'parent') {
      resolvedParentId = target.parentId;
      resolvedIndex = target.index;
    }

    // Cycle check: can't drop a node onto itself or one of its descendants.
    if (resolvedParentId && isSelfOrDescendant(component, resolvedParentId)) {
      return undefined;
    }

    // Refused before the detach, or the node would be lost.
    const refusal = dropRefusalFor(self, component, target);
    if (refusal) {
      console.warn(`[PageModel] moveTreeComponent: ${refusal}`);
      return undefined;
    }

    // When moving within the same parent and the component sits before the
    // insert index, the detach will shift everything left by one — adjust.
    if (resolvedParentId && typeof resolvedIndex === 'number' && component.parentId === resolvedParentId) {
      const currentParent = findComponentInPage(self, resolvedParentId);
      if (currentParent) {
        const currentIdx = currentParent.children.findIndex((c: ComponentInstance) => c.id === component.id);
        if (currentIdx !== -1 && currentIdx < resolvedIndex) {
          resolvedIndex -= 1;
        }
      }
    }

    // Once the node has landed, the parent it left may be down to one text node.
    const previousParentId = component.parentId;
    const collapseLeftParent = (newParentId: string | undefined) => {
      if (previousParentId && previousParentId !== newParentId) {
        findComponentInPage(self, previousParentId)?.collapseTextChild();
      }
    };

    // Detach from current location (tree parent, floating subtree parent, or canvasNodes map)
    detach(component);

    if (target.kind === 'floating') {
      component.setCanvasNodeType(CanvasNodeType.FLOATING_ELEMENT);
      component.setCanvasPosition(Math.round(target.x), Math.round(target.y));
      component.clearParent();
      self.canvasNodes.set(component.id, component);
      collapseLeftParent(undefined);
      self.updatedAt = new Date();
      return self.canvasNodes.get(component.id) as ComponentInstance | undefined;
    }

    // Target is a tree parent (appTree root, or a specific container anywhere on the page)
    const newParent = target.kind === 'appTree'
      ? appTree
      : resolvedParentId
        ? findComponentInPage(self, resolvedParentId)
        : undefined;
    if (!newParent) {
      console.warn('[PageModel] moveTreeComponent: target parent not found');
      return undefined;
    }

    // When the component was floating and lands in a tree parent, demote it to a tree
    // component. If the new parent is itself a floating element, the component becomes
    // a nested child of that floating subtree, still categorized as COMPONENT.
    if (component.isFloatingElement) {
      component.setCanvasNodeType(CanvasNodeType.COMPONENT);
    }
    newParent.addChild(component, resolvedIndex);
    collapseLeftParent(newParent.id);
    self.updatedAt = new Date();
    return component;
  },
}))
.views(self => ({

  /** The inputs of the definition this page belongs to, when it is one's. */
  get definitionInputs(): InputDefinition[] | undefined {
    if (!hasParent(self)) return undefined;
    const parent: object = getParent(self);
    return 'page' in parent && parent.page === self ? (parent as unknown as { inputs: InputDefinition[] }).inputs : undefined;
  },

  // Get page URL based on slug
  get url() {
    return `/${self.slug}`;
  },

  // The home page is the page with the empty slug: the published router
  // serves it at the site root, so its slug is never editable.
  get isHome() {
    return self.slug === '';
  },
  
  // Get full page title (with site name if needed)
  getFullTitle(siteName?: string) {
    return siteName ? `${self.metadata.title} | ${siteName}` : self.metadata.title;
  },
  
  // Get OpenGraph data
  get openGraphData() {
    return {
      title: self.metadata.ogTitle || self.metadata.title,
      description: self.metadata.ogDescription || self.metadata.description,
      image: self.metadata.ogImage,
      url: self.metadata.canonicalUrl
    };
  },
  
  // Check if page has app component tree
  get hasAppComponentTree() {
    return !!self.appComponentTree;
  },
  
  // Check if page has canvas nodes
  get hasCanvasNodes(): boolean {
    return self.canvasNodes.size > 0;
  },
  
  // Get all canvas nodes as array
  get canvasNodesArray(): ComponentInstance[] {
    return Array.from(self.canvasNodes.values());
  },
  
  // Get canvas node by ID
  getCanvasNode(nodeId: string): ComponentInstance | undefined {
    return self.canvasNodes.get(nodeId);
  },

  // Any component on the page by id: the app tree, a floating element's
  // subtree, or a top-level canvas node.
  findComponent(componentId: string): ComponentInstance | undefined {
    return findComponentInPage(self, componentId);
  },
  
  // Get viewport nodes (breakpoint viewports)
  get viewportNodes(): ComponentInstance[] {
    return this.canvasNodesArray.filter(node => node.isViewportNode);
  },
  
  // Get floating elements
  get floatingElements(): ComponentInstance[] {
    return this.canvasNodesArray.filter(node => node.isFloatingElement);
  },
  
  // Get visible canvas nodes
  get visibleCanvasNodes(): ComponentInstance[] {
    return this.canvasNodesArray.filter(node => node.canvasVisible);
  },
  
  // Get viewport nodes sorted by minWidth (largest first, like Framer)
  get sortedViewportNodes(): ComponentInstance[] {
    return this.viewportNodes.sort((a, b) => {
      const aMinWidth = a.breakpointMinWidth || 0;
      const bMinWidth = b.breakpointMinWidth || 0;
      return bMinWidth - aMinWidth;
    });
  },
  
  // Get root canvas component by ID (for floating elements)
  getRootCanvasComponent(componentId: string): ComponentInstance | undefined {
    return self.canvasNodes.get(componentId);
  },
  
  // Get exportable page data (only app component tree + breakpoint definitions)
  get exportData() {
    return {
      id: self.id,
      slug: self.slug,
      metadata: self.metadata,
      appComponentTree: self.appComponentTree, // Deployable app tree
      breakpoints: this.viewportNodes.map(viewport => viewport.breakpointInfo), // CSS breakpoint definitions
      createdAt: self.createdAt,
      updatedAt: self.updatedAt
    };
  }
}))
.views(self => {
  const definitions = () => projectOf(self)?.definitions ?? {};
  const breakpoints = () => extractBreakpoints(getSnapshot(self.canvasNodes));
  const stored = (node: unknown) => getSnapshot(node as ComponentInstance) as unknown as ComponentSnapshotLike;
  return {
    // The page as the published path expands it, for the editor surfaces. Computed
    // only for those that read it.
    get expansion(): PageExpansion {
      return expandPage(stored(self.appComponentTree), self.floatingElements.map(stored), definitions(), breakpoints());
    },
    // What the font scan reads on the canvas: the page, floating elements included,
    // with literal input values in place.
    get canvasFontRoots(): ComponentNode[] {
      return literalPageRoots([self.appComponentTree, ...self.floatingElements].map(stored), definitions(), breakpoints());
    },
    // The same for the preview, which shows only the page.
    get pageFontRoots(): ComponentNode[] {
      return literalPageRoots([stored(self.appComponentTree)], definitions(), breakpoints());
    },
  };
});

// TypeScript types
export type PageModelType = Instance<typeof PageModel>;
export type PageSnapshotIn = SnapshotIn<typeof PageModel>;
export type PageSnapshotOut = SnapshotOut<typeof PageModel>;

export default PageModel;
