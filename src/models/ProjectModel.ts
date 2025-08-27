// src/models/ProjectModel.ts
// Domain model for projects - contains multiple pages and project-level settings
import { types, Instance, SnapshotIn, SnapshotOut } from 'mobx-state-tree';
import PageModel, { PageModelType } from './PageModel';

// Project metadata model
const ProjectMetadataModel = types.model('ProjectMetadata', {
  title: types.string,
  description: '',
  
  // Timestamps
  createdAt: types.optional(types.Date, () => new Date()),
  updatedAt: types.optional(types.Date, () => new Date()),
});



// Main ProjectModel - Framer-style unified architecture
export const ProjectModel = types
  .model('Project', {
    // Identity
    id: types.identifier,
    
    // Project metadata
    metadata: ProjectMetadataModel,

    // Pages collection - all pages in this project
    // Each page manages its own viewport nodes (Framer-style)
    pages: types.map(PageModel),

  })
  .actions(self => ({

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
    
    // Get project statistics (Framer-style)
    get stats() {
      return {
        pageCount: self.pages.size,
        totalViewportNodes: this.pagesArray.reduce((total, page) => {
          return total + page.viewportNodes.length;
        }, 0),
        totalFloatingElements: this.pagesArray.reduce((total, page) => {
          return total + page.floatingElements.length;
        }, 0),
        totalCanvasNodes: this.pagesArray.reduce((total, page) => {
          return total + page.canvasNodesArray.length;
        }, 0)
      };
    },

    // Get all unique breakpoint labels across all pages (for suggestions)
    get allBreakpointLabels(): string[] {
      const labels = new Set<string>();
      this.pagesArray.forEach(page => {
        page.viewportNodes.forEach(viewport => {
          if (viewport.breakpointLabel) {
            labels.add(viewport.breakpointLabel);
          }
        });
      });
      return Array.from(labels).sort();
    },

    // Get all unique breakpoint minWidths across all pages
    get allBreakpointWidths(): number[] {
      const widths = new Set<number>();
      this.pagesArray.forEach(page => {
        page.viewportNodes.forEach(viewport => {
          if (viewport.breakpointMinWidth) {
            widths.add(viewport.breakpointMinWidth);
          }
        });
      });
      return Array.from(widths).sort((a, b) => a - b);
    },
  }));

// TypeScript types
export type ProjectModelType = Instance<typeof ProjectModel>;
export type ProjectSnapshotIn = SnapshotIn<typeof ProjectModel>;
export type ProjectSnapshotOut = SnapshotOut<typeof ProjectModel>;

export default ProjectModel;
