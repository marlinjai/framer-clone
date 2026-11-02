// The component panel, mounted for real on a real root store: Create component
// through its dialog, a placement's section (values, refusals, resets, binding to
// a collection's rows), the "This site" list, and Make input inside a definition.
// Over the four stateful paths: forward, backtrack (reset, undo), resume (a
// snapshot round trip into a fresh store) and re-entry (the definition or an input
// gone while the panel shows them).
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { applySnapshot, getSnapshot } from 'mobx-state-tree';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import type { ProjectModelType } from '@/models/ProjectModel';
import type { PlacementProps } from '@/lib/components/placement';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import type { DataSourceProvider } from '@/lib/bindings/dataSource/provider';
import { requestCreateComponent } from '@/lib/components/editorCommands';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

import RightSidebar from '../../RightSidebar';
import ComponentsPanel from '../../left/ComponentsPanel';
import ComponentDialogs from '@/components/ComponentDialogs';
import { getComponentCategory, SECTION_MAP } from '../sectionConfig';

afterEach(() => cleanup());

const provider: DataSourceProvider = {
  listCollections: async () => [],
  getCollection: async () => ({ id: 'col', name: 'Posts', columns: [{ id: 'title', name: 'Title', type: 'text' }] }) as never,
  listRows: async () => ({ rows: [] }) as never,
  getRow: async () => null,
  subscribe: () => () => {},
};

const INPUTS = [
  { id: 'title', name: 'Title', type: 'text', default: 'Card title' },
  { id: 'count', name: 'Count', type: 'number', min: 0, max: 10 },
  { id: 'badge', name: 'Badge', type: 'toggle', default: false },
  { id: 'tone', name: 'Tone', type: 'choice', options: [{ label: 'Light', value: 'light' }, { label: 'Dark', value: 'dark' }] },
  { id: 'href', name: 'Link', type: 'link' },
];

function setup() {
  store = createRootStore();
  store.projectStore.ingestProjectSnapshot({
    id: 'site',
    metadata: { title: 'Site' },
    pages: {},
    components: {
      card: {
        id: 'card',
        name: 'Card',
        page: {
          id: 'card-page',
          metadata: { title: 'Card' },
          appComponentTree: {
            id: 'c-root', type: 'article', componentType: 'host', props: {},
            children: [{ id: 'c-title', type: 'h3', componentType: 'host', props: { children: 'Stored' }, children: [], bindings: { children: { mode: 'read', expression: '{{input.title}}' } } }],
          },
          canvasNodes: {},
        },
        inputs: INPUTS,
        states: [{ id: 'open', name: 'Open', kind: 'custom' }],
      },
    } as never,
  });
  const project = store.projectStore.getProject('site') as ProjectModelType;
  const page = project.createPage('Home');
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  getHistoryStore()?.clear();
  return { project, page };
}

const mount = (ui: React.ReactNode) =>
  render(<DataSourceProviderContext.Provider value={provider}>{ui}</DataSourceProviderContext.Provider>);

function placeCard(project: ProjectModelType, pageId: string): ComponentInstance {
  const result = project.placeComponent(pageId, 'card', { kind: 'appTree' });
  if (!result.ok) throw new Error(result.message);
  store.editorUI.selectComponent(result.placement);
  getHistoryStore()?.clear();
  return result.placement;
}

const inputsOf = (node: ComponentInstance) => (node.props as Partial<PlacementProps>).inputs;

async function type(label: string, value: string) {
  const field = screen.getByLabelText(label);
  await act(async () => {
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value } });
  });
  await act(async () => fireEvent.keyDown(field, { key: 'Enter' }));
}

