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

/** Every node whose text belongs to this element, in page order: its own, then its text nodes. */
export function textNodesOf(node: ComponentInstance): ComponentInstance[] {
  const runs = (node.children as ComponentInstance[]).filter(child => isTextNodeType(child.type));
  return holdsText(node) ? [node, ...runs] : runs;
}
