// src/components/Canvas.tsx - High-performance infinite canvas with optimized zoom and pan
'use client';
import React, { useRef, useCallback, useEffect } from 'react';
import ResponsivePageRenderer from './ResponsivePageRenderer';
import { useTransformContext, useTransformNotifier } from '@/contexts/TransformContext';
// HudSurface is now imported in EditorApp
import { EditorTool } from '../stores/EditorUIStore';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { getDragManager } from '@/stores/RootStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import { visibleRectInFrame } from '@/lib/canvas/viewportFrame';
import { isLockedOnCanvas } from '@/lib/layers/layerActions';
import {
  boxFromPoints,
  marqueeHitTest,
  overlapArea,
  pastThreshold,
  type MarqueeCandidate,
  type ScreenBox,
} from '@/lib/canvas/marquee';
import {
  DOUBLE_TAP_ZOOM_FACTOR,
  TAP_MAX_DURATION_MS,
  TouchGestureTracker,
  dragThresholdFor,
  isDoubleTap,
  isTouchLike,
  zoomAround,
  type CameraTransform,
  type Tap,
} from '@/lib/canvas/touchGestures';

/** Where a marquee started: empty canvas, or one breakpoint frame. */
type MarqueeScope =
  | { kind: 'canvas' }
  | { kind: 'frame'; content: Element; breakpointId?: string };

/**
 * Every component rendered inside one breakpoint frame's content box, with
 * its visible on-screen rect and its nearest rendered ancestor component. The
 * page root is left out: it fills the frame, so it would always be hit.
 */
function collectFrameCandidates(content: Element, rootId: string | undefined): MarqueeCandidate[] {
  const out: MarqueeCandidate[] = [];
  content.querySelectorAll('[data-inner-component-id]').forEach(el => {
    const id = el.getAttribute('data-inner-component-id');
    if (!id || id === rootId) return;
    const rect = visibleRectInFrame(el);
    if (!rect) return; // clipped away by the frame
    const parentEl = el.parentElement?.closest('[data-inner-component-id]');
    const parentId = parentEl && content.contains(parentEl)
      ? parentEl.getAttribute('data-inner-component-id') ?? undefined
      : undefined;
    out.push({ id, parentId: parentId === rootId ? undefined : parentId, rect });
  });
  return out;
}

