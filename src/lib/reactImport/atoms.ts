// Parsing, and what counts as a construct. Parsing reads text and runs nothing: no
// program, no `lib` files, no import followed. A syntax kind is an atom unless the
// list below says why not, so a kind nobody thought of is reported, not lost.
//
// Every walk here keeps its own stack. `a+a+...` and `a()()...` parse and then overflow
// a recursive walker, and nothing recursive runs on a tree `isTooDeep` has not passed.
// The contract is docs/plans/2026-11-02-react-import.md, "The ledger".

import ts from 'typescript';
import { IMPORT_LIMITS } from './budget';

/** One construct of the source, with its exact range. `parent` is the nearest enclosing atom. */
export interface Atom {
  id: string;
  index: number;
  parent?: number;
  syntaxKind?: ts.SyntaxKind;
  start: number;
  end: number;
}

export interface ParsedFile {
  name: string;
  source: ts.SourceFile;
  /** The first syntax error's position, when the file has one. A recovered tree is a guess, so it converts nothing. */
  syntaxError?: number;
}

const MODIFIERS = [
  ts.SyntaxKind.AbstractKeyword, ts.SyntaxKind.AccessorKeyword, ts.SyntaxKind.AsyncKeyword, ts.SyntaxKind.ConstKeyword,
  ts.SyntaxKind.DeclareKeyword, ts.SyntaxKind.DefaultKeyword, ts.SyntaxKind.ExportKeyword, ts.SyntaxKind.InKeyword,
  ts.SyntaxKind.OutKeyword, ts.SyntaxKind.OverrideKeyword, ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword,
  ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.ReadonlyKeyword, ts.SyntaxKind.StaticKeyword,
];

/** Kinds that are not atoms, each with its reason. Everything else is one. */
const EXEMPT: ReadonlyMap<ts.SyntaxKind, string> = new Map<ts.SyntaxKind, string>([
  [ts.SyntaxKind.SourceFile, 'holder: the file is its statements'],
  [ts.SyntaxKind.EndOfFileToken, 'punctuation: it marks the end'],
  [ts.SyntaxKind.VariableStatement, 'holder: each declaration is an atom'],
  [ts.SyntaxKind.VariableDeclarationList, 'holder: each declaration is an atom'],
  [ts.SyntaxKind.JsxOpeningElement, 'holder: its tag and attributes are atoms'],
  [ts.SyntaxKind.JsxClosingElement, 'punctuation: it repeats the opening tag'],
  [ts.SyntaxKind.JsxAttributes, 'holder: each attribute is an atom'],
  [ts.SyntaxKind.JsxOpeningFragment, 'punctuation: the fragment is the atom'],
  [ts.SyntaxKind.JsxClosingFragment, 'punctuation: the fragment is the atom'],
  ...MODIFIERS.map((kind): [ts.SyntaxKind, string] => [kind, 'modifier: read with the declaration it sits on']),
]);

const isPunctuation = (kind: ts.SyntaxKind): boolean => kind >= ts.SyntaxKind.FirstPunctuation && kind <= ts.SyntaxKind.LastPunctuation;

/** Why a kind is no atom, or undefined when it is one. */
export function exemptReason(kind: ts.SyntaxKind): string | undefined {
  return isPunctuation(kind) ? 'punctuation' : EXEMPT.get(kind);
}

/** Layout between elements, which React drops. A plain space on one line is real text. */
const isLayoutText = (node: ts.Node): boolean => ts.isJsxText(node) && node.containsOnlyTriviaWhiteSpaces;

const isAtom = (node: ts.Node): boolean => exemptReason(node.kind) === undefined && !isLayoutText(node);

function childrenOf(node: ts.Node): ts.Node[] {
  const children: ts.Node[] = [];
  // A closing tag holds only the name its opening tag already claimed.
  if (ts.isJsxClosingElement(node)) return children;
  ts.forEachChild(node, (child) => {
    children.push(child);
  });
  return children;
}

/** Calls `visit` for every node, parents first, in source order, until it says `stop`. `skip` leaves out what a node holds. */
export function walk<T>(root: ts.Node, context: T, visit: (node: ts.Node, context: T) => { stop?: boolean; skip?: boolean; next: T }): void {
  const stack: Array<{ node: ts.Node; context: T }> = [{ node: root, context }];
  while (stack.length > 0) {
    const { node, context: from } = stack.pop() as { node: ts.Node; context: T };
    const { stop, skip, next } = visit(node, from);
    if (stop) return;
    if (skip) continue;
    const children = childrenOf(node);
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push({ node: children[i], context: next });
  }
}

