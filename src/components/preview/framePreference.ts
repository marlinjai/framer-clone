// Which frame the preview opens with, remembered per browser: filling the
// window (the default, how a visitor sees the page) or the device frame.
// Storage can be missing or throw (a private window, blocked site data), so
// both directions fail soft to the default.
import type { PreviewFrameMode } from './PreviewToolbar';

const KEY = 'lumitra:preview-frame';

export function readFramePreference(): PreviewFrameMode {
  try {
    return window.localStorage.getItem(KEY) === 'device' ? 'device' : 'fill';
  } catch {
    return 'fill';
  }
}

export function writeFramePreference(frame: PreviewFrameMode): void {
  try {
    window.localStorage.setItem(KEY, frame);
  } catch {
    // Remembering the choice is a nicety; the preview works without it.
  }
}
