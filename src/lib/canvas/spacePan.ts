import { isEditableTarget } from '@/lib/keyBindings';

// Hold Space to pan the canvas. Space is also how a keyboard presses a
// focused button, ticks a checkbox or switch, picks a menu item or option
// and types a space in a field (WCAG 2.1.1, keyboard), so the pan only takes
// Space when focus is on the canvas or on nothing interactive.

// Elements whose own Space behaviour wins over the pan.
const SPACE_CONTROL = [
  'button',
  'a[href]',
  'summary',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="radio"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="treeitem"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
].join(', ');

// Anything inside one of these keeps Space, even plain text: a dialog or an
// open menu owns the keyboard while it is up.
const SPACE_CONTAINER = [
  'dialog',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[aria-modal="true"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="listbox"]',
].join(', ');

// The canvas ground. The page drawn on it is edited, not operated: a button
// or link of the site on the canvas is a layer, so Space over it still pans.
const CANVAS = '[data-ground]';

/** True when Space on `target` belongs to the focused element, not the pan. */
export function spaceBelongsToTarget(target: EventTarget | null): boolean {
  if (isEditableTarget(target)) return true;
  if (!(target instanceof Element)) return false;
  // Text being edited, on the canvas too. Matched by attribute as well as by
  // isContentEditable, which some engines (jsdom) do not implement.
  if (target.closest('[contenteditable]:not([contenteditable="false"])')) return true;
  if (target.closest(SPACE_CONTAINER)) return true;
  const control = target.closest(SPACE_CONTROL);
  if (!control) return false;
  return !control.closest(CANVAS);
}

/** True when a focused control (button, link, menu item) keeps its Enter or Space. */
export function isActivatableControl(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(SPACE_CONTROL) && !target.closest(CANVAS);
}

export interface SpacePanUI {
  readonly previewOpen: boolean;
  readonly toolBeforeTemporaryGrab: unknown;
  beginTemporaryGrab(): void;
  endTemporaryGrab(): void;
}

/**
 * Hold Space to pan with the left button, whatever the active tool; the tool
 * comes back on release. Losing focus (Cmd+Tab with Space down) never
 * delivers the keyup, so blur releases it too. Returns the unbind function.
 */
export function bindSpacePan(
  ui: SpacePanUI,
  win: Window,
  isDragging: () => boolean = () => false,
): () => void {
  const isSpace = (e: KeyboardEvent) => e.code === 'Space' || e.key === ' ';
  const onKeyDown = (e: KeyboardEvent) => {
    if (!isSpace(e) || e.defaultPrevented) return;
    if (spaceBelongsToTarget(e.target)) return;
    // Space scrolls the preview over the editor; it is not a pan there.
    if (ui.previewOpen) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Stops the page from scrolling.
    e.preventDefault();
    if (e.repeat || isDragging()) return;
    ui.beginTemporaryGrab();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    // Only a Space that began a pan is swallowed; any other keyup reaches
    // the focused control, which a browser activates on Space up.
    if (!isSpace(e) || ui.toolBeforeTemporaryGrab === undefined) return;
    e.preventDefault();
    ui.endTemporaryGrab();
  };
  const release = () => ui.endTemporaryGrab();
  win.addEventListener('keydown', onKeyDown);
  win.addEventListener('keyup', onKeyUp);
  win.addEventListener('blur', release);
  return () => {
    win.removeEventListener('keydown', onKeyDown);
    win.removeEventListener('keyup', onKeyUp);
    win.removeEventListener('blur', release);
    release();
  };
}
