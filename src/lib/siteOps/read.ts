// src/lib/siteOps/read.ts
//
// What the read operations show of a project, kept short for an agent's context:
//
//   - siteOverview: pages (id, title, slug, breakpoints), the theme's live tokens,
//     the reusable components and the site's version.
//   - pageOutline: one page as a flat list in document order, each node with its
//     id, parent, depth, tag, label, a text excerpt, its own styles with the
//     responsive maps keyed by breakpoint key ("desktop", "mobile"), and its rule
//     selectors. A size budget pages a big page: the answer carries a cursor for
//     the next part.
//   - vocabularyFor: the generation format (buildSchemaDocs) plus the parts that
//     depend on the site (breakpoint keys per page, theme tokens, components) and
//     the operations themselves.
//
// Pure; client-safe.

import { getSnapshot } from 'mobx-state-tree';
import type { ProjectModelType } from '@/models/ProjectModel';
import type { PageModelType } from '@/models/PageModel';
import type { ComponentInstance } from '@/models/ComponentModel';
import { buildSchemaDocs } from '@/lib/ai/pageGen/schemaDocs';
import { tokenReference, type ThemeToken } from '@/lib/site/theme';
import { storedRulesOf, isDefinitionRule } from '@/lib/rules/rules';
import { keyedBreakpoints, rekeyResponsive } from './breakpoints';
import { isPlacementType, type PlacementProps } from '@/lib/components/placement';
import { parseInputValue, type InputDefinition } from '@/lib/components/inputs';
import type { ComponentDefinitionInstance } from '@/models/ComponentDefinitionModel';
import { MAX_BATCH_OPS } from './types';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export interface PageSummary {
  id: string;
  title: string;
  slug: string;
  isHome: boolean;
  /** Breakpoint keys, largest first; the first one writes the base value. */
  breakpoints: Array<{ key: string; label: string; minWidth: number }>;
  nodeCount: number;
}

export interface SiteOverview {
  siteId: string;
  name: string;
  version: number;
  pages: PageSummary[];
  theme: {
    mode?: string;
    tokens: Array<{ id: string; name: string; kind: string; reference: string; light?: string; dark?: string; family?: string }>;
    document: Record<string, string>;
  };
  components: ComponentOverview[];
  notFoundPageId: string | null;
}

/** One reusable component as an agent reads it. */
export interface ComponentOverview {
  id: string;
  name: string;
  description?: string;
  /** The definition's own page: getPage reads it, and node ids on it are the definition's. */
  pageId: string;
  /** What each placement may set, whole; a default per breakpoint is keyed by the definition page's keys. */
  inputs: InputDefinition[];
  states: Array<{ id: string; name: string; kind: string }>;
  /** How many placements use it, on every page and inside other components. */
  placements: number;
}

function breakpointKeysOf(page: PageModelType): Map<string, string> {
  return new Map(keyedBreakpoints(page).map((b) => [b.id, b.key] as const));
}

function placementCounts(project: ProjectModelType): Map<string, number> {
  const counts = new Map<string, number>();
  const walk = (node: ComponentInstance) => {
    if (isPlacementType(node.type)) {
      const id = (node.props as Partial<PlacementProps>).component;
      if (typeof id === 'string') counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const child of node.children as ComponentInstance[]) walk(child);
  };
  const pages = [...(Array.from(project.pages.values()) as PageModelType[]), ...Array.from(project.components.values(), (d) => d.page as PageModelType)];
  for (const page of pages) {
    walk(page.appComponentTree as ComponentInstance);
    for (const floating of page.canvasNodes.values() as Iterable<ComponentInstance>) if (!floating.isViewportNode) walk(floating);
  }
  return counts;
}

function componentOverview(definition: ComponentDefinitionInstance, placements: number): ComponentOverview {
  const page = definition.page as PageModelType;
  const keys = breakpointKeysOf(page);
  return {
    id: definition.id as string,
    name: definition.name,
    ...(definition.description ? { description: definition.description } : {}),
    pageId: page.id,
    inputs: (definition.inputs ?? []).map((input) => (input.default === undefined ? input : { ...input, default: rekeyResponsive(input.default, keys) })),
    states: (definition.states ?? []).map(({ id, name, kind }) => ({ id, name, kind })),
    placements,
  };
}

