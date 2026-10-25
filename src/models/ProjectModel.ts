// src/models/ProjectModel.ts
// Domain model for projects - contains multiple pages and project-level settings
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';
import { types, Instance, SnapshotIn, SnapshotOut, getSnapshot } from 'mobx-state-tree';
import { v4 as uuidv4 } from 'uuid';
import PageModel, { PageModelType } from './PageModel';
import ComponentModel, { createIntrinsicComponent, createViewportNode, type ComponentInstance, type ComponentSnapshotIn } from './ComponentModel';
import { suggestSlug, validateSlug, type SlugValidation } from '@/lib/pages/slug';
import {
  isHttpsUrl,
  normalizeSiteSettings,
  validateSiteSettings,
  type SiteSettings,
  type SiteSettingsErrors,
  type SiteSettingsInput,
} from '@/lib/site/siteSettings';
import { effectiveSiteName } from '@/lib/site/siteSettings';
import {
  COOKIE_SETTINGS_HASH,
  COOKIE_SETTINGS_LABELS,
  LEGAL_KINDS,
  LEGAL_LINK_LABELS,
  LEGAL_SLUGS,
  findLegalPage,
  legalLanguage,
  type LegalKind,
} from '@/lib/legal/legalPages';
import { buildLegalTemplate, factsFromTrees } from '@/lib/legal/templates';
import {
  LEGAL_LINKS_MARKER,
  footerLinkNode,
  footerLinksNav,
  legalPageRoot,
  type FooterLink,
  type LegalPageLook,
} from '@/lib/legal/legalPageTree';

