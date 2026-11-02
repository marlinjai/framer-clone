// A preset dropped from the palette, over the four stateful paths: forward (it lands whole
// as one step), backtrack (undo), resume (a snapshot round trip keeps every mark), and
// re-entry (a second drop and a duplicate stay apart from the first).

import { getSnapshot } from 'mobx-state-tree';
import { describe, expect, it } from 'vitest';
import { readBehaviourTree } from '@/lib/behaviour/format';
import { getComponentEntry, listComponentsByCategory } from '@/lib/componentRegistry';
import HistoryStore from '@/stores/HistoryStore';
import ProjectStore from '@/stores/ProjectStore';
import ComponentModel, { type ComponentInstance } from '@/models/ComponentModel';
import type { ProjectModelType } from '@/models/ProjectModel';

const INTERACTIVE = ['tabs', 'toolbar', 'tooltip', 'carousel', 'menu-button', 'menubar', 'combobox', 'slider-multithumb', 'windowsplitter', 'feed', 'dataGrid', 'treeview', 'treegrid'];

type Stored = { id: string; type: string; props: Record<string, unknown>; parentId?: string; label?: string; children: Stored[] };

function setup() {
  const store = ProjectStore.create({});
  store.ingestProjectSnapshot({ id: 'site', metadata: { title: 'Site' }, pages: {}, components: {} });
  const project = store.getProject('site') as ProjectModelType;
  const page = project.createPage('Home');
  page.setSlug('');
  const history = HistoryStore.create({});
  history.setTargetStore(store);
  history.clear();
  return { page, history, root: page.appComponentTree as unknown as ComponentInstance };
}

const stored = (node: ComponentInstance): Stored => JSON.parse(JSON.stringify(getSnapshot(node))) as Stored;
const walk = (node: Stored): Stored[] => [node, ...node.children.flatMap(walk)];
const refused = (node: Stored) => readBehaviourTree(node as never).refused;

describe('a preset from the palette', () => {
  it('is on offer under its own heading', () => {
    expect(listComponentsByCategory('interactive').map((entry) => entry.id)).toEqual(INTERACTIVE);
  });

  it.each(INTERACTIVE)('%s lands whole, with every child knowing its parent', (id) => {
    const { page } = setup();
    const placed = page.insertRegistryComponent(id, { kind: 'appTree' }) as ComponentInstance;
    const node = stored(placed);
    expect(placed.label).toBe(getComponentEntry(id)?.label);
    expect((node.props.behaviour as { preset: { kind: string } }).preset.kind).toBe(getComponentEntry(id)?.preset);
    expect(refused(node)).toEqual([]);
    const check = (parent: Stored) => parent.children.forEach((child) => {
      expect(child.parentId).toBe(parent.id);
      check(child);
    });
    check(node);
  });

  it('lands on the canvas outside a frame too', () => {
    const { page } = setup();
    const placed = page.insertRegistryComponent('tabs', { kind: 'floating', x: 120.4, y: 80.6 }) as ComponentInstance;
    expect(placed.canvasX).toBe(120);
    expect(placed.canvasY).toBe(81);
    expect(placed.isFloatingElement).toBe(true);
    expect(page.canvasNodes.get(placed.id)).toBe(placed);
    expect(placed.children.length).toBe(4);
  });

  it('is one undo step, and redo puts it back the same', () => {
    const { page, history, root } = setup();
    const count = root.children.length;
    const placed = page.insertRegistryComponent('tabs', { kind: 'appTree' }) as ComponentInstance;
    const before = stored(placed);
    expect(root.children.length).toBe(count + 1);
    history.undo();
    expect(root.children.length).toBe(count);
    history.redo();
    expect(stored(root.children[root.children.length - 1] as ComponentInstance)).toEqual(before);
  });

  it('keeps every mark through a snapshot', () => {
    const { page } = setup();
    const node = stored(page.insertRegistryComponent('carousel', { kind: 'appTree' }) as ComponentInstance);
    const again = stored(ComponentModel.create(JSON.parse(JSON.stringify(node))));
    expect(again).toEqual(node);
    expect(refused(again)).toEqual([]);
  });

  it('a second drop shares no id and no state with the first', () => {
    const { page } = setup();
    const ids = (node: Stored) => walk(node).map((at) => at.id);
    const domIds = (node: Stored) => walk(node).flatMap((at) => (typeof at.props.id === 'string' ? [at.props.id] : []));
    const one = stored(page.insertRegistryComponent('tabs', { kind: 'appTree' }) as ComponentInstance);
    const two = stored(page.insertRegistryComponent('tabs', { kind: 'appTree' }) as ComponentInstance);
    expect(ids(one).filter((id) => ids(two).includes(id))).toEqual([]);
    expect(domIds(one).filter((id) => domIds(two).includes(id))).toEqual([]);
    const state = (node: Stored) => (node.props.behaviour as { state: { id: string }[] }).state[0].id;
    expect(state(one)).not.toBe(state(two));
  });

  it('a duplicate points at its own panels, and its behaviour at its own list', () => {
    const { page } = setup();
    const placed = page.insertRegistryComponent('tabs', { kind: 'appTree' }) as ComponentInstance;
    const original = stored(placed);
    const copy = stored(page.duplicateComponent(placed.id) as ComponentInstance);
    const domIds = (node: Stored) => walk(node).flatMap((at) => (typeof at.props.id === 'string' ? [at.props.id] : []));
    expect(domIds(copy).filter((id) => domIds(original).includes(id))).toEqual([]);
    const held = new Set(domIds(copy));
    for (const at of walk(copy)) {
      for (const name of ['aria-controls', 'aria-labelledby']) {
        if (typeof at.props[name] === 'string') expect(held.has(at.props[name] as string)).toBe(true);
      }
    }
    const list = copy.children[0];
    const keys = (list.props.behaviour as { on: { do: { rove: string }[] }[] }).on;
    expect(keys[0].do[0].rove).toBe(list.id);
    expect(refused(copy)).toEqual([]);
  });

  it('a preset\'s nodes still find their own registry entry, so a text in one stays bindable', async () => {
    const { getRegistryIdForNode } = await import('@/components/sidebars/right/registryId');
    const { page } = setup();
    const placed = page.insertRegistryComponent('menu-button', { kind: 'appTree' }) as ComponentInstance;
    const button = placed.children[0] as ComponentInstance;
    expect(button.id.startsWith('menu-')).toBe(true);
    expect(getRegistryIdForNode(button)).toBe('button');
    const tabs = page.insertRegistryComponent('tabs', { kind: 'appTree' }) as ComponentInstance;
    expect(getRegistryIdForNode(tabs.children[0].children[0] as ComponentInstance)).toBe('button');
    // The data grid's seed is its entry's, not the layout grid's.
    const grid = page.insertRegistryComponent('dataGrid', { kind: 'appTree' }) as ComponentInstance;
    expect(grid.id.startsWith('datagrid-')).toBe(true);
    expect(getRegistryIdForNode(grid)).not.toBe('grid');
  });

  it('a duplicate of something with no preset keeps an id nothing points at', () => {
    const { page, root } = setup();
    root.addChildren([ComponentModel.create({ id: 'plain', type: 'div', componentType: 'host', props: { id: 'keep' } } as never)]);
    const copy = stored(page.duplicateComponent('plain') as ComponentInstance);
    expect(copy.props.id).toBe('keep');
  });
});
