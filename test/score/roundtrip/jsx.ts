// Nodes to JSX and static JSX to nodes, as far as the round-trip test needs and no
// further: the real import and export are step 7 of the complete primitives plan.
// The normalised form is the plan's definition under "The round trip".

import ts from 'typescript';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { FORM_KIND_ATTR } from '@/lib/forms/definition';
import { STICKY_CTA_ATTR, STICKY_CTA_MARKER } from '@/lib/stickyCta/stickyCta';

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

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
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
  if (typeof text === 'string' || typeof text === 'number') out.text = text;
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

/** Total over the normalised form: a node with no JSX representation throws. */
export function nodesToJsx(node: ComponentNode): string {
  const render = (n: NormalNode): string => {
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
  mixedText: boolean;
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
      out[key] = value.value;
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

export function jsxToNodes(jsx: string): ImportResult {
  const source = ts.createSourceFile('import.tsx', `const root = (${jsx});`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const leftOver: string[] = [];
  let mixedText = false;
  const textOf = (node: ts.Node) => node.getText(source).replace(/\s+/g, ' ').slice(0, 120);

  const convert = (element: ts.JsxElement | ts.JsxSelfClosingElement): ComponentNode | undefined => {
    const open = ts.isJsxElement(element) ? element.openingElement : element;
    const tag = open.tagName.getText(source);
    const island = ISLANDS[tag];
    if (!island && !/^[a-z]/.test(tag)) {
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

    const children: ComponentNode[] = [];
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
          if (converted) children.push(converted);
          continue;
        } else {
          leftOver.push(`unsupported child ${textOf(child)}`);
          continue;
        }
        // A node holds one leading string; text after an element has no slot.
        if (children.length > 0 || props.children !== undefined) {
          mixedText = true;
          leftOver.push(`text with no place in a node: ${JSON.stringify(text)}`);
        } else props.children = text;
      }
    }

    const node: ComponentNode = { type: host, props: props as ComponentNode['props'] };
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
  if (!root) return { leftOver: [`not JSX: ${jsx.slice(0, 80)}`], mixedText };

  // Only a bare element converts: `cond && <p />` or `items.map(...)` is a program.
  const statement = source.statements[0] as ts.VariableStatement;
  let init = statement.declarationList.declarations[0].initializer;
  while (init && ts.isParenthesizedExpression(init)) init = init.expression;
  if (init !== root) {
    return { leftOver: [`logic around the markup: ${textOf(init as ts.Node)}`], mixedText };
  }
  return { node: convert(root), leftOver, mixedText };
}
