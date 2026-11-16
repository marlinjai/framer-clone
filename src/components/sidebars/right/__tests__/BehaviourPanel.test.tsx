// The Page state panel and the Interactions section in the real RightSidebar, on a real
// store with its undo history, through the four paths of the stateful flow standard:
// forward, backtrack and revise, resume from what is saved, and re-entry. See
// docs/plans/2026-11-02-behaviour-model.md, "The panel" and "Stateful paths".
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import { openProject } from '@/stores/openProject';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import type { ProjectModelType } from '@/models/ProjectModel';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import { InMemoryDataSourceProvider } from '@/lib/bindings/dataSource/inMemoryProvider';
import { EditorTool } from '@/stores/EditorUIStore';
import { surfaceBehaviour } from '@/lib/behaviour/surfaceBehaviour';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

import RightSidebar from '../../RightSidebar';

let project: ProjectModelType;
let root: ComponentInstance;
let main: ComponentInstance;
let button: ComponentInstance;
let drawer: ComponentInstance;

const behaviourOf = (node: ComponentInstance) => (node.props as { behaviour?: Record<string, unknown> }).behaviour;
const history = () => getHistoryStore()!;

function setUp() {
  store = createRootStore();
  store.projectStore.createProject('Panel');
  project = store.projectStore.findProjectByTitle('Panel')!;
  const page = project.findPageBySlug('')!;
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  history().setTargetStore(project);
  root = page.appComponentTree as ComponentInstance;
  main = root.children[0] as ComponentInstance;
  main.addChildren([
    createIntrinsicComponent('menu-button', 'button', { children: 'Menu' }),
    createIntrinsicComponent('drawer', 'nav', { children: 'Links' }),
  ]);
  button = main.children.find((c: ComponentInstance) => c.id === 'menu-button')!;
  drawer = main.children.find((c: ComponentInstance) => c.id === 'drawer')!;
}

function mount() {
  return render(
    <DataSourceProviderContext.Provider value={new InMemoryDataSourceProvider()}>
      <RightSidebar />
    </DataSourceProviderContext.Provider>,
  );
}

const select = (node: ComponentInstance) => act(() => store.editorUI.selectComponent(node));
const interactions = () => within(screen.getByTestId('interactions-section'));
const pageState = () => within(screen.getByTestId('page-state-panel'));

/** Types into a field that commits on Enter. */
function typeAndCommit(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
  fireEvent.keyDown(field, { key: 'Enter' });
}

/** Adds an on or off value to the page and names it. */
function addPageValue(name: string): string {
  fireEvent.click(pageState().getByRole('button', { name: 'Add a value to the page' }));
  const states = (behaviourOf(root)?.state ?? []) as { id: string; name: string }[];
  const added = states[states.length - 1];
  typeAndCommit(pageState().getByLabelText(`Name of ${added.name}`), name);
  return added.id;
}

