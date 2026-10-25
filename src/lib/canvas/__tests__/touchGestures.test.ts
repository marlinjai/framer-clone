import { describe, it, expect } from 'vitest';
import {
  LONG_PRESS_MS,
  TouchGestureTracker,
  isLongPress,
  ZOOM_MAX,
  ZOOM_MIN,
  clampZoom,
  dragThresholdFor,
  isDoubleTap,
  isPastDragThreshold,
  isTouchLike,
  pinchAnchor,
  pinchCamera,
  zoomAround,
  type CameraTransform,
} from '../touchGestures';

const cam = (zoom = 1, panX = 0, panY = 0): CameraTransform => ({ zoom, panX, panY });
/** World point shown at screen point p under camera c. */
const toWorld = (c: CameraTransform, p: { x: number; y: number }) => ({
  x: (p.x - c.panX) / c.zoom,
  y: (p.y - c.panY) / c.zoom,
});

describe('zoom limits', () => {
  it('clamps to the shared limits and survives junk', () => {
    expect(clampZoom(0.01)).toBe(ZOOM_MIN);
    expect(clampZoom(50)).toBe(ZOOM_MAX);
    expect(clampZoom(2)).toBe(2);
    expect(clampZoom(NaN)).toBe(1);
  });
});

describe('zoomAround', () => {
  it('keeps the world point under the focus fixed', () => {
    const before = cam(1, 40, -20);
    const focus = { x: 200, y: 150 };
    const after = zoomAround(before, focus, 1.5);
    expect(after.zoom).toBeCloseTo(1.5);
    const w0 = toWorld(before, focus);
    const w1 = toWorld(after, focus);
    expect(w1.x).toBeCloseTo(w0.x);
    expect(w1.y).toBeCloseTo(w0.y);
  });

  it('stops at the maximum zoom without moving the focus point', () => {
    const before = cam(4, 0, 0);
    const after = zoomAround(before, { x: 100, y: 100 }, 3);
    expect(after.zoom).toBe(ZOOM_MAX);
    expect(toWorld(after, { x: 100, y: 100 }).x).toBeCloseTo(25);
  });
});

describe('pinchCamera', () => {
  it('spreading the fingers zooms around their midpoint', () => {
    const start = cam(1, 0, 0);
    const anchor = pinchAnchor(start, { x: 100, y: 200 }, { x: 200, y: 200 });
    const next = pinchCamera(anchor, { x: 50, y: 200 }, { x: 250, y: 200 });
    expect(next.zoom).toBeCloseTo(2);
    // The world point under the midpoint (150, 200) stays there.
    const w = toWorld(next, { x: 150, y: 200 });
    expect(w.x).toBeCloseTo(150);
    expect(w.y).toBeCloseTo(200);
  });

  it('moving both fingers together pans by the midpoint delta, zoom unchanged', () => {
    const start = cam(0.5, 10, 20);
    const anchor = pinchAnchor(start, { x: 100, y: 100 }, { x: 200, y: 100 });
    const next = pinchCamera(anchor, { x: 130, y: 60 }, { x: 230, y: 60 });
    expect(next.zoom).toBeCloseTo(0.5);
    expect(next.panX).toBeCloseTo(40);
    expect(next.panY).toBeCloseTo(-20);
  });

  it('pinches and pans at the same time', () => {
    const start = cam(1, 0, 0);
    const anchor = pinchAnchor(start, { x: 0, y: 0 }, { x: 100, y: 0 });
    // Spread to 200 and move the midpoint from (50,0) to (150,50).
    const next = pinchCamera(anchor, { x: 50, y: 50 }, { x: 250, y: 50 });
    expect(next.zoom).toBeCloseTo(2);
    const w = toWorld(next, { x: 150, y: 50 });
    expect(w.x).toBeCloseTo(50);
    expect(w.y).toBeCloseTo(0);
  });

  it('clamps the zoom and keeps the midpoint anchored at the limit', () => {
    const anchor = pinchAnchor(cam(4, 0, 0), { x: 0, y: 0 }, { x: 10, y: 0 });
    const next = pinchCamera(anchor, { x: -100, y: 0 }, { x: 110, y: 0 });
    expect(next.zoom).toBe(ZOOM_MAX);
    expect(toWorld(next, { x: 5, y: 0 }).x).toBeCloseTo(5 / 4);
  });

  it('fingers on top of each other only pan (no division by zero)', () => {
    const anchor = pinchAnchor(cam(1, 0, 0), { x: 50, y: 50 }, { x: 50, y: 50 });
    const next = pinchCamera(anchor, { x: 60, y: 70 }, { x: 60, y: 70 });
    expect(next).toEqual({ zoom: 1, panX: 10, panY: 20 });
  });
});

