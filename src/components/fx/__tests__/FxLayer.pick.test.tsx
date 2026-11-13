// Picking a layer by clicking it on the live canvas, and dragging a picked text box
// (../FxLayer, ../useCanvasPick, ../FxPickOutline), with the lazy mount stood in for and the real
// pick code over a probe built from real three.js planes. What is asked here: when a press is a
// pick and when it is the box's, that the canvas scaled to 60 percent still hits and drags right,
// and that a drag is one undo step that undo restores, that Escape and a lost scene leave
// nothing behind, and that no press is eaten after the fact.

import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Group, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry } from 'three';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import { EditorTool } from '@/stores/EditorUIStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import { addFxLayer, fxFromPreset, type FxEdit } from '@/lib/fxScene/edit';
import { FX_PROP } from '@/lib/fxScene/marker';
import { parseFxProp } from '@/lib/fxScene/fxScene';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

interface Drawn {
  layer: HTMLElement;
  options: { onLive: () => void; onOff: (reason: string) => void; onProbe?: (probe: unknown) => void };
  tornDown: boolean;
}
const drawn: Drawn[] = [];
const active = () => drawn.filter((d) => !d.tornDown);

vi.mock('@/lib/fxScene/mount', () => ({
  renderFxScene: (layer: HTMLElement, _stored: unknown, options: Drawn['options']) => {
    const entry: Drawn = { layer, options, tornDown: false };
    drawn.push(entry);
    return { update: () => {}, teardown: () => void (entry.tornDown = true) };
  },
}));

import { FxCanvasLayer } from '../FxLayer';

const ok = (edit: FxEdit & { layerId?: string }) => {
  if (!edit.ok) throw new Error(edit.message);
  return edit;
};
const flush = () => act(async () => {});

// The canvas is shown at 60 percent: 800 by 500 layout pixels, 480 wide on screen, at (100, 50).
const LAYOUT = { width: 800, height: 500 };
const RECT = { left: 100, top: 50, width: 480, height: 300 };
/** A point of the layout canvas (fractions of its size) in screen coordinates. */
const screenAt = (fx: number, fy: number) => ({ x: RECT.left + fx * RECT.width, y: RECT.top + fy * RECT.height });

const camera = new PerspectiveCamera(50, 1.6, 0.1, 100);
camera.position.set(0, 0, 5);
camera.updateMatrixWorld();
const frameWidth = 2 * Math.tan((50 * Math.PI) / 360) * 5 * 1.6;

let box: ComponentInstance;
let textBoxId: string;
let textId: string;
let boxEl: HTMLElement;
let child: HTMLElement;
let reachedDocument: ReturnType<typeof vi.fn<(e: Event) => void>>;

const positionOf = () => {
  const read = parseFxProp((box.props as Record<string, unknown>)[FX_PROP]);
  if (!read.ok) throw new Error('unreadable');
  return read.fx.scene.layers.find((l) => l.id === textBoxId)!.params.position.value as [number, number];
};

const event = (type: string, init: { x?: number; y?: number; button?: number; shift?: boolean; pointerType?: string; key?: string } = {}) => {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, button: init.button ?? 0, clientX: init.x ?? 0, clientY: init.y ?? 0, shiftKey: init.shift ?? false });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  Object.defineProperty(e, 'isPrimary', { value: true });
  Object.defineProperty(e, 'pointerType', { value: init.pointerType ?? 'mouse' });
  return e;
};
const press = (target: Element, x: number, y: number, extra: Parameters<typeof event>[1] = {}) => act(() => void target.dispatchEvent(event('pointerdown', { x, y, ...extra })));
const move = (x: number, y: number) => act(() => void window.dispatchEvent(event('pointermove', { x, y })));
const release = (x: number, y: number) => act(() => void window.dispatchEvent(event('pointerup', { x, y })));
const escape = () => act(() => void window.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))));

