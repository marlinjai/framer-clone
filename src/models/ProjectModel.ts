// src/models/ProjectModel.ts
// Domain model for projects - contains multiple pages and project-level settings
import { types, Instance, SnapshotIn, SnapshotOut } from 'mobx-state-tree';
import { v4 as uuidv4 } from 'uuid';
import PageModel, { PageModelType } from './PageModel';
import { createIntrinsicComponent, createViewportNode } from './ComponentModel';

// ---- Lumitra Studio binding ---------------------------------------------
//
// Optional sub-tree on `ProjectModel` that pairs a framer-clone site with a
// Lumitra Analytics project. This is the foundation slice (Wave 1): the
// fields persist here so later specs (snippet injection on publish,
// dashboard deep-link, edit-mode heatmap overlay) can read them without
// re-shaping MST. No UI in this spec.
//
// Secret-handling note: `apiKeyRef` stores a server-side reference
// (Infisical path, workspace-scoped pointer, etc.) — NOT the literal API
// key. The key resolution happens server-side on the publish path so the
// secret never lives in MST or in the publish output.
export const LumitraBindingModel = types
  .model('LumitraBinding', {
    projectId: types.maybe(types.string),
    ingestionEndpoint: types.maybe(types.string),
    apiKeyRef: types.maybe(types.string),
    enabled: types.optional(types.boolean, false),
  })
  .actions(self => ({
    setProjectId(id: string | undefined) {
      self.projectId = id;
    },
    setIngestionEndpoint(url: string | undefined) {
      self.ingestionEndpoint = url;
    },
    setApiKeyRef(ref: string | undefined) {
      self.apiKeyRef = ref;
    },
    setEnabled(on: boolean) {
      self.enabled = on;
    },
  }));

export type LumitraBindingType = Instance<typeof LumitraBindingModel>;

function slugify(input: string): string {
  const base = input.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'page';
}

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

    // Lumitra Analytics binding. `types.optional` with a factory means
    // pre-existing snapshots that omit `lumitra` load with the default
    // empty block (`enabled: false`, other fields undefined). No backcompat
    // guards needed at call sites — read `project.lumitra` directly.
    lumitra: types.optional(LumitraBindingModel, () => ({})),

  })
  .actions(self => ({

    // Add a new page to the project
    addPage(page: SnapshotIn<typeof PageModel>) {
      self.pages.set(page.id, page);
      self.metadata.updatedAt = new Date();
    },

    // ---- Lumitra binding mutations ---------------------------------------
    //
    // Thin pass-through wrappers around `LumitraBindingModel` actions so the
    // ProjectModel exposes a flat API surface for settings UIs (Wave 2) and
    // so each write bumps `updatedAt` and shows up in history as a single
    // user-visible action.

    setLumitraProjectId(id: string | undefined) {
      self.lumitra.setProjectId(id);
      self.metadata.updatedAt = new Date();
    },

    setLumitraIngestionEndpoint(url: string | undefined) {
      self.lumitra.setIngestionEndpoint(url);
      self.metadata.updatedAt = new Date();
    },

    setLumitraApiKeyRef(ref: string | undefined) {
      self.lumitra.setApiKeyRef(ref);
      self.metadata.updatedAt = new Date();
    },

    setLumitraEnabled(on: boolean) {
      self.lumitra.setEnabled(on);
      self.metadata.updatedAt = new Date();
    },

    // Create a fresh page with default viewports and an empty app tree root.
    // Title defaults to "Page N" where N is one past the current page count.
    // The slug is derived from the title; on collision a `-<short-uuid>`
    // suffix is appended so every page has a unique URL path.
    createPage(title?: string): PageModelType {
      const existingSlugs = new Set(
        Array.from(self.pages.values()).map(p => p.slug),
      );
      const effectiveTitle = (title && title.trim()) || `Page ${self.pages.size + 1}`;
      let slug = slugify(effectiveTitle);
      if (existingSlugs.has(slug)) {
        slug = `${slug}-${uuidv4().slice(0, 6)}`;
      }

      const desktopBreakpointId = uuidv4();
      const tabletBreakpointId = uuidv4();
      const mobileBreakpointId = uuidv4();

      const desktop = createViewportNode(
        `viewport-${desktopBreakpointId}`,
        desktopBreakpointId,
        'Desktop', 1280, 100, 100, 1280, 800,
      );
      const tablet = createViewportNode(
        `viewport-${tabletBreakpointId}`,
        tabletBreakpointId,
        'Tablet', 768, 1430, 100, 768, 1024,
      );
      const mobile = createViewportNode(
        `viewport-${mobileBreakpointId}`,
        mobileBreakpointId,
        'Mobile', 320, 2248, 100, 375, 667,
      );

      // Minimal app tree root. Using `div` (not `header`) keeps the semantic
      // tree flexible — users compose the hierarchy from here.
      const appTree = createIntrinsicComponent('root-' + uuidv4(), 'div', {
        style: {
          padding: '16px',
          fontFamily: 'Inter, sans-serif',
        },
      });

      const pageId = uuidv4();
      self.pages.set(pageId, PageModel.create({
        id: pageId,
        slug,
        metadata: { title: effectiveTitle, description: '' },
        appComponentTree: appTree,
        canvasNodes: {
          [desktop.id]: desktop,
          [tablet.id]: tablet,
          [mobile.id]: mobile,
        },
      }));
      self.metadata.updatedAt = new Date();
      return self.pages.get(pageId) as PageModelType;
    },

    // Remove a page from the project
    removePage(pageId: string) {
      self.pages.delete(pageId);
      self.metadata.updatedAt = new Date();
    },

    // Rename a page's visible title. Title doesn't have a uniqueness
    // constraint so this just passes through to the page.
    renamePage(pageId: string, title: string): boolean {
      const page = self.pages.get(pageId);
      if (!page) return false;
      const trimmed = title.trim();
      if (!trimmed) return false;
      page.updateMetadata({ title: trimmed });
      self.metadata.updatedAt = new Date();
      return true;
    },

    // Set a page's slug with project-wide uniqueness enforcement. Returns
    // false when the requested slug is already taken by a different page so
    // the UI can signal "try another". Empty slugs are rejected — routing
    // assumes every page has one.
    setPageSlug(pageId: string, rawSlug: string): boolean {
      const page = self.pages.get(pageId);
      if (!page) return false;
      const slug = slugify(rawSlug);
      if (!slug) return false;
      for (const other of self.pages.values()) {
        if (other.id !== pageId && other.slug === slug) return false;
      }
      page.setSlug(slug);
      self.metadata.updatedAt = new Date();
      return true;
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
