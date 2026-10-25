// src/components/phone/phoneHandlePress.ts
//
// A finger press on a canvas handle in the phone layout (resize and corner
// radius handles in HudSurface, spacing handles in SpacingHandlesLayer): a
// drag past the touch threshold starts the handle's own gesture, a still hold
// opens the selection's long-press menu (src/lib/canvas/handlePress.ts). One
// wiring for every handle, so they cannot drift apart.
import type { EditorUIType } from '@/stores/EditorUIStore';
import { haptic, hapticOrDefer } from '@/lib/haptics';
import { followHandlePress, type HandlePress } from '@/lib/canvas/handlePress';
import { slideMenuMove } from './PhoneContextMenu';

export function startPhoneHandlePress(opts: {
  editorUI: EditorUIType;
  pointerId: number;
  start: { x: number; y: number };
  /** Start the handle gesture from `start`; `at` is where the finger is now. */
  startHandle: (at: { x: number; y: number }) => void;
}): HandlePress {
  const { editorUI, start } = opts;
  return followHandlePress({
    pointerId: opts.pointerId,
    start,
    target: document,
    deps: {
      startHandle: opts.startHandle,
      openMenu: () => editorUI.openPhoneContextMenu(start),
      slideMove: (x, y) => slideMenuMove(editorUI, x, y),
      tryTick: hapticOrDefer,
      tick: () => { haptic(); },
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (t) => window.clearTimeout(t),
    },
  });
}
