// src/lib/behaviour/presets/menu.ts
//
// A menu button: a native popover opened by its button, with the keys the Authoring
// Practices list. Enter, Space and Down open it on the first item, Up on the last; Down and
// Up wrap, Home and End go to the ends, a printable key goes to the next item starting with
// it, and Escape closes it and gives the focus back. Choosing an item closes it too. See
// docs/plans/2026-11-02-behaviour-model.md, "Presets" and "Prototyped before freezing".
//
// The popover is native, so it opens without a script and its items are reached by Tab.
// Its own `toggle` writes the state, so `aria-expanded` follows light dismiss and Escape.
//
// PURE: no React, no MST.

import type { Trigger } from '../format';
import { assertSeed, derived, el, onKeys, propsOf, stateIdOn, type PresetNode } from './nodes';

export const MENU_VERSION = 1;

export interface MenuButtonOptions {
  seed: string;
  label?: string;
  items?: string[];
}

/** How long after the press that opened it the first item takes the focus: a frame. */
const FOCUS_AFTER_MS = 16;

const BUTTON_STYLE = { padding: '8px 16px', minHeight: '44px', font: 'inherit', cursor: 'pointer' };
const MENU_STYLE = { margin: '0', padding: '4px', minWidth: '160px', border: '1px solid #e5e5e5', borderRadius: '8px', background: '#fff', inset: 'auto' };
const ITEM_STYLE = { display: 'block', width: '100%', minHeight: '44px', padding: '8px 12px', border: '0', background: 'none', font: 'inherit', textAlign: 'start', cursor: 'pointer' };

const isMenu = (node: PresetNode): boolean => propsOf(node).role === 'menu';

/** Writes every generated entry on the root, its button and its menu. */
export function deriveMenuButton(root: PresetNode): PresetNode {
  const children = root.children ?? [];
  const menu = children.find(isMenu);
  if (!menu) return root;
  const open = stateIdOn(root, 'open');
  const go = (move: 'next' | 'prev' | 'first' | 'last' | 'type') => ({ rove: menu.id, move });
  const show = { popover: menu.id, op: 'show' as const };
  const button = children.find((child) => child !== menu);

  const item = (node: PresetNode): PresetNode => (propsOf(node).role === 'menuitem'
    ? derived(node, { on: [{ id: 'choose', on: 'click', do: [{ popover: menu.id, op: 'hide' }, ...(button ? [{ focus: button.id }] : [])] }] })
    : node);

  const menuOn: Trigger[] = [
    { id: 'sync', on: 'toggle', do: [{ set: open, value: { eq: [{ event: 'newState' }, 'open'] } }] },
    onKeys('next', ['ArrowDown'], go('next')),
    onKeys('prev', ['ArrowUp'], go('prev')),
    onKeys('first', ['Home'], go('first')),
    onKeys('last', ['End'], go('last')),
    { id: 'type', on: 'keydown', keys: ['Printable'], do: [go('type')] },
  ];

  return derived({
    ...root,
    children: children.map((child) => {
      if (child === menu) {
        return { ...derived(child, { group: { role: 'menuitem', axis: 'line', wrap: true }, on: menuOn }), children: child.children?.map(item) };
      }
      if (child !== button) return child;
      return derived({ ...child, props: { ...child.props, popoverTarget: menu.id, 'aria-controls': menu.id } as PresetNode['props'] }, {
        bind: [{ attr: 'aria-expanded', from: { get: open } }],
        on: [
          onKeys('down', ['ArrowDown'], show, go('first')),
          onKeys('up', ['ArrowUp'], show, go('last')),
          { id: 'press', on: 'click', do: [{ delay: FOCUS_AFTER_MS, do: [go('first')] }] },
        ],
      });
    }),
  }, {
    state: [{ id: open, name: 'Menu open', type: 'boolean', initial: false }],
    preset: { kind: 'menu-button', version: MENU_VERSION },
  });
}

export function menuButton({ seed, label = 'Actions', items = ['Copy', 'Paste', 'Delete'] }: MenuButtonOptions): PresetNode {
  assertSeed(seed);
  const menu = `${seed}-menu`;
  return deriveMenuButton(
    el(seed, 'div', {},
      el(`${seed}-button`, 'button', { type: 'button', 'aria-haspopup': 'menu', children: label, style: BUTTON_STYLE }),
      el(menu, 'div', { id: menu, popover: 'auto', role: 'menu', 'aria-label': label, style: MENU_STYLE },
        ...items.map((text, index) => el(`${seed}-item-${index}`, 'button', { type: 'button', role: 'menuitem', children: text, style: ITEM_STYLE })))),
  );
}
