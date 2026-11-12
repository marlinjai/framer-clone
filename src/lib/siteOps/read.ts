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
  components: Array<{ id: string; name: string; inputs: string[]; states: string[] }>;
  notFoundPageId: string | null;
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
    components: Array.from(project.components.values(), (definition) => ({
      id: definition.id as string,
      name: definition.name,
      inputs: (definition.inputs ?? []).map((input) => input.name),
      states: (definition.states ?? []).map((state) => state.name),
    })),
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
  childCount: number;
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

function outlineNode(node: ComponentInstance, parentId: string | null, depth: number, idToKey: Map<string, string>): OutlineNode {
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
    rest[k] = excerpt(isObj(v) ? getPlain(v) : v, VALUE_EXCERPT);
  }
  if (Object.keys(rest).length > 0) out.props = rest;
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
export function pageOutline(page: PageModelType, options: { cursor?: string; maxChars?: number } = {}): PageOutline {
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
    const entry = outlineNode(node, parentId, depth, idToKey);
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
- {op:"placeComponent", pageId, definitionId, to?, ref?}

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
