// src/models/PageModel.ts
import { types, Instance, SnapshotIn, SnapshotOut, IAnyModelType } from 'mobx-state-tree';
import ComponentModel, { ComponentInstance, ComponentSnapshotIn } from './ComponentModel';



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
