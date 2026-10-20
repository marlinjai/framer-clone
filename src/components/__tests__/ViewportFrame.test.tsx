// ViewportFrame sizing (ResponsivePageRenderer): a breakpoint frame's height is
// at least viewportHeight and grows with the page content, per frame.
//
// jsdom has no layout engine, so growth itself is driven by a stubbed
// ResizeObserver plus a stubbed offsetHeight. What this proves: the frame has
// no fixed height and no inner scroller, the measurement reaches the model and
// the label, each frame is independent, and the frame's own CSS never depends
// on the measurement (the property that rules out a grow-forever loop for
// `height: 100%` content).
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, screen } from '@testing-library/react';
import { createViewportNode, createIntrinsicComponent } from '@/models/ComponentModel';
import { ViewportFrame } from '../ResponsivePageRenderer';

vi.mock('@/hooks/useStore', () => ({
  useStore: () => ({ editorUI: { setSelectedViewportNode: vi.fn(), selectComponent: vi.fn() } }),
}));
vi.mock('@/lib/drag', () => ({
  useDragSource: () => ({ onPointerDown: () => {} }),
}));
// The page tree itself is out of scope here; a root with height: 100% stands in.
vi.mock('../ComponentRenderer', () => ({
  __esModule: true,
  default: () => <div data-testid="page-root" style={{ height: '100%' }} />,
}));

type Observed = { el: Element; cb: ResizeObserverCallback };
let observed: Observed[] = [];
const OriginalRO = globalThis.ResizeObserver;

beforeEach(() => {
  observed = [];
  globalThis.ResizeObserver = class {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) { this.cb = cb; }
    observe(el: Element) { observed.push({ el, cb: this.cb }); }
    unobserve() {}
    disconnect() { observed = observed.filter(o => o.cb !== this.cb); }
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = OriginalRO;
});

const scope = { frames: [] } as never;
const breakpoints = [{ id: 'bp-d', minWidth: 1280 }, { id: 'bp-p', minWidth: 320 }];

function renderFrame(viewport: ReturnType<typeof createViewportNode>) {
  const tree = createIntrinsicComponent('root-1', 'div', {});
  return render(
    <ViewportFrame
      viewport={viewport}
      appComponentTree={tree}
      breakpoints={breakpoints}
      primaryBreakpointId="bp-d"
      scope={scope}
    />,
  );
}

function frameEl(viewportId: string): HTMLElement {
  return document.querySelector(`[data-viewport-id="${viewportId}"]`) as HTMLElement;
}

// Simulate the browser laying the frame out at `height` px and notifying.
function layout(viewportId: string, height: number) {
  const el = frameEl(viewportId);
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: height });
  act(() => {
    for (const o of observed.filter(o => o.el === el)) o.cb([], {} as ResizeObserver);
  });
}

describe('ViewportFrame', () => {
  it('has a minimum height, no fixed height and no inner scroller', () => {
    const vp = createViewportNode('vp-d', 'bp-d', 'Desktop', 1280, 100, 100, 1280, 800);
    renderFrame(vp);
    const frame = frameEl('vp-d');
    const content = document.querySelector('[data-viewport-content-id="vp-d"]') as HTMLElement;
    expect(frame.style.height).toBe('');
    expect(frame.style.width).toBe('1280px');
    expect(content.style.minHeight).toBe('800px');
    expect(content.style.height).toBe('');
    expect(content.style.overflow).toBe('hidden');
    expect(document.querySelector('.overflow-auto')).toBeNull();
    // The ground wrapper follows the frame instead of a 100x100 default box.
    const ground = document.getElementById('ground-wrapper-vp-d') as HTMLElement;
    expect(ground.style.width).toBe('1280px');
    expect(ground.style.height).toBe('auto');
  });

  it('content taller than the minimum grows the frame, and the label says so', () => {
    const vp = createViewportNode('vp-d', 'bp-d', 'Desktop', 1280, 100, 100, 1280, 800);
    renderFrame(vp);
    layout('vp-d', 2600);
    expect(vp.renderedViewportHeight).toBe(2600);
    expect(vp.viewportBounds.height).toBe(2600);
    expect(screen.getByTestId('viewport-frame-size').textContent).toBe('1280×2600(min 800)');
  });

  it('shorter content keeps the frame at its minimum', () => {
    const vp = createViewportNode('vp-d', 'bp-d', 'Desktop', 1280, 100, 100, 1280, 800);
    renderFrame(vp);
    layout('vp-d', 2600);
    layout('vp-d', 800); // content removed: the browser lays out at the min again
    expect(vp.viewportBounds.height).toBe(800);
    expect(screen.getByTestId('viewport-frame-size').textContent).toBe('1280×800');
  });

  it('100%-height content cannot feed back: the frame CSS ignores the measurement', () => {
    const vp = createViewportNode('vp-p', 'bp-p', 'Phone', 320, 2248, 100, 375, 667);
    renderFrame(vp);
    const content = () => document.querySelector('[data-viewport-content-id="vp-p"]') as HTMLElement;
    const before = content().getAttribute('style');
    layout('vp-p', 667);
    layout('vp-p', 667);
    expect(content().getAttribute('style')).toBe(before);
    expect(content().style.gridTemplateRows).toBe('minmax(667px, auto)');
    expect(vp.viewportBounds.height).toBe(667);
  });

  it('each breakpoint frame grows independently', () => {
    const d = createViewportNode('vp-d', 'bp-d', 'Desktop', 1280, 100, 100, 1280, 800);
    const p = createViewportNode('vp-p', 'bp-p', 'Phone', 320, 2248, 100, 375, 667);
    renderFrame(d);
    renderFrame(p);
    layout('vp-d', 1900);
    layout('vp-p', 4200);
    expect(d.viewportBounds.height).toBe(1900);
    expect(p.viewportBounds.height).toBe(4200);
    const labels = screen.getAllByTestId('viewport-frame-size').map(n => n.textContent);
    expect(labels).toEqual(['1280×1900(min 800)', '375×4200(min 667)']);
  });

  it('forgets the measurement on unmount', () => {
    const vp = createViewportNode('vp-d', 'bp-d', 'Desktop', 1280, 100, 100, 1280, 800);
    const { unmount } = renderFrame(vp);
    layout('vp-d', 2600);
    unmount();
    expect(vp.renderedViewportHeight).toBeUndefined();
    expect(observed).toEqual([]);
  });
});
