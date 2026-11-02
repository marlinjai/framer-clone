// src/lib/behaviour/presets/tabs.ts
//
// Tabs, from the WAI-ARIA Authoring Practices: Left and Right (Up and Down when vertical),
// Home and End, automatic activation, one Tab stop. See
// docs/plans/2026-11-02-behaviour-model.md, "Presets".
//
// Activation follows focus through a trigger on each tab, so the keys only have to move
// the focus. A press selects and takes the focus along, since a browser that does not focus
// a button on click would otherwise leave the Tab stop behind. Without a script the tab
// list is hidden and every panel shows in order.
//
// The state is a number on hand placed tabs too, so a Collection and a hand placed list
// differ only in where the index comes from.
//
// PURE: no React, no MST.

import type { Binding, Expression, RowIndex, Trigger } from '../format';
import { assertSeed, copyItem, derived, el, initialOf, onKeys, propsOf, stateIdOn, withProps, type PresetNode } from './nodes';

export const TABS_VERSION = 1;

export interface TabItem {
  title: string;
  body: string;
}

export interface TabsOptions {
  seed: string;
  label?: string;
  items?: TabItem[];
  orientation?: 'horizontal' | 'vertical';
}

export interface CollectionTabsOptions {
  seed: string;
  label?: string;
  /** The source collection's id, or a template expression holding it. */
  collection: string;
  titleField: string;
  bodyField: string;
}

const DEFAULT_ITEMS: readonly TabItem[] = [
  { title: 'First', body: 'What the first tab says.' },
  { title: 'Second', body: 'What the second tab says.' },
  { title: 'Third', body: 'What the third tab says.' },
];