describe('a placement in the right panel', () => {
  it('shows only Component, Size, Position and Effects', () => {
    const { project, page } = setup();
    const node = placeCard(project, page.id);
    expect(getComponentCategory(node)).toBe('placement');
    expect(SECTION_MAP.placement).toEqual(['component', 'size', 'position', 'effects']);
    mount(<RightSidebar />);
    expect(screen.getByTestId('component-section')).toBeTruthy();
    expect(screen.queryByTestId('text-content-section')).toBeNull();
  });

  it('forward: each live type writes a parsed value as one step, and a refused one is not stored', async () => {
    const { project, page } = setup();
    const node = placeCard(project, page.id);
    mount(<RightSidebar />);
    await type('Title', 'Hello');
    expect(inputsOf(node)).toEqual({ title: 'Hello' });
    expect(getHistoryStore()?.history.length).toBe(1);
    await type('Count', '42');
    expect(screen.getByRole('alert').textContent).toMatch(/Not stored/);
    expect(inputsOf(node)?.count).toBeUndefined();
    await type('Count', '7');
    expect(inputsOf(node)?.count).toBe(7);
    await act(async () => fireEvent.click(screen.getByRole('switch', { name: 'Badge' })));
    expect(inputsOf(node)?.badge).toBe(true);
    await act(async () => fireEvent.change(screen.getByLabelText('Tone'), { target: { value: 'dark' } }));
    expect(inputsOf(node)?.tone).toBe('dark');
    await type('Link', 'javascript:alert(1)');
    expect(inputsOf(node)?.href).toBeUndefined();
    await type('Link', '/about');
    expect(inputsOf(node)?.href).toBe('/about');
    await act(async () => fireEvent.change(screen.getByLabelText('Initial state'), { target: { value: 'open' } }));
    expect(node.props.state).toBe('open');
  });

  it('backtrack: a row resets to the default, Reset all clears everything as one step, and undo restores it', async () => {
    const { project, page } = setup();
    const node = placeCard(project, page.id);
    node.setProps({ inputs: { title: 'Mine', tone: 'dark' }, state: 'open' });
    getHistoryStore()?.clear();
    mount(<RightSidebar />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Reset Title' })));
    expect(inputsOf(node)).toEqual({ tone: 'dark' });
    expect((screen.getByLabelText('Title') as HTMLInputElement).placeholder).toBe('Card title');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Reset all/ })));
    expect(inputsOf(node)).toBeUndefined();
    expect(node.props.state).toBeUndefined();
    await act(async () => getHistoryStore()?.undo());
    expect(inputsOf(node)).toEqual({ tone: 'dark' });
    expect(node.props.state).toBe('open');
  });

  it('binds an input to a row of the collection around it', async () => {
    const { project, page } = setup();
    const root = page.appComponentTree as unknown as ComponentInstance;
    root.addChildren([createIntrinsicComponent('list', 'div', { 'data-component-kind': 'collection' })]);
    const list = root.children.find((c: ComponentInstance) => c.id === 'list')!;
    list.setBinding('collection', { mode: 'read', expression: 'col' });
    const placed = project.placeComponent(page.id, 'card', { kind: 'parent', parentId: 'list' });
    if (!placed.ok) throw new Error(placed.message);
    store.editorUI.selectComponent(placed.placement);
    mount(<RightSidebar />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Bind Title' })));
    const option = await screen.findByRole('button', { name: /\{\{row\.title\}\}/ });
    await act(async () => fireEvent.click(option));
    expect(placed.placement.bindings['input.title']).toEqual({ mode: 'read', expression: '{{row.title}}' });
  });

  it('resume: values survive a snapshot into a fresh store and show again', () => {
    const { project, page } = setup();
    const node = placeCard(project, page.id);
    node.setProps({ inputs: { title: 'Kept' } });
    const saved = JSON.parse(JSON.stringify(getSnapshot(project)));
    store = createRootStore();
    store.projectStore.ingestProjectSnapshot(saved);
    const again = store.projectStore.getProject('site')!;
    const home = again.findPageById(page.id)!;
    store.editorUI.setCurrentProject(again);
    store.editorUI.setCurrentPage(home);
    store.editorUI.selectComponent(home.findComponent(node.id)!);
    mount(<RightSidebar />);
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Kept');
  });

  it('re-entry: a removed input drops its row, and a deleted definition leaves a missing note', async () => {
    const { project, page } = setup();
    placeCard(project, page.id);
    mount(<RightSidebar />);
    await act(async () => { project.removeInput('card', 'count'); });
    expect(screen.queryByLabelText('Count')).toBeNull();
    // Another tab's save, or an undo: the definition goes and the placement stays.
    await act(async () => { applySnapshot(project.components, {}); });
    expect(screen.getByTestId('component-missing')).toBeTruthy();
  });
});

