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
  label?: string;
  parentId?: string;
  props: Record<string, unknown>;
  type: string;
};

function isHostOrFunction(v: string): 'host' | 'function' {
  return v === ComponentTypeEnum.FUNCTION ? 'function' : 'host';
}

function isCanvasNodeType(v: string): 'component' | 'viewport' | 'floating' {
  if (v === CanvasNodeType.VIEWPORT) return 'viewport';
  if (v === CanvasNodeType.FLOATING_ELEMENT) return 'floating';
  return 'component';
}

function serializeOne(c: ComponentInstance): SerializedComponent {
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
