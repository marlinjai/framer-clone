// Spacing handles under a finger in the phone layout: they keep clear of the
// resize handles' touch areas (src/lib/canvas/spacingGeometry.ts placeHandles),
// and a press first decides between the spacing drag and the selection's
// long-press menu (src/lib/canvas/handlePress.ts), like the resize handles.
// jsdom has no layout, so the selected element and its frame get stubbed rects.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import { TransformProvider } from '@/contexts/TransformContext';
import { LONG_PRESS_MS, TOUCH_DRAG_THRESHOLD_PX } from '@/lib/canvas/touchGestures';
import { HANDLE_MIN_OFFSET, TOUCH_HANDLE_MIN_OFFSET } from '@/lib/canvas/spacingGeometry';
import SpacingHandlesLayer from '../SpacingHandlesLayer';

let store: RootStoreType;
let phone = true;

vi.mock('@/hooks/useStore', () => ({
  useStore: () => store,
}));
vi.mock('@/hooks/use-mobile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-mobile')>()),
  matchesPhone: () => phone,
}));

let main: ComponentInstance;
let breakpointId: string;
let host: HTMLElement;

const ELEMENT = { left: 100, top: 100, width: 300, height: 200 };

function stubRect(el: Element, r: { left: number; top: number; width: number; height: number }) {
  el.getBoundingClientRect = () => ({
    ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r,
  }) as DOMRect;
}

beforeEach(() => {
  phone = true;
  store = createRootStore();
  const { projectStore, editorUI } = store;
  projectStore.createProject('Spacing touch');
  const project = projectStore.findProjectByTitle('Spacing touch')!;
  const page = project.findPageBySlug('')!;
  editorUI.setCurrentProject(project);
  editorUI.setCurrentPage(page);
  main = (page.appComponentTree as ComponentInstance).children[0] as ComponentInstance;
  breakpointId = page.sortedViewportNodes[0].breakpointId!;
  editorUI.selectComponent(main, breakpointId);

  // The rendered element inside its frame, as the canvas would have it.
  host = document.createElement('div');
  host.setAttribute('data-viewport-content-id', 'frame');
  stubRect(host, { left: 0, top: 0, width: 2000, height: 2000 });
  const el = document.createElement('div');
  el.setAttribute('data-component-id', `${breakpointId}-${main.id}`);
  stubRect(el, ELEMENT);
  Object.defineProperty(el, 'offsetWidth', { value: ELEMENT.width });
  host.appendChild(el);
  document.body.appendChild(host);
});

afterEach(() => {
  cleanup();
  host.remove();
  document.documentElement.removeAttribute('data-pointer');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function renderLayer(pointer: 'touch' | 'mouse') {
  document.documentElement.setAttribute('data-pointer', pointer);
  render(
    <TransformProvider>
      <SpacingHandlesLayer />
    </TransformProvider>,
  );
  // The layer measures one frame after mounting.
  await act(async () => { await new Promise(r => requestAnimationFrame(() => r(null))); });
}

const handle = (id: string) => document.querySelector<HTMLElement>(`[data-spacing-handle="${id}"]`);
const centreX = (el: HTMLElement) => {
  const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(el.style.transform)!;
  return Number(m[1]) + parseFloat(el.style.width) / 2;
};
const marginRight = () => main.getResponsiveStyleValue('marginRight', breakpointId);

describe('placement', () => {
  it('under touch, a 0px margin handle sits the touch offset outside, clear of the east resize handle', async () => {
    await renderLayer('touch');
    const h = handle('margin-right')!;
    expect(centreX(h)).toBe(ELEMENT.left + ELEMENT.width + TOUCH_HANDLE_MIN_OFFSET);
  });

  it('with a mouse it stays where it always was', async () => {
    await renderLayer('mouse');
    const h = handle('margin-right')!;
    expect(centreX(h)).toBe(ELEMENT.left + ELEMENT.width + HANDLE_MIN_OFFSET);
  });
});

describe('press gate on phones', () => {
  it('a finger drag past the threshold starts the spacing drag once, measured from the press point', async () => {
    await renderLayer('touch');
    const h = handle('margin-right')!;
    const x = centreX(h);
    const y = ELEMENT.top + ELEMENT.height / 2;
    const notPrevented = fireEvent.pointerDown(h, {
      pointerId: 3, pointerType: 'touch', isPrimary: true, button: 0, clientX: x, clientY: y,
    });
    expect(notPrevented).toBe(false);
    // Within the threshold: nothing yet.
    fireEvent.pointerMove(document, { pointerId: 3, pointerType: 'touch', clientX: x + TOUCH_DRAG_THRESHOLD_PX - 1, clientY: y });
    expect(marginRight()).toBeUndefined();
    // Past it: the drag starts from the press point and applies this move at once (no jump).
    fireEvent.pointerMove(document, { pointerId: 3, pointerType: 'touch', clientX: x + 20, clientY: y });
    expect(marginRight()).toBe('20px');
    fireEvent.pointerMove(document, { pointerId: 3, pointerType: 'touch', clientX: x + 30, clientY: y });
    expect(marginRight()).toBe('30px');
    fireEvent.pointerUp(document, { pointerId: 3, pointerType: 'touch' });
    fireEvent.pointerMove(document, { pointerId: 3, pointerType: 'touch', clientX: x + 90, clientY: y });
    expect(marginRight()).toBe('30px');
    expect(store.editorUI.phoneContextMenu).toBeUndefined();
  });

  it('a still hold opens the selection\'s long-press menu and changes nothing', async () => {
    await renderLayer('touch');
    vi.useFakeTimers();
    const h = handle('margin-right')!;
    const x = centreX(h);
    fireEvent.pointerDown(h, { pointerId: 4, pointerType: 'touch', isPrimary: true, button: 0, clientX: x, clientY: 200 });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS - 1); });
    expect(store.editorUI.phoneContextMenu).toBeUndefined();
    act(() => { vi.advanceTimersByTime(1); });
    expect(store.editorUI.phoneContextMenu).toEqual({ x, y: 200 });
    fireEvent.pointerMove(document, { pointerId: 4, pointerType: 'touch', clientX: x + 40, clientY: 200 });
    fireEvent.pointerUp(document, { pointerId: 4, pointerType: 'touch' });
    expect(marginRight()).toBeUndefined();
  });

  it('a pen drags at once, and a finger outside the phone layout too', async () => {
    await renderLayer('touch');
    const h = handle('margin-right')!;
    const x = centreX(h);
    fireEvent.pointerDown(h, { pointerId: 5, pointerType: 'pen', isPrimary: true, button: 0, clientX: x, clientY: 200 });
    fireEvent.pointerMove(window, { pointerId: 5, pointerType: 'pen', clientX: x + 4, clientY: 200 });
    fireEvent.pointerUp(window, { pointerId: 5, pointerType: 'pen' });
    expect(marginRight()).toBe('4px');

    phone = false;
    const again = handle('margin-right')!;
    const x2 = centreX(again);
    fireEvent.pointerDown(again, { pointerId: 6, pointerType: 'touch', isPrimary: true, button: 0, clientX: x2, clientY: 200 });
    fireEvent.pointerMove(window, { pointerId: 6, pointerType: 'touch', clientX: x2 + 3, clientY: 200 });
    fireEvent.pointerUp(window, { pointerId: 6, pointerType: 'touch' });
    expect(store.editorUI.phoneContextMenu).toBeUndefined();
    // No renderer here: the drag starts again from the element's computed 0px.
    expect(marginRight()).toBe('3px');
  });
});