describe('Create component', () => {
  it('names the selection in the dialog, places it, and one undo takes it back', async () => {
    const { project, page } = setup();
    const root = page.appComponentTree as unknown as ComponentInstance;
    root.addChildren([createIntrinsicComponent('hero', 'section', { children: 'Hi' })]);
    store.editorUI.selectComponent(root.children.find((c: ComponentInstance) => c.id === 'hero'));
    getHistoryStore()?.clear();
    mount(<ComponentDialogs />);
    await act(async () => requestCreateComponent(store.editorUI));
    const name = screen.getByLabelText('Component name');
    await act(async () => fireEvent.change(name, { target: { value: 'Card' } }));
    await act(async () => fireEvent.submit(name.closest('form')!));
    expect(screen.getByRole('alert').textContent).toMatch(/already a component called Card/);
    await act(async () => fireEvent.change(name, { target: { value: 'Hero' } }));
    await act(async () => fireEvent.submit(name.closest('form')!));
    expect(store.editorUI.componentRequest).toBeNull();
    expect(project.components.size).toBe(2);
    expect(store.editorUI.selectedComponent?.type).toBe('#component');
    expect(getHistoryStore()?.history.length).toBe(1);
    await act(async () => getHistoryStore()?.undo());
    expect(project.components.size).toBe(1);
    expect(root.children.some((c: ComponentInstance) => c.id === 'hero')).toBe(true);
  });

  it('refuses the page itself before opening anything', () => {
    const { page } = setup();
    store.editorUI.selectComponent(page.appComponentTree as unknown as ComponentInstance);
    requestCreateComponent(store.editorUI);
    expect(store.editorUI.componentRequest).toBeNull();
    expect(store.editorUI.editorNotice?.message).toMatch(/page itself/);
  });

  it('warns that a form inside gets a new id', async () => {
    const { page } = setup();
    const root = page.appComponentTree as unknown as ComponentInstance;
    root.addChildren([createIntrinsicComponent('f', 'form', {})]);
    store.editorUI.selectComponent(root.children.find((c: ComponentInstance) => c.id === 'f'));
    mount(<ComponentDialogs />);
    await act(async () => requestCreateComponent(store.editorUI));
    expect(screen.getByTestId('component-dialog').textContent).toMatch(/past submissions/);
  });
});

describe('This site in the Components panel', () => {
  it('places by tap, counts placements, and greys a component inside itself', async () => {
    const { project, page } = setup();
    mount(<ComponentsPanel onTapPlace={(id) => project.placeComponent(page.id, id, { kind: 'appTree' })} onTapInsert={() => {}} />);
    const site = () => within(screen.getByTestId('site-components'));
    await act(async () => fireEvent.click(site().getByRole('button', { name: 'Add Card' })));
    expect(project.placementCount('card')).toBe(1);
    expect(screen.getByLabelText('1 placements')).toBeTruthy();
    await act(async () => store.editorUI.enterComponent('card'));
    const entry = site().getByRole('button', { name: 'Add Card' });
    expect(entry.getAttribute('aria-disabled')).toBe('true');
    await act(async () => fireEvent.click(entry));
    expect(project.placementCount('card')).toBe(1);
    expect(store.editorUI.editorNotice?.message).toMatch(/Card contains Card/);
  });

  it('deletes through the dialog, naming the placements, and undo brings them back', async () => {
    const { project, page } = setup();
    placeCard(project, page.id);
    mount(<><ComponentsPanel /><ComponentDialogs /></>);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'More actions for Card' })));
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: /Delete component/ })));
    expect(screen.getByTestId('component-dialog').textContent).toMatch(/placement becomes a plain copy/);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Delete component' })));
    expect(project.components.size).toBe(0);
    await act(async () => getHistoryStore()?.undo());
    expect(project.placementCount('card')).toBe(1);
  });
});

describe('Make input inside a definition', () => {
  it('turns a text into an input, offers it in the picker, and flags one that is gone', async () => {
    const { project } = setup();
    project.components.get('card')!.setInputs([]);
    project.components.get('card')!.page.findComponent('c-title')!.clearBinding('children');
    await act(async () => store.editorUI.enterComponent('card'));
    store.editorUI.selectComponent(project.components.get('card')!.page.findComponent('c-title')!);
    getHistoryStore()?.clear();
    mount(<RightSidebar />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Make Text an input' })));
    const card = project.components.get('card')!;
    expect(card.inputs).toEqual([{ id: 'text', name: 'Text', type: 'text', default: 'Stored' }]);
    expect(card.page.findComponent('c-title')!.bindings.children).toEqual({ mode: 'read', expression: '{{input.text}}' });
    expect(getHistoryStore()?.history.length).toBe(1);
    await act(async () => { card.setInputs([]); });
    await waitFor(() => expect(screen.getByText('input not found')).toBeTruthy());
  });
});
