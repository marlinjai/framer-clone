// src/lib/components/expand.ts
//
// One pure step before hydration: every placement becomes ordinary nodes, so
// stylesheets, effects, images, fonts, the sticky bar and the form lookup need no
// knowledge of components. A tree with nothing to expand comes back unchanged, by
// reference, so a page without placements renders byte for byte as it did.
//
// Each expanded node has a unique `id`, prefixed with its placement path, so a
// form placed twice is two forms, and a shared `classKey`, so twelve cards share
// their CSS wherever a class is issued. Inputs stay as `{{input.x}}` bindings:
// a value from data is only known in hydration, which reads `props.instance`,
// parses each value after it resolves and pushes the frame. Raw readers, which
// read literal props, ask for `literalInputs` instead.
//
// Stored JSON can say anything, so the budget, the cycle check and the depth limit
// run here even though the model refuses the same things. All tenants share one
// Node process, and a few hundred bytes of nested placements can ask for
// gigabytes. A placement that cannot expand becomes a `#missing` node, with one
// warning per page, and the page still serves.
//
// Contract: docs/plans/2026-11-02-reusable-components.md, "Expansion".
//
// PURE: no React, no MST, no server-only.

import { withFollowedRefs } from '@/lib/renderer/idRefs';
import type { ComponentDefinition, ComponentDefinitions } from '@/lib/components/definition';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { BreakpointRef } from '@/lib/responsive/cascade';
import type { BindingEntry, BindingsRecord } from '@/lib/bindings/types';
import { applyBindings, readsInput } from '@/lib/bindings/resolver/applyBindings';
import { evaluateExpression, parseExpression } from '@/lib/bindings/resolver/expression';
import { createScope, lookup, pushInputFrame, pushItemFrame, type BindingScope } from '@/lib/bindings/resolver/scope';
import { componentSnapshotToNode, extractBreakpoints, type ComponentSnapshotLike } from '@/lib/renderer/server/componentSnapshot';
import { mapNodeProps, mapResponsiveValue } from './breakpoints';
import { mayBindToSlot, parseInputValue, type InputDefinition } from './inputs';
import { REPEAT_PROP, repeatedCopies, repeatInputId, withItemBindingsChecked, withoutRepeat } from './repeat';
import { COMPONENT_LIMITS, isPlacementType, MISSING_TYPE, serializedBytes, type PlacementProps } from './placement';

// ---------- the budget ----------

/**
 * What one page may render from placements, in nodes and in bytes. Expansion and
 * hydration draw on one object, because a template cloned per row costs what it
 * renders. Past a limit, nothing more is paid for.
 */
export interface RenderBudget {
  readonly nodes: number;
  readonly bytes: number;
  readonly exhausted: boolean;
  /** Every problem of this page, once each. */
  readonly warnings: ReadonlySet<string>;
  /** The placements that render nothing, once each. `checkBeforePublish` shows these. */
  readonly failures: readonly ExpansionFailure[];
  /** True when it fits. A refusal stops all later charges too. */
  charge(nodes: number, bytes: number): boolean;
  /** Logs a problem once per page. */
  warn(message: string): void;
  /** `warn`, and records why a placement renders nothing, once per kind and definition. */
  fail(failure: ExpansionFailure, message: string): void;
}

/** Why a placement became a `#missing` node. */
export type ExpansionFailureKind = 'missing-definition' | 'cycle' | 'too-deep' | 'unrenderable' | 'over-budget';

export interface ExpansionFailure {
  kind: ExpansionFailureKind;
  /** The definition the placement names, when it names one. */
  definitionId?: string;
}

export function createRenderBudget(
  limits: { nodes?: number; bytes?: number; spent?: RenderBudget } = {},
): RenderBudget {
  const maxNodes = limits.nodes ?? COMPONENT_LIMITS.expandedNodesPerPage;
  const maxBytes = limits.bytes ?? COMPONENT_LIMITS.expandedBytesPerPage;
  const { spent } = limits;
  const warnings = new Set<string>(spent?.warnings);
  const failures: ExpansionFailure[] = [...(spent?.failures ?? [])];
  let nodes = spent?.nodes ?? 0;
  let bytes = spent?.bytes ?? 0;
  let exhausted = spent?.exhausted ?? false;
  const warn = (message: string) => {
    if (warnings.has(message)) return;
    warnings.add(message);
    console.warn(`[components] ${message}`);
  };
  const fail = (failure: ExpansionFailure, message: string) => {
    warn(message);
    const known = failures.some(({ kind, definitionId }) => kind === failure.kind && definitionId === failure.definitionId);
    if (!known) failures.push(failure);
  };
  return {
    get nodes() { return nodes; },
    get bytes() { return bytes; },
    get exhausted() { return exhausted; },
    warnings,
    failures,
    warn,
    fail,
    charge(moreNodes, moreBytes) {
      if (!exhausted && (nodes + moreNodes > maxNodes || bytes + moreBytes > maxBytes)) {
        exhausted = true;
        fail({ kind: 'over-budget' }, `this page is over its budget of ${maxNodes} expanded nodes or ${maxBytes} bytes: later placements render nothing`);
      }
      if (exhausted) return false;
      nodes += moreNodes;
      bytes += moreBytes;
      return true;
    },
  };
}

