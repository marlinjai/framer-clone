'use client';
// src/components/fx/FxPickOutline.tsx
//
// The outline of the picked layer on the live canvas: an HTML overlay over the scene layer,
// sized from the layer's projected bounds (the editor-only pick code in `@/lib/fx/pick`). It is
// never a second WebGL context and never takes a pointer. It sits inside a clip of the scene
// layer's own rectangle, so an outline that reaches past the box is cut there; HTML children of
// the box may lie over it. Its numbers are in the layer's layout pixels, inside the box, so the
// editor's zoom (a CSS transform on the canvas) scales it with the scene.

import React, { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import type { EditorUIType } from '@/stores/EditorUIStore';
import { FX_LAYER_STYLE } from '@/lib/fxScene/box';

/** Where a layer is on the canvas, in layout pixels (a box around it). */
export interface OutlineRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A change smaller than this is not worth a render. */
const MOVED_PX = 0.5;

const same = (a: OutlineRect | null, b: OutlineRect | null) =>
  a === b || (!!a && !!b && Math.abs(a.left - b.left) < MOVED_PX && Math.abs(a.top - b.top) < MOVED_PX && Math.abs(a.width - b.width) < MOVED_PX && Math.abs(a.height - b.height) < MOVED_PX);

interface Props {
  editorUI: EditorUIType;
  layerRef: React.RefObject<HTMLElement | null>;
  boundsOf: (layerId: string, width: number, height: number) => OutlineRect | null;
}

/** Measures the picked layer while one is picked: its text drifts with the pointer, so it is read every frame. */
function useOutline(layerId: string | undefined, layerRef: Props['layerRef'], boundsOf: Props['boundsOf']): OutlineRect | null {
  const [rect, setRect] = useState<OutlineRect | null>(null);
  useEffect(() => {
    setRect(null);
    if (!layerId) return;
    let frame = 0;
    let last: OutlineRect | null = null;
    const tick = () => {
      const layer = layerRef.current;
      const next = layer && layer.offsetWidth > 0 && layer.offsetHeight > 0 ? boundsOf(layerId, layer.offsetWidth, layer.offsetHeight) : null;
      if (!same(last, next)) {
        last = next;
        setRect(next);
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [layerId, layerRef, boundsOf]);
  return rect;
}

export const FxPickOutline = observer(function FxPickOutline({ editorUI, layerRef, boundsOf }: Props) {
  const pick = editorUI.fxLayerPick;
  // Read once per pick: the loop below must not ask the store (and re-read the scene) every frame.
  const layerId = pick?.kind === 'layer' && pick.componentId === editorUI.fxLive?.componentId ? pick.layerId : undefined;
  const rect = useOutline(layerId, layerRef, boundsOf);
  if (!layerId || !rect) return null;
  return (
    <div
      aria-hidden="true"
      data-fc-fx-outline=""
      style={{ position: FX_LAYER_STYLE.position, inset: FX_LAYER_STYLE.inset, zIndex: Number(FX_LAYER_STYLE.zIndex) + 1, overflow: 'hidden', pointerEvents: 'none' }}
    >
      <div
        data-fc-fx-outline-box=""
        style={{
          position: 'absolute',
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          boxSizing: 'border-box',
          border: '1px solid #3b82f6',
          boxShadow: '0 0 0 1px rgba(255,255,255,0.55)',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
});
