// The Inputs list of a component open on the canvas, mounted for real on a real
// root store with the dialog host: rename, move, a new type, new options and
// remove, each one undo step, and a change that takes values says so first. Over
// the four stateful paths: forward, backtrack (undo, a cancelled dialog), resume (a
// snapshot round trip into a fresh store) and re-entry (the input or the component
// gone while the list shows it). Also the formatted text, cursor and date controls
// of a placement.
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
  listCollections: async () => [],
  getCollection: async () => null,
  listRows: async () => ({ rows: [] }) as never,
  getRow: async () => null,
  subscribe: () => () => {},
};

const read = (expression: string) => ({ mode: 'read', expression });
const host = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, componentType: 'host', props: {}, children: [], ...extra });

function snapshot() {
  return {
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
          appComponentTree: host('c-root', 'article', {
            children: [
              host('c-title', 'h3', { props: { children: 'Stored' }, bindings: { children: read('{{input.title}}') } }),
              host('c-link', 'a', { props: { children: 'More' }, bindings: { href: read('{{input.href}}'), title: read('{{input.title}}') } }),
            ],
          }),
          canvasNodes: {},
        },
        inputs: [
          { id: 'title', name: 'Title', type: 'text', default: 'Card title' },
          { id: 'href', name: 'Link', type: 'link', default: '/' },
          { id: 'tone', name: 'Tone', type: 'choice', options: [{ label: 'Light', value: 'light' }, { label: 'Dark', value: 'dark' }], default: 'light' },
        ],
        states: [],
      },
      styled: {
        id: 'styled',
        name: 'Styled',
        page: { id: 'styled-page', metadata: { title: 'Styled' }, appComponentTree: host('s-root', 'div'), canvasNodes: {} },
        inputs: [
          { id: 'body', name: 'Body', type: 'richtext' },
          { id: 'pointer', name: 'Pointer', type: 'cursor' },
          { id: 'when', name: 'When', type: 'date' },
          { id: 'edge', name: 'Edge', type: 'border' },
        ],
        states: [],
      },
    } as never,
  };
}

function setup(): { project: ProjectModelType; home: PageModelType; placement: ComponentInstance } {
  store = createRootStore();
  store.projectStore.ingestProjectSnapshot(snapshot());
  const project = store.projectStore.getProject('site') as ProjectModelType;
  const home = project.createPage('Home');
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(home);
  const placed = project.placeComponent(home.id, 'card', { kind: 'appTree' });
  if (!placed.ok) throw new Error(placed.message);
  placed.placement.setProps({ inputs: { title: 'Mine', href: '/mine', tone: 'dark' } });
  store.editorUI.enterComponent('card');
  getHistoryStore()?.clear();
  return { project, home, placement: placed.placement };
}

const mount = () =>
  render(
    <DataSourceProviderContext.Provider value={provider}>
      <RightSidebar />
      <ComponentDialogs />
    </DataSourceProviderContext.Provider>,
  );

const card = (project: ProjectModelType) => project.components.get('card')!;
const names = (project: ProjectModelType) => card(project).inputs.map((input) => input.name);
const valuesOf = (node: ComponentInstance) => (node.props as Partial<PlacementProps>).inputs;
const history = () => getHistoryStore()?.history.length ?? 0;
const undo = () => act(async () => getHistoryStore()?.undo());

async function type(field: HTMLElement, value: string) {
  await act(async () => {
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value } });
  });
  await act(async () => fireEvent.keyDown(field, { key: 'Enter' }));
}

