// PageFitOnRequest: "Open it" on an agent's new page asks the canvas to bring the
// page's frames into view (editorUI.requestPageFit); the camera then fits them,
// waiting for the frames to render, and does nothing until asked.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import { TransformProvider } from '@/contexts/TransformContext';
import PageFitOnRequest from '../PageFitOnRequest';

let store: RootStoreType;
let phone = false;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));
vi.mock('@/hooks/use-mobile', () => ({ useIsPhone: () => phone }));

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

/** A canvas 1000 x 800 whose camera has panned the page's frame far off to the right. */
function canvas(withFrame: boolean) {
  const ground = document.createElement('div');
  ground.setAttribute('data-ground', '');
  ground.getBoundingClientRect = () => rect(0, 0, 1000, 800);
  const camera = document.createElement('div');
  camera.setAttribute('data-camera-transform', '0,0,1');
  ground.append(camera);
  let frame: HTMLElement | undefined;
  const addFrame = () => {
    frame = document.createElement('div');
    frame.setAttribute('data-viewport-id', 'desktop');
    frame.getBoundingClientRect = () => rect(3000, 200, 600, 400);
    camera.append(frame);
  };
  if (withFrame) addFrame();
  document.body.append(ground);
  return { camera, addFrame, remove: () => ground.remove() };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  store = createRootStore();
  phone = false;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('PageFitOnRequest', () => {
  it('does nothing until asked; asked, it fits the page frames into the visible canvas', () => {
    const { camera, remove } = canvas(true);
    render(
      <TransformProvider>
        <PageFitOnRequest />
      </TransformProvider>,
    );
    act(() => vi.advanceTimersByTime(100));
    expect(camera.style.transform).toBe('');
    act(() => store.editorUI.requestPageFit());
    act(() => vi.advanceTimersByTime(50));
    // Centred: the 600 x 400 frame at x 3000 now sits inside the 1000 x 800 canvas, at 100% at most.
    const [panX, panY, zoom] = (camera.getAttribute('data-camera-transform') ?? '').split(',').map(Number);
    expect(zoom).toBe(1);
    expect(3000 * zoom + panX).toBeGreaterThanOrEqual(0);
    expect(3000 * zoom + panX + 600 * zoom).toBeLessThanOrEqual(1000);
    expect(200 * zoom + panY).toBeGreaterThanOrEqual(0);
    remove();
  });

  it('fits into the part of the canvas the person sees: under the top bar, between the sidebars, labels clear', () => {
    const { camera, remove } = canvas(true);
    const chrome = (attr: string, value: string | null, r: DOMRect) => {
      const el = document.createElement('div');
      if (value === null) el.setAttribute(attr, '');
      else el.setAttribute(attr, value);
      el.getBoundingClientRect = () => r;
      document.body.append(el);
      return el;
    };
    const parts = [
      chrome('data-editor-topbar', null, rect(0, 0, 1000, 64)),
      chrome('data-editor-chrome', 'left', rect(0, 64, 240, 736)),
      chrome('data-editor-chrome', 'right', rect(760, 64, 240, 736)),
    ];
    render(
      <TransformProvider>
        <PageFitOnRequest />
      </TransformProvider>,
    );
    act(() => store.editorUI.requestPageFit());
    act(() => vi.advanceTimersByTime(50));
    const [panX, panY, zoom] = (camera.getAttribute('data-camera-transform') ?? '').split(',').map(Number);
    const left = 3000 * zoom + panX;
    const right = left + 600 * zoom;
    const top = 200 * zoom + panY;
    expect(left).toBeGreaterThanOrEqual(240);
    expect(right).toBeLessThanOrEqual(760);
    expect(top).toBeGreaterThanOrEqual(64 + 28); // the label above the frame clears the top bar
    expect(zoom).toBeLessThan(1); // 600 px wide frame into 520 px between the sidebars
    for (const part of parts) part.remove();
    remove();
  });

  it('on a phone it leaves the camera to the phone layout, which fits on every page change', () => {
    phone = true;
    const { camera, remove } = canvas(true);
    render(
      <TransformProvider>
        <PageFitOnRequest />
      </TransformProvider>,
    );
    act(() => store.editorUI.requestPageFit());
    act(() => vi.advanceTimersByTime(100));
    expect(camera.style.transform).toBe('');
    remove();
  });

  it('the request is editor state only, never in the editor snapshot', async () => {
    const { getSnapshot } = await import('mobx-state-tree');
    store.editorUI.requestPageFit();
    expect(JSON.stringify(getSnapshot(store.editorUI))).not.toContain('pageFitRequest');
  });

  it('waits for the new page frames to render, then fits', () => {
    const { camera, addFrame, remove } = canvas(false);
    render(
      <TransformProvider>
        <PageFitOnRequest />
      </TransformProvider>,
    );
    act(() => store.editorUI.requestPageFit());
    act(() => vi.advanceTimersByTime(100)); // a few frames with nothing to measure
    expect(camera.style.transform).toBe('');
    addFrame();
    act(() => vi.advanceTimersByTime(50));
    expect(camera.style.transform).not.toBe('');
    remove();
  });
});
