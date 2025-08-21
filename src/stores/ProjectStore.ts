// src/stores/ProjectStore.ts  
// Domain store for managing projects collection
import { types, Instance, flow, getRoot } from 'mobx-state-tree';
import ProjectModel, { ProjectInstance, createProject } from '../models/ProjectModel';
import { createPage } from '../models/PageModel';

// ProjectStore - manages the collection of all projects (domain logic)
const ProjectStore = types.model('ProjectStore', {
  // All projects in the application
  projects: types.map(ProjectModel),
})
.views(self => ({
  // Get all projects as array
  get allProjects(): ProjectInstance[] {
    return Array.from(self.projects.values());
  },
  
  // Get projects sorted by creation date (newest first)
  get projectsSorted(): ProjectInstance[] {
    return this.allProjects.sort((a, b) => 
      b.metadata.createdAt.getTime() - a.metadata.createdAt.getTime()
    );
  },
  
  // Get project by ID
  getProject(id: string): ProjectInstance | undefined {
    return self.projects.get(id);
  },
  
  // Find project by title
  findProjectByTitle(title: string): ProjectInstance | undefined {
    return this.allProjects.find(project => 
      project.metadata.title.toLowerCase() === title.toLowerCase()
    );
  },
  
  // Check if any projects exist
  get hasProjects(): boolean {
    return self.projects.size > 0;
  },
  
  // Get most recently created project
  get latestProject(): ProjectInstance | undefined {
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
  // Add a project
  addProject(project: ProjectInstance | Parameters<typeof createProject>) {
    if (Array.isArray(project)) {
      // Create from parameters
      const [id, title, description] = project;
      const newProject = createProject(id, title, description);
      self.projects.set(id, newProject);
      return newProject;
    } else {
      // Add existing project instance
      self.projects.set(project.id, project);
      return project;
    }
  },
  
  // Create a new project with default page
  createProject(id: string, title: string, description = ''): ProjectInstance {
    const project = createProject(id, title, description);
    
    // Add a default "Home" page
    const homePage = createPage(`${id}-home`, 'home', 'Home', 'Default home page');
    project.addPage(homePage);
    
    self.projects.set(id, project);
    return project;
  },
  
  // Remove a project
  removeProject(projectId: string) {
    self.projects.delete(projectId);
  },
  
  // Clone a project
  cloneProject(projectId: string, newTitle?: string): ProjectInstance | undefined {
    const originalProject = self.projects.get(projectId);
    if (!originalProject) return undefined;
    
    const newId = `${projectId}-copy-${Date.now()}`;
    const clonedProject = originalProject.clone(newId);
    
    if (newTitle) {
      clonedProject.updateMetadata({ title: newTitle });
    }
    
    self.projects.set(newId, clonedProject);
    return clonedProject;
  },
}))

// TypeScript types
export type ProjectStoreInstance = Instance<typeof ProjectStore>;

export default ProjectStore;