function countNodes(node: ComponentInstance): number {
  return 1 + (node.children as ComponentInstance[]).reduce((n, c) => n + countNodes(c), 0);
}

function liveTokens(tokens: readonly ThemeToken[]): SiteOverview['theme']['tokens'] {
  return tokens
    .filter((t) => !t.deleted)
    .map((t) =>
      t.kind === 'color'
        ? { id: t.id, name: t.name, kind: t.kind, reference: tokenReference(t.id), light: t.light, ...(t.dark ? { dark: t.dark } : {}) }
        : { id: t.id, name: t.name, kind: t.kind, reference: tokenReference(t.id), family: t.family },
    );
}

export function siteOverview(project: ProjectModelType, version: number, name?: string): SiteOverview {
  const site = project.site;
  const pages = (Array.from(project.pages.values()) as PageModelType[]).map((page) => ({
    id: page.id,
    title: page.metadata.title,
    slug: page.slug,
    isHome: page.slug === '',
    breakpoints: keyedBreakpoints(page).map(({ key, label, minWidth }) => ({ key, label, minWidth })),
    nodeCount: countNodes(page.appComponentTree as ComponentInstance),
  }));
  pages.sort((a, b) => Number(b.isHome) - Number(a.isHome) || a.slug.localeCompare(b.slug));
  return {
    siteId: project.id,
    name: name ?? project.metadata.title,
    version,
    pages,
    theme: {
      ...(site.theme.mode ? { mode: site.theme.mode } : {}),
      tokens: liveTokens(site.theme.tokens),
      document: { ...site.theme.document } as Record<string, string>,
    },
    components: (() => {
      const counts = placementCounts(project);
      return Array.from(project.components.values(), (definition) => componentOverview(definition, counts.get(definition.id as string) ?? 0));
    })(),
    notFoundPageId: site.notFoundPageId || null,
  };
}

// ---------- the page outline ----------

/** Characters of text and of one style value an outline shows. */
const TEXT_EXCERPT = 120;
const VALUE_EXCERPT = 120;
/** The default and the largest answer size, in characters of JSON. */
export const OUTLINE_DEFAULT_CHARS = 24_000;
export const OUTLINE_MAX_CHARS = 80_000;

export interface OutlineNode {
  id: string;
  parentId: string | null;
  depth: number;
  tag: string;
  label?: string;
  /** The node's own text, cut to an excerpt. */
  text?: string;
  /** Own styles; a responsive value is a map of breakpoint key (or `base`) to value. */
  style?: Record<string, unknown>;
  /** Selector rules on the node (`&:hover`, `& > li`) and global definitions. */
  rules?: string[];
  /** Attributes other than style, text, rules and the photo credit, as short values. */
  props?: Record<string, unknown>;
  /** On a component placement: which component, and the value of each input here. */
  component?: PlacementOutline;
  childCount: number;
}

/**
 * Where an input's value on a placement comes from: its own value, the component's
 * default, data (`bound`, the expression says which), or a stored value the input
 * refuses (`refused`: the default shows instead).
 */
export type InputValueSource = 'own' | 'default' | 'bound' | 'refused';

export interface PlacementInputValue {
  id: string;
  name: string;
  type: string;
  source: InputValueSource;
  /** The value that shows (not for a bound one, whose value is only known from data). Per breakpoint keyed by key. Never cut. */
  value?: unknown;
  expression?: string;
  reason?: string;
}

export interface PlacementOutline {
  definitionId: string;
  name?: string;
  /** The definition is gone: the placement shows nothing. */
  missing?: true;
  inputs?: PlacementInputValue[];
}

