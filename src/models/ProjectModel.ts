// src/models/ProjectModel.ts
// Domain model for projects - contains multiple pages and project-level settings
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';
import {
  addDisposer,
  addMiddleware,
  getRoot,
  getSnapshot,
  recordPatches,
  types,
  Instance,
  SnapshotIn,
  SnapshotOut,
} from 'mobx-state-tree';
import {
  contentModelRefusal,
  placementRefusal,
  stateRefusal,
  type ComponentDefinitions,
  type RefusedDefinition,
  type StateDefinition,
} from '@/lib/components/definition';
import { detachRefusal, detachedTree, type StoredNode } from '@/lib/components/detach';
import { mapNodeProps } from '@/lib/components/breakpoints';
import { inputDefinitionRefusal, mayBindToSlot, parseInputValue, type InputDefinition } from '@/lib/components/inputs';
import { parseExpression } from '@/lib/bindings/resolver/expression';
import { COMPONENT_LIMITS, PLACEMENT_TYPE, isPlacementType, serializedBytes, type PlacementProps } from '@/lib/components/placement';
import { extractBreakpoints } from '@/lib/renderer/server/componentSnapshot';
import { isStickyCta } from '@/lib/stickyCta/stickyCta';
import { literalPageTree } from '@/lib/renderer/server/snapshotToComponentNode';
import { v4 as uuidv4 } from 'uuid';
import PageModel, { PageModelType, type InsertTarget } from './PageModel';
import { ComponentDefinitionModel, parseModelComponents, type ComponentDefinitionInstance } from './ComponentDefinitionModel';
import { takeBackRefusedEdit } from '@/stores/HistoryStore';
import ComponentModel, { createIntrinsicComponent, createViewportNode, type ComponentInstance, type ComponentSnapshotIn } from './ComponentModel';
import { isDynamicSegment, productPagePath, suggestSlug, validateSlug, type SlugValidation } from '@/lib/pages/slug';
import {
  isHttpsUrl,
  normalizeSiteSettings,
  validateSiteSettings,
  type SiteSettings,
  type SiteSettingsErrors,
  type SiteSettingsInput,
} from '@/lib/site/siteSettings';
import { effectiveSiteName } from '@/lib/site/siteSettings';
import { normalizeTheme, validateThemeWrite, type SiteTheme } from '@/lib/site/theme';
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

/** The placed content a walk over a tree can reach, by definition id. */
type DefinitionLookup = { get(id: string): ComponentDefinitionInstance | undefined };

/**
 * Every footer a tree renders, in document order: its own, and those inside the
 * definitions it places, at the placement's position. `reached` collects those
 * definitions. Stored JSON can hold a cycle, so a walk stops as expansion does.
 */
