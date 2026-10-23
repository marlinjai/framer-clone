// The canvas renderer honours the Layers panel flags: a hidden layer is not
// rendered, a locked layer (or one inside a locked layer) passes clicks
// through to its nearest unlocked ancestor and never arms a drag.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { createRootStore, getDragManager, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import ComponentRenderer from '../ComponentRenderer';

let store: RootStoreType;

vi.mock('@/hooks/useStore', () => ({
  useStore: () => store,
}));

let root: ComponentInstance;
let main: ComponentInstance;
let nested: ComponentInstance;
let breakpoints: { id: string; minWidth: number }[];

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = createRootStore();
  const { projectStore, editorUI } = store;
  projectStore.createProject('Renderer layers');
  const project = projectStore.findProjectByTitle('Renderer layers')!;
  const page = project.findPageBySlug('')!;
  editorUI.setCurrentProject(project);
  editorUI.setCurrentPage(page);
  root = page.appComponentTree as ComponentInstance;
  main = root.children[0] as ComponentInstance;
  main.addChildren([createIntrinsicComponent('span-child', 'span', { children: 'Nested' })]);
  nested = main.children[0] as ComponentInstance;
  breakpoints = page.sortedViewportNodes.map(v => ({ id: v.breakpointId!, minWidth: v.breakpointMinWidth ?? 0 }));
  editorUI.clearSelection();
  getDragManager()!.wire({
    getTransform: () => ({ panX: 0, panY: 0, zoom: 1 }),
    getPage: () => store.editorUI.currentPage,
    getHistory: () => getHistoryStore(),
    getEditorUI: () => store.editorUI,
  });
});

afterEach(() => {
  getDragManager()?.cancel();
  cleanup();
  vi.restoreAllMocks();
});

function renderTree() {
  return render(
    <ComponentRenderer
      component={root}
      breakpointId={breakpoints[0].id}
      allBreakpoints={breakpoints}
      primaryId={breakpoints[0].id}
    />,
  );
}

const nodeEl = (c: ComponentInstance) =>
  document.querySelector<HTMLElement>(`[data-inner-component-id="${c.id}"]`);

describe('hidden layers', () => {
  it('are not rendered on the canvas, with their subtree', () => {
    renderTree();
    expect(nodeEl(nested)).not.toBeNull();
    act(() => main.toggleCanvasVisibility());
    expect(nodeEl(main)).toBeNull();
    expect(nodeEl(nested)).toBeNull();
  });
});

describe('locked layers', () => {
  it('an unlocked node is selected by a click and arms a drag', () => {
    renderTree();
    fireEvent.pointerDown(nodeEl(nested)!, { button: 0, isPrimary: true, pointerId: 1, pointerType: 'mouse' });
    expect(getDragManager()!.source).not.toBeNull();
    getDragManager()!.cancel();
    fireEvent.click(nodeEl(nested)!);
    expect(store.editorUI.selectedComponent).toBe(nested);
  });

  it('a click on a node inside a locked layer selects the nearest unlocked ancestor', () => {
    main.toggleCanvasLock();
    renderTree();
    fireEvent.pointerDown(nodeEl(nested)!, { button: 0, isPrimary: true, pointerId: 1, pointerType: 'mouse' });
    // The press bubbles to the root, which is not draggable: nothing armed.
    expect(getDragManager()!.source).toBeNull();
    fireEvent.click(nodeEl(nested)!);
    expect(store.editorUI.selectedComponent).toBe(root);
    expect(nodeEl(main)!.style.pointerEvents).toBe('none');
    expect(nodeEl(nested)!.style.pointerEvents).toBe('none');
  });

  it('a locked text node does not enter text editing on double-click', () => {
    nested.toggleCanvasLock();
    renderTree();
    fireEvent.doubleClick(nodeEl(nested)!);
    expect(store.editorUI.editingComponent).toBeUndefined();
  });
});
