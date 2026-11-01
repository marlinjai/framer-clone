// src/lib/renderer/textContent.ts
//
// Which nodes hold editable text, one rule for every place that edits it:
// inline editing on the canvas (ComponentRenderer), the Text field at the
// top of the properties panel (TextContentSection) and the Data section.
//
// A node holds text when its `children` prop is a string (a heading, a
// paragraph, a button label) or bound to data. Text mixed with elements lives in
// text nodes among the children (src/lib/renderer/textNode.ts): the Text field
// lists those too, so the text of a mixed paragraph is editable without touching
// its elements. Inline editing stays stricter (ComponentRenderer): it needs no
// child at all, because it reads the element's whole textContent back. A node
// whose text is bound to data still holds text, but the text is the binding's:
// it is shown as the binding, never edited.
import type { ComponentInstance } from '@/models/ComponentModel';
import { isTextNodeType } from './textNode';

/** True when the node has text of its own (bound or not). */
export function holdsText(node: ComponentInstance): boolean {
  if (node.isViewportNode) return false;
  return typeof node.props?.children === 'string' || isTextBound(node);
}

/** True when the node's text comes from a data binding. */
export function isTextBound(node: ComponentInstance): boolean {
  return !!node.getBinding('children');
}

/** True when the node's text may be typed over in the Text field. */
export function isTextEditable(node: ComponentInstance): boolean {
  return holdsText(node) && !isTextBound(node);
}

const EXCERPT_CHARS = 24;

/** The start of a text, cut at a word where one ends close by, or undefined when there is none. */
function excerptOf(value: unknown): string | undefined {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).replace(/\s+/g, ' ').trim() : '';
  if (!text) return undefined;
  if (text.length <= EXCERPT_CHARS) return text;
  const cut = text.slice(0, EXCERPT_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${space > EXCERPT_CHARS / 2 ? cut.slice(0, space) : cut}...`;
}

/** A neighbour as a person would point at it: its words, or what it is. */
function neighbourName(node: ComponentInstance): string {
  const words = excerptOf(node.props?.children);
  return words ? `"${words}"` : node.displayName;
}

/**
 * What a text run is called in the panel: a short excerpt and the elements on
 * either side, so `Hello <b>bold</b> world` reads as two different fields. A
 * run bound to data shows no stored text, an empty one has none.
 */
export function textRunLabel(element: ComponentInstance, run: ComponentInstance): string {
  const siblings = element.children as ComponentInstance[];
  const at = run === element ? -1 : siblings.indexOf(run);
  const before = siblings.slice(0, Math.max(at, 0)).reverse().find(child => !isTextNodeType(child.type));
  const after = siblings.slice(at + 1).find(child => !isTextNodeType(child.type));
  const words = excerptOf(run.props?.children);
  const name = isTextBound(run) ? 'Text from data' : words ? `"${words}"` : 'Empty text';
  const beside =
    before && after
      ? `between ${neighbourName(before)} and ${neighbourName(after)}`
      : after
        ? `before ${neighbourName(after)}`
        : before
          ? `after ${neighbourName(before)}`
          : '';
  const hidden = run !== element && !run.canvasVisible ? ', hidden' : '';
  return `${name}${beside ? ` ${beside}` : ''}${hidden}`;
}

/** Every node whose text belongs to this element, in page order: its own, then its text nodes. */
export function textNodesOf(node: ComponentInstance): ComponentInstance[] {
  const runs = (node.children as ComponentInstance[]).filter(child => isTextNodeType(child.type));
  return holdsText(node) ? [node, ...runs] : runs;
}
