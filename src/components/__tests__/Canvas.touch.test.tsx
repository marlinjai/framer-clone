// Touch and pen input on the canvas (src/lib/canvas/touchGestures.ts holds the
// math): two fingers pan and pinch-zoom, one finger taps, moves the selected
// node, draws the selection rectangle and double-taps; the mouse path stays
// exactly as before. jsdom has no layout, so every rect is at the origin and
// the ground's client coordinates equal its local coordinates.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { createRootStore, getDragManager, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import { TransformProvider } from '@/contexts/TransformContext';
import { EditorTool } from '@/stores/EditorUIStore';
import Canvas from '../Canvas';

let store: RootStoreType;

vi.mock('@/hooks/useStore', () => ({
  useStore: () => store,
}));

let root: ComponentInstance;
let main: ComponentInstance;
let nested: ComponentInstance;
let breakpointId: string;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // jsdom has no elementsFromPoint; the drag manager's drop-target lookup needs it.
  (document as any).elementsFromPoint = () => [];
  store = createRootStore();
  const { projectStore, editorUI } = store;
  projectStore.createProject('Canvas touch');
  const project = projectStore.findProjectByTitle('Canvas touch')!;
  const page = project.findPageBySlug('')!;
  editorUI.setCurrentProject(project);
  editorUI.setCurrentPage(page);
  root = page.appComponentTree as ComponentInstance;
  main = root.children[0] as ComponentInstance;
  main.addChildren([createIntrinsicComponent('span-child', 'span', { children: 'Nested' })]);
  nested = main.children[0] as ComponentInstance;
  breakpointId = page.sortedViewportNodes[0].breakpointId!;
  editorUI.clearSelection();
  editorUI.setSelectedTool(EditorTool.SELECT);
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
  delete (document as any).elementsFromPoint;
});

function renderCanvas() {
  return render(
    <TransformProvider>
      <Canvas />
    </TransformProvider>,
  );
}

const ground = () => document.querySelector<HTMLElement>('[data-ground]')!;
const marquee = () => document.querySelector<HTMLElement>('[data-testid="marquee-selection"]')!;
/** The first rendered copy of a node (every breakpoint frame renders the page). */
const nodeEl = (c: ComponentInstance) =>
  document.querySelector<HTMLElement>(`[data-inner-component-id="${c.id}"]`)!;

function camera() {
  const raw = document.querySelector('[data-camera-transform]')!.getAttribute('data-camera-transform')!;
  const [panX, panY, zoom] = raw.split(',').map(Number);
  return { panX, panY, zoom };
}

type Pt = { x: number; y: number };
// Like a browser: the first finger of a gesture is the primary pointer.
const primaryOf = new Map<number, boolean>();
beforeEach(() => primaryOf.clear());
const touch = (id: number, p: Pt, type = 'touch') => ({
  pointerId: id,
  pointerType: type,
  isPrimary: primaryOf.get(id) ?? false,
  button: 0,
  clientX: p.x,
  clientY: p.y,
});
const down = (el: Element, id: number, p: Pt, type?: string) => {
  primaryOf.set(id, primaryOf.size === 0);
  return fireEvent.pointerDown(el, touch(id, p, type));
};
const move = (el: Element, id: number, p: Pt, type?: string) => fireEvent.pointerMove(el, touch(id, p, type));
const up = (el: Element, id: number, p: Pt, type?: string) => {
  const r = fireEvent.pointerUp(el, touch(id, p, type));
  primaryOf.delete(id);
  return r;
};
const nextFrame = () => act(() => new Promise<void>(r => requestAnimationFrame(() => r())));

