'use client';
// src/components/ShopPreviewBar.tsx
//
// Which state a shop control shows on the canvas (designable shop controls,
// docs/plans/2026-11-02-designable-shop-controls.md): a small bar in the editor's
// notice stack while a shop control, or a part inside one, is selected. Like the
// product preview picker, it changes what the canvas shows and nothing that is
// saved. It also says, quietly, that orders are placed on the published site
// only, which is why the canvas never runs the checkout.
//
// Selecting a part the current state hides (the pay button while the canvas shows
// the ready state, from the Layers panel) switches to the first state that shows
// it, so a selection never lands on something invisible.

import React, { useEffect } from 'react';
import { observer } from 'mobx-react-lite';
import { getParent, hasParent } from 'mobx-state-tree';
import { useStore } from '@/hooks/useStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import { SHOP_CONTROLS, shopControlKindOf, shopLocaleOf, shopPartRoleOf } from '@/lib/commerce/parts';
import { checkoutStateShowing, checkoutStateShows } from '@/lib/renderer/commerce/CheckoutButton';

/** The shop control a node is or sits in, with the part roles from the control down to the node. */
export function shopControlAround(node: ComponentInstance | undefined): { control: ComponentInstance; roles: string[] } | undefined {
  const roles: string[] = [];
  let current: unknown = node;
  for (let i = 0; i < 256 && current; i++) {
    const candidate = current as ComponentInstance;
    if (shopControlKindOf(candidate.props)) return { control: candidate, roles: roles.reverse() };
    const role = shopPartRoleOf(candidate.props);
    if (role) roles.push(role);
    let parent: unknown = undefined;
    let walker: object = candidate;
    // The MST parent of a child is its parent's children array; step past it.
    while (hasParent(walker)) {
      walker = getParent(walker);
      if (!Array.isArray(walker)) {
        parent = walker;
        break;
      }
    }
    current = parent && typeof parent === 'object' && 'props' in parent ? parent : undefined;
  }
  return undefined;
}

const ShopPreviewBar = observer(() => {
  const { editorUI } = useStore();
  const found = shopControlAround(editorUI.selectedComponent);
  const locale = shopLocaleOf(editorUI.currentProject?.siteSettings?.language);
  const controlId = found?.control.id;
  const kind = found ? shopControlKindOf(found.control.props) : undefined;
  const spec = kind ? SHOP_CONTROLS[kind] : undefined;
  const current = (controlId && editorUI.shopPreviewStates[controlId]) || spec?.states[0]?.id;
  const rolesKey = found?.roles.join('|') ?? '';

  useEffect(() => {
    if (!found || !controlId || !current || found.roles.length === 0) return;
    if (checkoutStateShows(current, found.roles, locale)) return;
    const showing = checkoutStateShowing(found.roles, locale);
    if (showing) editorUI.setShopPreviewState(controlId, showing);
    // The roles stand for the selection; `found` is a new object each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlId, rolesKey, current, locale, editorUI]);

  if (!found || !spec || !controlId) return null;
  return (
    <div
      data-editor-ui="true"
      data-shop-preview-bar=""
      className="pointer-events-auto flex max-w-[640px] flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 shadow"
    >
      <label className="flex items-center gap-2">
        <span className="shrink-0">Showing</span>
        <select
          aria-label="Shop control state to show"
          value={current}
          onChange={(event) => editorUI.setShopPreviewState(controlId, event.target.value)}
          className="min-w-0 max-w-[260px] rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900"
        >
          {spec.states.map((state) => (
            <option key={state.id} value={state.id}>
              {state.label}
            </option>
          ))}
        </select>
      </label>
      <span className="text-gray-500">Sample data. Orders are placed on the published site only.</span>
    </div>
  );
});

export default ShopPreviewBar;
