// src/models/ProjectModel.ts
// Domain model for projects - contains multiple pages and project-level settings
import { types, Instance, SnapshotIn, SnapshotOut, IAnyModelType } from 'mobx-state-tree';
import PageModel, { PageModelType } from './PageModel';

// Project metadata model
const ProjectMetadataModel = types.model('ProjectMetadata', {
  title: types.string,
  description: types.optional(types.string, ''),
  
  // Project settings
  defaultBreakpoints: types.optional(types.boolean, true),
  
  // Timestamps
  createdAt: types.optional(types.Date, () => new Date()),
  updatedAt: types.optional(types.Date, () => new Date()),
});



// Main ProjectModel - domain logic only
const ProjectModel: IAnyModelType = types.model('Project', {
  // Identity
  id: types.identifier,
  
  // Project metadata
  metadata: ProjectMetadataModel,
  
  // Pages collection - all pages in this project
  pages: types.map(PageModel),
  
  // Settings and configuration
  settings: types.optional(types.frozen(), {}),
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
  
  // Update project settings
  updateSettings(settings: Record<string, any>) {
    self.settings = { ...self.settings, ...settings };
    self.metadata.updatedAt = new Date();
  },
  
  // Clone project with new ID
  clone(newId: string): ProjectModelType {
    return ProjectModel.create({
      id: newId,
      metadata: { 
        ...self.metadata,
        title: `${self.metadata.title} (Copy)`,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      pages: Array.from(self.pages.entries()).reduce((acc, [pageId, page]) => {
        const newPageId = `${newId}-${pageId}`;
        acc[newPageId] = page.clone(newPageId, `${page.slug}-copy`);
        return acc;
      }, {} as Record<string, PageModelType>),
      settings: { ...self.settings }
    });
  }
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
  
  // Get pages sorted by creation date
  get pagesSorted(): PageModelType[] {
    return this.pagesArray.sort((a, b) => 
      a.createdAt.getTime() - b.createdAt.getTime()
    );
  },
  
  // Check if project has pages
  get hasPages(): boolean {
    return self.pages.size > 0;
  },
  
  // Get first page (useful for default selection)
  get firstPage(): PageModelType | undefined {
    return this.pagesSorted[0];
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
  
  // Get exportable project data
  get exportData() {
    return {
      id: self.id,
      metadata: self.metadata,
      pages: this.pagesArray.map(page => page.exportData),
      settings: self.settings
    };
  }
}));

// Helper function to create a new project with default settings
export const createProject = (
  id: string,
  title: string,
  description = ''
): ProjectModelType => {
  return ProjectModel.create({
    id,
    metadata: {
      title,
      description
    }
  });
};

// TypeScript types
export type ProjectModelType = Instance<typeof ProjectModel>;
export type ProjectSnapshotIn = SnapshotIn<typeof ProjectModel>;
export type ProjectSnapshotOut = SnapshotOut<typeof ProjectModel>;

export default ProjectModel;
