// src/lib/behaviour/dom.ts
//
// How the browser side of behaviour reads an element, whatever the element holds. A
// `form` answers `form.parentElement` with a field whose `name` or `id` is
// `parentElement`, and that field's parent is the form, so a walk up the tree written
// the plain way never ends. No `guarded` catches a loop and no budget is reached: one
// stored field hung the tab for good. The render gate drops such a `name`, and leaves
// such an `id` open, because a member's name is an ordinary `id`. So every read the
// runtime makes of a stored element comes from the prototypes, taken here before any
// stored content can matter.
//
// Only the runtime's chunks import this: it reads `Node` as it loads, so a server never can.

/** A prototype's method as a plain function of the element, out of reach of what the element holds. */
const held = <A extends unknown[], R>(method: (...args: A) => R): ((el: unknown, ...args: A) => R) =>
  Function.prototype.call.bind(method) as unknown as (el: unknown, ...args: A) => R;
const read = <R>(owner: object, name: string): ((el: unknown) => R) =>
  held(Object.getOwnPropertyDescriptor(owner, name)?.get as () => R);

const E = Element.prototype;
const N = Node.prototype;

export const parentOf = read<Element | null>(N, 'parentElement') as (el: Node) => Element | null;
const typeOf = read<number>(N, 'nodeType');
export const isConnected = read<boolean>(N, 'isConnected') as (el: Element) => boolean;
export const childrenOf = read<HTMLCollection>(E, 'children') as (el: Element) => HTMLCollection;
export const isElement = (node: unknown): node is Element => !!node && typeOf(node) === 1;
export const closestTo = held(E.closest) as (el: Element, selector: string) => Element | null;
export const attrOf = held(E.getAttribute) as (el: Element, name: string) => string | null;
export const hasAttr = held(E.hasAttribute) as (el: Element, name: string) => boolean;
export const isMatch = held(E.matches) as (el: Element, selector: string) => boolean;
export const setAttr = held(E.setAttribute) as (el: Element, name: string, value: string) => void;
export const toggleAttr = held(E.toggleAttribute) as (el: Element, name: string, on: boolean) => boolean;
export const holds = held(N.contains) as (root: Node, node: Node) => boolean;
export const one = held(E.querySelector) as (root: Element, selector: string) => Element | null;
const all = held(E.querySelectorAll) as (root: Element, selector: string) => NodeListOf<HTMLElement>;
export const every = (root: Element, selector: string): HTMLElement[] => [...all(root, selector)];

/** Each ancestor from `el` itself up to the top of the document. */
export function* upFrom(el: Element | null): Generator<Element> {
  for (let at = el; at; at = parentOf(at)) yield at;
}