// ---------- what hydration reads ----------

/** Recorded on a placement root for hydration, which removes it. Never reaches the DOM. */
export interface PlacementInstance {
  inputs: Record<string, unknown>;
  /** The placement's values from data, under `input.<id>`. */
  bindings: BindingsRecord;
  inputDefinitions: InputDefinition[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** What hydration needs of a placement. A value from data sits in its bindings, under `input.<id>`. */
export function placementInstance(
  props: Pick<PlacementProps, 'inputs'>,
  bindings: BindingsRecord | undefined,
  inputDefinitions: InputDefinition[],
): PlacementInstance {
  return {
    inputs: props.inputs ?? {},
    bindings: Object.fromEntries(Object.entries(bindings ?? {}).filter(([slot]) => slot.startsWith('input.'))),
    inputDefinitions,
  };
}

export function placementInstanceOf(props: unknown): PlacementInstance | undefined {
  const instance = isRecord(props) ? props.instance : undefined;
  // Expansion writes this, but a stored page is opaque JSON, so its shape is checked here.
  if (!isRecord(instance) || !isRecord(instance.inputs) || !isRecord(instance.bindings)) return undefined;
  if (!Array.isArray(instance.inputDefinitions) || !instance.inputDefinitions.every(isRecord)) return undefined;
  return instance as unknown as PlacementInstance;
}

export function withoutInstance(node: ComponentNode): ComponentNode {
  const { instance: _instance, ...props } = (node.props ?? {}) as Record<string, unknown>;
  void _instance;
  return { ...node, props };
}

export function boundValue(binding: BindingEntry | undefined, scope: BindingScope): unknown {
  if (binding?.mode !== 'read') return undefined;
  const parsed = parseExpression(binding.expression);
  return parsed ? evaluateExpression(parsed, scope) : undefined;
}

/**
 * The complete values of a placement: each input's own value, resolved in the
 * scope outside the placement and parsed, or its default. A value that does not
 * parse is treated as absent, with one warning per page. With `dataIsUnknown`, for
 * raw readers, an input bound to data has no value here rather than its default.
 */
export function resolveInputValues(
  instance: PlacementInstance,
  scope: BindingScope,
  budget: RenderBudget,
  dataIsUnknown = false,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const definition of instance.inputDefinitions) {
    const binding = instance.bindings[`input.${definition.id}`];
    const bound = boundValue(binding, scope);
    if (bound === undefined && binding && dataIsUnknown) continue;
    const value = bound ?? instance.inputs[definition.id];
    if (value !== undefined) {
      const parsed = parseInputValue(definition, value);
      if (parsed.ok) {
        values[definition.id] = parsed.value;
        continue;
      }
      budget.warn(`input "${definition.name}" was given a value it refuses: ${parsed.reason}`);
    }
    if (definition.default !== undefined) values[definition.id] = definition.default;
  }
  return values;
}

/**
 * A node with the input bindings that have a value written into its props. Any
 * other binding stays, including one on an input with no value here. The same
 * node when there is nothing to write.
 */
export function bakeInputBindings(node: ComponentNode, scope: BindingScope): ComponentNode {
  const entries = Object.entries(node.bindings ?? {});
  const known = (entry: BindingEntry) =>
    entry.mode === 'read' && readsInput(entry) && boundValue(entry, scope) !== undefined;
  if (!entries.some(([, entry]) => known(entry))) return node;
  const baked = Object.fromEntries(entries.filter(([, entry]) => known(entry)));
  const rest = Object.fromEntries(entries.filter(([, entry]) => !known(entry)));
  const props = applyBindings({ bindings: baked }, node.props ?? {}, scope).resolvedProps;
  return { ...node, props: props as ComponentNode['props'], bindings: rest };
}

// ---------- stored attributes the renderer owns ----------

// The selectors and the runtime honour these, so stored ones go, placement or not.
const RENDERER_ATTRIBUTE = /^data-fcs?-/i;

const isRendererOwned = (name: string, value: unknown): boolean =>
  RENDERER_ATTRIBUTE.test(name) || (name === 'instance' && typeof value === 'object');

function holdsRendererOwned(node: ComponentNode): boolean {
  return Object.entries(node.props ?? {}).some(([name, value]) => isRendererOwned(name, value))
    || Object.keys(node.bindings ?? {}).some(slot => RENDERER_ATTRIBUTE.test(slot));
}

function withoutRendererOwned(node: ComponentNode): ComponentNode {
  if (!holdsRendererOwned(node)) return node;
  const next: ComponentNode = { ...node };
  if (node.props) {
    next.props = Object.fromEntries(
      Object.entries(node.props).filter(([name, value]) => !isRendererOwned(name, value)),
    ) as ComponentNode['props'];
  }
  if (node.bindings) {
    next.bindings = Object.fromEntries(
      Object.entries(node.bindings).filter(([slot]) => !RENDERER_ATTRIBUTE.test(slot)),
    );
  }
  return next;
}

function hasWork(root: ComponentNode): boolean {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (isPlacementType(node.type) || holdsRendererOwned(node)) return true;
    for (const child of node.children ?? []) stack.push(child);
  }
  return false;
}

