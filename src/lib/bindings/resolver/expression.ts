// Mustache-style read-binding expression parser + evaluator.
//
// This module is PURE and React-free. Phase 1 syntax is intentionally
// minimal: a SINGLE `{{path.segments}}` template, nothing else. There are
// no JS expressions, no filters/pipes, no method calls, no arithmetic. Any
// input that is not exactly one dotted identifier path returns `null` from
// parseExpression (e.g. `{{a + b}}`, `{{a | upper}}`, `{{a.b()}}`).

import type { BindingScope } from './scope';
import { lookup } from './scope';

export interface ParsedExpression {
  /** The original input string, verbatim. */
  raw: string;
  /** The dotted path split into identifier segments. */
  path: string[];
}

// Exactly one mustache pair wrapping a non-empty inner body. The inner body
// is captured non-greedily and surrounding whitespace is trimmed below. The
// `[^{}]` class forbids nested/extra braces.
const MUSTACHE = /^\{\{\s*([^{}]+?)\s*\}\}$/;

// A dotted path of JS-identifier segments and nothing else. Spaces,
// operators, parentheses and pipes all fail this test, which is how
// non-path expressions get rejected.
const PATH = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;

/**
 * Parse a binding expression string. Returns a ParsedExpression for a valid
 * single `{{path.segments}}` template, or `null` for anything else (including
 * non-strings, plain text, JS expressions, filters, and method calls).
 */
export function parseExpression(input: string): ParsedExpression | null {
  if (typeof input !== 'string') return null;
  const match = MUSTACHE.exec(input.trim());
  if (!match) return null;
  const inner = match[1].trim();
  if (!PATH.test(inner)) return null;
  return { raw: input, path: inner.split('.') };
}

/**
 * Evaluate a parsed expression against a scope. Delegates to `lookup`, so it
 * NEVER throws and returns `undefined` on any unknown path.
 */
export function evaluateExpression(
  expr: ParsedExpression,
  scope: BindingScope,
): unknown {
  return lookup(scope, expr.path);
}
