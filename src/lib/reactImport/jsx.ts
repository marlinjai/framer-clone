// Layer 1, static JSX to nodes. It reads a file as what it is, a source from a
// stranger. A tag or attribute goes through the render gate's own functions, because
// otherwise the gate would drop it at render time with nobody told, and an attribute
// that means something to the platform is refused, since a source may not set it. What
// it cannot read is a line. Classes wait for layer 2, props for layer 3, handlers for
// layer 4 and loops for layer 5.
//
// The contract is docs/plans/2026-11-02-react-import.md, "Layer 1: static JSX".

import ts from 'typescript';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { isDroppedProp, isBlockedTag, safeInlineStyle, withoutDocumentId } from '@/lib/renderer/blockedNodes';
import { isRenderedAttribute } from '@/lib/renderer/renderVocabulary';
import { TEXT_NODE_TYPE, refusesBareText } from '@/lib/renderer/textNode';
import { isVoidTag } from '@/lib/drag/voidTags';
import { scanCssValue } from '@/lib/responsive/responsiveCss';
import type { ParsedFile } from './atoms';
import type { ImportBudget } from './budget';
import type { Claim, Ledger } from './ledger';
import type { DetailKey, LineKind } from './report';
import { UNKNOWN, createEvaluator, fileScope, functionScope, holdsEffect, toPlain, type Evaluated, type Evaluator, type Scope } from './staticEval';

/**
 * Attributes the code reads as instructions. An island's marker turns a `div` into a form, and an editor
 * mark makes a node the target of a click. The names outside these families are the ones
 * `platformAttributes.test.ts` finds read in `src`, so a new one fails there until it is judged here.
 */
const PLATFORM_FAMILY = /^data-(?:fc|fcs|fx|u|island|component|inner-component|form|sticky|repeat|ground|viewport|breakpoint|floating-root|preview|editor|camera|lenis)(?:-|$)/i;
const PLATFORM_NAMES: ReadonlySet<string> = new Set([
  'data-add-line', 'data-discard-row', 'data-drag-handle', 'data-escape-local', 'data-focus-key', 'data-haptics', 'data-import-all',
  'data-import-row', 'data-layer-breakpoint', 'data-layer-row', 'data-logo-choose', 'data-menu-item', 'data-notice-action',
  'data-outline-select', 'data-page-overlay', 'data-page-settings-button', 'data-pan-cursor', 'data-placement', 'data-pointer',
  'data-radius-corner', 'data-resize-direction', 'data-resume-offer', 'data-shown', 'data-spacing-band', 'data-spacing-handle',
]);

export const isPlatformAttribute = (name: string): boolean => PLATFORM_FAMILY.test(name) || PLATFORM_NAMES.has(name.toLowerCase());

/**
 * The names this layer decides on, each with its one spelling. The render gate lower-cases a name and HTML
 * reads one in any case, so `ACTION` or `ID` would pass every comparison here and still act on a page. Any
 * other spelling is refused. A stored name is never lower-cased, because SVG needs `viewBox`.
 */
const KEYED_NAMES: ReadonlyMap<string, string> = new Map([
  ['style', 'style'], ['id', 'id'], ['class', 'class'], ['classname', 'className'], ['children', 'children'], ['key', 'key'], ['ref', 'ref'], ['action', 'action'],
]);

/** Attributes that make a form of any element, or join one from anywhere. */
const FORM_LOGIC_NAMES: ReadonlySet<string> = new Set(['formaction', 'formmethod', 'formtarget', 'formenctype', 'form']);

/** The name is the tag, and only a plain one can be: `a:b` and `a.b` are not elements. */
const PLAIN_TAG = /^[a-z][a-zA-Z0-9-]*$/;

/** A loop, because a pattern anchored at the end retries from every space, and a line of them is quadratic. */
function withoutTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === ' ') end -= 1;
  return line.slice(0, end);
}

/** JSX text as React reads it: lines trimmed, blank lines dropped, joined by a space. */
function jsxText(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const kept = lines
    .map((line, i) => {
      let text = line.replace(/\t/g, ' ');
      if (i > 0) text = text.replace(/^ +/, '');
      if (i < lines.length - 1) text = withoutTrailingSpaces(text);
      return text;
    })
    .filter((line) => line.length > 0);
  return kept.join(' ');
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '\u00a9', reg: '\u00ae', trade: '\u2122',
  hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  laquo: '\u00ab', raquo: '\u00bb', bull: '\u2022', middot: '\u00b7', times: '\u00d7', euro: '\u20ac', deg: '\u00b0',
};

