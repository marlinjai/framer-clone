// src/lib/components/detach.ts
//
// Detach: a placement replaced by a plain copy of what it renders, in the
// breakpoints of whatever holds it. Deleting a definition does this to every
// placement, so "pages look the same" is the promise.
//
// A literal input value is written into its slot. A value from data has no literal
// here, so the binding is rewritten to the outer expression, joining paths:
// `{{input.image.src}}` over `input.image: {{row.cover}}` gives `{{row.cover.src}}`.
// A nested placement stays a placement, with its values treated the same way. Ids
// are fresh, and behaviour follows them. A repeated `id` attribute takes the suffix
// expansion gives it, or the copy would print the same id twice for good.
//
// A pointer state becomes an ordinary rule: `&:hover` and its like on the root,
// and on a descendant a selector reading a marker the root gains. A custom state
// compiles to a `when` rule, which needs the behaviour runtime, so `detachRefusal`
// refuses such a definition until that exists, rather than losing the state.
//
// Contract: docs/plans/2026-11-02-reusable-components.md, "Detach".
//
// PURE: no React, no MST, no server-only.

import { remapBehaviourRefs } from '@/lib/behaviour/format';
import type { BindingEntry, BindingsRecord } from '@/lib/bindings/types';
import { parseExpression } from '@/lib/bindings/resolver/expression';
import { createScope, lookup, pushInputFrame, pushItemFrame, type BindingScope } from '@/lib/bindings/resolver/scope';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { extractBreakpoints } from '@/lib/renderer/server/componentSnapshot';
import type { BreakpointRef } from '@/lib/responsive/cascade';
import { HOVER_GATE } from '@/lib/rules/states';
import { mapNodeProps, mapResponsiveValue } from './breakpoints';
import { isPointerState, placementMarker, POINTER_STATE_CSS, type ComponentDefinition, type PointerStateKind, type StateDefinition } from './definition';
import {
  bakeInputBindings,
  bindingsAllowed,
  boundValue,
  createRenderBudget,
  mergeStyle,
  resolveInputValues,
  rewriteReferences,
  stableHash,
  type PlacementInstance,
} from './expand';
import { isPlacementType, type PlacementProps } from './placement';
import { repeatInputId, withoutRepeat } from './repeat';
import { MAX_LIST_ITEMS } from './inputs';

