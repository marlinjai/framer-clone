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
// Explicit annotation to help TS not collapse inference during staged extension
const PageWithRoot = PageBase.props({
  rootComponent: types.late((): IAnyModelType => ComponentModel),
  
  // Root canvas components - components positioned absolutely on canvas (like Framer)
  // These are components that have no parent and live directly on the canvas
  rootCanvasComponents: types.optional(types.map(ComponentModel), {}),
});

const PageModel = PageWithRoot
  .actions(self => ({
  // Update page metadata
  updateMetadata(metadata: Partial<SnapshotIn<typeof PageMetadataModel>>) {
    Object.assign(self.metadata, metadata);
    self.updatedAt = new Date();
  },
  
  // Set root component
  setRootComponent(component: ComponentInstance | SnapshotIn<typeof ComponentModel>) {
    self.rootComponent = component;
    self.updatedAt = new Date();
  },
  
  // Root canvas component management (Framer-style)
  addRootCanvasComponent(component: ComponentInstance | ComponentSnapshotIn) {
    self.rootCanvasComponents.set(component.id, component);
    self.updatedAt = new Date();
  },
  
  removeRootCanvasComponent(componentId: string) {
    self.rootCanvasComponents.delete(componentId);
    self.updatedAt = new Date();
  },
  
  updateRootCanvasComponent(componentId: string, updates: Partial<ComponentSnapshotIn>) {
    const component = self.rootCanvasComponents.get(componentId);
    if (component) {
      Object.assign(component, updates);
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
  
  // Check if page has components
  get hasComponents() {
    return !!self.rootComponent;
  },
  
  // Check if page has root canvas components
  get hasRootCanvasComponents(): boolean {
    return self.rootCanvasComponents.size > 0;
  },
  
  // Get all root canvas components as array
  get rootCanvasComponentsArray(): ComponentInstance[] {
    return Array.from(self.rootCanvasComponents.values());
  },
  
  // Get root canvas component by ID
  getRootCanvasComponent(componentId: string): ComponentInstance | undefined {
    return self.rootCanvasComponents.get(componentId);
  },
  
  // Get root canvas components by type
  getRootCanvasComponentsByType(type: string): ComponentInstance[] {
    return this.rootCanvasComponentsArray.filter(component => component.type === type);
  },
  
  // Get visible root canvas components
  get visibleRootCanvasComponents(): ComponentInstance[] {
    return this.rootCanvasComponentsArray.filter(component => component.canvasVisible);
  },
  
  // Get root canvas components that are positioned (have canvas coordinates)
  get positionedRootCanvasComponents(): ComponentInstance[] {
    return this.rootCanvasComponentsArray.filter(component => component.isRootCanvasComponent);
  },
  
  // Get serializable page data
  get exportData() {
    return {
      id: self.id,
      slug: self.slug,
      metadata: self.metadata,
      rootComponent: self.rootComponent,
      rootCanvasComponents: self.rootCanvasComponents,
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
