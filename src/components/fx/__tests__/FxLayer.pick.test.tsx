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
import { addFxLayer, fxFromPreset, removeFxLayer, type FxEdit } from '@/lib/fxScene/edit';
import { FX_PROP } from '@/lib/fxScene/marker';
import { parseFxProp } from '@/lib/fxScene/fxScene';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

// The real pick code, with a spy on the call that lets go of its scratch canvas.
const { releaseScratch } = vi.hoisted(() => ({ releaseScratch: vi.fn() }));
vi.mock('@/lib/fx/pick', async (original) => {
  const real = await original<typeof import('@/lib/fx/pick')>();
  return {
    ...real,
    releaseScratch: () => {
      releaseScratch();
      real.releaseScratch();
    },
  };
});

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

const event = (type: string, init: { x?: number; y?: number; button?: number; buttons?: number; shift?: boolean; pointerType?: string; key?: string } = {}) => {
  // A button is down while the pointer is pressed or moving with it down; a release has none.
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, button: init.button ?? 0, buttons: init.buttons ?? (type === 'pointermove' || type === 'pointerdown' ? 1 : 0), clientX: init.x ?? 0, clientY: init.y ?? 0, shiftKey: init.shift ?? false });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  Object.defineProperty(e, 'isPrimary', { value: true });
  Object.defineProperty(e, 'pointerType', { value: init.pointerType ?? 'mouse' });
  return e;
};
const press = (target: Element, x: number, y: number, extra: Parameters<typeof event>[1] = {}) => act(() => void target.dispatchEvent(event('pointerdown', { x, y, ...extra })));
const move = (x: number, y: number) => act(() => void window.dispatchEvent(event('pointermove', { x, y })));
const release = (x: number, y: number) => act(() => void window.dispatchEvent(event('pointerup', { x, y })));
/** A key pressed where the editor's focus is: on the body, so it travels to the window as in the editor. */
const key = (init: KeyboardEventInit) => act(() => void document.body.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })));
const escape = () => key({ key: 'Escape' });
/** Stands in for the editor's own key handler on the window (bubble phase): Escape drops the pick, as EditorApp's does. */
let editorKeys: ReturnType<typeof vi.fn<(e: KeyboardEvent) => void>>;
const editorKeyHandler = (e: KeyboardEvent) => {
  editorKeys(e);
  if (e.key === 'Escape') store.editorUI.clearFxLayerPick();
};

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
  editorKeys = vi.fn<(e: KeyboardEvent) => void>();
  window.addEventListener('keydown', editorKeyHandler);
  document.addEventListener('pointerdown', reachedDocument);
});
afterEach(() => {
  window.removeEventListener('keydown', editorKeyHandler);
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
    // The editor's own Escape (which drops the pick) never saw it: the drag took it.
    expect(editorKeys).not.toHaveBeenCalled();
    expect(store.editorUI.fxLayerPick?.kind).toBe('layer');
    // The drag is over: a later move does nothing, and Escape is the editor's again.
    await move(CENTRE.x + 90, CENTRE.y);
    expect(positionOf()).toEqual(start);
    await escape();
    expect(editorKeys).toHaveBeenCalledTimes(1);
    expect(store.editorUI.fxLayerPick).toBeUndefined();
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

  it('the click at the end of a long drag (or a long press) is not the box\'s: the pick and its outline stay', async () => {
    await mountLive();
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(1_000);
    await press(boxEl, CENTRE.x, CENTRE.y);
    await move(CENTRE.x + 40, CENTRE.y);
    now.mockReturnValue(9_000);
    await release(CENTRE.x + 40, CENTRE.y);
    const clicked = vi.fn();
    document.addEventListener('click', clicked);
    act(() => void boxEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(clicked).not.toHaveBeenCalled();
    document.removeEventListener('click', clicked);
    expect(store.editorUI.fxLayerPick?.kind).toBe('layer');
  });

  it('another selection mid-drag ends the drag and puts the text back; the new selection is not moved', async () => {
    await mountLive();
    const start = positionOf();
    await press(boxEl, CENTRE.x, CENTRE.y);
    await move(CENTRE.x + 40, CENTRE.y);
    expect(positionOf()).not.toEqual(start);
    act(() => store.editorUI.clearSelection());
    await move(CENTRE.x + 80, CENTRE.y);
    expect(positionOf()).toEqual(start);
    expect(entries()).toBe(0);
    expect(getHistoryStore()!.batch).toBeUndefined();
  });

  it('another selection mid-drag, then the release without another move: the text is put back and nothing is committed onto the box that is no longer selected', async () => {
    await mountLive();
    const start = positionOf();
    await press(boxEl, CENTRE.x, CENTRE.y);
    await move(CENTRE.x + 40, CENTRE.y);
    expect(positionOf()).not.toEqual(start);
    act(() => store.editorUI.clearSelection());
    await release(CENTRE.x + 40, CENTRE.y);
    expect(positionOf()).toEqual(start);
    expect(entries()).toBe(0);
    expect(getHistoryStore()!.batch).toBeUndefined();
  });

  it('Delete, Cmd+D, Cmd+Z and Escape mid-drag never reach the editor\'s key handler, so they are not folded into the drag\'s undo step; after it they do', async () => {
    await mountLive();
    await press(boxEl, CENTRE.x, CENTRE.y);
    await move(CENTRE.x + 40, CENTRE.y);
    for (const init of [{ key: 'Delete' }, { key: 'Backspace' }, { key: 'd', metaKey: true }, { key: 'z', metaKey: true }, { key: 'x', ctrlKey: true }]) await key(init);
    expect(editorKeys).not.toHaveBeenCalled();
    await release(CENTRE.x + 40, CENTRE.y);
    expect(entries()).toBe(1);
    await key({ key: 'Delete' });
    await key({ key: 'z', metaKey: true });
    expect(editorKeys).toHaveBeenCalledTimes(2);
  });

  it('text written directly in the box over the point is HTML and wins the press', async () => {
    await mountLive();
    boxEl.prepend(document.createTextNode('Headline'));
    const range = document.createRange();
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [{ left: CENTRE.x - 20, right: CENTRE.x + 20, top: CENTRE.y - 10, bottom: CENTRE.y + 10 }],
    });
    void range;
    await press(boxEl, CENTRE.x, CENTRE.y);
    expect(store.editorUI.fxLayerPick).toBeUndefined();
    expect(reachedDocument).toHaveBeenCalledTimes(1);
    delete (Range.prototype as unknown as Record<string, unknown>).getClientRects;
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

describe('a drag that loses its release or its batch', () => {
  const entries = () => getHistoryStore()!.history.length;

  it('a move with no button down means the release was never seen: the drag ends with what it did, and a hovering pointer moves nothing', async () => {
    await mountLive();
    await press(boxEl, CENTRE.x, CENTRE.y);
    await move(CENTRE.x + 40, CENTRE.y);
    const moved = positionOf();
    act(() => void window.dispatchEvent(event('pointermove', { x: CENTRE.x + 80, y: CENTRE.y, buttons: 0 })));
    expect(positionOf()).toEqual(moved);
    expect(entries()).toBe(1);
    expect(getHistoryStore()!.batch).toBeUndefined();
    // Hovering later does not move the text, and the editor has its keys back.
    act(() => void window.dispatchEvent(event('pointermove', { x: CENTRE.x + 200, y: CENTRE.y, buttons: 0 })));
    expect(positionOf()).toEqual(moved);
    await key({ key: 'Delete' });
    expect(editorKeys).toHaveBeenCalledTimes(1);
    // A new press is a new pick (not stopped by a drag that never ended).
    await press(boxEl, CENTRE.x, CENTRE.y);
    expect(store.editorUI.fxLayerPick?.kind).toBe('layer');
  });

  it('a lost pointer capture ends the drag with what it did', async () => {
    await mountLive();
    await press(boxEl, CENTRE.x, CENTRE.y);
    await move(CENTRE.x + 40, CENTRE.y);
    const moved = positionOf();
    act(() => {
      const lost = new Event('lostpointercapture');
      Object.defineProperty(lost, 'pointerId', { value: 1 });
      boxEl.dispatchEvent(lost);
    });
    expect(entries()).toBe(1);
    await move(CENTRE.x + 120, CENTRE.y);
    expect(positionOf()).toEqual(moved);
  });

  it('the window losing focus mid-drag puts the text back and records nothing', async () => {
    await mountLive();
    const start = positionOf();
    await press(boxEl, CENTRE.x, CENTRE.y);
    await move(CENTRE.x + 40, CENTRE.y);
    act(() => void window.dispatchEvent(new Event('blur')));
    expect(positionOf()).toEqual(start);
    expect(entries()).toBe(0);
    expect(getHistoryStore()!.batch).toBeUndefined();
  });

  it('another gesture committing a batch mid-drag ends the drag: later moves are not separate undo steps', async () => {
    await mountLive();
    await press(boxEl, CENTRE.x, CENTRE.y);
    await move(CENTRE.x + 40, CENTRE.y);
    act(() => getHistoryStore()!.commitBatch());
    const stored = positionOf();
    expect(entries()).toBe(1);
    await move(CENTRE.x + 90, CENTRE.y);
    await move(CENTRE.x + 140, CENTRE.y);
    await release(CENTRE.x + 140, CENTRE.y);
    expect(positionOf()).toEqual(stored);
    expect(entries()).toBe(1);
    expect(getHistoryStore()!.batch).toBeUndefined();
  });
});

describe('double-click, and the pointer held by every picking press', () => {
  const LOCKUP = () => screenAt(0.5 + 0.5 * (2.6 / (frameWidth / 2)), 0.5);

  it('two picking presses make a double-click on the box the pick\'s, not the box\'s (which would edit its text)', async () => {
    await mountLive();
    const dbl = vi.fn();
    document.addEventListener('dblclick', dbl);
    await press(boxEl, CENTRE.x, CENTRE.y);
    await release(CENTRE.x, CENTRE.y);
    await press(boxEl, CENTRE.x, CENTRE.y);
    await release(CENTRE.x, CENTRE.y);
    act(() => void boxEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })));
    expect(dbl).not.toHaveBeenCalled();
    document.removeEventListener('dblclick', dbl);
  });

  it('a double-click on an HTML child of the box (its headline) is the child\'s, right after a pick, and after a press that picked nothing', async () => {
    await mountLive();
    const dbl = vi.fn();
    document.addEventListener('dblclick', dbl);
    await press(boxEl, CENTRE.x, CENTRE.y);
    await release(CENTRE.x, CENTRE.y);
    act(() => void child.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })));
    expect(dbl).toHaveBeenCalledTimes(1);
    // A press that picks nothing ends the run: the next double-click on the box is the box's.
    await press(boxEl, CORNER.x, CORNER.y);
    await release(CORNER.x, CORNER.y);
    act(() => void boxEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })));
    expect(dbl).toHaveBeenCalledTimes(2);
    document.removeEventListener('dblclick', dbl);
  });

  it('a press that picks a layer which is not dragged still holds the pointer until its release', async () => {
    await mountLive();
    const hold = vi.fn();
    const letGo = vi.fn();
    (boxEl as unknown as { setPointerCapture: unknown }).setPointerCapture = hold;
    (boxEl as unknown as { releasePointerCapture: unknown }).releasePointerCapture = letGo;
    const at = LOCKUP();
    await press(boxEl, at.x, at.y);
    expect(store.editorUI.fxLayerPick).toEqual({ componentId: box.id, kind: 'layer', layerId: textId });
    expect(hold).toHaveBeenCalledWith(1);
    expect(letGo).not.toHaveBeenCalled();
    await release(at.x + 300, at.y);
    expect(letGo).toHaveBeenCalledWith(1);
  });
});

