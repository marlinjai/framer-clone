// src/lib/renderer/textNode.ts
//
// A text node: a child with `type: '#text'` and its text in `props.children`.
// It emits no element, so `Hello <b>bold</b> world` is three children and the
// DOM is exactly that, with no wrapper around the text. One rule for every
// renderer, so this module stays free of React and of the model (the published
// renderer and the client islands import it too).
//
// Older rows may hold a string AND child nodes on one node. They are not
// migrated: every renderer shows the string first, then the children.

export const TEXT_NODE_TYPE = '#text';

/** True for a node that renders as bare text. */
export function isTextNodeType(type: unknown): boolean {
  return type === TEXT_NODE_TYPE;
}

let warnedUnrenderable = false;

/**
 * Text as React renders it: strings exactly as stored ("Hello " keeps its
 * space) and numbers, zero included. Nothing is null; anything else stored
 * here cannot render, so it is reported once rather than dropped in silence.
 */
export function renderableText(value: unknown): string | number | null {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (value !== undefined && value !== null && !warnedUnrenderable) {
    warnedUnrenderable = true;
    console.warn(`[renderer] stored text is a ${typeof value}, not text: it renders nothing`);
  }
  return null;
}

/**
 * What an element contains: its own text, then its children. Without children
 * the text goes through as it is; with them, a legacy string stays in front.
 */
export function ownTextThenChildren<T>(text: unknown, children: readonly T[]): unknown {
  if (children.length === 0) return text;
  const own = renderableText(text);
  return own === null || own === '' ? children : [own, ...children];
}
