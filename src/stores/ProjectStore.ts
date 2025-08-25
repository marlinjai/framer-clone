// src/stores/ProjectStore.ts  
// Domain store for managing projects collection
import { types, Instance } from 'mobx-state-tree';
import ProjectModel, { ProjectModelType } from '../models/ProjectModel';
import { v4 as uuidv4 } from 'uuid';
import { createIntrinsicComponent } from '@/models/ComponentModel';

// ProjectStore - manages the collection of all projects (domain logic)
const ProjectStore = types.model('ProjectStore', {
  // All projects in the application
  projects: types.map(ProjectModel),
})
.views(self => ({
  // Get all projects as array
  get allProjects(): ProjectModelType[] {
    return Array.from(self.projects.values());
  },
  
  // Get projects sorted by creation date (newest first)
  get projectsSorted(): ProjectModelType[] {
    return this.allProjects.sort((a, b) => 
      b.metadata.createdAt.getTime() - a.metadata.createdAt.getTime()
    );
  },
  
  // Get project by ID
  getProject(id: string): ProjectModelType | undefined {
    return self.projects.get(id);
  },
  
  // Find project by title
  findProjectByTitle(title: string): ProjectModelType | undefined {
    return this.allProjects.find(project => 
      project.metadata.title.toLowerCase() === title.toLowerCase()
    );
  },
  
  // Check if any projects exist
  get hasProjects(): boolean {
    return self.projects.size > 0;
  },
  
  // Get most recently created project
  get latestProject(): ProjectModelType | undefined {
    return this.projectsSorted[0];
  },
  
  // Get project statistics
  get stats() {
    const projects = this.allProjects;
    return {
      totalProjects: projects.length,
      totalPages: projects.reduce((sum, p) => sum + p.stats.pageCount, 0),
      totalComponents: projects.reduce((sum, p) => sum + p.stats.totalComponents, 0)
    };
  }
}))
.actions(self => ({

  // Create a new project with default page
  createProject(title: string, description = '') {
    const projectId = uuidv4();
    const primaryBreakpointId = uuidv4();
    const pageId = uuidv4();
    const rootComponentId = uuidv4();

    // Root component (responsive style maps keyed by primary breakpoint id)
    const rootComponent = createIntrinsicComponent('root-' + rootComponentId, 'div', {
      style: {
        width: { [primaryBreakpointId]: '1280px' },
        height: { [primaryBreakpointId]: '1000px' },
        backgroundColor: { [primaryBreakpointId]: '#000' },
      },
    });

    self.projects.set(projectId, {
      id: projectId,
      metadata: {
        title,
        description,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      pages: {
        [pageId]: {
          id: pageId,
            slug: '',
            metadata: {
              title: 'Home',
              description: 'Default home page'
            },
            createdAt: new Date(),
            updatedAt: new Date(),
            rootComponent, // <-- direct component snapshot (correct shape)
        }
      },
      breakpoints: {
        [primaryBreakpointId]: {
          id: primaryBreakpointId,
          label: 'Default',
          minWidth: 1280,
        },
      },
      primaryBreakpoint: primaryBreakpointId, // reference to existing breakpoint
    });
  },
  
  // Remove a project
  removeProject(projectId: string) {
    self.projects.delete(projectId);
  },
}))

// TypeScript types
export type ProjectStoreType = Instance<typeof ProjectStore>;

export default ProjectStore;
