// src/lib/ai/serializers/subtree.ts
//
// Single-subtree serializer. Given any ComponentInstance, produce a
// plain-JSON `SerializedComponent` describing it and its descendants.
//
// Read-only: never mutates MST. Reads `.props`, `.children`, etc. via
// MST views (which are MobX-tracked but don't write).

import {
  ComponentTypeEnum,
  CanvasNodeType,
  type ComponentInstance,
} from '@/models/ComponentModel';
import { getParent, hasParent } from 'mobx-state-tree';
import { isPlacementType, type PlacementProps } from '@/lib/components/placement';
import { normalize } from './normalize';
import { truncateTreeToBudget } from './tokenBudget';

/**
 * The shape every component-tree-shaped serializer emits. Mirrors the MST
 * `ComponentModel` shape but stripped to the fields the AI needs to plan
 * a mutation:
 *
 *   - id / type / componentType / canvasNodeType — node identity
 *   - label — human-readable hint
 *   - props — including any responsive style maps; sorted-key plain object
 *   - parentId — present when the node has a parent (i.e. it's not the
 *     subtree root or a top-level canvas node)
 *   - children — recursive
 *
 * Keys arrive sorted alphabetically because the object is funnelled
 * through `normalize` before return.
 */
export type SerializedComponent = {
  canvasNodeType: 'component' | 'viewport' | 'floating';
  children: SerializedComponent[];
  componentType: 'host' | 'function';
  id: string;
  /** A placement ("#component"): the name of the component it places. */
  name?: string;
  /** A placement: its input values, as the generator writes them. */
  inputs?: Record<string, unknown>;
  /** A placement: the state it starts in. */
  state?: string;
  label?: string;
  parentId?: string;
  props: Record<string, unknown>;
  type: string;
};

/** The site's definitions, from the project holding this node. */
function definitionsAbove(node: object): Record<string, { name?: unknown }> {
  let current: object = node;
  while (hasParent(current)) {
    current = getParent(current);
    if ('definitions' in current) return (current as { definitions: Record<string, { name?: unknown }> }).definitions;
  }
  return {};
}

/**
 * A placement as the generator writes one: its component's name and its own
 * values, never the component's inner tree, which is the definition's and is far
 * more tokens (docs/plans/2026-11-02-reusable-components.md, "AI generation").
 */
function serializePlacement(c: ComponentInstance): SerializedComponent {
  const { component, inputs, state, style } = (c.props ?? {}) as Partial<PlacementProps>;
  const definition = typeof component === 'string' ? definitionsAbove(c)[component] : undefined;
  const node: Record<string, unknown> = {
    id: c.id,
    type: c.type,
    componentType: isHostOrFunction(c.componentType),
    canvasNodeType: isCanvasNodeType(c.canvasNodeType),
    name: typeof definition?.name === 'string' ? definition.name : 'Missing component',
    inputs: inputs ?? {},
    props: style !== undefined ? { style } : {},
    children: [],
  };
  if (typeof state === 'string') node.state = state;
  if (c.label !== undefined) node.label = c.label;
  if (c.parentId !== undefined) node.parentId = c.parentId;
  return normalize(node) as SerializedComponent;
}

function isHostOrFunction(v: string): 'host' | 'function' {
  return v === ComponentTypeEnum.FUNCTION ? 'function' : 'host';
}

function isCanvasNodeType(v: string): 'component' | 'viewport' | 'floating' {
  if (v === CanvasNodeType.VIEWPORT) return 'viewport';
  if (v === CanvasNodeType.FLOATING_ELEMENT) return 'floating';
  return 'component';
}

function serializeOne(c: ComponentInstance): SerializedComponent {
  if (isPlacementType(c.type)) return serializePlacement(c);
  // Read children first so MobX tracks the dependency consistently.
  const kids: SerializedComponent[] = [];
  for (const child of c.children) {
    kids.push(serializeOne(child as ComponentInstance));
  }

  const node: Record<string, unknown> = {
    id: c.id,
    type: c.type,
    componentType: isHostOrFunction(c.componentType),
    canvasNodeType: isCanvasNodeType(c.canvasNodeType),
    // `props` is a frozen JS object on MST — normalize gives us a
    // deep-sorted-key clone.
    props: c.props ?? {},
    children: kids,
  };
  if (c.label !== undefined) node.label = c.label;
  if (c.parentId !== undefined) node.parentId = c.parentId;

  return normalize(node) as SerializedComponent;
}

/**
 * Serialize a single component subtree.
 *
 * When `opts.maxTokens` is provided the result is greedily truncated by
 * depth — innermost leaves drop first, the root + its immediate children
 * survive longest. See `tokenBudget.truncateTreeToBudget`.
 */
export function serializeSubtree(
  component: ComponentInstance,
  opts: { maxTokens?: number } = {},
): SerializedComponent {
  const out = serializeOne(component);
  if (opts.maxTokens !== undefined) {
    return truncateTreeToBudget(out, opts.maxTokens);
  }
  return out;
}
