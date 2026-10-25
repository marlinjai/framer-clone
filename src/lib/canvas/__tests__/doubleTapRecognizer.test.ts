// The double-tap that starts text editing comes from touch events, so its
// action can run inside touchend (iOS opens the keyboard only there).
import { describe, it, expect } from 'vitest';
import {
  DOUBLE_TAP_MAX_DELAY_MS,
  DoubleTapRecognizer,
  TAP_MAX_DURATION_MS,
  TOUCH_DRAG_THRESHOLD_PX,
} from '../touchGestures';

const P = { x: 100, y: 100 };

/** A one-finger tap: down at `t`, up 50ms later. */
function tap(r: DoubleTapRecognizer, id: number, t: number, p = P) {
  r.start(id, p, t, 1);
  return r.end(id, p, t + 50, 0);
}

describe('DoubleTapRecognizer', () => {
  it('two quick taps in the same spot are a double-tap; the next tap starts over', () => {
    const r = new DoubleTapRecognizer();
    expect(tap(r, 1, 0)).toBe('tap');
    expect(tap(r, 2, 200)).toBe('double');
    expect(tap(r, 3, 400)).toBe('tap');
  });

  it('taps too far apart in time or space are not', () => {
    const r = new DoubleTapRecognizer();
    tap(r, 1, 0);
    expect(tap(r, 2, 50 + DOUBLE_TAP_MAX_DELAY_MS + 1)).toBe('tap');
    expect(tap(r, 3, 2000, { x: 200, y: 100 })).toBe('tap');
    expect(tap(r, 4, 2100, { x: 100, y: 100 })).toBe('tap');
  });

  it('a finger that moved past the touch threshold is a drag and breaks the sequence', () => {
    const r = new DoubleTapRecognizer();
    tap(r, 1, 0);
    r.start(2, P, 100, 1);
    r.move(2, { x: P.x + TOUCH_DRAG_THRESHOLD_PX, y: P.y });
    expect(r.end(2, P, 150, 0)).toBeNull();
    expect(tap(r, 3, 200)).toBe('tap');
  });

  it('a long press is not a tap', () => {
    const r = new DoubleTapRecognizer();
    tap(r, 1, 0);
    r.start(2, P, 60, 1);
    expect(r.end(2, P, 60 + TAP_MAX_DURATION_MS + 1, 0)).toBeNull();
  });

  it('a second finger (a pinch) breaks it, until every finger has lifted', () => {
    const r = new DoubleTapRecognizer();
    tap(r, 1, 0);
    r.start(2, P, 100, 1);
    r.start(3, { x: 200, y: 100 }, 110, 2);
    expect(r.end(3, { x: 200, y: 100 }, 150, 1)).toBeNull();
    expect(r.end(2, P, 160, 0)).toBeNull();
    expect(tap(r, 4, 200)).toBe('tap');
  });

  it('a touch that did not start on the canvas breaks it', () => {
    const r = new DoubleTapRecognizer();
    tap(r, 1, 0);
    r.start(2, P, 100, 1, false);
    expect(r.end(2, P, 150, 0)).toBeNull();
    expect(tap(r, 3, 200)).toBe('tap');
  });

  it('cancel forgets everything (touchcancel)', () => {
    const r = new DoubleTapRecognizer();
    tap(r, 1, 0);
    r.cancel();
    expect(tap(r, 2, 100)).toBe('tap');
  });
});
