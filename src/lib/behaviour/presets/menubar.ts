// src/lib/behaviour/presets/menubar.ts
//
// A menubar: top items in a row, each opening its own menu. Left and Right move along the
// bar, and from inside a menu close it and move on; Down, Enter and Space open a menu on its
// first item, Up on its last; Escape closes it and gives the focus back to its top item;
// Home, End and a printable key work on the bar and in a menu. A press on a top item opens
// its menu, or closes it when it is the one open. See
// docs/plans/2026-11-02-behaviour-model.md, "Presets".
//
// Which menu is open is one number on the bar, -1 for none, so opening one closes any
// other. The bar's keys sit on each top item rather than on the bar, so a key pressed
// inside a menu never reaches them. Without a script the top items are links and every
// menu is a list of links under its item.
//
// PURE: no React, no MST.

import type { Action, Expression, Trigger } from '../format';
import { assertSeed, derived, el, onKeys, propsOf, stateIdOn, type PresetNode } from './nodes';

export const MENUBAR_VERSION = 1;

export interface MenubarMenu {
  title: string;
  href: string;
  items: { title: string; href: string }[];
}

export interface MenubarOptions {
  seed: string;
  label?: string;
  menus?: MenubarMenu[];
}

const DEFAULT_MENUS: readonly MenubarMenu[] = [
  { title: 'Products', href: '/products', items: [{ title: 'New', href: '/products/new' }, { title: 'Sale', href: '/products/sale' }] },
  { title: 'About', href: '/about', items: [{ title: 'Team', href: '/about/team' }, { title: 'Jobs', href: '/about/jobs' }] },
];

/** None of the menus. */
const NONE = -1;
/** How long after the key that opened it a menu's item takes the focus: a frame, once the menu shows. */
const FOCUS_AFTER_MS = 16;

const LINK_STYLE = { display: 'block', padding: '10px 12px', minHeight: '44px', boxSizing: 'border-box', color: 'inherit', textDecoration: 'none' };
const MENU_STYLE = { position: 'absolute', top: '100%', left: '0', zIndex: 10, margin: '0', padding: '4px', listStyle: 'none', minWidth: '180px', border: '1px solid #e5e5e5', borderRadius: '8px', background: '#fff' };

const roleOf = (node: PresetNode): unknown => propsOf(node).role;

/** Writes every generated entry from the bar's slots, each holding a top item and its menu. */
export function deriveMenubar(root: PresetNode): PresetNode {
  const bar = root.id;
  const open = stateIdOn(root, 'open');
  const go = (group: string, move: 'next' | 'prev' | 'first' | 'last' | 'type') => ({ rove: group, move });
  const set = (value: number): Action => ({ set: open, value });
  const slots = (root.children ?? []).filter((child) => child.children?.some((at) => roleOf(at) === 'menu'));

  const slot = (node: PresetNode): PresetNode => {
    const index = slots.indexOf(node);
    const top = node.children?.find((child) => roleOf(child) === 'menuitem');
    const menu = node.children?.find((child) => roleOf(child) === 'menu');
    if (index === -1 || !top || !menu) return node;
    const into = (move: 'first' | 'last'): Action[] => [set(index), { delay: FOCUS_AFTER_MS, do: [go(menu.id, move)] }];
    // The one menu open is this one: a press closes it, otherwise opens it.
    const flip: Expression = { map: open, cases: { [String(index)]: NONE }, default: index };
    const away = (move: 'next' | 'prev'): Trigger => onKeys(`away-${move}`, [move === 'next' ? 'InlineEnd' : 'InlineStart'], set(NONE), go(bar, move));
    return {
      ...node,
      children: node.children?.map((child) => {
        if (child === top) {
          return derived({ ...child, props: { ...child.props, 'aria-haspopup': 'menu', 'aria-controls': menu.id } as PresetNode['props'] }, {
            bind: [{ attr: 'aria-expanded', from: { eq: [{ get: open }, index] } }],
            on: [
              { id: 'press', on: 'click', prevent: true, do: [{ set: open, value: flip }] },
              onKeys('open-first', ['ArrowDown', 'Enter', 'Space'], ...into('first')),
              onKeys('open-last', ['ArrowUp'], ...into('last')),
              onKeys('next', ['InlineEnd'], set(NONE), go(bar, 'next')),
              onKeys('prev', ['InlineStart'], set(NONE), go(bar, 'prev')),
              onKeys('first', ['Home'], go(bar, 'first')),
              onKeys('last', ['End'], go(bar, 'last')),
              { id: 'type', on: 'keydown', keys: ['Printable'], do: [go(bar, 'type')] },
            ],
          });
        }
        if (child !== menu) return child;
        return derived(child, {
          showWhen: { state: open, eq: index },
          group: { role: 'menuitem', axis: 'line', wrap: true },
          on: [
            onKeys('next', ['ArrowDown'], go(menu.id, 'next')),
            onKeys('prev', ['ArrowUp'], go(menu.id, 'prev')),
            onKeys('first', ['Home'], go(menu.id, 'first')),
            onKeys('last', ['End'], go(menu.id, 'last')),
            { id: 'type', on: 'keydown', keys: ['Printable'], do: [go(menu.id, 'type')] },
            { id: 'close', on: 'keydown', keys: ['Escape'], do: [set(NONE), { focus: top.id }] },
            away('next'),
            away('prev'),
          ],
        });
      }),
    };
  };

  return derived({ ...root, children: root.children?.map(slot) }, {
    state: [{ id: open, name: 'Open menu', type: 'number', initial: NONE, min: NONE, max: Math.max(NONE, slots.length - 1) }],
    group: { role: 'menuitem', axis: 'line', wrap: true },
    preset: { kind: 'menubar', version: MENUBAR_VERSION },
  });
}

export function menubar({ seed, label = 'Site', menus = [...DEFAULT_MENUS] }: MenubarOptions): PresetNode {
  assertSeed(seed);
  return deriveMenubar(
    el(seed, 'ul', { role: 'menubar', 'aria-label': label, style: { display: 'flex', flexWrap: 'wrap', gap: '4px', margin: '0', padding: '0', listStyle: 'none' } },
      ...menus.map((menu, index) => {
        const id = `${seed}-${index}`;
        return el(id, 'li', { role: 'none', style: { position: 'relative' } },
          el(`${id}-top`, 'a', { role: 'menuitem', href: menu.href, children: menu.title, style: LINK_STYLE }),
          el(`${id}-menu`, 'ul', {
            id: `${id}-menu`,
            role: 'menu',
            'aria-label': menu.title,
            style: MENU_STYLE,
            // Without the gate every menu is a list of links under its item, covering nothing.
            rules: [{ id: 'in-flow', selector: '&', gate: 'off', style: { position: 'static', border: '0', padding: '0 0 0 12px' } }],
          },
            ...menu.items.map((item, at) => el(`${id}-item-${at}`, 'li', { role: 'none' },
              el(`${id}-link-${at}`, 'a', { role: 'menuitem', href: item.href, children: item.title, style: LINK_STYLE })))));
      })),
  );
}
