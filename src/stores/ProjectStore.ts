// src/stores/ProjectStore.ts  
// Domain store for managing projects collection
import { parseModelComponents } from '@/models/ComponentDefinitionModel';
import { types, Instance, applySnapshot } from 'mobx-state-tree';
import ProjectModel, { ProjectModelType, ProjectSnapshotIn } from '../models/ProjectModel';
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

    // Create the app component tree (Framer-style: direct components, no wrapper)
    // In Framer, the app tree is the Tree that represents the final page of the app
    const appComponentTree = createIntrinsicComponent('header-' + uuidv4(), 'header', {
      style: {
        color: 'white',
        padding: '16px',
        borderRadius: '8px',
        marginBottom: '20px',
        fontFamily: 'system-ui, sans-serif'
      },
    });

    // Add a main component as a sibling (this would be handled differently in a real app)
    const mainComponent = createIntrinsicComponent('main-' + uuidv4(), 'main', {
      style: {
        padding: '20px',
        backgroundColor: 'black',
        borderRadius: '8px',
        boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
        fontFamily: 'system-ui, sans-serif',
        color: 'white',
      },
      children: 'This is the main content area. Click on components to select them across viewports!'
    });



    // Create sample floating elements (Framer-style image component)
    const FloatingImageComponent = createFloatingCanvasComponent('img-inner-' + uuidv4(), 'img', {
      src: '/images/sample-image.jpg',
      alt: 'Sample image',
      draggable: false, // Prevent default image drag
      style: {
        display: 'block',
        width: '400px',
        height: '300px',
        borderRadius: '8px',
        objectPosition: 'center center',
        objectFit: 'cover',
        userSelect: 'none',
        WebkitUserDrag: 'none',
        pointerEvents: 'none', // Let parent handle all interactions
      }
    },
      1600,
      -500 // Position below viewports
    );

    // Set a proper label for the image component
    FloatingImageComponent.setLabel('Hero Image');

    // Create sample floating elements (Framer-style image component)
    const AppTreeImageComponent = createIntrinsicComponent('img-inner-' + uuidv4(), 'img', {
      src: '/images/sample-image.jpg',
      alt: 'Sample image',
      draggable: false, // Prevent default image drag
      style: {
        display: 'block',
        width: '400px',
        height: '300px',
        borderRadius: '8px',
        objectPosition: 'center center',
        objectFit: 'cover',
        userSelect: 'none',
        WebkitUserDrag: 'none',
        pointerEvents: 'none', // Let parent handle all interactions
        zIndex: 100,
      }
    });

    // Set a proper label for the image component
    AppTreeImageComponent.setLabel('App Tree Image');


    const sampleTextComponent = createFloatingCanvasComponent(
      uuidv4(),
      'div',
      {
        children: 'Welcome to Framer Clone!\nDrag elements around the canvas.',
        style: {
          width: '300px',
          height: '100px',
          fontSize: '16px',
          fontFamily: 'system-ui, sans-serif',
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

    // Set a proper label for the text component
    sampleTextComponent.setLabel('Welcome Text');

      // Add the main component as a child of the header (simplified structure)
      // Parent relationships will be automatically set by addChildren()
      appComponentTree.addChildren([mainComponent, AppTreeImageComponent]);

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
            [FloatingImageComponent.id]: FloatingImageComponent,
            [sampleTextComponent.id]: sampleTextComponent,
          },
        }
      }
    });
  },
  
  // Ingest a server-loaded project snapshot into the collection (MT-08).
  // MST accepts a snapshot as a map value inside an action; this keys it by the
  // snapshot's id and returns that id so callers can select it. Replaces any
  // existing project with the same id (pre-MVP: no merge semantics needed).
  ingestProjectSnapshot(snapshot: ProjectSnapshotIn): string {
    self.projects.set(snapshot.id, snapshot);
    // The model drops a definition it cannot read, so the reasons are taken here,
    // while the stored value is still in hand, for the publish check to show.
    self.projects.get(snapshot.id)?.replaceLoadRefusals(parseModelComponents(snapshot.components).refused);
    return snapshot.id;
  },

  // Put a newer server copy of an open project in place, touching only what
  // differs from `before` (the open copy's snapshot): `next` is the server copy
  // with every unchanged part replaced by `before`'s own object
  // (src/lib/projects/structuralSharing.ts), so a part that is the same object
  // is skipped, and of the pages only those added, removed or changed are
  // reconciled. A full `projects.set` would walk (and instantiate) every page
  // of the site for a one-node change. Falls back to ingestProjectSnapshot for
  // a project not in the store.
  adoptProjectSnapshot(next: ProjectSnapshotIn, before: ProjectSnapshotIn): string {
    const project = self.projects.get(next.id);
    if (!project) return this.ingestProjectSnapshot(next);
    const target = project as unknown as Record<string, unknown>;
    const nextParts = next as unknown as Record<string, unknown>;
    const beforeParts = before as unknown as Record<string, unknown>;
    const keys = new Set([...Object.keys(nextParts), ...Object.keys(beforeParts)]);
    // Refuse a malformed copy before anything is touched (a page whose id differs from its key
    // would throw in `pages.set` after another page was already removed).
    for (const [id, page] of Object.entries((nextParts.pages ?? {}) as Record<string, { id?: unknown }>)) {
      if (page && page.id !== id) throw new Error(`adoptProjectSnapshot: page keyed ${id} carries id ${String(page.id)}`);
    }
    try {
      for (const key of keys) {
        if (key === 'id' || nextParts[key] === beforeParts[key]) continue;
        if (key === 'pages') {
          const pages = project.pages;
          const nextPages = (nextParts.pages ?? {}) as Record<string, unknown>;
          const beforePages = (beforeParts.pages ?? {}) as Record<string, unknown>;
          for (const id of Object.keys(beforePages)) if (!(id in nextPages)) pages.delete(id);
          for (const [id, page] of Object.entries(nextPages)) {
            if (page !== beforePages[id]) pages.set(id, withStoredDates(pages.get(id), page) as never);
          }
          continue;
        }
        // Any other part (components through their processor, the settings, the metadata): assigned whole.
        target[key] = key === 'metadata' ? withStoredDates(project.metadata as never, nextParts[key]) : nextParts[key];
      }
    } catch (error) {
      // All or nothing: a failure part-way puts the whole working copy back as it was.
      applySnapshot(project, before as never);
      throw error;
    }
    // Always from the incoming components: the server may have removed the last refused definition, which leaves
    // both component maps equal (empty) while the stored refusals are stale.
    project.replaceLoadRefusals(parseModelComponents(next.components).refused);
    return next.id;
  },

  // Remove a project
  removeProject(projectId: string) {
    self.projects.delete(projectId);
  },
}))

/**
 * A page (or the project's metadata) snapshot with the stored node's own Date objects where the time is
 * the same: MobX-State-Tree keeps a date only when handed that very object, so
 * an equal timestamp would otherwise be replaced (a patch, and an undo step part).
 */
function withStoredDates(stored: { createdAt?: Date; updatedAt?: Date } | undefined, page: unknown): unknown {
  if (!stored || !page || typeof page !== 'object') return page;
  const snapshot = page as { createdAt?: unknown; updatedAt?: unknown };
  const same = (date: Date | undefined, value: unknown) =>
    date instanceof Date && (value instanceof Date ? value.getTime() === date.getTime() : value === date.getTime());
  const createdAt = same(stored.createdAt, snapshot.createdAt);
  const updatedAt = same(stored.updatedAt, snapshot.updatedAt);
  if (!createdAt && !updatedAt) return page;
  return {
    ...snapshot,
    ...(createdAt ? { createdAt: stored.createdAt } : {}),
    ...(updatedAt ? { updatedAt: stored.updatedAt } : {}),
  };
}

// TypeScript types
export type ProjectStoreType = Instance<typeof ProjectStore>;

export default ProjectStore;
