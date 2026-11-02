// Layer 1, static JSX to nodes, and the normal form's parser for the round trip test.
//
// `convertFile` is the importer's: it reads a file as what it is, a source from a
// stranger. A tag or attribute goes through the render gate's own functions, because
// otherwise the gate would drop it at render time with nobody told, and an attribute
// that means something to the platform is refused, since a source may not set it. What
// it cannot read is a line. Classes wait for layer 2, props for layer 3, handlers for
// layer 4 and loops for layer 5.
//
// `jsxToNodes` is the other direction of `nodesToJsx` in test/score/roundtrip/jsx.ts. It
// reads a small language of its own (`rules`, `bindings`, islands by name), which exists
// for that test and no developer sees. It is not a way into a project.
//
// The contract is docs/plans/2026-11-02-react-import.md, "Layer 1: static JSX".

import ts from 'typescript';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { isDroppedProp, isBlockedTag, safeInlineStyle, withoutDocumentId } from '@/lib/renderer/blockedNodes';
import { readBehaviourTree, type StateValue } from '@/lib/behaviour/format';
import { FORM_KIND_ATTR } from '@/lib/forms/definition';
import { isLegacyRulesAttribute, isRuleList, readRules, type RuleContext } from '@/lib/rules/rules';
import { STICKY_CTA_ATTR, STICKY_CTA_MARKER } from '@/lib/stickyCta/stickyCta';
import { isRenderedAttribute } from '@/lib/renderer/renderVocabulary';
import { TEXT_NODE_TYPE, isTextNodeType, refusesBareText } from '@/lib/renderer/textNode';
import { isVoidTag } from '@/lib/drag/voidTags';
import { isTooDeep, parseFile, type ParsedFile } from './atoms';
import type { ImportBudget } from './budget';
import type { Claim, Ledger } from './ledger';
import type { DetailKey, LineKind } from './report';
import { UNKNOWN, createEvaluator, fileScope, functionScope, toPlain, type Evaluated, type Evaluator, type Scope } from './staticEval';

/** A text node with a binding: bare text has nowhere to carry the bindings prop. */
export const TEXT_RUN_TAG = 'TextRun';

/** The bindings prop on a JSX element: the plan's "explicit, named prop". */
export const BINDINGS_PROP = 'bindings';

/** An island's own element: a submit button is a button, a form is a div. */
export const ISLAND_HOST_PROP = 'as';

