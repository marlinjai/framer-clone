// src/lib/siteMerge/references.ts
//
// What a site document points at (docs/plans/2026-11-10-site-branches.md, section 5, rule 10): nodes named
// by a behaviour rule or by an HTML reference (`for`, `aria-*`, an `href="#..."`, ...), pages linked to by
// address, sent to by a form or named as the 404 page, and component definitions placed on a page.
//
// The merge asks rule 10 from the result, not by guessing ahead: it merges, looks at what the result points
// at and does not hold (and main or the branch alone did not leave so), asks each such thing's removal as a
// rule 6 conflict, and merges again (`./document.ts`). A reference is one referring node and one target, so a
// second node newly pointing at something already pointed at in the base counts too.
//
// The reference rules themselves are not repeated here: the walks of `remapBehaviourRefs` and
// `withFollowedRefs` (which copy and paste use to make references follow new ids) are run with a map that
// records every id they look up, so a reference kind added there is seen here too. Links use the address
// keys of `src/lib/siteOps/pageLinks.ts`, the code `deletePage` counts links with.
//
// PURE: client and server safe.

import { remapBehaviourRefs } from '@/lib/behaviour/format';
import { withFollowedRefs } from '@/lib/renderer/idRefs';
import { isPlacementType } from '@/lib/components/placement';
import { addressKeyOfSlug, linkKeyOfHref } from '@/lib/siteOps/pageLinks';
import { isPlainObject } from './value';
import type { MergeDocument } from './document';

type Node = Record<string, unknown> & { id?: unknown; props?: unknown; children?: unknown; type?: unknown };

/** More nodes than a 10 MB site can hold: a walk past it is a broken document, refused loudly. */
export const MAX_WALKED_NODES = 2_000_000;

/** A map that answers nothing and records every key it is asked for. */
function recorder(into: Set<string>): ReadonlyMap<string, string> {
  return {
    get(key: string) {
      into.add(key);
      return undefined;
    },
  } as unknown as ReadonlyMap<string, string>;
}

/** Every node of some trees, depth first. Throws past `MAX_WALKED_NODES`. */
export function* walkNodes(trees: readonly unknown[]): Generator<Node> {
  const stack = [...trees].reverse();
  let seen = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isPlainObject(node)) continue;
    if (++seen > MAX_WALKED_NODES) throw new Error(`a site document with more than ${MAX_WALKED_NODES} nodes`);
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

/** Every page body of a document with its container key (`page:<id>`, `component:<id>`). */
export function documentBodies(doc: MergeDocument): Array<[string, unknown]> {
  return [
    ...doc.pages.map((page) => [`page:${page.pageId}`, page.snapshot] as [string, unknown]),
    ...Object.entries(doc.components ?? {}).map(([id, d]) => [`component:${id}`, isPlainObject(d) ? d.page : undefined] as [string, unknown]),
  ];
}

/** HTML element ids to the node carrying each, in the trees of one page body. */
export function htmlIdsOf(trees: readonly unknown[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of walkNodes(trees)) {
    const props = isPlainObject(node.props) ? node.props : undefined;
    if (typeof node.id === 'string' && props && typeof props.id === 'string' && props.id !== '' && !out.has(props.id)) out.set(props.id, node.id);
  }
  return out;
}

/**
 * Each node reference in the trees of one page body: the referring node and the node it names. An HTML
 * reference names an element `id`; `elsewhere` gives the node that carried it on another side, so a
 * reference to an element the merge removed is still a reference to that node.
 */
export function nodeReferences(trees: readonly unknown[], elsewhere?: ReadonlyMap<string, string>): Array<{ from: string; to: string; lostId?: boolean }> {
  const out: Array<{ from: string; to: string; lostId?: boolean }> = [];
  const htmlIdToNode = new Map<string, string>();
  const htmlRefs: Array<{ from: string; ids: Set<string> }> = [];
  for (const node of walkNodes(trees)) {
    if (typeof node.id !== 'string') continue;
    const props = isPlainObject(node.props) ? node.props : undefined;
    if (!props) continue;
    if (typeof props.id === 'string' && props.id !== '') htmlIdToNode.set(props.id, node.id);
    if (props.behaviour !== undefined) {
      const named = new Set<string>();
      remapBehaviourRefs({ id: node.id, props: { behaviour: props.behaviour } } as never, recorder(named));
      for (const to of named) out.push({ from: node.id, to });
    }
    const ids = new Set<string>();
    withFollowedRefs(props, recorder(ids));
    if (ids.size > 0) htmlRefs.push({ from: node.id, ids });
  }
  // An HTML reference names an element `id`; it points at the node carrying that id, if any.
  for (const { from, ids } of htmlRefs) {
    for (const htmlId of ids) {
      const here = htmlIdToNode.get(htmlId);
      if (here !== undefined) {
        out.push({ from, to: here });
        continue;
      }
      // The element id is gone from the trees. Its former node may still be there under another id: the
      // reference is broken all the same (`lostId`), not satisfied by the node.
      const former = elsewhere?.get(htmlId);
      if (former !== undefined) out.push({ from, to: former, lostId: true });
    }
  }
  return out;
}

/** Something the merged document points at that is not there, though main and the branch alone did not leave it so. */
export interface DanglingReference {
  /** `link`: links to an address no page holds any more (a page renamed or removed on the other side). */
  kind: 'node' | 'page' | 'component' | 'link';
  /** The node, page or component id; for `link`, the page that held the address. */
  id: string;
  /** For a node: the page or component definition it was in (`page:<id>`, `component:<id>`). */
  container?: string;
  /** For a node: the node is still there but no longer carries the HTML element id the reference names. */
  lostId?: boolean;
  /** For a link: the address the links lead to, and how many links lead there. */
  slug?: string;
  count?: number;
}

