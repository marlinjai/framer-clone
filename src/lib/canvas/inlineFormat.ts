// src/lib/canvas/inlineFormat.ts
//
// Text nodes on the canvas: opening one for typing, and turning selected words
// into their own element (bold, italic, a link).
//
// A text node emits no element, so there is nothing to make editable until one
// exists. While it is edited, ComponentRenderer renders it as a span of its own.
// Only that span is editable: the browser never touches its element siblings,
// which React owns, so editing cannot flatten or lose them. The span has to
// exist inside the gesture (iOS opens the keyboard only for a focus made there,
// src/lib/canvas/inlineTextEdit.ts), which is what the flushSync below is for.
//
// A format writes the text as typed so far and the split in one model action,
// so typing and bolding a word is one undo step.

import { flushSync } from 'react-dom';
import { getParentOfType, hasParentOfType } from 'mobx-state-tree';
import ComponentModel, { type ComponentInstance } from '@/models/ComponentModel';
import type { EditorUIType } from '@/stores/EditorUIStore';
import { isTextBound, renderedRunsOf } from '@/lib/renderer/textContent';
import { bareTextRefusal, isTextNodeType, refusesBareText } from '@/lib/renderer/textNode';
import { caretRangeAt, startInlineTextEdit, type CaretPoint } from './inlineTextEdit';

export type InlineFormat = 'bold' | 'italic' | 'link';

interface FormatSpec {
  tag: string;
  /** Tags that already mean this format, the one written first. */
  tags: readonly string[];
  label: string;
  /** What the new element starts with: the Link section takes the target from here. */
  props?: Record<string, unknown>;
}

const FORMATS: Record<InlineFormat, FormatSpec> = {
  bold: { tag: 'strong', tags: ['strong', 'b'], label: 'Bold' },
  italic: { tag: 'em', tags: ['em', 'i'], label: 'Italic' },
  link: { tag: 'a', tags: ['a'], label: 'Link', props: { href: '#' } },
};

/** The shortcut key (with Cmd or Ctrl) of each format. */
export const INLINE_FORMAT_KEYS: Readonly<Record<string, InlineFormat>> = { b: 'bold', i: 'italic', k: 'link' };

/** Elements whose content is text and nothing else: a browser drops markup inside them. */
const TEXT_ONLY_TAGS = new Set(['option', 'textarea', 'title', 'style', 'script']);

function parentElementOf(node: ComponentInstance): ComponentInstance | undefined {
  return hasParentOfType(node, ComponentModel) ? (getParentOfType(node, ComponentModel) as ComponentInstance) : undefined;
}

/** The element a run of text belongs to: the parent of a text node, or the element holding its own text. */
export function ownerOfRun(run: ComponentInstance): ComponentInstance | undefined {
  return isTextNodeType(run.type) ? parentElementOf(run) : run;
}

/** True when `element` is itself this format: pressing it again takes the format off. */
export function hasInlineFormat(element: ComponentInstance, format: InlineFormat): boolean {
  return FORMATS[format].tags.includes(element.type);
}

/** Why words in `element` cannot take `format`, or undefined when they can. */
export function inlineFormatRefusal(element: ComponentInstance, format: InlineFormat): string | undefined {
  const props = element.props as Record<string, unknown>;
  if (!element.isHostElement || props['data-component-kind'] || props['data-form-kind']) {
    return 'This element draws its own content, so its words cannot be formatted.';
  }
  if (refusesBareText(element.type) || TEXT_ONLY_TAGS.has(element.type)) {
    return 'The text here cannot hold other elements, so its words cannot be formatted.';
  }
  const { label, tags } = FORMATS[format];
  for (let node: ComponentInstance | undefined = element; node; node = parentElementOf(node)) {
    if (format === 'link' && (tags.includes(node.type) || node.type === 'button')) {
      return 'A link cannot go inside another link or a button.';
    }
    if (format !== 'link' && tags.includes(node.type)) return `This text is already ${label.toLowerCase()}.`;
  }
  return undefined;
}

/** The text of an edited run: a browser may type a space at an edge as a no-break space. */
export function normaliseEditedText(text: string): string {
  return text.replace(/ /g, ' ');
}

/** The element being typed in, when the edit is live in this document. */
export function editedElement(editing: ComponentInstance | undefined): HTMLElement | null {
  if (!editing || typeof document === 'undefined') return null;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  return active.getAttribute('data-inner-component-id') === editing.id ? active : null;
}

/** The selection inside `el` as offsets into its text; null when it lies elsewhere. */
export function selectionOffsets(el: HTMLElement): { text: string; start: number; end: number } | null {
  const selection = el.ownerDocument.defaultView?.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer)) return null;
  const before = range.cloneRange();
  before.selectNodeContents(el);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  return { text: normaliseEditedText(el.textContent ?? ''), start, end: start + range.toString().length };
}

