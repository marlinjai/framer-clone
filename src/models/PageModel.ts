// src/models/PageModel.ts
import { types, Instance, SnapshotIn, SnapshotOut, IAnyModelType } from 'mobx-state-tree';
import ComponentModel, { ComponentInstance } from './ComponentModel';

// Breakpoint configuration for responsive design
const BreakpointModel = types.model('Breakpoint', {
  // Breakpoints are defined by their minimum width (this is the only required value)
  minWidth: types.number,
  
  // Optional label for display purposes
  label: types.string,
  
  // Device type for context (mobile, tablet, desktop)
  deviceType: types.optional(types.enumeration(['mobile', 'tablet', 'desktop']), 'desktop'),
});

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

// Pre-declare the interface to avoid circular reference issues
interface IPageModel extends Instance<typeof PageModel> {}

// Main PageModel
const PageModel: IAnyModelType = types.model('Page', {
  // Identity
  id: types.identifier,
  slug: types.string,
  
  // Metadata
  metadata: PageMetadataModel,
  
  
  // Responsive breakpoints for canvas preview
  breakpoints: types.map(BreakpointModel),
  
  // Root component tree (single tree with responsive styles)
  rootComponent: types.maybe(types.late(() => ComponentModel)),
  
  // Page-level settings
  settings: types.optional(types.frozen(), {}),
  
  // Timestamps
  createdAt: types.optional(types.Date, () => new Date()),
  updatedAt: types.optional(types.Date, () => new Date()),
})
.actions(self => ({
  // Update page metadata
  updateMetadata(metadata: Partial<SnapshotIn<typeof PageMetadataModel>>) {
    Object.assign(self.metadata, metadata);
    self.updatedAt = new Date();
  },
  
  // Set root component
  setRootComponent(component: ComponentInstance) {
    self.rootComponent = component;
    self.updatedAt = new Date();
  },
  
  // Add or update breakpoint
  addBreakpoint(name: string, breakpoint: SnapshotIn<typeof BreakpointModel>) {
    self.breakpoints.set(name, breakpoint);
    self.updatedAt = new Date();
  },
  
  // Update breakpoint (Framer style: just minWidth and optionally label)
  updateBreakpoint(name: string, minWidth: number, label?: string) {
    const currentBreakpoint = self.breakpoints.get(name);
    if (!currentBreakpoint) return;
    
    self.breakpoints.set(name, {
      ...currentBreakpoint,
      minWidth,
      ...(label && { label })
    });
    
    self.updatedAt = new Date();
  },
  
  // Update breakpoint with Framer-like cascading behavior
  // When you change a breakpoint width, the next breakpoint adjusts to start from that width
  updateBreakpointWidth(name: string, newWidth: number) {
    const currentBreakpoint = self.breakpoints.get(name);
    if (!currentBreakpoint) return;
    
    // Get current breakpoints sorted by minWidth to understand the order
    const sortedBreakpoints = Array.from(self.breakpoints.entries())
      .map(([bpName, bp]) => ({ name: bpName, ...bp }))
      .sort((a, b) => a.minWidth - b.minWidth);
      
    const currentIndex = sortedBreakpoints.findIndex(bp => bp.name === name);
    
    if (currentIndex === -1) return;
    
    // Update the current breakpoint
    self.breakpoints.set(name, {
      ...currentBreakpoint,
      minWidth: newWidth
    });
    
    // Update all subsequent breakpoints to start at the new width if they would overlap
    for (let i = currentIndex + 1; i < sortedBreakpoints.length; i++) {
      const nextBreakpoint = sortedBreakpoints[i];
      
      // If the next breakpoint starts before or at our new width, move it to our new width
      if (nextBreakpoint.minWidth <= newWidth) {
        const nextBp = self.breakpoints.get(nextBreakpoint.name);
        if (nextBp) {
          self.breakpoints.set(nextBreakpoint.name, {
            ...nextBp,
            minWidth: newWidth
          });
        }
      } else {
        // Stop cascading once we find a breakpoint that doesn't need updating
        break;
      }
    }
    
    self.updatedAt = new Date();
  },
  
  // Remove breakpoint
  removeBreakpoint(name: string) {
    self.breakpoints.delete(name);
    self.updatedAt = new Date();
  },
  

  
  // Update page settings
  updateSettings(settings: Record<string, any>) {
    self.settings = { ...self.settings, ...settings };
    self.updatedAt = new Date();
  },
  
  // Clone page with new ID and slug
  clone(newId: string, newSlug: string): IPageModel {
    return PageModel.create({
      id: newId,
      slug: newSlug,
      metadata: { ...self.metadata },
      breakpoints: Array.from(self.breakpoints.entries()).reduce((acc, [key, value]) => {
        acc[key] = { ...value };
        return acc;
      }, {} as any),
      rootComponent: self.rootComponent?.clone(`${newId}-root`),
      settings: { ...self.settings }
    });
  }
}))
.views(self => ({
  // Get breakpoint by name
  getBreakpoint(name: string) {
    return self.breakpoints.get(name);
  },
  
  // Get all breakpoints as array, sorted by minWidth
  get breakpointsArray() {
    return Array.from(self.breakpoints.entries())
      .map(([name, breakpoint]) => ({
        name,
        ...breakpoint
      }))
      .sort((a, b) => a.minWidth - b.minWidth);
  },
  
  // Get the active breakpoint for a given viewport width
  getActiveBreakpoint(viewportWidth: number) {
    const sortedBreakpoints = this.breakpointsArray;
    
    // Find the largest breakpoint that's still smaller than or equal to viewport width
    for (let i = sortedBreakpoints.length - 1; i >= 0; i--) {
      if (viewportWidth >= sortedBreakpoints[i].minWidth) {
        return sortedBreakpoints[i];
      }
    }
    
    // Fallback to first breakpoint (mobile)
    return sortedBreakpoints[0];
  },
  
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
      breakpoints: this.breakpointsArray,
      rootComponent: self.rootComponent,
      settings: self.settings,
      createdAt: self.createdAt,
      updatedAt: self.updatedAt
    };
  }
}));

// Default breakpoints (Framer-style: only minWidth and label matter)
export const DEFAULT_BREAKPOINTS = {
  mobile: {
    minWidth: 375,
    label: 'Mobile',
    deviceType: 'mobile'
  },
  tablet: {
    minWidth: 768,
    label: 'Tablet', 
    deviceType: 'tablet'
  },
  desktop: {
    minWidth: 1280,
    label: 'Desktop',
    deviceType: 'desktop'
  }
};

// Helper function to create a new page with default settings
export const createPage = (
  id: string,
  slug: string,
  title: string,
  description = ''
): Instance<typeof PageModel> => {
  return PageModel.create({
    id,
    slug,
    metadata: {
      title,
      description,
      ogTitle: title,
      ogDescription: description
    },
    breakpoints: DEFAULT_BREAKPOINTS
  });
};

// TypeScript types
export type PageInstance = IPageModel;
export type PageSnapshotIn = SnapshotIn<typeof PageModel>;
export type PageSnapshotOut = SnapshotOut<typeof PageModel>;
export type BreakpointInstance = Instance<typeof BreakpointModel>;

export default PageModel;
