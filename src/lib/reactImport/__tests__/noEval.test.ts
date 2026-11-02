// @vitest-environment node
// Source is data, and nothing in this folder evaluates it. The check is on the syntax
// tree rather than on text, so a comment that mentions `eval` passes and a spelling
// such as `globalThis['eval']` does not.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { walk } from '../atoms';

const FOLDER = path.resolve(__dirname, '..');

/** Names that run text as code or reach outside a parse, wherever they stand. */
const BANNED_NAMES: ReadonlySet<string> = new Set(['eval', 'Function', 'AsyncFunction', 'GeneratorFunction', 'require', 'importScripts']);
/** The parts of TypeScript that read the disk, follow imports or produce code to run. */
const BANNED_MEMBERS: ReadonlySet<string> = new Set(['createProgram', 'createCompilerHost', 'transpile', 'transpileModule', 'sys', 'createWatchProgram', 'createLanguageService']);

/** Each eval-shaped thing in one file. The cases below prove it finds them. */
function evalShapes(name: string, text: string): string[] {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const found: string[] = [];
  walk(source, undefined, (node) => {
    if (ts.isIdentifier(node) && BANNED_NAMES.has(node.text)) found.push(node.text);
    if (ts.isStringLiteralLike(node) && BANNED_NAMES.has(node.text)) found.push(`'${node.text}'`);
    if (ts.isPropertyAccessExpression(node) && BANNED_MEMBERS.has(node.name.text)) found.push(`.${node.name.text}`);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) found.push('import()');
    const callee = ts.isCallExpression(node) ? node.expression : undefined;
    if (callee && ts.isIdentifier(callee) && (callee.text === 'setTimeout' || callee.text === 'setInterval')) found.push(callee.text);
    return { next: undefined };
  });
  return found;
}

describe('nothing here evaluates source', () => {
  const files = readdirSync(FOLDER, { recursive: true, encoding: 'utf8' }).filter((name) => /\.tsx?$/.test(name) && !name.includes('__tests__'));

  it('covers the folder', () => {
    expect(files).toEqual(expect.arrayContaining(['source.ts', 'staticEval.ts', 'jsx.ts', 'atoms.ts', 'ledger.ts', 'report.ts', 'budget.ts']));
  });

  it.each(files)('%s has no eval-shaped call', (name) => {
    expect(evalShapes(name, readFileSync(path.join(FOLDER, name), 'utf8'))).toEqual([]);
  });

  it.each([
    ['eval("1")', 'eval'],
    ['globalThis["eval"]("1")', "'eval'"],
    ['new Function("return 1")', 'Function'],
    ['Function("return 1")()', 'Function'],
    ['(0).constructor.constructor("x")', undefined],
    ['import("./x")', 'import()'],
    ['require("./x")', 'require'],
    ['ts.transpileModule(x, {})', '.transpileModule'],
    ['ts.createProgram([], {})', '.createProgram'],
    ['ts.sys.readFile("x")', '.sys'],
    ['setTimeout("alert(1)")', 'setTimeout'],
  ])('finds %s', (text, expected) => {
    const shapes = evalShapes('x.ts', text);
    if (expected) expect(shapes).toContain(expected);
    else expect(shapes).toEqual([]);
  });

  it('ignores a comment', () => {
    expect(evalShapes('x.ts', '// eval("1")\nconst a = 1;')).toEqual([]);
  });
});
