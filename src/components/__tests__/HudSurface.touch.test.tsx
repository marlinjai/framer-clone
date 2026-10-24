// Resize and corner radius handles under a finger: they follow the finger's
// own pointer (a touch sends its compat mouse events only after lifting, so
// the mouse loop alone never ran), and a mouse keeps its mouse loop.
// jsdom has no layout: the overlay measures 0, so a gesture starts from 1px.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import { TransformProvider } from '@/contexts/TransformContext';
import HudSurface from '../HudSurface';

let store: RootStoreType;

vi.mock('@/hooks/useStore', () => ({
  useStore: () => store,
}));

let main: ComponentInstance;
let breakpointId: string;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = createRootStore();
  const { projectStore, editorUI } = store;
  projectStore.createProject('Hud touch');
  const project = projectStore.findProjectByTitle('Hud touch')!;
  const page = project.findPageBySlug('')!;
  editorUI.setCurrentProject(project);
  editorUI.setCurrentPage(page);
  main = (page.appComponentTree as ComponentInstance).children[0] as ComponentInstance;
  breakpointId = page.sortedViewportNodes[0].breakpointId!;
  editorUI.selectComponent(main, breakpointId);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderHud() {
  return render(
    <TransformProvider>
      <HudSurface />
    </TransformProvider>,
  );
}

const handle = (dir: string) => document.querySelector<HTMLElement>(`[data-testid="resize-handle-${dir}"]`)!;
const width = () => main.getResponsiveStyleValue('width', breakpointId);

describe('resize handles', () => {
  it('a finger drags the east handle', () => {
    renderHud();
    const notPrevented = fireEvent.pointerDown(handle('e'), {
      pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, clientX: 0, clientY: 0,
    });
    // Default prevented: no compat mouse events start the gesture a second time.
    expect(notPrevented).toBe(false);
    fireEvent.pointerMove(document, { pointerId: 7, pointerType: 'touch', clientX: 50, clientY: 0 });
    expect(width()).toBe('51px');
    // Another finger's movement is not this gesture.
    fireEvent.pointerMove(document, { pointerId: 8, pointerType: 'touch', clientX: 300, clientY: 0 });
    expect(width()).toBe('51px');
    fireEvent.pointerUp(document, { pointerId: 7, pointerType: 'touch' });
    fireEvent.pointerMove(document, { pointerId: 7, pointerType: 'touch', clientX: 90, clientY: 0 });
    expect(width()).toBe('51px');
    expect(store.editorUI.isResizing ?? false).toBe(false);
  });

  it('a pen drags it too, a mouse pointerdown leaves it to the mouse loop', () => {
    renderHud();
    fireEvent.pointerDown(handle('e'), { pointerId: 3, pointerType: 'pen', isPrimary: true, button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(document, { pointerId: 3, pointerType: 'pen', clientX: 20, clientY: 0 });
    fireEvent.pointerUp(document, { pointerId: 3, pointerType: 'pen' });
    expect(width()).toBe('21px');

    fireEvent.pointerDown(handle('e'), { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(document, { pointerId: 1, pointerType: 'mouse', clientX: 70, clientY: 0 });
    expect(width()).toBe('21px');
  });

  it('the mouse resize works exactly as before', () => {
    renderHud();
    fireEvent.mouseDown(handle('e'), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.mouseMove(document, { clientX: 30, clientY: 0 });
    fireEvent.mouseUp(document);
    expect(width()).toBe('31px');
  });
});

describe('corner radius handles', () => {
  it('a finger drags a corner inward to round it', () => {
    renderHud();
    const dot = document.querySelector<HTMLElement>('[data-testid="radius-handle-tl"]')!;
    fireEvent.pointerDown(dot, { pointerId: 4, pointerType: 'touch', isPrimary: true, button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(document, { pointerId: 4, pointerType: 'touch', clientX: 10, clientY: 10 });
    fireEvent.pointerUp(document, { pointerId: 4, pointerType: 'touch' });
    // jsdom overlay is 0 wide: the radius is capped at half of the 1px box
    // (0.5px, rounded to 1px). A mouse-only loop would have written nothing.
    expect(main.getResponsiveStyleValue('borderRadius', breakpointId)).toBe('1px');
  });
});