/** Opens the add form, picks the event and saves. Actions start as the form suggests. */
function addInteraction(event: string, before?: () => void) {
  fireEvent.click(interactions().getByRole('button', { name: 'Add interaction' }));
  fireEvent.change(interactions().getByLabelText('Event'), { target: { value: event } });
  before?.();
  fireEvent.click(interactions().getByRole('button', { name: 'Add this interaction' }));
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  setUp();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('forward', () => {
  it('declares a value, makes a button toggle it, and shows the drawer only while it is on', () => {
    mount();
    select(button);
    const menu = addPageValue('Menu open');
    expect(behaviourOf(root)).toEqual({ state: [{ id: menu, name: 'Menu open', type: 'boolean', initial: false }] });

    addInteraction('click');
    const on = behaviourOf(button)?.on as { id: string; on: string; do: unknown[] }[];
    expect(on).toHaveLength(1);
    expect(on[0]).toMatchObject({ on: 'click', do: [{ toggle: menu }] });
    expect(interactions().getByText('On click, toggle Menu open')).toBeTruthy();

    select(drawer);
    fireEvent.change(interactions().getByLabelText('Show when value'), { target: { value: menu } });
    expect(behaviourOf(drawer)).toEqual({ showWhen: { state: menu, eq: true } });
    fireEvent.click(interactions().getByRole('switch'));
    expect(behaviourOf(drawer)).toEqual({ showWhen: { state: menu, eq: true }, noScript: 'hide' });

    // What the canvas shows follows the preview control in the Page state panel.
    const shown = () => surfaceBehaviour(store.editorUI.currentPage!.expansion.root, store.editorUI.previewState).problems;
    fireEvent.change(pageState().getByLabelText('Preview Menu open'), { target: { value: 'true' } });
    expect(store.editorUI.previewState).toEqual({ [menu]: true });
    expect(shown()).toEqual([]);
  });

  it('every edit is one undo step, and committing the same value is none', () => {
    mount();
    select(button);
    const before = history().undoIdx;
    const id = addPageValue('Open');
    expect(history().undoIdx).toBe(before + 2); // add, then rename
    typeAndCommit(pageState().getByLabelText('Name of Open'), 'Open');
    expect(history().undoIdx).toBe(before + 2);
    addInteraction('click');
    expect(history().undoIdx).toBe(before + 3);
    act(() => history().undo());
    expect(behaviourOf(button)).toBeUndefined();
    expect((behaviourOf(root)?.state as { id: string }[])[0].id).toBe(id);
  });

  it('writes an interaction from All events, with the browser response stopped', () => {
    mount();
    select(button);
    const hit = addPageValue('Hit');
    addInteraction('dragover', () => {
      fireEvent.change(interactions().getByLabelText('Action 1'), { target: { value: 'set' } });
      fireEvent.change(interactions().getByLabelText('New value in action 1'), { target: { value: 'true' } });
      fireEvent.click(within(interactions().getByRole('group', { name: 'Interaction' })).getAllByRole('switch')[0]);
    });
    expect((behaviourOf(button)?.on as unknown[])[0]).toMatchObject({ on: 'dragover', prevent: true, do: [{ set: hit, value: true }] });
  });

  it('each type of value takes only what it can hold, and says why it refused', () => {
    mount();
    select(button);
    addPageValue('Size');
    fireEvent.change(pageState().getByLabelText('Type of Size'), { target: { value: 'number' } });
    const size = () => (behaviourOf(root)?.state as Record<string, unknown>[])[0];
    expect(size()).toMatchObject({ type: 'number', initial: 0 });
    typeAndCommit(pageState().getByLabelText('Lowest of Size'), '5');
    expect(screen.getByRole('alert').textContent).toContain('initial is outside min and max');
    expect(size().min).toBeUndefined();
    typeAndCommit(pageState().getByLabelText('First value of Size'), '7');
    typeAndCommit(pageState().getByLabelText('Lowest of Size'), '5');
    expect(size()).toMatchObject({ initial: 7, min: 5 });

    fireEvent.change(pageState().getByLabelText('Type of Size'), { target: { value: 'choice' } });
    typeAndCommit(pageState().getByLabelText('Options of Size'), 'small, small');
    expect(screen.getByRole('alert').textContent).toContain('two options are the same');
    typeAndCommit(pageState().getByLabelText('Options of Size'), 'small, large');
    expect(size()).toMatchObject({ type: 'choice', options: ['small', 'large'], initial: 'small' });

    typeAndCommit(pageState().getByLabelText('Name of Size'), '   ');
    expect(screen.getByRole('alert').textContent).toContain('a state needs a name');
    expect(size().name).toBe('Size');
  });

  it('refuses an interaction the parser refuses, writes nothing, and says why', () => {
    mount();
    select(button);
    addPageValue('Open');
    const before = history().undoIdx;
    addInteraction('mouseenter', () => {
      fireEvent.change(interactions().getByLabelText('Action 1'), { target: { value: 'focus' } });
    });
    expect(screen.getByRole('alert').textContent).toMatch(/Not saved: .*(focus|click|press)/i);
    expect(behaviourOf(button)).toBeUndefined();
    expect(history().undoIdx).toBe(before);
    fireEvent.click(interactions().getByRole('button', { name: 'Cancel' }));
    expect(interactions().queryByRole('group', { name: 'Interaction' })).toBeNull();
  });

  it('takes an address that leaves the site only as a safe link, typed by a person', () => {
    mount();
    select(button);
    addInteraction('click', () => {
      fireEvent.change(interactions().getByLabelText('Action 1'), { target: { value: 'navigate' } });
      const address = interactions().getByLabelText('Address in action 1');
      fireEvent.change(address, { target: { value: 'javascript:alert(1)' } });
      expect(interactions().getByRole('alert').textContent).toContain('Use a page path');
      fireEvent.change(address, { target: { value: 'https://example.com/book' } });
      expect(interactions().getByText(/Leaves the site/)).toBeTruthy();
    });
    expect((behaviourOf(button)?.on as unknown[])[0]).toMatchObject({ on: 'click', do: [{ navigate: 'https://example.com/book' }] });
  });

  it('works in the phone sheet too', () => {
    render(
      <DataSourceProviderContext.Provider value={new InMemoryDataSourceProvider()}>
        <RightSidebar variant="sheet" />
      </DataSourceProviderContext.Provider>,
    );
    select(button);
    addPageValue('Open');
    addInteraction('click');
    expect(interactions().getByText('On click, toggle Open')).toBeTruthy();
  });
});

describe('backtrack and revise', () => {
  it('deleting a value marks what reads it refused, visibly, and one undo restores it all', () => {
    mount();
    select(button);
    const menu = addPageValue('Menu open');
    addInteraction('click');
    select(drawer);
    fireEvent.change(interactions().getByLabelText('Show when value'), { target: { value: menu } });

    const before = history().undoIdx;
    fireEvent.click(pageState().getByRole('button', { name: 'Delete Menu open' }));
    expect(history().undoIdx).toBe(before + 1);
    expect(interactions().getByText(/Shown always: .*menu|Shown always:/)).toBeTruthy();
    select(button);
    expect(interactions().getByText(/Does not run:/)).toBeTruthy();
    // The entries stay stored, so the person sees what broke and can fix or delete it.
    expect((behaviourOf(button)?.on as unknown[])).toHaveLength(1);

    act(() => history().undo());
    expect(interactions().queryByText(/Does not run:/)).toBeNull();
    expect(interactions().getByText('On click, toggle Menu open')).toBeTruthy();
  });

  it('renaming a value changes nothing else, since references use the id', () => {
    mount();
    select(button);
    const menu = addPageValue('Menu open');
    addInteraction('click');
    const stored = JSON.stringify(behaviourOf(button));
    typeAndCommit(pageState().getByLabelText('Name of Menu open'), 'Drawer open');
    expect(JSON.stringify(behaviourOf(button))).toBe(stored);
    expect(interactions().getByText('On click, toggle Drawer open')).toBeTruthy();
    expect((behaviourOf(root)?.state as { id: string }[])[0].id).toBe(menu);
  });

  it('a preview stays only while its value can still hold it', () => {
    mount();
    select(button);
    const size = addPageValue('Size');
    fireEvent.change(pageState().getByLabelText('Type of Size'), { target: { value: 'choice' } });
    typeAndCommit(pageState().getByLabelText('Options of Size'), 'small, medium, large');
    fireEvent.change(pageState().getByLabelText('Preview Size'), { target: { value: 'large' } });
    expect(store.editorUI.previewState).toEqual({ [size]: 'large' });

    // The same options again keeps it.
    typeAndCommit(pageState().getByLabelText('Options of Size'), 'small, medium, large, huge');
    expect(store.editorUI.previewState).toEqual({ [size]: 'large' });
    // Taking its option away drops it from the preview itself, not only from what shows.
    typeAndCommit(pageState().getByLabelText('Options of Size'), 'small, medium');
    expect(store.editorUI.previewState).toEqual({});

    fireEvent.change(pageState().getByLabelText('Preview Size'), { target: { value: 'medium' } });
    fireEvent.change(pageState().getByLabelText('Type of Size'), { target: { value: 'boolean' } });
    expect(store.editorUI.previewState).toEqual({});
  });

  it('editing an interaction keeps every field it holds that the panel has no control for', () => {
    mount();
    select(button);
    const menu = addPageValue('Open');
    act(() => {
      button.setBehaviour({ on: [{ id: 'mine', on: 'click', if: { state: menu, eq: false }, do: [{ toggle: menu }] }] });
    });
    fireEvent.click(interactions().getByRole('button', { name: /^Edit: / }));
    expect(interactions().getByText(/Also holds a condition/)).toBeTruthy();
    fireEvent.change(interactions().getByLabelText('Event'), { target: { value: 'keydown' } });
    fireEvent.change(interactions().getByLabelText('Keys'), { target: { value: 'Enter' } });
    fireEvent.click(interactions().getByRole('button', { name: 'Save this interaction' }));
    expect(behaviourOf(button)).toEqual({ on: [{ id: 'mine', on: 'keydown', keys: ['Enter'], if: { state: menu, eq: false }, do: [{ toggle: menu }] }] });
  });

  it('an open editor whose interaction an undo changed closes instead of saving over it', () => {
    mount();
    select(button);
    addPageValue('Open');
    addInteraction('click');
    fireEvent.click(interactions().getByRole('button', { name: /^Edit: / }));
    expect(interactions().getByRole('group', { name: 'Interaction' })).toBeTruthy();
    act(() => history().undo());
    expect(interactions().queryByRole('group', { name: 'Interaction' })).toBeNull();
  });

  it('shows what a preset wrote with its mark, and offers no edit that the preset would undo', () => {
    mount();
    const tabs = store.editorUI.currentPage!.insertRegistryComponent('tabs', { kind: 'appTree' })!;
    select(tabs);
    expect(pageState().getByText(/Made by a preset/)).toBeTruthy();
    expect(pageState().queryByRole('button', { name: /^Delete Active tab/ })).toBeNull();
  });
});

describe('a preset\'s items', () => {
  it('a tab is added and taken out through the preset, one undo step each', () => {
    mount();
    const tabs = store.editorUI.currentPage!.insertRegistryComponent('tabs', { kind: 'appTree' })!;
    select(tabs);
    const group = () => within(interactions().getByRole('group', { name: 'Tabs' }));
    expect(group().getByText('3 tabs, made from a preset')).toBeTruthy();
    const before = history().undoIdx;
    fireEvent.click(group().getByRole('button', { name: 'Add tab' }));
    expect(group().getByText('4 tabs, made from a preset')).toBeTruthy();
    expect(history().undoIdx).toBe(before + 1);
    fireEvent.change(group().getByLabelText('Remove a tab'), { target: { value: '0' } });
    expect(group().getByText('3 tabs, made from a preset')).toBeTruthy();
    expect(Array.from((group().getByLabelText('Remove a tab') as HTMLSelectElement).options).map((o) => o.text)).toEqual(['Remove a tab', 'Second', 'Third', 'Tab 4']);
    act(() => history().undo());
    act(() => history().undo());
    expect(group().getByText('3 tabs, made from a preset')).toBeTruthy();
    expect(Array.from((group().getByLabelText('Remove a tab') as HTMLSelectElement).options).map((o) => o.text)).toEqual(['Remove a tab', 'First', 'Second', 'Third']);
  });

  it('a carousel gains a slide', () => {
    mount();
    const slides = store.editorUI.currentPage!.insertRegistryComponent('carousel', { kind: 'appTree' })!;
    select(slides);
    fireEvent.click(within(interactions().getByRole('group', { name: 'Slides' })).getByRole('button', { name: 'Add slide' }));
    expect(interactions().getByText('4 slides, made from a preset')).toBeTruthy();
  });
});

describe('resume', () => {
  it('a saved page reads back with every row, and a refused entry with its reason; previews and drafts do not come back', () => {
    mount();
    select(button);
    const menu = addPageValue('Menu open');
    addInteraction('click');
    act(() => drawer.setBehaviour({ showWhen: { state: 'gone', eq: true } }));
    fireEvent.change(pageState().getByLabelText('Preview Menu open'), { target: { value: 'true' } });
    fireEvent.click(interactions().getByRole('button', { name: 'Add interaction' }));
    const saved = JSON.parse(JSON.stringify(getSnapshot(project)));
    cleanup();

    // A fresh editor opened on what was saved, through the loader the editor uses.
    store = createRootStore();
    openProject(store, saved, null, 1);
    const page = store.editorUI.currentPage!;
    mount();
    act(() => store.editorUI.selectComponent(page.findComponent('menu-button')!));
    expect(interactions().getByText('On click, toggle Menu open')).toBeTruthy();
    expect(interactions().queryByRole('group', { name: 'Interaction' })).toBeNull();
    expect(store.editorUI.previewState).toEqual({});
    expect((pageState().getByLabelText('Preview Menu open') as HTMLSelectElement).value).toBe('');
    act(() => store.editorUI.selectComponent(page.findComponent('drawer')!));
    expect(interactions().getByText(/Shown always: .*gone/)).toBeTruthy();
    expect(menu).toMatch(/^v-/);
  });
});

describe('re-entry', () => {
  it('a half-typed draft on one element never lands on another', () => {
    mount();
    select(button);
    addPageValue('Open');
    fireEvent.click(interactions().getByRole('button', { name: 'Add interaction' }));
    fireEvent.change(interactions().getByLabelText('Event'), { target: { value: 'mouseenter' } });
    select(drawer);
    expect(interactions().queryByRole('group', { name: 'Interaction' })).toBeNull();
    select(button);
    expect(interactions().queryByRole('group', { name: 'Interaction' })).toBeNull();
    expect(behaviourOf(drawer)).toBeUndefined();
    expect(behaviourOf(button)).toBeUndefined();
  });

  it('the selected element going away leaves the panel standing, and its values with the page', () => {
    mount();
    select(button);
    addPageValue('Open');
    act(() => {
      store.editorUI.clearSelection();
      main.removeChild(button.id);
    });
    expect(screen.queryByTestId('interactions-section')).toBeNull();
    expect(pageState().getByLabelText('Name of Open')).toBeTruthy();
  });

  it('in Interact the preview is off, since the page runs from its first values', () => {
    mount();
    select(button);
    addPageValue('Open');
    act(() => store.editorUI.setSelectedTool(EditorTool.INTERACT));
    expect((pageState().getByLabelText('Preview Open') as HTMLSelectElement).disabled).toBe(true);
    expect(pageState().getByText(/runs in Interact/)).toBeTruthy();
    act(() => store.editorUI.setSelectedTool(EditorTool.SELECT));
    expect((pageState().getByLabelText('Preview Open') as HTMLSelectElement).disabled).toBe(false);
  });

  it('offers no Interactions for a frame, a text run or a placement, and Keep per row inside a list', () => {
    mount();
    select(root);
    expect(screen.queryByTestId('interactions-section')).toBeTruthy();
    act(() => store.editorUI.setSelectedViewportNode(store.editorUI.currentPage!.sortedViewportNodes[0]));
    expect(screen.queryByTestId('interactions-section')).toBeNull();

    act(() => {
      main.addChildren([createIntrinsicComponent('list', 'div', { 'data-component-kind': 'collection' })]);
      (main.children.find((c: ComponentInstance) => c.id === 'list') as ComponentInstance).addChildren([createIntrinsicComponent('card', 'article', {})]);
    });
    select(store.editorUI.currentPage!.findComponent('card')!);
    expect(pageState().getByRole('button', { name: /^Keep per row/ })).toBeTruthy();
    fireEvent.click(pageState().getByRole('button', { name: /^Keep per row/ }));
    expect(behaviourOf(store.editorUI.currentPage!.findComponent('card')!)?.state).toHaveLength(1);
    expect(pageState().getByRole('group', { name: 'Values of Article' })).toBeTruthy();
  });
});