describe('the scratch canvas of the text read-back', () => {
  it('is let go when the canvas layer goes away (Live off, the editor closed), not held for the rest of the tab', async () => {
    const view = await mountLive();
    releaseScratch.mockClear();
    view.unmount();
    expect(releaseScratch).toHaveBeenCalledTimes(1);
  });
});

describe('the four paths of picking', () => {
  const outlineLeft = () => parseFloat((document.querySelector('[data-fc-fx-outline-box]') as HTMLElement | null)?.style.left ?? 'NaN');

  it('backtrack: pick one layer, then another: the pick and its outline move to the second', async () => {
    await mountLive();
    await press(boxEl, CENTRE.x, CENTRE.y);
    await release(CENTRE.x, CENTRE.y);
    await waitFor(() => expect(document.querySelector('[data-fc-fx-outline-box]')).not.toBeNull());
    const first = outlineLeft();
    const lockup = screenAt(0.5 + 0.5 * (2.6 / (frameWidth / 2)), 0.5);
    await press(boxEl, lockup.x, lockup.y);
    await release(lockup.x, lockup.y);
    expect(store.editorUI.fxLayerPick).toEqual({ componentId: box.id, kind: 'layer', layerId: textId });
    await waitFor(() => expect(outlineLeft()).not.toBe(first));
    // And back: the first layer again, its outline where it was.
    await press(boxEl, CENTRE.x, CENTRE.y);
    await release(CENTRE.x, CENTRE.y);
    await waitFor(() => expect(outlineLeft()).toBe(first));
  });

  it('resume in the session: a canvas mounted again shows the outline of the layer that is still picked', async () => {
    const view = await mountLive();
    await press(boxEl, CENTRE.x, CENTRE.y);
    await release(CENTRE.x, CENTRE.y);
    await waitFor(() => expect(document.querySelector('[data-fc-fx-outline-box]')).not.toBeNull());
    view.unmount();
    await mountLive();
    expect(store.editorUI.fxLayerPick).toEqual({ componentId: box.id, kind: 'layer', layerId: textBoxId });
    await waitFor(() => expect(document.querySelector('[data-fc-fx-outline-box]')).not.toBeNull());
  });

  it('resume after a reload (a store with no pick): no outline until a layer is clicked, then it picks', async () => {
    // A reload is a new root store holding the stored scene and nothing picked; the scene is the same.
    const stored = (box.props as Record<string, unknown>)[FX_PROP];
    store = createRootStore();
    store.projectStore.createProject('Reloaded');
    const project = store.projectStore.findProjectByTitle('Reloaded')!;
    const page = project.findPageBySlug('')!;
    store.editorUI.setCurrentProject(project);
    store.editorUI.setCurrentPage(page);
    getHistoryStore()!.setTargetStore(store.projectStore);
    box = page.insertRegistryComponent('fxScene', { kind: 'appTree' })!;
    box.setProps({ [FX_PROP]: stored });
    store.editorUI.selectComponent(box, page.sortedViewportNodes[0].breakpointId!);
    store.editorUI.startFxLive(box.id, null);
    expect(store.editorUI.fxLayerPick).toBeUndefined();
    await mountLive();
    expect(document.querySelector('[data-fc-fx-outline-box]')).toBeNull();
    await press(boxEl, CENTRE.x, CENTRE.y);
    expect(store.editorUI.fxLayerPick).toEqual({ componentId: box.id, kind: 'layer', layerId: textBoxId });
    await waitFor(() => expect(document.querySelector('[data-fc-fx-outline-box]')).not.toBeNull());
  });

  it('re-entry: the picked layer is deleted (no outline, back to the box), then another is picked; Live off and on picks again with the new scene', async () => {
    const view = await mountLive();
    await press(boxEl, CENTRE.x, CENTRE.y);
    await release(CENTRE.x, CENTRE.y);
    await waitFor(() => expect(document.querySelector('[data-fc-fx-outline-box]')).not.toBeNull());
    const removed = removeFxLayer((box.props as Record<string, unknown>)[FX_PROP], textBoxId);
    if (!removed.ok) throw new Error(removed.message);
    act(() => box.setProps({ [FX_PROP]: removed.stored }));
    expect(store.editorUI.fxLayerPick).toBeUndefined();
    await waitFor(() => expect(document.querySelector('[data-fc-fx-outline-box]')).toBeNull());
    const lockup = screenAt(0.5 + 0.5 * (2.6 / (frameWidth / 2)), 0.5);
    await press(boxEl, lockup.x, lockup.y);
    await release(lockup.x, lockup.y);
    expect(store.editorUI.fxLayerPick).toEqual({ componentId: box.id, kind: 'layer', layerId: textId });
    // Live off, then on again: a new drawing and a new probe, and the pick works on it.
    view.unmount();
    act(() => store.editorUI.stopFxLive());
    act(() => store.editorUI.startFxLive(box.id, null));
    await mountLive();
    act(() => store.editorUI.clearFxLayerPick());
    await press(boxEl, lockup.x, lockup.y);
    expect(store.editorUI.fxLayerPick).toEqual({ componentId: box.id, kind: 'layer', layerId: textId });
  });
});

