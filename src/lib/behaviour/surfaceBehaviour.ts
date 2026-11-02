// src/lib/behaviour/surfaceBehaviour.ts
//
// What the two editor surfaces show of stored behaviour. See "The editor canvas" in
// docs/plans/2026-11-02-behaviour-model.md. Both run the published page's own pass,
// applyBehaviour, over the page's expansion, so no second compile of `when`, `showWhen`
// or a binding exists:
//
//   - The canvas, in Select, runs nothing. A volatile preview stands in for a state's
//     first value, so the pass writes `data-fcs-*`, the bindings and the `showWhen` rules
//     as though the page started there. "Menu open" stays visible while it is styled.
//   - The preview runs the page from its real first values, with the program this pass
//     returns, in its own frame (PreviewFrame).
//
// The renderers draw the live tree, not this one, so what the pass wrote is handed over
// per node id as `NodeDom`: the attributes and custom properties it added or changed.
// The sheets read the applied tree, whose `compiledRules` hold the conditions.
//
// A Collection's rows are not in the expansion: the editor draws its template once per
// row. So a row's own index cannot be read here, and a `showWhen` that compares with it
// leaves the node visible, the safe direction, as applyBehaviour already says.
//
// PURE: no React, no MST.

import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { applyBehaviour, type BehaviourProblem } from '@/lib/renderer/server/applyBehaviour';
import { readBehaviourTree, type Condition, type StateValue } from './format';
import type { BehaviourProgram } from './program';

/** A preview value per state id. Volatile: never saved, never in undo. */
export type PreviewValues = Readonly<Record<string, string | number | boolean>>;

/** What the pass wrote on one node, beyond what is stored. */
export interface NodeDom {
  attributes: Readonly<Record<string, unknown>>;
  /** Stored attributes the pass took away, such as `value` turned into `defaultValue`. */
  removed: readonly string[];
  /** Custom properties a binding writes. */
  style: Readonly<Record<string, unknown>>;
}

export interface SurfaceBehaviour {
  /** The tree with the pass applied, `compiledRules` on the nodes holding conditions. */
  root: ComponentNode;
  program: BehaviourProgram | null;
  /** By node id, as the expansion names it. */
  dom: ReadonlyMap<string, NodeDom>;
  problems: readonly BehaviourProblem[];
}

const MAX_TEXT_INITIAL = 4096;
/** Keys the pass consumes: neither is ever a DOM attribute. */
const CONSUMED: ReadonlySet<string> = new Set(['behaviour', 'rules']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * True when `value` may stand for this stored state's first value. The parser checks a
 * stored entry the same way, and would refuse the whole state over a value outside it,
 * so a preview that no longer fits, say after its options changed, is simply not shown.
 */
export function fitsState(state: unknown, value: unknown): boolean {
  if (!isRecord(state)) return false;
  switch (state.type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      const { min, max } = state;
      return !(typeof min === 'number' && value < min) && !(typeof max === 'number' && value > max);
    }
    case 'choice':
      return typeof value === 'string' && Array.isArray(state.options) && state.options.includes(value);
    case 'text': {
      if (typeof value !== 'string') return false;
      const limit = typeof state.maxLength === 'number' ? Math.min(state.maxLength, MAX_TEXT_INITIAL) : MAX_TEXT_INITIAL;
      return value.length <= limit;
    }
    default:
      return false;
  }
}

/** The tree with each previewed state starting at its preview value. Copies only the nodes it changes. */
function withPreview(node: ComponentNode, preview: PreviewValues): ComponentNode {
  const props = node.props as Record<string, unknown> | undefined;
  const behaviour = props?.behaviour;
  let next = node;
  if (isRecord(behaviour) && Array.isArray(behaviour.state)) {
    let changed = false;
    const state = behaviour.state.map((entry: unknown) => {
      const id = isRecord(entry) ? entry.id : undefined;
      if (typeof id !== 'string' || !Object.hasOwn(preview, id) || !fitsState(entry, preview[id])) return entry;
      changed = true;
      return { ...(entry as Record<string, unknown>), initial: preview[id] };
    });
    if (changed) next = { ...node, props: { ...props, behaviour: { ...behaviour, state } } as ComponentNode['props'] };
  }
  const children = node.children;
  if (!children) return next;
  const mapped = children.map((child) => withPreview(child, preview));
  return mapped.some((child, index) => child !== children[index]) ? { ...next, children: mapped } : next;
}

/** What the pass changed on one node. Null when it wrote nothing. */
function domOf(stored: ComponentNode, applied: ComponentNode): NodeDom | null {
  const before = (stored.props ?? {}) as Record<string, unknown>;
  const after = (applied.props ?? {}) as Record<string, unknown>;
  const attributes: Record<string, unknown> = {};
  const style: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(after)) {
    if (CONSUMED.has(name) || before[name] === value) continue;
    if (name !== 'style') {
      attributes[name] = value;
      continue;
    }
    // A binding adds its custom property to the stored style: only what it added is the pass's.
    const was = isRecord(before.style) ? before.style : {};
    for (const [key, entry] of Object.entries(isRecord(value) ? value : {})) if (was[key] !== entry) style[key] = entry;
  }
  const removed = Object.keys(before).filter((name) => !CONSUMED.has(name) && name !== 'style' && !(name in after));
  return Object.keys(attributes).length + Object.keys(style).length + removed.length > 0 ? { attributes, removed, style } : null;
}