/** JSX decodes character references and the parser leaves them raw. Undefined for a name not in the table. */
function decodeEntities(text: string): string | undefined {
  let unknown = false;
  const decoded = text.replace(/&(#\d+|#x[\da-f]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = /^#x/i.test(body) ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (Object.hasOwn(NAMED_ENTITIES, body)) return NAMED_ENTITIES[body];
    unknown = true;
    return whole;
  });
  return unknown ? undefined : decoded;
}

/** The address without what a browser ignores in front of it. */
function withoutLeadingControls(address: string): string {
  let start = 0;
  while (start < address.length && (address.charCodeAt(start) <= 32 || address.charCodeAt(start) === 127)) start += 1;
  return address.slice(start);
}

/** Whether an address reaches another host: a scheme, or two slashes of either kind. A data address is here already. */
const hasHost = (address: string): boolean => /^(?:[/\\]{2}|(?!data:)[a-z][a-z0-9+.-]*:)/i.test(withoutLeadingControls(address));

/** Attributes whose address the browser fetches with no click. `href` on an `a` only goes anywhere on one. */
function fetchesElsewhere(name: string, tag: string, value: string): boolean {
  if (name === 'srcset') return value.split(/[\s,]+/).some(hasHost);
  if (name === 'src' || name === 'poster' || name === 'data') return hasHost(value);
  return (name === 'href' || name === 'xlinkhref') && (tag === 'use' || tag === 'image') && hasHost(value);
}

/**
 * Whether `scanCssValue`, which must not meet them, would misread this text: a backslash outside a
 * string, which is how `url(` is spelled without the letters, or a raw newline inside one.
 */
function hidesFromScan(text: string): boolean {
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === '\n' || ch === '\r' || ch === '\f') return true;
      else if (ch === quote) quote = '';
    } else if (ch === '\\') return true;
    else if (ch === '"' || ch === "'") quote = ch;
  }
  return false;
}

/** A value that loads a file from elsewhere. Allowed by the format, and a visitor's address reaches a third party. */
function loadsElsewhere(text: string): boolean {
  const { indirect, urls, strings } = scanCssValue(text);
  return indirect || urls.some(hasHost) || text.includes('://') || strings.some((each) => each.includes('://') || each.startsWith('//'));
}

type Markup = ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment;
type ComponentFunction = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
type Content = ComponentNode | string | number;

const isMarkup = (node: ts.Node): node is Markup => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
const isFunctionValue = (node: ts.Node | undefined): node is ts.ArrowFunction | ts.FunctionExpression =>
  node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));

/** Parentheses and type assertions change no value: the expression inside, and the wrappers to claim. */
function unwrap(expression: ts.Expression): { inner: ts.Expression; wrappers: ts.Node[] } {
  const wrappers: ts.Node[] = [];
  let inner = expression;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isSatisfiesExpression(inner) || ts.isNonNullExpression(inner)) {
    wrappers.push(inner);
    inner = inner.expression;
  }
  return { inner, wrappers };
}

interface LayerContext {
  file: ParsedFile;
  ledger: Ledger;
  budget: ImportBudget;
  evaluator: Evaluator;
  /** Constants already claimed: a table read by every attribute is walked once. */
  claimedReads: Set<ts.VariableDeclaration>;
}

/** Where a piece of markup stands: its node key, its scope, and what the element around it decides. */
interface Place {
  key: string;
  scope: Scope;
  insideSvg: boolean;
  parentTag: string;
  /** Elements above this one, in the output: inlining multiplies what the source's own depth allows. */
  depth: number;
}

const childKey = (parent: string, index: number) => `${parent}-${index}`;

/** One attribute's reading: a result to keep, or the line that says why not. */
type AttributeResult = { store?: { name: string; value: unknown }; claim: Claim; reads?: ReadonlySet<ts.VariableDeclaration> };