function placementOutline(
  node: ComponentInstance,
  idToKey: ReadonlyMap<string, string>,
  components: ProjectModelType['components'],
): PlacementOutline {
  const stored = node.props as Partial<PlacementProps>;
  const definitionId = typeof stored.component === 'string' ? stored.component : '';
  const definition = components.get(definitionId) as ComponentDefinitionInstance | undefined;
  if (!definition) return { definitionId, missing: true };
  const defaultKeys = breakpointKeysOf(definition.page as PageModelType);
  const own = (isObj(stored.inputs) ? getPlain(stored.inputs) : {}) as Record<string, unknown>;
  const bindings = (node.bindings ?? {}) as Record<string, { expression?: unknown } | undefined>;
  const inputs = (definition.inputs ?? []).map((input): PlacementInputValue => {
    const base = { id: input.id, name: input.name, type: input.type };
    const fallback = input.default === undefined ? {} : { value: rekeyResponsive(input.default, defaultKeys) };
    const binding = bindings[`input.${input.id}`];
    if (binding) return { ...base, source: 'bound', ...(typeof binding.expression === 'string' ? { expression: binding.expression } : {}) };
    const value = own[input.id];
    if (value === undefined) return { ...base, source: 'default', ...fallback };
    const parsed = parseInputValue(input, value);
    if (!parsed.ok) return { ...base, source: 'refused', reason: parsed.reason, ...fallback };
    return { ...base, source: 'own', value: rekeyResponsive(value, idToKey) };
  });
  return { definitionId, name: definition.name, inputs };
}

export interface PageOutline {
  pageId: string;
  title: string;
  slug: string;
  breakpoints: string[];
  total: number;
  nodes: OutlineNode[];
  /** Pass as `cursor` for the next part; null when this was the last. */
  nextCursor: string | null;
}

const OWN_PROPS = new Set(['style', 'children', 'rules']);

function excerpt(value: unknown, max: number): unknown {
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}...` : value;
  if (isObj(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = excerpt(v, max);
    return out;
  }
  return value;
}

function outlineNode(
  node: ComponentInstance,
  parentId: string | null,
  depth: number,
  idToKey: Map<string, string>,
  components?: ProjectModelType['components'],
): OutlineNode {
  const placement = isPlacementType(node.type);
  const props = (node.props ?? {}) as Record<string, unknown>;
  const out: OutlineNode = { id: node.id, parentId, depth, tag: node.type, childCount: node.children.length };
  if (node.label) out.label = node.label as string;
  if (typeof props.children === 'string' || typeof props.children === 'number') out.text = excerpt(String(props.children), TEXT_EXCERPT) as string;
  if (isObj(props.style) && Object.keys(props.style).length > 0) {
    const style: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props.style)) style[k] = excerpt(rekeyResponsive(v, idToKey), VALUE_EXCERPT);
    out.style = style;
  }
  const rules = storedRulesOf(props);
  if (rules.length > 0) out.rules = rules.map((r) => (isDefinitionRule(r) ? r.define : [...(r.at ?? []), r.selector].join(' ')));
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (OWN_PROPS.has(k) || k.startsWith('data-credit')) continue;
    // A placement's values are under `component`, whole and keyed by breakpoint key.
    if (placement && k === 'inputs') continue;
    rest[k] = excerpt(isObj(v) ? getPlain(v) : v, VALUE_EXCERPT);
  }
  if (Object.keys(rest).length > 0) out.props = rest;
  // Only with the site's components at hand: without them nothing is known of the definition.
  if (placement && components) out.component = placementOutline(node, idToKey, components);
  return out;
}

/** A frozen MST value as plain data. */
function getPlain(value: Record<string, unknown>): unknown {
  try {
    return getSnapshot(value as never);
  } catch {
    return value;
  }
}

/**
 * The page in document order from `cursor` (a node id from an earlier answer's
 * nextCursor) on, as many nodes as fit `maxChars`. Throws on a cursor that names
 * no node of the page, so a caller is never silently sent back to the start.
 */
export function pageOutline(
  page: PageModelType,
  options: { cursor?: string; maxChars?: number; components?: ProjectModelType['components'] } = {},
): PageOutline {
  const breakpoints = keyedBreakpoints(page);
  const idToKey = new Map(breakpoints.map((b) => [b.id, b.key] as const));
  const flat: Array<{ node: ComponentInstance; parentId: string | null; depth: number }> = [];
  const walk = (node: ComponentInstance, parentId: string | null, depth: number) => {
    flat.push({ node, parentId, depth });
    for (const child of node.children as ComponentInstance[]) walk(child, node.id, depth + 1);
  };
  walk(page.appComponentTree as ComponentInstance, null, 0);

  let start = 0;
  if (options.cursor) {
    start = flat.findIndex((entry) => entry.node.id === options.cursor);
    if (start < 0) throw new Error(`the cursor ${JSON.stringify(options.cursor)} names no node of this page`);
  }
  const budget = Math.min(Math.max(options.maxChars ?? OUTLINE_DEFAULT_CHARS, 2_000), OUTLINE_MAX_CHARS);
  const nodes: OutlineNode[] = [];
  let used = 0;
  let index = start;
  for (; index < flat.length; index++) {
    const { node, parentId, depth } = flat[index];
    const entry = outlineNode(node, parentId, depth, idToKey, options.components);
    const size = JSON.stringify(entry).length + 1;
    // Always at least one node, so a single huge node still moves the cursor on.
    if (nodes.length > 0 && used + size > budget) break;
    nodes.push(entry);
    used += size;
  }
  return {
    pageId: page.id,
    title: page.metadata.title,
    slug: page.slug,
    breakpoints: breakpoints.map((b) => b.key),
    total: flat.length,
    nodes,
    nextCursor: index < flat.length ? flat[index].node.id : null,
  };
}

// ---------- the vocabulary ----------

/** How the operations are written, for describeVocabulary. */
export const OPERATIONS_DOCS = `# Site operations

