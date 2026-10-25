// src/lib/renderer/textContent.ts
//
// Which nodes hold editable text, one rule for every place that edits it:
// inline editing on the canvas (ComponentRenderer), the Text field at the
// top of the properties panel (TextContentSection) and the Data section.
//
// A node holds text when it has no child components and its `children` prop
// is a string (a heading, a paragraph, a button label). Anything with child
// components renders its own subtree, and turning it into a text box would
// lose those children. A node whose text is bound to data still holds text,
// but the text is the binding's: it is shown as the binding, never edited.
import type { ComponentInstance } from '@/models/ComponentModel';

/** True when the node's content is its own text (bound or not). */
export function holdsText(node: ComponentInstance): boolean {
  if (node.isViewportNode) return false;
  if (node.children.length > 0) return false;
  return typeof node.props?.children === 'string' || isTextBound(node);
}

/** True when the node's text comes from a data binding. */
export function isTextBound(node: ComponentInstance): boolean {
  return !!node.getBinding('children');
}

/** True when the node's text may be typed over (inline or in the Text field). */
export function isTextEditable(node: ComponentInstance): boolean {
  return holdsText(node) && !isTextBound(node);
}
