// @vitest-environment node

import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { collectAtoms, exemptReason, hasParserTrap, isTooDeep, parseFile } from '../atoms';
import { IMPORT_LIMITS } from '../budget';
import { Ledger } from '../ledger';

const parsed = (text: string) => parseFile('x.tsx', text);
const kinds = (text: string) => collectAtoms(parsed(text), 0).atoms.map((atom) => ts.SyntaxKind[atom.syntaxKind as ts.SyntaxKind]);

describe('what counts as a construct', () => {
  it('decides every syntax kind: atom by default, exempt only with a reason', () => {
    const kindValues = Object.values(ts.SyntaxKind).filter((value): value is ts.SyntaxKind => typeof value === 'number');
    const exempt = kindValues.filter((kind) => exemptReason(kind) !== undefined);
    for (const kind of exempt) expect(exemptReason(kind)).toMatch(/\S/);
    // Nothing a program does sits on the list: only punctuation, holders and modifiers.
    for (const kind of [ts.SyntaxKind.CallExpression, ts.SyntaxKind.Identifier, ts.SyntaxKind.Parameter, ts.SyntaxKind.TypeReference,
      ts.SyntaxKind.IfStatement, ts.SyntaxKind.TryStatement, ts.SyntaxKind.JsxText, ts.SyntaxKind.JsxAttribute, ts.SyntaxKind.ClassDeclaration,
      ts.SyntaxKind.PropertyDeclaration, ts.SyntaxKind.Decorator, ts.SyntaxKind.AwaitExpression]) {
      expect(exemptReason(kind)).toBeUndefined();
    }
  });

  it('holds parameter defaults, type annotations and statements nested deep', () => {
    const found = kinds('function f(a: string = "x") { if (a) { try { g(); } catch (e) { h(); } } }');
    expect(found).toEqual(expect.arrayContaining(['Parameter', 'StringKeyword', 'StringLiteral', 'IfStatement', 'TryStatement', 'CatchClause', 'CallExpression']));
  });

  it('holds class members and JSX text', () => {
    expect(kinds('class A { x = 1; m() {} }')).toEqual(expect.arrayContaining(['ClassDeclaration', 'PropertyDeclaration', 'MethodDeclaration']));
    expect(kinds('<p>text</p>')).toContain('JsxText');
  });

  it('drops layout between elements and keeps a space on one line', () => {
    expect(kinds('<p>\n  <b />\n</p>')).not.toContain('JsxText');
    expect(kinds('<p><b /> <i /></p>')).toContain('JsxText');
  });

  it('records exact ranges, with no leading trivia', () => {
    const file = parsed('/* note */   const a = 1;');
    const { atoms } = collectAtoms(file, 3);
    expect(atoms[0].id).toBe('3:0');
    expect(file.source.text.slice(atoms[0].start, atoms[0].end)).toBe('a = 1');
  });

  it('names its parents, so a stretch stays one line', () => {
    const { atoms } = collectAtoms(parsed('f(a);'), 0);
    expect(atoms[0].parent).toBeUndefined();
    expect(atoms.slice(1).every((atom) => atom.parent !== undefined && atom.parent < atom.index)).toBe(true);
  });
});

describe('the depth check', () => {
  const nested = (depth: number) => parsed(`const a = ${'['.repeat(depth)}${']'.repeat(depth)};`).source;

  it('reads the tree, at the limit and past it', () => {
    expect(isTooDeep(nested(10))).toBe(false);
    expect(isTooDeep(nested(IMPORT_LIMITS.astDepth + 1))).toBe(true);
  });

  it('sees what a bracket count misses', () => {
    expect(isTooDeep(parsed(`const a = ${'!'.repeat(300)}1;`).source)).toBe(true);
    expect(isTooDeep(parsed(`const a = ${'a=>'.repeat(300)}1;`).source)).toBe(true);
    expect(isTooDeep(parsed(`const a = ${'a+'.repeat(300)}a;`).source)).toBe(true);
  });
});

describe('the parser trap', () => {
  const nested = (levels: number) => `${'async(a='.repeat(levels)}1${')'.repeat(levels)}`;

  it('counts nesting, not occurrences', () => {
    expect(hasParserTrap(nested(8))).toBe(false);
    expect(hasParserTrap(nested(9))).toBe(true);
    expect(hasParserTrap('async(a=1);'.repeat(1_000))).toBe(false);
  });

  it('reads tokens, so a string or comment is not code', () => {
    expect(hasParserTrap(`const a = "${nested(20)}";`)).toBe(false);
    expect(hasParserTrap(`// ${nested(20)}`)).toBe(false);
  });

  it('survives a stray closer', () => {
    expect(hasParserTrap(`)))${nested(20)}`)).toBe(true);
  });
});

describe('the ledger', () => {
  it('opens everything as left, in one line per stretch', () => {
    const ledger = new Ledger();
    ledger.open(parsed('f(a);\ng(b);'));
    const lines = ledger.close();
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => [line.line, line.endLine, line.kind, line.disposition])).toEqual([[1, 1, 'statement', 'left'], [2, 2, 'statement', 'left']]);
  });

  it('leaves what sits inside a narrow claim open', () => {
    const file = parsed('f(a);');
    const ledger = new Ledger();
    ledger.open(file);
    const statement = file.source.statements[0];
    ledger.claim(file.source, [statement], { kind: 'statement', disposition: 'converted', detail: 'element' });
    const lines = ledger.close();
    expect(lines.map((line) => line.disposition)).toEqual(['converted', 'left']);
    expect(lines[1].excerpt).toBe('f(a)');
  });

  it('takes a broad claim over all a node holds', () => {
    const file = parsed('f(a);');
    const ledger = new Ledger();
    ledger.open(file);
    ledger.claimSubtree(file.source, file.source.statements[0], { kind: 'statement', disposition: 'converted', detail: 'element' });
    expect(ledger.close()).toHaveLength(1);
  });

  it('refuses a claim on a file it never opened', () => {
    const ledger = new Ledger();
    const file = parsed('a;');
    expect(() => ledger.claim(file.source, [], { kind: 'statement', disposition: 'left', detail: 'left' })).toThrow(/never opened/);
  });
});
