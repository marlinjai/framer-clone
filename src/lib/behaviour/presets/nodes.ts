// src/lib/behaviour/presets/nodes.ts
//
// What every preset builds with. A preset is a pure function that returns ordinary nodes
// with `behaviour` and roles, and there is no preset type at render time, so the palette,
// the AI generator and the score call the same function and what lands on a page can be
// edited like anything else. See docs/plans/2026-11-02-behaviour-model.md, "Presets".
//
// Each preset has one `derive` step, which writes every generated entry from the structure
// of the nodes, marked `preset: true`, and keeps what a person added. Building a preset is
// laying out its nodes and deriving once, so adding an item and building one are the same
// path: clone an item, derive again.
//
// A `seed` keeps two presets on a page apart: it starts every node id, which is also what
// a preset uses as an element `id`, and every state id, since a state id must be unique on
// its path to the root and a preset can sit inside another.
//
// PURE: no React, no MST.

import { compactBehaviour, remapBehaviourRefs, type Binding, type StateValue, type StoredBehaviour, type Trigger, type Action } from '../format';
import { renewCopyIds } from '@/lib/renderer/idRefs';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';

/** A node as a preset writes it. `label` is what Layers calls it. */
export type PresetNode = Omit<ComponentNode, 'id' | 'children'> & { id: string; label?: string; children?: PresetNode[] };

type Props = Record<string, unknown>;

/** A seed is lower case, because it starts state ids. */
const SEED = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function assertSeed(seed: string): void {
  if (!SEED.test(seed)) throw new Error(`a preset seed is short and lower case, got ${JSON.stringify(seed)}`);
}

export function el(id: string, type: string, props: Props, ...children: PresetNode[]): PresetNode {
  const node: PresetNode = { id, type, props: props as PresetNode['props'] };
  if (children.length > 0) node.children = children;
  return node;
}

export const propsOf = (node: PresetNode): Props => (node.props ?? {}) as Props;
export const behaviourOf = (node: PresetNode): StoredBehaviour => (propsOf(node).behaviour ?? {}) as StoredBehaviour;

/** The same node with `props` changed. Nodes may be frozen, so nothing is written in place. */
export const withProps = (node: PresetNode, props: Props): PresetNode =>
  ({ ...node, props: { ...propsOf(node), ...props } as PresetNode['props'] });

const own = <T extends { preset?: true }>(list: readonly T[] | undefined): T[] => (list ?? []).filter((entry) => entry.preset !== true);
const marked = <T extends object>(list: readonly T[] | undefined): (T & { preset: true })[] =>
  (list ?? []).map((entry) => ({ ...entry, preset: true as const }));

/** What a derive step writes on one node. */
export type Derived = Omit<StoredBehaviour, 'state' | 'on' | 'bind'> & {
  state?: StateValue[];
  on?: Trigger[];
  bind?: Binding[];
};

/**
 * The node with its generated entries replaced by `derive`, and everything a person added
 * kept. Generated entries go first, so a person's trigger runs after them. A node left with
 * nothing has no `behaviour` at all, as the stored shape asks, rather than an empty one.
 */
export function derived(node: PresetNode, derive: Derived): PresetNode {
  const before = behaviourOf(node);
  const { state, on, bind, ...fields } = derive;
  const lists = {
    state: [...marked(state), ...own(before.state)],
    on: [...marked(on), ...own(before.on)],
    bind: [...marked(bind), ...own(before.bind)],
  };
  const merged: Record<string, unknown> = { ...before, ...fields };
  for (const [name, list] of Object.entries(lists)) {
    if (list.length > 0) merged[name] = list;
    else delete merged[name];
  }
  const rest: Record<string, unknown> = { ...propsOf(node) };
  delete rest.behaviour;
  const behaviour = compactBehaviour(merged);
  return { ...node, props: (behaviour ? { ...rest, behaviour } : rest) as PresetNode['props'] };
}

/** The id of a generated state on this node, or what the first derive calls it. */
export function stateIdOn(node: PresetNode, suffix: string): string {
  const found = behaviourOf(node).state?.find((state) => state.preset === true && state.id.endsWith(`-${suffix}`));
  return found?.id ?? `${node.id}-${suffix}`;
}

/** The first value of a generated number, or 0 before the first derive. */
export function initialOf(node: PresetNode, state: string): number {
  const found = behaviourOf(node).state?.find((entry) => entry.id === state);
  return found?.type === 'number' ? found.initial : 0;
}

/** The name a person gave a preset's value, kept when the preset writes the value again, or `fallback`. */
export function nameOf(node: PresetNode, state: string, fallback: string): string {
  const found = behaviourOf(node).state?.find((entry) => entry.id === state);
  return typeof found?.name === 'string' && found.name.trim() !== '' ? found.name : fallback;
}

/** A keyboard trigger that keeps the key from the page. */
export const onKeys = (id: string, keys: string[], ...actions: Action[]): Trigger =>
  ({ id, on: 'keydown', keys, prevent: true, do: actions });

function idsUnder(node: PresetNode, out: Set<string>): Set<string> {
  out.add(node.id);
  node.children?.forEach((child) => idsUnder(child, out));
  return out;
}

/**
 * Hands out ids that follow an item's own: one past the highest number its stem has under
 * `root` or in `taken` (the rest of the page, and every id the page's behaviour names), so
 * an id is never one a node elsewhere holds, nor one a removed item had while anything
 * still names it, where a reference would silently pass to the new item.
 */
function freshIds(root: PresetNode, taken: ReadonlySet<string> = new Set()): (old: string) => string {
  const used = idsUnder(root, new Set(taken));
  return (old) => {
    const stem = old.replace(/-\d+$/, '');
    let at = 0;
    for (const id of used) {
      if (!id.startsWith(`${stem}-`)) continue;
      const rest = id.slice(stem.length + 1);
      if (/^\d+$/.test(rest)) at = Math.max(at, Number(rest) + 1);
    }
    used.add(`${stem}-${at}`);
    return `${stem}-${at}`;
  };
}

/** A copy of an item with fresh ids, a person's references inside it following them. `taken` is what the rest of the page uses. */
export function copyItem(root: PresetNode, item: PresetNode, taken?: ReadonlySet<string>): PresetNode {
  const newId = freshIds(root, taken);
  const ids = new Map<string, string>();
  const renew = (at: PresetNode): PresetNode => {
    const id = newId(at.id);
    ids.set(at.id, id);
    return { ...at, id, ...(at.children ? { children: at.children.map(renew) } : {}) };
  };
  const copy = renew(item);
  return remapBehaviourRefs(renewCopyIds(copy, copy.id), ids);
}
