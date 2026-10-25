// Inline text editing on the canvas, started by a finger or a mouse.
//
// iOS Safari opens the on-screen keyboard only for a focus() made
// synchronously inside a touchend (or click) handler, on an element that is
// editable at that moment (src/lib/canvas/inlineTextEdit.ts). These tests
// drive the real event order of a finger (pointerdown, touchstart,
// pointerup, touchend, then the click a tap produces unless the touchend was
// cancelled) and check what holds INSIDE the touchend dispatch, before any
// timer, promise or React re-render: the element is contentEditable,
// selectable and focused, with the caret in it. jsdom cannot prove that the
// keyboard opens; that needs the phone (or WebKit, see the pull request).
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { reaction } from 'mobx';
import { createRootStore, getDragManager, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import { TransformProvider } from '@/contexts/TransformContext';
import { EditorTool } from '@/stores/EditorUIStore';
import Canvas from '../Canvas';
import HudSurface from '../HudSurface';

let store: RootStoreType;

vi.mock('@/hooks/useStore', () => ({
  useStore: () => store,
}));

let main: ComponentInstance;
let nested: ComponentInstance;
let breakpointId: string;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  (document as { elementsFromPoint?: Document['elementsFromPoint'] }).elementsFromPoint = () => [];
  store = createRootStore();
  const { projectStore, editorUI } = store;
  projectStore.createProject('Canvas text edit');
  const project = projectStore.findProjectByTitle('Canvas text edit')!;
  const page = project.findPageBySlug('')!;
  editorUI.setCurrentProject(project);
  editorUI.setCurrentPage(page);
  const root = page.appComponentTree as ComponentInstance;
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
  delete (document as { elementsFromPoint?: Document['elementsFromPoint'] }).elementsFromPoint;
});

function renderCanvas(withHud = false) {
  return render(
    <TransformProvider>
      <Canvas />
      {withHud && <HudSurface />}
    </TransformProvider>,
  );
}

const ground = () => document.querySelector<HTMLElement>('[data-ground]')!;
const nodeEl = (c: ComponentInstance) =>
  document.querySelector<HTMLElement>(`[data-inner-component-id="${c.id}"]`)!;

function camera() {
  const raw = document.querySelector('[data-camera-transform]')!.getAttribute('data-camera-transform')!;
  const [panX, panY, zoom] = raw.split(',').map(Number);
  return { panX, panY, zoom };
}

type Pt = { x: number; y: number };
const pointer = (id: number, p: Pt) => ({
  pointerId: id,
  pointerType: 'touch',
  isPrimary: true,
  button: 0,
  clientX: p.x,
  clientY: p.y,
});

/** A TouchEvent-shaped event (jsdom has no Touch constructor). */
function touchEvent(type: string, id: number, p: Pt, fingersAfter: number): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  const t = { identifier: id, clientX: p.x, clientY: p.y };
  Object.defineProperty(ev, 'changedTouches', { value: [t] });
  Object.defineProperty(ev, 'touches', { value: Array.from({ length: fingersAfter }, () => t) });
  return ev;
}

/** One finger tap the way a phone sends it. Returns the touchend event. */
function fingerTap(el: Element, id: number, p: Pt): Event {
  fireEvent.pointerDown(el, pointer(id, p));
  act(() => {
    el.dispatchEvent(touchEvent('touchstart', id, p, 1));
  });
  fireEvent.pointerUp(el, pointer(id, p));
  const end = touchEvent('touchend', id, p, 0);
  act(() => {
    el.dispatchEvent(end);
  });
  // The browser sends a click after a tap unless the touchend was cancelled.
  if (!end.defaultPrevented) fireEvent.click(el);
  return end;
}

