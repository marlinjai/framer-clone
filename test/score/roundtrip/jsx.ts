// Nodes to JSX, and the normal form two trees are compared in, as far as the round-trip
// test needs and no further. The parser back to nodes moved to `src/lib/reactImport/jsx.ts`,
// the importer's home, and the real export is step 7 of the complete primitives plan.
// The normalised form is the plan's definition under "The round trip".
//
// `rules` is a named prop like any other, in its stored form. Import reads it through
// the one parser, with the state in reach, because a list that only travels as JSON
// would carry a refused rule through unchanged: what the parser refuses is left out
// of the node and reported line by line.

import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { FORM_KIND_ATTR } from '@/lib/forms/definition';
import { BINDINGS_PROP, ISLANDS, ISLAND_HOST_PROP, TEXT_RUN_TAG } from '@/lib/reactImport/jsx';
import { STICKY_CTA_ATTR } from '@/lib/stickyCta/stickyCta';
import { TEXT_NODE_TYPE, isTextNodeType } from '@/lib/renderer/textNode';

export { jsxToNodes, withPlaceIds } from '@/lib/reactImport/jsx';

export interface NormalNode {
  type: string;
  props: Record<string, unknown>;
  text?: string | number;
  bindings?: unknown;
  children: NormalNode[];
}

/** Declaration order is meaning, a later longhand beats a shorthand, so a `style` keeps its own. */
function sortKeys(value: unknown, keepOrder = false): unknown {
  if (Array.isArray(value)) return value.map((item) => sortKeys(item));
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as object);
    return Object.fromEntries(
      (keepOrder ? keys : keys.sort()).map((key) => [key, sortKeys((value as Record<string, unknown>)[key], key === 'style')]),
    );
  }
  return value;
}

function simplify(node: ComponentNode): NormalNode {
  const { children: text, ...props } = (node.props ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'function') throw new Error(`prop ${key} is a function: no JSX form`);
  }
  const out: NormalNode = {
    type: node.type,
    props: JSON.parse(JSON.stringify(props)) as Record<string, unknown>,
    children: (node.children ?? []).map(simplify),
  };
  if (typeof text === 'string' || typeof text === 'number') {
    // A string in front of child nodes renders as a leading text node, so it is one.
    if (out.children.length > 0) out.children.unshift({ type: TEXT_NODE_TYPE, props: {}, text, children: [] });
    else out.text = text;
  }
  // And a lone plain text node renders as the element's own text.
  const only = out.children.length === 1 ? out.children[0] : undefined;
  if (only && isTextNodeType(only.type) && only.text !== undefined && !only.bindings && Object.keys(only.props).length === 0) {
    out.children = [];
    out.text = only.text;
  }
  if (node.bindings && Object.keys(node.bindings).length > 0) out.bindings = node.bindings;
  return out;
}

/** The form two trees are compared in: no ids, keys in one order. A ComponentNode holds no canvas bookkeeping. */
export function normalise(node: ComponentNode): NormalNode {
  return sortKeys(simplify(node)) as NormalNode;
}

function attributeText(name: string, value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string' && !/["&<>{}\n]/.test(value)) return ` ${name}="${value}"`;
  return ` ${name}={${JSON.stringify(value)}}`;
}

/** A text node is an expression among its siblings; a bound one needs a tag to carry the binding. */
function renderTextNode(n: NormalNode): string {
  const extra = Object.keys(n.props);
  if (extra.length > 0 || n.children.length > 0) throw new Error(`a text node holds only text, not ${extra.join(', ') || 'children'}`);
  const text = n.text === undefined ? '' : `{${JSON.stringify(n.text)}}`;
  if (n.bindings === undefined) return text || '{""}';
  const bindings = attributeText(BINDINGS_PROP, n.bindings);
  return text ? `<${TEXT_RUN_TAG}${bindings}>${text}</${TEXT_RUN_TAG}>` : `<${TEXT_RUN_TAG}${bindings} />`;
}

/** Total over the normalised form: a node with no JSX representation throws. */
export function nodesToJsx(node: ComponentNode): string {
  const render = (n: NormalNode): string => {
    if (isTextNodeType(n.type)) return renderTextNode(n);
    const island = Object.entries(ISLANDS).find(([, { attr, value }]) => n.props[attr] === value);
    const name = island ? island[0] : n.type;
    if (!island && !/^[a-z][a-zA-Z0-9-]*$/.test(name)) throw new Error(`type ${JSON.stringify(name)} is not a JSX tag`);
    // An island we do not know must never flatten to plain markup.
    for (const marker of ['data-component-kind', FORM_KIND_ATTR, STICKY_CTA_ATTR]) {
      if (!island && n.props[marker] !== undefined) throw new Error(`unknown island ${marker}=${String(n.props[marker])}`);
    }
    const attrs = Object.entries(n.props)
      .filter(([key]) => !(island && key === island[1].attr))
      .map(([key, value]) => {
        if (key === BINDINGS_PROP) throw new Error('a stored prop named bindings clashes with the bindings prop');
        return attributeText(key, value);
      })
      .join('');
    const host = island ? attributeText(ISLAND_HOST_PROP, n.type) : '';
    const bindings = n.bindings === undefined ? '' : attributeText(BINDINGS_PROP, n.bindings);
    const text = n.text === undefined ? '' : `{${JSON.stringify(n.text)}}`;
    const children = n.children.map(render).join('');
    if (!text && !children) return `<${name}${host}${attrs}${bindings} />`;
    return `<${name}${host}${attrs}${bindings}>${text}${children}</${name}>`;
  };
  return render(simplify(node));
}