describe('two fingers', () => {
  it('pinch zooms around the midpoint between the fingers, smoothly per frame', async () => {
    renderCanvas();
    const g = ground();
    down(g, 1, { x: 100, y: 100 });
    down(g, 2, { x: 200, y: 100 });
    move(g, 1, { x: 50, y: 100 });
    move(g, 2, { x: 250, y: 100 });
    // Coalesced into the next animation frame.
    expect(camera()).toEqual({ panX: 0, panY: 0, zoom: 1 });
    await nextFrame();
    // Spread 100 -> 200 doubles the zoom; world (150,100) stays under the midpoint.
    expect(camera()).toEqual({ panX: -150, panY: -100, zoom: 2 });
    up(g, 1, { x: 50, y: 100 });
    up(g, 2, { x: 250, y: 100 });
  });

  it('moving both fingers pans, and the last positions land on lift without waiting for a frame', () => {
    renderCanvas();
    const g = ground();
    down(g, 1, { x: 100, y: 100 });
    down(g, 2, { x: 200, y: 100 });
    move(g, 1, { x: 130, y: 120 });
    move(g, 2, { x: 230, y: 120 });
    up(g, 2, { x: 230, y: 120 });
    expect(camera()).toEqual({ panX: 30, panY: 20, zoom: 1 });
    up(g, 1, { x: 130, y: 120 });
  });

  it('clamps the pinch to the zoom limits', () => {
    renderCanvas();
    const g = ground();
    down(g, 1, { x: 100, y: 100 });
    down(g, 2, { x: 110, y: 100 });
    move(g, 2, { x: 900, y: 100 });
    up(g, 2, { x: 900, y: 100 });
    expect(camera().zoom).toBe(5);
    up(g, 1, { x: 100, y: 100 });
  });

  it('lifting one finger mid-pinch does not jump, drag or select; the survivor does nothing', async () => {
    renderCanvas();
    const el = nodeEl(nested);
    down(el, 1, { x: 10, y: 10 });
    down(el, 2, { x: 110, y: 10 });
    move(el, 2, { x: 210, y: 10 });
    up(el, 2, { x: 210, y: 10 });
    const settled = camera();
    expect(settled.zoom).toBe(2);
    move(el, 1, { x: 300, y: 300 });
    await nextFrame();
    expect(camera()).toEqual(settled);
    expect(getDragManager()!.source).toBeNull();
    up(el, 1, { x: 300, y: 300 });
    // The click a lifting finger may produce is swallowed.
    fireEvent.click(el);
    expect(store.editorUI.selectedComponent).toBeUndefined();
  });

  it('a finger whose lift never arrived is forgotten when the window loses focus', () => {
    renderCanvas();
    const g = ground();
    down(g, 1, { x: 100, y: 100 }); // its pointerup is lost (app switch)
    fireEvent.blur(window);
    primaryOf.clear();
    // The next finger is a first finger again: one finger never moves the camera,
    // and a pinch needs two real fingers.
    down(g, 2, { x: 100, y: 100 });
    move(g, 2, { x: 300, y: 300 });
    up(g, 2, { x: 300, y: 300 });
    expect(camera()).toEqual({ panX: 0, panY: 0, zoom: 1 });
    expect(marquee().style.display).toBe('none');
  });

  it('a second finger cancels a one-finger rectangle and an armed move', () => {
    store.editorUI.selectComponent(main, breakpointId);
    renderCanvas();
    const g = ground();
    down(g, 1, { x: 5, y: 5 });
    move(g, 1, { x: 40, y: 40 });
    expect(marquee().style.display).toBe('block');
    down(g, 2, { x: 80, y: 80 });
    expect(marquee().style.display).toBe('none');
    up(g, 1, { x: 40, y: 40 });
    up(g, 2, { x: 80, y: 80 });

    down(nodeEl(nested), 3, { x: 5, y: 5 });
    expect(getDragManager()!.sourceNodeId).toBe(main.id);
    down(g, 4, { x: 60, y: 60 });
    expect(getDragManager()!.source).toBeNull();
    up(g, 3, { x: 5, y: 5 });
    up(g, 4, { x: 60, y: 60 });
  });
});