/** Runtime islands are named components; import maps the name back to the marker prop. */
export const ISLANDS: Record<string, { attr: string; value: string }> = {
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

/** Attributes the renderers read as instructions: an island's marker turns a `div` into a form. */
const PLATFORM_ATTRIBUTE = /^data-(?:fc|fcs|u|island|component|inner-component|form|sticky|repeat)(?:-|$)/i;

/** The name is the tag, and only a plain one can be: `a:b` and `a.b` are not elements. */
const PLAIN_TAG = /^[a-z][a-zA-Z0-9-]*$/;

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

/** A style value that loads a file from elsewhere. Allowed by the format, and a visitor's address reaches a third party. */
const EXTERNAL_ADDRESS = /(?:url|image-set|image)\(\s*['"]?\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i;

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
}

/** Where a piece of markup stands: its node key, its scope, and what the element around it decides. */
interface Place {
  key: string;
  scope: Scope;
  insideSvg: boolean;
  parentTag: string;
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
  if (safeInlineStyle(declarations) !== declarations) return { claim: left('refused-attribute', 'refusedStyle', key) };
  const external = Object.values(declarations).some((text) => typeof text === 'string' && EXTERNAL_ADDRESS.test(text));
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
  // Not a value, but a line each: an element with a million attributes costs what it says.
  budget.chargeEvaluated(name.length + 64);
  if (name === 'key') return { claim: converted('attribute', 'key', key) };
  if (name === 'ref') return { claim: left('attribute', 'ref', key) };
  if (name === 'className' || name === 'class') return { claim: left('class', 'classPending', key) };
  if (/^on[A-Z]/.test(name)) return { claim: left('handler', 'handler', key) };
  if (name === 'children') return { claim: left('attribute', 'childrenAttribute', key) };
  if (PLATFORM_ATTRIBUTE.test(name)) return { claim: left('refused-attribute', 'platformAttribute', key) };
  // By name, before the value is read: a dynamic `dangerouslySetInnerHTML` is refused, not "dynamic".
  if (name === 'dangerouslySetInnerHTML' || (name !== 'style' && !isRenderedAttribute(name.toLowerCase()))) return { claim: left('refused-attribute', 'refusedAttribute', key) };

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

  if (name === 'style') return { ...readStyle(value, key), reads };
  if (value === UNKNOWN) return { claim: left('attribute', 'dynamicAttribute', key) };
  if (value === null || value === undefined) return { claim: converted('attribute', 'emptyValue', key), reads };
  const stored = toPlain(value);
  if (isDroppedProp(name, stored)) return { claim: left('refused-attribute', 'refusedAttribute', key) };
  if (name === 'id' && withoutDocumentId(tag, { id: stored }).id === undefined) return { claim: left('refused-attribute', 'refusedAttribute', key) };
  return { store: { name, value: stored }, claim: converted('attribute', 'attribute', key), reads };
}

function claimReads({ file, ledger }: LayerContext, reads: ReadonlySet<ts.VariableDeclaration> | undefined): void {
  for (const declaration of reads ?? []) {
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

/** A form works through its island, so a form with its own logic is not the form it looks like. */
function isFormWithLogic(tag: string, open: ts.JsxOpeningLikeElement): boolean {
  return tag.toLowerCase() === 'form' && open.attributes.properties.some((attribute) =>
    ts.isJsxSpreadAttribute(attribute) || (ts.isIdentifier(attribute.name) && (attribute.name.text === 'action' || /^on[A-Z]/.test(attribute.name.text))));
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
  const { key, scope, insideSvg } = place;
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
      const inner = { key, scope, insideSvg: lower !== 'foreignobject' && (insideSvg || lower === 'svg'), parentTag: tag };
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
  const { file, ledger } = context;
  const { key } = place;
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

/** Statements on the way to the markup. A declaration only matters if read, anything else can change what renders. */
function leaveDeciders({ file, ledger }: LayerContext, statements: readonly ts.Statement[], key: string): void {
  for (const statement of statements) {
    const declares = ts.isVariableStatement(statement) || ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
      || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isImportDeclaration(statement);
    if (!declares) ledger.claimSubtree(file.source, statement, left('statement', 'leftInTree', key));
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

/** Layer 1 over one file: its markup as nodes, each construct claimed or left in the ledger. */
export function convertFile(file: ParsedFile, ledger: Ledger, budget: ImportBudget): ComponentNode | undefined {
  const context: LayerContext = { file, ledger, budget, evaluator: createEvaluator(budget) };
  const { source } = file;
  const scope = fileScope(source);
  const contents: Content[] = [];
  const key = childKey(ROOT_KEY, 0);
  const place: Place = { key, scope, insideSvg: false, parentTag: '' };

  // A pasted fragment is a file whose last statement is markup.
  const last = source.statements[source.statements.length - 1];
  const fragment = last && ts.isExpressionStatement(last) && isMarkup(unwrap(last.expression).inner) ? last : undefined;
  if (fragment) {
    leaveDeciders(context, source.statements.slice(0, -1), key);
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

export interface ImportResult {
  node?: ComponentNode;
  /** Everything not converted, by source text: reported, never dropped silently. */
  leftOver: string[];
}

/**
 * A literal expression's value, or a refusal when it is a program. Not the evaluator:
 * this reads the JSON that `nodesToJsx` writes, so a `__proto__` key is a key, and
 * reaches the rule parser, which refuses it by name. In real source it sets a prototype.
 */
function literalValue(expr: ts.Expression): { ok: true; value: unknown } | { ok: false } {
  if (ts.isStringLiteralLike(expr)) return { ok: true, value: expr.text };
  if (ts.isNumericLiteral(expr)) return { ok: true, value: Number(expr.text) };
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, value: true };
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, value: false };
  if (expr.kind === ts.SyntaxKind.NullKeyword) return { ok: true, value: null };
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken) {
    const inner = literalValue(expr.operand);
    return inner.ok ? { ok: true, value: -(inner.value as number) } : inner;
  }
  if (ts.isArrayLiteralExpression(expr)) {
    const values = expr.elements.map((e) => literalValue(e));
    if (values.some((v) => !v.ok)) return { ok: false };
    return { ok: true, value: values.map((v) => (v as { value: unknown }).value) };
  }
  if (ts.isObjectLiteralExpression(expr)) {
    const out: Record<string, unknown> = {};
    for (const prop of expr.properties) {
      if (!ts.isPropertyAssignment(prop)) return { ok: false };
      const key = ts.isIdentifier(prop.name) ? prop.name.text : ts.isStringLiteralLike(prop.name) ? prop.name.text : undefined;
      if (key === undefined) return { ok: false };
      const value = literalValue(prop.initializer);
      if (!value.ok) return { ok: false };
      // Plain assignment to `__proto__` would drop the key, and hide it from the parser.
      Object.defineProperty(out, key, { value: value.value, enumerable: true, writable: true, configurable: true });
    }
    return { ok: true, value: out };
  }
  return { ok: false };
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
  const walkTree = (node: ComponentNode, copy: ComponentNode, outer: ReadonlyMap<string, StateValue>) => {
    const state = behaviours.get(copy)?.state;
    const states = state ? new Map([...outer, ...state.map((value): [string, StateValue] => [value.id, value])]) : outer;
    // A page with no behaviour never reaches that pass, so no state is in reach at all.
    settleRules(node, behaviours.size > 0 ? { states } : {}, leftOver);
    node.children?.forEach((child, index) => walkTree(child, (copy.children as ComponentNode[])[index], states));
  };
  walkTree(root, keyed, new Map());
}

function jsxToNodesUnguarded(jsx: string, source: ts.SourceFile): ImportResult {
  const leftOver: string[] = [];
  const textOf = (node: ts.Node) => node.getText(source).replace(/\s+/g, ' ').slice(0, 120);

  const convert = (element: ts.JsxElement | ts.JsxSelfClosingElement): ComponentNode | undefined => {
    const open = ts.isJsxElement(element) ? element.openingElement : element;
    const tag = open.tagName.getText(source);
    const island = Object.hasOwn(ISLANDS, tag) ? ISLANDS[tag] : undefined;
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
        const literal = literalValue(init.expression);
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
    const contents: Content[] = [];
    if (ts.isJsxElement(element)) {
      for (const child of element.children) {
        let text: string | number | undefined;
        if (ts.isJsxText(child)) {
          text = jsxText(child.text);
          if (text.length === 0) continue;
        } else if (ts.isJsxExpression(child)) {
          if (!child.expression) continue;
          const literal = literalValue(child.expression);
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

/** The normal form's parser. It holds the same line as the importer on a hostile input: a refusal, never a throw. */
export function jsxToNodes(jsx: string): ImportResult {
  try {
    const { source } = parseFile('import.tsx', `const root = (${jsx});`);
    if (isTooDeep(source)) return { leftOver: ['nested too deeply to read safely'] };
    return jsxToNodesUnguarded(jsx, source);
  } catch (error) {
    if (error instanceof RangeError) return { leftOver: ['nested too deeply to read safely'] };
    throw error;
  }
}
