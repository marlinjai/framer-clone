// The Components list inside the phone sheet: a tap adds the component next
// to or inside the selection, selects it and reports back so the sheet closes.
// On desktop the list stays drag only.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import LeftSidebar from '../../LeftSidebar';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));
vi.mock('../PagesPanel', () => ({ __esModule: true, default: () => <div /> }));
vi.mock('../LayersPanel', () => ({ __esModule: true, default: () => <div /> }));
vi.mock('@/components/cms/ContentManagerPanel', () => ({ __esModule: true, default: () => <div /> }));

beforeEach(() => {
  store = createRootStore();
  store.projectStore.createProject('Demo', 'test');
  const project = store.projectStore.findProjectByTitle('Demo');
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(project?.findPageBySlug(''));
});
afterEach(() => cleanup());

const showComponents = () => fireEvent.click(screen.getByRole('tab', { name: 'Components' }));

describe('Components in the phone sheet', () => {
  it('a tap adds the component inside the selected container, selects it, and reports back', () => {
    const onInserted = vi.fn();
    render(<LeftSidebar variant="sheet" onComponentInserted={onInserted} />);
    showComponents();
    const root = store.editorUI.currentPage!.appComponentTree;
    store.editorUI.selectComponent(root);
    const before = root.children.length;
    const add = screen.getAllByRole('button', { name: /^Add / })[0];
    fireEvent.click(add);
    expect(root.children.length).toBe(before + 1);
    const created = root.children[root.children.length - 1];
    expect(store.editorUI.selectedComponent?.id).toBe(created.id);
    expect(onInserted).toHaveBeenCalledTimes(1);
  });

  it('with nothing selected it goes at the end of the page', () => {
    render(<LeftSidebar variant="sheet" />);
    showComponents();
    store.editorUI.clearSelection();
    const root = store.editorUI.currentPage!.appComponentTree;
    const before = root.children.length;
    fireEvent.click(screen.getAllByRole('button', { name: /^Add / })[0]);
    expect(root.children.length).toBe(before + 1);
  });

  it('docked (desktop) the list stays drag only', () => {
    render(<LeftSidebar />);
    showComponents();
    expect(screen.queryAllByRole('button', { name: /^Add / })).toHaveLength(0);
  });
});