describe('a drag that ends early while the button is still down keeps the pointer held', () => {
  const entries = () => getHistoryStore()!.history.length;
  const ENDINGS: [string, () => Promise<void>][] = [
    ['Escape', async () => void (await escape())],
    ['the window losing focus', async () => void act(() => void window.dispatchEvent(new Event('blur')))],
    ['another selection', async () => void act(() => store.editorUI.clearSelection())],
    ['another gesture\'s batch', async () => void act(() => getHistoryStore()!.commitBatch())],
  ];

  it.each(ENDINGS)('%s: the pointer is let go at the real release, wherever it is, and the click after it is not the box parent\'s', async (_name, end) => {
    await mountLive();
    const hold = vi.fn();
    const letGo = vi.fn();
    (boxEl as unknown as { setPointerCapture: unknown }).setPointerCapture = hold;
    (boxEl as unknown as { releasePointerCapture: unknown }).releasePointerCapture = letGo;
    await press(boxEl, CENTRE.x, CENTRE.y);
    await move(CENTRE.x + 40, CENTRE.y);
    await end();
    // The drag is over, the button is not: the box still holds the pointer.
    await move(CENTRE.x + 90, CENTRE.y);
    expect(letGo).not.toHaveBeenCalled();
    // The release far outside the box; the pointer is the box's, so its click comes to the box and is swallowed.
    await release(5, 5);
    expect(letGo).toHaveBeenCalledWith(1);
    const clicked = vi.fn();
    document.addEventListener('click', clicked);
    act(() => void boxEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    document.removeEventListener('click', clicked);
    expect(clicked).not.toHaveBeenCalled();
    expect(getHistoryStore()!.batch).toBeUndefined();
    expect(entries()).toBeLessThanOrEqual(1);
  });

  it('unmounting leaves no listener of the hook behind: the held pointer is let go once, and a later release does nothing', async () => {
    const view = await mountLive();
    const letGo = vi.fn();
    (boxEl as unknown as { setPointerCapture: unknown }).setPointerCapture = vi.fn();
    (boxEl as unknown as { releasePointerCapture: unknown }).releasePointerCapture = letGo;
    const lockup = screenAt(0.5 + 0.5 * (2.6 / (frameWidth / 2)), 0.5);
    await press(boxEl, lockup.x, lockup.y);
    expect(letGo).not.toHaveBeenCalled();
    view.unmount();
    expect(letGo).toHaveBeenCalledTimes(1);
    await release(lockup.x, lockup.y);
    expect(letGo).toHaveBeenCalledTimes(1);
  });
});
