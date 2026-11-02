// Nodes to JSX and static JSX to nodes, as far as the round-trip test needs and no
// further: the real import and export are step 7 of the complete primitives plan.
// The normalised form is the plan's definition under "The round trip".
//
// `rules` is a named prop like any other, in its stored form. Import reads it through
// the one parser, with the state in reach, because a list that only travels as JSON
// would carry a refused rule through unchanged: what the parser refuses is left out
// of the node and reported line by line.

import ts from 'typescript';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { readBehaviourTree, type StateValue } from '@/lib/behaviour/format';
import { FORM_KIND_ATTR } from '@/lib/forms/definition';
import { isLegacyRulesAttribute, isRuleList, readRules, type RuleContext } from '@/lib/rules/rules';
import { STICKY_CTA_ATTR, STICKY_CTA_MARKER } from '@/lib/stickyCta/stickyCta';
import { TEXT_NODE_TYPE, isTextNodeType } from '@/lib/renderer/textNode';

/** A text node with a binding: bare text has nowhere to carry the bindings prop. */
const TEXT_RUN_TAG = 'TextRun';

/** The bindings prop on a JSX element: the plan's "explicit, named prop". */
const BINDINGS_PROP = 'bindings';

/** An island's own element: a submit button is a button, a form is a div. */
const ISLAND_HOST_PROP = 'as';

/** Runtime islands are named components; import maps the name back to the marker prop. */
const ISLANDS: Record<string, { attr: string; value: string }> = {
  Form: { attr: FORM_KIND_ATTR, value: 'form' },
  FormField: { attr: FORM_KIND_ATTR, value: 'form-field' },
  FormSubmit: { attr: FORM_KIND_ATTR, value: 'form-submit' },
  StickyCta: { attr: STICKY_CTA_ATTR, value: STICKY_CTA_MARKER },
  Collection: { attr: 'data-component-kind', value: 'collection' },
  RecordView: { attr: 'data-component-kind', value: 'record-view' },
  TableView: { attr: 'data-component-kind', value: 'table-view' },
  ProductList: { attr: 'data-component-kind', value: 'product-list' },
  ProductDetail: { attr: 'data-component-kind', value: 'product-detail' },
  VariantSelector: { attr: 'data-component-kind', value: 'variant-selector' },
  AddToCart: { attr: 'data-component-kind', value: 'add-to-cart' },
  CartView: { attr: 'data-component-kind', value: 'cart-view' },
  CheckoutButton: { attr: 'data-component-kind', value: 'checkout-button' },
};

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

export interface ImportResult {
  node?: ComponentNode;
  /** Everything not converted, by source text: reported, never dropped silently. */
  leftOver: string[];
  /** Text sat somewhere a node cannot hold it. */
}

/** A literal expression's value, or undefined with a note when it is a program. */
function literalValue(expr: ts.Expression, source: ts.SourceFile): { ok: true; value: unknown } | { ok: false } {
  if (ts.isStringLiteralLike(expr)) return { ok: true, value: expr.text };
  if (ts.isNumericLiteral(expr)) return { ok: true, value: Number(expr.text) };
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, value: true };
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, value: false };
  if (expr.kind === ts.SyntaxKind.NullKeyword) return { ok: true, value: null };
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken) {
    const inner = literalValue(expr.operand, source);
    return inner.ok ? { ok: true, value: -(inner.value as number) } : inner;
  }
  if (ts.isArrayLiteralExpression(expr)) {
    const values = expr.elements.map((e) => literalValue(e, source));
    if (values.some((v) => !v.ok)) return { ok: false };
    return { ok: true, value: values.map((v) => (v as { value: unknown }).value) };
  }
  if (ts.isObjectLiteralExpression(expr)) {
    const out: Record<string, unknown> = {};
    for (const prop of expr.properties) {
      if (!ts.isPropertyAssignment(prop)) return { ok: false };
      const key = ts.isIdentifier(prop.name) ? prop.name.text : ts.isStringLiteralLike(prop.name) ? prop.name.text : undefined;
      if (key === undefined) return { ok: false };
      const value = literalValue(prop.initializer, source);
      if (!value.ok) return { ok: false };
      // Plain assignment to `__proto__` would drop the key, and hide it from the parser.
      Object.defineProperty(out, key, { value: value.value, enumerable: true, writable: true, configurable: true });
    }
    return { ok: true, value: out };
  }
  return { ok: false };
}

/** JSX text as React reads it: lines trimmed, blank lines dropped, joined by a space. */
function jsxText(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const kept = lines
    .map((line, i) => {
      let text = line.replace(/\t/g, ' ');
      if (i > 0) text = text.replace(/^ +/, '');
      if (i < lines.length - 1) text = text.replace(/ +$/, '');
      return text;
    })
    .filter((line) => line.length > 0);
  return kept.join(' ');
}

/** The tree with ids from each node's place, which JSX does not carry and behaviour needs. */
export function withPlaceIds(node: ComponentNode, place = 'n'): ComponentNode {
  const children = node.children?.map((child, index) => withPlaceIds(child, `${place}-${index}`));
  return { ...node, id: place, ...(children ? { children } : {}) };
}

