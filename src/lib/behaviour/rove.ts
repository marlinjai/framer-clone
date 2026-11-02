// src/lib/behaviour/rove.ts
//
// Focus groups: moving through a toolbar, a menu, a list of options, a grid or a tree.
// A chunk of its own beside the runtime, fetched only by a program with a group. See
// docs/plans/2026-11-02-behaviour-model.md, "Actions" and "Prototyped before freezing".
//
// A group's items are the descendants with its role that can be seen and belong to no
// nearer group, read from what is rendered each time, so `filter`, a closed branch and a
// hidden panel need no bookkeeping. An axis decides what a move means:
//
//   line  next, prev, first, last, up and down along the items
//   grid  items are cells. next and prev stay in the row, up and down keep the column,
//         first and last are the row's ends, or the grid's with Ctrl held
//   tree  next and prev run through what is visible, up goes to the parent item and
//         down into the first child
//
// In a normal group the focus moves and one item holds the Tab stop. The server writes
// no `tabindex`, so without a script every item is reachable by Tab. In a virtual group
// the focus stays on the owner, which names the active item in `aria-activedescendant`.
//
// Directions need nothing here: a chord resolves `InlineEnd` against the writing direction,
// and a move follows reading order.
//
// PURE and client-safe: no React, no MST.

import type { Rove } from './format';
import { attrOf, closestTo, every, hasAttr, holds, isElement, parentOf, setAttr, toggleAttr, upFrom } from './dom';
import type { CreateRover, Kit, Run } from './program';

const ACTIVE_ATTR = 'data-u-active';
/** Items or rows a Page Up or Page Down moves by. */
const PAGE = 5;
const TYPEAHEAD_MS = 500;
const FOCUSABLE = 'a[href],area[href],button,input,select,textarea,summary,iframe,audio[controls],video[controls],[contenteditable],[tabindex]';

const isShown = (el: Element): boolean => el.getClientRects().length > 0;
const textOf = (el: Element): string => (el.textContent ?? '').trim();
const clamp = (value: number, high: number): number => Math.min(high, Math.max(0, value));