describe('one finger', () => {
  it('never pans the camera in the Select tool', () => {
    renderCanvas();
    const g = ground();
    down(g, 1, { x: 10, y: 10 });
    move(g, 1, { x: 200, y: 200 });
    up(g, 1, { x: 200, y: 200 });
    expect(camera()).toEqual({ panX: 0, panY: 0, zoom: 1 });
  });

  it('pans with the Grab tool, an explicit choice to pan', () => {
    store.editorUI.setSelectedTool(EditorTool.GRAB);
    renderCanvas();
    const g = ground();
    down(g, 1, { x: 10, y: 10 });
    move(g, 1, { x: 60, y: 30 });
    up(g, 1, { x: 60, y: 30 });
    expect(camera()).toEqual({ panX: 50, panY: 20, zoom: 1 });
  });

  it('draws the selection rectangle on empty canvas, past a finger-sized threshold', () => {
    renderCanvas();
    const g = ground();
    down(g, 1, { x: 10, y: 10 });
    move(g, 1, { x: 16, y: 10 }); // 6px: still a tap for a finger
    expect(marquee().style.display).toBe('none');
    move(g, 1, { x: 60, y: 50 });
    expect(marquee().style.display).toBe('block');
    expect(marquee().style.width).toBe('50px');
    up(g, 1, { x: 60, y: 50 });
    expect(marquee().style.display).toBe('none');
  });

  it('a tap on a node selects it, a tap on empty canvas clears', () => {
    renderCanvas();
    const el = nodeEl(nested);
    down(el, 1, { x: 5, y: 5 });
    up(el, 1, { x: 5, y: 5 });
    fireEvent.click(el);
    expect(store.editorUI.selectedComponent?.id).toBe(nested.id);
    const g = ground();
    down(g, 2, { x: 500, y: 500 });
    up(g, 2, { x: 500, y: 500 });
    fireEvent.click(g);
    expect(store.editorUI.selectedComponent).toBeUndefined();
  });

  it('a drag on the selected node (or inside it) moves it through the drag manager', () => {
    store.editorUI.selectComponent(main, breakpointId);
    renderCanvas();
    const el = nodeEl(nested);
    down(el, 1, { x: 5, y: 5 });
    const dm = getDragManager()!;
    expect(dm.sourceNodeId).toBe(main.id);
    move(el, 1, { x: 10, y: 5 }); // 5px: below the finger threshold
    expect(dm.isActive).toBe(false);
    move(el, 1, { x: 40, y: 30 });
    expect(dm.isActive).toBe(true);
    dm.cancel();
    up(el, 1, { x: 40, y: 30 });
  });

  it('a drag on an unselected node draws a rectangle instead of moving it', () => {
    renderCanvas();
    const el = nodeEl(nested);
    down(el, 1, { x: 5, y: 5 });
    expect(getDragManager()!.source).toBeNull();
    move(el, 1, { x: 50, y: 50 });
    expect(marquee().style.display).toBe('block');
    up(el, 1, { x: 50, y: 50 });
  });

  it('double-tap on a text node enters text editing', () => {
    renderCanvas();
    const el = nodeEl(nested);
    down(el, 1, { x: 5, y: 5 });
    up(el, 1, { x: 5, y: 5 });
    fireEvent.click(el);
    down(el, 2, { x: 6, y: 6 });
    up(el, 2, { x: 6, y: 6 });
    expect(store.editorUI.editingComponent?.id).toBe(nested.id);
    expect(document.activeElement).toBe(el);
  });

  it('double-tap on the selected text node edits it, though its move captured the pointer', () => {
    store.editorUI.selectComponent(nested, breakpointId);
    const captured: Element[] = [];
    vi.spyOn(Element.prototype, 'setPointerCapture').mockImplementation(function (this: Element) {
      captured.push(this);
    });
    renderCanvas();
    const el = nodeEl(nested);
    const g = ground();
    // A captured pointer's pointerup and click land on the capture target.
    down(el, 1, { x: 5, y: 5 });
    expect(captured.at(-1)).toBe(el); // the pressed element, never the ground
    up(g, 1, { x: 5, y: 5 });
    getDragManager()!.cancel();
    down(el, 2, { x: 5, y: 5 });
    up(g, 2, { x: 5, y: 5 });
    expect(store.editorUI.editingComponent?.id).toBe(nested.id);
    expect(camera().zoom).toBe(1);
  });

  it('double-tap on empty canvas zooms in one step around the tap', () => {
    renderCanvas();
    const g = ground();
    down(g, 1, { x: 100, y: 100 });
    up(g, 1, { x: 100, y: 100 });
    down(g, 2, { x: 100, y: 100 });
    up(g, 2, { x: 100, y: 100 });
    expect(camera()).toEqual({ panX: -50, panY: -50, zoom: 1.5 });
  });

  it('two slow taps are not a double-tap', () => {
    const now = vi.spyOn(performance, 'now');
    renderCanvas();
    const g = ground();
    now.mockReturnValue(1000);
    down(g, 1, { x: 100, y: 100 });
    up(g, 1, { x: 100, y: 100 });
    now.mockReturnValue(1600);
    down(g, 2, { x: 100, y: 100 });
    up(g, 2, { x: 100, y: 100 });
    expect(camera().zoom).toBe(1);
  });

  it('a pen follows the touch model: a drag on an unselected node selects by rectangle', () => {
    renderCanvas();
    const el = nodeEl(nested);
    down(el, 1, { x: 5, y: 5 }, 'pen');
    expect(getDragManager()!.source).toBeNull();
    move(el, 1, { x: 50, y: 50 }, 'pen');
    expect(marquee().style.display).toBe('block');
    up(el, 1, { x: 50, y: 50 }, 'pen');
  });

  it('the canvas ground takes every touch for its own gestures', () => {
    renderCanvas();
    expect(ground().className).toContain('touch-none');
  });
});