describe('the Inputs list of a component', () => {
  it('shows on the root of the open component only, with what each input sets', () => {
    const { project } = setup();
    mount();
    const list = within(screen.getByRole('list', { name: 'Inputs of Card' }));
    expect(list.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByTestId('definition-input-title').textContent).toContain('Sets 2 fields');
    expect(screen.getByTestId('definition-input-tone').textContent).toContain('Not connected');
    cleanup();
    store.editorUI.selectComponent((card(project).page as PageModelType).findComponent('c-title'));
    mount();
    expect(screen.queryByTestId('definition-inputs')).toBeNull();
  });

  it('forward and backtrack: rename keeps the id and the values, one step, and undo restores it', async () => {
    const { project, placement } = setup();
    mount();
    await type(screen.getByLabelText('Name of Title'), 'Heading');
    expect(names(project)).toEqual(['Heading', 'Link', 'Tone']);
    expect(card(project).inputs[0].id).toBe('title');
    expect(valuesOf(placement)?.title).toBe('Mine');
    expect(history()).toBe(1);
    await undo();
    expect(names(project)).toEqual(['Title', 'Link', 'Tone']);
  });

  it('refuses an empty name and a taken one, with the reason in place', async () => {
    const { project } = setup();
    mount();
    await type(screen.getByLabelText('Name of Title'), '  ');
    expect(screen.getByRole('alert').textContent).toMatch(/needs a name/);
    await type(screen.getByLabelText('Name of Title'), 'link');
    expect(screen.getByRole('alert').textContent).toMatch(/already has an input called link/);
    expect(names(project)).toEqual(['Title', 'Link', 'Tone']);
    expect(history()).toBe(0);
  });

  it('moves by buttons, one step each, with the ends disabled', async () => {
    const { project } = setup();
    mount();
    expect((screen.getByRole('button', { name: 'Move Title up' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Move Tone down' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Move Title down' })));
    expect(names(project)).toEqual(['Link', 'Title', 'Tone']);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Move Tone up' })));
    expect(names(project)).toEqual(['Link', 'Tone', 'Title']);
    expect(history()).toBe(2);
    await undo();
    await undo();
    expect(names(project)).toEqual(['Title', 'Link', 'Tone']);
  });

  it('a new type that takes values asks first, and its counts are the ones that go', async () => {
    const { project, placement } = setup();
    mount();
    // Link to Plain text: the placement's address is text too, but the href field cannot read text.
    await act(async () => fireEvent.change(screen.getByLabelText('Type of Link'), { target: { value: 'text' } }));
    const dialog = within(screen.getByTestId('component-dialog'));
    expect(dialog.getByText(/1 field in the component stops reading it/)).toBeTruthy();
    expect(card(project).inputs[1].type).toBe('link');
    await act(async () => fireEvent.click(dialog.getByRole('button', { name: 'Change type' })));
    expect(card(project).inputs[1].type).toBe('text');
    expect((card(project).page as PageModelType).findComponent('c-link')?.bindings.href).toBeUndefined();
    expect(valuesOf(placement)?.href).toBe('/mine');
    expect(history()).toBe(1);
    await undo();
    expect(card(project).inputs[1].type).toBe('link');
    expect((card(project).page as PageModelType).findComponent('c-link')?.bindings.href?.expression).toBe('{{input.href}}');
  });

  it('a new type that takes nothing runs at once, and a cancelled dialog changes nothing', async () => {
    const { project, placement } = setup();
    mount();
    // Plain text to Formatted text: a string is formatted text, nothing goes.
    await act(async () => fireEvent.change(screen.getByLabelText('Type of Title'), { target: { value: 'richtext' } }));
    expect(screen.queryByTestId('component-dialog')).toBeNull();
    expect(card(project).inputs[0].type).toBe('richtext');
    // Formatted text to Toggle: the placement's value and the default go, so it asks.
    await act(async () => fireEvent.change(screen.getByLabelText('Type of Title'), { target: { value: 'toggle' } }));
    const dialog = within(screen.getByTestId('component-dialog'));
    expect(dialog.getByText(/1 placement loses its value/)).toBeTruthy();
    expect(dialog.getByText(/Its default does not fit/)).toBeTruthy();
    await act(async () => fireEvent.click(dialog.getByRole('button', { name: 'Cancel' })));
    expect(card(project).inputs[0].type).toBe('richtext');
    expect(valuesOf(placement)?.title).toBe('Mine');
  });

  it('new options keep the values still among them, and ask before the rest go', async () => {
    const { project, placement } = setup();
    mount();
    const field = screen.getByLabelText('Options of Tone');
    expect((field as HTMLInputElement).value).toBe('Light = light, Dark = dark');
    await type(field, 'Light = light, Dark = dark, Sand = sand');
    expect(screen.queryByTestId('component-dialog')).toBeNull();
    expect(card(project).inputs[2].options).toHaveLength(3);
    await type(screen.getByLabelText('Options of Tone'), 'Sand = sand');
    const dialog = within(screen.getByTestId('component-dialog'));
    expect(dialog.getByText(/1 placement loses its value/)).toBeTruthy();
    await act(async () => fireEvent.click(dialog.getByRole('button', { name: 'Change options' })));
    expect(card(project).inputs[2].options).toEqual([{ label: 'Sand', value: 'sand' }]);
    expect(card(project).inputs[2].default).toBeUndefined();
    expect(valuesOf(placement)?.tone).toBeUndefined();
    await type(screen.getByLabelText('Options of Tone'), 'a, b = a');
    expect(screen.getByRole('alert').textContent).toMatch(/two options have the same value/);
  });

  it('remove takes the values and connections across the site in one step, and undo brings all back', async () => {
    const { project, placement } = setup();
    mount();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Remove Title' })));
    expect(names(project)).toEqual(['Link', 'Tone']);
    expect(valuesOf(placement)?.title).toBeUndefined();
    expect((card(project).page as PageModelType).findComponent('c-title')?.bindings.children).toBeUndefined();
    expect(history()).toBe(1);
    await undo();
    expect(names(project)).toEqual(['Title', 'Link', 'Tone']);
    expect(valuesOf(placement)?.title).toBe('Mine');
    expect((card(project).page as PageModelType).findComponent('c-title')?.bindings.children?.expression).toBe('{{input.title}}');
  });

  it('resume: an edited list survives a snapshot round trip into a fresh store', async () => {
    const { project } = setup();
    mount();
    await type(screen.getByLabelText('Name of Tone'), 'Theme');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Move Theme up' })));
    const saved = JSON.parse(JSON.stringify(getSnapshot(project)));
    cleanup();
    store = createRootStore();
    store.projectStore.ingestProjectSnapshot(saved);
    const reloaded = store.projectStore.getProject('site') as ProjectModelType;
    expect(names(reloaded)).toEqual(['Title', 'Theme', 'Link']);
    expect(card(reloaded).inputs[1].id).toBe('tone');
  });

  it('re-entry: an input removed elsewhere leaves the list, and an open dialog says it is gone', async () => {
    const { project } = setup();
    mount();
    await act(async () => fireEvent.change(screen.getByLabelText('Type of Link'), { target: { value: 'text' } }));
    await act(async () => project.removeInput('card', 'href'));
    expect(screen.queryByTestId('definition-input-href')).toBeNull();
    const dialog = within(screen.getByTestId('component-dialog'));
    expect(dialog.getByText('That input no longer exists.')).toBeTruthy();
    expect((dialog.getByRole('button', { name: /^Change (type|options)$/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the styled input controls of a placement', () => {
  function styled(): ComponentInstance {
    store = createRootStore();
    store.projectStore.ingestProjectSnapshot(snapshot());
    const project = store.projectStore.getProject('site') as ProjectModelType;
    const home = project.createPage('Home');
    store.editorUI.setCurrentProject(project);
    store.editorUI.setCurrentPage(home);
    const placed = project.placeComponent(home.id, 'styled', { kind: 'appTree' });
    if (!placed.ok) throw new Error(placed.message);
    store.editorUI.selectComponent(placed.placement);
    getHistoryStore()?.clear();
    return placed.placement;
  }

  it('formatted text is typed in its notation and stored as runs, and shown back the same way', async () => {
    const node = styled();
    mount();
    await type(screen.getByLabelText('Body'), 'Hi **there**, see [the shop](/shop)');
    expect(valuesOf(node)?.body).toEqual({
      runs: [{ text: 'Hi ' }, { text: 'there', marks: ['strong'] }, { text: ', see ' }, { text: 'the shop', href: '/shop' }],
    });
    expect((screen.getByLabelText('Body') as HTMLTextAreaElement).value).toBe('Hi **there**, see [the shop](/shop)');
    await type(screen.getByLabelText('Body'), '[bad](javascript:alert(1))');
    expect(screen.getByRole('alert').textContent).toMatch(/Not stored/);
  });

  it('a cursor is picked from the keywords it takes, a date from a date field, a border typed and checked', async () => {
    const node = styled();
    mount();
    await act(async () => fireEvent.change(screen.getByLabelText('Pointer'), { target: { value: 'grab' } }));
    expect(valuesOf(node)?.pointer).toBe('grab');
    const date = screen.getByLabelText('When') as HTMLInputElement;
    expect(date.type).toBe('date');
    await type(date, '2026-11-02');
    expect(valuesOf(node)?.when).toBe('2026-11-02');
    await type(screen.getByLabelText('Edge'), '1px solid red;background:url(https://track.example/x)');
    expect(valuesOf(node)?.edge).toBeUndefined();
    await type(screen.getByLabelText('Edge'), '1px solid red');
    expect(valuesOf(node)?.edge).toBe('1px solid red');
  });
});
