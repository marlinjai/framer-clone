'use client';
// src/components/fx/useCanvasPick.ts
//
// Picking a layer of the live FX scene by clicking it on the canvas, and dragging a picked text
// box. The interaction model:
//
//  - The first click on a box selects the box, as it always did. Only a click on a box that is
//    already selected (alone, with Live on, in the frame that draws) asks the live scene which
//    layer is under the pointer.
//  - A hit picks that layer (EditorUIStore.pickFxLayer) and the click is not the box's. A miss
//    leaves the box as it was: its own handlers run. An HTML child of the box that lies over the
//    point wins: the press then targets the child, not the box, and nothing here runs.
//  - A press on the picked TEXT BOX and 3 px of travel drag it: `position` is written through
//    `setFxParam` on every move, inside one history batch, so the whole drag is one undo step.
//
// The listeners are native and in the capture phase on the box element: React's own handlers on
// the box (selection, the box drag, double-click to edit) run later in the bubble phase, and a
// press this hook takes stops there. It runs only while the scene is live (a refused scene or a
// lost context draws nothing to pick).
//
// The engine side is the editor-only `@/lib/fx/pick`, loaded by the caller (FxLayer.tsx) by its own
// dynamic import; this file takes its functions as a parameter and imports none of it.

import { useEffect } from 'react';
import type { RefObject } from 'react';

import { EditorTool, type EditorUIType } from '@/stores/EditorUIStore';
import { getDragManager, getHistoryStore } from '@/stores/RootStore';
import { isTouchLike } from '@/lib/canvas/touchGestures';
import { setFxParam } from '@/lib/fxScene/edit';
import { FX_PROP } from '@/lib/fxScene/marker';
import { parseFxProp } from '@/lib/fxScene/fxScene';

/** What a drag must travel before it is a drag and not a click. */
export const DRAG_THRESHOLD_PX = 3;
/** The window of a double-click after a picking press or the end of a drag, in ms. */
const DOUBLE_CLICK_MS = 800;

/** The editor-only `@/lib/fx/pick`, as this hook uses it (spelled out here: only FxLayer.tsx may import that entry). */
export interface CanvasPickTools {
  picker: { pickAt: (ndcX: number, ndcY: number) => string | null };
  pointerToNdc: (client: { x: number; y: number }, rect: { left: number; top: number; width: number }, layout: { width: number; height: number }) => { x: number; y: number } | null;
  positionAfterDrag: (start: readonly [number, number], travel: { dx: number; dy: number }, scale: number, layout: { width: number; height: number }) => [number, number];
}

interface Options {
  editorUI: EditorUIType;
  /** The scene layer; its parent is the box. */
  layerRef: RefObject<HTMLElement | null>;
  /** Null: nothing can be picked (not live, or the pick code is not loaded). */
  tools: CanvasPickTools | null;
}

/** Whether text written directly in the box (a text node is never an event target) lies under the point: it is HTML, and wins. */
function textOver(box: HTMLElement, x: number, y: number): boolean {
  for (const node of Array.from(box.childNodes)) {
    if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    // jsdom has no layout: no rectangles, no text over the point.
    const rects = typeof range.getClientRects === 'function' ? Array.from(range.getClientRects()) : [];
    if (rects.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) return true;
  }
  return false;
}

