// src/lib/renderer/repeatChildren.tsx
//
// The children of a node on the canvas and in the preview, with a repeated child
// (`props['data-repeat']`, src/lib/components/repeat.ts) drawn once per item of
// the list it repeats for, each against its own item frame, as the published page
// draws it. Both renderers draw live MST nodes, so every copy is the same node:
// selecting any of them selects it.
//
// `showTemplate` is for a component open on its own canvas: with no items to show,
// the repeated node is drawn once, empty, so it can still be selected and edited.

import React from 'react';
import type { ComponentInstance } from '@/models/ComponentModel';
import { lookup, pushItemFrame, type BindingScope } from '@/lib/bindings/resolver/scope';
import { MAX_LIST_ITEMS } from '@/lib/components/inputs';
import { repeatInputId } from '@/lib/components/repeat';

export function childrenWithRepeats(
  children: readonly ComponentInstance[],
  scope: BindingScope,
  renderNode: (node: ComponentInstance, scope: BindingScope) => React.ReactNode,
  showTemplate: boolean,
): React.ReactNode[] {
  return children.flatMap((child) => {
    const repeatId = repeatInputId(child.props);
    if (!repeatId) return [<React.Fragment key={child.id}>{renderNode(child, scope)}</React.Fragment>];
    const items = lookup(scope, ['input', repeatId]);
    const list = Array.isArray(items) ? items.slice(0, MAX_LIST_ITEMS) : [];
    if (list.length === 0 && showTemplate) {
      return [<React.Fragment key={child.id}>{renderNode(child, pushItemFrame(scope, {}))}</React.Fragment>];
    }
    return list.map((item, index) => (
      <React.Fragment key={`${child.id}__${index}`}>{renderNode(child, pushItemFrame(scope, item))}</React.Fragment>
    ));
  });
}