function left(kind: LineKind, detail: DetailKey, nodeKey: string): Claim {
  return { kind, disposition: 'left', detail, nodeKey, next: ['accept', 'rewrite'] };
}

const converted = (kind: LineKind, detail: DetailKey, nodeKey: string): Claim => ({ kind, disposition: 'converted', detail, nodeKey });

function readStyle(value: Evaluated, key: string): Pick<AttributeResult, 'store' | 'claim'> {
  if (value === UNKNOWN) return { claim: left('attribute', 'dynamicAttribute', key) };
  if (value === null || value === undefined) return { claim: converted('attribute', 'emptyValue', key) };
  const style = toPlain(value);
  if (typeof style !== 'object' || style === null || Array.isArray(style)) return { claim: left('refused-attribute', 'refusedStyle', key) };
  const declarations = style as Record<string, unknown>;
  const texts = Object.values(declarations).filter((text): text is string => typeof text === 'string');
  if (safeInlineStyle(declarations) !== declarations || texts.some(hidesFromScan)) return { claim: left('refused-attribute', 'refusedStyle', key) };
  const external = texts.some(loadsElsewhere);
  return {
    store: { name: 'style', value: declarations },
    claim: external
      ? { kind: 'external-address', disposition: 'adapted', detail: 'styleExternal', nodeKey: key, next: ['accept'] }
      : converted('attribute', 'style', key),
  };
}

function readAttribute({ evaluator, budget }: LayerContext, attribute: ts.JsxAttribute, tag: string, key: string, scope: Scope): AttributeResult {
  if (!ts.isIdentifier(attribute.name)) return { claim: left('refused-attribute', 'refusedAttribute', key) };
  const name = attribute.name.text;
  const lower = name.toLowerCase();
  // Not a value, but a line each: an element with a million attributes costs what it says.
  budget.chargeEvaluated(name.length + 64);
  const keyed = KEYED_NAMES.get(lower);
  if (keyed !== undefined && keyed !== name) return { claim: left('refused-attribute', 'refusedAttribute', key) };
  if (name === 'key') return { claim: converted('attribute', 'key', key) };
  if (name === 'ref') return { claim: left('attribute', 'ref', key) };
  if (name === 'className' || name === 'class') return { claim: left('class', 'classPending', key) };
  if (/^on[A-Z]/.test(name)) return { claim: left('handler', 'handler', key) };
  if (name === 'children') return { claim: left('attribute', 'childrenAttribute', key) };
  if (isPlatformAttribute(name)) return { claim: left('refused-attribute', 'platformAttribute', key) };
  // By name, before the value is read: a dynamic `dangerouslySetInnerHTML` is refused, not "dynamic".
  if (name === 'dangerouslySetInnerHTML' || (name !== 'style' && !isRenderedAttribute(lower))) return { claim: left('refused-attribute', 'refusedAttribute', key) };

  const init = attribute.initializer;
  let value: Evaluated = true;
  let reads: ReadonlySet<ts.VariableDeclaration> | undefined;
  if (init && ts.isStringLiteral(init)) {
    value = decodeEntities(init.text) ?? UNKNOWN;
    if (value === UNKNOWN) return { claim: left('attribute', 'entity', key) };
  } else if (init && ts.isJsxExpression(init) && init.expression) {
    ({ value, reads } = evaluator.evaluate(init.expression, scope));
  } else if (init) {
    return { claim: left('attribute', 'dynamicAttribute', key) };
  }

  // Paid per write. The constant was paid for once, and 4,900 attributes write it out 4,900 times.
  if (value !== UNKNOWN) budget.chargeEvaluated(evaluator.sizeOf(value));
  if (name === 'style') return { ...readStyle(value, key), reads };
  if (value === UNKNOWN) return { claim: left('attribute', 'dynamicAttribute', key) };
  if (value === null || value === undefined) return { claim: converted('attribute', 'emptyValue', key), reads };
  const stored = toPlain(value);
  if (isDroppedProp(name, stored)) return { claim: left('refused-attribute', 'refusedAttribute', key) };
  if (name === 'id' && withoutDocumentId(tag, { id: stored }).id === undefined) return { claim: left('refused-attribute', 'refusedAttribute', key) };
  const external = typeof stored === 'string' && fetchesElsewhere(lower, tag.toLowerCase(), stored);
  return {
    store: { name, value: stored },
    claim: external ? { kind: 'external-address', disposition: 'adapted', detail: 'attributeExternal', nodeKey: key, next: ['accept'] } : converted('attribute', 'attribute', key),
    reads,
  };
}