describe('thresholds and taps', () => {
  it('uses a larger drag threshold for fingers than for mouse and pen', () => {
    expect(dragThresholdFor('mouse')).toBe(4);
    expect(dragThresholdFor('pen')).toBe(4);
    expect(dragThresholdFor('touch')).toBe(8);
    expect(isPastDragThreshold({ x: 0, y: 0 }, { x: 5, y: 0 }, 'mouse')).toBe(true);
    expect(isPastDragThreshold({ x: 0, y: 0 }, { x: 5, y: 0 }, 'touch')).toBe(false);
    expect(isPastDragThreshold({ x: 0, y: 0 }, { x: 0, y: -8 }, 'touch')).toBe(true);
  });

  it('classifies touch-like input', () => {
    expect(isTouchLike('touch')).toBe(true);
    expect(isTouchLike('pen')).toBe(true);
    expect(isTouchLike('mouse')).toBe(false);
    expect(isTouchLike(undefined)).toBe(false);
  });

  it('detects a double-tap by time and distance', () => {
    const first = { x: 100, y: 100, time: 1000 };
    expect(isDoubleTap(null, first)).toBe(false);
    expect(isDoubleTap(first, { x: 110, y: 105, time: 1250 })).toBe(true);
    expect(isDoubleTap(first, { x: 110, y: 105, time: 1400 })).toBe(false); // too slow
    expect(isDoubleTap(first, { x: 140, y: 100, time: 1100 })).toBe(false); // too far
    expect(isDoubleTap(first, { x: 100, y: 100, time: 900 })).toBe(false); // clock went back
  });
});

describe('TouchGestureTracker', () => {
  it('one finger is a single gesture and never moves the camera', () => {
    const t = new TouchGestureTracker();
    expect(t.down(1, { x: 0, y: 0 }, 0, cam())).toBe('single');
    expect(t.move(1, { x: 50, y: 0 }, 'touch')).toBeNull();
    expect(t.pointer(1)?.moved).toBe(true);
    expect(t.up(1, cam()).phase).toBe('idle');
    expect(t.multiTouch).toBe(false);
  });

  it('a second finger starts a pinch that pans and zooms', () => {
    const t = new TouchGestureTracker();
    t.down(1, { x: 100, y: 100 }, 0, cam());
    expect(t.down(2, { x: 200, y: 100 }, 10, cam())).toBe('pinch-start');
    expect(t.phase).toBe('pinch');
    expect(t.multiTouch).toBe(true);
    t.move(1, { x: 50, y: 100 }, 'touch');
    const next = t.move(2, { x: 250, y: 100 }, 'touch');
    expect(next?.zoom).toBeCloseTo(2);
  });

  it('lifting one finger mid-pinch settles: no jump, the survivor does nothing', () => {
    const t = new TouchGestureTracker();
    t.down(1, { x: 100, y: 100 }, 0, cam());
    t.down(2, { x: 200, y: 100 }, 10, cam());
    const applied = t.move(2, { x: 300, y: 100 }, 'touch')!;
    expect(t.up(2, applied).phase).toBe('settled');
    // Moving the remaining finger changes nothing.
    expect(t.move(1, { x: 400, y: 400 }, 'touch')).toBeNull();
    expect(t.currentPinchCamera()).toBeNull();
    expect(t.up(1, applied).phase).toBe('idle');
    // The gesture remembers it was multi-touch until the next first finger.
    expect(t.multiTouch).toBe(true);
    t.down(5, { x: 0, y: 0 }, 100, applied);
    expect(t.multiTouch).toBe(false);
  });

  it('a finger landing again after settling resumes the pinch from where the camera is', () => {
    const t = new TouchGestureTracker();
    t.down(1, { x: 100, y: 100 }, 0, cam());
    t.down(2, { x: 200, y: 100 }, 10, cam());
    const applied = t.move(2, { x: 300, y: 100 }, 'touch')!;
    t.up(2, applied);
    expect(t.down(3, { x: 150, y: 150 }, 50, applied)).toBe('pinch-start');
    // No movement yet: the camera is exactly the one applied.
    expect(t.currentPinchCamera()).toEqual(applied);
  });

  it('a third finger is ignored; losing a pinch finger re-anchors on the remaining two', () => {
    const t = new TouchGestureTracker();
    t.down(1, { x: 0, y: 0 }, 0, cam());
    t.down(2, { x: 100, y: 0 }, 0, cam());
    expect(t.down(3, { x: 50, y: 100 }, 0, cam())).toBe('extra');
    expect(t.move(3, { x: 60, y: 120 }, 'touch')).toBeNull();
    const applied = cam(1.2, 5, 5);
    expect(t.up(1, applied).phase).toBe('pinch');
    expect(t.pinchPointers).toEqual([2, 3]);
    expect(t.currentPinchCamera()).toEqual(applied);
  });

  it('ignores unknown pointers and resets cleanly', () => {
    const t = new TouchGestureTracker();
    expect(t.move(9, { x: 1, y: 1 })).toBeNull();
    expect(t.up(9, cam()).tracked).toBeUndefined();
    t.down(1, { x: 0, y: 0 }, 0, cam());
    t.down(2, { x: 10, y: 0 }, 0, cam());
    t.reset();
    expect(t.size).toBe(0);
    expect(t.phase).toBe('idle');
    expect(t.multiTouch).toBe(false);
  });
});