/** Leaves one node's `rules` as what a stylesheet could take, and reports the rest. */
function settleRules(node: ComponentNode, context: RuleContext, leftOver: string[]): void {
  const props = node.props as Record<string, unknown> | undefined;
  const stored = props?.rules;
  if (!props || stored === undefined) return;
  if (isTextNodeType(node.type)) {
    leftOver.push(`rules on a text node: ${JSON.stringify(stored).slice(0, 120)}`);
    delete props.rules;
    return;
  }
  if (isLegacyRulesAttribute(stored)) return;
  if (!isRuleList(stored)) {
    leftOver.push(`rules is neither a list nor a table attribute: ${JSON.stringify(stored).slice(0, 120)}`);
    delete props.rules;
    return;
  }
  const { refused } = readRules({ rules: stored }, context);
  if (refused.length === 0) return;
  for (const { index, rule, reason } of refused) {
    const id = (rule as { id?: unknown } | null)?.id;
    leftOver.push(`refused rule ${typeof id === 'string' ? id : `#${index}`}: ${reason}`);
  }
  const out = new Set(refused.map(({ index }) => index));
  const kept = stored.filter((_, index) => !out.has(index));
  if (kept.length > 0) props.rules = kept;
  else delete props.rules;
}

/** Every node's rules, against the state on its path, as the behaviour pass reads them. */
function settleTreeRules(root: ComponentNode, leftOver: string[]): void {
  const keyed = withPlaceIds(root);
  const { behaviours } = readBehaviourTree(keyed);
  const walk = (node: ComponentNode, copy: ComponentNode, outer: ReadonlyMap<string, StateValue>) => {
    const state = behaviours.get(copy)?.state;
    const states = state ? new Map([...outer, ...state.map((value): [string, StateValue] => [value.id, value])]) : outer;
    // A page with no behaviour never reaches that pass, so no state is in reach at all.
    settleRules(node, behaviours.size > 0 ? { states } : {}, leftOver);
    node.children?.forEach((child, index) => walk(child, (copy.children as ComponentNode[])[index], states));
  };
  walk(root, keyed, new Map());
}

export function jsxToNodes(jsx: string): ImportResult {
  const source = ts.createSourceFile('import.tsx', `const root = (${jsx});`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const leftOver: string[] = [];
  const textOf = (node: ts.Node) => node.getText(source).replace(/\s+/g, ' ').slice(0, 120);

  const convert = (element: ts.JsxElement | ts.JsxSelfClosingElement): ComponentNode | undefined => {
    const open = ts.isJsxElement(element) ? element.openingElement : element;
    const tag = open.tagName.getText(source);
    const island = ISLANDS[tag];
    const textRun = tag === TEXT_RUN_TAG;
    if (!island && !textRun && !/^[a-z]/.test(tag)) {
      leftOver.push(`unknown component <${tag}>`);
      return undefined;
    }
    const props: Record<string, unknown> = island ? { [island.attr]: island.value } : {};
    let bindings: ComponentNode['bindings'];
    let host = tag;
    for (const attribute of open.attributes.properties) {
      if (!ts.isJsxAttribute(attribute)) {
        leftOver.push(`spread props: ${textOf(attribute)}`);
        continue;
      }
      const name = attribute.name.getText(source);
      const init = attribute.initializer;
      let value: unknown = true;
      if (init && ts.isStringLiteral(init)) value = init.text;
      else if (init && ts.isJsxExpression(init) && init.expression) {
        const literal = literalValue(init.expression, source);
        if (!literal.ok) {
          leftOver.push(`dynamic prop ${textOf(attribute)}`);
          continue;
        }
        value = literal.value;
      }
      if (name === BINDINGS_PROP) bindings = value as ComponentNode['bindings'];
      else if (island && name === ISLAND_HOST_PROP) host = String(value);
      else props[name] = value;
    }

    // Text and elements in source order; which form a run takes is known at the end.
    const contents: Array<ComponentNode | string | number> = [];
    if (ts.isJsxElement(element)) {
      for (const child of element.children) {
        let text: string | number | undefined;
        if (ts.isJsxText(child)) {
          text = jsxText(child.text);
          if (text.length === 0) continue;
        } else if (ts.isJsxExpression(child)) {
          if (!child.expression) continue;
          const literal = literalValue(child.expression, source);
          if (!literal.ok || (typeof literal.value !== 'string' && typeof literal.value !== 'number')) {
            leftOver.push(`dynamic child ${textOf(child)}`);
            continue;
          }
          text = literal.value;
        } else if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
          const converted = convert(child);
          if (converted) contents.push(converted);
          continue;
        } else {
          leftOver.push(`unsupported child ${textOf(child)}`);
          continue;
        }
        contents.push(text);
      }
    }

    // A lone run is the element's own text; beside anything else each run is a text node.
    let children: ComponentNode[] = [];
    if (contents.length === 1 && typeof contents[0] !== 'object') props.children = contents[0];
    else {
      children = contents.map((item) =>
        typeof item === 'object' ? item : { type: TEXT_NODE_TYPE, props: { children: item } as ComponentNode['props'] },
      );
    }

    const node: ComponentNode = { type: textRun ? TEXT_NODE_TYPE : host, props: props as ComponentNode['props'] };
    if (bindings) node.bindings = bindings;
    if (children.length > 0) node.children = children;
    return node;
  };

  let root: ts.JsxElement | ts.JsxSelfClosingElement | undefined;
  const find = (node: ts.Node) => {
    if (!root && (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node))) root = node;
    if (!root) ts.forEachChild(node, find);
  };
  find(source);
  if (!root) return { leftOver: [`not JSX: ${jsx.slice(0, 80)}`] };

  // Only a bare element converts: `cond && <p />` or `items.map(...)` is a program.
  const statement = source.statements[0] as ts.VariableStatement;
  let init = statement.declarationList.declarations[0].initializer;
  while (init && ts.isParenthesizedExpression(init)) init = init.expression;
  if (init !== root) {
    return { leftOver: [`logic around the markup: ${textOf(init as ts.Node)}`] };
  }
  const node = convert(root);
  if (node) settleTreeRules(node, leftOver);
  return { node, leftOver };
}
