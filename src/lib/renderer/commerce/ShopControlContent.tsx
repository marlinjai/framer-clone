// src/lib/renderer/commerce/ShopControlContent.tsx
//
// What a shop control (src/lib/commerce/parts.ts) draws inside its host: its part
// nodes, under the runtime context the control publishes. On the canvas and in
// the editor's Preview the surface's own renderer has drawn the children already
// (so each part selects and edits as a node there); the control adds a default
// copy of any required part the tree lacks (before the children when the
// control's parts come first). On a published page the control
// draws its own children from the node, completed the same way. Either way every
// required part is on the page. The platform's guard rule for the parts kept in
// sight comes first.
'use client';

import React from 'react';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { BindingScope } from '@/lib/bindings/resolver/scope';
import { createScope } from '@/lib/bindings/resolver/scope';
import { SHOP_CONTROLS, missingShopParts, missingShopPartsKey, normalizeShopControl, shopGuardCss, type ShopControlKind, type ShopLocale, type ShopTreeNode } from '@/lib/commerce/parts';
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
  // `drawn` is a new element on every render of the canvas and the Preview, so the
  // memos read only whether the surface drew the children, never the element itself.
  const ownDraw = drawn === undefined;
  // On those surfaces the node is a live instance changed in place (a part deleted,
  // moved), so its reference says nothing: the fallback is kept for as long as the
  // parts the control holds stay the same (missingShopPartsKey).
  const missingKey = ownDraw ? null : missingShopPartsKey(node, kind);
  const fallback = React.useMemo(
    () => (missingKey === null ? null : missingShopParts(node, locale, kind)),
    // `node` is left out on purpose: it is a live instance changed in place, so its
    // reference stays the same when a part leaves it; the parts it holds (missingKey)
    // are its identity here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [missingKey, locale, kind],
  );
  // A published page hands the island a plain node built once (CommerceIsland), so its reference is the key.
  const own = React.useMemo(
    () => (ownDraw ? normalizeShopControl(node as unknown as ShopTreeNode, locale, 'node', kind) : null),
    [node, ownDraw, locale, kind],
  );
  const at = scope ?? createScope();
  // The platform's guard rule for the parts kept in sight comes first (shopGuardCss).
  const guard = <style data-shop-guard="" dangerouslySetInnerHTML={{ __html: SHOP_GUARD_CSS }} />;
  if (own) return <>{guard}{renderNodeChildren(own as unknown as ComponentNode, at)}</>;
  const missing = fallback && fallback.length > 0 ? renderNodeChildren({ type: 'div', children: fallback } as ComponentNode, at) : null;
  // A control whose parts come first (the variant selector, before the designer's
  // add to cart) draws a missing part there too, where the next load stores it.
  const first = !!SHOP_CONTROLS[kind].partsFirst;
  return (
    <>
      {guard}
      {first ? missing : null}
      {drawn}
      {first ? null : missing}
    </>
  );
}
