// src/lib/layers/sidebarWidth.ts
//
// Width of the editor's left sidebar (Pages + Layers), resizable by dragging
// or arrow-keying the handle on its right edge. The sidebar floats over the
// full-screen canvas (EditorApp positions it `fixed left-0`), so nothing else
// in the editor offsets itself by this width.
//
// The width is remembered in localStorage. The editor has no user id on the
// client, so "per user" is per browser profile; storage can throw (private
// mode, sandboxed frames) and remembering the width is only a convenience.

export const LEFT_SIDEBAR_DEFAULT_WIDTH = 256;
export const LEFT_SIDEBAR_MIN_WIDTH = 220;
export const LEFT_SIDEBAR_MAX_WIDTH = 480;
/** One Arrow key press on the resize handle. */
export const LEFT_SIDEBAR_KEY_STEP = 16;

const STORAGE_KEY = 'framer-clone:left-sidebar-width';

/** The width kept inside [min, max], rounded to whole pixels. Non-finite input gives the default. */
export function clampLeftSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return LEFT_SIDEBAR_DEFAULT_WIDTH;
  return Math.round(Math.min(LEFT_SIDEBAR_MAX_WIDTH, Math.max(LEFT_SIDEBAR_MIN_WIDTH, width)));
}

/** The remembered width, or the default (missing, unreadable or garbage values are ignored). */
export function loadLeftSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return LEFT_SIDEBAR_DEFAULT_WIDTH;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && raw.trim() !== '' ? clampLeftSidebarWidth(parsed) : LEFT_SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return LEFT_SIDEBAR_DEFAULT_WIDTH;
  }
}

export function saveLeftSidebarWidth(width: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(clampLeftSidebarWidth(width)));
  } catch {
    // storage unavailable: remembering the width is a nicety
  }
}

// ---------- Layer row action strip ----------
//
// A Layers row reveals its action buttons on hover, over the right end of the
// row. Deep rows in a narrow sidebar have little room for the name, and the
// full strip (hide, lock, more) would cover most of it, so a
// click aimed at the name lands on a button. LayerNode makes each row a CSS
// size container: below 172px of row content (icons, a 40px readable name and
// the full strip) only "More" shows, whose menu holds every action, as does
// right-click. The name reserves the strip's width while hovered, so it
// truncates beside the buttons instead of running under them.

const LAYER_ACTION_BUTTON = 22;
const LAYER_ACTION_GAP = 2;
const LAYER_ACTIONS_INSET = 4;

/** Pixels a strip of `buttons` action buttons covers at the row's right end. */
export function layerActionsWidth(buttons: number): number {
  if (buttons <= 0) return 0;
  return buttons * LAYER_ACTION_BUTTON + (buttons - 1) * LAYER_ACTION_GAP + LAYER_ACTIONS_INSET;
}