describe('double-tap to edit text, from touch events', () => {
  it('turns the text editable and focuses it inside the touchend, before any re-render', () => {
    renderCanvas();
    const el = nodeEl(nested);
    const inside: Record<string, unknown> = {};
    // Runs in the same touchend dispatch, after the canvas's capture listener.
    const probe = () => {
      const sel = window.getSelection();
      inside.editable = el.getAttribute('contenteditable');
      inside.selectable = el.style.userSelect;
      inside.focused = document.activeElement === el;
      inside.caretIn = !!sel?.anchorNode && el.contains(sel.anchorNode);
      inside.storeEditing = store.editorUI.editingComponent?.id;
    };
    fingerTap(el, 1, { x: 5, y: 5 });
    window.addEventListener('touchend', probe);
    const end = fingerTap(el, 2, { x: 6, y: 6 });
    window.removeEventListener('touchend', probe);
    expect(inside).toEqual({ editable: 'true', selectable: 'text', focused: true, caretIn: true, storeEditing: nested.id });
    // Cancelled: no emulated mouse events or click follow into the text.
    expect(end.defaultPrevented).toBe(true);
    // After React has re-rendered: the same DOM node, still focused and editable.
    expect(nodeEl(nested)).toBe(el);
    expect(document.activeElement).toBe(el);
    expect(el.getAttribute('contenteditable')).toBe('true');
    expect(el.style.userSelect).toBe('text');
  });

  it('a click after the double-tap does not end editing or change the selection', () => {
    renderCanvas();
    const el = nodeEl(nested);
    fingerTap(el, 1, { x: 5, y: 5 });
    fingerTap(el, 2, { x: 5, y: 5 });
    fireEvent.click(el);
    expect(store.editorUI.editingComponent?.id).toBe(nested.id);
    expect(store.editorUI.selectedComponent?.id).toBe(nested.id);
    expect(document.activeElement).toBe(el);
  });

  it('a finger in the text keeps editing; a press elsewhere on the canvas commits and ends it', () => {
    renderCanvas();
    const el = nodeEl(nested);
    fingerTap(el, 1, { x: 5, y: 5 });
    fingerTap(el, 2, { x: 5, y: 5 });
    fireEvent.pointerDown(el, pointer(3, { x: 8, y: 5 }));
    fireEvent.pointerUp(el, pointer(3, { x: 8, y: 5 }));
    expect(store.editorUI.editingComponent?.id).toBe(nested.id);
    el.textContent = 'Typed on a phone';
    fireEvent.pointerDown(ground(), pointer(4, { x: 300, y: 300 }));
    fireEvent.pointerUp(ground(), pointer(4, { x: 300, y: 300 }));
    expect(store.editorUI.editingComponent).toBeUndefined();
    expect(nested.props.children).toBe('Typed on a phone');
  });

  it('a double-tap on a selection handle above the text edits the text under it', () => {
    store.editorUI.selectComponent(nested, breakpointId);
    renderCanvas();
    const el = nodeEl(nested);
    // A resize handle's 44px touch target covers a small text; it lives in
    // the HUD, outside the canvas ground.
    const handle = document.createElement('div');
    handle.setAttribute('data-resize-direction', 'n');
    document.body.appendChild(handle);
    (document as { elementsFromPoint?: Document['elementsFromPoint'] }).elementsFromPoint = () => [handle, el, ground()];
    const tapOnHandle = (id: number) => {
      act(() => {
        handle.dispatchEvent(touchEvent('touchstart', id, { x: 5, y: 5 }, 1));
      });
      act(() => {
        handle.dispatchEvent(touchEvent('touchend', id, { x: 5, y: 5 }, 0));
      });
    };
    tapOnHandle(1);
    tapOnHandle(2);
    expect(store.editorUI.editingComponent?.id).toBe(nested.id);
    expect(document.activeElement).toBe(el);
    handle.remove();
  });

  it('while editing, the resize and corner handles step aside', () => {
    store.editorUI.selectComponent(nested, breakpointId);
    renderCanvas(true);
    const handles = () => document.querySelector<HTMLElement>('[data-testid="resize-handles"]')!.parentElement!;
    expect(handles().style.display).toBe('');
    const el = nodeEl(nested);
    fingerTap(el, 1, { x: 5, y: 5 });
    fingerTap(el, 2, { x: 5, y: 5 });
    expect(handles().style.display).toBe('none');
    act(() => el.blur());
    expect(handles().style.display).toBe('');
  });

  it('a pinch between the taps is not a double-tap', () => {
    renderCanvas();
    const el = nodeEl(nested);
    fingerTap(el, 1, { x: 5, y: 5 });
    act(() => {
      el.dispatchEvent(touchEvent('touchstart', 2, { x: 5, y: 5 }, 1));
      el.dispatchEvent(touchEvent('touchstart', 3, { x: 50, y: 5 }, 2));
      el.dispatchEvent(touchEvent('touchend', 3, { x: 50, y: 5 }, 1));
      el.dispatchEvent(touchEvent('touchend', 2, { x: 5, y: 5 }, 0));
    });
    fingerTap(el, 4, { x: 5, y: 5 });
    expect(store.editorUI.editingComponent).toBeUndefined();
  });

  it('a tap on the editor chrome between the taps breaks the double-tap', () => {
    renderCanvas();
    const el = nodeEl(nested);
    const bar = document.createElement('button');
    document.body.appendChild(bar);
    fingerTap(el, 1, { x: 5, y: 5 });
    act(() => {
      bar.dispatchEvent(touchEvent('touchstart', 2, { x: 5, y: 5 }, 1));
      bar.dispatchEvent(touchEvent('touchend', 2, { x: 5, y: 5 }, 0));
    });
    fingerTap(el, 3, { x: 5, y: 5 });
    expect(store.editorUI.editingComponent).toBeUndefined();
    bar.remove();
  });

  it('double-tap on empty canvas zooms in one step, once', () => {
    renderCanvas();
    const g = ground();
    fingerTap(g, 1, { x: 100, y: 100 });
    fingerTap(g, 2, { x: 100, y: 100 });
    expect(camera()).toEqual({ panX: -50, panY: -50, zoom: 1.5 });
  });

  it('text bound to data is not edited on the canvas', () => {
    nested.setBinding('children', { mode: 'read', expression: '{{page.params.slug}}' });
    renderCanvas();
    const el = nodeEl(nested);
    fingerTap(el, 1, { x: 5, y: 5 });
    fingerTap(el, 2, { x: 5, y: 5 });
    expect(store.editorUI.editingComponent).toBeUndefined();
    expect(el.getAttribute('contenteditable')).toBeNull();
  });
});

