// @vitest-environment node

import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parseFile } from '../atoms';
import { BudgetExceeded, createImportBudget } from '../budget';
import { UNKNOWN, createEvaluator, fileScope, functionScope, toPlain, type Evaluated } from '../staticEval';

/** The value of the last declaration in a file. */
function evaluateResult(source: ts.SourceFile, budget = createImportBudget()): Evaluated {
  const last = source.statements[source.statements.length - 1] as ts.VariableStatement;
  return createEvaluator(budget).evaluate(last.declarationList.declarations[0].initializer as ts.Expression, fileScope(source)).value;
}

const value = (expression: string, setup = '') => {
  const { source } = parseFile('x.tsx', `${setup}\nconst result = ${expression};`);
  return evaluateResult(source);
};

describe('what it reads', () => {
  it.each<[string, unknown]>([
    ['"a"', 'a'],
    ['`a`', 'a'],
    ['1.5', 1.5],
    ['-2', -2],
    ['0x10', 16],
    ['true', true],
    ['false', false],
    ['null', null],
    ['undefined', undefined],
    ['`a${1}b${"c"}${null}`', 'a1bcnull'],
    ['("a" as const)', 'a'],
    ['("a" satisfies string)', 'a'],
    ['true ? "a" : "b"', 'a'],
    ['0 ? "a" : "b"', 'b'],
    ['1 && "a"', 'a'],
    ['0 && "a"', 0],
    ['0 || "a"', 'a'],
    ['"" ?? "a"', ''],
    ['null ?? "a"', 'a'],
  ])('%s', (expression, expected) => {
    expect(value(expression)).toBe(expected);
  });

  it('reads objects, arrays, spreads and members', () => {
    const setup = 'const base = { a: 1, b: { c: "x" } }; const list = ["p", "q"];';
    expect(value('base.b.c', setup)).toBe('x');
    expect(value('base["a"]', setup)).toBe(1);
    expect(value('list[1]', setup)).toBe('q');
    expect(value('list.length', setup)).toBe(2);
    expect(toPlain(value('{ ...base, a: 2 }', setup) as never)).toEqual({ a: 2, b: { c: 'x' } });
    expect(toPlain(value('[...list, "r"]', setup) as never)).toEqual(['p', 'q', 'r']);
    expect(toPlain(value('{ ["k"]: 1, ...null, ...false }') as never)).toEqual({ k: 1 });
    expect(value('missing?.x', 'const missing = null;')).toBeUndefined();
  });

  it('reads a chain of constants, and says which', () => {
    const { source } = parseFile('x.tsx', 'const a = "x"; const b = { a }; const c = 1; const result = b.a;');
    const last = source.statements[3] as ts.VariableStatement;
    const { reads } = createEvaluator(createImportBudget()).evaluate(last.declarationList.declarations[0].initializer as ts.Expression, fileScope(source));
    expect([...reads].map((declaration) => declaration.name.getText(source)).sort()).toEqual(['a', 'b']);
  });
});

describe('what it calls nothing for', () => {
  it.each([
    'f()', 'new Date()', 'a + b', '"a" + "b"', 'x', 'typeof 1', '!true', '1 + 1', 'async () => 1', '<div />', 'import("x")',
    '/a/', '10n', 'this', 'class {}', 'function () {}', '[,1]', '[..."ab"]', '{ get a() { return 1; } }', '{ a() {} }',
  ])('%s is unknown', (expression) => {
    expect(value(expression)).toBe(UNKNOWN);
  });

  it('never runs what it reads', () => {
    let ran = false;
    (globalThis as { touch?: () => void }).touch = () => {
      ran = true;
    };
    value('touch()');
    value('{ a: touch() }.a');
    value('`${touch()}`');
    delete (globalThis as { touch?: () => void }).touch;
    expect(ran).toBe(false);
  });
});

