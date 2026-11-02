// src/lib/renderer/idRefs.ts
//
// HTML `id` attributes that a repeat would duplicate, and what points at them. See
// docs/plans/2026-11-02-behaviour-model.md, step 6 of the pass. A Collection clones
// its template once per row, so an `id` in the template appears once per row. A popover
// in row 5 then opens row 1's, and a screen reader announces row 1's label.
//
// The first use keeps its `id`, so an anchor keeps working. A later use in a clone gets
// a suffix from its row, which depends on nothing but its position, and the references
// inside that clone follow it. A reference to an `id` outside the clone stays. An `id`
// that a binding already made unique per row is left alone, and a repeat outside any
// clone is the author's and stays too: nothing here can tell which use was meant.
//
// PURE: no React, no MST.

/** The attributes holding an `id`, or a list of them, in lower case. */
const REFERENCE_NAMES: ReadonlySet<string> = new Set([
  'for', 'htmlfor', 'aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-owns', 'aria-activedescendant',
  'aria-details', 'aria-errormessage', 'aria-flowto', 'popovertarget', 'commandfor', 'list', 'form', 'headers',
]);

/** True for an attribute whose value names an `id`. */
export const isIdReference = (name: string): boolean => REFERENCE_NAMES.has(name.toLowerCase());

const followList = (value: string, ids: ReadonlyMap<string, string>): string =>
  value.replace(/\S+/g, (token) => ids.get(token) ?? token);

function followed(name: string, value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value !== 'string') return value;
  if (isIdReference(name)) return followList(value, ids);
  if (name.toLowerCase() !== 'href' || !value.startsWith('#')) return value;
  const target = ids.get(value.slice(1));
  return target === undefined ? value : `#${target}`;
}

/**
 * Props with their references following `ids`, old to new, and `href`s starting `#`.
 * Hands back the same object when nothing changed.
 */
export function withFollowedRefs(props: Record<string, unknown>, ids: ReadonlyMap<string, string>): Record<string, unknown> {
  let copy: Record<string, unknown> | null = null;
  for (const [name, value] of Object.entries(props)) {
    const next = followed(name, value, ids);
    if (next !== value) {
      copy ??= { ...props };
      copy[name] = next;
    }
  }
  return copy ?? props;
}

/** What this needs of a node. */
interface IdNode {
  props?: unknown;
  children?: unknown;
  cloneIndex?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const propsOf = (node: IdNode): Record<string, unknown> | undefined => (isRecord(node.props) ? node.props : undefined);
const idOf = (node: IdNode): string | undefined => {
  const id = propsOf(node)?.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
};
const childrenOf = <N extends IdNode>(node: N): N[] => (Array.isArray(node.children) ? (node.children as N[]) : []);
const isClone = (node: IdNode): boolean => typeof node.cloneIndex === 'number';

/** Calls `visit` for every node a clone holds directly: nested clones hold their own. */
function walkLevel<N extends IdNode>(node: N, visit: (node: N) => void): void {
  visit(node);
  for (const child of childrenOf(node)) {
    if (!isClone(child)) walkLevel(child, visit);
  }
}

/**
 * The tree with an `id` repeated by a clone made unique, and the references inside
 * each clone following it. Returns the same tree when there is nothing to do.
 */
export function suffixCloneIds<N extends IdNode>(root: N): N {
  const counts = new Map<string, number>();
  const count = (node: N): void => {
    const id = idOf(node);
    if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
    childrenOf(node).forEach(count);
  };
  count(root);
  const taken = new Set(counts.keys());
  /** Ids a first use has claimed. Those outside any clone go first, since they cannot move. */
  const seen = new Set<string>();
  const claimOutside = (node: N): void => {
    if (isClone(node)) return;
    const id = idOf(node);
    if (id !== undefined) seen.add(id);
    childrenOf(node).forEach(claimOutside);
  };
  claimOutside(root);

  const issue = (id: string, path: readonly number[]): string => {
    let next = `${id}-r${path.join('-')}`;
    while (taken.has(next)) next = `${next}_`;
    taken.add(next);
    return next;
  };

  const assign = (clone: N, path: readonly number[]): Map<string, string> => {
    const own = new Map<string, string>();
    walkLevel(clone, (node) => {
      const id = idOf(node);
      if (id === undefined || (counts.get(id) ?? 0) < 2 || own.has(id)) return;
      if (seen.has(id)) own.set(id, issue(id, path));
      else seen.add(id);
    });
    return own;
  };

  const rewrite = (node: N, path: readonly number[], ids: ReadonlyMap<string, string>): N => {
    let at = path;
    let reach = ids;
    if (isClone(node)) {
      at = [...path, node.cloneIndex as number];
      const own = assign(node, at);
      if (own.size > 0) reach = new Map([...ids, ...own]);
    }
    const props = propsOf(node);
    let nextProps = props && reach.size > 0 ? withFollowedRefs(props, reach) : props;
    const id = idOf(node);
    const moved = id === undefined ? undefined : reach.get(id);
    if (moved !== undefined) nextProps = { ...nextProps, id: moved };
    const children = childrenOf(node);
    const nextChildren = children.map((child) => rewrite(child, at, reach));
    const sameChildren = nextChildren.every((child, index) => child === children[index]);
    if (nextProps === props && sameChildren) return node;
    return { ...node, ...(nextProps !== props ? { props: nextProps } : {}), ...(sameChildren ? {} : { children: nextChildren }) };
  };

  return [...counts.values()].some((uses) => uses > 1) ? rewrite(root, [], new Map()) : root;
}
