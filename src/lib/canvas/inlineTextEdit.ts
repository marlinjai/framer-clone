// src/lib/canvas/inlineTextEdit.ts
//
// Starting inline text editing on the canvas, the DOM half.
//
// iOS Safari opens the on-screen keyboard only for a focus() that runs
// synchronously inside the handler of a user gesture (touchend or click; not
// pointerup, not an effect after a React re-render), on an element that is
// editable at that moment. And WebKit refuses a caret in a contentEditable
// element whose ancestor has `-webkit-user-select: none`, which the canvas
// ground sets (`select-none`) so a drag never selects page text. So the
// gesture handler that decides "edit this text" calls startInlineTextEdit
// on the element right there, before it tells the store: the element is
// made editable and selectable, focused and given a caret in the same call
// stack, and React's re-render (ComponentRenderer, which renders the same
// attributes for the editing node) keeps the same DOM node and its focus.
//
// Chromium needs none of this, which is why the first touch version passed
// in headless Chromium and failed on a real iPhone.

export interface CaretPoint {
  x: number;
  y: number;
}

/** Inline styles the editing element carries while it is edited (ComponentRenderer renders the same). */
export const EDITING_TEXT_STYLE = {
  // Undo the ground's select-none for the edited text: WebKit gives no caret
  // and no keyboard to a contentEditable element that cannot be selected.
  userSelect: 'text',
  WebkitUserSelect: 'text',
  // The ground hides the iOS long-press callout; editing text needs it
  // (select, copy, paste).
  WebkitTouchCallout: 'default',
  cursor: 'text',
  outline: '2px solid #3b82f6',
} as const;

/**
 * Make `el` an editing text box and focus it, synchronously. `caret` is
 * where the caret goes: a screen point (a double-tap: the caret lands where
 * the finger was, or at the end when the point is not over the text), or
 * 'all' to select the whole text (a mouse double-click: type to replace).
 */
export function startInlineTextEdit(el: HTMLElement, caret: CaretPoint | 'all' | 'end'): void {
  if (el.contentEditable !== 'true') el.contentEditable = 'true';
  el.style.userSelect = 'text';
  el.style.setProperty('-webkit-user-select', 'text');
  el.style.setProperty('-webkit-touch-callout', 'default');
  if (document.activeElement !== el) {
    try {
      // preventScroll: the canvas pans the text into view itself
      // (PhoneEditorChrome), a scrolled document would shift the fixed bars.
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
  }
  placeCaret(el, caret);
}

/** A collapsed range at a screen point, when the point is over `el`'s text. */
export function caretRangeAt(el: HTMLElement, x: number, y: number): Range | null {
  const doc = el.ownerDocument;
  type CaretDoc = Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const d = doc as CaretDoc;
  try {
    if (typeof d.caretPositionFromPoint === 'function') {
      const pos = d.caretPositionFromPoint(x, y);
      if (pos && el.contains(pos.offsetNode)) {
        const range = doc.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
        return range;
      }
    }
    if (typeof d.caretRangeFromPoint === 'function') {
      const range = d.caretRangeFromPoint(x, y);
      if (range && el.contains(range.startContainer)) {
        range.collapse(true);
        return range;
      }
    }
  } catch {
    // An offset outside the node (engines disagree at line ends): fall back.
  }
  return null;
}

/** Put the caret (or a select-all) into `el`. */
export function placeCaret(el: HTMLElement, caret: CaretPoint | 'all' | 'end'): void {
  const sel = el.ownerDocument.defaultView?.getSelection();
  if (!sel) return;
  let range: Range | null = null;
  if (caret !== 'all' && caret !== 'end') range = caretRangeAt(el, caret.x, caret.y);
  if (!range) {
    range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    if (caret !== 'all') range.collapse(false);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}
