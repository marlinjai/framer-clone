'use client';
// src/components/sidebars/right/sections/ShopPartNote.tsx
//
// The properties panel's word on a shop part whose text is the platform's
// (src/lib/commerce/parts.ts): the demo notice, the simulated payment line and
// the pay button's wording (fixed, with the reason), and a server message (its
// text arrives at run time). It takes the place of the Text field for such a
// part, so nobody types text the page would never show. Styling stays open.
import React from 'react';
import { observer } from 'mobx-react-lite';
import { Lock, Info } from 'lucide-react';
import { getParent, hasParent } from 'mobx-state-tree';
import type { ComponentInstance } from '@/models/ComponentModel';
import { shopPartRoleOf, shopPartSpec, shopStyleLimit } from '@/lib/commerce/parts';

/** Whether the node is a shop part whose text is not the designer's. */
export function isLockedShopText(component: ComponentInstance): boolean {
  const role = shopPartRoleOf(component.props);
  const spec = role ? shopPartSpec(role) : undefined;
  return !!spec && (!!spec.fixedText || !!spec.dynamicText);
}

export const ShopPartNote = observer(({ component }: { component: ComponentInstance }) => {
  const role = shopPartRoleOf(component.props);
  const spec = role ? shopPartSpec(role) : undefined;
  if (!spec || (!spec.fixedText && !spec.dynamicText)) return null;
  const reason = spec.dynamicText
    ? 'Its text comes from the shop at the moment it shows (a message from the server), so there is nothing to type here. Style it freely.'
    : (spec.fixedReason ?? 'Fixed text: the platform writes it in the site language. Style it freely.');
  return (
    <div
      data-testid="shop-part-note"
      className="mx-3 my-2 flex items-start gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-2 text-[11px] leading-snug text-muted-foreground"
    >
      <Lock size={12} className="mt-0.5 flex-none" aria-hidden />
      <span>{reason}</span>
    </div>
  );
});
ShopPartNote.displayName = 'ShopPartNote';

/** The node's tree ancestors, nearest first (a child sits in its parent's children array). */
function ancestorsOf(component: ComponentInstance): ComponentInstance[] {
  const out: ComponentInstance[] = [];
  let node: unknown = component;
  while (node && hasParent(node as never, 2)) {
    node = getParent(node as never, 2);
    if (!node || typeof node !== 'object' || !('props' in (node as object))) break;
    out.push(node as ComponentInstance);
  }
  return out;
}

const STYLE_LIMITS = {
  kept:
    'Kept readable on the published page: the total, the notices and the pay wording must stay visible, so this part and the parts around it keep type, colour, box, border, layout and small hover lifts, and leave out positioning, masks, clips, outlines wider than a focus ring, large transforms or filters and very small type.',
  beside:
    'Next to the total, a notice or the pay button: this element is published without positioning, z-index, click-through, negative margins, large transforms or wide outlines, so it never covers them.',
} as const;

/**
 * The properties panel's word on what the published page leaves out of this node's
 * styles, for a part kept in sight, a wrapper around one, or a node beside one
 * (src/lib/commerce/parts.ts, shopStyleLimit). Null for anything else.
 */
export const ShopStyleNote = observer(({ component }: { component: ComponentInstance }) => {
  const limit = shopStyleLimit(component, ancestorsOf(component));
  if (!limit) return null;
  return (
    <div
      data-testid="shop-style-note"
      className="mx-3 my-2 flex items-start gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-2 text-[11px] leading-snug text-muted-foreground"
    >
      <Info size={12} className="mt-0.5 flex-none" aria-hidden />
      <span>{STYLE_LIMITS[limit]}</span>
    </div>
  );
});
ShopStyleNote.displayName = 'ShopStyleNote';