export const createRover: CreateRover = (kit: Kit) => {
  let typed = '';
  let typedAt = 0;

  /** The group's visible items, nearest group only, so a nested menu keeps its own. */
  const itemsOf = (group: Element, role: string): HTMLElement[] => {
    const found = every(group, `[role="${role}"]`);
    kit.charge(found.length);
    return found.filter((item) => {
      for (const at of upFrom(parentOf(item))) {
        if (at === group) break;
        if (kit.entryOf(at)?.group) return false;
      }
      return isShown(item);
    });
  };

  const specOf = (group: Element) => kit.entryOf(group)?.group;

  const indexIn = (items: HTMLElement[], group: Element, role: string, virtual: boolean): number => {
    if (virtual) return items.findIndex((item) => hasAttr(item, ACTIVE_ATTR));
    const current = kit.doc.activeElement;
    const focused = current ? (closestTo(current, `[role="${role}"]`) as HTMLElement | null) : null;
    const at = focused && holds(group, focused) ? items.indexOf(focused) : -1;
    return at !== -1 ? at : items.findIndex((item) => item.tabIndex === 0);
  };

  const along = (index: number, by: number, count: number, wrap: boolean): number => {
    const next = index + by;
    if (wrap) return (next + count) % count;
    return index === -1 && by < 0 ? 0 : clamp(next, count - 1);
  };

  const typeahead = (items: HTMLElement[], index: number, event: KeyboardEvent): number => {
    const now = event.timeStamp;
    const key = event.key.toLowerCase();
    typed = now - typedAt < TYPEAHEAD_MS ? typed + key : key;
    typedAt = now;
    const same = [...typed].every((char) => char === key);
    const needle = same ? key : typed;
    const start = same ? index + 1 : Math.max(index, 0);
    const rotated = [...items.slice(start), ...items.slice(0, start)];
    const hit = rotated.find((item) => textOf(item).toLowerCase().startsWith(needle));
    return hit ? items.indexOf(hit) : index;
  };

  const lineMove = (move: Rove, index: number, count: number, wrap: boolean): number => {
    if (move === 'first') return 0;
    if (move === 'last') return count - 1;
    if (move === 'page-down') return clamp(index + PAGE, count - 1);
    if (move === 'page-up') return clamp(index - PAGE, count - 1);
    return along(index, move === 'next' || move === 'down' ? 1 : -1, count, wrap);
  };

  const gridMove = (items: HTMLElement[], move: Rove, index: number, wrap: boolean, event: Event | null): number => {
    const rows = new Map<Element, HTMLElement[]>();
    for (const cell of items) {
      const row = closestTo(cell, '[role="row"],tr') ?? parentOf(cell) as Element;
      rows.set(row, [...(rows.get(row) ?? []), cell]);
    }
    const table = [...rows.values()];
    const y = Math.max(0, table.findIndex((row) => row.includes(items[index])));
    const cells = table[y];
    const x = Math.max(0, cells.indexOf(items[index]));
    const at = (row: number, column: number): number => items.indexOf(table[row][clamp(column, table[row].length - 1)]);
    const wide = (event as KeyboardEvent | null)?.ctrlKey === true;
    if (move === 'first') return wide ? 0 : at(y, 0);
    if (move === 'last') return wide ? items.length - 1 : at(y, cells.length - 1);
    if (move === 'next' || move === 'prev') return at(y, along(x, move === 'next' ? 1 : -1, cells.length, wrap));
    if (move === 'up' || move === 'down') return at(along(y, move === 'down' ? 1 : -1, table.length, wrap), x);
    return at(clamp(y + (move === 'page-down' ? PAGE : -PAGE), table.length - 1), x);
  };

  const treeMove = (items: HTMLElement[], move: Rove, index: number, role: string, wrap: boolean): number => {
    const item = items[index] as HTMLElement | undefined;
    if (move === 'up') {
      const above = item ? parentOf(item) : null;
      const parent = above ? (closestTo(above, `[role="${role}"]`) as HTMLElement | null) : null;
      return parent ? items.indexOf(parent) : index;
    }
    if (move === 'down') {
      const child = item ? items.find((other) => other !== item && holds(item, other)) : undefined;
      return child ? items.indexOf(child) : index;
    }
    return lineMove(move, index, items.length, wrap);
  };

  const tabStop = (items: HTMLElement[], chosen: HTMLElement): void => {
    for (const item of items) setAttr(item, 'tabindex', item === chosen ? '0' : '-1');
  };

  const clearActive = (group: Element, owner: Element | null): void => {
    for (const item of every(group, `[${ACTIVE_ATTR}]`)) {
      toggleAttr(item, ACTIVE_ATTR, false);
      setAttr(item, 'aria-selected', 'false');
    }
    if (owner) toggleAttr(owner, 'aria-activedescendant', false);
  };

  const makeActive = (group: Element, item: HTMLElement, owner: Element | null, key: string, index: number): void => {
    clearActive(group, owner);
    setAttr(item, ACTIVE_ATTR, '');
    setAttr(item, 'aria-selected', 'true');
    const id = attrOf(item, 'id') || `fc-${key}-${index}`;
    setAttr(item, 'id', id);
    if (owner) setAttr(owner, 'aria-activedescendant', id);
    item.scrollIntoView({ block: 'nearest' });
  };

  /** The first focusable past the group, for what has to leave a feed. */
  const leave = (group: Element, after: boolean): void => {
    const scanned = every(isElement(kit.container) ? kit.container : kit.doc.documentElement, FOCUSABLE);
    kit.charge(scanned.length);
    const all = scanned.filter((el) => el.tabIndex >= 0 && isShown(el) && !holds(group, el));
    const beyond = Node[after ? 'DOCUMENT_POSITION_FOLLOWING' : 'DOCUMENT_POSITION_PRECEDING'];
    const found = all.filter((el) => group.compareDocumentPosition(el) & beyond);
    found[after ? 0 : found.length - 1]?.focus();
  };

  const move = (key: string, to: Rove, run: Run): void => {
    const group = kit.find(key, run.el);
    const spec = group ? specOf(group) : undefined;
    if (!group || !spec) {
      kit.warn('no such group', key);
      return;
    }
    const owner = spec.virtual ? kit.find(spec.virtual.owner, run.el) : null;
    if (to === 'clear') {
      clearActive(group, owner);
      return;
    }
    if (to === 'exit-after' || to === 'exit-before') {
      leave(group, to === 'exit-after');
      return;
    }
    const items = itemsOf(group, spec.role);
    if (items.length === 0 || !kit.charge(0)) return;
    const index = indexIn(items, group, spec.role, spec.virtual !== undefined);
    const wrap = spec.wrap === true;
    let next: number;
    if (to === 'type') next = typeahead(items, index, run.event as KeyboardEvent);
    else if (spec.axis === 'grid') next = gridMove(items, to, index, wrap, run.event);
    else if (spec.axis === 'tree') next = treeMove(items, to, index, spec.role, wrap);
    else next = lineMove(to, index, items.length, wrap);
    const item = items[next];
    if (!item) return;
    if (spec.virtual) {
      makeActive(group, item, owner, key, next);
      return;
    }
    tabStop(items, item);
    item.focus();
  };

  const active = (key: string, run: Pick<Run, 'el'>): string => {
    const group = kit.find(key, run.el);
    const spec = group ? specOf(group) : undefined;
    if (!group || !spec) return '';
    const items = itemsOf(group, spec.role);
    const item = items[indexIn(items, group, spec.role, spec.virtual !== undefined)];
    return item ? textOf(item) : '';
  };

  const sync = (group: Element): void => {
    const spec = specOf(group);
    if (!spec || spec.virtual) return;
    const items = itemsOf(group, spec.role);
    const chosen = items.find((item) => attrOf(item, 'tabindex') === '0') ?? items.find((item) => attrOf(item, 'aria-selected') === 'true') ?? items[0];
    if (chosen) tabStop(items, chosen);
  };

  /** A click or a Tab into a group moves its Tab stop to what took the focus. */
  const followFocus = (event: Event): void => {
    const { target } = event;
    if (!isElement(target)) return;
    for (const at of upFrom(parentOf(target))) {
      const spec = kit.entryOf(at)?.group;
      if (!spec) continue;
      const item = closestTo(target, `[role="${spec.role}"]`) as HTMLElement | null;
      if (!spec.virtual && item && holds(at, item)) tabStop(itemsOf(at, spec.role), item);
      return;
    }
  };

  kit.container.addEventListener('focusin', followFocus, true);

  return { move, active, sync, stop: () => kit.container.removeEventListener('focusin', followFocus, true) };
};
