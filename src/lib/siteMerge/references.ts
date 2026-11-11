// src/lib/siteMerge/references.ts
//
// What a site document points at (docs/plans/2026-11-10-site-branches.md, section 5, rule 10): nodes named
// by a behaviour rule or by an HTML reference (`for`, `aria-*`, an `href="#..."`, ...), pages linked to or
// sent to by a form or named as the 404 page, and component definitions placed on a page.
//
// The merge uses it two ways. A thing removed on one side that the other side newly points at counts as
// changed there, so its removal is asked (rule 6) instead of leaving a dangling reference. And after the
// merge, what still points at nothing, and pointed at something on both sides alone, is reported.
//
// The reference rules themselves are not repeated here: the walks of `remapBehaviourRefs` and
// `withFollowedRefs` (which copy and paste use to make references follow new ids) are run with a map that
// records every id they look up, so a reference kind added there is seen here too.
//
// PURE: client and server safe.

import { remapBehaviourRefs } from '@/lib/behaviour/format';
import { withFollowedRefs } from '@/lib/renderer/idRefs';
import { isPlacementType } from '@/lib/components/placement';
import { countLinksToPage } from '@/lib/siteOps/pageLinks';
import { isPlainObject } from './value';
import type { MergeDocument } from './document';

type Node = Record<string, unknown> & { id?: unknown; props?: unknown; children?: unknown; type?: unknown };

/** A map that answers nothing and records every key it is asked for. */
function recorder(into: Set<string>): ReadonlyMap<string, string> {
  return {
    get(key: string) {
      into.add(key);
      return undefined;
    },
  } as unknown as ReadonlyMap<string, string>;
}

