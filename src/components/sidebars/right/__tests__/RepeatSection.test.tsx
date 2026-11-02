// A repeat made and set up through the real panels on a real root store: Repeat
// for and New list on an element of a component, the fields of a list in the
// Inputs list, and a placement's items. Each change one undo step. Over the four
// stateful paths: forward, backtrack (undo, stop repeating), resume (a snapshot
// round trip into a fresh store) and re-entry (the list removed or retyped away
// while elements repeat for it and placements hold items).
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { ProjectModelType } from '@/models/ProjectModel';
import type { PageModelType } from '@/models/PageModel';
import type { PlacementProps } from '@/lib/components/placement';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import type { DataSourceProvider } from '@/lib/bindings/dataSource/provider';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

import RightSidebar from '../../RightSidebar';
import ComponentDialogs from '@/components/ComponentDialogs';

afterEach(() => cleanup());

const provider: DataSourceProvider = {
  listCollections: async () => [], getCollection: async () => null, listRows: async () => ({ rows: [] }) as never,
  getRow: async () => null, subscribe: () => () => {},
};
const host = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, componentType: 'host', props: {}, children: [], ...extra });

function setup() {
  store = createRootStore();
  store.projectStore.ingestProjectSnapshot({
    id: 'site', metadata: { title: 'Site' }, pages: {},
    components: {
      nav: {
        id: 'nav', name: 'Nav', states: [],
        page: {
          id: 'nav-page', metadata: { title: 'Nav' },
          appComponentTree: host('n', 'ul', { children: [host('li', 'li', { props: { children: 'Home' } })] }),
          canvasNodes: {},
        },
        inputs: [
          { id: 'links', name: 'Links', type: 'list', fields: [{ id: 'label', name: 'Label', type: 'text' }, { id: 'to', name: 'To', type: 'link' }] },
          { id: 'title', name: 'Title', type: 'text' },
        ],
      },
    } as never,
  });
  const project = store.projectStore.getProject('site') as ProjectModelType;
  const home = project.createPage('Home');
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(home);
  const placed = project.placeComponent(home.id, 'nav', { kind: 'appTree' });
  if (!placed.ok) throw new Error(placed.message);
  getHistoryStore()?.clear();
  return { project, home, placement: placed.placement };
}

const mount = () => render(
  <DataSourceProviderContext.Provider value={provider}><RightSidebar /><ComponentDialogs /></DataSourceProviderContext.Provider>,
);
const nav = (project: ProjectModelType) => project.components.get('nav')!;
const li = (project: ProjectModelType) => (nav(project).page as PageModelType).findComponent('li')!;
const history = () => getHistoryStore()?.history.length ?? 0;
const undo = () => act(async () => getHistoryStore()?.undo());
const itemsOf = (node: ComponentInstance) => (node.props as Partial<PlacementProps>).inputs?.links;

function openLi(project: ProjectModelType) {
  store.editorUI.enterComponent('nav');
  store.editorUI.selectComponent(li(project));
  getHistoryStore()?.clear();
}

async function type(field: HTMLElement, value: string) {
  await act(async () => {
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value } });
  });
  await act(async () => fireEvent.keyDown(field, { key: 'Enter' }));
}

describe('Repeat for, on an element of a component', () => {
  it('forward and backtrack: repeats for a list in one step, stops repeating, and undo restores each', async () => {
    const { project } = setup();
    openLi(project);
    mount();
    const select = within(screen.getByTestId('repeat-section')).getByLabelText('Repeat for');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Nothing, shown once', 'Links']);
    await act(async () => fireEvent.change(select, { target: { value: 'links' } }));
    expect(li(project).props['data-repeat']).toBe('links');
    expect(history()).toBe(1);
    await act(async () => fireEvent.change(select, { target: { value: '__none__' } }));
    expect(li(project).props['data-repeat']).toBeUndefined();
    await undo();
    expect(li(project).props['data-repeat']).toBe('links');
    await undo();
    expect(li(project).props['data-repeat']).toBeUndefined();
  });

  it('New list adds a list with two items and repeats for it, as one step', async () => {
    const { project } = setup();
    openLi(project);
    mount();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'New list for this element' })));
    const made = nav(project).inputs.find((input) => input.id === 'items');
    expect(made).toMatchObject({ type: 'list', default: [{ text: 'Home' }, { text: 'Item 2' }] });
    expect(li(project).props['data-repeat']).toBe('items');
    expect(history()).toBe(1);
    await undo();
    expect(nav(project).inputs.some((input) => input.id === 'items')).toBe(false);
    expect(li(project).props['data-repeat']).toBeUndefined();
  });

  it('is not offered on the root or on text, and the model refuses both', () => {
    const { project } = setup();
    store.editorUI.enterComponent('nav');
    mount();
    expect(screen.queryByTestId('repeat-section')).toBeNull();
    expect(project.setRepeat('nav', 'n', 'links')).toMatchObject({ ok: false });
    expect(project.setRepeat('nav', 'li', 'title')).toMatchObject({ ok: false });
    expect(project.setRepeat('nav', 'gone', 'links')).toMatchObject({ ok: false });
  });

  it('re-entry: removing the list, or retyping it away, stops the repeat in the same step', async () => {
    const { project } = setup();
    project.setRepeat('nav', 'li', 'links');
    expect(project.inputConnectionCount('nav', 'links')).toBe(1);
    expect(project.inputTypeChangeBindingLoss('nav', { id: 'links', name: 'Links', type: 'text' })).toBe(1);
    getHistoryStore()?.clear();
    project.removeInput('nav', 'links');
    expect(li(project).props['data-repeat']).toBeUndefined();
    expect(history()).toBe(1);
    await undo();
    expect(li(project).props['data-repeat']).toBe('links');
    project.changeInputType('nav', { id: 'links', name: 'Links', type: 'text' });
    expect(li(project).props['data-repeat']).toBeUndefined();
  });

  it('says so when a stored repeat names an input that is gone', () => {
    const { project } = setup();
    li(project).setProps({ 'data-repeat': 'nope' });
    openLi(project);
    mount();
    expect(screen.getByTestId('repeat-section').textContent).toMatch(/input that is gone/);
  });
});