/** A style value's base (responsive maps carry `base`), when it is a plain safe string. */
function baseStyle(value: unknown): string | undefined {
  const raw =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && typeof (value as Record<string, unknown>).base === 'string'
        ? ((value as Record<string, unknown>).base as string)
        : undefined;
  if (!raw || /[<>;{}]|url\(|expression\(/i.test(raw)) return undefined;
  return raw.trim() || undefined;
}

/** Every node of this type in a component tree, in document order. */
function findByType(root: ComponentInstance, type: string): ComponentInstance[] {
  const out: ComponentInstance[] = [];
  const visit = (node: ComponentInstance) => {
    if (node.type === type) out.push(node);
    node.children.forEach((c: ComponentInstance) => visit(c));
  };
  visit(root);
  return out;
}

/** Result of ProjectModel.addLegalLinksToFooters. */
export interface LegalLinksResult {
  /** Pages whose footer gained at least one link. */
  pagesUpdated: number;
  /** Pages (other than legal pages) with no footer to put links in. */
  pagesWithoutFooter: number;
}

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

/**
 * The outcome of ProjectModel.setHomePage: the chosen page's slug before the
 * change (its old path, now leading to the root) and where the former home
 * page(s) moved.
 */
export type SetHomePageResult =
  | { ok: true; previousSlug: string; moved: Array<{ pageId: string; title: string; slug: string }> }
  | { ok: false; message: string };

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

/**
 * Where the current home page(s) move when `pageId` becomes the home page:
 * every OTHER page holding the empty slug gets a free slug suggested from its
 * name. The chosen page's current path stays taken, so it can become a
 * redirect to the root instead of being claimed by the former home page.
 * Shared by ProjectModel.setHomePage and the panel's preview of it.
 */
function planHomeChange(
  pages: Iterable<{ id: string; slug: string; metadata: { title: string } }>,
  pageId: string,
): Array<{ pageId: string; title: string; slug: string }> {
  const list = Array.from(pages);
  const taken = list.map(p => p.slug);
  const moved: Array<{ pageId: string; title: string; slug: string }> = [];
  for (const former of list) {
    if (former.id === pageId || former.slug !== '') continue;
    const slug = suggestSlug(former.metadata.title, taken);
    taken.push(slug);
    moved.push({ pageId: former.id, title: former.metadata.title, slug });
  }
  return moved;
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
          fontFamily: 'system-ui, sans-serif',
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

    // A simple thank-you page for a form's "redirect to a page" success target
    // (published site essentials, decision 4): a heading, a sentence and a link
    // back to the home page, in one action (one history entry). The owner
    // edits it like any page. The slug follows createPage's rules.
    createThankYouPage(copy: { title?: string; heading?: string; text?: string; backLabel?: string } = {}): PageModelType {
      const page = (self as unknown as { createPage(title?: string): PageModelType }).createPage(copy.title?.trim() || 'Thank you');
      const root = page.appComponentTree as unknown as ComponentInstance;
      root.updateResponsiveStyle('padding', '96px 24px');
      root.updateResponsiveStyle('display', 'flex');
      root.updateResponsiveStyle('flexDirection', 'column');
      root.updateResponsiveStyle('alignItems', 'center');
      root.updateResponsiveStyle('gap', '16px');
      root.updateResponsiveStyle('textAlign', 'center');
      const heading = createIntrinsicComponent('heading-' + uuidv4(), 'h1', {
        children: copy.heading?.trim() || 'Thank you!',
        style: { fontSize: '40px', fontWeight: 700, margin: 0, color: '#111827' },
      });
      heading.setLabel('Heading');
      const text = createIntrinsicComponent('text-' + uuidv4(), 'p', {
        children: copy.text?.trim() || 'We received your message and will get back to you soon.',
        style: { fontSize: '18px', margin: 0, color: '#374151', maxWidth: '560px' },
      });
      text.setLabel('Text');
      const back = createIntrinsicComponent('link-' + uuidv4(), 'a', {
        children: copy.backLabel?.trim() || 'Back to the home page',
        href: '/',
        style: { fontSize: '16px', fontWeight: 600, color: '#111827', textDecoration: 'underline' },
      });
      back.setLabel('Back link');
      root.addChildren([heading, text, back]);
      self.metadata.updatedAt = new Date();
      return page;
    },

    // Legal pages (published site essentials, decision 5): create the
    // Impressum, privacy policy or terms from the template, filled from the
    // Site settings business data, in the site language, at the kind's stable
    // slug (/impressum, /datenschutz, /agb; /imprint, /privacy, /terms). When
    // the project already has that page (created before, or the owner's own
    // page at one of those slugs) it is returned unchanged: never a second
    // copy at "impressum-2". The new page's link goes into every footer in
    // the same action (one history entry).
    createLegalPage(kind: LegalKind): { page: PageModelType; created: boolean } {
      const existing = findLegalPage(self.pages.values(), kind);
      if (existing) return { page: existing, created: false };

      const settings = normalizeSiteSettings(self.siteSettings);
      const lang = legalLanguage(settings.language);
      const pages = Array.from(self.pages.values());
      const trees = pages.map(p => getSnapshot(p.appComponentTree) as Parameters<typeof factsFromTrees>[0] extends Iterable<infer T> ? T : never);
      const template = buildLegalTemplate({
        kind,
        language: settings.language,
        business: settings.business,
        siteName: effectiveSiteName(settings, self.metadata.title),
        facts: factsFromTrees(trees, self.lumitra.enabled),
      });

      // The home page's font and colours, so the legal page looks like the site.
      const home = pages.find(p => p.slug === '');
      const homeStyle = (home ? (getSnapshot(home.appComponentTree) as { props?: { style?: Record<string, unknown> } }).props?.style : undefined) ?? {};
      const look: LegalPageLook = {
        fontFamily: baseStyle(homeStyle.fontFamily),
        color: baseStyle(homeStyle.color),
        backgroundColor: baseStyle(homeStyle.backgroundColor),
      };

      const pageId = uuidv4();
      self.pages.set(pageId, PageModel.create({
        id: pageId,
        // Free: findLegalPage above returns any page at either language's slug.
        slug: LEGAL_SLUGS[lang][kind],
        metadata: { title: template.title, description: template.description, legalTemplate: kind },
        appComponentTree: legalPageRoot(template, look) as unknown as ComponentSnapshotIn,
        canvasNodes: defaultViewportSnapshots(),
      }));
      const page = self.pages.get(pageId) as PageModelType;
      (self as unknown as { addLegalLinksToFooters(): LegalLinksResult }).addLegalLinksToFooters();
      self.metadata.updatedAt = new Date();
      return { page, created: true };
    },

    // Put links to the project's legal pages (and the "Cookie settings" link
    // the consent banner reopens from) into the footer of every page that has
    // one: a small nav at the end of the page's last <footer>. Links already
    // in that footer (same href) are not added twice, and a second run adds
    // to the same nav. Pages without a footer are counted, not changed.
    addLegalLinksToFooters(): LegalLinksResult {
      const settings = normalizeSiteSettings(self.siteSettings);
      const lang = legalLanguage(settings.language);
      const pages = Array.from(self.pages.values());
      const links: FooterLink[] = [];
      for (const kind of LEGAL_KINDS) {
        const page = findLegalPage(pages, kind);
        if (page) links.push({ href: `/${page.slug}`, label: LEGAL_LINK_LABELS[lang][kind] });
      }
      links.push({ href: COOKIE_SETTINGS_HASH, label: COOKIE_SETTINGS_LABELS[lang] });

      const result: LegalLinksResult = { pagesUpdated: 0, pagesWithoutFooter: 0 };
      for (const page of pages) {
        const root = page.appComponentTree as unknown as ComponentInstance;
        const footers = findByType(root, 'footer');
        const footer = footers[footers.length - 1];
        if (!footer) {
          if (!page.metadata.legalTemplate) result.pagesWithoutFooter++;
          continue;
        }
        const hrefs = new Set(
          findByType(footer, 'a')
            .map((a: ComponentInstance) => (a.props as Record<string, unknown>).href)
            .filter((h): h is string => typeof h === 'string'),
        );
        const missing = links.filter(l => !hrefs.has(l.href));
        if (missing.length === 0) continue;
        const nav = footer.children.find(
          (c: ComponentInstance) => (c.props as Record<string, unknown>)[LEGAL_LINKS_MARKER] !== undefined,
        ) as ComponentInstance | undefined;
        if (nav) {
          for (const link of missing) nav.addChild(ComponentModel.create(footerLinkNode(link) as unknown as ComponentSnapshotIn));
        } else {
          footer.addChild(
            ComponentModel.create(footerLinksNav(missing, lang === 'de' ? 'Rechtliches' : 'Legal') as unknown as ComponentSnapshotIn),
          );
        }
        result.pagesUpdated++;
      }
      if (result.pagesUpdated > 0) self.metadata.updatedAt = new Date();
      return result;
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
          props: { style: { display: 'flex', flexDirection: 'column', width: '100%', fontFamily: 'system-ui, sans-serif' } },
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

    // "Set as home page": the chosen page takes the empty slug and is served
    // at the site root, in ONE action (one undo step). The page that was the
    // home page until now (or, in an older project, every page holding the
    // empty slug) moves to a free slug derived from its name, through the
    // shared slug rules (src/lib/pages/slug.ts); it is then an ordinary page,
    // so it can be renamed, moved or deleted. A project without a home page
    // (older projects could delete theirs) simply gets one.
    //
    // The chosen page's old path is reserved while the former home page's
    // slug is picked, so the two never trade places by accident. In-site links
    // to that old path (href "/about", also with "#..." or "?...") are pointed
    // at "/" in the same action, so they keep working on an unpublished site
    // too. On a published site the server additionally records the old path
    // as a redirect to the page (now the root) on the next save, and the root
    // address now serves the new home page (src/lib/pages/redirects.ts).
    //
    // The 404 page can never be the home page: the pointer is cleared when it
    // named the chosen page. Sitemap, canonical URLs and the published router
    // read the slugs, so they follow without further changes.
    setHomePage(pageId: string): SetHomePageResult {
      const page = self.pages.get(pageId);
      if (!page) return { ok: false, message: 'This page no longer exists.' };
      if (page.slug === '' && homePageCount(self.pages.values()) === 1) {
        return { ok: false, message: 'This page is already the home page.' };
      }
      const previousSlug = page.slug;
      const moved = planHomeChange(self.pages.values(), pageId);
      for (const m of moved) self.pages.get(m.pageId)?.setSlug(m.slug);
      page.setSlug('');

      if (previousSlug !== '') {
        const oldPath = `/${previousSlug}`;
        const retarget = (href: string): string | undefined => {
          if (href === oldPath) return '/';
          if (href.startsWith(`${oldPath}#`) || href.startsWith(`${oldPath}?`)) return `/${href.slice(oldPath.length)}`;
          return undefined;
        };
        const visit = (node: ComponentInstance) => {
          const href = (node.props as Record<string, unknown>).href;
          if (typeof href === 'string') {
            const next = retarget(href);
            if (next !== undefined) node.setProps({ href: next });
          }
          node.children.forEach((c: ComponentInstance) => visit(c));
        };
        for (const p of self.pages.values()) visit(p.appComponentTree as unknown as ComponentInstance);
      }

      const settings = normalizeSiteSettings(self.siteSettings);
      if (settings.notFoundPageId === pageId) {
        self.siteSettings = { ...settings, notFoundPageId: '' };
      }
      self.metadata.updatedAt = new Date();
      return { ok: true, previousSlug, moved };
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

    // What setHomePage(pageId) would do, without doing it: the former home
    // page(s) and the slug each would move to. The panel shows this before
    // the owner confirms.
    previewHomeChange(pageId: string): Array<{ pageId: string; title: string; slug: string }> {
      return planHomeChange(self.pages.values(), pageId);
    },

    // The page served at the site root (the first, in an older project with
    // two), or undefined when the project has none.
    get homePage(): PageModelType | undefined {
      return Array.from(self.pages.values()).find(p => p.slug === '');
    },

    // False when the project has no page at the site root (older projects
    // whose home page was deleted); any page can then take it (setHomePage).
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
