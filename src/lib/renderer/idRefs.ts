// src/lib/renderer/idRefs.ts
//
// HTML `id` attributes that a repeat would duplicate, and what points at them. See
// docs/plans/2026-11-02-behaviour-model.md, step 6 of the pass. A Collection clones
// its template once per row, so an `id` in the template appears once per row. A popover
// in row 5 then opens row 1's, and a screen reader announces row 1's label.
//
// Only an `id` something inside the clone points at moves. The first use keeps it, so an
// anchor keeps working. A later use in a clone gets a suffix from its row, which depends on
// nothing but its position, and the references inside that clone follow it. Everything else
// stays exactly as it was, since a page that opted into nothing should change only where it
// was broken: a repeat nothing points at breaks nothing, an `id` a binding made unique per
// row is not a repeat, an `id` a rule names would stop matching, and a repeat outside any
// clone is the author's, since nothing here can tell which use was meant.
//
// An image map is found by its `name`, so on a `map` that counts as its `id`.
//
// PURE: no React, no MST.

/** The attributes holding an `id`, or a list of them, in lower case. */
const REFERENCE_NAMES: ReadonlySet<string> = new Set([
  'for', 'htmlfor', 'aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-owns', 'aria-activedescendant',
  'aria-details', 'aria-errormessage', 'aria-flowto', 'popovertarget', 'commandfor', 'list', 'form', 'headers',
]);
/** Attributes holding `#<id>`. */
const FRAGMENT_NAMES: ReadonlySet<string> = new Set(['href', 'usemap']);

/** True for an attribute whose value names an `id`. */
export const isIdReference = (name: string): boolean => REFERENCE_NAMES.has(name.toLowerCase());

const followList = (value: string, ids: ReadonlyMap<string, string>): string =>
  value.replace(/\S+/g, (token) => ids.get(token) ?? token);

function followed(name: string, value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value !== 'string') return value;
  if (isIdReference(name)) return followList(value, ids);
  if (!FRAGMENT_NAMES.has(name.toLowerCase()) || !value.startsWith('#')) return value;
  const target = ids.get(value.slice(1));
  return target === undefined ? value : `#${target}`;
}

/**
 * Props with their references following `ids`, old to new, and `href` or `usemap`
 * values starting `#`.
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
  type?: unknown;
  props?: unknown;
  compiledRules?: unknown;
  children?: unknown;
  cloneIndex?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const propsOf = (node: IdNode): Record<string, unknown> | undefined => (isRecord(node.props) ? node.props : undefined);
const isMap = (node: IdNode): boolean => typeof node.type === 'string' && node.type.toLowerCase() === 'map';
const idOf = (node: IdNode): string | undefined => {
  const props = propsOf(node);
  const id = props?.id ?? (isMap(node) ? props?.name : undefined);
  return typeof id === 'string' && id.length > 0 ? id : undefined;
};
const childrenOf = <N extends IdNode>(node: N): N[] => (Array.isArray(node.children) ? (node.children as N[]) : []);
const isClone = (node: IdNode): boolean => typeof node.cloneIndex === 'number';

/** Every `id` the props point at. */
function referencesOf(props: Record<string, unknown>, out: Set<string>): void {
  for (const [name, value] of Object.entries(props)) {
    if (typeof value !== 'string') continue;
    if (isIdReference(name)) value.split(/\s+/).forEach((token) => out.add(token));
    else if (FRAGMENT_NAMES.has(name.toLowerCase()) && value.startsWith('#')) out.add(value.slice(1));
  }
}

/** The selector and wrapper text of a node's rules, stored or compiled. */
function ruleTextOf(node: IdNode): string[] {
  const out: string[] = [];
  const rules = [propsOf(node)?.rules, node.compiledRules].flatMap((list) => (Array.isArray(list) ? (list as unknown[]) : []));
  for (const rule of rules) {
    if (!isRecord(rule)) continue;
    for (const text of [rule.selector, ...(Array.isArray(rule.parts) ? rule.parts : []), ...(Array.isArray(rule.at) ? rule.at : [])]) {
      if (typeof text === 'string') out.push(text);
    }
  }
  return out;
}