/** A page address any side gave a page: its key, to the page and its slug there. */
type KnownAddresses = Map<string, { pageId: string; slug: string }>;

/** Per container, HTML element ids to their node on any of the three sides. */
type KnownHtmlIds = Map<string, Map<string, string>>;

/** Every broken reference of a document, keyed by what points and what it points at. */
function brokenReferences(doc: MergeDocument, known: KnownAddresses, htmlIds: KnownHtmlIds): Map<string, DanglingReference> {
  const out = new Map<string, DanglingReference>();
  const components = doc.components ?? {};
  const pageIds = new Set(doc.pages.map((p) => p.pageId));
  const held = new Set(doc.pages.map((p) => addressKeyOfSlug(textOf(p.slug))));
  for (const [container, body] of documentBodies(doc)) {
    const trees = treesOf(body);
    const present = new Set<string>();
    for (const node of walkNodes(trees)) {
      if (typeof node.id === 'string') present.add(node.id);
      const props = isPlainObject(node.props) ? node.props : undefined;
      if (!props || typeof node.id !== 'string') continue;
      const from = `${container}/${node.id}`;
      if (isPlacementType(node.type) && typeof props.component === 'string' && !(props.component in components)) {
        out.set(`component|${props.component}|${from}`, { kind: 'component', id: props.component });
      }
      // As the form settings read it (readFormSettings, src/lib/forms/definition.ts; countLinksToPage).
      const sent = props.successBehavior === 'redirect' && typeof props.redirectPageId === 'string' ? props.redirectPageId.trim() : '';
      if (sent !== '' && !pageIds.has(sent)) out.set(`page|${sent}|${from}`, { kind: 'page', id: sent });
      const key = typeof props.href === 'string' ? linkKeyOfHref(props.href) : null;
      const page = key === null ? undefined : known.get(key);
      if (key !== null && page && !held.has(key)) out.set(`link|${key}|${from}`, { kind: 'link', id: page.pageId, slug: page.slug, count: 1 });
    }
    for (const { from, to, lostId } of nodeReferences(trees, htmlIds.get(container))) {
      if (lostId && present.has(to)) out.set(`node|${container}|${to}|${from}|lostId`, { kind: 'node', id: to, container, lostId: true });
      else if (!present.has(to)) out.set(`node|${container}|${to}|${from}`, { kind: 'node', id: to, container });
    }
  }
  const notFound = isPlainObject(doc.siteSettings) ? doc.siteSettings.notFoundPageId : undefined;
  if (typeof notFound === 'string' && notFound !== '' && !pageIds.has(notFound)) out.set(`page|${notFound}|#404`, { kind: 'page', id: notFound });
  return out;
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * What a merge result points at and does not hold, left out each reference main or the branch alone already
 * left broken the same way (the same referring node, the same target). One entry per target; a link entry
 * counts its links. Built once per merge from the three sides; `base` adds the addresses pages had at the fork
 * point to the links looked for.
 */
export function danglingChecker(main: MergeDocument, branch: MergeDocument, base?: MergeDocument): (merged: MergeDocument) => DanglingReference[] {
  const sides = [main, branch, ...(base ? [base] : [])];
  const known: KnownAddresses = new Map();
  const htmlIds: KnownHtmlIds = new Map();
  for (const doc of sides) {
    for (const page of doc.pages) {
      const slug = textOf(page.slug);
      const key = addressKeyOfSlug(slug);
      // The home address always resolves, and a dynamic address has no single path.
      if (key !== null && !known.has(key)) known.set(key, { pageId: page.pageId, slug });
    }
    for (const [container, body] of documentBodies(doc)) {
      const ids = htmlIds.get(container) ?? new Map<string, string>();
      for (const [htmlId, nodeId] of htmlIdsOf(treesOf(body))) if (!ids.has(htmlId)) ids.set(htmlId, nodeId);
      htmlIds.set(container, ids);
    }
  }
  const before = new Set([...brokenReferences(main, known, htmlIds).keys(), ...brokenReferences(branch, known, htmlIds).keys()]);
  return (merged) => {
    const out = new Map<string, DanglingReference>();
    for (const [key, ref] of brokenReferences(merged, known, htmlIds)) {
      if (before.has(key)) continue;
      const target = `${ref.kind}|${ref.container ?? ''}|${ref.id}${ref.lostId ? '|lostId' : ''}`;
      const seen = out.get(target);
      if (seen && ref.kind === 'link') seen.count = (seen.count ?? 0) + 1;
      else if (!seen) out.set(target, { ...ref });
    }
    return [...out.values()];
  };
}

/** `danglingChecker` for one result. */
export function danglingReferences(merged: MergeDocument, main: MergeDocument, branch: MergeDocument, base?: MergeDocument): DanglingReference[] {
  return danglingChecker(main, branch, base)(merged);
}

/**
 * The key under which the merge asks the removal of what a dangling reference points at (`./document.ts`),
 * or null when the merged document still holds that thing (a link to an address its page no longer has:
 * reported, but there is no removal to ask).
 */
export function askKey(ref: DanglingReference, merged: MergeDocument): string | null {
  // A node that is still there has no removal to ask.
  if (ref.kind === 'node') return ref.lostId ? null : `node|${ref.container}|${ref.id}`;
  if (ref.kind === 'component') return ref.id in (merged.components ?? {}) ? null : `component|${ref.id}`;
  return merged.pages.some((p) => p.pageId === ref.id) ? null : `page|${ref.id}`;
}
