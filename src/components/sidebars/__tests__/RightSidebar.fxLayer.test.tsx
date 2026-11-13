// With a layer of an FX scene picked in the Layers panel, the right panel shows that layer alone;
// the box's own sections (Size, Styles, ...) return when the pick clears
// (docs/plans/2026-11-13-fx-layers-in-layers-panel.md, "The properties panel").
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import type { ComponentInstance } from '@/models/ComponentModel';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

import RightSidebar from '../RightSidebar';

let box: ComponentInstance;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = createRootStore();
  store.projectStore.createProject('Right panel fx');
  const project = store.projectStore.findProjectByTitle('Right panel fx')!;
  const page = project.findPageBySlug('')!;
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  getHistoryStore()!.setTargetStore(store.projectStore);
  box = page.insertRegistryComponent('fxScene', { kind: 'appTree' })!;
  store.editorUI.selectComponent(box, page.sortedViewportNodes[0].breakpointId!);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the right panel with an FX scene box', () => {
  it('shows the box\'s own sections when nothing of the scene is picked', () => {
    render(<RightSidebar />);
    expect(screen.getByLabelText('Starts')).toBeTruthy();
    expect(screen.getAllByText(/^size$/i).length).toBeGreaterThan(0);
  });

  it('with a layer picked shows that layer alone, and the box\'s sections come back when the pick clears', () => {
    render(<RightSidebar />);
    act(() => store.editorUI.pickFxLayer(box, { kind: 'layer', layerId: 'bloom' }));
    expect(screen.getByRole('group', { name: 'Settings of Bloom' })).toBeTruthy();
    expect(screen.queryAllByText(/^size$/i)).toHaveLength(0);
    expect(screen.queryByLabelText('Starts')).toBeNull();
    act(() => store.editorUI.clearFxLayerPick());
    expect(screen.queryByRole('group', { name: /^Settings of/ })).toBeNull();
    expect(screen.getAllByText(/^size$/i).length).toBeGreaterThan(0);
  });

  it('the Background pick shows the scene background alone', () => {
    render(<RightSidebar />);
    act(() => store.editorUI.pickFxLayer(box, { kind: 'background' }));
    expect(screen.getByLabelText('Scene background')).toBeTruthy();
    expect(screen.queryAllByText(/^size$/i)).toHaveLength(0);
  });

  it('hides the state switch while a layer is picked and brings it back with the pick cleared', () => {
    render(<RightSidebar />);
    expect(screen.getByRole('radio', { name: /^Hover$/ })).toBeTruthy();
    act(() => store.editorUI.pickFxLayer(box, { kind: 'layer', layerId: 'bloom' }));
    expect(screen.queryByRole('radio', { name: /^Hover$/ })).toBeNull();
    act(() => store.editorUI.clearFxLayerPick());
    expect(screen.getByRole('radio', { name: /^Hover$/ })).toBeTruthy();
  });

  it('does the same in the phone sheet', () => {
    render(<RightSidebar variant="sheet" />);
    act(() => store.editorUI.pickFxLayer(box, { kind: 'layer', layerId: 'bloom' }));
    expect(screen.getByRole('group', { name: 'Settings of Bloom' })).toBeTruthy();
    expect(screen.queryAllByText(/^size$/i)).toHaveLength(0);
  });

  it('picking a layer while the box is in the Hover state returns to Normal, so the layer is editable', () => {
    render(<RightSidebar />);
    act(() => store.editorUI.setActiveRule('hover'));
    act(() => store.editorUI.pickFxLayer(box, { kind: 'layer', layerId: 'bloom' }));
    expect(store.editorUI.activeRule).toBeNull();
    expect(store.editorUI.previewRule).toBeNull();
    expect(screen.getByRole('group', { name: 'Settings of Bloom' })).toBeTruthy();
  });
});
