// src/lib/renderer/commerce/ShopControlContent.tsx
//
// What a shop control (src/lib/commerce/parts.ts) draws inside its host: its part
// nodes, under the runtime context the control publishes. On the canvas and in
// the editor's Preview the surface's own renderer has drawn the children already
// (so each part selects and edits as a node there); the control adds a default
// copy of any required part the tree lacks. On a published page the control
// draws its own children from the node, completed the same way. Either way every
// required part is on the page.
'use client';

import React from 'react';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { BindingScope } from '@/lib/bindings/resolver/scope';
import { createScope } from '@/lib/bindings/resolver/scope';
import { missingShopParts, normalizeShopControl, type ShopControlKind, type ShopLocale, type ShopTreeNode } from '@/lib/commerce/parts';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { renderNodeChildren } from '@/lib/renderer/server/renderComponentNode';

export interface ShopControlContentProps {
  node: ComponentInstance;
  kind: ShopControlKind;
  locale: ShopLocale;
  /** The children as the surface drew them; undefined on a published page. */
  drawn: React.ReactNode | undefined;
  /** The binding scope of the control, for the parts it draws itself. */
  scope?: BindingScope;
}

export function ShopControlContent({ node, kind, locale, drawn, scope }: ShopControlContentProps) {
  const fallback = React.useMemo(() => (drawn === undefined ? null : missingShopParts(node, locale, kind)), [node, drawn, locale, kind]);
  const own = React.useMemo(
    () => (drawn === undefined ? normalizeShopControl(node as unknown as ShopTreeNode, locale, 'node', kind) : null),
    [node, drawn, locale, kind],
  );
  const at = scope ?? createScope();
  if (own) return <>{renderNodeChildren(own as unknown as ComponentNode, at)}</>;
  return (
    <>
      {drawn}
      {fallback && fallback.length > 0 ? renderNodeChildren({ type: 'div', children: fallback } as ComponentNode, at) : null}
    </>
  );
}