// ---------- identity ----------

const MAX_PATH = 120;

/** A stable 53 bit hash: the same text gives the same id on every render and in both runtimes. */
export function stableHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** `formId` is capped at 200 in submit.ts, and six uuid segments are already 226. */
export function pathId(prefix: string, id: string): string {
  const path = `${prefix}__${id}`;
  return path.length > MAX_PATH ? `p-${stableHash(path)}` : path;
}

export function rewriteReferences(node: ComponentNode, renamed: ReadonlyMap<string, string>): ComponentNode {
  return {
    ...node,
    ...(node.props ? { props: withFollowedRefs(node.props, renamed) as ComponentNode['props'] } : {}),
    ...(node.children ? { children: node.children.map(child => rewriteReferences(child, renamed)) } : {}),
  };
}

// ---------- merging a placement onto the root ----------

/** A plain value is the `base` of a map, so one breakpoint's override survives a placement's size. */
function mergeValue(definition: unknown, placement: unknown): unknown {
  const asMap = (value: unknown) => (isRecord(value) ? value : { base: value });
  return isRecord(definition) || isRecord(placement) ? { ...asMap(definition), ...asMap(placement) } : placement;
}

/**
 * Per property and per breakpoint. A placement key is deleted and re-added, so it
 * always lands last: spreading alone keeps a shared key's old position, and a
 * definition's `paddingTop` would beat a placement's `padding`.
 */
export function mergeStyle(definition: unknown, placement: unknown): unknown {
  if (!isRecord(placement)) return definition;
  const merged: Record<string, unknown> = isRecord(definition) ? { ...definition } : {};
  for (const [key, value] of Object.entries(placement)) {
    const combined = key in merged ? mergeValue(merged[key], value) : value;
    delete merged[key];
    merged[key] = combined;
  }
  return merged;
}

// ---------- expansion ----------

export interface ExpandOptions {
  /** Shared with hydration. A fresh one when absent. */
  budget?: RenderBudget;
  /**
   * For readers of raw snapshots: write literal input values and defaults into
   * their bound slots. A value bound to data stays unknown, and a reader treats it
   * as it treats any binding today.
   */
  literalInputs?: boolean;
}

interface PreparedDefinition {
  tree: ComponentNode;
  /** Its inputs, with each default keyed on this page's breakpoints. */
  inputs: InputDefinition[];
  nodes: number;
  bytes: number;
}

// Computed once per stored definition, and the cached site keeps these objects.
const sizes = new WeakMap<ComponentDefinition, number>();

function definitionBytes(definition: ComponentDefinition): number {
  const known = sizes.get(definition);
  if (known !== undefined) return known;
  const bytes = serializedBytes(definition);
  sizes.set(definition, bytes);
  return bytes;
}

function countNodes(node: ComponentNode): number {
  return 1 + (node.children ?? []).reduce((sum, child) => sum + countNodes(child), 0);
}

