// src/stores/ProjectStore.ts  
// Domain store for managing projects collection
import { types, Instance } from 'mobx-state-tree';
import ProjectModel, { ProjectModelType } from '../models/ProjectModel';
import { v4 as uuidv4 } from 'uuid';
import { createIntrinsicComponent, createRootCanvasComponent } from '@/models/ComponentModel';
import { createBreakpointViewportComponent } from '@/utils/canvasHelpers';

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
    const desktopBreakpointId = uuidv4();
    const tabletBreakpointId = uuidv4();
    const mobileBreakpointId = uuidv4();
    const pageId = uuidv4();
    const rootComponentId = uuidv4();

    // Root component (responsive style maps keyed by primary breakpoint id)
    const rootComponent = createIntrinsicComponent('root-' + rootComponentId, 'div', {
      style: {
        position: { [desktopBreakpointId]: '' },
        width: { [desktopBreakpointId]: '1280px', [tabletBreakpointId]: '768px', [mobileBreakpointId]: '320px' },
        height: { [desktopBreakpointId]: '1000px' },
        backgroundColor: { [desktopBreakpointId]: '#4A90E2' },
      },
    });

    // Create sample root canvas components for demonstration
    const sampleImageComponent = createRootCanvasComponent(
      uuidv4(),
      'img',
      {
        src: 'https://picsum.photos/400/300',
        alt: 'Sample image',
        width: '400px',
        height: '300px',
        style: {
          objectFit: 'cover',
          borderRadius: '8px',
        }
      },
      1600,
      200
    );

    const sampleTextComponent = createRootCanvasComponent(
      uuidv4(),
      'div',
      {
        children: 'Welcome to Framer Clone!\nDrag elements around the canvas.',
        style: {
          width: '300px',
          height: '100px',
          fontSize: '16px',
          fontFamily: 'Inter, sans-serif',
          color: '#000000',
          padding: '8px',
          boxSizing: 'border-box',
          whiteSpace: 'pre-wrap',
          userSelect: 'none',
          border: '2px solid blue',
          backgroundColor: 'rgba(255, 255, 255, 0.9)',
        }
      },
      1700,
      550
    );

    // Create root canvas components for breakpoint viewports (positioned on canvas)
    const desktopViewportComponent = createBreakpointViewportComponent(
      `viewport-${desktopBreakpointId}`,
      desktopBreakpointId,
      100, // X position
      100, // Y position
      1280 // Width
    );

    const tabletViewportComponent = createBreakpointViewportComponent(
      `viewport-${tabletBreakpointId}`,
      tabletBreakpointId,
      1430, // X position (100 + 1280 + 50 spacing)
      100,  // Y position
      768   // Width
    );

    const mobileViewportComponent = createBreakpointViewportComponent(
      `viewport-${mobileBreakpointId}`,
      mobileBreakpointId,
      2248, // X position (100 + 1280 + 50 + 768 + 50)
      100,  // Y position
      320   // Width
    );

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
            rootCanvasComponents: {
              [sampleImageComponent.id]: sampleImageComponent,
              [sampleTextComponent.id]: sampleTextComponent,
              [desktopViewportComponent.id]: desktopViewportComponent,
              [tabletViewportComponent.id]: tabletViewportComponent,
              [mobileViewportComponent.id]: mobileViewportComponent,
            },
        }
      },
      breakpoints: {
        [desktopBreakpointId]: {
          id: desktopBreakpointId,
          label: 'Desktop',
          minWidth: 1280,
        },
        [tabletBreakpointId]: {
          id: tabletBreakpointId,
          label: 'Tablet',
          minWidth: 768,
        },
        [mobileBreakpointId]: {
          id: mobileBreakpointId,
          label: 'Mobile',
          minWidth: 320,
        },
      },
      primaryBreakpoint: desktopBreakpointId, // reference to existing breakpoint
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
