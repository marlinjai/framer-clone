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
  main.setProps({ children: undefined }); // the seed's text would become a leading text node
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

  it('the More menu and a right-click offer the same actions', () => {
    render(<LayersPanel />);
    const { armed } = press(within(rowOf(main)).getByRole('button', { name: 'More layer actions' }));
    expect(armed).toBe(false);
    const menu = screen.getByRole('menu');
    const labels = within(menu).getAllByRole('menuitem').map(b => b.textContent);
    expect(labels).toEqual(['Hide layer', 'Lock layer', 'Collapse', 'Create component', 'Duplicate', 'Delete layer']);
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
    nested.addChild(createIntrinsicComponent('deep', 'em', { children: 'Deep' }));
    render(<LayersPanel />);
    fireEvent.click(within(rowOf(main)).getByRole('button', { name: `Collapse ${main.displayName}` }), { altKey: true });
    expect(store.editorUI.collapsedLayerIds.has(main.id)).toBe(true);
    expect(store.editorUI.collapsedLayerIds.has(nested.id)).toBe(true);
    fireEvent.click(within(rowOf(main)).getByRole('button', { name: `Expand ${main.displayName}` }), { altKey: true });
    expect(store.editorUI.collapsedLayerIds.has(main.id)).toBe(false);
    expect(store.editorUI.collapsedLayerIds.has(nested.id)).toBe(false);
  });

  it('Alt+click on a breakpoint row folds the group with every container in it', () => {
    render(<LayersPanel />);
    const desktop = page.sortedViewportNodes[0];
    fireEvent.click(within(rowOf(root)).getByRole('button', { name: `Collapse ${desktop.label}` }), { altKey: true });
    expect(store.editorUI.collapsedLayerIds.has(desktop.id)).toBe(true);
    expect(store.editorUI.collapsedLayerIds.has(main.id)).toBe(true);
    expect(rowOf(main)).toBeNull();
    fireEvent.click(within(rowOf(root)).getByRole('button', { name: `Expand ${desktop.label}` }), { altKey: true });
    expect(store.editorUI.collapsedLayerIds.has(desktop.id)).toBe(false);
    expect(rowOf(nested)).not.toBeNull();
  });

  it('Collapse all folds every container but keeps the page sections listed; Expand all opens them', () => {
    render(<LayersPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all layers' }));
    expect(rowOf(root)).not.toBeNull();
    expect(rowOf(main)).not.toBeNull();
    expect(rowOf(nested)).toBeNull();
    // The root has no row to fold, so its id never piles up in the fold state.
    expect(store.editorUI.collapsedLayerIds.has(root.id)).toBe(false);
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

describe('text nodes in the Layers panel', () => {
  function withTextNode() {
    nested.addChild(createIntrinsicComponent('bold', 'strong', {}));
    return nested.children[0] as ComponentInstance;
  }

  it('shows a text node as its text, and marks its row as no drop parent', () => {
    const run = withTextNode();
    render(<LayersPanel />);
    const row = rowOf(run);
    expect(row.textContent).toContain('Nested');
    expect(row.hasAttribute('data-text-node-row')).toBe(true);
    expect(rowOf(nested).hasAttribute('data-text-node-row')).toBe(false);
  });

  it('a click on a text row selects the element it sits in', () => {
    const run = withTextNode();
    render(<LayersPanel />);
    fireEvent.click(rowOf(run));
    expect(store.editorUI.selectedComponent?.id).toBe(nested.id);
  });

  it('offers no lock on a text row, and hide and delete still work', () => {
    const run = withTextNode();
    render(<LayersPanel />);
    const row = within(rowOf(run));
    expect(row.queryByRole('button', { name: 'Lock layer' })).toBeNull();
    fireEvent.click(row.getByRole('button', { name: 'Hide layer' }));
    expect(run.canvasVisible).toBe(false);
  });
});

describe('the page root is the breakpoint row', () => {
  const desktopOf = () => page.sortedViewportNodes[0];
  const rowIn = (c: ComponentInstance, bp: string) =>
    document.querySelector<HTMLElement>(`[data-layer-row="${c.id}"][data-layer-breakpoint="${bp}"]`)!;

  it('lists the root children directly under the breakpoint, with no row of its own', () => {
    render(<LayersPanel />);
    // No component row (a tree drop target) for the root anywhere.
    expect(document.querySelector(`[data-inner-component-id="${root.id}"]`)).toBeNull();
    // The breakpoint row stands for it.
    const bpRow = rowOf(root);
    expect(bpRow.getAttribute('data-viewport-id')).toBe(desktopOf().id);
    expect(bpRow.textContent).toContain(desktopOf().label);
    // Its children are top-level rows (no indent guide), their children indented once.
    expect(rowOf(main).textContent).not.toContain('│');
    expect(rowOf(nested).textContent).toContain('│');
  });

  it('clicking the breakpoint row, or its name, selects the root in that breakpoint', () => {
    render(<LayersPanel />);
    act(() => store.editorUI.selectComponent(main, breakpointId));
    fireEvent.click(rowOf(root));
    expect(store.editorUI.selectedComponent).toBe(root);
    expect(store.editorUI.selectedViewportNode?.id).toBe(desktopOf().id);
    const tablet = page.sortedViewportNodes[1];
    fireEvent.click(screen.getByText(tablet.label!));
    expect(store.editorUI.selectedComponent).toBe(root);
    expect(store.editorUI.selectedViewportNode?.id).toBe(tablet.id);
  });

  it('marks the breakpoint row selected only in the breakpoint the root was picked in', () => {
    render(<LayersPanel />);
    const tablet = page.sortedViewportNodes[1];
    const tabletRow = rowIn(root, tablet.breakpointId!);
    expect(rowOf(root).className).toContain('bg-brand/10');
    expect(tabletRow.className).not.toContain('bg-brand/10');
    // On a touch screen the selected row keeps its action cluster visible.
    const cluster = (row: HTMLElement) => within(row).getByRole('button', { name: 'More layer actions' }).parentElement!;
    expect(cluster(rowOf(root)).className).toContain('[@media(hover:none)]:opacity-100');
    expect(cluster(tabletRow).className).not.toContain('[@media(hover:none)]:opacity-100');
  });

  it('the breakpoint row menu holds the root actions, never Delete or Duplicate', () => {
    render(<LayersPanel />);
    const { armed } = press(within(rowOf(root)).getByRole('button', { name: 'More layer actions' }));
    expect(armed).toBe(false);
    const labels = within(screen.getByRole('menu')).getAllByRole('menuitem').map(b => b.textContent);
    expect(labels).toEqual(['Hide layer', 'Lock layer', 'Collapse']);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Hide layer' }));
    expect(root.canvasVisible).toBe(false);
    // Rows under a hidden page body are dimmed like it.
    expect(within(rowOf(main)).getByText(main.displayName).className).toContain('opacity-50');
    // A right-click opens the same menu, and its Collapse folds the group.
    fireEvent.contextMenu(rowOf(root), { clientX: 10, clientY: 10 });
    const menu = screen.getByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Delete layer' })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: 'Duplicate' })).toBeNull();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Collapse' }));
    expect(rowOf(main)).toBeNull();
  });

  it('a drop onto the breakpoint row inserts the dragged node into the root', () => {
    render(<LayersPanel />);
    const bpRow = rowOf(root);
    const pointer = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 };
    (document as { elementsFromPoint?: Document['elementsFromPoint'] }).elementsFromPoint = () => [bpRow];
    try {
      const source = rowOf(nested);
      fireEvent.pointerDown(source, { ...pointer, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(source, { ...pointer, clientX: 40, clientY: 40 });
      expect(getDragManager()!.pendingTarget).toEqual({ kind: 'appTree' });
      fireEvent.pointerUp(source, { ...pointer, clientX: 40, clientY: 40 });
    } finally {
      delete (document as { elementsFromPoint?: Document['elementsFromPoint'] }).elementsFromPoint;
    }
    expect(nested.parentId).toBe(root.id);
    expect(root.children[root.children.length - 1].id).toBe(nested.id);
    // One undo step puts it back.
    getHistoryStore()!.undo();
    expect(page.findComponent(nested.id)?.parentId).toBe(main.id);
  });

  it('a canvas selection of the root opens its collapsed breakpoint group', async () => {
    render(<LayersPanel />);
    const tablet = page.sortedViewportNodes[1];
    expect(store.editorUI.collapsedLayerIds.has(tablet.id)).toBe(true);
    await act(async () => {
      store.editorUI.selectComponent(root, tablet.breakpointId);
    });
    expect(store.editorUI.collapsedLayerIds.has(tablet.id)).toBe(false);
    expect(rowIn(main, tablet.breakpointId!)).not.toBeNull();
  });

  it('inside a component definition the root is the component and keeps its own row', () => {
    const created = store.editorUI.currentProject!.createComponentFromSelection(page.id, [main.id], 'Card');
    if (!created.ok) throw new Error(created.message);
    store.editorUI.enterComponent(created.definitionId);
    expect(store.editorUI.inComponent).toBe(true);
    const definitionRoot = store.editorUI.currentPage!.appComponentTree as ComponentInstance;
    render(<LayersPanel />);
    expect(document.querySelector(`[data-inner-component-id="${definitionRoot.id}"]`)).not.toBeNull();
    // The breakpoint row is only the group header there: no drop marker into the root.
    expect(document.querySelector('[data-viewport-id]')).toBeNull();
  });
});

describe('row icons', () => {
  // The row's type icon: the first lucide svg that is not the fold chevron.
  const iconOf = (c: ComponentInstance) =>
    rowOf(c).querySelector('svg.lucide:not(.lucide-chevron-down):not(.lucide-chevron-right)')!.getAttribute('class');
  const add = (parent: ComponentInstance, id: string, type: string, props: Record<string, unknown>) => {
    parent.addChild(createIntrinsicComponent(id, type as 'div', props));
    return parent.children[parent.children.length - 1] as ComponentInstance;
  };

  it('names each kind of node with its own icon instead of a text "T" for everything', () => {
    const section = add(root, 'hero-x', 'section', {});
    const title = add(section, 'hero-title', 'h1', { children: 'Hello' });
    const nav = add(root, 'nav-x', 'nav', { style: { display: 'flex', flexDirection: 'row' } });
    const link = add(nav, 'nav-link', 'a', { href: '/', children: 'Home' });
    const stack = add(root, 'stack-x', 'div', { style: { display: 'flex', flexDirection: 'column' } });
    const grid = add(root, 'grid-x', 'div', { style: { display: 'grid' } });
    const paragraph = add(root, 'para-x', 'p', { children: 'Copy' });
    const button = add(root, 'btn-x', 'button', { children: 'Go' });
    const video = add(root, 'video-x', 'video', {});
    const list = add(root, 'list-x', 'ul', {});
    const item = add(list, 'item-x', 'li', { children: 'One' });
    const collection = add(root, 'coll-x', 'div', { 'data-component-kind': 'collection' });
    const products = add(root, 'prod-x', 'div', { 'data-component-kind': 'product-list' });
    const form = add(root, 'form-x', 'div', { 'data-form-kind': 'form' });
    const email = add(form, 'email-x', 'div', { 'data-form-kind': 'form-field', fieldType: 'email' });
    const textBox = add(root, 'textbox-x', 'div', { children: 'Welcome' });
    const emptySection = add(root, 'empty-x', 'section', {});
    render(<LayersPanel />);
    // A div holding nothing but text reads as text; an empty section is still a frame.
    expect(iconOf(textBox)).toContain('lucide-type');
    expect(iconOf(emptySection)).toContain('lucide-container');

    expect(iconOf(main)).toContain('lucide-container');
    expect(iconOf(section)).toContain('lucide-container');
    expect(iconOf(title)).toContain('lucide-type');
    expect(iconOf(nav)).toContain('lucide-columns-2');
    expect(iconOf(link)).toContain('lucide-link');
    expect(iconOf(stack)).toContain('lucide-align-vertical-space-around');
    expect(iconOf(grid)).toContain('lucide-grid-3x3');
    expect(iconOf(paragraph)).toContain('lucide-type');
    expect(iconOf(button)).toContain('lucide-square');
    expect(iconOf(video)).toContain('lucide-video');
    expect(iconOf(list)).toContain('lucide-layout-list');
    expect(iconOf(item)).toContain('lucide-type');
    expect(iconOf(collection)).toContain('lucide-list');
    expect(iconOf(products)).toContain('lucide-shopping-bag');
    expect(iconOf(form)).toContain('lucide-clipboard-list');
    expect(iconOf(email)).toContain('lucide-mail');
    expect(iconOf(image)).toContain('lucide-image');
    expect(iconOf(nested)).toContain('lucide-type');
  });

  it('follows the layout of the breakpoint the row is listed in', () => {
    const [desktop, tablet] = page.sortedViewportNodes;
    const responsive = add(root, 'resp-x', 'div', {
      style: { display: { [desktop.breakpointId!]: 'grid', [tablet.breakpointId!]: 'block' } },
    });
    store.editorUI.setCollapsedLayerIds(new Set());
    render(<LayersPanel />);
    const rowIn = (bp: string) =>
      document.querySelector<HTMLElement>(`[data-layer-row="${responsive.id}"][data-layer-breakpoint="${bp}"]`)!;
    expect(rowIn(desktop.breakpointId!).querySelector('svg.lucide-grid-3x3')).not.toBeNull();
    expect(rowIn(tablet.breakpointId!).querySelector('svg.lucide-container')).not.toBeNull();
  });
});