const ACTIVE = 'active';
const GROUP = { role: 'tab', axis: 'line', wrap: true } as const;
const LIST_STYLE = { display: 'flex', gap: '4px', overflowX: 'auto', borderBottom: '1px solid #e5e5e5' };
const VERTICAL_LIST_STYLE = { display: 'flex', flexDirection: 'column', gap: '4px' };
const TAB_STYLE = { padding: '8px 16px', minHeight: '44px', border: '0', background: 'none', font: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap' };
const PANEL_STYLE = { padding: '16px 0' };

const isTab = (node: PresetNode): boolean => propsOf(node).role === 'tab';
const isPanel = (node: PresetNode): boolean => propsOf(node).role === 'tabpanel';
const isList = (node: PresetNode): boolean => propsOf(node).role === 'tablist';

/** The keys on a tab list. They move the focus, and each tab selects itself when it gets it. */
function listKeys(group: string, vertical: boolean): Trigger[] {
  const go = (move: 'next' | 'prev' | 'first' | 'last') => ({ rove: group, move });
  return [
    onKeys('next', [vertical ? 'ArrowDown' : 'InlineEnd'], go('next')),
    onKeys('prev', [vertical ? 'ArrowUp' : 'InlineStart'], go('prev')),
    onKeys('first', ['Home'], go('first')),
    onKeys('last', ['End'], go('last')),
  ];
}

/** What selects a tab, wherever its index comes from. */
function tabEntries(key: string, state: string, index: number | RowIndex): { on: Trigger[]; bind: Binding[] } {
  const value: Expression = index;
  const select = { set: state, value };
  return {
    on: [{ id: 'focus', on: 'focus', do: [select] }, { id: 'click', on: 'click', do: [select, { focus: key }] }],
    bind: [{ attr: 'aria-selected', from: { eq: [{ get: state }, value] } }],
  };
}

/**
 * Writes every generated entry from the tabs and panels the root holds, in their order.
 * Keeps what a person added, and the first tab where it still exists.
 */
export function deriveTabs(root: PresetNode): PresetNode {
  const children = root.children ?? [];
  const list = children.find(isList);
  if (!list) return root;
  const state = stateIdOn(root, ACTIVE);
  const tabList = (list.children ?? []).filter(isTab);
  const panels = children.filter(isPanel);
  const last = Math.max(0, tabList.length - 1);

  const tab = (node: PresetNode): PresetNode => {
    const index = tabList.indexOf(node);
    return derived(withProps(node, { id: node.id, 'aria-controls': panels[index]?.id }), tabEntries(node.id, state, index));
  };
  const panel = (node: PresetNode): PresetNode => {
    const index = panels.indexOf(node);
    return derived(withProps(node, { id: node.id, 'aria-labelledby': tabList[index]?.id }), { showWhen: { state, eq: index } });
  };
  const nextList = derived(list, {
    noScript: 'hide',
    group: GROUP,
    on: listKeys(list.id, propsOf(list)['aria-orientation'] === 'vertical'),
  });

  return derived({
    ...root,
    children: children.map((child) => {
      if (child === list) return { ...nextList, children: list.children?.map((item) => (isTab(item) ? tab(item) : item)) };
      return isPanel(child) ? panel(child) : child;
    }),
  }, {
    state: [{ id: state, name: 'Active tab', type: 'number', initial: Math.min(initialOf(root, state), last), min: 0, max: last }],
    preset: { kind: 'tabs', version: TABS_VERSION },
  });
}

const tabNode = (id: string, title: string): PresetNode =>
  el(id, 'button', { type: 'button', role: 'tab', children: title, style: TAB_STYLE });

const panelNode = (id: string, body: string): PresetNode =>
  el(id, 'div', { role: 'tabpanel', tabIndex: 0, children: body, style: PANEL_STYLE });

export function tabs({ seed, label = 'Sections', items = [...DEFAULT_ITEMS], orientation = 'horizontal' }: TabsOptions): PresetNode {
  assertSeed(seed);
  const vertical = orientation === 'vertical';
  return deriveTabs(
    el(seed, 'div', {},
      el(`${seed}-list`, 'div', {
        role: 'tablist',
        'aria-label': label,
        ...(vertical ? { 'aria-orientation': 'vertical' } : {}),
        style: vertical ? VERTICAL_LIST_STYLE : LIST_STYLE,
      }, ...items.map((item, index) => tabNode(`${seed}-tab-${index}`, item.title))),
      ...items.map((item, index) => panelNode(`${seed}-panel-${index}`, item.body))),
  );
}

/**
 * Tabs and panels from one source, as two Collections over the same rows: tab 3 selects
 * panel 3. A row has no id a binding can read, and a binding is one whole value, so nothing
 * here can give a panel an id of its own per row: a tab has no `aria-controls`, and a panel
 * takes its name from the row's title instead of from its tab.
 */
export function collectionTabs({ seed, label = 'Sections', collection, titleField, bodyField }: CollectionTabsOptions): PresetNode {
  assertSeed(seed);
  const state = `${seed}-${ACTIVE}`;
  const list = `${seed}-list`;
  const tab = `${seed}-tab`;
  const panel = `${seed}-panel`;
  const read = (expression: string) => ({ mode: 'read' as const, expression });
  const collectionOf = (node: PresetNode): PresetNode => ({ ...node, bindings: { collection: read(collection) } });
  const tabTemplate: PresetNode = {
    ...tabNode(tab, ''),
    bindings: { children: read(`{{row.${titleField}}}`) },
  };
  const panelTemplate: PresetNode = {
    ...panelNode(panel, ''),
    bindings: { children: read(`{{row.${bodyField}}}`), 'aria-label': read(`{{row.${titleField}}}`) },
  };
  return derived(
    el(seed, 'div', {},
      derived(
        collectionOf(el(list, 'div', { 'data-component-kind': 'collection', role: 'tablist', 'aria-label': label, style: LIST_STYLE },
          derived(tabTemplate, tabEntries(tab, state, { row: 'index' })))),
        { noScript: 'hide', group: GROUP, on: listKeys(list, false) },
      ),
      collectionOf(el(`${seed}-panels`, 'div', { 'data-component-kind': 'collection' },
        derived(panelTemplate, { showWhen: { state, eq: { row: 'index' } } })))),
    {
      state: [{ id: state, name: 'Active tab', type: 'number', initial: 0, min: 0 }],
      preset: { kind: 'tabs', version: TABS_VERSION },
    },
  );
}

/** One more tab and panel, cloned from the last, with every generated entry derived again. */
export function addTab(root: PresetNode, item: TabItem): PresetNode {
  const children = root.children ?? [];
  const list = children.find(isList);
  const lastTab = list?.children?.filter(isTab).at(-1);
  const lastPanel = children.filter(isPanel).at(-1);
  if (!list || !lastTab || !lastPanel) return root;
  const tab = withProps(copyItem(root, lastTab), { children: item.title });
  const panel = withProps(copyItem(root, lastPanel), { children: item.body });
  const at = children.lastIndexOf(lastPanel) + 1;
  return deriveTabs({
    ...root,
    children: [
      ...children.slice(0, at).map((child) => (child === list ? { ...list, children: [...(list.children ?? []), tab] } : child)),
      panel,
      ...children.slice(at),
    ],
  });
}

/** Takes a tab and its panel out. The last one stays: a tab list with no tabs is no tab list. */
export function removeTab(root: PresetNode, index: number): PresetNode {
  const children = root.children ?? [];
  const list = children.find(isList);
  const tabList = list?.children?.filter(isTab) ?? [];
  const panels = children.filter(isPanel);
  if (!list || tabList.length < 2 || !tabList[index]) return root;
  return deriveTabs({
    ...root,
    children: children
      .filter((child) => child !== panels[index])
      .map((child) => (child === list ? { ...list, children: list.children?.filter((item) => item !== tabList[index]) } : child)),
  });
}