// Inner Canvas component that uses TransformContext
const CanvasInner = observer(() => {
  // Performance-optimized refs for direct DOM manipulation
  // ground wrapper (fills viewport, hosts grid & overlays, NOT transformed)
  const groundRef = useRef<HTMLDivElement>(null);
  // camera wrapper (only transformed element containing page trees)
  const cameraRef = useRef<HTMLDivElement>(null);
  const rootStore = useStore();

  // Get transform state and notifier from context
  const { state: transformState } = useTransformContext();
  const notifySubscribers = useTransformNotifier();

  /**
   * Apply transform to canvas camera element and notify subscribers
   *
   * This is the core function that:
   * 1. Reads current transform state from context ref
   * 2. Applies CSS transform directly to DOM (bypassing React)
   * 3. Updates data attribute for external debugging
   * 4. Notifies all subscribers (HudSurface, etc.) via context
   *
   * Performance optimizations:
   * - Direct DOM manipulation (no React re-render)
   * - Single transform application (not separate translate/scale)
   * - Cached callback with stable dependencies
   */
  const applyTransform = useCallback(() => {
    if (cameraRef.current) {
      const { zoom, panX, panY } = transformState.current;

      // Direct CSS transform application - fastest approach for real-time updates
      // Format: translate(x, y) scale(z) - order matters for proper transformation
      const transformString = `translate(${panX}px, ${panY}px) scale(${zoom})`;
      cameraRef.current.style.transform = transformString;

      // Update data attribute for external debugging and HudSurface compatibility
      cameraRef.current.setAttribute('data-camera-transform', `${panX},${panY},${zoom}`);

      // Notify all subscribers (HudSurface, debug overlays, etc.)
      // This triggers direct DOM updates in subscribed components
      notifySubscribers();
    }
  }, [notifySubscribers, transformState]);

  // Handle mouse wheel - pan by default, zoom with Command key
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();

    if (!groundRef.current) return;

    // Check if Command key is pressed (metaKey on Mac, ctrlKey on Windows/Linux)
    const isZoomModifier = e.metaKey || e.ctrlKey;

    if (isZoomModifier) {
      // ZOOM MODE: Stack Overflow proven cursor-centered zoom algorithm
      const rect = groundRef.current.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // Detect pinch gestures (typically have larger deltaY and ctrlKey set)
      // Use slower zoom factor for pinch gestures to make them feel more controlled
      const isLikelyPinch = e.ctrlKey && Math.abs(e.deltaY) > 10;
      // Pinch gestures: 1.01 (1% per step) for very slow, precise zoom
      // Wheel zoom: 1.05 (5% per step) for reasonable responsiveness
      const scaleFactor = isLikelyPinch ? 1.01 : 1.05;
      const zoomDirection = e.deltaY > 0 ? -1 : 1;
      const factor = Math.pow(scaleFactor, zoomDirection);
      const newZoom = Math.max(0.1, Math.min(5, transformState.current.zoom * factor));

      // Get current state
      const { zoom: currentZoom, panX: currentPanX, panY: currentPanY } = transformState.current;

      // Stack Overflow algorithm: translate → scale → translate back
      // Step 1: Convert mouse position to world coordinates
      const worldX = (mouseX - currentPanX) / currentZoom;
      const worldY = (mouseY - currentPanY) / currentZoom;

      // Step 2: Apply the zoom transformation around the world point
      // This is equivalent to: translate(worldX, worldY) → scale(factor) → translate(-worldX, -worldY)
      const newPanX = mouseX - worldX * newZoom;
      const newPanY = mouseY - worldY * newZoom;

      // Update transform state
      transformState.current.zoom = newZoom;
      transformState.current.panX = newPanX;
      transformState.current.panY = newPanY;
    } else {
      // PAN MODE: Regular scroll = pan canvas
      transformState.current.panX -= e.deltaX;
      transformState.current.panY -= e.deltaY;
    }

    // Apply transform immediately
    applyTransform();
  }, [applyTransform, transformState]);

  // ===== Pan =====
  //
  // Middle mouse pans in every tool; the left button pans with the Grab tool
  // (also while Space is held, which switches to Grab temporarily). The press
  // is taken in the capture phase on the ground, before any page component,
  // frame or the drag manager sees it, so panning works wherever the pointer
  // is over the canvas, page content included. Pointer capture keeps the
  // gesture alive when the pointer leaves the canvas.
  const panRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  // Set when a gesture (pan, marquee) ends in a click the page must not see:
  // without this, releasing over a component would select it, and releasing
  // over empty canvas would clear the selection the marquee just made.
  const suppressClickRef = useRef(false);

  const setPanCursor = useCallback((state: 'grab' | 'grabbing' | null) => {
    const ground = groundRef.current;
    if (!ground) return;
    if (state) ground.setAttribute('data-pan-cursor', state);
    else ground.removeAttribute('data-pan-cursor');
  }, []);

  const restPanCursor = useCallback(() => {
    setPanCursor(rootStore.editorUI.selectedTool === EditorTool.GRAB ? 'grab' : null);
  }, [rootStore.editorUI, setPanCursor]);

  const startPan = useCallback((e: React.PointerEvent) => {
    const ground = groundRef.current;
    if (!ground) return;
    // Nothing below the ground (components, frames, the drag manager) may
    // turn this press into a selection or a move.
    e.stopPropagation();
    panRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    suppressClickRef.current = e.button === 0;
    try {
      ground.setPointerCapture(e.pointerId);
    } catch {
      // Capture refused (pointer already released): the up handler still
      // ends the pan when it reaches the ground.
    }
    setPanCursor('grabbing');
  }, [setPanCursor]);

  const endPan = useCallback((pointerId: number) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== pointerId) return;
    panRef.current = null;
    const ground = groundRef.current;
    try {
      if (ground?.hasPointerCapture(pointerId)) ground.releasePointerCapture(pointerId);
    } catch {
      // noop
    }
    restPanCursor();
  }, [restPanCursor]);

  // ===== Marquee =====
  //
  // With the Select tool, a left drag that starts on empty canvas, or on a
  // breakpoint frame's own background (the page root or the frame's content
  // box, not a component inside it), draws a selection rectangle. A drag on a
  // frame's title label still moves the frame; a drag on a component still
  // moves the component. Below the threshold the press stays a click, so
  // clicking empty canvas still clears the selection and clicking a frame
  // still selects it.
  const marqueeRef = useRef<HTMLDivElement>(null);
  const marqueeCleanupRef = useRef<(() => void) | null>(null);

  const hideMarquee = useCallback(() => {
    if (marqueeRef.current) marqueeRef.current.style.display = 'none';
  }, []);

  const drawMarquee = useCallback((box: ScreenBox) => {
    const el = marqueeRef.current;
    const ground = groundRef.current;
    if (!el || !ground) return;
    const origin = ground.getBoundingClientRect();
    el.style.display = 'block';
    el.style.transform = `translate(${box.left - origin.left}px, ${box.top - origin.top}px)`;
    el.style.width = `${box.width}px`;
    el.style.height = `${box.height}px`;
  }, []);

  /** Where a left press in the Select tool may start a marquee, or null. */
  const marqueeScopeFor = useCallback((target: EventTarget | null): MarqueeScope | null => {
    if (!(target instanceof Element)) return null;
    const ground = groundRef.current;
    if (!ground || !ground.contains(target)) return null;
    if (target instanceof HTMLElement && target.isContentEditable) return null;
    // Outside every canvas node: the ground, grid or camera itself.
    if (!target.closest('.ground-wrapper')) return { kind: 'canvas' };
    // Inside a frame's content box: only its background (the content box or
    // the page root) starts a marquee; a real component keeps its own drag.
    const content = target.closest('[data-viewport-content-id]');
    if (!content) return null; // frame label, frame chrome, floating element
    const page = rootStore.editorUI.currentPage;
    const inner = target.closest('[data-inner-component-id]');
    const innerId = inner && content.contains(inner) ? inner.getAttribute('data-inner-component-id') : null;
    if (innerId && innerId !== page?.appComponentTree?.id) return null;
    const breakpointId = content.closest('[data-breakpoint-id]')?.getAttribute('data-breakpoint-id') ?? undefined;
    return { kind: 'frame', content, breakpointId };
  }, [rootStore.editorUI]);

  const applyMarquee = useCallback((box: ScreenBox, scope: MarqueeScope, additive: boolean) => {
    const ui = rootStore.editorUI;
    const page = ui.currentPage;
    if (!page) return;

    let ids: string[];
    let breakpointId: string | undefined;
    const rootId = page.appComponentTree?.id;
    if (scope.kind === 'frame') {
      ids = marqueeHitTest(box, collectFrameCandidates(scope.content, rootId));
      breakpointId = scope.breakpointId;
    } else {
      // From empty canvas: floating elements, plus the components of the
      // breakpoint frame the rectangle covers most (every frame renders the
      // same page, so one frame is the selection's context).
      const floating: MarqueeCandidate[] = [];
      for (const node of page.floatingElements) {
        if (!node.canvasVisible || node.canvasLocked) continue;
        const el = document.getElementById(`ground-wrapper-${node.id}`);
        if (el) floating.push({ id: node.id, rect: el.getBoundingClientRect() });
      }
      let bestFrame: Element | null = null;
      let bestArea = 0;
      for (const frame of Array.from(groundRef.current?.querySelectorAll('[data-viewport-content-id]') ?? [])) {
        const area = overlapArea(box, frame.getBoundingClientRect());
        if (area > bestArea) {
          bestArea = area;
          bestFrame = frame;
        }
      }
      const treeIds = bestFrame ? marqueeHitTest(box, collectFrameCandidates(bestFrame, rootId)) : [];
      if (bestFrame && treeIds.length > 0) {
        breakpointId = bestFrame.closest('[data-breakpoint-id]')?.getAttribute('data-breakpoint-id') ?? undefined;
      }
      ids = [...treeIds, ...marqueeHitTest(box, floating)];
    }

    const hits = ids
      .map(id => page.findComponent(id))
      .filter((c): c is ComponentInstance => !!c && c.id !== rootId && !c.isViewportNode)
      // Locked layers (or layers inside a locked one) are never picked.
      .filter(c => !isLockedOnCanvas(c, id => page.findComponent(id)));

    if (additive) {
      // Shift+drag adds to what is selected; an empty rectangle changes nothing.
      if (hits.length === 0) return;
      ui.setSelection(
        [...ui.selectedComponentList, ...hits],
        ui.selectedViewportNode?.breakpointId ?? breakpointId,
      );
      return;
    }
    if (hits.length === 0) {
      ui.clearSelection();
      return;
    }
    ui.setSelection(hits, breakpointId);
  }, [rootStore.editorUI]);

  const startMarquee = useCallback((e: React.PointerEvent, scope: MarqueeScope) => {
    // Keep the press from reaching the frame's drag source (it would move
    // the whole frame) now that the marquee owns it. No preventDefault: the
    // click that follows a press without movement must still fire.
    e.stopPropagation();
    marqueeCleanupRef.current?.();

    const pointerId = e.pointerId;
    const start = { x: e.clientX, y: e.clientY };
    const additive = e.shiftKey;
    const threshold = dragThresholdFor(e.pointerType);
    let engaged = false;
    let box: ScreenBox = boxFromPoints(start, start);

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const current = { x: ev.clientX, y: ev.clientY };
      if (!engaged) {
        if (!pastThreshold(start, current, threshold)) return;
        engaged = true;
      }
      box = boxFromPoints(start, current);
      drawMarquee(box);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const wasEngaged = engaged;
      cleanup();
      if (!wasEngaged) return; // a click: its own handlers select or clear
      suppressClickRef.current = true;
      applyMarquee(box, scope, additive);
    };
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      cleanup();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      // Escape ends the rectangle only; the selection stays as it was.
      ev.preventDefault();
      ev.stopPropagation();
      if (engaged) suppressClickRef.current = true;
      cleanup();
    };

    // Window listeners, not pointer capture: capturing at press time would
    // retarget the click that follows a plain press to the ground, and the
    // frame or page root under the pointer must still receive that click.
    function cleanup() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      hideMarquee();
      if (marqueeCleanupRef.current === cleanup) marqueeCleanupRef.current = null;
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    marqueeCleanupRef.current = cleanup;
  }, [applyMarquee, drawMarquee, hideMarquee]);

  // End a marquee left running when the canvas unmounts (page switch).
  useEffect(() => () => marqueeCleanupRef.current?.(), []);

  // ===== Touch and pen =====
  //
  // The gesture model (src/lib/canvas/touchGestures.ts, decided with the
  // owner on 2026-10-24): two fingers pan and pinch-zoom the camera at the
  // same time; one finger never pans (except with the Grab tool). One finger
  // taps to select, drags the selected element (or the selected element it is
  // inside) through the drag manager, draws the selection rectangle when the
  // drag starts anywhere else, and double-taps to edit text (or to zoom in a
  // step on empty canvas). A long-press does nothing. The mouse path below is
  // untouched: every branch here is gated on a touch or pen pointer.
  const touchRef = useRef<TouchGestureTracker | null>(null);
  if (!touchRef.current) touchRef.current = new TouchGestureTracker();
  const touchListenersRef = useRef<(() => void) | null>(null);
  const pinchRafRef = useRef(0);
  const lastTapRef = useRef<Tap | null>(null);
  // Clicks are swallowed from the moment a second finger lands until shortly
  // after the last finger lifts: neither finger of a pinch may select or clear.
  const blockTouchClicksUntilRef = useRef(0);
  // When the last touch or pen press happened, for the native dblclick and
  // contextmenu a touch can produce (the canvas handles both itself).
  const lastTouchPressAtRef = useRef(-Infinity);

  const groundPoint = useCallback((clientX: number, clientY: number) => {
    const rect = groundRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  }, []);

  const currentCamera = useCallback((): CameraTransform => {
    const { zoom, panX, panY } = transformState.current;
    return { zoom, panX, panY };
  }, [transformState]);

  const applyCamera = useCallback((camera: CameraTransform) => {
    transformState.current.zoom = camera.zoom;
    transformState.current.panX = camera.panX;
    transformState.current.panY = camera.panY;
    applyTransform();
  }, [applyTransform, transformState]);

  /** Apply the pinch for the fingers' latest positions now (rAF or flush). */
  const flushPinch = useCallback(() => {
    if (pinchRafRef.current) {
      cancelAnimationFrame(pinchRafRef.current);
      pinchRafRef.current = 0;
    }
    const camera = touchRef.current?.currentPinchCamera();
    if (camera) applyCamera(camera);
  }, [applyCamera]);

  const schedulePinch = useCallback(() => {
    if (pinchRafRef.current) return;
    pinchRafRef.current = requestAnimationFrame(() => {
      pinchRafRef.current = 0;
      flushPinch();
    });
  }, [flushPinch]);

  /** A second finger landed: whatever the first finger started stops. */
  const cancelOneFingerGestures = useCallback(() => {
    marqueeCleanupRef.current?.();
    const dm = getDragManager();
    // An engaged move is reverted, an armed one simply dropped. Only a drag
    // the canvas fingers own: a drag from a panel with another finger stays.
    if (dm && dm.pointerId !== null && touchRef.current?.has(dm.pointerId)) dm.cancel();
    if (panRef.current && touchRef.current?.has(panRef.current.pointerId)) endPan(panRef.current.pointerId);
  }, [endPan]);

  /** The selected node the press is on or inside, if it may move. */
  const selectedNodeUnder = useCallback((target: Element): ComponentInstance | null => {
    const ui = rootStore.editorUI;
    const page = ui.currentPage;
    const ground = groundRef.current;
    if (!page || !ground) return null;
    const selector = '[data-inner-component-id],[data-ground-wrapper-id]';
    let el: Element | null = target.closest(selector);
    while (el && ground.contains(el)) {
      const id = el.getAttribute('data-inner-component-id') ?? el.getAttribute('data-ground-wrapper-id');
      if (id && ui.isSelected(id)) {
        const node = page.findComponent(id);
        if (!node || node.isViewportNode) return null;
        if (isLockedOnCanvas(node, nid => page.findComponent(nid))) return null;
        return node;
      }
      el = el.parentElement?.closest(selector) ?? null;
    }
    return null;
  }, [rootStore.editorUI]);

  /**
   * Where a one-finger drag that is neither on the selection nor on a
   * desktop marquee spot draws its rectangle: inside an unselected component
   * of a frame (that frame), or on an unselected floating element (the
   * canvas). On a phone the page fills the screen, so this is where most
   * drags start, and a stray drag selects instead of moving something.
   * Frame labels keep moving their frame.
   */
  const touchMarqueeScopeFor = useCallback((target: Element): MarqueeScope | null => {
    const content = target.closest('[data-viewport-content-id]');
    if (content && target.closest('[data-inner-component-id]')) {
      const breakpointId = content.closest('[data-breakpoint-id]')?.getAttribute('data-breakpoint-id') ?? undefined;
      return { kind: 'frame', content, breakpointId };
    }
    const wrapperId = target.closest('[data-ground-wrapper-id]')?.getAttribute('data-ground-wrapper-id');
    const node = wrapperId ? rootStore.editorUI.currentPage?.findComponent(wrapperId) : undefined;
    if (node?.isFloatingElement) return { kind: 'canvas' };
    return null;
  }, [rootStore.editorUI]);

  const handleDoubleTap = useCallback((target: Element, tap: Tap) => {
    if (target instanceof HTMLElement && target.isContentEditable) return;
    // The same double-click handlers the mouse uses decide (text editing).
    const dbl = new MouseEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      clientX: tap.x,
      clientY: tap.y,
      detail: 2,
      view: window,
    });
    const handled = !target.dispatchEvent(dbl);
    const editing = rootStore.editorUI.editingComponent;
    if (handled && editing) {
      // Focus inside this tap, not in the effect after the re-render: iOS only
      // opens the keyboard for a focus that happens during the user gesture.
      let el: Element | null = target.closest('[data-inner-component-id]');
      while (el && el.getAttribute('data-inner-component-id') !== editing.id) {
        el = el.parentElement?.closest('[data-inner-component-id]') ?? null;
      }
      if (el instanceof HTMLElement) {
        el.contentEditable = 'true';
        el.focus();
      }
      return;
    }
    if (handled) return;
    // Empty canvas: zoom in one step around the tap.
    if (marqueeScopeFor(target)?.kind === 'canvas') {
      applyCamera(zoomAround(currentCamera(), groundPoint(tap.x, tap.y), DOUBLE_TAP_ZOOM_FACTOR));
    }
  }, [applyCamera, currentCamera, groundPoint, marqueeScopeFor, rootStore.editorUI]);

  const stopTouchListeners = useCallback(() => {
    touchListenersRef.current?.();
    touchListenersRef.current = null;
  }, []);

  /**
   * Window listeners for the fingers on the canvas, from the first finger
   * down to the last finger up. Window, not the ground: a finger's events go
   * to the element it pressed (implicit capture), which may be a component
   * whose drag source has captured it.
   */
  const ensureTouchListeners = useCallback(() => {
    if (touchListenersRef.current) return;
    const tracker = touchRef.current!;
    const onMove = (ev: PointerEvent) => {
      if (!tracker.has(ev.pointerId)) return;
      const camera = tracker.move(ev.pointerId, groundPoint(ev.clientX, ev.clientY), ev.pointerType);
      if (camera) schedulePinch();
    };
    const onEnd = (ev: PointerEvent) => {
      if (!tracker.has(ev.pointerId)) return;
      const wasPhase = tracker.phase;
      // Land the camera on the fingers' final positions before re-anchoring.
      if (wasPhase === 'pinch') flushPinch();
      const { phase, tracked } = tracker.up(ev.pointerId, currentCamera());
      if (phase === 'idle') {
        stopTouchListeners();
        if (tracker.multiTouch) blockTouchClicksUntilRef.current = performance.now() + 400;
      }
      if (
        ev.type === 'pointerup' &&
        wasPhase === 'single' &&
        tracked &&
        !tracked.moved &&
        !tracker.multiTouch &&
        performance.now() - tracked.startTime <= TAP_MAX_DURATION_MS &&
        rootStore.editorUI.selectedTool === EditorTool.SELECT
      ) {
        const tap = { x: ev.clientX, y: ev.clientY, time: performance.now() };
        if (isDoubleTap(lastTapRef.current, tap) && ev.target instanceof Element) {
          lastTapRef.current = null;
          handleDoubleTap(ev.target, tap);
        } else {
          lastTapRef.current = tap;
        }
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    touchListenersRef.current = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
    };
  }, [currentCamera, flushPinch, groundPoint, handleDoubleTap, rootStore.editorUI, schedulePinch, stopTouchListeners]);

  // Unmount: drop the fingers and any pending frame.
  useEffect(() => () => {
    touchListenersRef.current?.();
    touchListenersRef.current = null;
    if (pinchRafRef.current) cancelAnimationFrame(pinchRafRef.current);
    touchRef.current?.reset();
  }, []);

  /** A touch or pen press on the canvas (capture phase, before any node). */
  const handleTouchPointerDown = useCallback((e: React.PointerEvent) => {
    const tracker = touchRef.current!;
    lastTouchPressAtRef.current = performance.now();
    ensureTouchListeners();
    const result = tracker.down(
      e.pointerId,
      groundPoint(e.clientX, e.clientY),
      performance.now(),
      currentCamera(),
    );
    if (result !== 'single') {
      // Second (or later) finger: it belongs to the pinch, nothing below may
      // select, move or start a rectangle with it.
      e.stopPropagation();
      blockTouchClicksUntilRef.current = Infinity;
      lastTapRef.current = null;
      if (result === 'pinch-start') cancelOneFingerGestures();
      return;
    }
    blockTouchClicksUntilRef.current = 0;
    // Pen barrel button or eraser: nothing.
    if (e.button !== 0) return;
    const tool = rootStore.editorUI.selectedTool;
    if (tool === EditorTool.GRAB) {
      startPan(e);
      return;
    }
    if (tool !== EditorTool.SELECT) return;
    if (getDragManager()?.isActive) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    // Editing text: the finger places the caret.
    if (target instanceof HTMLElement && target.isContentEditable) return;
    const selected = selectedNodeUnder(target);
    if (selected) {
      // Move the selected node, even when the finger is on one of its
      // children. Below the threshold this stays a tap (the click selects).
      getDragManager()?.begin({ kind: 'moveNode', nodeId: selected.id }, e, selected);
      e.stopPropagation();
      return;
    }
    const scope = marqueeScopeFor(target) ?? touchMarqueeScopeFor(target);
    if (scope) startMarquee(e, scope);
  }, [
    cancelOneFingerGestures,
    currentCamera,
    ensureTouchListeners,
    groundPoint,
    marqueeScopeFor,
    rootStore.editorUI,
    selectedNodeUnder,
    startMarquee,
    startPan,
    touchMarqueeScopeFor,
  ]);

  // A touch can make the browser send its own dblclick (some engines do on a
  // double-tap) and, on a long-press, a contextmenu. The canvas runs its own
  // double-tap and gives a long-press no meaning, so both are dropped when
  // they follow a touch or pen press. Synthetic events (ours) are untrusted.
  const handleDoubleClickCapture = useCallback((e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    if (performance.now() - lastTouchPressAtRef.current > 1000) return;
    e.stopPropagation();
    e.preventDefault();
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (performance.now() - lastTouchPressAtRef.current > 1500) return;
    e.preventDefault();
  }, []);

  // ===== Ground pointer handlers =====
  const handlePointerDownCapture = useCallback((e: React.PointerEvent) => {
    suppressClickRef.current = false;
    if (isTouchLike(e.pointerType)) {
      handleTouchPointerDown(e);
      return;
    }
    if (panRef.current) {
      // Another button pressed during a pan: keep panning, select nothing.
      e.stopPropagation();
      return;
    }
    if (e.pointerType === 'mouse' && e.button === 1) {
      startPan(e);
      return;
    }
    if (e.button !== 0 || !e.isPrimary) return;
    const tool = rootStore.editorUI.selectedTool;
    if (tool === EditorTool.GRAB) {
      startPan(e);
      return;
    }
    if (tool !== EditorTool.SELECT) return;
    if (getDragManager()?.isActive) return;
    const scope = marqueeScopeFor(e.target);
    if (scope) startMarquee(e, scope);
  }, [handleTouchPointerDown, marqueeScopeFor, rootStore.editorUI, startMarquee, startPan]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== e.pointerId) return;
    const deltaX = e.clientX - pan.x;
    const deltaY = e.clientY - pan.y;
    if (deltaX === 0 && deltaY === 0) return;
    // Update transform state directly (no React re-render)
    transformState.current.panX += deltaX;
    transformState.current.panY += deltaY;
    applyTransform();
    pan.x = e.clientX;
    pan.y = e.clientY;
  }, [applyTransform, transformState]);

  const handlePointerEnd = useCallback((e: React.PointerEvent) => {
    endPan(e.pointerId);
  }, [endPan]);

  // Middle press: no autoscroll, no paste (Linux), and a link under the
  // pointer does not open in a new tab.
  const preventMiddleDefault = useCallback((e: React.MouseEvent) => {
    if (e.button === 1) e.preventDefault();
  }, []);

  const handleClickCapture = useCallback((e: React.MouseEvent) => {
    if (performance.now() < blockTouchClicksUntilRef.current) {
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    e.stopPropagation();
    e.preventDefault();
  }, []);

  // Handle canvas click - deselect when clicking empty space
  const handleCanvasClick = useCallback((e: React.MouseEvent) => {
    // Only deselect if we're in SELECT mode and clicking on empty canvas space
    if (rootStore.editorUI.selectedTool === EditorTool.SELECT) {
      const target = e.target as HTMLElement;

      // Check if we clicked on the ground element itself, the grid background, or camera wrapper
      // (i.e., not on any actual content elements)
      const isEmptySpace = target === groundRef.current ||
                          target.classList.contains('opacity-40') || // Grid background
                          target === cameraRef.current ||
                          (target.closest && !target.closest('.ground-wrapper') && !target.closest('[data-component-id]') && !target.closest('[data-viewport-id]'));

      if (isEmptySpace) {
        rootStore.editorUI.clearSelection();
      }
    }
  }, [rootStore.editorUI]);

  const preventNativeDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  // Add native wheel event listener with non-passive option
  useEffect(() => {
    const ground = groundRef.current;
    if (!ground) return;
    ground.addEventListener('wheel', handleWheel, { passive: false });
    return () => ground.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // Update cursor when tool changes (Grab tool, or Space held)
  const selectedTool = rootStore.editorUI.selectedTool;
  useEffect(() => {
    if (panRef.current) return; // mid-pan the hand stays closed
    setPanCursor(selectedTool === EditorTool.GRAB ? 'grab' : null);
  }, [selectedTool, setPanCursor]);

  // A tool switch mid-marquee (V/H, Space) ends the rectangle.
  useEffect(() => {
    if (selectedTool !== EditorTool.SELECT) marqueeCleanupRef.current?.();
  }, [selectedTool]);

  // Don't render if no page is selected
  if (!rootStore.editorUI.currentPage) {
    return (
      <main className="flex-1 p-8 flex items-center justify-center">
        <div className="text-gray-500 text-center">
          <div className="text-lg font-medium">No page selected</div>
          <div className="text-sm">Create a project to start designing</div>
        </div>
      </main>
    );
  }

  return (
    <main className="w-screen h-screen bg-gray-100 relative">
      <div className="w-full h-full bg-gray-100 overflow-hidden relative">
        {/* Canvas viewport. data-ground marks this as the drop region that
            resolves to `{kind:'floating', x, y}` for the new DragManager when
            the cursor is over empty canvas. */}
        <div
          ref={groundRef}
          data-ground="true"
          // touch-action: none hands every finger on the canvas to the
          // gestures above (no browser scroll, pinch or double-tap zoom here);
          // the rest of the editor keeps native panel scrolling. No iOS
          // long-press callout on images in the page.
          className={`w-full h-full select-none touch-none ${selectedTool === EditorTool.GRAB ? 'cursor-grab' : 'cursor-default'} relative overflow-hidden`}
          style={{ WebkitTouchCallout: 'none' }}
          onPointerDownCapture={handlePointerDownCapture}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onLostPointerCapture={handlePointerEnd}
          onMouseDownCapture={preventMiddleDefault}
          onMouseUpCapture={preventMiddleDefault}
          onAuxClickCapture={preventMiddleDefault}
          onClickCapture={handleClickCapture}
          onClick={handleCanvasClick}
          onDoubleClickCapture={handleDoubleClickCapture}
          onContextMenu={handleContextMenu}
          // The editor uses pointer gestures only; a native drag of a link or
          // image in the page would hijack the pointer mid-pan or mid-marquee.
          onDragStartCapture={preventNativeDrag}
        >
          {/* Fixed grid background - stays in viewport, doesn't transform */}
          <div
            className="absolute inset-0 opacity-40 pointer-events-none"
            style={{
              backgroundImage: `
                linear-gradient(to right, #e5e7eb 1px, transparent 1px),
                linear-gradient(to bottom, #e5e7eb 1px, transparent 1px)
              `,
              backgroundSize: '20px 20px',
            }}
          />

          {/* Camera (transform wrapper) only element that pans/zooms */}
          <div
            ref={cameraRef}
            className="absolute top-0 left-0 w-0 h-0 origin-top-left will-change-transform"
            style={{ transform: `translate(${transformState.current.panX}px, ${transformState.current.panY}px) scale(${transformState.current.zoom})` }}
            data-camera-transform={`${transformState.current.panX},${transformState.current.panY},${transformState.current.zoom}`}
          >
            {/* Page root(s) */}
            <ResponsivePageRenderer  />
          </div>

          {/* Marquee (rubber-band) selection rectangle, in ground space.
              Positioned by direct DOM writes during the gesture. */}
          <div
            ref={marqueeRef}
            data-testid="marquee-selection"
            aria-hidden="true"
            className="absolute top-0 left-0 pointer-events-none border border-brand bg-brand/10 rounded-[2px]"
            style={{ display: 'none', zIndex: 20 }}
          />
        </div>
      </div>
    </main>
  );
});

// Main Canvas component (TransformProvider now in EditorApp)
const Canvas = observer(() => {
  return <CanvasInner />;
});

Canvas.displayName = 'Canvas';

export default Canvas;
