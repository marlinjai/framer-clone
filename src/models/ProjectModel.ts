// src/models/ProjectModel.ts
// Domain model for projects - contains multiple pages and project-level settings
import { types, Instance, SnapshotIn, getSnapshot, applySnapshot, SnapshotOut } from 'mobx-state-tree';
import PageModel, { PageModelType } from './PageModel';
import { BreakpointModel, BreakpointSnapshotIn, BreakpointType } from './BreakpointModel';
import { v4 as uuidv4 } from 'uuid';

// Project metadata model
const ProjectMetadataModel = types.model('ProjectMetadata', {
  title: types.string,
  description: '',
  
  // Timestamps
  createdAt: types.optional(types.Date, () => new Date()),
  updatedAt: types.optional(types.Date, () => new Date()),
});



// Main ProjectModel - domain logic only
export const ProjectModel = types
  .model('Project', {
    // Identity
    id: types.identifier,
    
    // Project metadata
    metadata: ProjectMetadataModel,

    // All breakpoints
    breakpoints: types.map(BreakpointModel),

    // Required reference (must exist in breakpoints snapshot at creation)
    primaryBreakpoint: types.reference(BreakpointModel),

    // Pages collection - all pages in this project
    pages: types.map(PageModel),

  })
  .actions(self => ({

    // Internal initializer (only use during creation if hydrating)
    _setPrimary(id: string) {
      // Only allow if currently consistent
      if (!self.breakpoints.has(id)) throw new Error('Primary breakpoint id not found in map');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (self as any).primaryBreakpoint = id; // MST assignment
    },
    // Add a new secondary breakpoint (UUID auto)
    addBreakpoint(label: string, minWidth: number): BreakpointType {
      const breakpointId = uuidv4();

      self.breakpoints.set(breakpointId, {
        id: breakpointId,
        label,
        minWidth,
      });
      self.metadata = { ...self.metadata, updatedAt: new Date() };
      return self.breakpoints.get(breakpointId)!;
    },
    // Remove a breakpoint from the project
    removeBreakpoint(breakpointId: string) {
      if (breakpointId === self.primaryBreakpoint.id) {
        throw new Error('Cannot remove the primary breakpoint');
      }
      self.breakpoints.delete(breakpointId);
      self.metadata.updatedAt = new Date();
    },

    // Update an existing breakpoint
    updateBreakpoint(breakpointId: string, updates: Partial<BreakpointSnapshotIn>) {
      const breakpoint = self.breakpoints.get(breakpointId);
      if (breakpoint) {
        applySnapshot(breakpoint, { ...getSnapshot(breakpoint), ...updates });
        self.metadata.updatedAt = new Date();
      }
    },

    // Add a new page to the project
    addPage(page: SnapshotIn<typeof PageModel>) {
      self.pages.set(page.id, page);
      self.metadata.updatedAt = new Date();
    },
    
    // Remove a page from the project
    removePage(pageId: string) {
      self.pages.delete(pageId);
      self.metadata.updatedAt = new Date();
    },
    
    // Update project metadata
    updateMetadata(metadata: Partial<SnapshotIn<typeof ProjectMetadataModel>>) {
      Object.assign(self.metadata, metadata);
      self.metadata.updatedAt = new Date();
    },
  }))
  .views(self => ({
    // Get page by ID
    getPage(pageId: string): PageModelType | undefined {
      return self.pages.get(pageId);
    },
    
    // Get all pages as array
    get pagesArray(): PageModelType[] {
      return Array.from(self.pages.values());
    },
    
    // Check if project has pages
    get hasPages(): boolean {
      return self.pages.size > 0;
    },
    
    // Find page by slug
    findPageBySlug(slug: string): PageModelType | undefined {
      return this.pagesArray.find(page => page.slug === slug);
    },
    
    // Get project statistics
    get stats() {
      return {
        pageCount: self.pages.size,
        totalComponents: this.pagesArray.reduce((total, page) => {
          return total + (page.rootComponent?.allDescendants.length || 0);
        }, 0)
      };
    },

    get orderedBreakpoints(): BreakpointType[] {
      return Array.from(self.breakpoints.values()).sort((a,b)=>a.minWidth-b.minWidth);
    },
  }));

// TypeScript types
export type ProjectModelType = Instance<typeof ProjectModel>;
export type ProjectSnapshotIn = SnapshotIn<typeof ProjectModel>;
export type ProjectSnapshotOut = SnapshotOut<typeof ProjectModel>;

export default ProjectModel;