describe('long-press', () => {
  it('a still finger held LONG_PRESS_MS is a long-press, not before', () => {
    const t = new TouchGestureTracker();
    t.down(1, { x: 10, y: 10 }, 1000, cam());
    expect(t.longPressDue(1, 1000 + LONG_PRESS_MS - 1)).toBe(false);
    expect(t.longPressDue(1, 1000 + LONG_PRESS_MS)).toBe(true);
  });

  it('wobble under the touch threshold keeps it; a move past it cancels for good', () => {
    const t = new TouchGestureTracker();
    t.down(1, { x: 10, y: 10 }, 0, cam());
    t.move(1, { x: 15, y: 13 }, 'touch');
    expect(t.longPressDue(1, LONG_PRESS_MS)).toBe(true);
    t.move(1, { x: 30, y: 10 }, 'touch');
    expect(t.longPressDue(1, LONG_PRESS_MS + 100)).toBe(false);
    t.move(1, { x: 10, y: 10 }, 'touch');
    expect(t.longPressDue(1, LONG_PRESS_MS + 200)).toBe(false);
  });

  it('a second finger cancels it, also after that finger lifts', () => {
    const t = new TouchGestureTracker();
    t.down(1, { x: 10, y: 10 }, 0, cam());
    t.down(2, { x: 100, y: 10 }, 50, cam());
    expect(t.longPressDue(1, LONG_PRESS_MS)).toBe(false);
    t.up(2, cam());
    expect(t.longPressDue(1, LONG_PRESS_MS + 100)).toBe(false);
  });

  it('a lifted finger is never a long-press', () => {
    const t = new TouchGestureTracker();
    t.down(1, { x: 10, y: 10 }, 0, cam());
    t.up(1, cam());
    expect(t.longPressDue(1, LONG_PRESS_MS)).toBe(false);
  });

  it('isLongPress is the pure rule', () => {
    expect(isLongPress({ startTime: 0, moved: false }, LONG_PRESS_MS, false)).toBe(true);
    expect(isLongPress({ startTime: 0, moved: false }, LONG_PRESS_MS - 1, false)).toBe(false);
    expect(isLongPress({ startTime: 0, moved: true }, LONG_PRESS_MS, false)).toBe(false);
    expect(isLongPress({ startTime: 0, moved: false }, LONG_PRESS_MS, true)).toBe(false);
  });
});
