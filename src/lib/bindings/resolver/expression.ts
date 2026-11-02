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

// Exactly one mustache pair wrapping a non-empty inner body, with surrounding
// whitespace trimmed and no nested or extra braces. By hand, because a pattern
// with whitespace on both sides of a lazy body is cubic on a stored value.
function mustacheBody(text: string): string | null {
  if (!text.startsWith('{{') || !text.endsWith('}}') || text.length < 4) return null;
  const inner = text.slice(2, -2);
  return inner.includes('{') || inner.includes('}') ? null : inner.trim();
}

// A dotted path of field segments and nothing else. A segment is one or more of
// the characters that appear in a binding key: JS-identifier characters PLUS the
// hyphen and a leading digit, because a CMS column id is a `uuid()` (e.g.
// `8f3a9c2e-1b4d-...`) and the binding picker emits `{{row.<columnId>}}`
// verbatim (BindingPicker.tsx). A grammar that rejected hyphens/leading digits
// would silently fail EVERY real CMS row-field binding (the unit-test fixtures
// only ever used clean ids like `title`, so they never exercised a real id).
// Spaces, operators, parentheses and pipes are still absent from the class, so
// `{{a + b}}` / `{{a | upper}}` / `{{a.b()}}` continue to be rejected.
const PATH = /^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*$/;

/**
 * Parse a binding expression string. Returns a ParsedExpression for a valid
 * single `{{path.segments}}` template, or `null` for anything else (including
 * non-strings, plain text, JS expressions, filters, and method calls).
 */
export function parseExpression(input: string): ParsedExpression | null {
  if (typeof input !== 'string') return null;
  const inner = mustacheBody(input.trim());
  if (!inner || !PATH.test(inner)) return null;
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
