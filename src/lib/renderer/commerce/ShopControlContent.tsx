// src/lib/renderer/commerce/ShopControlContent.tsx
//
// What a shop control (src/lib/commerce/parts.ts) draws inside its host: its part
// nodes, under the runtime context the control publishes. On the canvas and in
// the editor's Preview the surface's own renderer has drawn the children already
// (so each part selects and edits as a node there); the control adds a default
// copy of any required part the tree lacks. On a published page the control
// draws its own children from the node, completed the same way. Either way every
// required part is on the page. The platform's guard rule for the parts kept in
// sight comes first.
'use client';

import React from 'react';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { BindingScope } from '@/lib/bindings/resolver/scope';
import { createScope } from '@/lib/bindings/resolver/scope';
import { missingShopParts, normalizeShopControl, shopGuardCss, type ShopControlKind, type ShopLocale, type ShopTreeNode } from '@/lib/commerce/parts';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { renderNodeChildren } from '@/lib/renderer/server/renderComponentNode';

/** Constant text: built from the spec, never from stored data, and never holding a `<`. */
const SHOP_GUARD_CSS = shopGuardCss();

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
  // The platform's guard rule for the parts kept in sight comes first (shopGuardCss).
  const guard = <style data-shop-guard="" dangerouslySetInnerHTML={{ __html: SHOP_GUARD_CSS }} />;
  if (own) return <>{guard}{renderNodeChildren(own as unknown as ComponentNode, at)}</>;
  return (
    <>
      {guard}
      {drawn}
      {fallback && fallback.length > 0 ? renderNodeChildren({ type: 'div', children: fallback } as ComponentNode, at) : null}
    </>
  );
}
