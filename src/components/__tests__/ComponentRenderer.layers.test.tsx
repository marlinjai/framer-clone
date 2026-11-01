// The canvas renderer honours the Layers panel flags: a hidden layer is not
// rendered, a locked layer (or one inside a locked layer) passes clicks
// through to its nearest unlocked ancestor and never arms a drag. A link
// selects on a click and never navigates the editor.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { createRootStore, getDragManager, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import ComponentModel, { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
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
  main.setProps({ children: undefined }); // the seed's text would become a leading text node
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

describe('links on the canvas', () => {
  it('a click on a link, or on text inside one, selects without navigating the editor', () => {
    main.addChildren([createIntrinsicComponent('link-1', 'a', { href: '/contact' })]);
    const link = main.children[1] as ComponentInstance;
    link.addChildren([createIntrinsicComponent('link-text', 'span', { children: 'Contact' })]);
    const inner = link.children[0] as ComponentInstance;
    renderTree();

    // fireEvent answers false when the default action was prevented: no navigation.
    expect(fireEvent.click(nodeEl(link)!)).toBe(false);
    expect(store.editorUI.selectedComponent?.id).toBe(link.id);

    expect(fireEvent.click(nodeEl(inner)!)).toBe(false);
    expect(store.editorUI.selectedComponent?.id).toBe(inner.id);

    // An ordinary node keeps its default action.
    expect(fireEvent.click(nodeEl(nested)!)).toBe(true);
  });
});

describe('mixed text on the canvas', () => {
  /** `Hello <strong>bold</strong> world` inside a paragraph under main. */
  function mixedParagraph() {
    main.addChildren([createIntrinsicComponent('para', 'p', { children: 'Hello ' })]);
    const para = main.children.find((c: ComponentInstance) => c.id === 'para') as ComponentInstance;
    para.addChild(createIntrinsicComponent('bold', 'strong', { children: 'bold' }));
    para.addChild(ComponentModel.create({ id: 'tail', type: '#text', componentType: 'host', props: { children: ' world' }, parentId: para.id }));
    return para;
  }

  it('renders the text in order with no wrapper and no placeholder', () => {
    mixedParagraph();
    const { container } = renderTree();
    const el = container.querySelector('[data-inner-component-id="para"]')!;
    expect(el.textContent).toBe('Hello bold world');
    expect(Array.from(el.childNodes).map(n => n.nodeName)).toEqual(['#text', 'STRONG', '#text']);
    expect(container.textContent).not.toContain('Unknown component');
  });

  it('never turns the mixed parent into a text box, so a commit cannot flatten it', () => {
    const para = mixedParagraph();
    const { container } = renderTree();
    const el = container.querySelector('[data-inner-component-id="para"]') as HTMLElement;
    fireEvent.doubleClick(el);
    expect(el.getAttribute('contenteditable')).toBeNull();
    expect(store.editorUI.editingComponent).toBeUndefined();
    fireEvent.blur(el);
    expect((para.children as ComponentInstance[]).map(c => c.type)).toEqual(['#text', 'strong', '#text']);
  });

  it('edits an element child of mixed text inline, and only that child', () => {
    const para = mixedParagraph();
    const { container } = renderTree();
    const bold = container.querySelector('[data-inner-component-id="bold"]') as HTMLElement;
    fireEvent.doubleClick(bold);
    expect(bold.getAttribute('contenteditable')).toBe('true');
    bold.textContent = 'strong';
    fireEvent.blur(bold);
    expect(para.children[1].props.children).toBe('strong');
    expect(para.children[0].props.children).toBe('Hello ');
  });

  it('a click on the text of a mixed paragraph selects the paragraph', () => {
    mixedParagraph();
    const { container } = renderTree();
    fireEvent.click(container.querySelector('[data-inner-component-id="para"]')!);
    expect(store.editorUI.selectedComponent?.id).toBe('para');
  });

  it('honours the Layers eye on a text node', () => {
    const para = mixedParagraph();
    act(() => (para.children[0] as ComponentInstance).toggleCanvasVisibility());
    const { container } = renderTree();
    expect(container.querySelector('[data-inner-component-id="para"]')!.textContent).toBe('bold world');
  });

  it('renders a legacy string in front of its children, and keeps it out of inline editing', () => {
    main.addChild(ComponentModel.create({
      id: 'legacy',
      type: 'p',
      componentType: 'host',
      props: { children: 'Old ' },
      children: [{ id: 'in', type: 'em', componentType: 'host', parentId: 'legacy', props: { children: 'row' } }],
    }));
    const { container } = renderTree();
    const el = container.querySelector('[data-inner-component-id="legacy"]') as HTMLElement;
    expect(el.textContent).toBe('Old row');
    fireEvent.doubleClick(el);
    expect(store.editorUI.editingComponent).toBeUndefined();
  });
});