describe('prototypes', () => {
  const setup = 'const o = { a: 1 }; const l = [1];';

  it.each(['o.constructor', 'o.__proto__', 'o["__proto__"]', 'o.toString', 'o.hasOwnProperty', 'l.constructor', 'l.map', 'l["__proto__"]', 'o.a.toFixed', '"x".length', 'l[1]', 'l[-1]', 'l[0.5]'])('%s is unknown', (expression) => {
    expect(value(expression, setup)).toBe(UNKNOWN);
  });

  it('makes objects with no prototype', () => {
    expect(Object.getPrototypeOf(value('{ a: 1 }'))).toBeNull();
  });

  it('refuses a literal __proto__, which sets a prototype rather than a key', () => {
    expect(value('{ __proto__: { polluted: 1 } }')).toBe(UNKNOWN);
    expect(value('{ "__proto__": 1 }')).toBe(UNKNOWN);
    expect(value('{ ["__proto__"]: 1 }')).toBe(UNKNOWN);
    expect(({} as { polluted?: number }).polluted).toBeUndefined();
  });
});

describe('what a constant is not', () => {
  it.each([
    ['let', 'let a = "x";'],
    ['var', 'var a = "x";'],
    ['a destructure', 'const { a } = { a: "x" };'],
    ['a chain past the depth', Array.from({ length: 40 }, (_, i) => `const a${i + 1 === 40 ? '' : i + 1} = ${i === 0 ? '"x"' : `a${i}`};`).join('\n')],
    ['two constants reading each other', 'const a = [b]; const b = [a];'],
    ['a class', 'class a {}'],
    ['a function', 'function a() {}'],
  ])('%s', (_name, setup) => {
    expect(value('a', setup)).toBe(UNKNOWN);
  });

  it.each([
    ['assignment', 'o.a = 2;'],
    ['compound assignment', 'o.a += 2;'],
    ['nested assignment', 'o.b.c = 2;'],
    ['increment', 'o.a++;'],
    ['delete', 'delete o.a;'],
    ['an array writer', 'o.push(1);'],
    ['a call that receives it', 'merge(o);'],
    ['a call that receives a piece of it', 'merge(o.b);'],
  ])('reads no object written through by %s', (_name, write) => {
    expect(value('o.a', `const o = { a: 1, b: {} };\n${write}`)).toBe(UNKNOWN);
  });

  it('still reads a string passed to a call, which nothing can write', () => {
    expect(value('s', 'const s = "x"; merge(s);')).toBe('x');
  });

  it('lets a parameter shadow a constant', () => {
    const { source } = parseFile('x.tsx', 'const a = "x"; function F(a) { return a; }');
    const fn = source.statements[1] as ts.FunctionDeclaration;
    const expression = (fn.body?.statements[0] as ts.ReturnStatement).expression as ts.Expression;
    const scope = functionScope(fn, fn.body?.statements ?? [], fileScope(source));
    expect(createEvaluator(createImportBudget()).evaluate(expression, scope).value).toBe(UNKNOWN);
  });

  it('lets a local constant shadow a file constant', () => {
    const { source } = parseFile('x.tsx', 'const a = "x"; function F() { const a = "y"; return a; }');
    const fn = source.statements[1] as ts.FunctionDeclaration;
    const expression = (fn.body?.statements[1] as ts.ReturnStatement).expression as ts.Expression;
    const scope = functionScope(fn, fn.body?.statements ?? [], fileScope(source));
    expect(createEvaluator(createImportBudget()).evaluate(expression, scope).value).toBe('y');
  });
});

describe('the budget', () => {
  it('is paid before a doubling value exists', () => {
    const lines = ['const a0 = ["xxxxxxxxxxxxxxxx"];'];
    for (let i = 1; i <= 40; i += 1) lines.push(`const a${i} = [...a${i - 1}, ...a${i - 1}];`);
    // Read in order, so each level is one step and the depth limit is not what stops it.
    const levels = Array.from({ length: 41 }, (_, i) => `a${i}`).join(', ');
    const { source } = parseFile('x.tsx', `${lines.join('\n')}\nconst result = [${levels}];`);
    expect(() => evaluateResult(source)).toThrow(BudgetExceeded);
  });
});