describe('mouse stays as it was', () => {
  const mouse = (p: Pt, extra: Record<string, unknown> = {}) => ({
    pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, clientX: p.x, clientY: p.y, ...extra,
  });

  it('a left drag on empty canvas draws a rectangle past 4px and never pans', () => {
    renderCanvas();
    const g = ground();
    fireEvent.pointerDown(g, mouse({ x: 10, y: 10 }));
    fireEvent.pointerMove(g, mouse({ x: 15, y: 10 }));
    expect(marquee().style.display).toBe('block');
    fireEvent.pointerUp(g, mouse({ x: 15, y: 10 }));
    expect(camera()).toEqual({ panX: 0, panY: 0, zoom: 1 });
  });

  it('a press on an unselected node arms a move of that node', () => {
    renderCanvas();
    fireEvent.pointerDown(nodeEl(nested), mouse({ x: 5, y: 5 }));
    expect(getDragManager()!.sourceNodeId).toBe(nested.id);
  });

  it('middle mouse pans, wheel pans, ctrl+wheel zooms', () => {
    renderCanvas();
    const g = ground();
    fireEvent.pointerDown(g, mouse({ x: 10, y: 10 }, { button: 1 }));
    fireEvent.pointerMove(g, mouse({ x: 40, y: 30 }, { button: 1 }));
    fireEvent.pointerUp(g, mouse({ x: 40, y: 30 }, { button: 1 }));
    expect(camera()).toEqual({ panX: 30, panY: 20, zoom: 1 });
    fireEvent.wheel(g, { deltaX: 10, deltaY: 5 });
    expect(camera()).toEqual({ panX: 20, panY: 15, zoom: 1 });
    fireEvent.wheel(g, { deltaY: -1, ctrlKey: true, clientX: 0, clientY: 0 });
    expect(camera().zoom).toBeCloseTo(1.05);
  });

  it('a mouse double-click still edits text and is not taken for a touch', () => {
    renderCanvas();
    fireEvent.doubleClick(nodeEl(nested));
    expect(store.editorUI.editingComponent?.id).toBe(nested.id);
  });
});