/** The scene's probe: the text box as a real plane (its text rectangle half the frame wide, plus padding). */
const probe = () => {
  const root = new Group();
  root.add(new Mesh(new PlaneGeometry(frameWidth * 0.5 + 0.8, 1.4), new MeshBasicMaterial()));
  const layer = { id: textBoxId, type: 'textBox', name: 'Text', visible: true, blend: 'normal', params: { width: { type: 'number', value: 0.5 } } };
  // A text lockup to the right of it.
  const lockup = new Group();
  const plate = new Mesh(new PlaneGeometry(1.2, 0.5), new MeshBasicMaterial());
  plate.position.set(2.6, 0, 0);
  lockup.add(plate);
  const lockupLayer = { id: textId, type: 'text', name: 'Lockup', visible: true, blend: 'normal', params: {} };
  return {
    camera,
    canvas: document.createElement('canvas'),
    layers: () => [
      { layer, root },
      { layer: lockupLayer, root: lockup },
    ],
    invalidate: () => {},
  };
};

/** Mount the canvas layer for the selected box and make its scene live with the probe handed over. */
async function mountLive() {
  // The pick code is fetched by a dynamic import: loaded first, so the first test does not race its transform.
  await import('@/lib/fx/pick');
  const view = render(
    <div data-box="">
      <FxCanvasLayer stored={(box.props as Record<string, unknown>)[FX_PROP]} />
      <span data-child="">child</span>
    </div>,
  );
  await flush();
  await flush();
  const layerEl = document.querySelector('[data-fc-fx-layer]') as HTMLElement;
  Object.defineProperty(layerEl, 'offsetWidth', { value: LAYOUT.width, configurable: true });
  Object.defineProperty(layerEl, 'offsetHeight', { value: LAYOUT.height, configurable: true });
  layerEl.getBoundingClientRect = () => ({ ...RECT, right: RECT.left + RECT.width, bottom: RECT.top + RECT.height, x: RECT.left, y: RECT.top, toJSON: () => ({}) });
  boxEl = document.querySelector('[data-box]') as HTMLElement;
  child = document.querySelector('[data-child]') as HTMLElement;
  act(() => active()[0].options.onLive());
  act(() => active()[0].options.onProbe!(probe()));
  await flush();
  return view;
}