describe('the fields of a list, in the Inputs list', () => {
  it('keeps the ids of fields it keeps, and asks before values go', async () => {
    const { project, placement } = setup();
    placement.setProps({ inputs: { links: [{ label: 'One', to: '/one' }] } });
    store.editorUI.enterComponent('nav');
    getHistoryStore()?.clear();
    mount();
    const field = screen.getByLabelText('Fields of Links');
    expect((field as HTMLInputElement).value).toBe('Label, To: link');
    await type(field, 'Label, To: link, Icon: image');
    expect(screen.queryByTestId('component-dialog')).toBeNull();
    expect(nav(project).inputs[0].fields?.map((f) => f.id)).toEqual(['label', 'to', 'icon']);
    expect(itemsOf(placement)).toEqual([{ label: 'One', to: '/one' }]);
    await type(screen.getByLabelText('Fields of Links'), 'Label: number');
    const dialog = within(screen.getByTestId('component-dialog'));
    expect(dialog.getByText(/1 placement loses its value/)).toBeTruthy();
    await act(async () => fireEvent.click(dialog.getByRole('button', { name: 'Change options' })));
    expect(itemsOf(placement)).toBeUndefined();
    await type(screen.getByLabelText('Fields of Links'), 'Label: choice');
    expect(screen.getByRole('alert').textContent).toMatch(/a field is text, number/);
  });
});

describe('the items of a placement', () => {
  it('adds, fills, moves and removes items, each one step, and refuses an unsafe address in place', async () => {
    const { placement } = setup();
    store.editorUI.selectComponent(placement);
    mount();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add item to Links' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add item to Links' })));
    await type(screen.getByLabelText('Label of Links item 1'), 'One');
    await type(screen.getByLabelText('Label of Links item 2'), 'Two');
    await type(screen.getByLabelText('To of Links item 2'), 'javascript:alert(1)');
    expect(screen.getByRole('alert').textContent).toMatch(/Not stored/);
    expect(itemsOf(placement)).toEqual([{ label: 'One' }, { label: 'Two' }]);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Move Links item 2 up' })));
    expect(itemsOf(placement)).toEqual([{ label: 'Two' }, { label: 'One' }]);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Remove Links item 1' })));
    expect(itemsOf(placement)).toEqual([{ label: 'One' }]);
    getHistoryStore()?.clear();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Remove Links item 1' })));
    expect(itemsOf(placement)).toEqual([]);
    expect(history()).toBe(1);
    expect(screen.getByText(/No items: nothing of it shows/)).toBeTruthy();
    await undo();
    expect(itemsOf(placement)).toEqual([{ label: 'One' }]);
  });

  it('resume: items survive a snapshot round trip, and re-entry: a retype away leaves no stale row', async () => {
    const { project, placement } = setup();
    placement.setProps({ inputs: { links: [{ label: 'Kept', to: '/k' }] } });
    const saved = JSON.parse(JSON.stringify(getSnapshot(project)));
    store = createRootStore();
    store.projectStore.ingestProjectSnapshot(saved);
    const reloaded = store.projectStore.getProject('site') as ProjectModelType;
    const again = (reloaded.pages.values().next().value as PageModelType).appComponentTree.children[0] as ComponentInstance;
    expect(itemsOf(again)).toEqual([{ label: 'Kept', to: '/k' }]);
    store.editorUI.setCurrentProject(reloaded);
    store.editorUI.setCurrentPage(reloaded.pages.values().next().value as PageModelType);
    store.editorUI.selectComponent(again);
    mount();
    expect((screen.getByLabelText('Label of Links item 1') as HTMLInputElement).value).toBe('Kept');
    await act(async () => reloaded.changeInputType('nav', { id: 'links', name: 'Links', type: 'text' }));
    expect(screen.queryByLabelText('Label of Links item 1')).toBeNull();
    expect(itemsOf(again)).toBeUndefined();
  });

  it('a gallery adds an image by its address, and refuses an unsafe one', async () => {
    const { project, placement } = setup();
    project.changeInputType('nav', { id: 'links', name: 'Links', type: 'gallery' });
    store.editorUI.selectComponent(placement);
    mount();
    await type(screen.getByLabelText('New image for Links'), 'javascript:alert(1)');
    expect(screen.getByRole('alert').textContent).toMatch(/Not stored/);
    expect(itemsOf(placement)).toBeUndefined();
    await type(screen.getByLabelText('New image for Links'), '/a.jpg');
    await type(screen.getByLabelText('Image of Links item 1 description'), 'A');
    expect(itemsOf(placement)).toEqual([{ src: '/a.jpg', alt: 'A' }]);
  });
});
