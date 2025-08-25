// src/models/PageModel.ts
import { types, Instance, SnapshotIn, SnapshotOut, IAnyModelType } from 'mobx-state-tree';
import ComponentModel, { ComponentInstance } from './ComponentModel';



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
  
  // Get serializable page data
  get exportData() {
    return {
      id: self.id,
      slug: self.slug,
      metadata: self.metadata,
      rootComponent: self.rootComponent,
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