/** Every node of some trees, depth first. */
function* nodes(trees: readonly unknown[]): Generator<Node> {
  const stack = [...trees].reverse();
  let guard = 0;
  while (stack.length > 0 && guard++ < 1_000_000) {
    const node = stack.pop();
    if (!isPlainObject(node)) continue;
    yield node as Node;
    if (Array.isArray(node.children)) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
}

/** The trees of a page body (a page, or a component definition's page). */
export function treesOf(body: unknown): unknown[] {
  if (!isPlainObject(body)) return [];
  const canvas = isPlainObject(body.canvasNodes) ? Object.values(body.canvasNodes) : [];
  return [body.appComponentTree, ...canvas];
}

/** The node ids the trees of one page body point at, by behaviour rules or HTML references to an element `id`. */
export function nodeReferences(trees: readonly unknown[]): Set<string> {
  const behaviourRefs = new Set<string>();
  const htmlRefs = new Set<string>();
  const htmlIdToNode = new Map<string, string>();
  for (const node of nodes(trees)) {
    if (typeof node.id !== 'string') continue;
    const props = isPlainObject(node.props) ? node.props : undefined;
    if (props && typeof props.id === 'string' && props.id !== '') htmlIdToNode.set(props.id, node.id);
    if (props?.behaviour !== undefined) remapBehaviourRefs({ id: node.id, props: { behaviour: props.behaviour } } as never, recorder(behaviourRefs));
    if (props) withFollowedRefs(props, recorder(htmlRefs));
  }
  const out = new Set(behaviourRefs);
  for (const htmlId of htmlRefs) {
    const node = htmlIdToNode.get(htmlId);
    if (node !== undefined) out.add(node);
  }
  return out;
}

/** How many times each component definition is placed in these trees. */
export function placements(trees: readonly unknown[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const node of nodes(trees)) {
    if (!isPlacementType(node.type) || !isPlainObject(node.props) || typeof node.props.component !== 'string') continue;
    out.set(node.props.component, (out.get(node.props.component) ?? 0) + 1);
  }
  return out;
}

/** Every tree of a document: its pages' and its component definitions'. */
export function documentTrees(doc: MergeDocument): unknown[] {
  return [
    ...doc.pages.flatMap((page) => treesOf(page.snapshot)),
    ...Object.values(doc.components ?? {}).flatMap((definition) => treesOf(isPlainObject(definition) ? definition.page : undefined)),
  ];
}

/** How much a document points at one page: links and forms leading there, and the 404 page setting. */
export function pageReferences(doc: MergeDocument, trees: readonly unknown[], page: { pageId: string; slug: string }): number {
  const notFound = isPlainObject(doc.siteSettings) && doc.siteSettings.notFoundPageId === page.pageId ? 1 : 0;
  return countLinksToPage(trees, page) + notFound;
}

/** Something the merged document points at that is not there, though it was on main and on the branch alone. */
export interface DanglingReference {
  /** `link`: links to an address no page holds any more (a page renamed or removed on the other side). */
  kind: 'node' | 'page' | 'component' | 'link';
  /** The node, page or component id; for `link`, the page that held the address. */
  id: string;
  /** For a node: the page or component definition it was in (`page:<id>`, `component:<id>`). */
  container?: string;
  /** For a link: the address the links lead to, and how many there are. */
  slug?: string;
  count?: number;
}

/** An address as pages are compared by it: trimmed, lowercased. */
const addressKey = (slug: string) => slug.trim().toLowerCase();

/**
 * Links in `merged` to an address no page of it holds, that some page held on main, the branch or the base:
 * rule 10's "a link to a slug that the other side renamed is reported too" (the redirect only exists once the
 * site is published). Left out: links that already led nowhere on main or on the branch alone, as many.
 */
function danglingLinks(merged: MergeDocument, main: MergeDocument, branch: MergeDocument, base?: MergeDocument): DanglingReference[] {
  const held = (doc: MergeDocument) => new Set(doc.pages.map((p) => addressKey(p.slug)));
  const now = held(merged);
  const candidates = new Map<string, { pageId: string; slug: string }>();
  for (const doc of [main, branch, ...(base ? [base] : [])]) {
    for (const page of doc.pages) {
      const key = addressKey(page.slug);
      // The home address always resolves, and a dynamic address has no single path.
      if (key === '' || key.includes(':') || now.has(key) || candidates.has(key)) continue;
      candidates.set(key, { pageId: page.pageId, slug: page.slug });
    }
  }
  if (candidates.size === 0) return [];
  const trees = { merged: documentTrees(merged), main: documentTrees(main), branch: documentTrees(branch) };
  const heldOn = { main: held(main), branch: held(branch) };
  const out: DanglingReference[] = [];
  // Only `href` links: a form's thank-you page is named by id and reported as a missing page above, so the
  // count runs with an id no form can hold.
  const byAddress = (t: unknown[], page: { slug: string }) => countLinksToPage(t, { pageId: '\u0000', slug: page.slug });
  for (const [key, page] of candidates) {
    const count = byAddress(trees.merged, page);
    if (count === 0) continue;
    const before = (side: 'main' | 'branch') => (heldOn[side].has(key) ? 0 : byAddress(trees[side], page));
    if (count > Math.max(before('main'), before('branch'))) out.push({ kind: 'link', id: page.pageId, slug: page.slug, count });
  }
  return out.sort((a, b) => (a.slug! < b.slug! ? -1 : a.slug! > b.slug! ? 1 : 0));
}

/**
 * What `merged` points at and does not hold, left out what main or the branch alone already pointed at so.
 * `base` adds the addresses pages had at the fork point to the links looked for.
 */
export function danglingReferences(merged: MergeDocument, main: MergeDocument, branch: MergeDocument, base?: MergeDocument): DanglingReference[] {
  const broken = (doc: MergeDocument): Map<string, DanglingReference> => {
    const out = new Map<string, DanglingReference>();
    const bodies: Array<[string, unknown]> = [
      ...doc.pages.map((page) => [`page:${page.pageId}`, page.snapshot] as [string, unknown]),
      ...Object.entries(doc.components ?? {}).map(([id, d]) => [`component:${id}`, isPlainObject(d) ? d.page : undefined] as [string, unknown]),
    ];
    for (const [container, body] of bodies) {
      const trees = treesOf(body);
      const present = new Set<string>();
      for (const node of nodes(trees)) if (typeof node.id === 'string') present.add(node.id);
      for (const id of nodeReferences(trees)) if (!present.has(id)) out.set(`node|${container}|${id}`, { kind: 'node', id, container });
    }
    const all = documentTrees(doc);
    for (const id of placements(all).keys()) if (!(id in (doc.components ?? {}))) out.set(`component|${id}`, { kind: 'component', id });
    const pageIds = new Set(doc.pages.map((p) => p.pageId));
    const notFound = isPlainObject(doc.siteSettings) ? doc.siteSettings.notFoundPageId : undefined;
    if (typeof notFound === 'string' && notFound !== '' && !pageIds.has(notFound)) out.set(`page|${notFound}`, { kind: 'page', id: notFound });
    for (const node of nodes(all)) {
      const props = isPlainObject(node.props) ? node.props : undefined;
      // As the form settings read it (readFormSettings, src/lib/forms/definition.ts; countLinksToPage).
      const sent = props?.successBehavior === 'redirect' && typeof props.redirectPageId === 'string' ? props.redirectPageId.trim() : '';
      if (sent !== '' && !pageIds.has(sent)) out.set(`page|${sent}`, { kind: 'page', id: sent });
    }
    return out;
  };
  const before = new Set([...broken(main).keys(), ...broken(branch).keys()]);
  return [...[...broken(merged)].filter(([key]) => !before.has(key)).map(([, ref]) => ref), ...danglingLinks(merged, main, branch, base)];
}