describe('mouse double-click edits synchronously too', () => {
  it('focuses and selects the whole text inside the dblclick dispatch', () => {
    renderCanvas();
    const el = nodeEl(nested);
    let focusedInside = false;
    let selected = '';
    let editableInside = -1;
    // The handler stops the event, so the probe is the store change: a MobX
    // reaction runs synchronously when the action ends, still inside the
    // dblclick dispatch and before React re-renders.
    const stop = reaction(
      () => store.editorUI.editingComponent?.id,
      (id) => {
        if (id !== nested.id) return;
        focusedInside = document.activeElement === el;
        selected = window.getSelection()?.toString() ?? '';
        editableInside = el.hasAttribute('contenteditable') ? 1 : 0;
      },
    );
    fireEvent.doubleClick(el);
    stop();
    expect(editableInside).toBe(1);
    expect(focusedInside).toBe(true);
    expect(selected).toBe('Nested');
    expect(document.activeElement).toBe(el);
    expect(store.editorUI.editingComponent?.id).toBe(nested.id);
  });

  it('Enter commits the typed text as one undo step', () => {
    renderCanvas();
    const el = nodeEl(nested);
    fireEvent.doubleClick(el);
    el.textContent = 'Changed';
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(store.editorUI.editingComponent).toBeUndefined();
    expect(nested.props.children).toBe('Changed');
    act(() => getHistoryStore()!.undo());
    expect(nested.props.children).toBe('Nested');
    expect(nodeEl(nested).textContent).toBe('Nested');
  });
});
