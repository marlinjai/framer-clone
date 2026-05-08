// src/models/PageModel.ts
import {
  types,
  Instance,
  SnapshotIn,
  SnapshotOut,
  IAnyModelType,
  detach,
  getRoot,
} from 'mobx-state-tree';
import { v4 as uuidv4 } from 'uuid';
import ComponentModel, {
  ComponentInstance,
  ComponentSnapshotIn,
  CanvasNodeType,
  createIntrinsicComponent,
  createFloatingCanvasComponent,
} from './ComponentModel';
import { getComponentEntry } from '@/lib/componentRegistry';

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



// SEO and metadata model
const PageMetadataModel = types.model('PageMetadata', {
  title: types.string,
  description: types.optional(types.string, ''),
  keywords: types.optional(types.array(types.string), []),
  ogTitle: types.optional(types.string, ''),
  ogDescription: types.optional(types.string, ''),
  ogImage: types.optional(types.string, ''),
  canonicalUrl: types.optional(types.string, ''),
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

const PageModel = PageWithComponents
  .actions(self => ({
  // Update page metadata
  updateMetadata(metadata: Partial<SnapshotIn<typeof PageMetadataModel>>) {
    Object.assign(self.metadata, metadata);
    self.updatedAt = new Date();
  },

  // Set the URL slug. Caller is responsible for collision checks within the
  // project — ProjectModel.setPageSlug wraps this with that guarantee.
  setSlug(slug: string) {
    self.slug = slug;
    self.updatedAt = new Date();
  },
  
  // Set app component tree (deployable responsive app)
  setAppComponentTree(component: ComponentInstance | SnapshotIn<typeof ComponentModel>) {
    self.appComponentTree = component;
    self.updatedAt = new Date();
  },
  
  // Unified canvas node management (Framer-style)
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

    if (target.kind === 'floating') {
      const floating = createFloatingCanvasComponent(
        `${entry.id}-${uuidv4()}`,
        entry.htmlType,
        entry.defaultProps,
        Math.round(target.x),
        Math.round(target.y),
      );
      floating.setLabel(entry.label);
      self.canvasNodes.set(floating.id, floating);
      self.updatedAt = new Date();
      return self.canvasNodes.get(floating.id);
    }

    const child = createIntrinsicComponent(
      `${entry.id}-${uuidv4()}`,
      entry.htmlType,
      entry.defaultProps,
    );
    child.setLabel(entry.label);

    let parent: ComponentInstance | undefined;
    let insertIndex: number | undefined;
    if (target.kind === 'appTree') {
      parent = self.appComponentTree as ComponentInstance;
    } else if (target.kind === 'parent') {
      parent = findComponentInPage(self, target.parentId);
      insertIndex = target.index;
    } else if (target.kind === 'sibling') {
      const sibling = findComponentInPage(self, target.siblingId);
      if (sibling?.parentId) {
        parent = findComponentInPage(self, sibling.parentId);
        if (parent) {
          const siblingIdx = parent.children.findIndex((c: ComponentInstance) => c.id === sibling.id);
          insertIndex = target.position === 'before' ? siblingIdx : siblingIdx + 1;
        }
      }
    }

    if (!parent) {
      console.warn('[PageModel] Insert target parent not found, falling back to appTree');
      parent = self.appComponentTree as ComponentInstance;
    }

    parent.addChild(child, insertIndex);
    self.updatedAt = new Date();
    return child;
  },

  // Delete any component on the page — tree child (removeChild on its parent) or
  // floating / viewport node (removeCanvasNode). Clears editorUI selections so no
  // safeReference is left dangling on a destroyed node. Viewport nodes are skipped:
  // we don't want Backspace to nuke entire breakpoint frames.
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
    let component: ComponentInstance | undefined = findComponentInPage(self, componentId);
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

    // Detach from current location (tree parent, floating subtree parent, or canvasNodes map)
    detach(component);

    if (target.kind === 'floating') {
      component.setCanvasNodeType(CanvasNodeType.FLOATING_ELEMENT);
      component.setCanvasPosition(Math.round(target.x), Math.round(target.y));
      component.clearParent();
      self.canvasNodes.set(component.id, component);
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
    self.updatedAt = new Date();
    return component;
  },
}))
.views(self => ({

  // Get page URL based on slug
  get url() {
    return `/${self.slug}`;
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
}));

// TypeScript types
export type PageModelType = Instance<typeof PageModel>;
export type PageSnapshotIn = SnapshotIn<typeof PageModel>;
export type PageSnapshotOut = SnapshotOut<typeof PageModel>;

export default PageModel;