function claimReads({ file, ledger, claimedReads }: LayerContext, reads: ReadonlySet<ts.VariableDeclaration> | undefined): void {
  for (const declaration of reads ?? []) {
    if (claimedReads.has(declaration)) continue;
    claimedReads.add(declaration);
    ledger.claimSubtree(file.source, declaration, { kind: 'statement', disposition: 'converted', detail: 'constant', invisible: true });
  }
}

function convertAttributes(context: LayerContext, open: ts.JsxOpeningLikeElement, tag: string, key: string, scope: Scope): Record<string, unknown> {
  const { file, ledger } = context;
  const props: Record<string, unknown> = {};
  for (const attribute of open.attributes.properties) {
    if (!ts.isJsxAttribute(attribute)) {
      ledger.claimSubtree(file.source, attribute, left('spread', 'spread', key));
      continue;
    }
    const { store, claim, reads } = readAttribute(context, attribute, tag, key, scope);
    ledger.claimSubtree(file.source, attribute, claim);
    if (store) {
      claimReads(context, reads);
      props[store.name] = store.value;
    }
  }
  return props;
}

/** A form works through its island, so one with logic of its own, on it or on a control, is not the form it looks like. */
function isFormWithLogic(tag: string, open: ts.JsxOpeningLikeElement): boolean {
  const isForm = tag.toLowerCase() === 'form';
  return open.attributes.properties.some((attribute) => {
    if (ts.isJsxSpreadAttribute(attribute)) return isForm;
    if (!ts.isIdentifier(attribute.name)) return false;
    const lower = attribute.name.text.toLowerCase();
    return FORM_LOGIC_NAMES.has(lower) || (isForm && (lower === 'action' || lower.startsWith('on')));
  });
}

function pushText(context: LayerContext, node: ts.Node, text: string | number, { key, parentTag }: Place, out: Content[]): void {
  const { file, ledger, budget } = context;
  if (refusesBareText(parentTag)) {
    ledger.claimSubtree(file.source, node, left('expression', 'bareText', key));
    return;
  }
  budget.chargeEvaluated(String(text).length);
  ledger.claimSubtree(file.source, node, converted('expression', 'text', key));
  out.push(text);
}

/** What one child expression renders, in the order React would render it. */
function convertExpressionChild(context: LayerContext, child: ts.JsxExpression, place: Place, out: Content[]): void {
  const { file, ledger, evaluator } = context;
  const { key, scope } = place;
  if (!child.expression) {
    ledger.claimSubtree(file.source, child, { kind: 'expression', disposition: 'converted', detail: 'emptyValue', nodeKey: key });
    return;
  }
  const { inner, wrappers } = unwrap(child.expression);
  if (isMarkup(inner)) {
    ledger.claim(file.source, [child, ...wrappers], converted('expression', 'fragment', key));
    convertMarkup(context, inner, { ...place, key: childKey(key, out.length) }, out);
    return;
  }
  const { value, reads } = evaluator.evaluate(child.expression, scope);
  if (typeof value === 'string' || typeof value === 'number') {
    claimReads(context, reads);
    pushText(context, child, value, place, out);
  } else if (value === null || value === undefined || typeof value === 'boolean') {
    claimReads(context, reads);
    ledger.claimSubtree(file.source, child, converted('expression', 'emptyValue', key));
  } else {
    ledger.claimSubtree(file.source, child, left('expression', 'dynamicChild', key));
  }
}

function convertChildren(context: LayerContext, children: readonly ts.JsxChild[], place: Place, out: Content[]): void {
  const { file, ledger } = context;
  const { key } = place;
  for (const child of children) {
    if (ts.isJsxText(child)) {
      if (child.containsOnlyTriviaWhiteSpaces) continue;
      const text = decodeEntities(jsxText(child.text));
      if (text === undefined) ledger.claim(file.source, [child], left('expression', 'entity', key));
      else if (text.length > 0) pushText(context, child, text, place, out);
      else ledger.claim(file.source, [child], converted('expression', 'emptyValue', key));
    } else if (ts.isJsxExpression(child)) {
      convertExpressionChild(context, child, place, out);
    } else {
      convertMarkup(context, child, { ...place, key: childKey(key, out.length) }, out);
    }
  }
}