A write is one batch: { siteId, expectedVersion, ops: [...] } with at most ${MAX_BATCH_OPS} operations, applied in
order and all or nothing. expectedVersion is the version getSite or the last write returned; a newer stored
version refuses the batch with site_changed and the current version (read again, then retry). A refused batch
writes nothing and lists each refused operation with its index and the reason. Nothing is ever dropped
silently: a value the editor would not keep refuses its operation.

Ids: every node and page id comes from getSite / getPage. A node or page a batch creates may carry "ref": "name";
later operations of the same batch name it as "ref:name", and the answer maps every ref to its new id.

Breakpoints: a responsive value is a map of breakpoint key to value ({"desktop": "64px", "mobile": "24px"}); the
largest breakpoint (first in getSite) writes the base value, a smaller one only its override. "base" is every
breakpoint without its own value.

Operations:
- {op:"createPage", title, slug?, description?, ref?}
- {op:"updatePageSettings", pageId, title?, slug?, description?, ogImage?, noIndex?, notFoundPage?}
- {op:"deletePage", pageId}: deletes a page of the draft (never the home page or the last page); pageId may be
  "ref:name". The answer counts the links on the site that still lead to it. The published site keeps it until the
  next publish.
- {op:"insertNodes", pageId, parentId?, index?, nodes:[...]}: nodes in the generation format below, each with an
  optional ref. parentId defaults to the page root; index defaults to the end. An imageQuery on an img or a
  container places a credited stock photo.
- {op:"updateStyle", nodeId, property, value, breakpoint?, state?}: value null removes it; state is hover, focused
  or pressed.
- {op:"updateText", nodeId, text}: plain text only, on a node that holds text.
- {op:"setProps", nodeId, props:{name: value or null}}: attributes (href, alt, src, aria-*); not style, children,
  rules or behaviour. An Unsplash src needs its data-credit-* attributes in the same call (findImages gives them).
- {op:"setFxScene", nodeId, fx}: replaces the scene of an FX scene box (a div with data-fx "scene"; insertNodes
  places one with preset "fxScene"). fx is the form the generation format describes under "FX scene"
  ({preset, start?, calm?, background?, layers?}), or a whole stored scene {version:1, scene, start, calm}. Refused,
  with the reason, when anything would be left out or changed: an unknown preset, layer or setting, a value out of
  its range, a text layer left with sample text, a picture address that is not one of this site's uploads. The
  box's own background is a style (updateStyle). getPage shows the stored scene of such a box under props.fx:
  change it and send it back whole to retune a scene that is no preset any more.