beforeEach(() => {
  drawn.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = createRootStore();
  store.projectStore.createProject('Pick');
  const project = store.projectStore.findProjectByTitle('Pick')!;
  const page = project.findPageBySlug('')!;
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  getHistoryStore()!.setTargetStore(store.projectStore);
  box = page.insertRegistryComponent('fxScene', { kind: 'appTree' })!;
  const withBox = ok(addFxLayer(ok(fxFromPreset()).stored, 'textBox'));
  textBoxId = withBox.layerId!;
  const withText = ok(addFxLayer(withBox.stored, 'text'));
  textId = withText.layerId!;
  box.setProps({ [FX_PROP]: withText.stored });
  getHistoryStore()!.clear();
  store.editorUI.selectComponent(box, page.sortedViewportNodes[0].breakpointId!);
  store.editorUI.startFxLive(box.id, null);
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false && query.includes('reduce'), addEventListener: () => {}, removeEventListener: () => {} }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({ getExtension: () => null })) as never);
  reachedDocument = vi.fn<(e: Event) => void>();
  document.addEventListener('pointerdown', reachedDocument);
});
afterEach(() => {
  document.removeEventListener('pointerdown', reachedDocument);
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CENTRE = screenAt(0.5, 0.5);
const CORNER = screenAt(0.97, 0.05);

describe('a press on the box', () => {
  it('a hit picks the layer, and the box does not see the press nor its click', async () => {
    await mountLive();
    await press(boxEl, CENTRE.x, CENTRE.y);
    expect(store.editorUI.fxLayerPick).toEqual({ componentId: box.id, kind: 'layer', layerId: textBoxId });
    expect(reachedDocument).not.toHaveBeenCalled();
    const clicked = vi.fn();
    document.addEventListener('click', clicked);
    await release(CENTRE.x, CENTRE.y);
    act(() => void boxEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(clicked).not.toHaveBeenCalled();
    document.removeEventListener('click', clicked);
    // The box stays the selection.
    expect(store.editorUI.selectedComponent?.id).toBe(box.id);
  });

  it('a miss leaves the box selected and is the box\'s own press', async () => {
    await mountLive();
    await press(boxEl, CORNER.x, CORNER.y);
    expect(store.editorUI.fxLayerPick).toBeUndefined();
    expect(reachedDocument).toHaveBeenCalledTimes(1);
    expect(store.editorUI.selectedComponent?.id).toBe(box.id);
  });

  it('an HTML child of the box over the layer wins the press', async () => {
    await mountLive();
    await press(child, CENTRE.x, CENTRE.y);
    expect(store.editorUI.fxLayerPick).toBeUndefined();
    expect(reachedDocument).toHaveBeenCalledTimes(1);
  });

  it('the first click on a box selects it: only a box that is already the selection picks', async () => {
    await mountLive();
    act(() => store.editorUI.clearSelection());
    await press(boxEl, CENTRE.x, CENTRE.y);
    expect(store.editorUI.fxLayerPick).toBeUndefined();
    expect(reachedDocument).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['with Shift (a toggle in the selection)', { shift: true }],
    ['with the middle button (a pan)', { button: 1 }],
    ['with a finger', { pointerType: 'touch' }],
  ])('%s is not a pick', async (_name, extra) => {
    await mountLive();
    await press(boxEl, CENTRE.x, CENTRE.y, extra);
    expect(store.editorUI.fxLayerPick).toBeUndefined();
    expect(reachedDocument).toHaveBeenCalledTimes(1);
  });

  it('with the Grab tool (a pan) it is not a pick', async () => {
    await mountLive();
    act(() => store.editorUI.setSelectedTool(EditorTool.GRAB));
    await press(boxEl, CENTRE.x, CENTRE.y);
    expect(store.editorUI.fxLayerPick).toBeUndefined();
    expect(reachedDocument).toHaveBeenCalledTimes(1);
  });

  it('a scene that stopped drawing (a lost context, a refused scene) picks nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mountLive();
    act(() => active()[0].options.onOff('context-lost'));
    await press(boxEl, CENTRE.x, CENTRE.y);
    expect(store.editorUI.fxLayerPick).toBeUndefined();
    expect(reachedDocument).toHaveBeenCalledTimes(1);
  });

  it('a scene whose probe is gone picks nothing', async () => {
    await mountLive();
    act(() => active()[0].options.onProbe!(null));
    await press(boxEl, CENTRE.x, CENTRE.y);
    expect(store.editorUI.fxLayerPick).toBeUndefined();
  });

  it('the click of a swallowed press does not wait for ever: the next press ends the wait', async () => {
    await mountLive();
    await press(boxEl, CENTRE.x, CENTRE.y);
    // No click ever came (a cancelled pointer); the next press is a miss, and its click is the box's.
    await press(boxEl, CORNER.x, CORNER.y);
    const clicked = vi.fn();
    document.addEventListener('click', clicked);
    act(() => void boxEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(clicked).toHaveBeenCalledTimes(1);
    document.removeEventListener('click', clicked);
  });

  it('shows the outline of the picked layer, and takes it away with the pick', async () => {
    await mountLive();
    expect(document.querySelector('[data-fc-fx-outline-box]')).toBeNull();
    await press(boxEl, CENTRE.x, CENTRE.y);
    await waitFor(() => expect(document.querySelector('[data-fc-fx-outline-box]')).not.toBeNull());
    const outline = document.querySelector('[data-fc-fx-outline-box]') as HTMLElement;
    // Layout pixels: the text rectangle is 0.5 of the frame, 400 of the 800.
    expect(parseFloat(outline.style.width)).toBeGreaterThan(380);
    expect(parseFloat(outline.style.width)).toBeLessThan(430);
    act(() => store.editorUI.clearFxLayerPick());
    await waitFor(() => expect(document.querySelector('[data-fc-fx-outline-box]')).toBeNull());
  });
});

describe('dragging a picked text box', () => {
  const entries = () => getHistoryStore()!.history.length;

  it('at 60 percent zoom the text follows the pointer, in one undo step that undo restores', async () => {
    await mountLive();
    const start = positionOf();
    await press(boxEl, CENTRE.x, CENTRE.y);
    // 48 screen pixels at 60 percent are 80 layout pixels: a tenth of the 800.
    await move(CENTRE.x + 24, CENTRE.y);
    await move(CENTRE.x + 48, CENTRE.y + 30);
    expect(positionOf()[0]).toBeCloseTo(start[0] + 0.1, 5);
    expect(positionOf()[1]).toBeCloseTo(start[1] + 0.1, 5);
    // Nothing is recorded while the gesture runs.
    expect(entries()).toBe(0);
    await release(CENTRE.x + 48, CENTRE.y + 30);
    expect(entries()).toBe(1);
    expect(getHistoryStore()!.batch).toBeUndefined();
    act(() => getHistoryStore()!.undo());
    expect(positionOf()).toEqual(start);
    expect(getHistoryStore()!.canUndo).toBe(false);
    act(() => getHistoryStore()!.redo());
    expect(positionOf()[0]).toBeCloseTo(start[0] + 0.1, 5);
  });

  it('keeps the text inside the box', async () => {
    await mountLive();
    await press(boxEl, CENTRE.x, CENTRE.y);
    await move(CENTRE.x + 5000, CENTRE.y - 5000);
    await release(0, 0);
    expect(positionOf()).toEqual([1, 0]);
  });

  it('Escape ends the drag, puts the text back and records nothing; the layer stays picked', async () => {
    await mountLive();
    const start = positionOf();
    await press(boxEl, CENTRE.x, CENTRE.y);
    await move(CENTRE.x + 40, CENTRE.y);
    expect(positionOf()).not.toEqual(start);
    await escape();
    expect(positionOf()).toEqual(start);
    expect(entries()).toBe(0);
    expect(store.editorUI.fxLayerPick?.kind).toBe('layer');
    // The drag is over: a later move does nothing.
    await move(CENTRE.x + 90, CENTRE.y);
    expect(positionOf()).toEqual(start);
  });

  it('a press and less than 3 pixels is a click: nothing moves and nothing is recorded', async () => {
    await mountLive();
    const start = positionOf();
    await press(boxEl, CENTRE.x, CENTRE.y);
    await move(CENTRE.x + 2, CENTRE.y + 1);
    await release(CENTRE.x + 2, CENTRE.y + 1);
    expect(positionOf()).toEqual(start);
    expect(entries()).toBe(0);
    expect(store.editorUI.fxLayerPick?.kind).toBe('layer');
  });

  it('a cancelled pointer ends the drag and leaves the text where it started', async () => {
    await mountLive();
    const start = positionOf();
    await press(boxEl, CENTRE.x, CENTRE.y);
    await move(CENTRE.x + 40, CENTRE.y);
    act(() => void window.dispatchEvent(event('pointercancel')));
    expect(positionOf()).toEqual(start);
    expect(entries()).toBe(0);
    expect(getHistoryStore()!.batch).toBeUndefined();
  });

  it('another gesture\'s open batch is neither folded into nor undone: the drag does not start', async () => {
    await mountLive();
    const start = positionOf();
    getHistoryStore()!.startBatch('Resize');
    await press(boxEl, CENTRE.x, CENTRE.y);
    await move(CENTRE.x + 40, CENTRE.y);
    await release(CENTRE.x + 40, CENTRE.y);
    expect(positionOf()).toEqual(start);
    expect(getHistoryStore()!.batch?.name).toBe('Resize');
    getHistoryStore()!.cancelBatch();
  });

  it('the scene going away mid-drag ends the drag and leaves nothing behind', async () => {
    const view = await mountLive();
    const start = positionOf();
    await press(boxEl, CENTRE.x, CENTRE.y);
    await move(CENTRE.x + 40, CENTRE.y);
    view.unmount();
    expect(positionOf()).toEqual(start);
    expect(entries()).toBe(0);
    expect(getHistoryStore()!.batch).toBeUndefined();
  });

  it('a layer that is not a text box is picked and never dragged', async () => {
    await mountLive();
    const start = positionOf();
    const lockup = screenAt(0.5 + 0.5 * (2.6 / (frameWidth / 2)), 0.5);
    await press(boxEl, lockup.x, lockup.y);
    expect(store.editorUI.fxLayerPick).toEqual({ componentId: box.id, kind: 'layer', layerId: textId });
    await move(lockup.x + 60, lockup.y);
    await release(lockup.x + 60, lockup.y);
    expect(positionOf()).toEqual(start);
    expect(entries()).toBe(0);
  });
});