/** A binding of an input to an address, by a type whose check is no address check. */
export function bindingsAllowed(bindings: BindingsRecord, inputs: readonly InputDefinition[], budget: RenderBudget): BindingsRecord {
  const kept: BindingsRecord = {};
  for (const [slot, entry] of Object.entries(bindings)) {
    const path = entry.mode === 'read' ? parseExpression(entry.expression)?.path : undefined;
    const input = path?.[0] === 'input' ? inputs.find(candidate => candidate.id === path[1]) : undefined;
    if (input && !mayBindToSlot(input.type, slot)) {
      budget.warn(`input "${input.name}" is ${input.type} and cannot be bound to the address ${slot}`);
      continue;
    }
    kept[slot] = entry;
  }
  return kept;
}

/**
 * Expand a page tree. Unchanged, by reference, when it holds no placement and no
 * stored renderer attribute.
 */
export function expandPlacements(
  root: ComponentNode,
  definitions: ComponentDefinitions,
  pageBreakpoints: readonly BreakpointRef[],
  options: ExpandOptions = {},
): ComponentNode {
  if (!hasWork(root)) return root;

  const budget = options.budget ?? createRenderBudget();
  const literal = options.literalInputs === true;
  const prepared = new Map<string, PreparedDefinition>();

  // A page node never yields its `id`, so these are known before the first placement.
  const seenIds = new Set<string>();
  const collectIds = (node: ComponentNode): void => {
    if (isPlacementType(node.type)) return;
    const id = node.props?.id;
    if (typeof id === 'string') seenIds.add(id);
    (node.children ?? []).forEach(collectIds);
  };
  collectIds(root);

  /** The tree of a definition, for this page's breakpoints, clear of what must not pass. */
  const prepare = (id: string, definition: ComponentDefinition): PreparedDefinition | null => {
    const known = prepared.get(id);
    if (known) return known;
    const bytes = definitionBytes(definition);
    const tree = definition.page?.appComponentTree as ComponentSnapshotLike | undefined;
    if (!tree || typeof tree.type !== 'string' || tree.type.startsWith('#')) return null;
    if (bytes > COMPONENT_LIMITS.definitionBytes) return null;
    const own = extractBreakpoints(definition.page.canvasNodes);
    const inputs = definition.inputs ?? [];
    const clean = (stored: ComponentNode): ComponentNode => {
      const node = withoutRendererOwned(stored);
      const props = mapNodeProps((node.props ?? {}) as Record<string, unknown>, own, pageBreakpoints);
      // Compilation is what makes a state rule safe. Until it runs, an uncompiled
      // one would read as a rule that always applies.
      if (Array.isArray(props.rules)) {
        props.rules = props.rules.filter(rule => !(isRecord(rule) && 'componentState' in rule));
      }
      return {
        ...node,
        props: props as ComponentNode['props'],
        ...(node.bindings ? { bindings: bindingsAllowed(node.bindings, inputs, budget) } : {}),
        ...(node.children ? { children: node.children.map(clean) } : {}),
      };
    };
    // A definition's own root cannot repeat: the list it would read opens inside it.
    const adapted = withItemBindingsChecked(withoutRepeat(clean(componentSnapshotToNode(tree))), inputs, message => budget.warn(message));
    const mappedInputs = inputs.map(input =>
      input.default === undefined ? input : { ...input, default: mapResponsiveValue(input.default, own, pageBreakpoints) });
    const result = { tree: adapted, inputs: mappedInputs, nodes: countNodes(adapted), bytes };
    prepared.set(id, result);
    return result;
  };

  const missing = (node: ComponentNode, failure: ExpansionFailure, reason: string): ComponentNode => {
    budget.fail(failure, reason);
    return { type: MISSING_TYPE, ...(node.id ? { id: node.id } : {}) };
  };

  /** Every node of the tree under the placement's path. The root takes the placement's own id. */
  const withIdentity = (tree: ComponentNode, placementId: string): ComponentNode => {
    const copy = (node: ComponentNode, index: number): ComponentNode => ({
      ...node,
      id: pathId(placementId, node.id ?? String(index)),
      ...(node.id ? { classKey: node.id } : {}),
      ...(node.children ? { children: node.children.map(copy) } : {}),
    });
    return { ...copy(tree, 0), id: placementId, placementRoot: true };
  };

  /** Walks one expansion, in order, giving a repeated `id` attribute a stable suffix. */
  const finishExpansion = (
    node: ComponentNode,
    placementId: string,
    stack: readonly string[],
    scope: BindingScope | null,
    renamed: Map<string, string>,
  ): ComponentNode | null => {
    if (isPlacementType(node.type)) return expand(node, stack, scope);
    if (scope && boundValue(node.bindings?.visible, scope) === false) return null;
    const baked = scope ? bakeInputBindings(node, scope) : node;
    const next: ComponentNode = { ...baked };
    const id = next.props?.id;
    // An `id` bound to an input is the author's and is left alone.
    if (typeof id === 'string' && !next.bindings?.id) {
      if (seenIds.has(id)) {
        const suffix = stableHash(placementId).slice(0, 6);
        let unique = `${id}-${suffix}`;
        for (let n = 2; seenIds.has(unique); n++) unique = `${id}-${suffix}-${n}`;
        seenIds.add(unique);
        if (!renamed.has(id)) renamed.set(id, unique);
        next.props = { ...next.props, id: unique } as ComponentNode['props'];
      } else {
        seenIds.add(id);
      }
    }
    if (baked.children) {
      next.children = baked.children
        .flatMap(child => {
          // Raw readers see each item a literal list gives, as the page does.
          const repeatId = scope ? repeatInputId(child.props) : undefined;
          if (!scope || !repeatId) return [finishExpansion(child, placementId, stack, scope, renamed)];
          return repeatedCopies(child, lookup(scope, ['input', repeatId]))
            .map(copy => finishExpansion(copy.node, placementId, stack, pushItemFrame(scope, copy.item), renamed));
        })
        .filter(child => child !== null);
    }
    return next;
  };

  /** One placement as ordinary nodes, or `#missing`, or null when a literal `visible` removes it. */
  const expand = (node: ComponentNode, stack: readonly string[], outer: BindingScope | null): ComponentNode | null => {
    const props = (node.props ?? {}) as unknown as PlacementProps;
    const id = props.component;
    if (typeof id !== 'string' || !Object.hasOwn(definitions, id)) {
      return missing(
        node,
        { kind: 'missing-definition', ...(typeof id === 'string' ? { definitionId: id } : {}) },
        `a placement names a definition this site does not have: ${String(id)}`,
      );
    }
    const definition = definitions[id];
    if (stack.includes(id)) return missing(node, { kind: 'cycle', definitionId: id }, `a definition contains itself: ${[...stack, id].join(' > ')}`);
    if (stack.length >= COMPONENT_LIMITS.nestingDepth) {
      return missing(node, { kind: 'too-deep', definitionId: id }, `placements nest more than ${COMPONENT_LIMITS.nestingDepth} deep: ${[...stack, id].join(' > ')}`);
    }
    const ready = prepare(id, definition);
    if (!ready) return missing(node, { kind: 'unrenderable', definitionId: id }, `a definition cannot be rendered: ${id}`);
    if (!budget.charge(ready.nodes, ready.bytes)) {
      return missing(node, { kind: 'over-budget' }, `placement of ${id} left out: the page is over its budget`);
    }

    const placementId = node.id ?? `p-${stableHash(`${stack.join('>')}>${id}`)}`;
    const instance = placementInstance(props, node.bindings, ready.inputs);
    const tree = withIdentity(ready.tree, placementId);
    const rootProps = { ...tree.props } as Record<string, unknown>;
    if (props.style !== undefined) rootProps.style = mergeStyle(rootProps.style, props.style);
    if (isRecord(props.effects)) rootProps.effects = { ...(isRecord(rootProps.effects) ? rootProps.effects : {}), ...props.effects };
    // A placement repeated for a list of the component around it: the root carries
    // the marker, and the copies are made where the outer list is known.
    const repeat = repeatInputId(props);
    if (repeat) rootProps[REPEAT_PROP] = repeat;
    if (!literal) rootProps.instance = instance;
    const merged: ComponentNode = { ...tree, props: rootProps as ComponentNode['props'] };

    const scope = literal
      ? pushInputFrame(createScope(), resolveInputValues(instance, outer ?? createScope(), budget, true))
      : null;
    const renamed = new Map<string, string>();
    const done = finishExpansion(merged, placementId, [...stack, id], scope, renamed);
    return done && renamed.size > 0 ? rewriteReferences(done, renamed) : done;
  };

  /** The page around the placements. Whatever no placement touches keeps its identity. */
  const walk = (stored: ComponentNode): ComponentNode | null => {
    if (isPlacementType(stored.type)) return expand(stored, [], null);
    const node = withoutRendererOwned(stored);
    if (!node.children) return node;
    const children = node.children.map(walk).filter(child => child !== null);
    const same = children.length === node.children.length && children.every((child, i) => child === node.children?.[i]);
    return same ? node : { ...node, children };
  };

  return walk(root) ?? { type: MISSING_TYPE };
}
