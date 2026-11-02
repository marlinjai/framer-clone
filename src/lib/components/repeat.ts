// src/lib/components/repeat.ts
//
// A node inside a component repeated once per item of a `list` or `gallery`
// input: it holds `props['data-repeat']: '<input id>'`, and each copy reads its
// item through an `item` frame (`{{item.label}}`, `{{item.src}}`). This runs in
// hydration, after the placement's input frame is pushed, because a value bound
// to data (`input.tags: {{row.tags}}`) has no items before then.
//
// - Each copy's `id` takes the item index, through the whole subtree, or items
//   would collide as React keys and a form in a list would be one form. Its
//   `classKey` stays the template's, so a hundred items share their CSS.
// - At most MAX_LIST_ITEMS copies; parseInputValue already refuses a longer list.
// - No items (an empty list, no value and no default, a value that did not parse)
//   is no copy at all: the node renders nothing.
// - An `item` binding into an address slot (`href`, `src`) stands only where the
//   item's field is an address type, as an `input` binding does.
//
// Contract: docs/plans/2026-11-02-reusable-components.md, "List and gallery".
//
// PURE: no React, no MST. Client and server safe.

import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { BindingsRecord } from '@/lib/bindings/types';
import { parseExpression } from '@/lib/bindings/resolver/expression';
import { MAX_LIST_ITEMS, mayBindToSlot, type InputDefinition, type InputType } from './inputs';

export const REPEAT_PROP = 'data-repeat';

/** The input a node repeats for, or undefined when it repeats for nothing. */
export function repeatInputId(props: unknown): string | undefined {
  const value = props && typeof props === 'object' ? (props as Record<string, unknown>)[REPEAT_PROP] : undefined;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Whether an input holds items a node can repeat for. */
export const isRepeatable = (input: Pick<InputDefinition, 'type'>): boolean => input.type === 'list' || input.type === 'gallery';

/** The node without its repeat marker, the same node when it has none. */
export function withoutRepeat(node: ComponentNode): ComponentNode {
  if (!node.props || !Object.hasOwn(node.props, REPEAT_PROP)) return node;
  const { [REPEAT_PROP]: _gone, ...props } = node.props as Record<string, unknown>;
  void _gone;
  return { ...node, props: props as ComponentNode['props'] };
}

/**
 * What an `item` path reads, as an input type: a gallery's item is an image, its
 * `src` an address and its `alt` text; a list's item path names one of its fields.
 * Undefined for a path no item has.
 */
export function itemPathType(input: InputDefinition, path: readonly string[]): InputType | undefined {
  const imagePart = (rest: readonly string[]): InputType | undefined =>
    rest.length === 0 ? 'image' : rest[0] === 'src' && rest.length === 1 ? 'image' : rest[0] === 'alt' && rest.length === 1 ? 'text' : undefined;
  if (input.type === 'gallery') return imagePart(path);
  if (input.type !== 'list' || path.length === 0) return undefined;
  const field = input.fields?.find(candidate => candidate.id === path[0]);
  if (!field) return undefined;
  return field.type === 'image' ? imagePart(path.slice(1)) : path.length === 1 ? field.type : undefined;
}

const itemPath = (entry: { mode?: string; expression?: string }): string[] | undefined => {
  if (entry.mode !== 'read' || typeof entry.expression !== 'string') return undefined;
  const path = parseExpression(entry.expression)?.path;
  return path?.[0] === 'item' ? path.slice(1) : undefined;
};

/**
 * The bindings of a node under a repeat, without an `item` binding into an address
 * slot that the item's field may not set. `warn` hears about each one left out.
 */
function itemBindingsAllowed(bindings: BindingsRecord, input: InputDefinition | undefined, warn: (message: string) => void): BindingsRecord {
  let changed = false;
  const kept: BindingsRecord = {};
  for (const [slot, entry] of Object.entries(bindings)) {
    const path = itemPath(entry);
    if (path) {
      const type = input ? itemPathType(input, path) : undefined;
      // A path no item has, or one outside any repeat, reads nothing: an address cannot come from it.
      if (!mayBindToSlot(type ?? 'text', slot)) {
        warn(`an item of "${input?.name ?? 'no list'}" cannot set the address ${slot}`);
        changed = true;
        continue;
      }
    }
    kept[slot] = entry;
  }
  return changed ? kept : bindings;
}

/**
 * A definition's tree with every `item` binding checked against the input of the
 * repeat it sits in. Run once per definition, where expansion prepares it.
 */
export function withItemBindingsChecked(
  tree: ComponentNode,
  inputs: readonly InputDefinition[],
  warn: (message: string) => void,
): ComponentNode {
  const walk = (node: ComponentNode, repeated: InputDefinition | undefined): ComponentNode => {
    const repeatId = repeatInputId(node.props);
    const input = repeatId ? inputs.find(candidate => candidate.id === repeatId && isRepeatable(candidate)) : repeated;
    const bindings = node.bindings ? itemBindingsAllowed(node.bindings, input, warn) : node.bindings;
    const children = node.children?.map(child => walk(child, input));
    const sameChildren = !children || children.every((child, i) => child === node.children?.[i]);
    if (bindings === node.bindings && sameChildren) return node;
    return { ...node, ...(bindings ? { bindings } : {}), ...(children ? { children } : {}) };
  };
  return walk(tree, undefined);
}

/** A subtree with every `id` taking the item index, the template's own as `classKey`. */
function itemCopy(node: ComponentNode, index: number): ComponentNode {
  return {
    ...node,
    ...(node.id ? { id: `${node.id}__${index}`, classKey: node.classKey ?? node.id } : {}),
    ...(node.children ? { children: node.children.map(child => itemCopy(child, index)) } : {}),
  };
}

/**
 * One copy of a repeated node per item, each with the item it shows. Nothing for a
 * value that is not a list of items.
 */
export function repeatedCopies(node: ComponentNode, items: unknown): { node: ComponentNode; item: unknown }[] {
  if (!Array.isArray(items)) return [];
  const template = withoutRepeat(node);
  return items.slice(0, MAX_LIST_ITEMS).map((item, index) => ({ node: itemCopy(template, index), item }));
}

/**
 * What an item offers a slot, as the binding picker lists it: each path of the
 * item this slot may take, with its label. An image gives its address to `src`
 * and its text to `alt`, as an image input does.
 */
export function itemChoicesFor(list: InputDefinition, slot: string): { label: string; expression: string }[] {
  const imageChoice = (label: string, base: string[]): { label: string; expression: string }[] => {
    const part = slot === 'src' ? 'src' : slot === 'alt' ? 'alt' : undefined;
    const path = part ? [...base, part] : [...base, 'src'];
    return mayBindToSlot(itemPathType(list, path.slice(1)) ?? 'text', slot) ? [{ label, expression: `{{${path.join('.')}}}` }] : [];
  };
  if (list.type === 'gallery') return imageChoice('Image', ['item']);
  return (list.fields ?? []).flatMap(field => {
    if (field.type === 'image') return imageChoice(field.name, ['item', field.id]);
    return mayBindToSlot(field.type, slot) ? [{ label: field.name, expression: `{{item.${field.id}}}` }] : [];
  });
}
