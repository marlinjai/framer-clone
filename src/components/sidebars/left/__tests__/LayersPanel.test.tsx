// Layers panel row actions and folding. The rows are drag sources whose
// pointerdown captures the pointer, which used to swallow every click on the
// row's own buttons (Eye, Lock, Delete, the fold chevron). These tests press
// each control the way a mouse does (pointerdown, then click) against a wired
// DragManager and check the action ran and no drag was armed.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, createEvent, fireEvent, screen, within, act } from '@testing-library/react';
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

  it('Collapse all folds the breakpoint groups and every container; Expand all opens them', () => {
    render(<LayersPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all layers' }));
    // The breakpoint rows stay, folded; nothing inside them is listed.
    expect(rowOf(root)).not.toBeNull();
    for (const viewport of page.sortedViewportNodes) {
      expect(store.editorUI.collapsedLayerIds.has(viewport.id)).toBe(true);
    }
    expect(rowOf(main)).toBeNull();
    expect(rowOf(nested)).toBeNull();
    // The root has no row to fold, so its id never piles up in the fold state.
    expect(store.editorUI.collapsedLayerIds.has(root.id)).toBe(false);
    // Opening one group afterwards lists its sections, still folded.
    const desktop = page.sortedViewportNodes[0];
    fireEvent.click(within(rowOf(root)).getByRole('button', { name: `Expand ${desktop.label}` }));
    expect(rowOf(main)).not.toBeNull();
    expect(rowOf(nested)).toBeNull();
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

// The rows of an FX scene box (docs/plans/2026-11-13-fx-layers-in-layers-panel.md, slice L1):
// derived from the stored scene, picked into the editor's `fxLayerPick`, acted on by buttons,
// the menu and keys. The store, the history and the strict reader are the real ones.
describe('the rows of an FX scene box', () => {
  let box: ComponentInstance;
  const FX = 'fx';
  const rowsIn = (bp: string = breakpointId) => Array.from(document.querySelectorAll<HTMLElement>(`[data-fx-layer-row][data-fx-layer-breakpoint="${bp}"]`));
  const rowNames = (bp?: string) => rowsIn(bp).map((el) => el.querySelector('button')!.getAttribute('aria-label')!.split(',')[0]);
  const rowOf = (name: string, bp: string = breakpointId) => rowsIn(bp).find((el) => el.querySelector('button')!.getAttribute('aria-label')!.startsWith(`${name},`))!;
  const nameButton = (name: string, bp?: string) => rowOf(name, bp).querySelector('button')!;
  const layerIds = () => ((box.props as Record<string, unknown>)[FX] as { scene: { layers: { id: string; name: string; visible: boolean }[] } }).scene.layers;
  const undo = () => act(() => getHistoryStore()!.undo());

  beforeEach(() => {
    box = page.insertRegistryComponent('fxScene', { kind: 'appTree' })!;
    store.editorUI.setCollapsedLayerIds(new Set());
    getHistoryStore()!.clear();
  });

  it('lists the scene under the box, front at the top, effects in their own group, then the background', () => {
    render(<LayersPanel />);
    // Content front first, then the Effects group (applied last on top), in the order the plan shows.
    expect(rowNames()).toEqual(['Grain', 'Vignette', 'Bloom', 'Noise Field', 'Gradient']);
    const group = document.querySelector(`[data-fx-scene-rows="${box.id}"]`)!;
    expect(within(group as HTMLElement).getByText('Scene')).toBeTruthy();
    expect(within(group as HTMLElement).getByText('Effects')).toBeTruthy();
    expect(document.querySelector(`[data-fx-background-row="${box.id}"][data-fx-layer-breakpoint="${breakpointId}"]`)).not.toBeNull();
  });

  it('repeats under the box in every breakpoint, and the highlight follows the selected frame', () => {
    const frames = page.sortedViewportNodes.map((v) => v.breakpointId!);
    expect(frames.length).toBeGreaterThan(1);
    render(<LayersPanel />);
    // Only the first frame is expanded in the fixture: expand the rest.
    act(() => store.editorUI.setCollapsedLayerIds(new Set()));
    for (const bp of frames) expect(rowsIn(bp)).toHaveLength(5);
    fireEvent.click(nameButton('Bloom', frames[1]));
    expect(nameButton('Bloom', frames[1]).getAttribute('aria-current')).toBe('true');
    expect(nameButton('Bloom', frames[0]).getAttribute('aria-current')).toBeNull();
    expect(store.editorUI.selectedViewportNode?.breakpointId).toBe(frames[1]);
  });

  it('picking a row in another breakpoint moves Live drawing there, as picking the box does', () => {
    const frames = page.sortedViewportNodes.map((v) => v.breakpointId!);
    store.editorUI.startFxLive(box.id, frames[0]);
    render(<LayersPanel />);
    act(() => store.editorUI.setCollapsedLayerIds(new Set()));
    fireEvent.click(nameButton('Bloom', frames[1]));
    expect(store.editorUI.fxLive).toEqual({ componentId: box.id, frameId: frames[1] });
  });

  it('is not part of the node tree: no row is a drag source or a drop target the resolver can find', () => {
    render(<LayersPanel />);
    for (const row of rowsIn()) {
      expect(row.closest('[data-inner-component-id]')).toBeNull();
      expect(row.closest('[data-layer-row]')).toBeNull();
      expect(row.closest('[data-viewport-id]')).toBeNull();
    }
    // A press on a row arms no drag.
    fireEvent.pointerDown(rowOf('Bloom'), { button: 0, clientX: 5, clientY: 5 });
    expect(getDragManager()!.isActive).toBe(false);
  });

  it('shows no Scene group for a box whose scene cannot be read', () => {
    act(() => box.setProps({ fx: { version: 99, scene: {} } }));
    render(<LayersPanel />);
    expect(document.querySelector(`[data-fx-scene-rows="${box.id}"]`)).toBeNull();
  });

  it('a click picks the layer: the box stays selected, the row is current and says what it is', () => {
    render(<LayersPanel />);
    fireEvent.click(nameButton('Bloom'));
    expect(store.editorUI.selectedComponent?.id).toBe(box.id);
    expect(store.editorUI.fxLayerPick).toMatchObject({ kind: 'layer', layerId: 'bloom' });
    expect(nameButton('Bloom').getAttribute('aria-current')).toBe('true');
    expect(nameButton('Bloom').getAttribute('aria-label')).toBe('Bloom, effect');
    expect(nameButton('Noise Field').getAttribute('aria-current')).toBeNull();
    // Shift click picks that layer alone too.
    fireEvent.click(nameButton('Grain'), { shiftKey: true });
    expect(store.editorUI.fxLayerPick).toMatchObject({ layerId: 'grain' });
    expect(store.editorUI.selectedComponentList).toHaveLength(1);
    fireEvent.click(nameButton('Vignette'), { metaKey: true });
    expect(store.editorUI.fxLayerPick).toMatchObject({ layerId: 'vignette' });
    expect(store.editorUI.selectedComponentList).toHaveLength(1);
  });

  it('the Background row is picked like a layer and has no hide, delete or menu', () => {
    render(<LayersPanel />);
    const row = document.querySelector<HTMLElement>(`[data-fx-background-row="${box.id}"][data-fx-layer-breakpoint="${breakpointId}"]`)!;
    fireEvent.click(within(row).getByRole('button'));
    expect(store.editorUI.fxLayerPick).toEqual({ componentId: box.id, kind: 'background' });
    expect(within(row).getAllByRole('button')).toHaveLength(1);
  });

  it('hide and show by the eye button are stored, one undo step each, and are labelled as the scene\'s own', () => {
    render(<LayersPanel />);
    const eye = () => within(rowOf('Bloom')).getByRole('button', { name: /(Hide|Show) Bloom in the scene/ });
    fireEvent.click(eye());
    expect(layerIds().find((l) => l.id === 'bloom')!.visible).toBe(false);
    expect(nameButton('Bloom').getAttribute('aria-label')).toBe('Bloom, effect, hidden');
    fireEvent.click(eye());
    expect(layerIds().find((l) => l.id === 'bloom')!.visible).toBe(true);
    undo();
    expect(layerIds().find((l) => l.id === 'bloom')!.visible).toBe(false);
    undo();
    expect(getHistoryStore()!.canUndo).toBe(false);
  });

  it('hiding the layer god rays read marks the god rays row off', () => {
    render(<LayersPanel />);
    // Built through the one edit module, as the panel does.
    return import('@/lib/fxScene/edit').then(({ addFxLayer, toggleFxLayer }) => {
      const added = addFxLayer((box.props as Record<string, unknown>)[FX], 'godRays');
      if (!added.ok) throw new Error(added.message);
      act(() => box.setProps({ fx: added.stored }));
      const raysRow = () => document.querySelector<HTMLElement>(`[data-fx-layer-row="${added.layerId}"][data-fx-layer-breakpoint="${breakpointId}"]`)!;
      expect(raysRow().textContent).toMatch(/reads /);
      expect(raysRow().textContent).not.toMatch(/off:/);
      const source = layerIds().find((l) => raysRow().textContent!.includes(`reads ${l.name}`))!;
      const hidden = toggleFxLayer((box.props as Record<string, unknown>)[FX], source.id);
      if (!hidden.ok) throw new Error(hidden.message);
      act(() => box.setProps({ fx: hidden.stored }));
      expect(raysRow().textContent).toMatch(/off: its layer is hidden/);
    });
  });

  it('the row menu offers hide, rename, duplicate, bring forward, send backward and delete', () => {
    render(<LayersPanel />);
    fireEvent.contextMenu(rowOf('Bloom'));
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['Hide in the scene', 'Rename', 'Duplicate', 'Bring forward', 'Send backward', 'Delete layer']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(layerIds().map((l) => l.name)).toContain('Bloom copy');
    expect(store.editorUI.fxLayerPick).toMatchObject({ kind: 'layer' });
    // Stored Bloom, Bloom copy, Vignette: bringing Bloom forward puts it in front of its copy.
    fireEvent.contextMenu(rowOf('Bloom'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Bring forward' }));
    expect(rowNames().indexOf('Bloom')).toBeLessThan(rowNames().indexOf('Bloom copy'));
  });

  it('delete by the trash button removes the layer, never the box; undo brings it back', () => {
    render(<LayersPanel />);
    fireEvent.click(within(rowOf('Bloom')).getByRole('button', { name: 'Delete Bloom' }));
    expect(layerIds().some((l) => l.id === 'bloom')).toBe(false);
    expect(page.findComponent(box.id)).toBeDefined();
    expect(rowNames()).not.toContain('Bloom');
    undo();
    expect(rowNames()).toContain('Bloom');
  });

  it('rename: double-click and F2 open the field, Enter stores, Escape keeps the old name, undo restores it', () => {
    render(<LayersPanel />);
    const rowById = (id: string) => document.querySelector<HTMLElement>(`[data-fx-layer-row="${id}"][data-fx-layer-breakpoint="${breakpointId}"]`)!;
    fireEvent.doubleClick(nameButton('Bloom'));
    let field = within(rowById('bloom')).getByLabelText('Layer name') as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: 'Glow' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(layerIds().find((l) => l.id === 'bloom')!.name).toBe('Glow');
    expect(within(rowById('bloom')).queryByLabelText('Layer name')).toBeNull();
    undo();
    expect(layerIds().find((l) => l.id === 'bloom')!.name).toBe('Bloom');

    // F2 on the picked layer, through the editor's own dispatcher (the key handler of EditorApp).
    fireEvent.click(nameButton('Bloom'));
    act(() => store.editorUI.startFxLayerRename(box.id, 'bloom'));
    field = within(rowById('bloom')).getByLabelText('Layer name') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'Other' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(layerIds().find((l) => l.id === 'bloom')!.name).toBe('Bloom');
    expect(within(rowById('bloom')).queryByLabelText('Layer name')).toBeNull();
  });

  it('Enter and Space on a focused row pick it (the name is a button)', () => {
    render(<LayersPanel />);
    const button = nameButton('Vignette');
    expect(button.tagName).toBe('BUTTON');
    button.focus();
    // A button's Enter and Space become a click; jsdom does not synthesise it, so the click stands for them.
    fireEvent.click(button);
    expect(store.editorUI.fxLayerPick).toMatchObject({ layerId: 'vignette' });
  });

  it('announces a move and a refusal in a polite live region, once (one region, not one per breakpoint)', () => {
    render(<LayersPanel />);
    fireEvent.click(nameButton('Bloom'));
    const forward = () => {
      fireEvent.contextMenu(rowOf('Bloom'));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Bring forward' }));
    };
    const regions = () => screen.getAllByRole('status').filter((el) => el.getAttribute('aria-live') === 'polite');
    forward();
    expect(regions().map((r) => r.textContent).filter(Boolean)).toEqual(['Bloom moved in front of Vignette.']);
    forward();
    forward();
    expect(regions().map((r) => r.textContent).filter(Boolean)).toEqual(['Bloom is already at the front of its group.']);
    // After an undo of a move that WAS stored, the message about it is gone.
    undo();
    expect(regions().map((r) => r.textContent).filter(Boolean)).toEqual([]);
  });

  it('the Scene group folds and keeps its state like any row', () => {
    render(<LayersPanel />);
    const toggle = screen.getAllByRole('button', { name: 'Collapse Scene' })[0];
    fireEvent.click(toggle);
    expect(rowsIn()).toHaveLength(0);
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand Scene' })[0]);
    expect(rowsIn()).toHaveLength(5);
  });

  it('after another writer\'s snapshot (the stored scene replaced), the rows follow and a pick of a vanished layer falls back to the box', async () => {
    render(<LayersPanel />);
    fireEvent.click(nameButton('Bloom'));
    const { removeFxLayer } = await import('@/lib/fxScene/edit');
    const without = removeFxLayer((box.props as Record<string, unknown>)[FX], 'bloom');
    if (!without.ok) throw new Error(without.message);
    act(() => box.setProps({ fx: without.stored }));
    expect(rowNames()).not.toContain('Bloom');
    expect(store.editorUI.fxLayerPick).toBeUndefined();
    expect(store.editorUI.selectedComponent?.id).toBe(box.id);
  });

  describe('nested effects and drag to reorder', () => {
    const scope = async (effect: string, target: string) => {
      const { setFxLayerTarget } = await import('@/lib/fxScene/edit');
      const edit = setFxLayerTarget((box.props as Record<string, unknown>)[FX], effect, target);
      if (!edit.ok) throw new Error(edit.message);
      act(() => box.setProps({ fx: edit.stored }));
    };
    /** A drag as the browser sends it: the data transfer is shared by every event of the gesture. */
    const transfer = () => ({ data: {} as Record<string, string>, effectAllowed: '', dropEffect: '', get types() { return Object.keys(this.data); }, setData(t: string, v: string) { this.data[t] = v; }, getData(t: string) { return this.data[t]; } });
    const drag = (from: HTMLElement, over: HTMLElement, place: 'above' | 'below') => {
      const dataTransfer = transfer();
      vi.spyOn(over, 'getBoundingClientRect').mockReturnValue({ top: 100, height: 28, left: 0, right: 100, bottom: 128, width: 100, x: 0, y: 100, toJSON: () => ({}) });
      const y = place === 'above' ? 105 : 124;
      fireEvent.dragStart(from, { dataTransfer });
      // jsdom's drag events carry no pointer position: set it on the event, as a browser has it.
      for (const make of [createEvent.dragOver, createEvent.drop]) {
        const event = make(over, { dataTransfer });
        Object.defineProperty(event, 'clientY', { value: y });
        fireEvent(over, event);
      }
      fireEvent.dragEnd(from, { dataTransfer });
    };

    it('shows a scoped effect nested under its layer, indented, and not in the Effects group', async () => {
      render(<LayersPanel />);
      await scope('bloom', 'gradient-bg');
      // Effects group: Grain, Vignette. Content: Noise Field, Gradient, then Gradient's nested Bloom.
      expect(rowNames()).toEqual(['Grain', 'Vignette', 'Noise Field', 'Gradient', 'Bloom']);
      expect(rowOf('Bloom').getAttribute('data-fx-layer-group')).toBe('nested:gradient-bg');
      expect(nameButton('Bloom').getAttribute('aria-label')).toBe('Bloom, effect, applies to Gradient');
      const indent = (name: string) => parseInt(rowOf(name).style.paddingLeft, 10);
      expect(indent('Bloom')).toBeGreaterThan(indent('Gradient'));
      // Picking it works like any layer.
      fireEvent.click(nameButton('Bloom'));
      expect(store.editorUI.fxLayerPick).toMatchObject({ layerId: 'bloom' });
    });

    it('shows a colour hint for a layer with a colour of its own', () => {
      render(<LayersPanel />);
      expect(rowOf('Noise Field').querySelector('[data-fx-swatch]')).not.toBeNull();
      expect(rowOf('Bloom').querySelector('[data-fx-swatch]')).toBeNull();
    });

    it('drag: dropping a row below another in its group reorders it as one undo step', () => {
      render(<LayersPanel />);
      const before = layerIds().map((l) => l.name);
      // Effects listed: Grain, Vignette, Bloom. Drop Grain below Bloom: it becomes the back-most effect.
      drag(rowOf('Grain'), rowOf('Bloom'), 'below');
      const after = layerIds().map((l) => l.name);
      expect(after).not.toEqual(before);
      expect(rowNames().slice(0, 3)).toEqual(['Vignette', 'Bloom', 'Grain']);
      undo();
      expect(layerIds().map((l) => l.name)).toEqual(before);
    });

    it('drag: a row dropped into another group is refused with the reason, and nothing is stored', async () => {
      render(<LayersPanel />);
      await scope('bloom', 'gradient-bg');
      const before = JSON.stringify((box.props as Record<string, unknown>)[FX]);
      drag(rowOf('Grain'), rowOf('Noise Field'), 'above'); // effect onto a content row
      expect(store.editorUI.fxLayerNotice).toMatchObject({ problem: true, text: expect.stringMatching(/Grain stays among the scene's effects: it cannot be moved into the layers that draw/) });
      expect(store.editorUI.editorNotice).toMatchObject({ kind: 'refused', message: expect.stringMatching(/Grain stays among the scene's effects/) });
      drag(rowOf('Noise Field'), rowOf('Grain'), 'above'); // content onto an effect row
      expect(store.editorUI.fxLayerNotice?.text).toMatch(/Noise Field stays among the layers that draw: it cannot be moved into the scene's effects/);
      drag(rowOf('Grain'), rowOf('Bloom'), 'above'); // scene effect into the nest of Gradient
      expect(JSON.stringify((box.props as Record<string, unknown>)[FX])).toBe(before);
      expect(store.editorUI.fxLayerNotice).toMatchObject({ problem: true, text: expect.stringMatching(/Grain stays among the scene's effects: it cannot be moved into the effects of Gradient/) });
    });

    it('drag: another group\'s row is marked refused while hovering, and a valid drop afterwards clears the banner', () => {
      render(<LayersPanel />);
      const dataTransfer = transfer();
      fireEvent.dragStart(rowOf('Grain'), { dataTransfer });
      const over = createEvent.dragOver(rowOf('Noise Field'), { dataTransfer });
      fireEvent(rowOf('Noise Field'), over);
      expect(rowOf('Noise Field').getAttribute('data-fx-drop')).toBe('refused');
      expect(over.defaultPrevented).toBe(true);
      fireEvent.dragEnd(rowOf('Grain'), { dataTransfer });
      drag(rowOf('Grain'), rowOf('Noise Field'), 'above');
      expect(store.editorUI.editorNotice?.kind).toBe('refused');
      drag(rowOf('Grain'), rowOf('Bloom'), 'below'); // a valid reorder inside the Effects group
      expect(store.editorUI.fxLayerNotice?.problem).toBe(false);
      expect(store.editorUI.editorNotice).toBeUndefined();
    });

    it('drag: a nested effect reorders among its siblings only', async () => {
      render(<LayersPanel />);
      await scope('bloom', 'gradient-bg');
      await scope('vignette', 'gradient-bg');
      // nested under Gradient, front first: Vignette, Bloom
      expect(rowNames().slice(-2)).toEqual(['Vignette', 'Bloom']);
      drag(rowOf('Vignette'), rowOf('Bloom'), 'below');
      expect(rowNames().slice(-2)).toEqual(['Bloom', 'Vignette']);
      undo();
      expect(rowNames().slice(-2)).toEqual(['Vignette', 'Bloom']);
    });

    it('drag: something that is not a layer (a file) dragged over a row is ignored', () => {
      render(<LayersPanel />);
      const before = JSON.stringify((box.props as Record<string, unknown>)[FX]);
      const over = rowOf('Vignette');
      const event = createEvent.drop(over, { dataTransfer: { types: ['Files'], getData: () => '' } });
      fireEvent(over, event);
      expect(event.defaultPrevented).toBe(false);
      expect(JSON.stringify((box.props as Record<string, unknown>)[FX])).toBe(before);
    });

    it('drag: dropping a row where it already is stores nothing', () => {
      render(<LayersPanel />);
      const before = JSON.stringify((box.props as Record<string, unknown>)[FX]);
      drag(rowOf('Grain'), rowOf('Vignette'), 'above');
      expect(JSON.stringify((box.props as Record<string, unknown>)[FX])).toBe(before);
      expect(getHistoryStore()!.canUndo).toBe(false);
    });
  });
});
