// Layers panel row actions and folding. The rows are drag sources whose
// pointerdown captures the pointer, which used to swallow every click on the
// row's own buttons (Eye, Lock, Delete, the fold chevron). These tests press
// each control the way a mouse does (pointerdown, then click) against a wired
// DragManager and check the action ran and no drag was armed.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, within, act } from '@testing-library/react';
import { createRootStore, getDragManager, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import type { PageModelType } from '@/models/PageModel';
import LayersPanel from '../LayersPanel';

let store: RootStoreType;

vi.mock('@/hooks/useStore', () => ({
  useStore: () => store,
}));

let page: PageModelType;
let root: ComponentInstance;
let main: ComponentInstance;
let image: ComponentInstance;
let nested: ComponentInstance;
let breakpointId: string;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = createRootStore();
  const { projectStore, editorUI } = store;
  projectStore.createProject('Layers test');
  const project = projectStore.findProjectByTitle('Layers test')!;
  page = project.findPageBySlug('')!;
  editorUI.setCurrentProject(project);
  editorUI.setCurrentPage(page);
  root = page.appComponentTree as ComponentInstance;
  [main, image] = root.children as ComponentInstance[];
  main.addChildren([createIntrinsicComponent('span-child', 'span', { children: 'Nested' })]);
  nested = main.children[0] as ComponentInstance;
  // Only the first breakpoint frame expanded keeps one row per node.
  const [desktop, ...others] = page.sortedViewportNodes;
  breakpointId = desktop.breakpointId!;
  editorUI.setCollapsedLayerIds(new Set(others.map(v => v.id)));
  editorUI.selectComponent(root, breakpointId);
  getDragManager()!.wire({
    getTransform: () => ({ panX: 0, panY: 0, zoom: 1 }),
    getPage: () => store.editorUI.currentPage,
    getHistory: () => getHistoryStore(),
    getEditorUI: () => store.editorUI,
  });
  getHistoryStore()!.clear();
});

afterEach(() => {
  getDragManager()?.cancel();
  cleanup();
  vi.restoreAllMocks();
});

const rowOf = (c: ComponentInstance) =>
  document.querySelector<HTMLElement>(`[data-layer-row="${c.id}"][data-layer-breakpoint="${breakpointId}"]`)!;

/** A mouse press on `el`: pointerdown (what arms a drag), then click. */
function press(el: HTMLElement) {
  fireEvent.pointerDown(el, { button: 0, isPrimary: true, pointerId: 1, pointerType: 'mouse' });
  const armed = getDragManager()!.source !== null;
  fireEvent.click(el);
  return { armed };
}

describe('the row itself', () => {
  it('still arms a drag on pointerdown (the control tests below are meaningful)', () => {
    render(<LayersPanel />);
    const { armed } = press(rowOf(main));
    expect(armed).toBe(true);
  });
});

