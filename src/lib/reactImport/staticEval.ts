// The closed evaluator: what is this expression, a value or `UNKNOWN`. It calls nothing
// and runs nothing. It reads the syntax of literals, template strings, local `const`,
// object and array literals, spreads of those, member access, `? :`, `&&`, `||` and `??`.
// Anything else is `UNKNOWN`, which the layer reports.
//
// Objects are null-prototype, and a key is read only when it is the object's own, so
// `constructor` and `__proto__` reach nothing. Every value pays the budget for what it
// would cost written out, before it exists: `const a=[...b,...b]` doubles per level, and
// so does `[b,b]`, which shares memory until something walks it.
//
// The contract is docs/plans/2026-11-02-react-import.md, "Layer 1: static JSX".

import ts from 'typescript';
import { walk } from './atoms';
import { IMPORT_LIMITS, type ImportBudget } from './budget';

export const UNKNOWN: unique symbol = Symbol('unknown');

export type StaticValue = string | number | boolean | null | undefined | StaticObject | StaticValue[];
export interface StaticObject {
  [key: string]: StaticValue;
}
export type Evaluated = StaticValue | typeof UNKNOWN;

/** A name in scope: a constant to read, a function to inline, or something only known at run time. */
export type Binding =
  | { kind: 'const'; name: string; declaration: ts.VariableDeclaration; init: ts.Expression; scope: Scope }
  | { kind: 'function'; declaration: ts.FunctionDeclaration; scope: Scope }
  | { kind: 'unknown' };

/** One lexical scope. Inner names shadow outer ones, and a prop that shadows a constant is unknown, not the constant. */
export class Scope {
  readonly bindings = new Map<string, Binding>();

  constructor(readonly mutated: ReadonlySet<string>, readonly parent?: Scope) {}

  lookup(name: string): Binding | undefined {
    return this.bindings.get(name) ?? this.parent?.lookup(name);
  }
}

function declareUnknown(scope: Scope, name: ts.BindingName): void {
  walk(name, undefined, (node) => {
    if (ts.isIdentifier(node)) scope.bindings.set(node.text, { kind: 'unknown' });
    return { next: undefined };
  });
}

function declareStatements(scope: Scope, statements: readonly ts.Statement[]): void {
  for (const statement of statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      scope.bindings.set(statement.name.text, { kind: 'function', declaration: statement, scope });
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      scope.bindings.set(statement.name.text, { kind: 'unknown' });
    } else if (ts.isVariableStatement(statement)) {
      const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const declaration of statement.declarationList.declarations) {
        if (isConst && ts.isIdentifier(declaration.name) && declaration.initializer) {
          scope.bindings.set(declaration.name.text, { kind: 'const', name: declaration.name.text, declaration, init: declaration.initializer, scope });
        } else {
          declareUnknown(scope, declaration.name);
        }
      }
    }
  }
}

const ARRAY_WRITERS: ReadonlySet<string> = new Set(['copyWithin', 'fill', 'pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift']);

/** The name at the root of `a.b[0].c`, when there is one. */
function rootName(expression: ts.Expression): string | undefined {
  let current = expression;
  while (!ts.isIdentifier(current)) {
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current) || ts.isParenthesizedExpression(current)
      || ts.isNonNullExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
    else return undefined;
  }
  return current.text;
}

/**
 * Names something may write through. `const` keeps a name, not a value: after `o.a = 2`
 * or `merge(o)`, reading the literal would be a confident wrong answer, so an object or
 * array under such a name is unknown. By name across the file, which errs towards `UNKNOWN`.
 */
function namesWrittenThrough(source: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  const add = (expression: ts.Expression) => {
    const name = rootName(expression);
    if (name) names.add(name);
  };
  walk(source, undefined, (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) add(node.left);
    else if (ts.isDeleteExpression(node)) add(node.expression);
    else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) add(node.operand);
    else if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression) && ARRAY_WRITERS.has(node.expression.name.text)) add(node.expression.expression);
      node.arguments.forEach(add);
    }
    return { next: undefined };
  });
  return names;
}

export function fileScope(source: ts.SourceFile): Scope {
  const scope = new Scope(namesWrittenThrough(source));
  declareStatements(scope, source.statements);
  return scope;
}