/** A lone run is the element's own text; beside anything else each run is a text node. */
function settleContents(context: LayerContext, node: ComponentNode, contents: Content[], key: string): void {
  if (contents.length === 0) return;
  if (contents.length === 1 && typeof contents[0] !== 'object') {
    (node.props as Record<string, unknown>).children = contents[0];
    return;
  }
  context.budget.chargeNodes(contents.filter((item) => typeof item !== 'object').length);
  node.children = contents.map((item, index) =>
    typeof item === 'object' ? item : { id: childKey(key, index), type: TEXT_NODE_TYPE, props: { children: item } as ComponentNode['props'] });
}

function convertElement(context: LayerContext, element: ts.JsxElement | ts.JsxSelfClosingElement, tag: string, place: Place, out: Content[]): void {
  const { file, ledger, budget } = context;
  const { key, scope, insideSvg, depth } = place;
  budget.checkOutputDepth(depth);
  budget.chargeNodes(1);
  const open = ts.isJsxElement(element) ? element.openingElement : element;
  if (!PLAIN_TAG.test(tag) || isBlockedTag(tag, insideSvg)) {
    ledger.claimSubtree(file.source, element, left('refused-tag', 'refusedTag', key));
    return;
  }
  if (isFormWithLogic(tag, open)) {
    ledger.claimSubtree(file.source, element, left('element', 'form', key));
    return;
  }
  ledger.claim(file.source, [element, open.tagName], converted('element', 'element', key));
  const props = convertAttributes(context, open, tag, key, scope);
  const node: ComponentNode = { id: key, type: tag, props: props as ComponentNode['props'] };
  const contents: Content[] = [];
  if (ts.isJsxElement(element)) {
    if (isVoidTag(tag)) {
      // A void element renders no content, so what the source put there goes nowhere.
      for (const child of element.children) ledger.claimSubtree(file.source, child, left('expression', 'voidChildren', key));
    } else {
      const lower = tag.toLowerCase();
      const inner = { key, scope, insideSvg: lower !== 'foreignobject' && (insideSvg || lower === 'svg'), parentTag: tag, depth: depth + 1 };
      convertChildren(context, element.children, inner, contents);
    }
  }
  settleContents(context, node, contents, key);
  out.push(node);
}

/** The function a component tag names, when it is one declared here. */
function localFunction(name: string, scope: Scope): { fn: ComponentFunction; scope: Scope } | undefined {
  const binding = scope.lookup(name);
  if (binding?.kind === 'function') return { fn: binding.declaration, scope: binding.scope };
  if (binding?.kind === 'const' && isFunctionValue(binding.init)) return { fn: binding.init, scope: binding.scope };
  return undefined;
}

/** A component with no props is its own markup. Taking props is slice `import-entries`. */
function convertComponent(context: LayerContext, element: ts.JsxElement | ts.JsxSelfClosingElement, tag: string, place: Place, out: Content[]): void {
  const { file, ledger, budget } = context;
  const { key, scope } = place;
  const open = ts.isJsxElement(element) ? element.openingElement : element;
  const local = ts.isIdentifier(open.tagName) ? localFunction(tag, scope) : undefined;
  if (!local) {
    ledger.claimSubtree(file.source, element, left('unknown-component', 'unknownComponent', key));
    return;
  }
  const hasContent = ts.isJsxElement(element) && element.children.some((child) => !ts.isJsxText(child) || !child.containsOnlyTriviaWhiteSpaces);
  if (local.fn.parameters.length > 0 || open.attributes.properties.length > 0 || hasContent) {
    ledger.claimSubtree(file.source, element, left('unknown-component', 'componentWithProps', key));
    return;
  }
  budget.enterComponent(tag);
  ledger.claim(file.source, [element, open.tagName], converted('element', 'component', key));
  // Its names are the ones where it was declared, not where it is used.
  convertFunctionBody(context, local.fn, { ...place, scope: local.scope }, out);
  budget.leaveComponent();
}