- {op:"moveNode", nodeId, to:{parentId, index?} or {siblingId, position:"before"|"after"}}
- {op:"removeNode", nodeId}
- {op:"addRule", nodeId, rule:{selector:"& > li", at?:["@media (...)"], style:{...}}}
- {op:"setTheme", theme:{mode?, tokens:[...], document:{backgroundColor?, color?, fontFamily?}}}: the whole theme;
  a style refers to a token as var(--fc-t-<id>).
- {op:"placeComponent", pageId, definitionId, to?, inputs?, ref?}: places one of the components getSite lists, at the
  end of the page root unless "to" ({parentId, index?} or {siblingId, position}) says where. inputs gives the
  placement values of its own, by input id ({"title": "Opening hours"}); every input left out shows its default.
- {op:"setComponentInputs", nodeId, values:{inputId: value or null}}: sets values of one placement; null goes back to
  the component's default.

Components: getSite lists each reusable component with its inputs (id, name, type, default, and options, limits or
list fields where the type has them) and how many placements use it. A placement is a "#component" node: its content
and style live in the component, so updateStyle, setProps and children do not apply to it; what differs per
placement is its input values. getPage shows on each placement "component": {definitionId, name, inputs:[{id, name,
type, source, value}]}, where source is "own" (its own value), "default", "bound" (the value comes from data, the
expression says which; a value set here would never show, so it is refused) or "refused" (a stored value the input
refuses; the default shows). A value is checked against its input's type, as in the editor: text a string, number a
finite number within its limits (stored as given, the unit added when it renders), toggle true or false, color a CSS
colour or a map of breakpoint key to colour, image an address or {src, alt} (https, http or a site path; not an
Unsplash photo, whose credit a placement cannot keep), link and file a safe address, choice one of its option values,
richtext a string or {runs:[{text, marks?, href?}]}, date an ISO 8601 date, border, shadow and transition a CSS value,
cursor a cursor keyword, list an array of items keyed by field id, gallery an array of images. An event input holds no
value. An unknown input id, or a value its input refuses, refuses the operation with the reason.

Making and changing components. A component's own page (pageId in getSite) reads with getPage, and its nodes are edited
with the usual operations (insertNodes with that pageId, updateStyle, updateText...): every page using the component
changes with it, and an edit a use cannot take refuses the batch.
- {op:"createComponent", pageId, nodeIds:[...], name, ref?, placementRef?}: makes a component from nodes next to each
  other under one parent (several get a wrapping div); a placement takes their place, and the nodes keep their ids
  inside the component. ref names the component, placementRef the placement, for later operations of the batch.
- {op:"renameComponent", definitionId, name}: names are unique on the site.
- {op:"addComponentInput", definitionId, input:{id?, name, type, default?, options?, min?, max?, step?, unit?,
  maxLength?, multiline?, fields?, description?, group?}, connect?:{nodeId, slot}}: adds an input (the id comes from
  the name when absent). With connect, a field of a node inside the component reads it, as the editor's Make input:
  slot is children (its text), href, src, alt, visible, style.<property>, or input.<id> on a component placed inside
  it. The default is then the field's current value unless one is given. An address (href, src) takes only an image,
  link or file input; a field already connected is refused.
- {op:"renameComponentInput", definitionId, inputId, name}: the id, values and connections stay.
- {op:"removeComponentInput", definitionId, inputId}: removes it with every connection inside the component and every
  placement's value of it on every page; the answer counts them.
- {op:"setComponentInputDefault", definitionId, inputId, default}: what every placement without its own value shows;
  null removes the default (a connected field then shows the value stored in the component). A colour default per
  breakpoint is keyed by the component page's breakpoint keys.

Workflow: describeVocabulary once, getSite, getPage for the page you edit, then small batches; previewUrl to look at
the result; publish when it is right.`;

export interface Vocabulary {
  operations: string;
  generationFormat: string;
  site?: Pick<SiteOverview, 'pages' | 'theme' | 'components'>;
}

export function vocabularyFor(project?: ProjectModelType, version = 0): Vocabulary {
  const out: Vocabulary = { operations: OPERATIONS_DOCS, generationFormat: buildSchemaDocs() };
  if (project) {
    const { pages, theme, components } = siteOverview(project, version);
    out.site = { pages, theme, components };
  }
  return out;
}