describe('row action buttons', () => {
  it('Hide layer hides the node, starts no drag and leaves the selection alone', () => {
    render(<LayersPanel />);
    const button = within(rowOf(main)).getByRole('button', { name: 'Hide layer' });
    const { armed } = press(button);
    expect(armed).toBe(false);
    expect(main.canvasVisible).toBe(false);
    expect(store.editorUI.selectedComponent).toBe(root);
    // Hidden rows show a Show action and stay dimmed.
    expect(within(rowOf(main)).getByRole('button', { name: 'Show layer' })).toBeTruthy();
    expect(within(rowOf(main)).getByText(main.displayName).className).toContain('opacity-50');
    // One undo step brings it back.
    getHistoryStore()!.undo();
    expect(main.canvasVisible).toBe(true);
  });

  it('Lock layer locks the node and Unlock layer releases it', () => {
    render(<LayersPanel />);
    const { armed } = press(within(rowOf(image)).getByRole('button', { name: 'Lock layer' }));
    expect(armed).toBe(false);
    expect(image.canvasLocked).toBe(true);
    press(within(rowOf(image)).getByRole('button', { name: 'Unlock layer' }));
    expect(image.canvasLocked).toBe(false);
  });

  it('Delete layer (in the More menu) removes a container too, as one undo step', () => {
    render(<LayersPanel />);
    // The hover strip is Hide, Lock and More; Delete lives in the menus.
    expect(within(rowOf(main)).queryByRole('button', { name: 'Delete layer' })).toBeNull();
    const { armed } = press(within(rowOf(main)).getByRole('button', { name: 'More layer actions' }));
    expect(armed).toBe(false);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Delete layer' }));
    expect(page.findComponent(main.id)).toBeUndefined();
    expect(page.findComponent('span-child')).toBeUndefined();
    getHistoryStore()!.undo();
    expect(page.findComponent(main.id)).toBeDefined();
    expect(page.findComponent('span-child')).toBeDefined();
  });

  it('the page root offers no Delete', () => {
    render(<LayersPanel />);
    press(within(rowOf(root)).getByRole('button', { name: 'More layer actions' }));
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: 'Delete layer' })).toBeNull();
  });

  it('the More menu and a right-click offer the same actions', () => {
    render(<LayersPanel />);
    const { armed } = press(within(rowOf(main)).getByRole('button', { name: 'More layer actions' }));
    expect(armed).toBe(false);
    const menu = screen.getByRole('menu');
    const labels = within(menu).getAllByRole('menuitem').map(b => b.textContent);
    expect(labels).toEqual(['Hide layer', 'Lock layer', 'Collapse', 'Duplicate', 'Delete layer']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Lock layer' }));
    expect(main.canvasLocked).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.contextMenu(rowOf(image), { clientX: 40, clientY: 50 });
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Delete layer' }));
    expect(page.findComponent(image.id)).toBeUndefined();
  });
});

describe('folding', () => {
  it('the chevron folds and unfolds a container row without starting a drag', () => {
    render(<LayersPanel />);
    expect(rowOf(nested)).not.toBeNull();
    const chevron = within(rowOf(main)).getByRole('button', { name: `Collapse ${main.displayName}` });
    const { armed } = press(chevron);
    expect(armed).toBe(false);
    expect(rowOf(nested)).toBeNull();
    press(within(rowOf(main)).getByRole('button', { name: `Expand ${main.displayName}` }));
    expect(rowOf(nested)).not.toBeNull();
  });

  it('Alt+click folds the whole subtree, and Alt+click again opens it all', () => {
    render(<LayersPanel />);
    fireEvent.click(within(rowOf(root)).getByRole('button', { name: `Collapse ${root.displayName}` }), { altKey: true });
    expect(store.editorUI.collapsedLayerIds.has(root.id)).toBe(true);
    expect(store.editorUI.collapsedLayerIds.has(main.id)).toBe(true);
    fireEvent.click(within(rowOf(root)).getByRole('button', { name: `Expand ${root.displayName}` }), { altKey: true });
    expect(store.editorUI.collapsedLayerIds.has(root.id)).toBe(false);
    expect(store.editorUI.collapsedLayerIds.has(main.id)).toBe(false);
  });

  it('Collapse all and Expand all fold every container', () => {
    render(<LayersPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all layers' }));
    expect(rowOf(root)).not.toBeNull();
    expect(rowOf(main)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all layers' }));
    expect(rowOf(nested)).not.toBeNull();
  });

  it('a canvas selection opens the folded ancestors of its row', async () => {
    render(<LayersPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all layers' }));
    expect(rowOf(nested)).toBeNull();
    await act(async () => {
      store.editorUI.selectComponent(nested, breakpointId);
    });
    expect(rowOf(nested)).not.toBeNull();
  });

  it('selecting the same node in another breakpoint frame opens that frame group', async () => {
    render(<LayersPanel />);
    const tablet = page.sortedViewportNodes[1];
    expect(store.editorUI.collapsedLayerIds.has(tablet.id)).toBe(true);
    await act(async () => {
      store.editorUI.selectComponent(nested, breakpointId);
    });
    await act(async () => {
      store.editorUI.selectComponent(nested, tablet.breakpointId);
    });
    expect(store.editorUI.collapsedLayerIds.has(tablet.id)).toBe(false);
    expect(
      document.querySelector(`[data-layer-row="${nested.id}"][data-layer-breakpoint="${tablet.breakpointId}"]`),
    ).not.toBeNull();
  });
});