function convertMarkup(context: LayerContext, markup: Markup, place: Place, out: Content[]): void {
  const { file, ledger, budget } = context;
  const { key } = place;
  // A fragment or a component makes no node, so without this a tree of them costs nothing and never ends.
  budget.chargeSteps(1);
  if (ts.isJsxFragment(markup)) {
    ledger.claim(file.source, [markup], converted('element', 'fragment', key));
    convertChildren(context, markup.children, place, out);
    return;
  }
  const open = ts.isJsxElement(markup) ? markup.openingElement : markup;
  const tag = open.tagName.getText(file.source);
  if (/^[A-Z]/.test(tag) || ts.isPropertyAccessExpression(open.tagName)) convertComponent(context, markup, tag, place, out);
  else convertElement(context, markup, tag, place, out);
}

function convertRootExpression(context: LayerContext, expression: ts.Expression, place: Place, out: Content[]): void {
  const { file, ledger } = context;
  const { key } = place;
  const { inner, wrappers } = unwrap(expression);
  if (!isMarkup(inner)) {
    ledger.claimSubtree(file.source, expression, left('expression', 'rootNotMarkup', key));
    return;
  }
  ledger.claim(file.source, wrappers, converted('expression', 'fragment', key));
  convertMarkup(context, inner, place, out);
}

/** `X.displayName = "..."`, which real components have and which changes nothing a visitor sees. */
function isDisplayName(expression: ts.Expression): boolean {
  return ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isPropertyAccessExpression(expression.left) && ts.isIdentifier(expression.left.expression)
    && expression.left.name.text === 'displayName' && ts.isStringLiteralLike(expression.right);
}

/** Whether a statement does anything when it runs, rather than only naming something. */
function isDecider(statement: ts.Statement): boolean {
  if (ts.isImportDeclaration(statement)) return !statement.importClause;
  if (ts.isVariableStatement(statement) || ts.isClassDeclaration(statement) || ts.isExportAssignment(statement)) return holdsEffect(statement);
  if (ts.isExpressionStatement(statement)) return !ts.isStringLiteral(statement.expression) && !isDisplayName(statement.expression);
  return !(ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
    || ts.isEnumDeclaration(statement) || ts.isExportDeclaration(statement) || ts.isImportEqualsDeclaration(statement) || ts.isEmptyStatement(statement));
}

/** Statements on the way to the markup. What only names something matters if read, anything else can change what renders. */
function leaveDeciders({ file, ledger, budget }: LayerContext, statements: readonly ts.Statement[], key: string): void {
  budget.chargeSteps(statements.length);
  for (const statement of statements) {
    if (isDecider(statement)) ledger.claimSubtree(file.source, statement, left('statement', 'leftInTree', key));
  }
}

/** A component's body: declarations, then one `return`. */
function convertFunctionBody(context: LayerContext, fn: ComponentFunction, place: Place, out: Content[]): void {
  const { file, ledger } = context;
  const { key, scope: outer } = place;
  const isAsync = ts.canHaveModifiers(fn) && ts.getModifiers(fn)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
  if (isAsync || fn.asteriskToken) {
    ledger.claimSubtree(file.source, fn, left('statement', 'rootNotMarkup', key));
    return;
  }
  const body = fn.body;
  if (!body) {
    ledger.claimSubtree(file.source, fn, left('statement', 'nothingToPlace', key));
    return;
  }
  const claimShell = (nodes: ts.Node[]) => ledger.claim(file.source, [fn, ...(fn.name ? [fn.name] : []), ...nodes], converted('statement', 'component', key));
  if (!ts.isBlock(body)) {
    claimShell([]);
    convertRootExpression(context, body, { ...place, scope: functionScope(fn, [], outer) }, out);
    return;
  }
  const scope = functionScope(fn, body.statements, outer);
  const result = body.statements.find(ts.isReturnStatement);
  leaveDeciders(context, body.statements.slice(0, result ? body.statements.indexOf(result) : undefined), key);
  if (!result?.expression) {
    ledger.claim(file.source, [fn], left('statement', 'nothingToPlace', key));
    return;
  }
  claimShell([body, result]);
  convertRootExpression(context, result.expression, { ...place, scope }, out);
}

