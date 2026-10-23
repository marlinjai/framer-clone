// src/models/ProjectModel.ts
// Domain model for projects - contains multiple pages and project-level settings
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';
import { types, Instance, SnapshotIn, SnapshotOut } from 'mobx-state-tree';
import { v4 as uuidv4 } from 'uuid';
import PageModel, { PageModelType } from './PageModel';
import { createIntrinsicComponent, createViewportNode, type ComponentSnapshotIn } from './ComponentModel';
import { suggestSlug, validateSlug, type SlugValidation } from '@/lib/pages/slug';
import {
  isHttpsUrl,
  normalizeSiteSettings,
  validateSiteSettings,
  type SiteSettings,
  type SiteSettingsErrors,
  type SiteSettingsInput,
} from '@/lib/site/siteSettings';

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

/** The outcome of ProjectModel.updatePageSettings: per-field problems, if any. */
export type PageSettingsResult =
  | { ok: true }
  | { ok: false; errors: { title?: string; slug?: string; ogImage?: string; notFoundPage?: string } };

/** What the page settings panel can change in one go. */
export interface PageSettingsInput {
  title: string;
  slug: string;
  description: string;
  /** https URL of the page's Open Graph image; blank uses the site default. Omitted: unchanged. */
  ogImage?: string;
  /** Keep the page out of search engines (robots noindex, left out of the sitemap). Omitted: unchanged. */
  noIndex?: boolean;
  /** Make this the site's 404 page (true) or stop being it (false). Omitted: unchanged. */
  notFoundPage?: boolean;
}

/** The outcome of ProjectModel.updateSiteSettings. */
export type SiteSettingsResult = { ok: true } | { ok: false; errors: SiteSettingsErrors };

// Project metadata model
const ProjectMetadataModel = types.model('ProjectMetadata', {
  title: types.string,
  description: '',
  
  // Timestamps
  createdAt: types.optional(types.Date, () => new Date()),
  updatedAt: types.optional(types.Date, () => new Date()),
});



