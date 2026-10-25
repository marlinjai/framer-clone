// src/lib/canvas/handlePress.ts
//
// A finger press on a selection handle (resize, corner radius) in the phone
// layout. On a small selected element the handles' 44px touch areas cover most
// of it, so a long-press aimed at the element lands on a handle, and handle
// presses never reach the canvas where the long-press menu is recognised: the
// menu silently did not open (seen on production, 2026-10-25).
//
// So a finger press on a handle waits for one of two things:
//   - the finger moves past the touch drag threshold: the handle gesture starts
//     as before, from the press point (no jump), and the rest of the drag
//     follows the handle's own listeners;
//   - the finger stays still for LONG_PRESS_MS: the selected element's
//     long-press menu opens, exactly as a long-press on the element itself
//     does, including the deferred iOS haptic tick at the release and
//     slide-to-select while the finger stays down.
// A quick tap that does neither does nothing (as before: a handle tap never
// resized anything). Pens keep the immediate, precise handles (the caller only
// uses this for touch).

import { LONG_PRESS_MS, TOUCH_DRAG_THRESHOLD_PX } from './touchGestures';

export interface HandlePressDeps {
  /** Start the handle's own gesture from the original press point. */
  startHandle: () => void;
  /** Open the selected element's long-press menu at the press point. */
  openMenu: () => void;
  /** Highlight the menu item under the finger (slide-to-select). */
  slideMove: (x: number, y: number) => void;
  /** Try the haptic now (hapticOrDefer); 'deferred' when it can only play at the release (iOS). */
  tryTick: () => string;
  /** Play the deferred tick (called from inside the release gesture). */
  tick: () => void;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
}

export type HandlePressState = 'waiting' | 'handle' | 'menu' | 'done';

export interface HandlePress {
  move: (x: number, y: number) => void;
  /** The finger lifted (`released` true) or the press was cancelled. */
  end: (released: boolean) => void;
  readonly state: HandlePressState;
}

export function startHandlePress(start: { x: number; y: number }, deps: HandlePressDeps): HandlePress {
  let state: HandlePressState = 'waiting';
  let tickPending = false;
  const timer = deps.setTimer(() => {
    if (state !== 'waiting') return;
    state = 'menu';
    tickPending = deps.tryTick() === 'deferred';
    deps.openMenu();
  }, LONG_PRESS_MS);

  return {
    get state() {
      return state;
    },
    move(x, y) {
      if (state === 'waiting') {
        if (Math.hypot(x - start.x, y - start.y) > TOUCH_DRAG_THRESHOLD_PX) {
          deps.clearTimer(timer);
          state = 'handle';
          deps.startHandle();
        }
      } else if (state === 'menu') {
        deps.slideMove(x, y);
      }
    },
    end(released) {
      deps.clearTimer(timer);
      if (state === 'menu' && released && tickPending) deps.tick();
      tickPending = false;
      state = 'done';
    },
  };
}
