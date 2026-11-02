// src/lib/renderer/detachedExpansion.ts
//
// An expanded placement as a detached MobX-State-Tree tree, for the preview: the
// published compile path's output, rendered by the same HeadlessComponentRenderer as
// any page node. One tree per expansion result, which PageModel.expansion keeps until
// the page or a definition changes.

import ComponentModel, { ComponentTypeEnum, type ComponentInstance, type ComponentSnapshotIn } from '@/models/ComponentModel';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';

const trees = new WeakMap<ComponentNode, ComponentInstance>();

function toSnapshot(node: ComponentNode, parentId?: string): ComponentSnapshotIn {
  return {
    id: node.id ?? '',
    type: node.type,
    componentType: ComponentTypeEnum.HOST,
    props: node.props ?? {},
    bindings: node.bindings ?? {},
    ...(parentId ? { parentId } : {}),
    children: (node.children ?? []).map(child => toSnapshot(child, node.id)),
  } as ComponentSnapshotIn;
}

export function detachedExpansion(node: ComponentNode): ComponentInstance {
  const known = trees.get(node);
  if (known) return known;
  const tree = ComponentModel.create(toSnapshot(node));
  trees.set(node, tree);
  return tree;
}