export function useCanvasPick({ editorUI, layerRef, tools }: Options): void {
  useEffect(() => {
    const layer = layerRef.current;
    const box = layer?.parentElement;
    if (!tools || !layer || !box) return;
    const { picker, pointerToNdc, positionAfterDrag } = tools;

    // The click that follows a press this hook took (and the end of its drag) is not the box's. Kept until the
    // next press, never by time: a drag or a held press outlasts any window, and its click comes at its end.
    let swallowNextClick = false;
    let lastPickAt = -Infinity;
    let drag: { stop: (revert: boolean) => void } | null = null;

    const swallowClick = (e: Event) => {
      if (!swallowNextClick) return;
      swallowNextClick = false;
      e.stopPropagation();
    };
    const swallowDoubleClick = (e: Event) => {
      // Two presses that both picked a layer are not a double-click on the box (which edits its text).
      if (performance.now() - lastPickAt > DOUBLE_CLICK_MS) return;
      e.stopPropagation();
    };

    const layerPosition = (layerId: string): [number, number] | null => {
      const component = editorUI.selectedComponent;
      if (!component) return null;
      const read = parseFxProp((component.props as Record<string, unknown>)[FX_PROP]);
      if (!read.ok) return null;
      const value = read.fx.scene.layers.find((l) => l.id === layerId)?.params.position?.value;
      return Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number') ? [value[0] as number, value[1] as number] : null;
    };

    const beginDrag = (e: PointerEvent, component: NonNullable<typeof editorUI.selectedComponent>, layerId: string, start: [number, number]) => {
      const origin = { x: e.clientX, y: e.clientY };
      const pointerId = e.pointerId;
      let started = false;
      let ownBatch: unknown;
      let lastWritten = start;
      const userSelect = document.body.style.userSelect;
      const finish = (revert: boolean) => {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
        window.removeEventListener('pointercancel', cancel, true);
        window.removeEventListener('keydown', key, true);
        drag = null;
        lastPickAt = performance.now();
        document.body.style.userSelect = userSelect;
        try {
          box.releasePointerCapture(pointerId);
        } catch {
          // Already released: the pointer is gone.
        }
        const history = getHistoryStore();
        const own = ownBatch;
        ownBatch = undefined;
        // Only the drag's own batch: another gesture's is never committed or undone from here.
        if (!own || !history || history.batch !== own) return;
        // Escape, a cancelled pointer, the scene going away: nothing of the drag stays, and nothing is recorded.
        if (revert) history.revertBatch();
        else history.commitBatch();
      };
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const dx = ev.clientX - origin.x;
        const dy = ev.clientY - origin.y;
        if (!started) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
          const history = getHistoryStore();
          // Another gesture's batch is open: this drag would be folded into it, or undo it. Not started.
          if (!history || history.batch) {
            finish(true);
            return;
          }
          history.startBatch('Move text');
          ownBatch = history.batch;
          document.body.style.userSelect = 'none';
          started = true;
        }
        // The box the drag began on, and still the selection: another selection (a shortcut, an agent, the Layers panel) ends it.
        if (editorUI.selectedComponent?.id !== component.id) {
          finish(true);
          return;
        }
        const rect = layer.getBoundingClientRect();
        const layout = { width: layer.offsetWidth, height: layer.offsetHeight };
        if (!component || layout.width <= 0 || layout.height <= 0 || rect.width <= 0) {
          finish(true);
          return;
        }
        const next = positionAfterDrag(start, { dx, dy }, rect.width / layout.width, layout);
        // The same place: nothing to store (each write keeps a copy of the scene in the undo step).
        if (Math.abs(next[0] - lastWritten[0]) < 1e-4 && Math.abs(next[1] - lastWritten[1]) < 1e-4) return;
        lastWritten = next;
        const current = (component.props as Record<string, unknown>)[FX_PROP];
        const edit = setFxParam(current, layerId, 'position', next);
        if (!edit.ok) {
          editorUI.setFxLayerNotice({ componentId: component.id, about: JSON.stringify(current ?? null), text: edit.message, problem: true });
          finish(true);
          return;
        }
        component.setProps({ [FX_PROP]: edit.stored });
      };
      const up = (ev: PointerEvent) => {
        if (ev.pointerId === pointerId) finish(false);
      };
      const cancel = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        // A cancelled pointer has no click after it.
        swallowNextClick = false;
        finish(true);
      };
      const key = (ev: KeyboardEvent) => {
        const edit = ev.key === 'Delete' || ev.key === 'Backspace' || ((ev.metaKey || ev.ctrlKey) && ['d', 'z', 'y', 'x', 'v'].includes(ev.key.toLowerCase()));
        if (ev.key !== 'Escape' && !edit) return;
        // Escape ends the drag only (the editor's own Escape, which would drop the pick, does not see it); an edit
        // of the layer or the history while the drag runs would be folded into its undo step, or undone by it.
        ev.stopPropagation();
        ev.preventDefault();
        if (ev.key === 'Escape') finish(true);
      };
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', up, true);
      window.addEventListener('pointercancel', cancel, true);
      window.addEventListener('keydown', key, true);
      try {
        box.setPointerCapture(pointerId);
      } catch {
        // No capture: the window listeners still follow the pointer.
      }
      drag = { stop: finish };
    };

    const onPointerDown = (e: PointerEvent) => {
      // A new press ends the wait for the last one's click: it is not left to eat a later click.
      swallowNextClick = false;
      if (drag) return;
      // Only a plain left press of a mouse or pen with the Select tool.
      if (e.button !== 0 || !e.isPrimary || isTouchLike(e.pointerType)) return;
      if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      if (editorUI.selectedTool !== EditorTool.SELECT || getDragManager()?.isActive) return;
      // An HTML child of the box is on top of the point: it is the one pressed.
      if (e.target !== box || textOver(box, e.clientX, e.clientY)) return;
      const live = editorUI.fxLive;
      const component = editorUI.selectedComponent;
      // Only a box that is already the one selection; the first click on a box selects it.
      if (!live || !component || component.id !== live.componentId || editorUI.selectedComponents.length !== 1) return;
      if (editorUI.fxLiveStatus.state !== 'live') return;
      const rect = layer.getBoundingClientRect();
      const ndc = pointerToNdc({ x: e.clientX, y: e.clientY }, rect, { width: layer.offsetWidth, height: layer.offsetHeight });
      if (!ndc) return;
      const layerId = picker.pickAt(ndc.x, ndc.y);
      if (layerId === null) return;
      // A hit is not the box's press: no selection, no box drag.
      e.stopPropagation();
      swallowNextClick = true;
      lastPickAt = performance.now();
      const picked = editorUI.fxLayerPick;
      const alreadyPicked = picked?.kind === 'layer' && picked.layerId === layerId;
      if (!alreadyPicked) editorUI.pickFxLayer(component, { kind: 'layer', layerId }, live.frameId ?? undefined);
      const type = parseFxProp((component.props as Record<string, unknown>)[FX_PROP]);
      const isTextBox = type.ok && type.fx.scene.layers.find((l) => l.id === layerId)?.type === 'textBox';
      const start = isTextBox ? layerPosition(layerId) : null;
      // Pressing the layer that was picked already, or one that is picked by this press, can drag it.
      if (start) beginDrag(e, component, layerId, start);
    };

    box.addEventListener('pointerdown', onPointerDown, true);
    box.addEventListener('click', swallowClick, true);
    box.addEventListener('dblclick', swallowDoubleClick, true);
    return () => {
      box.removeEventListener('pointerdown', onPointerDown, true);
      box.removeEventListener('click', swallowClick, true);
      box.removeEventListener('dblclick', swallowDoubleClick, true);
      // Going away mid-drag (Live off, the scene stopped, another box): the drag ends and leaves nothing.
      (drag as { stop: (revert: boolean) => void } | null)?.stop(true);
    };
  }, [editorUI, layerRef, tools]);
}