const ID_SELECTOR = /#([^\s#.,:>+~()[\]"'=]+)/g;
const ID_ATTRIBUTE = /\[\s*id\s*[~|^$*]?=\s*["']?([^"'\]\s]*)/gi;

/** True for an `id` this selector text can match: a suffix would change the result. */
function namesId(text: string, id: string): boolean {
  return [...text.matchAll(ID_SELECTOR)].some((match) => match[1] === id)
    || [...text.matchAll(ID_ATTRIBUTE)].some((match) => id.includes(match[1]));
}

/** Calls `visit` for every node a clone holds directly: nested clones hold their own. */
function walkLevel<N extends IdNode>(node: N, visit: (node: N) => void): void {
  visit(node);
  for (const child of childrenOf(node)) {
    if (!isClone(child)) walkLevel(child, visit);
  }
}

/**
 * A copied subtree whose element ids would repeat the original's: an `id` something in
 * the copy points at gets `stem` added, and the references follow it. One nothing points
 * at stays, as in a clone, since a rule may read it and a repeat of it breaks nothing.
 * Hands back the same object when nothing changed.
 */
export function renewCopyIds<N extends IdNode>(root: N, stem: string): N {
  const held: string[] = [];
  const pointedAt = new Set<string>();
  const read = (node: N): void => {
    const id = idOf(node);
    if (id !== undefined) held.push(id);
    const props = propsOf(node);
    if (props) referencesOf(props, pointedAt);
    childrenOf(node).forEach(read);
  };
  read(root);
  const ids = new Map(held.filter((id) => pointedAt.has(id)).map((id) => [id, `${id}-${stem}`]));
  if (ids.size === 0) return root;
  const write = (node: N): N => {
    const props = propsOf(node);
    const id = idOf(node);
    const moved = id === undefined ? undefined : ids.get(id);
    const followedProps = props ? withFollowedRefs(props, ids) : undefined;
    return {
      ...node,
      ...(followedProps ? { props: moved === undefined ? followedProps : { ...followedProps, [isMap(node) ? 'name' : 'id']: moved } } : {}),
      ...(Array.isArray(node.children) ? { children: childrenOf(node).map(write) } : {}),
    };
  };
  return write(root);
}

/**
 * The tree with an `id` repeated by a clone made unique, and the references inside
 * each clone following it. Returns the same tree when there is nothing to do.
 */
export function suffixCloneIds<N extends IdNode>(root: N): N {
  const counts = new Map<string, number>();
  const ruleText: string[] = [];
  const count = (node: N): void => {
    const id = idOf(node);
    if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
    ruleText.push(...ruleTextOf(node));
    childrenOf(node).forEach(count);
  };
  count(root);
  const namedByRule = (id: string): boolean => ruleText.some((text) => namesId(text, id));
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

  const referencesInside = (node: N, out: Set<string>): Set<string> => {
    const props = propsOf(node);
    if (props) referencesOf(props, out);
    childrenOf(node).forEach((child) => referencesInside(child, out));
    return out;
  };

  const assign = (clone: N, path: readonly number[]): Map<string, string> => {
    const own = new Map<string, string>();
    const pointedAt = referencesInside(clone, new Set());
    walkLevel(clone, (node) => {
      const id = idOf(node);
      if (id === undefined || (counts.get(id) ?? 0) < 2 || own.has(id) || !pointedAt.has(id) || namedByRule(id)) return;
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
    if (moved !== undefined) {
      nextProps = { ...nextProps, ...(typeof nextProps?.id === 'string' ? { id: moved } : {}), ...(isMap(node) && nextProps?.name === id ? { name: moved } : {}) };
    }
    const children = childrenOf(node);
    const nextChildren = children.map((child) => rewrite(child, at, reach));
    const sameChildren = nextChildren.every((child, index) => child === children[index]);
    if (nextProps === props && sameChildren) return node;
    return { ...node, ...(nextProps !== props ? { props: nextProps } : {}), ...(sameChildren ? {} : { children: nextChildren }) };
  };

  return [...counts.values()].some((uses) => uses > 1) ? rewrite(root, [], new Map()) : root;
}
