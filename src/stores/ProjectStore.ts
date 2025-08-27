// src/stores/ProjectStore.ts  
// Domain store for managing projects collection
import { types, Instance } from 'mobx-state-tree';
import ProjectModel, { ProjectModelType } from '../models/ProjectModel';
import { v4 as uuidv4 } from 'uuid';
import { createIntrinsicComponent, createFloatingCanvasComponent, createViewportNode } from '@/models/ComponentModel';

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
      totalCanvasNodes: projects.reduce((sum, p) => sum + p.stats.totalCanvasNodes, 0)
    };
  }
}))
.actions(self => ({

  // Create a new project with default page (Framer-style unified architecture)
  createProject(title: string, description = '') {
    const projectId = uuidv4();
    const desktopBreakpointId = uuidv4();
    const tabletBreakpointId = uuidv4();
    const mobileBreakpointId = uuidv4();
    const pageId = uuidv4();
    // Removed rootComponentId - no longer needed with direct component structure

    // Create the app component tree (Framer-style: direct components, no wrapper)
    // In Framer, the app tree is a collection of root-level components
    const appComponentTree = createIntrinsicComponent('header-' + uuidv4(), 'header', {
      style: {
        color: 'white',
        padding: '16px',
        borderRadius: '8px',
        marginBottom: '20px',
        fontFamily: 'Inter, sans-serif'
      },
      children: 'Welcome to Framer Clone!'
    });

    // Add a main component as a sibling (this would be handled differently in a real app)
    const mainComponent = createIntrinsicComponent('main-' + uuidv4(), 'main', {
      style: {
        padding: '20px',
        backgroundColor: 'black',
        borderRadius: '8px',
        boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
        fontFamily: 'Inter, sans-serif'
      },
      children: 'This is the main content area. Click on components to select them across viewports!'
    });

    // Add the main component as a child of the header (simplified structure)
    appComponentTree.addChildren([mainComponent]);

    // Create viewport nodes (Framer-style: positioned on canvas)
    const desktopViewport = createViewportNode(
      `viewport-${desktopBreakpointId}`,
      desktopBreakpointId,
      'Desktop',
      1280,
      100, // X position
      100, // Y position
      1280, // Viewport width
      800   // Viewport height
    );

    const tabletViewport = createViewportNode(
      `viewport-${tabletBreakpointId}`,
      tabletBreakpointId,
      'Tablet',
      768,
      1430, // X position (100 + 1280 + 50 spacing)
      100,  // Y position
      768,  // Viewport width
      1024  // Viewport height
    );

    const mobileViewport = createViewportNode(
      `viewport-${mobileBreakpointId}`,
      mobileBreakpointId,
      'Mobile',
      320,
      2248, // X position (100 + 1280 + 50 + 768 + 50)
      100,  // Y position
      375,  // Viewport width
      667   // Viewport height
    );

    // Create sample floating elements
    const sampleImageComponent = createFloatingCanvasComponent(
      uuidv4(),
      'img',
      {
        src: '/images/sample-image.png',
        alt: 'Sample image',
        width: '400px',
        height: '300px',
        style: {
          objectFit: 'cover',
          borderRadius: '8px',
        }
      },
      1600,
      -500 // Position below viewports
    );

    const sampleTextComponent = createFloatingCanvasComponent(
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
      2100,
      500 // Position below viewports
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
          appComponentTree: appComponentTree, // Deployable app tree
          canvasNodes: {
            // Viewport nodes (breakpoint frames)
            [desktopViewport.id]: desktopViewport,
            [tabletViewport.id]: tabletViewport,
            [mobileViewport.id]: mobileViewport,
            // Floating elements
            [sampleImageComponent.id]: sampleImageComponent,
            [sampleTextComponent.id]: sampleTextComponent,
          },
        }
      }
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