/** A stored node, as `getSnapshot` gives it: everything else on it is copied as it is. */
export interface StoredNode {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  bindings?: BindingsRecord;
  children?: StoredNode[];
  parentId?: string;
  label?: string;
  [key: string]: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const treeOf = (definition: ComponentDefinition): StoredNode =>
  definition.page.appComponentTree as unknown as StoredNode;

function someNode(node: StoredNode, test: (node: StoredNode) => boolean): boolean {
  return test(node) || (node.children ?? []).some(child => someNode(child, test));
}

const stateRulesOf = (node: StoredNode): Record<string, unknown>[] => {
  const rules = node.props?.rules;
  return Array.isArray(rules) ? rules.filter((rule): rule is Record<string, unknown> => isRecord(rule) && 'componentState' in rule) : [];
};

/** Why this definition's placements cannot become plain copies yet, or null. */
export function detachRefusal(definition: ComponentDefinition): string | null {
  const custom = new Set(definition.states.filter(state => state.kind === 'custom').map(state => state.id));
  const holdsCustom = someNode(treeOf(definition), node => stateRulesOf(node).some(rule => custom.has(rule.componentState as string)));
  return holdsCustom ? `${definition.name} has custom states, which a plain copy cannot keep yet.` : null;
}

/** The selector a pointer state becomes once its component is gone. */
function pointerRule(rule: Record<string, unknown>, state: StateDefinition & { kind: PointerStateKind }, isRoot: boolean, marker: string): Record<string, unknown> {
  const { componentState: _state, ...stored } = rule;
  void _state;
  const active = POINTER_STATE_CSS[state.kind];
  const selector = isRoot ? `&${active}` : `&:where([${marker}]${active} *)`;
  const at = [...(Array.isArray(rule.at) ? rule.at as string[] : []), ...(state.kind === 'hover' ? [HOVER_GATE] : [])];
  return { ...stored, selector, ...(at.length > 0 ? { at } : {}) };
}

export interface DetachOptions {
  /** The definition this placement names. */
  definition: ComponentDefinition;
  /** The breakpoints of the page or definition holding the placement. */
  holderBreakpoints: readonly BreakpointRef[];
  /** The `id` attributes already in use where the copy lands. */
  takenIds: ReadonlySet<string>;
  newId: () => string;
}

/**
 * The plain copy of a placement, or null when a literal `visible` removes its root,
 * as it does on the page. The caller checks `detachRefusal` and sets `parentId`.
 */
export function detachedTree(placement: StoredNode, options: DetachOptions): StoredNode | null {
  const { definition, holderBreakpoints, takenIds, newId } = options;
  const own = extractBreakpoints(definition.page.canvasNodes);
  const stored = (placement.props ?? {}) as unknown as PlacementProps;
  const inputDefinitions = definition.inputs.map(input =>
    input.default === undefined ? input : { ...input, default: mapResponsiveValue(input.default, own, holderBreakpoints) });
  const instance: PlacementInstance = {
    inputs: stored.inputs ?? {},
    bindings: Object.fromEntries(Object.entries(placement.bindings ?? {}).filter(([slot]) => slot.startsWith('input.'))),
    inputDefinitions,
  };
  const budget = createRenderBudget();
  const placementScope = pushInputFrame(createScope(), resolveInputValues(instance, createScope(), budget, true));

  // The live marker's name with no value, so a live placement's rules never match the copy.
  const marker = placementMarker(definition.id);
  const ids = new Map<string, string>();
  const taken = new Set(takenIds);
  const renamed = new Map<string, string>();
  let markRoot = false;

  /** The expression an input path reads once the input is gone, when it came from data. */
  const outerExpression = (entry: BindingEntry): string | undefined => {
    const path = entry.mode === 'read' ? parseExpression(entry.expression)?.path : undefined;
    if (path?.[0] !== 'input') return undefined;
    const outer = instance.bindings[`input.${path[1]}`];
    const outerPath = outer?.mode === 'read' ? parseExpression(outer.expression)?.path : undefined;
    return outerPath ? `{{${[...outerPath, ...path.slice(2)].join('.')}}}` : undefined;
  };
  // An item of a list is the placement's too: it is written in with the copy that shows it.
  const readsInputFrame = (entry: BindingEntry) => {
    const head = entry.mode === 'read' ? parseExpression(entry.expression)?.path[0] : undefined;
    return head === 'input' || head === 'item';
  };

  /** Bindings split by what happens to them: rewritten to data, written as literals, or left alone. */
  const splitBindings = (bindings: BindingsRecord) => {
    const kept: BindingsRecord = {};
    const literal: BindingsRecord = {};
    for (const [slot, entry] of Object.entries(bindings)) {
      if (!readsInputFrame(entry)) {
        kept[slot] = entry;
        continue;
      }
      const expression = outerExpression(entry);
      if (expression) kept[slot] = { ...entry, expression } as BindingEntry;
      else literal[slot] = entry;
    }
    return { kept, literal };
  };

  const copyRules = (props: Record<string, unknown>, isRoot: boolean): Record<string, unknown> => {
    if (!Array.isArray(props.rules)) return props;
    const rules = props.rules.flatMap(rule => {
      if (!isRecord(rule) || !('componentState' in rule)) return [rule];
      const state = definition.states.find(candidate => candidate.id === rule.componentState);
      if (!state || !isPointerState(state)) return [];
      if (!isRoot) markRoot = true;
      return [pointerRule(rule, state, isRoot, marker)];
    });
    const { rules: _rules, ...rest } = props;
    void _rules;
    return rules.length > 0 ? { ...props, rules } : rest;
  };

  const freshAttributeId = (props: Record<string, unknown>, bound: boolean): Record<string, unknown> => {
    const { id } = props;
    if (typeof id !== 'string' || bound) return props;
    if (!taken.has(id)) {
      taken.add(id);
      return props;
    }
    const suffix = stableHash(placement.id).slice(0, 6);
    let unique = `${id}-${suffix}`;
    for (let n = 2; taken.has(unique); n++) unique = `${id}-${suffix}-${n}`;
    taken.add(unique);
    if (!renamed.has(id)) renamed.set(id, unique);
    return { ...props, id: unique };
  };

  const copyPlacement = (node: StoredNode, props: Record<string, unknown>, id: string, scope: BindingScope): StoredNode => {
    const { kept, literal } = splitBindings(node.bindings ?? {});
    const baked = bakeInputBindings({ id, type: node.type, props: {}, bindings: literal } as ComponentNode, scope);
    const written = Object.entries(baked.props as Record<string, unknown>)
      .flatMap(([head, value]) => (head === 'input' && isRecord(value) ? Object.entries(value) : []));
    const inputs = { ...(isRecord(props.inputs) ? props.inputs : {}), ...Object.fromEntries(written) };
    return {
      ...node,
      id,
      props: { ...props, ...(Object.keys(inputs).length > 0 ? { inputs } : {}) },
      bindings: kept,
    };
  };

  const copy = (node: StoredNode, parentId: string | undefined, isRoot: boolean, scope: BindingScope = placementScope): StoredNode | null => {
    const allowed = bindingsAllowed(node.bindings ?? {}, inputDefinitions, budget);
    const { kept, literal } = splitBindings(allowed);
    const { visible, ...written } = literal;
    if (boundValue(visible, scope) === false) return null;
    const id = newId();
    ids.set(node.id, id);
    const mapped = copyRules(mapNodeProps(node.props ?? {}, own, holderBreakpoints), isRoot);
    if (isPlacementType(node.type)) return { ...copyPlacement({ ...node, bindings: allowed }, mapped, id, scope), parentId };
    const baked = bakeInputBindings(
      { id, type: node.type, props: mapped as ComponentNode['props'], bindings: written } as ComponentNode,
      scope,
    );
    const props = freshAttributeId(baked.props as Record<string, unknown>, 'id' in allowed);
    return {
      ...node,
      id,
      parentId,
      props,
      bindings: kept,
      children: (node.children ?? []).flatMap(child => copyChild(child, id, scope)),
    };
  };

  /**
   * A child, or one copy per item where it repeats for a list whose items are known
   * here, each with its item written in. A list bound to data has no items in the
   * editor, so its node stays once, without the marker, showing its stored values.
   */
  const copyChild = (child: StoredNode, parentId: string, scope: BindingScope): StoredNode[] => {
    const repeatId = repeatInputId(child.props);
    const one = (node: StoredNode, at: BindingScope): StoredNode[] => {
      const copied = copy(node, parentId, false, at);
      return copied ? [copied] : [];
    };
    if (!repeatId) return one(child, scope);
    const items = lookup(scope, ['input', repeatId]);
    const plain = { ...child, props: withoutRepeat(child as unknown as ComponentNode).props } as StoredNode;
    if (!Array.isArray(items)) return instance.bindings[`input.${repeatId}`] ? one(plain, scope) : [];
    return items.slice(0, MAX_LIST_ITEMS).flatMap(item => one(plain, pushItemFrame(scope, item)));
  };

  const tree = copy(treeOf(definition), undefined, true);
  if (!tree) return null;

  const rootProps: Record<string, unknown> = { ...tree.props };
  if (stored.style !== undefined) rootProps.style = mergeStyle(rootProps.style, stored.style);
  if (isRecord(stored.effects)) rootProps.effects = { ...(isRecord(rootProps.effects) ? rootProps.effects : {}), ...stored.effects };
  if (stored.behaviour) rootProps.behaviour = withPlacementBehaviour(rootProps.behaviour, stored.behaviour);
  if (markRoot) rootProps[marker] = '';

  const merged: StoredNode = { ...tree, props: rootProps, ...(placement.label ? { label: placement.label } : {}) };
  const remapped = remapBehaviourRefs(merged as never, ids) as unknown as StoredNode;
  return renamed.size > 0 ? rewriteReferences(remapped as unknown as ComponentNode, renamed) as unknown as StoredNode : remapped;
}

/** `on` is appended to the root's, `showWhen` set on it: the placement's Trigger field. */
function withPlacementBehaviour(root: unknown, placed: NonNullable<PlacementProps['behaviour']>): Record<string, unknown> {
  const own = isRecord(root) ? root : {};
  const on = [...(Array.isArray(own.on) ? own.on : []), ...(placed.on ?? [])];
  return { ...own, ...(on.length > 0 ? { on } : {}), ...(placed.showWhen === undefined ? {} : { showWhen: placed.showWhen }) };
}

/** True when a plain copy of this definition takes a form to a new id, which leaves past submissions behind. */
export function detachLosesFormHistory(definition: ComponentDefinition): boolean {
  return someNode(treeOf(definition), node => {
    const props = isRecord(node.props) ? node.props : {};
    return node.type === 'form' || typeof props['data-form-kind'] === 'string';
  });
}