/** A function's scope: its parameters, then the declarations at the top of its body. */
export function functionScope(fn: ts.SignatureDeclaration, body: readonly ts.Statement[], parent: Scope): Scope {
  const scope = new Scope(parent.mutated, parent);
  for (const parameter of fn.parameters) declareUnknown(scope, parameter.name);
  declareStatements(scope, body);
  return scope;
}

const SLOT_BYTES = 8;

export interface Evaluator {
  /** The value, and the constant declarations it read, which the caller claims when it keeps the value. */
  evaluate(expression: ts.Expression, scope: Scope): { value: Evaluated; reads: ReadonlySet<ts.VariableDeclaration> };
}

export function createEvaluator(budget: ImportBudget): Evaluator {
  const sizes = new WeakMap<object, number>();
  const known = new Map<Binding, { value: Evaluated; reads: Set<ts.VariableDeclaration> }>();
  const resolving = new Set<Binding>();

  const sizeOf = (value: StaticValue): number => {
    if (typeof value === 'string') return value.length;
    if (typeof value === 'object' && value !== null) return sizes.get(value) ?? SLOT_BYTES;
    return SLOT_BYTES;
  };

  const sized = <T extends object>(value: T, size: number): T => {
    sizes.set(value, size);
    return value;
  };

  function readConstant(binding: Extract<Binding, { kind: 'const' }>, depth: number, reads: Set<ts.VariableDeclaration>): Evaluated {
    let result = known.get(binding);
    if (!result) {
      // Two constants reading each other have no value, and would otherwise branch per level.
      if (resolving.has(binding)) return UNKNOWN;
      resolving.add(binding);
      const own = new Set<ts.VariableDeclaration>([binding.declaration]);
      result = { value: run(binding.init, binding.scope, depth + 1, own), reads: own };
      resolving.delete(binding);
      known.set(binding, result);
    }
    const { value } = result;
    if (typeof value === 'object' && value !== null && binding.scope.mutated.has(binding.name)) return UNKNOWN;
    for (const read of result.reads) reads.add(read);
    return value;
  }

  function runArray(node: ts.ArrayLiteralExpression, scope: Scope, depth: number, reads: Set<ts.VariableDeclaration>): Evaluated {
    const parts: StaticValue[][] = [];
    let size = 0;
    for (const element of node.elements) {
      if (ts.isOmittedExpression(element)) return UNKNOWN;
      const value = run(ts.isSpreadElement(element) ? element.expression : element, scope, depth + 1, reads);
      if (value === UNKNOWN) return UNKNOWN;
      if (ts.isSpreadElement(element) && !Array.isArray(value)) return UNKNOWN;
      const items = ts.isSpreadElement(element) ? (value as StaticValue[]) : [value];
      size += ts.isSpreadElement(element) ? sizeOf(value) : sizeOf(value) + SLOT_BYTES;
      parts.push(items);
    }
    budget.chargeEvaluated(size);
    return sized(parts.flat(1), size);
  }

  function keyOf(name: ts.PropertyName, scope: Scope, depth: number, reads: Set<ts.VariableDeclaration>): string | undefined {
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
    if (!ts.isComputedPropertyName(name)) return undefined;
    const value = run(name.expression, scope, depth + 1, reads);
    return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
  }

  function runObject(node: ts.ObjectLiteralExpression, scope: Scope, depth: number, reads: Set<ts.VariableDeclaration>): Evaluated {
    const out = Object.create(null) as StaticObject;
    let size = 0;
    const set = (key: string, value: StaticValue) => {
      size += key.length + sizeOf(value) + SLOT_BYTES;
      budget.chargeEvaluated(key.length + sizeOf(value) + SLOT_BYTES);
      out[key] = value;
    };
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        const value = run(property.expression, scope, depth + 1, reads);
        if (value === null || value === undefined || value === false) continue;
        if (value === UNKNOWN || typeof value !== 'object' || Array.isArray(value)) return UNKNOWN;
        for (const key of Object.keys(value)) set(key, value[key]);
        continue;
      }
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return UNKNOWN;
      const key = keyOf(property.name, scope, depth, reads);
      // A literal's `__proto__` sets a prototype rather than a key, and no object here has one.
      if (key === undefined || key === '__proto__') return UNKNOWN;
      const value = run(ts.isPropertyAssignment(property) ? property.initializer : property.name, scope, depth + 1, reads);
      if (value === UNKNOWN) return UNKNOWN;
      set(key, value);
    }
    return sized(out, size);
  }

  function runMember(node: ts.PropertyAccessExpression | ts.ElementAccessExpression, scope: Scope, depth: number, reads: Set<ts.VariableDeclaration>): Evaluated {
    const base = run(node.expression, scope, depth + 1, reads);
    if (base === UNKNOWN) return UNKNOWN;
    if ((base === null || base === undefined) && node.questionDotToken) return undefined;
    if (typeof base !== 'object' || base === null) return UNKNOWN;
    const key = ts.isPropertyAccessExpression(node) ? node.name.text : run(node.argumentExpression, scope, depth + 1, reads);
    if (typeof key !== 'string' && typeof key !== 'number') return UNKNOWN;
    if (Array.isArray(base)) {
      if (key === 'length') return base.length;
      return typeof key === 'number' && Number.isInteger(key) && key >= 0 && key < base.length ? base[key] : UNKNOWN;
    }
    return Object.hasOwn(base, key) ? base[key] : UNKNOWN;
  }

  function runTemplate(node: ts.TemplateExpression, scope: Scope, depth: number, reads: Set<ts.VariableDeclaration>): Evaluated {
    const pieces = [node.head.text];
    let size = node.head.text.length;
    for (const span of node.templateSpans) {
      const value = run(span.expression, scope, depth + 1, reads);
      if (value === UNKNOWN || (typeof value === 'object' && value !== null)) return UNKNOWN;
      const text = String(value);
      pieces.push(text, span.literal.text);
      size += text.length + span.literal.text.length;
    }
    budget.chargeEvaluated(size);
    return pieces.join('');
  }

  function runLogical(node: ts.BinaryExpression, scope: Scope, depth: number, reads: Set<ts.VariableDeclaration>): Evaluated {
    const operator = node.operatorToken.kind;
    if (operator !== ts.SyntaxKind.AmpersandAmpersandToken && operator !== ts.SyntaxKind.BarBarToken && operator !== ts.SyntaxKind.QuestionQuestionToken) return UNKNOWN;
    const left = run(node.left, scope, depth + 1, reads);
    if (left === UNKNOWN) return UNKNOWN;
    const takesLeft = operator === ts.SyntaxKind.AmpersandAmpersandToken ? !left
      : operator === ts.SyntaxKind.BarBarToken ? Boolean(left)
        : left !== null && left !== undefined;
    return takesLeft ? left : run(node.right, scope, depth + 1, reads);
  }

  function run(node: ts.Expression, scope: Scope, depth: number, reads: Set<ts.VariableDeclaration>): Evaluated {
    if (depth > IMPORT_LIMITS.evalDepth) return UNKNOWN;
    // A step pays too, so a table read many times costs what it does.
    budget.chargeEvaluated(1);
    if (ts.isStringLiteralLike(node)) {
      budget.chargeEvaluated(node.text.length);
      return node.text;
    }
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isIdentifier(node)) {
      const binding = scope.lookup(node.text);
      if (!binding) return node.text === 'undefined' ? undefined : UNKNOWN;
      return binding.kind === 'const' ? readConstant(binding, depth, reads) : UNKNOWN;
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
      const value = run(node.operand, scope, depth + 1, reads);
      return typeof value === 'number' ? -value : UNKNOWN;
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) {
      return run(node.expression, scope, depth + 1, reads);
    }
    if (ts.isTemplateExpression(node)) return runTemplate(node, scope, depth, reads);
    if (ts.isArrayLiteralExpression(node)) return runArray(node, scope, depth, reads);
    if (ts.isObjectLiteralExpression(node)) return runObject(node, scope, depth, reads);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return runMember(node, scope, depth, reads);
    if (ts.isConditionalExpression(node)) {
      const test = run(node.condition, scope, depth + 1, reads);
      if (test === UNKNOWN) return UNKNOWN;
      return run(test ? node.whenTrue : node.whenFalse, scope, depth + 1, reads);
    }
    if (ts.isBinaryExpression(node)) return runLogical(node, scope, depth, reads);
    return UNKNOWN;
  }

  return {
    evaluate(expression, scope) {
      const reads = new Set<ts.VariableDeclaration>();
      const value = run(expression, scope, 0, reads);
      return { value, reads };
    },
  };
}

/** A value as stored data, on ordinary objects: only keys the evaluator wrote, and never `__proto__`. */
export function toPlain(value: StaticValue): unknown {
  if (Array.isArray(value)) return value.map(toPlain);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.keys(value).map((key) => [key, toPlain(value[key])]));
  }
  return value;
}
