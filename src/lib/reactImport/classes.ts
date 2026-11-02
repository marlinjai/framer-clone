// What a `className` holds, as data for layer 2. Candidates come from the value through
// the evaluator and from the arguments of a class helper, never from a scan of strings,
// because a scan reads words that are not classes. A helper is known by the module it is
// imported from, never by what a function looks like.
//
// The contract is docs/plans/2026-11-02-react-import.md, "Layer 2: Tailwind", "Extraction".

import ts from 'typescript';
import { UNKNOWN, type Evaluated, type Evaluator, type Scope, type StaticValue } from './staticEval';

/** How a helper treats its arguments. `merge` runs the real `tailwind-merge` over them, as the original does. */
type Helper = { merge: boolean; assumed?: true };

/**
 * The class helpers, by module and the name they are exported under. `cn` from `@/lib/utils` is shadcn's
 * `twMerge(clsx(inputs))`. Its body is not read here, so it is assumed, and the line says so.
 */
const HELPERS: Readonly<Record<string, Readonly<Record<string, Helper>>>> = {
  clsx: { clsx: { merge: false }, default: { merge: false } },
  classnames: { default: { merge: false } },
  'tailwind-merge': { twMerge: { merge: true } },
  '@/lib/utils': { cn: { merge: true, assumed: true } },
};

export interface HelperImport {
  helper: Helper;
  /** The import that brings it, to claim when a class string reads it. */
  declaration: ts.ImportDeclaration;
}

/** The class helpers a file imports, by the local name they go by. */
export function helperImports(source: ts.SourceFile): Map<string, HelperImport> {
  const found = new Map<string, HelperImport>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    const specifier = statement.moduleSpecifier.text;
    if (!clause || clause.isTypeOnly || !Object.hasOwn(HELPERS, specifier)) continue;
    const exported = HELPERS[specifier];
    if (clause.name && Object.hasOwn(exported, 'default')) found.set(clause.name.text, { helper: exported.default, declaration: statement });
    const bindings = clause.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const name = (element.propertyName ?? element.name).text;
      if (Object.hasOwn(exported, name)) found.set(element.name.text, { helper: exported[name], declaration: statement });
    }
  }
  return found;
}

export interface ReadClasses {
  /** In source order. */
  classes: string[];
  /** A helper that merges wraps them. */
  merged: boolean;
  /** A piece is only known when the component runs. */
  dynamic: boolean;
  /** Constants the value read, to claim when it is kept. */
  reads: Set<ts.VariableDeclaration>;
  /** The helper imports it called. */
  helpers: Set<HelperImport>;
}

const tokensOf = (text: string): string[] => text.split(/\s+/).filter(Boolean);

/** Whether a value counts as present inside `clsx`: its truthiness, as the original computes it. */
const isPresent = (value: StaticValue): boolean => Boolean(value);

/** Adds what a `clsx` argument contributes. Unknown pieces make the list dynamic, never a guess. */
function addValue(value: Evaluated, out: ReadClasses): void {
  if (value === UNKNOWN) {
    out.dynamic = true;
    return;
  }
  if (typeof value === 'string') out.classes.push(...tokensOf(value));
  else if (typeof value === 'number') {
    // `clsx(1)` gives "1": a class nothing compiles, which layer 2 reports.
    if (value !== 0 && Number.isFinite(value)) out.classes.push(String(value));
  } else if (Array.isArray(value)) {
    for (const each of value) addValue(each, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) if (isPresent(value[key])) out.classes.push(...tokensOf(key));
  }
}

/** The callee of a helper call, when it is one this file imports and nothing inside shadows. */
function helperOf(call: ts.CallExpression, scope: Scope, imports: ReadonlyMap<string, HelperImport>): HelperImport | undefined {
  if (!ts.isIdentifier(call.expression) || call.typeArguments || call.questionDotToken) return undefined;
  if (scope.lookup(call.expression.text) !== undefined) return undefined;
  return imports.get(call.expression.text);
}

/** One expression of a class list: a helper call read argument by argument, anything else through the evaluator. */
function addExpression(expression: ts.Expression, scope: Scope, evaluator: Evaluator, imports: ReadonlyMap<string, HelperImport>, out: ReadClasses): void {
  let inner = expression;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isSatisfiesExpression(inner) || ts.isNonNullExpression(inner)) inner = inner.expression;
  if (ts.isCallExpression(inner)) {
    const used = helperOf(inner, scope, imports);
    if (!used) {
      out.dynamic = true;
      return;
    }
    out.helpers.add(used);
    if (used.helper.merge) out.merged = true;
    for (const argument of inner.arguments) {
      // `clsx(...list)` takes each item as an argument, which is what reading the list as one array gives.
      if (ts.isSpreadElement(argument)) addValue(evaluate(argument.expression), out);
      else addExpression(argument, scope, evaluator, imports, out);
    }
    return;
  }
  addValue(evaluate(inner), out);

  function evaluate(each: ts.Expression): Evaluated {
    const { value, reads } = evaluator.evaluate(each, scope);
    for (const read of reads) out.reads.add(read);
    return value;
  }
}

/** The classes of a `className` value. A string literal holds them all; anything else is read as far as it can be. */
export function readClassValue(expression: ts.Expression, scope: Scope, evaluator: Evaluator, imports: ReadonlyMap<string, HelperImport>): ReadClasses {
  const out: ReadClasses = { classes: [], merged: false, dynamic: false, reads: new Set(), helpers: new Set() };
  addExpression(expression, scope, evaluator, imports, out);
  return out;
}