/** Walks the stored tree and the applied one together. The pass maps children one to one on a tree with no clones. */
function collectDom(stored: ComponentNode, applied: ComponentNode, out: Map<string, NodeDom>): void {
  const dom = domOf(stored, applied);
  if (dom && stored.id) out.set(stored.id, dom);
  const before = stored.children ?? [];
  const after = applied.children ?? [];
  for (let index = 0; index < Math.min(before.length, after.length); index++) collectDom(before[index], after[index], out);
}

const EMPTY: ReadonlyMap<string, NodeDom> = new Map();

/**
 * The last few results per tree, by preview. A tree is replaced whole on every change.
 * The canvas, at a preview, and the preview overlay, at first values, read the same tree,
 * and one slot would make each throw the other's result away: the overlay's runtime would
 * then see a new program on its next render and start again under a visitor's hands.
 */
const memo = new WeakMap<ComponentNode, Map<string, SurfaceBehaviour>>();
const KEPT_PER_TREE = 4;

/** The behaviour pass over one surface tree, with `preview` standing for first values. */
export function surfaceBehaviour(root: ComponentNode, preview: PreviewValues = {}): SurfaceBehaviour {
  const key = JSON.stringify(preview);
  let kept = memo.get(root);
  if (!kept) memo.set(root, (kept = new Map()));
  const known = kept.get(key);
  if (known) return known;
  const problems: BehaviourProblem[] = [];
  const source = Object.keys(preview).length > 0 ? withPreview(root, preview) : root;
  const applied = applyBehaviour(source, (found) => problems.push(...found));
  let result: SurfaceBehaviour;
  if (applied.root === source && !applied.program) {
    result = { root, program: null, dom: EMPTY, problems };
  } else {
    const dom = new Map<string, NodeDom>();
    collectDom(root, applied.root, dom);
    result = { root: applied.root, program: applied.program, dom, problems };
  }
  // The oldest goes first: a Map keeps the order entries were set in.
  if (kept.size >= KEPT_PER_TREE) kept.delete(kept.keys().next().value as string);
  kept.set(key, result);
  return result;
}

// --- reveal from Layers ---------------------------------------------------------

/** What hides a node, and the preview that would show it, when there is one. */
export interface Reveal {
  /** Preview values that make every condition on the way down true. Empty when nothing hides the node. */
  values: Record<string, string | number | boolean>;
  /** The states those values are for, by name, for the badge. */
  names: string[];
  /** Set when a condition hides the node that a preview cannot undo: why. */
  blocked?: string;
}

/** The assignments that make `condition` true, or null when it is not a plain chain of `eq`. */
function assignments(condition: Condition, out: Map<string, string | number | boolean>): boolean {
  if ('state' in condition) {
    // A comparison with the row has no one value to preview.
    if (typeof condition.eq === 'object') return false;
    const known = out.get(condition.state);
    if (known !== undefined && known !== condition.eq) return false;
    out.set(condition.state, condition.eq);
    return true;
  }
  if ('all' in condition) return condition.all.every((entry) => assignments(entry, out));
  return false;
}

/**
 * True when the condition holds for these values. A comparison with the row counts as
 * holding: no surface can read a row here, and the pass leaves such a node visible.
 */
function holds(condition: Condition, read: (id: string) => unknown): boolean {
  if ('state' in condition) return typeof condition.eq === 'object' || read(condition.state) === condition.eq;
  if ('not' in condition) return !holds(condition.not, read);
  if ('all' in condition) return condition.all.every((entry) => holds(entry, read));
  return condition.any.some((entry) => holds(entry, read));
}

/**
 * The preview that shows `nodeId`, read from the stored tree: each `showWhen` on the way
 * down, against the state in reach there, the preview standing for first values. A node
 * a `showWhen` reading the row hides is left to the panel, which says so.
 */
export function revealFor(root: ComponentNode, nodeId: string, preview: PreviewValues = {}): Reveal | null {
  const tree = readBehaviourTree(root);
  const path: ComponentNode[] = [];
  const find = (node: ComponentNode): boolean => {
    path.push(node);
    if (node.id === nodeId) return true;
    if ((node.children ?? []).some(find)) return true;
    path.pop();
    return false;
  };
  if (!find(root)) return null;

  const states = new Map<string, StateValue>();
  const values = new Map<string, string | number | boolean>();
  const names: string[] = [];
  for (const node of path) {
    const behaviour = tree.behaviours.get(node);
    for (const state of behaviour?.state ?? []) states.set(state.id, state);
    const condition = behaviour?.showWhen;
    if (!condition) continue;
    const read = (id: string): unknown => (values.has(id) ? values.get(id) : Object.hasOwn(preview, id) && fitsState(states.get(id), preview[id]) ? preview[id] : states.get(id)?.initial);
    if (holds(condition, read)) continue;
    const wanted = new Map(values);
    const label = (node.props as { 'aria-label'?: unknown } | undefined)?.['aria-label'];
    const where = typeof label === 'string' && label ? label : node.type;
    if (!assignments(condition, wanted)) return { values: Object.fromEntries(values), names, blocked: `a Show when on ${where} that a preview cannot satisfy` };
    for (const [id, value] of wanted) {
      if (values.get(id) === value) continue;
      const state = states.get(id);
      if (!state || !fitsState(state, value)) return { values: Object.fromEntries(values), names, blocked: `a Show when on ${where} that reads a state out of reach` };
      values.set(id, value);
      if (!names.includes(state.name)) names.push(state.name);
    }
  }
  return { values: Object.fromEntries(values), names };
}