function findFooters(
  root: ComponentInstance,
  components: DefinitionLookup,
  reached: Set<string>,
  stack: readonly string[] = [],
): ComponentInstance[] {
  const out: ComponentInstance[] = [];
  const visit = (node: ComponentInstance) => {
    if (isPlacementType(node.type)) {
      const id = (node.props as Partial<PlacementProps>).component;
      const definition = typeof id === 'string' ? components.get(id) : undefined;
      if (!definition || stack.includes(definition.id) || stack.length >= COMPONENT_LIMITS.nestingDepth) return;
      reached.add(definition.id);
      out.push(...findFooters(definition.page.appComponentTree as ComponentInstance, components, reached, [...stack, definition.id]));
      return;
    }
    if (node.type === 'footer') out.push(node);
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

/** The outcome of ProjectModel.updateTheme. */
export type ThemeResult = { ok: true } | { ok: false; errors: string[] };

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

/** What a component action did. A refusal says why, so the panel can show it. */
export type ComponentActionResult<T = object> = ({ ok: true } & T) | { ok: false; message: string };

/** The definitions these patches touched, by id. Paths are relative to the project. */
function touchedDefinitions(patches: readonly { path: string }[]): Set<string> {
  const ids = new Set<string>();
  for (const { path } of patches) {
    const [, root, id] = path.split('/');
    if (root === 'components' && id) ids.add(id);
  }
  return ids;
}

/** Every node of a tree, itself first. */
function eachNode(root: ComponentInstance, visit: (node: ComponentInstance) => void): void {
  visit(root);
  root.children.forEach((child: ComponentInstance) => eachNode(child, visit));
}

/** The nodes of a page or a definition's page: the tree and whatever floats beside it. */
function nodesOfPage(page: PageModelType): ComponentInstance[] {
  const nodes: ComponentInstance[] = [];
  eachNode(page.appComponentTree as unknown as ComponentInstance, node => nodes.push(node));
  for (const canvasNode of page.canvasNodes.values()) {
    eachNode(canvasNode as unknown as ComponentInstance, node => nodes.push(node));
  }
  return nodes;
}

function nodesInclude(root: ComponentInstance, test: (node: ComponentInstance) => boolean): boolean {
  let found = false;
  eachNode(root, node => {
    found = found || test(node);
  });
  return found;
}

/** The input id a binding reads, when it reads one. */
function boundInputId(entry: { mode?: string; expression?: string }): string | undefined {
  const path = entry.mode === 'read' ? parseExpression(entry.expression ?? '')?.path : undefined;
  return path?.[0] === 'input' ? path[1] : undefined;
}

/** The site's definitions as plain data, which is what expansion reads. */
function definitionsOf(project: { components: unknown }): ComponentDefinitions {
  return getSnapshot(project.components as Parameters<typeof getSnapshot>[0]) as unknown as ComponentDefinitions;
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

    // Reusable components (src/models/ComponentDefinitionModel.ts), by id. Older
    // snapshots omit the key, which is no definitions. Normalized on the way in,
    // on every path into the model: stored JSON can say anything, and a
    // definition that cannot be read is skipped with a warning, so its placements
    // show as missing and the project still opens.
    components: types.optional(
      types.snapshotProcessor(types.map(ComponentDefinitionModel), {
        preProcessor: (raw: unknown) => parseModelComponents(raw).definitions as never,
      }),
      {},
    ),

  })
  .volatile(() => ({
    // What the publish check cannot see in the model: definitions the load skipped
    // and edits undone for going over a limit. Never saved and never an undo step.
    refusedComponents: [] as RefusedDefinition[],
  }))
  .actions(self => ({
    noteRefusedComponents(refused: readonly RefusedDefinition[]) {
      const same = (a: RefusedDefinition, b: RefusedDefinition) => a.id === b.id && a.reason === b.reason;
      // An edit refused again replaces its earlier entry with a new object, so a
      // publish that acknowledged the earlier one does not clear this one too.
      const kept = self.refusedComponents.filter(old => !refused.some(entry => entry.edit && same(old, entry)));
      const fresh = refused.filter(entry => entry.edit || !kept.some(old => same(old, entry)));
      if (fresh.length > 0 || kept.length !== self.refusedComponents.length) {
        self.refusedComponents = [...kept, ...fresh.map(entry => ({ ...entry }))];
      }
    },
    // What the load skipped, as the stored value now says. A project loaded over
    // itself keeps its volatile state, so the earlier load's entries must go.
    replaceLoadRefusals(refused: readonly RefusedDefinition[]) {
      self.refusedComponents = [...self.refusedComponents.filter(({ edit }) => edit), ...refused.map(entry => ({ ...entry }))];
    },
    // Once a publish went out past the warning: only the edits it listed. One
    // refused while the request was out is not in what went out, and stays.
    clearRefusedEdits(acknowledged: readonly RefusedDefinition[]) {
      self.refusedComponents = self.refusedComponents.filter(entry => !entry.edit || !acknowledged.includes(entry));
    },
  }))
  .actions(self => ({
    // A definition over its size is refused whole when it is next read, and the
    // Save after that would take it out of the column. Stopping that at the last
    // moment is the only place that sees every edit: a typed sentence, a pasted
    // image address, a generated subtree, any action on any node inside. So each
    // top-level action that touched a definition is measured, and undone whole if
    // it took one over. Undo and redo apply patches and are not edits.
    afterCreate() {
      addDisposer(self, addMiddleware(self, (call, next) => {
        if (call.type !== 'action' || call.parentActionEvent || call.name.startsWith('@')) {
          next(call);
          return;
        }
        const recorder = recordPatches(self);
        next(call, result => {
          recorder.stop();
          const limit = COMPONENT_LIMITS.definitionBytes;
          const sizeOf = (id: string) => {
            const definition = self.components.get(id);
            return definition ? serializedBytes(getSnapshot(definition)) : 0;
          };
          const after = new Map([...touchedDefinitions(recorder.patches)].map(id => [id, sizeOf(id)]));
          const over = [...after].filter(([, size]) => size > limit);
          if (over.length === 0) return result;
          takeBackRefusedEdit(() => recorder.undo());
          // One that already was too big may still shrink, and that edit stands.
          const grew = over.filter(([id, size]) => size > sizeOf(id));
          if (grew.length === 0) {
            recorder.replay();
            return result;
          }
          const [id] = grew[0];
          const name = self.components.get(id)?.name ?? id;
          const message = `${name} would be larger than ${Math.round(limit / 1024)} kilobytes, so this edit was undone.`;
          console.warn(`[ProjectModel] ${message}`);
          self.noteRefusedComponents([{ id: name, reason: message, edit: true }]);
          getRoot<{ editorUI?: { setEditorNotice?: (notice: { kind: 'refused'; message: string }) => void } }>(self)
            .editorUI?.setEditorNotice?.({ kind: 'refused', message });
          const refused = !!result && typeof result === 'object' && 'ok' in result;
          return refused ? { ok: false, message } : undefined;
        });
      }));
    },
  }))
  .actions(self => {
  // A page's slug is locked when it is THE home page: it has the empty slug
  // and no other page does. An extra empty-slug page in an older project may
  // move to a real slug (one home page stays).
  const isSlugLocked = (pageId: string): boolean => {
    const page = self.pages.get(pageId);
    return !!page && page.slug === '' && homePageCount(self.pages.values()) <= 1;
  };
  // The page with this id, among the pages or inside a definition.
  const pageById = (pageId: string): PageModelType | undefined => {
    const page = self.pages.get(pageId);
    if (page) return page;
    for (const definition of self.components.values()) {
      if (definition.page.id === pageId) return definition.page as PageModelType;
    }
    return undefined;
  };
  const allPages = (): PageModelType[] => [
    ...self.pages.values(),
    ...Array.from(self.components.values(), definition => definition.page as PageModelType),
  ];
  const placementsOf = (definitionId: string): Array<{ page: PageModelType; node: ComponentInstance }> =>
    allPages().flatMap(page =>
      nodesOfPage(page)
        .filter(node => isPlacementType(node.type) && (node.props as Partial<PlacementProps>).component === definitionId)
        .map(node => ({ page, node })),
    );
  const parentOf = (page: PageModelType, node: ComponentInstance): ComponentInstance | undefined =>
    nodesOfPage(page).find(candidate => candidate.children.includes(node));
  const nameRefusal = (name: string, except?: string): string | undefined => {
    if (!name) return 'Give the component a name.';
    const taken = Array.from(self.components.values()).some(other => other.id !== except && other.name === name);
    return taken ? `There is already a component called ${name}.` : undefined;
  };
  const inputWithout = (node: ComponentInstance, inputId: string) => {
    const { inputs } = node.props as Partial<PlacementProps>;
    if (inputs && inputId in inputs) {
      const { [inputId]: _gone, ...rest } = inputs;
      void _gone;
      node.setProps({ inputs: Object.keys(rest).length > 0 ? rest : undefined });
    }
    node.clearBinding(`input.${inputId}`);
  };
  // Replace a placement with its plain copy, in the holder's breakpoints.
  const detachNode = (page: PageModelType, node: ComponentInstance): ComponentActionResult<{ root?: ComponentInstance }> => {
    const stored = node.props as Partial<PlacementProps>;
    const definition = definitionsOf(self)[stored.component ?? ''];
    if (!definition) return { ok: false, message: 'This component no longer exists.' };
    const refusal = detachRefusal(definition);
    if (refusal) return { ok: false, message: refusal };
    const takenIds = new Set(nodesOfPage(page).flatMap(({ props }) => {
      const id = (props as { id?: unknown }).id;
      return typeof id === 'string' ? [id] : [];
    }));
    const tree = detachedTree(getSnapshot(node) as unknown as StoredNode, {
      definition,
      holderBreakpoints: extractBreakpoints(getSnapshot(page.canvasNodes)),
      takenIds,
      newId: uuidv4,
    });
    const parent = parentOf(page, node);
    if (!parent) {
      // Floating beside the page: the copy keeps the spot.
      // Read before the removal: MST destroys a node taken out of its map.
      const { canvasNodeType, canvasX, canvasY } = node;
      page.removeCanvasNode(node.id);
      if (!tree) return { ok: true };
      const floating = ComponentModel.create({
        ...(tree as unknown as ComponentSnapshotIn),
        canvasNodeType,
        canvasX,
        canvasY,
      });
      page.addCanvasNode(floating);
      return { ok: true, root: page.getCanvasNode(floating.id) };
    }
    const index = parent.children.findIndex((child: ComponentInstance) => child.id === node.id);
    parent.removeChild(node.id);
    if (!tree) return { ok: true };
    const root = ComponentModel.create({ ...(tree as unknown as ComponentSnapshotIn), parentId: parent.id });
    parent.addChild(root, index);
    return { ok: true, root };
  };

  return {

    // ---- Reusable components (docs/plans/2026-11-02-reusable-components.md) ----
    //
    // These cross pages, so they are actions here: a page action could not record
    // patches on another page's subtree as one user step. Each is one history
    // entry. A size limit is enforced for all of them by the guard in afterCreate.

    // Make a component from selected nodes of one parent. Several become one under
    // a `div`, as does a node with no element of its own, since a definition root
    // needs one. The selection becomes one placement, and undo restores it.
    createComponentFromSelection(pageId: string, nodeIds: readonly string[], rawName: string): ComponentActionResult<{ definitionId: string; placement: ComponentInstance }> {
      const name = rawName.trim();
      const page = pageById(pageId);
      if (!page) return { ok: false, message: 'This page no longer exists.' };
      if (self.components.size >= COMPONENT_LIMITS.definitionsPerSite) {
        return { ok: false, message: `A site has at most ${COMPONENT_LIMITS.definitionsPerSite} components.` };
      }
      const taken = nameRefusal(name);
      if (taken) return { ok: false, message: taken };
      const nodes = nodeIds.map(id => page.findComponent(id));
      if (nodes.length === 0 || nodes.some(node => !node)) return { ok: false, message: 'Select the elements to make a component from.' };
      const selected = nodes as ComponentInstance[];
      const parent = parentOf(page, selected[0]);
      if (!parent || selected.some(node => !parent.children.includes(node))) {
        return { ok: false, message: 'Select elements next to each other on the page. The page itself cannot become a component.' };
      }
      const inOrder = (parent.children as ComponentInstance[]).filter(child => nodeIds.includes(child.id));
      if (inOrder.some(node => nodesInclude(node, n => isStickyCta(n.props)))) {
        return { ok: false, message: 'A sticky bar is one per page, so a component cannot hold it.' };
      }

      const frames = defaultViewportSnapshots();
      const from = extractBreakpoints(getSnapshot(page.canvasNodes));
      const to = extractBreakpoints(frames);
      const toDefinition = (snapshot: StoredNode): StoredNode => ({
        ...snapshot,
        props: mapNodeProps(snapshot.props ?? {}, from, to),
        children: (snapshot.children ?? []).map(toDefinition),
      });
      const stored = inOrder.map(node => toDefinition(getSnapshot(node) as unknown as StoredNode));
      const needsWrapper = stored.length > 1 || stored[0].type.startsWith('#');
      const wrapperId = `root-${uuidv4()}`;
      const tree: StoredNode = needsWrapper
        ? { id: wrapperId, type: 'div', componentType: 'host', label: name, props: {}, children: stored.map(node => ({ ...node, parentId: wrapperId })) }
        : { ...stored[0], parentId: undefined };

      const definitionId = uuidv4();
      // The same checks a placement meets, run on the site as it would be after this,
      // before anything changes: the new root may not suit the parent it lands in, and
      // on a definition page the new level may push a chain past the nesting limit.
      const next = {
        ...definitionsOf(self),
        [definitionId]: { id: definitionId, name, page: { appComponentTree: tree }, inputs: [], states: [] },
      } as unknown as ComponentDefinitions;
      const holder = Array.from(self.components.values()).find(definition => definition.page === page)?.id;
      const ancestorTags: string[] = [];
      for (let up: ComponentInstance | undefined = parent; up; up = up.parentId ? page.findComponent(up.parentId) : undefined) {
        ancestorTags.push(up.type);
      }
      const placementRefused = placementRefusal(next, holder, definitionId) ?? contentModelRefusal(next, definitionId, ancestorTags);
      if (placementRefused) return { ok: false, message: placementRefused };
      const index = parent.children.findIndex((child: ComponentInstance) => child.id === inOrder[0].id);
      for (const node of inOrder) parent.removeChild(node.id);
      self.components.set(definitionId, {
        id: definitionId,
        name,
        page: {
          id: `page-${definitionId}`,
          metadata: { title: name },
          appComponentTree: tree as unknown as ComponentSnapshotIn,
          canvasNodes: frames,
        },
        inputs: [],
        states: [],
      });
      // No label of its own: Layers shows the definition's name, which a rename changes.
      const placement = createIntrinsicComponent(`component-${uuidv4()}`, PLACEMENT_TYPE as never, { component: definitionId });
      parent.addChild(placement, index);
      self.metadata.updatedAt = new Date();
      return { ok: true, definitionId, placement };
    },

    placeComponent(pageId: string, definitionId: string, target: InsertTarget): ComponentActionResult<{ placement: ComponentInstance }> {
      const page = pageById(pageId);
      if (!page) return { ok: false, message: 'This page no longer exists.' };
      const definition = self.components.get(definitionId);
      if (!definition) return { ok: false, message: 'That component no longer exists.' };
      const refusal = page.placementRefusal(definitionId, target);
      if (refusal) return { ok: false, message: refusal };
      const placement = page.insertPlacement(definitionId, target);
      if (!placement) return { ok: false, message: 'The component could not be placed there.' };
      self.metadata.updatedAt = new Date();
      return { ok: true, placement };
    },

    renameDefinition(definitionId: string, rawName: string): ComponentActionResult {
      const name = rawName.trim();
      const definition = self.components.get(definitionId);
      if (!definition) return { ok: false, message: 'That component no longer exists.' };
      const taken = nameRefusal(name, definitionId);
      if (taken) return { ok: false, message: taken };
      definition.setName(name);
      self.metadata.updatedAt = new Date();
      return { ok: true };
    },

    addInput(definitionId: string, input: InputDefinition): ComponentActionResult {
      const definition = self.components.get(definitionId);
      if (!definition) return { ok: false, message: 'That component no longer exists.' };
      if (definition.inputs.length >= COMPONENT_LIMITS.inputsPerDefinition) {
        return { ok: false, message: `A component has at most ${COMPONENT_LIMITS.inputsPerDefinition} inputs.` };
      }
      const refusal = inputDefinitionRefusal(input);
      if (refusal) return { ok: false, message: refusal };
      if (definition.inputs.some(other => other.id === input.id)) return { ok: false, message: 'This component already has that input.' };
      definition.setInputs([...definition.inputs, input]);
      self.metadata.updatedAt = new Date();
      return { ok: true };
    },

    // The value and every binding to it go, across all pages and definitions, in one
    // step. A kept value would mean nothing and come back wrong if the id returned.
    removeInput(definitionId: string, inputId: string): ComponentActionResult {
      const definition = self.components.get(definitionId);
      if (!definition) return { ok: false, message: 'That component no longer exists.' };
      if (!definition.inputs.some(input => input.id === inputId)) return { ok: false, message: 'That input no longer exists.' };
      for (const node of nodesOfPage(definition.page as PageModelType)) {
        for (const [slot, entry] of Object.entries(node.bindings)) {
          if (boundInputId(entry as { mode?: string; expression?: string }) === inputId) node.clearBinding(slot);
        }
      }
      for (const { node } of placementsOf(definitionId)) inputWithout(node, inputId);
      definition.setInputs(definition.inputs.filter(input => input.id !== inputId));
      self.metadata.updatedAt = new Date();
      return { ok: true };
    },

    // Values that pass the new type stay and the rest go, in one step. A binding the
    // new type may not hold goes too: rendering would refuse it. The dialog first
    // shows `inputTypeChangeLoss`.
    changeInputType(definitionId: string, next: InputDefinition): ComponentActionResult {
      const definition = self.components.get(definitionId);
      if (!definition) return { ok: false, message: 'That component no longer exists.' };
      if (!definition.inputs.some(input => input.id === next.id)) return { ok: false, message: 'That input no longer exists.' };
      const refusal = inputDefinitionRefusal(next);
      if (refusal) return { ok: false, message: refusal };
      for (const { node } of placementsOf(definitionId)) {
        const value = (node.props as Partial<PlacementProps>).inputs?.[next.id];
        if (value !== undefined && !parseInputValue(next, value).ok) inputWithout(node, next.id);
      }
      for (const node of nodesOfPage(definition.page as PageModelType)) {
        for (const [slot, entry] of Object.entries(node.bindings)) {
          const reads = boundInputId(entry as { mode?: string; expression?: string }) === next.id;
          if (reads && !mayBindToSlot(next.type, slot)) node.clearBinding(slot);
        }
      }
      definition.setInputs(definition.inputs.map(input => (input.id === next.id ? next : input)));
      self.metadata.updatedAt = new Date();
      return { ok: true };
    },

    addState(definitionId: string, state: StateDefinition): ComponentActionResult {
      const definition = self.components.get(definitionId);
      if (!definition) return { ok: false, message: 'That component no longer exists.' };
      if (definition.states.length >= COMPONENT_LIMITS.statesPerDefinition) {
        return { ok: false, message: `A component has at most ${COMPONENT_LIMITS.statesPerDefinition} states.` };
      }
      const refusal = stateRefusal(state);
      if (refusal) return { ok: false, message: refusal };
      if (definition.states.some(other => other.id === state.id)) return { ok: false, message: 'This component already has that state.' };
      definition.setStates([...definition.states, state]);
      self.metadata.updatedAt = new Date();
      return { ok: true };
    },

    // The state, its rules, `noScriptState`, and the placements starting on it. The
    // `choice` state and triggers compiled from states arrive with custom states,
    // which extend this.
    removeState(definitionId: string, stateId: string): ComponentActionResult {
      const definition = self.components.get(definitionId);
      if (!definition) return { ok: false, message: 'That component no longer exists.' };
      if (!definition.states.some(state => state.id === stateId)) return { ok: false, message: 'That state no longer exists.' };
      for (const node of nodesOfPage(definition.page as PageModelType)) {
        const rules = (node.props as { rules?: unknown }).rules;
        if (!Array.isArray(rules)) continue;
        for (const rule of rules as { id: string; componentState?: string }[]) {
          if (rule.componentState === stateId) node.removeRule(rule.id);
        }
      }
      for (const { node } of placementsOf(definitionId)) {
        if ((node.props as Partial<PlacementProps>).state === stateId) node.setProps({ state: undefined });
      }
      definition.setStates(
        definition.states
          .filter(state => state.id !== stateId)
          .map(state => (state.implies?.includes(stateId) ? { ...state, implies: state.implies.filter(id => id !== stateId) } : state)),
      );
      if (definition.noScriptState === stateId) definition.setNoScriptState(undefined);
      self.metadata.updatedAt = new Date();
      return { ok: true };
    },

    detachPlacement(pageId: string, placementId: string): ComponentActionResult<{ root?: ComponentInstance }> {
      const page = pageById(pageId);
      const node = page?.findComponent(placementId);
      if (!page || !node || !isPlacementType(node.type)) return { ok: false, message: 'That component is no longer here.' };
      const result = detachNode(page, node);
      if (result.ok) self.metadata.updatedAt = new Date();
      return result;
    },

    // Every placement becomes a plain copy, across all pages and definitions, so
    // pages look the same. Nothing changes when any of them cannot.
    deleteDefinition(definitionId: string): ComponentActionResult {
      const definition = self.components.get(definitionId);
      if (!definition) return { ok: false, message: 'That component no longer exists.' };
      const refusal = detachRefusal(definitionsOf(self)[definitionId]);
      if (refusal) return { ok: false, message: refusal };
      for (const { page, node } of placementsOf(definitionId)) detachNode(page, node);
      self.components.delete(definitionId);
      self.metadata.updatedAt = new Date();
      return { ok: true };
    },

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
      // Expanded with literal inputs, or a form inside a component, or an Unsplash
      // address passed to one, would go unmentioned in the privacy page.
      const definitions = definitionsOf(self);
      const trees = pages.map(p => literalPageTree(getSnapshot(p), definitions).root as Parameters<typeof factsFromTrees>[0] extends Iterable<infer T> ? T : never);
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
    // to the same nav. Pages without a footer are counted, not changed. A footer
    // inside a reusable component is the page's footer too: the links go to the
    // definition, once, and every page placing it counts as updated. A definition
    // holding a footer that no page places yet gets them as well, so placing it
    // later needs nothing more.
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

      // True when the footer gained at least one link.
      const addLinks = (footer: ComponentInstance): boolean => {
        const hrefs = new Set(
          findByType(footer, 'a')
            .map((a: ComponentInstance) => (a.props as Record<string, unknown>).href)
            .filter((h): h is string => typeof h === 'string'),
        );
        const missing = links.filter(l => !hrefs.has(l.href));
        if (missing.length === 0) return false;
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
        return true;
      };
      // One footer, however many pages place it.
      const gained = new Map<ComponentInstance, boolean>();
      const addOnce = (footer: ComponentInstance): boolean => {
        const known = gained.get(footer);
        if (known !== undefined) return known;
        const added = addLinks(footer);
        gained.set(footer, added);
        return added;
      };

      const result: LegalLinksResult = { pagesUpdated: 0, pagesWithoutFooter: 0 };
      const reached = new Set<string>();
      for (const page of pages) {
        const root = page.appComponentTree as unknown as ComponentInstance;
        const footers = findFooters(root, self.components, reached);
        const footer = footers[footers.length - 1];
        if (!footer) {
          if (!page.metadata.legalTemplate) result.pagesWithoutFooter++;
          continue;
        }
        if (addOnce(footer)) result.pagesUpdated++;
      }
      let changed = result.pagesUpdated > 0;
      for (const definition of self.components.values()) {
        if (reached.has(definition.id)) continue;
        const footers = findFooters(definition.page.appComponentTree as ComponentInstance, self.components, new Set());
        const footer = footers[footers.length - 1];
        if (footer && addOnce(footer)) changed = true;
      }
      if (changed) self.metadata.updatedAt = new Date();
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
    //
    // The theme and the site's head items are not this dialog's: it edits a draft
    // of the whole object, so a dialog opened before a token edit and saved after
    // it would put the old theme back. Their current values are always kept, and
    // only updateTheme (and updateSiteHead, slice H1) write them.
    updateSiteSettings(input: SiteSettingsInput): SiteSettingsResult {
      const kept = normalizeSiteSettings(self.siteSettings);
      const next: SiteSettings = { ...normalizeSiteSettings(input), theme: kept.theme, head: kept.head };
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

    // The site's theme (src/lib/site/theme.ts), replaced as a whole in ONE action,
    // so a token edit, a rename, a delete or a Clean up is one undo step. Refused
    // whole, with nothing changed, when validateThemeWrite finds a problem: a cap
    // passed, a name taken, a value outside the grammar, a live token removed
    // outright, or a document value that is not a live token of its kind.
    updateTheme(input: SiteTheme): ThemeResult {
      const settings = normalizeSiteSettings(self.siteSettings);
      const next = normalizeTheme(input);
      const errors = validateThemeWrite(next, settings.theme);
      if (errors.length > 0) return { ok: false, errors };
      if (JSON.stringify(settings.theme) === JSON.stringify(next)) return { ok: true };
      self.siteSettings = { ...settings, theme: next };
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
    // too, in reusable components as well: a definition's links, its `link` input
    // defaults, and the `link` values placements pass. On a published site the server additionally records the old path
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
      // A page with a dynamic segment (`products/:handle`) needs its value
      // from the address; at the root there is none, so it would render
      // empty. Such a page cannot be the home page.
      if (page.slug.split('/').some(isDynamicSegment)) {
        return { ok: false, message: 'A page that shows a different item for each address cannot be the home page.' };
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
        const retargetLinkValue = (type: string, value: unknown): string | undefined =>
          type === 'link' && typeof value === 'string' ? retarget(value) : undefined;
        const retargetPlacement = (node: ComponentInstance) => {
          const { component, inputs } = node.props as Partial<PlacementProps>;
          const definition = typeof component === 'string' ? self.components.get(component) : undefined;
          if (!definition || !inputs) return;
          const retargeted = definition.inputs.flatMap(({ id, type }) => {
            const next = retargetLinkValue(type, inputs[id]);
            return next === undefined ? [] : [[id, next] as const];
          });
          if (retargeted.length > 0) node.setProps({ inputs: { ...inputs, ...Object.fromEntries(retargeted) } });
        };
        const visit = (node: ComponentInstance) => {
          const href = (node.props as Record<string, unknown>).href;
          if (typeof href === 'string') {
            const next = retarget(href);
            if (next !== undefined) node.setProps({ href: next });
          }
          if (isPlacementType(node.type)) retargetPlacement(node);
          node.children.forEach((c: ComponentInstance) => visit(c));
        };
        for (const p of self.pages.values()) visit(p.appComponentTree as unknown as ComponentInstance);
        for (const definition of self.components.values()) {
          visit(definition.page.appComponentTree as ComponentInstance);
          if (definition.inputs.some(({ type, default: stored }) => retargetLinkValue(type, stored) !== undefined)) {
            definition.setInputs(definition.inputs.map(input => {
              const next = retargetLinkValue(input.type, input.default);
              return next === undefined ? input : { ...input, default: next };
            }));
          }
        }
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

    // The reusable components as plain data, for expansion.
    get definitions(): ComponentDefinitions {
      return definitionsOf(self);
    },

    // The page with this id, among the pages or inside a definition.
    findPageById(pageId: string): PageModelType | undefined {
      const page = self.pages.get(pageId);
      if (page) return page;
      return Array.from(self.components.values()).find(definition => definition.page.id === pageId)?.page as PageModelType | undefined;
    },

    // What a person calls this page: a definition's own name, or the page's title.
    pageName(pageId: string): string | undefined {
      const definition = Array.from(self.components.values()).find(candidate => candidate.page.id === pageId);
      return definition?.name ?? self.pages.get(pageId)?.metadata.title;
    },

    placementCount(definitionId: string): number {
      let count = 0;
      for (const page of [...self.pages.values(), ...Array.from(self.components.values(), d => d.page as PageModelType)]) {
        count += nodesOfPage(page).filter(node => isPlacementType(node.type) && (node.props as Partial<PlacementProps>).component === definitionId).length;
      }
      return count;
    },

    // How many placements would lose their value to changeInputType.
    inputTypeChangeLoss(definitionId: string, next: InputDefinition): number {
      let lost = 0;
      for (const page of [...self.pages.values(), ...Array.from(self.components.values(), d => d.page as PageModelType)]) {
        for (const node of nodesOfPage(page)) {
          const { component, inputs } = node.props as Partial<PlacementProps>;
          const value = isPlacementType(node.type) && component === definitionId ? inputs?.[next.id] : undefined;
          if (value !== undefined && !parseInputValue(next, value).ok) lost++;
        }
      }
      return lost;
    },

    // True when the page's slug cannot change: it is the project's only home
    // page (see isSlugLocked in the actions above).
    isSlugLocked(pageId: string): boolean {
      const page = self.pages.get(pageId);
      return !!page && page.slug === '' && homePageCount(self.pages.values()) <= 1;
    },

    // True when setHomePage(pageId) would accept the page: it exists, is not
    // already THE home page, and its slug has no dynamic segment. The menus,
    // Page settings and the chooser offer the action only for such pages.
    canBecomeHomePage(pageId: string): boolean {
      const page = self.pages.get(pageId);
      if (!page) return false;
      if (page.slug === '' && homePageCount(self.pages.values()) <= 1) return false;
      return !page.slug.split('/').some(isDynamicSegment);
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

    // Where the product page lives (`/products` for `products/:handle`), the base of `{{product.href}}`
    get productPagePath(): string | null {
      return productPagePath(Array.from(self.pages.values(), page => page.slug));
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
