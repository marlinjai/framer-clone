// src/lib/canvas/touchGestures.ts
//
// Touch and pen input on the canvas: the pure math and bookkeeping, no DOM.
// Canvas.tsx feeds pointer events in and applies the camera this returns, so
// the rules (pinch around the fingers' midpoint, two-finger pan, tap versus
// drag, double-tap timing, what happens when a finger lifts) are unit tested
// without a browser.
//
// The gesture model on a touch screen (decided 2026-10-24 with the owner,
// written up in docs/plans/2026-10-24-editor-on-phones.md):
//   - two fingers: move pans the camera, pinch zooms it, both at once, around
//     the midpoint between the fingers;
//   - one finger: tap selects, a drag on the selected element moves it, a
//     drag anywhere else draws the selection rectangle, double-tap edits text
//     (or zooms in a step on empty canvas). One finger never pans, except
//     with the Grab tool, which is an explicit choice to pan.
//   - long-press (added 2026-10-25 with the owner, phone layout): one finger
//     held still for LONG_PRESS_MS on an element selects it and opens the
//     context menu. Moving past the drag threshold or a second finger
//     cancels it, exactly as either turns a tap into something else.

/** The camera: screen = world * zoom + pan. Same shape as TransformContext. */
export interface CameraTransform {
  zoom: number;
  panX: number;
  panY: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Zoom limits shared by the wheel, the toolbar and the pinch. */
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 5;

/** Factor one double-tap on empty canvas zooms in by. */
export const DOUBLE_TAP_ZOOM_FACTOR = 1.5;

/** Mouse travel before a press becomes a drag (the drag manager and marquee
 *  have always used 4px). */
export const MOUSE_DRAG_THRESHOLD_PX = 4;
/** A fingertip wobbles more than a mouse: below this a touch stays a tap. */
export const TOUCH_DRAG_THRESHOLD_PX = 8;

/** Two taps within this time and distance are a double-tap. */
export const DOUBLE_TAP_MAX_DELAY_MS = 300;
export const DOUBLE_TAP_MAX_DISTANCE_PX = 24;
/** A press held longer than this is not a tap. */
export const TAP_MAX_DURATION_MS = 450;
/** A still finger held this long is a long-press (the phone context menu). */
export const LONG_PRESS_MS = 450;

/**
 * True when a press counts as a long-press now: one finger the whole time,
 * never moved past the drag threshold, held at least LONG_PRESS_MS.
 */
export function isLongPress(press: { startTime: number; moved: boolean }, now: number, multiTouch: boolean): boolean {
  if (multiTouch || press.moved) return false;
  return now - press.startTime >= LONG_PRESS_MS;
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
}

/** Pointer travel before a press becomes a drag, per input type. */
export function dragThresholdFor(pointerType: string | undefined): number {
  return pointerType === 'touch' ? TOUCH_DRAG_THRESHOLD_PX : MOUSE_DRAG_THRESHOLD_PX;
}

/** True for input that follows the touch gesture model (finger or pen). */
export function isTouchLike(pointerType: string | undefined): boolean {
  return pointerType === 'touch' || pointerType === 'pen';
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Zoom by `factor` keeping the world point under `focus` (ground-relative
 * screen px) where it is. The zoom is clamped; at a limit the pan still keeps
 * the focus point fixed.
 */
export function zoomAround(camera: CameraTransform, focus: Point, factor: number): CameraTransform {
  const zoom = clampZoom(camera.zoom * factor);
  const worldX = (focus.x - camera.panX) / camera.zoom;
  const worldY = (focus.y - camera.panY) / camera.zoom;
  return { zoom, panX: focus.x - worldX * zoom, panY: focus.y - worldY * zoom };
}

/**
 * Where a pinch starts: the camera and the two fingers at that moment. The
 * camera during the gesture is always computed from this anchor, never frame
 * to frame, so rounding cannot drift and a clamped zoom does not accumulate.
 */
export interface PinchAnchor {
  camera: CameraTransform;
  midpoint: Point;
  distance: number;
}

export function pinchAnchor(camera: CameraTransform, a: Point, b: Point): PinchAnchor {
  return { camera: { ...camera }, midpoint: midpoint(a, b), distance: distance(a, b) };
}

/**
 * The camera for two fingers now at `a` and `b`, given the anchor. The world
 * point that was under the anchor midpoint follows the current midpoint (the
 * two-finger pan) while the zoom scales with the finger spread (the pinch).
 * Fingers that started on top of each other (distance 0) only pan.
 */
export function pinchCamera(anchor: PinchAnchor, a: Point, b: Point): CameraTransform {
  const mid = midpoint(a, b);
  const spread = distance(a, b);
  const ratio = anchor.distance > 0 && spread > 0 ? spread / anchor.distance : 1;
  const zoom = clampZoom(anchor.camera.zoom * ratio);
  const worldX = (anchor.midpoint.x - anchor.camera.panX) / anchor.camera.zoom;
  const worldY = (anchor.midpoint.y - anchor.camera.panY) / anchor.camera.zoom;
  return { zoom, panX: mid.x - worldX * zoom, panY: mid.y - worldY * zoom };
}

/** True once the pointer has moved past the drag threshold for its type. */
export function isPastDragThreshold(start: Point, current: Point, pointerType?: string): boolean {
  const t = dragThresholdFor(pointerType);
  return Math.abs(current.x - start.x) >= t || Math.abs(current.y - start.y) >= t;
}

/** A completed tap: where and when the finger lifted. */
export interface Tap {
  x: number;
  y: number;
  time: number;
}

/** True when `tap` completes a double-tap begun by `previous`. */
export function isDoubleTap(previous: Tap | null, tap: Tap): boolean {
  if (!previous) return false;
  const dt = tap.time - previous.time;
  if (dt < 0 || dt > DOUBLE_TAP_MAX_DELAY_MS) return false;
  return Math.hypot(tap.x - previous.x, tap.y - previous.y) <= DOUBLE_TAP_MAX_DISTANCE_PX;
}

// ===== Pointer bookkeeping =====

interface TrackedPointer {
  start: Point;
  current: Point;
  startTime: number;
  /** Moved past the drag threshold at some point. */
  moved: boolean;
}

/**
 * The fingers on the canvas and the pinch they form. One instance lives per
 * canvas. A gesture runs from the first finger down to the last finger up.
 *
 * Phases:
 *   - single: one finger, nothing claimed here; the canvas lets the existing
 *     select / move / marquee path have it.
 *   - pinch: two (or more) fingers; the first two pinch and pan the camera.
 *   - settled: a pinch lost a finger; the fingers still down do nothing until
 *     they lift (no drag, no jump, no click), or a finger lands again and the
 *     pinch resumes from a fresh anchor.
 */
export type GesturePhase = 'idle' | 'single' | 'pinch' | 'settled';

export class TouchGestureTracker {
  private pointers = new Map<number, TrackedPointer>();
  private pinchIds: [number, number] | null = null;
  private anchor: PinchAnchor | null = null;
  private wasMulti = false;
  phase: GesturePhase = 'idle';

  get size(): number {
    return this.pointers.size;
  }

  has(id: number): boolean {
    return this.pointers.has(id);
  }

  /** True when this gesture had two fingers down at some point. */
  get multiTouch(): boolean {
    return this.wasMulti;
  }

  /** The two pointer ids forming the pinch, or null. */
  get pinchPointers(): [number, number] | null {
    return this.pinchIds;
  }

  pointer(id: number): { start: Point; current: Point; startTime: number; moved: boolean } | undefined {
    return this.pointers.get(id);
  }

  /**
   * A finger lands. Returns 'pinch-start' when this finger starts (or
   * resumes) a pinch, which is the caller's cue to cancel any one-finger
   * gesture in progress.
   */
  down(id: number, p: Point, time: number, camera: CameraTransform): 'single' | 'pinch-start' | 'extra' {
    this.pointers.set(id, { start: { ...p }, current: { ...p }, startTime: time, moved: false });
    if (this.pointers.size === 1) {
      this.phase = 'single';
      this.wasMulti = false;
      return 'single';
    }
    if (this.phase === 'pinch') return 'extra'; // a third finger: ignored
    this.wasMulti = true;
    this.startPinch(camera);
    return 'pinch-start';
  }

  /**
   * A finger moves. Returns the camera to apply when the pinch changed it,
   * or null.
   */
  move(id: number, p: Point, pointerType?: string): CameraTransform | null {
    const t = this.pointers.get(id);
    if (!t) return null;
    t.current = { ...p };
    if (!t.moved && isPastDragThreshold(t.start, p, pointerType)) t.moved = true;
    if (this.phase !== 'pinch' || !this.pinchIds || !this.anchor) return null;
    if (id !== this.pinchIds[0] && id !== this.pinchIds[1]) return null;
    return this.currentPinchCamera();
  }

  /** The camera the pinch implies for the fingers' latest positions. */
  currentPinchCamera(): CameraTransform | null {
    if (this.phase !== 'pinch' || !this.pinchIds || !this.anchor) return null;
    const a = this.pointers.get(this.pinchIds[0]);
    const b = this.pointers.get(this.pinchIds[1]);
    if (!a || !b) return null;
    return pinchCamera(this.anchor, a.current, b.current);
  }

  /**
   * A finger lifts (or is cancelled). `camera` is the camera as currently
   * applied: when the pinch loses a finger but two remain, the pinch
   * re-anchors there so nothing jumps.
   */
  up(id: number, camera: CameraTransform): { phase: GesturePhase; tracked: TrackedPointer | undefined } {
    const tracked = this.pointers.get(id);
    if (!tracked) return { phase: this.phase, tracked };
    this.pointers.delete(id);
    if (this.pointers.size === 0) {
      this.phase = 'idle';
      this.pinchIds = null;
      this.anchor = null;
      return { phase: 'idle', tracked };
    }
    if (this.phase === 'pinch' && this.pinchIds && (id === this.pinchIds[0] || id === this.pinchIds[1])) {
      if (this.pointers.size >= 2) {
        this.startPinch(camera);
      } else {
        this.phase = 'settled';
        this.pinchIds = null;
        this.anchor = null;
      }
    }
    return { phase: this.phase, tracked };
  }

  /**
   * True when finger `id` is a long-press at `now`: the only finger of the
   * gesture (no pinch ever started), still down, and still where it landed.
   */
  longPressDue(id: number, now: number): boolean {
    const t = this.pointers.get(id);
    if (!t || this.phase !== 'single' || this.pointers.size !== 1) return false;
    return isLongPress(t, now, this.wasMulti);
  }

  /** Forget every finger (canvas unmount, tool switch, window blur). */
  reset(): void {
    this.pointers.clear();
    this.pinchIds = null;
    this.anchor = null;
    this.wasMulti = false;
    this.phase = 'idle';
  }

  private startPinch(camera: CameraTransform) {
    const ids = Array.from(this.pointers.keys()).slice(0, 2) as [number, number];
    const a = this.pointers.get(ids[0])!;
    const b = this.pointers.get(ids[1])!;
    this.pinchIds = ids;
    this.anchor = pinchAnchor(camera, a.current, b.current);
    this.phase = 'pinch';
  }
}