interface Candidate {
  fn: ComponentFunction;
  exported: boolean;
  isDefault: boolean;
  /** What holds it, beside the function: a `const` declaration and its name. */
  holder: ts.Node[];
}

const hasModifier = (node: ts.HasModifiers, kind: ts.SyntaxKind): boolean => ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false;

/** The components a file declares at its top level, by the convention React goes by: a capital. */
function componentsOf(source: ts.SourceFile): Candidate[] {
  const candidates = new Map<string, Candidate>();
  const add = (name: string, candidate: Candidate) => candidates.set(name, candidate);
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.body) {
      const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
      const name = statement.name?.text ?? (isDefault ? 'default' : '');
      if (/^[A-Z]/.test(name) || isDefault) add(name, { fn: statement, exported: hasModifier(statement, ts.SyntaxKind.ExportKeyword), isDefault, holder: [] });
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && /^[A-Z]/.test(declaration.name.text) && isFunctionValue(declaration.initializer)) {
          add(declaration.name.text, { fn: declaration.initializer, exported: hasModifier(statement, ts.SyntaxKind.ExportKeyword), isDefault: false, holder: [declaration, declaration.name] });
        }
      }
    }
  }
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      const named = candidates.get(statement.expression.text);
      if (named) add(statement.expression.text, { ...named, isDefault: true, holder: [...named.holder, statement, statement.expression] });
    }
  }
  return [...candidates.values()];
}

/** Which component a file means: the default export, the one export, or the one component. */
function chooseComponent(candidates: readonly Candidate[]): Candidate | undefined {
  const defaults = candidates.filter((each) => each.isDefault);
  if (defaults.length === 1) return defaults[0];
  const exported = candidates.filter((each) => each.exported);
  if (exported.length === 1) return exported[0];
  return candidates.length === 1 ? candidates[0] : undefined;
}

const ROOT_KEY = 'n';

/** The key of a result's first node, for a line about the whole of it. */
export const ROOT_NODE_KEY = childKey(ROOT_KEY, 0);

/** Layer 1 over one file: its markup as nodes, each construct claimed or left in the ledger. */
export function convertFile(file: ParsedFile, ledger: Ledger, budget: ImportBudget): ComponentNode | undefined {
  const context: LayerContext = { file, ledger, budget, evaluator: createEvaluator(budget), claimedReads: new Set() };
  const { source } = file;
  const scope = fileScope(source);
  const contents: Content[] = [];
  const key = ROOT_NODE_KEY;
  const place: Place = { key, scope, insideSvg: false, parentTag: '', depth: 0 };

  // A pasted fragment is a file whose last statement is markup.
  const last = source.statements[source.statements.length - 1];
  const fragment = last && ts.isExpressionStatement(last) && isMarkup(unwrap(last.expression).inner) ? last : undefined;
  leaveDeciders(context, fragment ? source.statements.slice(0, -1) : source.statements, key);
  if (fragment) {
    ledger.claim(source, [fragment], converted('statement', 'fragment', key));
    convertRootExpression(context, fragment.expression, place, contents);
  } else {
    const candidates = componentsOf(source);
    const chosen = chooseComponent(candidates);
    if (!chosen) {
      if (candidates.length > 0) ledger.refuse('familyNoEntry', 'unknown-component', ['add-entry']);
      else ledger.refuse('nothingToPlace', 'statement', ['rewrite']);
      return undefined;
    }
    ledger.claim(source, chosen.holder, converted('statement', 'component', key));
    convertFunctionBody(context, chosen.fn, place, contents);
  }

  const nodes = contents.filter((item): item is ComponentNode => typeof item === 'object');
  if (contents.length === 1 && nodes.length === 1) return nodes[0];
  if (contents.length === 0) {
    ledger.refuse('nothingToPlace', 'statement', ['rewrite']);
    return undefined;
  }
  // A placement has one root, and text beside nodes has nowhere else to stand.
  ledger.refuse('wrapper', 'element', [], 'adapted');
  budget.chargeNodes(1);
  const wrapper: ComponentNode = { id: ROOT_KEY, type: 'div', props: {} as ComponentNode['props'] };
  settleContents(context, wrapper, contents, ROOT_KEY);
  return wrapper;
}