/** Whether a tree passes the depth limit, read from the tree, since no bracket scan sees `!` or `a+a`. */
export function isTooDeep(source: ts.SourceFile): boolean {
  let tooDeep = false;
  walk(source, 0, (_node, depth) => {
    tooDeep = depth > IMPORT_LIMITS.astDepth;
    return { stop: tooDeep, next: depth + 1 };
  });
  return tooDeep;
}

const SCRIPT_KINDS: Readonly<Record<string, ts.ScriptKind>> = {
  tsx: ts.ScriptKind.TSX, ts: ts.ScriptKind.TS, jsx: ts.ScriptKind.JSX, js: ts.ScriptKind.JSX, mjs: ts.ScriptKind.JSX,
};

export const extensionOf = (name: string): string => /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() ?? '';

/** Whether a file of this name is source. */
export const isScript = (name: string): boolean => Object.hasOwn(SCRIPT_KINDS, extensionOf(name));

/** How many `async(` may stand open inside each other. No real file comes near it. */
const ASYNC_NESTING_LIMIT = 8;

const OPENERS: ReadonlySet<ts.SyntaxKind> = new Set([ts.SyntaxKind.OpenParenToken, ts.SyntaxKind.OpenBracketToken, ts.SyntaxKind.OpenBraceToken]);
const CLOSERS: ReadonlySet<ts.SyntaxKind> = new Set([ts.SyntaxKind.CloseParenToken, ts.SyntaxKind.CloseBracketToken, ts.SyntaxKind.CloseBraceToken]);

/**
 * Whether a text holds the parser's exponential case. On `async(a=async(a=...` TypeScript tries the arrow
 * function and the call at every level, so 246 bytes outlast the worker's deadline, inside
 * `createSourceFile`, before any limit here can act. So this runs first, on tokens, which is linear.
 *
 * It catches the family, not everything. Tokens read JSX text as code, so a quote in text can hide a run
 * from it, and other shapes may exist. Those are what the host's deadline is for.
 */
export function hasParserTrap(text: string): boolean {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.JSX, text);
  const open: number[] = [];
  let depth = 0;
  let afterAsync = false;
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (afterAsync && (token === ts.SyntaxKind.OpenParenToken || token === ts.SyntaxKind.LessThanToken)) {
      open.push(depth);
      if (open.length > ASYNC_NESTING_LIMIT) return true;
    }
    if (OPENERS.has(token)) depth += 1;
    else if (CLOSERS.has(token)) {
      depth = Math.max(0, depth - 1);
      while (open.length > 0 && open[open.length - 1] >= depth) open.pop();
    }
    afterAsync = token === ts.SyntaxKind.AsyncKeyword;
  }
  return false;
}

/**
 * The tree of one file, with no parent pointers: nothing here reads them, and so no
 * pass runs over a tree that has not been measured. A `RangeError` passes out of this
 * on purpose, to the one catch: the parser itself overflows on deep enough input.
 */
export function parseFile(name: string, text: string): ParsedFile {
  const kind = Object.hasOwn(SCRIPT_KINDS, extensionOf(name)) ? SCRIPT_KINDS[extensionOf(name)] : ts.ScriptKind.TSX;
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, false, kind);
  const { parseDiagnostics } = source as unknown as { parseDiagnostics: readonly ts.DiagnosticWithLocation[] };
  return { name, source, ...(parseDiagnostics.length > 0 ? { syntaxError: parseDiagnostics[0].start } : {}) };
}

/** Every atom of a file, parents before children, and the atom of each node. */
export function collectAtoms(file: ParsedFile, fileIndex: number): { atoms: Atom[]; byNode: Map<ts.Node, Atom> } {
  const atoms: Atom[] = [];
  const byNode = new Map<ts.Node, Atom>();
  walk<number | undefined>(file.source, undefined, (node, parent) => {
    if (!isAtom(node)) return { next: parent };
    const atom: Atom = {
      id: `${fileIndex}:${atoms.length}`,
      index: atoms.length,
      syntaxKind: node.kind,
      start: node.getStart(file.source),
      end: node.end,
      ...(parent === undefined ? {} : { parent }),
    };
    atoms.push(atom);
    byNode.set(node, atom);
    return { next: atom.index };
  });
  return { atoms, byNode };
}