/**
 * The run of text under a screen point in `host`, which renders `element`. Only
 * text directly in `host` counts: an element child has its own text. Runs emit
 * text in order, so the nth DOM text is the nth rendered run. Text bound to data
 * is the binding's and is not opened.
 */
export function runAtPoint(host: HTMLElement, element: ComponentInstance, point: CaretPoint): ComponentInstance | undefined {
  const node = caretRangeAt(host, point.x, point.y)?.startContainer;
  if (!node || node.nodeType !== Node.TEXT_NODE || node.parentNode !== host) return undefined;
  const texts = Array.from(host.childNodes).filter((child) => child.nodeType === Node.TEXT_NODE);
  const run = renderedRunsOf(element)[texts.indexOf(node as ChildNode)];
  return run && !isTextBound(run) ? run : undefined;
}

function directChildWithId(host: HTMLElement, id: string): HTMLElement | undefined {
  return Array.from(host.children).find(
    (child): child is HTMLElement => child instanceof HTMLElement && child.getAttribute('data-inner-component-id') === id,
  );
}

/**
 * Open a run inside `host` for typing, synchronously: the store is told, React
 * renders the run's span in this call stack, and it takes focus before the
 * gesture ends. A legacy string in front of the children becomes a text node
 * first, since only a node can be opened. Returns false when no span appeared.
 */
export function beginRunEdit(
  editorUI: EditorUIType,
  element: ComponentInstance,
  run: ComponentInstance,
  host: HTMLElement,
  breakpointId: string | undefined,
  caret: CaretPoint | 'all' | 'end',
): boolean {
  let target = run;
  flushSync(() => {
    if (run === element) {
      element.adoptOwnText();
      target = element.children[0] as ComponentInstance;
    }
    editorUI.selectComponent(element, breakpointId);
    editorUI.beginTextEdit(target);
  });
  const span = directChildWithId(host, target.id);
  if (!span) {
    editorUI.endTextEdit();
    return false;
  }
  startInlineTextEdit(span, caret);
  return true;
}

/** Take a format off: the element gives its words back to its parent as plain text. */
function removeFormat(editorUI: EditorUIType, element: ComponentInstance, el: HTMLElement): boolean {
  const parent = parentElementOf(element);
  if (!parent) {
    editorUI.setEditorNotice({ kind: 'refused', message: 'This element stands on its own, so it has nothing to give its text back to.' });
    return false;
  }
  const refusal = bareTextRefusal(parent.type);
  if (refusal) {
    editorUI.setEditorNotice({ kind: 'refused', message: refusal });
    return false;
  }
  const text = normaliseEditedText(el.textContent ?? '');
  const breakpointId = editorUI.selectedViewportNode?.breakpointId;
  flushSync(() => {
    // Before the element goes: its blur must not write the text a second time.
    editorUI.endTextEdit();
    parent.unwrapChild(element.id, text);
    editorUI.selectComponent(parent, breakpointId);
  });
  return true;
}

/**
 * Apply `format` to the words selected in the text being edited. The words
 * become their own element between what stands before and after them, and the
 * edit moves to that element with the same words selected, so a second press
 * takes the format off again. A link ends the edit and selects the new element,
 * whose Link section takes the target. A refusal is shown, never silent.
 * Returns true when the page changed.
 */
export function applyInlineFormat(editorUI: EditorUIType, format: InlineFormat): boolean {
  const run = editorUI.editingComponent as ComponentInstance | undefined;
  const el = editedElement(run);
  const element = run && ownerOfRun(run);
  if (!run || !el || !element) return false;
  const isRun = run !== element;
  if (!isRun && hasInlineFormat(element, format)) return removeFormat(editorUI, element, el);

  const refusal = inlineFormatRefusal(element, format);
  if (refusal) {
    editorUI.setEditorNotice({ kind: 'refused', message: refusal });
    return false;
  }
  const selected = selectionOffsets(el);
  if (!selected || selected.start === selected.end) return false;

  const host = isRun ? el.parentElement : el;
  const breakpointId = editorUI.selectedViewportNode?.breakpointId;
  const { tag, label, props } = FORMATS[format];
  let created: ComponentInstance | undefined;
  flushSync(() => {
    created = element.wrapTextRange(run.id, selected.text, selected.start, selected.end, { tag, label, props });
    if (!created) return;
    editorUI.selectComponent(created, breakpointId);
    // Before the old edit ends: its blur must not write the text a second time.
    if (format === 'link') editorUI.endTextEdit();
    else editorUI.beginTextEdit(created);
  });
  if (!created) return false;

  if (format === 'link') {
    // Selected, so typing a target replaces the placeholder.
    const target = document.querySelector<HTMLInputElement>('input[aria-label="Link target"]');
    target?.focus();
    target?.select();
    return true;
  }
  const next = host ? directChildWithId(host, created.id) : undefined;
  if (next) startInlineTextEdit(next, 'all');
  else editorUI.endTextEdit();
  return true;
}