// How many pages hold the empty (home) slug. Normally exactly one; older
// projects may have none (their home page was deleted) or, rarely, two.
function homePageCount(pages: Iterable<{ slug: string }>): number {
  let n = 0;
  for (const p of pages) if (p.slug === '') n++;
  return n;
}

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

    // Site settings (src/lib/site/siteSettings.ts): site name, language,
    // favicon, Open Graph defaults, title template, 404 page and the business
    // data. A frozen value, replaced as a whole by updateSiteSettings, so a
    // dialog save is one undo step and the shape lives in one pure module.
    // Normalized on the way in (older snapshots omit fields or the whole
    // object; `{}` is "all defaults", including language `en`), so the stored
    // value is always complete and a snapshot round-trips unchanged.
    siteSettings: types.optional(
      types.snapshotProcessor(types.frozen<SiteSettings>(), {
        preProcessor: (raw: SiteSettingsInput | undefined) => normalizeSiteSettings(raw),
      }),
      {},
    ),

  })
  .actions(self => {
  // A page's slug is locked when it is THE home page: it has the empty slug
  // and no other page does. An extra empty-slug page in an older project may
  // move to a real slug (one home page stays).
  const isSlugLocked = (pageId: string): boolean => {
    const page = self.pages.get(pageId);
    return !!page && page.slug === '' && homePageCount(self.pages.values()) <= 1;
  };
  return {

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
    // The slug is suggested from the title by the shared slug rules
    // (src/lib/pages/slug.ts): transliterated, capped, never reserved, and on
    // collision suffixed `-2`, `-3`, ... so every page has a unique URL path.
    createPage(title?: string): PageModelType {
      const effectiveTitle = (title && title.trim()) || `Page ${self.pages.size + 1}`;
      const slug = suggestSlug(effectiveTitle, Array.from(self.pages.values(), p => p.slug));

      // The three default frames (src/lib/canvas/defaultViewports.ts).
      const viewports = defaultViewportSnapshots();

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
        canvasNodes: viewports,
      }));
      self.metadata.updatedAt = new Date();
      return self.pages.get(pageId) as PageModelType;
    },

    // AI page generation: create a page whose app tree root holds the
    // generated sections, with viewports that reuse the given breakpoint ids
    // (the ids the generated responsive maps are keyed to). One action, so it
    // is one history entry. Slug collision handling matches createPage.
    addGeneratedPage(input: {
      title: string;
      description?: string;
      sections: ComponentSnapshotIn[];
      viewports: Array<{
        breakpointId: string;
        label: string;
        minWidth: number;
        x: number;
        y: number;
        width: number;
        height: number;
      }>;
    }): PageModelType {
      const title = input.title.trim() || `Page ${self.pages.size + 1}`;
      const slug = suggestSlug(title, Array.from(self.pages.values(), p => p.slug));

      const canvasNodes: Record<string, ReturnType<typeof createViewportNode>> = {};
      for (const v of input.viewports) {
        const node = createViewportNode(
          `viewport-${uuidv4()}`, v.breakpointId, v.label, v.minWidth, v.x, v.y, v.width, v.height,
        );
        canvasNodes[node.id] = node;
      }
      const rootId = 'root-' + uuidv4();
      const pageId = uuidv4();
      self.pages.set(pageId, PageModel.create({
        id: pageId,
        slug,
        metadata: { title, description: input.description ?? '' },
        appComponentTree: {
          id: rootId,
          type: 'div',
          componentType: 'host',
          label: 'Page',
          props: { style: { display: 'flex', flexDirection: 'column', width: '100%', fontFamily: 'Inter, sans-serif' } },
          children: input.sections.map(s => ({ ...s, parentId: rootId })),
        },
        canvasNodes,
      }));
      self.metadata.updatedAt = new Date();
      return self.pages.get(pageId) as PageModelType;
    },

    // Remove a page from the project
    removePage(pageId: string) {
      self.pages.delete(pageId);
      // The 404 page is gone: the site falls back to the default 404.
      const settings = normalizeSiteSettings(self.siteSettings);
      if (settings.notFoundPageId === pageId) {
        self.siteSettings = { ...settings, notFoundPageId: '' };
      }
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

    // Set a page's slug through the shared rules (format, reserved paths,
    // project-wide uniqueness). Returns the validation result so the UI can
    // explain a refusal. The home page (empty slug) always lives at the site
    // root, so its slug never changes. Nothing is rewritten silently: an
    // invalid slug is refused, not normalized.
    setPageSlug(pageId: string, slug: string): SlugValidation {
      const page = self.pages.get(pageId);
      if (!page) return { ok: false, code: 'empty', message: 'This page no longer exists.' };
      if (slug === page.slug) return { ok: true };
      if (isSlugLocked(page.id)) {
        return { ok: false, code: 'home_locked', message: 'The home page always lives at the site root.' };
      }
      const result = validateSlug(slug, {
        pageId,
        pages: Array.from(self.pages.values(), p => ({ id: p.id, slug: p.slug })),
      });
      if (!result.ok) return result;
      page.setSlug(slug);
      self.metadata.updatedAt = new Date();
      return { ok: true };
    },

    // The page settings panel's save: name, slug and meta description in ONE
    // action, so it is one undo step and one history entry. All fields are
    // validated first; on any problem nothing changes. An unchanged slug is
    // not re-validated (pages from before the slug rules keep theirs), and the
    // home page's slug can never change.
    updatePageSettings(pageId: string, input: PageSettingsInput): PageSettingsResult {
      const page = self.pages.get(pageId);
      if (!page) return { ok: false, errors: { title: 'This page no longer exists.' } };
      const errors: { title?: string; slug?: string; ogImage?: string; notFoundPage?: string } = {};
      const title = input.title.trim();
      if (!title) errors.title = 'Enter a page name.';
      const slugChanged = input.slug !== page.slug;
      if (slugChanged) {
        if (isSlugLocked(page.id)) {
          errors.slug = 'The home page always lives at the site root.';
        } else {
          const result = validateSlug(input.slug, {
            pageId,
            pages: Array.from(self.pages.values(), p => ({ id: p.id, slug: p.slug })),
          });
          if (!result.ok) errors.slug = result.message;
        }
      }
      const ogImage = input.ogImage === undefined ? page.metadata.ogImage : input.ogImage.trim();
      if (ogImage && !isHttpsUrl(ogImage)) errors.ogImage = 'Enter a full https:// address of an image.';
      // The page that ends up at the site root can never be the 404 page.
      const endsAsHome = slugChanged ? input.slug === '' : page.slug === '';
      if (input.notFoundPage && endsAsHome) {
        errors.notFoundPage = 'The home page cannot be the 404 page.';
      }
      if (errors.title || errors.slug || errors.ogImage || errors.notFoundPage) return { ok: false, errors };

      const description = input.description.trim();
      const noIndex = input.noIndex === undefined ? page.metadata.noIndex : input.noIndex;
      const metadataChanged =
        title !== page.metadata.title ||
        description !== page.metadata.description ||
        ogImage !== page.metadata.ogImage ||
        noIndex !== page.metadata.noIndex;
      const settings = normalizeSiteSettings(self.siteSettings);
      const isNotFound = settings.notFoundPageId === pageId;
      const notFoundChanged = input.notFoundPage !== undefined && input.notFoundPage !== isNotFound;
      // Nothing changed: no mutation, so no empty undo step.
      if (!metadataChanged && !slugChanged && !notFoundChanged) return { ok: true };
      if (metadataChanged) page.updateMetadata({ title, description, ogImage, noIndex });
      if (slugChanged) page.setSlug(input.slug);
      if (notFoundChanged) {
        // One pointer, so there is exactly one 404 page per site.
        self.siteSettings = { ...settings, notFoundPageId: input.notFoundPage ? pageId : '' };
      }
      self.metadata.updatedAt = new Date();
      return { ok: true };
    },

    // The Site settings dialog's save: the whole object in ONE action (one
    // undo step). Normalized, then validated; on any problem nothing changes.
    // The 404 pointer must name an existing page that is not the home page.
    updateSiteSettings(input: SiteSettingsInput): SiteSettingsResult {
      const next: SiteSettings = normalizeSiteSettings(input);
      const errors = validateSiteSettings(next);
      if (next.notFoundPageId) {
        const target = self.pages.get(next.notFoundPageId);
        if (!target) errors.notFoundPageId = 'That page no longer exists.';
        else if (target.slug === '') errors.notFoundPageId = 'The home page cannot be the 404 page.';
      }
      if (Object.keys(errors).length > 0) return { ok: false, errors };
      const current = normalizeSiteSettings(self.siteSettings);
      if (JSON.stringify(current) === JSON.stringify(next)) return { ok: true };
      self.siteSettings = next;
      self.metadata.updatedAt = new Date();
      return { ok: true };
    },

    // Give a project that has NO home page one: the chosen page takes the
    // empty slug and is served at the site root. Only for projects without a
    // home page (older projects could delete theirs); with a home page this is
    // refused, since the home page itself can never move. On a published site
    // the page's old path keeps working as a redirect to the root.
    makeHomePage(pageId: string): boolean {
      const page = self.pages.get(pageId);
      if (!page) return false;
      if (Array.from(self.pages.values()).some(p => p.slug === '')) return false;
      page.setSlug('');
      // The home page can never be the 404 page.
      const settings = normalizeSiteSettings(self.siteSettings);
      if (settings.notFoundPageId === pageId) {
        self.siteSettings = { ...settings, notFoundPageId: '' };
      }
      self.metadata.updatedAt = new Date();
      return true;
    },

    // Update project metadata
    updateMetadata(metadata: Partial<SnapshotIn<typeof ProjectMetadataModel>>) {
      Object.assign(self.metadata, metadata);
      self.metadata.updatedAt = new Date();
    },
  };
  })
  .views(self => ({
    // The Site settings, normalized: always complete, whatever the snapshot held.
    get site(): SiteSettings {
      return normalizeSiteSettings(self.siteSettings);
    },

    // True when the page's slug cannot change: it is the project's only home
    // page (see isSlugLocked in the actions above).
    isSlugLocked(pageId: string): boolean {
      const page = self.pages.get(pageId);
      return !!page && page.slug === '' && homePageCount(self.pages.values()) <= 1;
    },

    // True when the project has no page at the site root (older projects
    // whose home page was deleted); the page list then offers makeHomePage.
    get hasHomePage(): boolean {
      return homePageCount(self.pages.values()) > 0;
    },

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
