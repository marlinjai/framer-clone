// src/lib/canvas/cameraControls.ts
//
// Camera moves that live outside Canvas.tsx: the zoom buttons and reset of the
// bottom toolbar, and "zoom to fit" (the phone layout fits the canvas to the
// screen when it opens and from its zoom button; touch double-tap may reuse it).
//
// The camera is the transform in TransformContext ({ zoom, panX, panY }, pan in
// pixels relative to the canvas ground, `[data-ground]`). The zoom math (limits,
// clamping, zooming around a point) has one home, src/lib/canvas/touchGestures.ts,
// shared with the canvas's pinch and wheel; the fit math here is pure and tested
// (computeFitTransform), and applying a transform writes the
// camera element's style and notifies subscribers, exactly as Canvas does on a
// wheel zoom, so nothing re-renders during camera moves.
'use client';

import React from 'react';
import { useTransformContext, useTransformNotifier } from '@/contexts/TransformContext';
import { clampZoom, zoomAround, type CameraTransform } from './touchGestures';

export type { CameraTransform };

/** An axis-aligned rectangle. World rects are in canvas units, screen rects in ground pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FitOptions {
  /** Space left around the content inside the visible area, in pixels. Default 24. */
  padding?: number;
  /** Never zoom in past this (fitting a small element should not blow it up). Default 1. */
  maxZoom?: number;
  /**
   * 'contain' fits width and height and centres both ways (an overview).
   * 'width' fits the width only and aligns the content's top with the visible
   * area's top (reading a tall page from its start).
   */
  mode?: 'contain' | 'width';
}

/**
 * The camera transform that shows `content` (world units) inside `visible`
 * (ground pixels, e.g. the canvas minus the bars that cover it).
 */
export function computeFitTransform(content: Rect, visible: Rect, options: FitOptions = {}): CameraTransform {
  const padding = options.padding ?? 24;
  const maxZoom = options.maxZoom ?? 1;
  const mode = options.mode ?? 'contain';
  const availW = Math.max(1, visible.width - padding * 2);
  const availH = Math.max(1, visible.height - padding * 2);
  const cw = Math.max(1, content.width);
  const ch = Math.max(1, content.height);
  const byWidth = availW / cw;
  const raw = mode === 'width' ? byWidth : Math.min(byWidth, availH / ch);
  const zoom = clampZoom(Math.min(maxZoom, raw));
  const panX = visible.x + (visible.width - cw * zoom) / 2 - content.x * zoom;
  const panY =
    mode === 'width'
      ? visible.y + padding - content.y * zoom
      : visible.y + (visible.height - ch * zoom) / 2 - content.y * zoom;
  return { zoom, panX, panY };
}

/** Union of rectangles, or null for none. */
export function unionRects(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.width);
    y2 = Math.max(y2, r.y + r.height);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

// ---------- DOM side ----------

function groundElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-ground]');
}

/**
 * The world rects of the canvas's breakpoint frames (`[data-viewport-id]`),
 * measured from the DOM under the current transform. Empty when no page is open.
 */
export function measureViewportFrames(t: CameraTransform): Rect[] {
  const ground = groundElement();
  if (!ground) return [];
  const origin = ground.getBoundingClientRect();
  const frames = Array.from(document.querySelectorAll<HTMLElement>('[data-camera-transform] [data-viewport-id]'));
  return frames
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({
      x: (r.left - origin.left - t.panX) / t.zoom,
      y: (r.top - origin.top - t.panY) / t.zoom,
      width: r.width / t.zoom,
      height: r.height / t.zoom,
    }));
}

/** Insets of the visible canvas area: the parts covered by fixed chrome (top bar, bottom bar). */
export interface CanvasInsets {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

/** The ground's visible rect in ground pixels, minus the insets. Null when there is no canvas. */
export function visibleCanvasRect(insets: CanvasInsets = {}): Rect | null {
  const ground = groundElement();
  if (!ground) return null;
  const { width, height } = ground.getBoundingClientRect();
  const top = insets.top ?? 0;
  const left = insets.left ?? 0;
  return {
    x: left,
    y: top,
    width: Math.max(1, width - left - (insets.right ?? 0)),
    height: Math.max(1, height - top - (insets.bottom ?? 0)),
  };
}

/**
 * Camera controls bound to the editor's TransformContext: the live zoom
 * percentage, step zoom around the canvas centre, reset, and zoom to fit.
 */
export function useCameraControls() {
  const { state: transformState, subscribe } = useTransformContext();
  const notifySubscribers = useTransformNotifier();
  const [zoomPercentage, setZoomPercentage] = React.useState(() => Math.round(transformState.current.zoom * 100));

  React.useEffect(
    () => subscribe(() => setZoomPercentage(Math.round(transformState.current.zoom * 100))),
    [subscribe, transformState],
  );

  /** Write a transform to the camera element and tell every subscriber (HudSurface and others). */
  const apply = React.useCallback(
    (next: CameraTransform) => {
      transformState.current.zoom = next.zoom;
      transformState.current.panX = next.panX;
      transformState.current.panY = next.panY;
      const camera = document.querySelector<HTMLElement>('[data-camera-transform]');
      if (camera) {
        camera.style.transform = `translate(${next.panX}px, ${next.panY}px) scale(${next.zoom})`;
        camera.setAttribute('data-camera-transform', `${next.panX},${next.panY},${next.zoom}`);
      }
      notifySubscribers();
    },
    [transformState, notifySubscribers],
  );

  /** Zoom in or out by 5% around the canvas centre. */
  const zoomStep = React.useCallback(
    (direction: 'in' | 'out') => {
      const ground = groundElement();
      if (!ground) return;
      const rect = ground.getBoundingClientRect();
      const current = { ...transformState.current };
      // A 5% step of the zoom level (as the toolbar always did), as a factor for zoomAround.
      const target = current.zoom + (direction === 'in' ? 0.05 : -0.05);
      apply(zoomAround(current, { x: rect.width / 2, y: rect.height / 2 }, target / current.zoom));
    },
    [transformState, apply],
  );

  const reset = React.useCallback(() => apply({ zoom: 1, panX: 0, panY: 0 }), [apply]);

  /** Move the camera by screen pixels (positive moves the content right and down). */
  const panBy = React.useCallback(
    (dx: number, dy: number) => {
      const current = transformState.current;
      apply({ zoom: current.zoom, panX: current.panX + dx, panY: current.panY + dy });
    },
    [transformState, apply],
  );

  /**
   * Fit the canvas frames into the visible area. `pick` chooses which frames
   * (default all); returns false when there is nothing to fit yet.
   */
  const fit = React.useCallback(
    (options: FitOptions & { insets?: CanvasInsets; pick?: (frames: Rect[]) => Rect[] } = {}) => {
      const current = { ...transformState.current };
      const frames = measureViewportFrames(current);
      const content = unionRects(options.pick ? options.pick(frames) : frames);
      const visible = visibleCanvasRect(options.insets);
      if (!content || !visible) return false;
      apply(computeFitTransform(content, visible, options));
      return true;
    },
    [transformState, apply],
  );

  return { zoomPercentage, apply, zoomStep, reset, fit, panBy };
}
