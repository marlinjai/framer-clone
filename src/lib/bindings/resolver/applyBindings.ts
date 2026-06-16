// Provider-free read-binding application.
//
// This module is PURE and React-free. It SUPERSEDES the wave-2
// `applyBindings(node, props, scope, dataSource)` signature: there is NO
// dataSource argument. Callers feed already-fetched rows in via the scope
// chain (see scope.ts), so this function only ever READS resolved values and
// merges them into props. That keeps the whole resolver Node-evaluable for
// the static-publish path.

import type { BindingsRecord, ReadBinding } from '@/lib/bindings/types';
import type { BindingScope } from './scope';
import { evaluateExpression, parseExpression } from './expression';

/** A render-time props bag. Mirrors ComponentModel's PropsRecord without
 *  importing the (React-coupled) model. */
export type Props = Record<string, unknown>;

/** Minimal structural view of a component node the resolver needs. The full
 *  node lives on the MST ComponentModel; we only read its binding map here so
 *  this module stays free of React / MST coupling. */
export interface ComponentNode {
  type?: string;
  bindings?: BindingsRecord;
}

/**
 * Sentinel a caller can place into a row value to signal that the underlying
 * data is still loading. When `applyBindings` resolves a slot to this value
 * it reports `isLoading: true` and leaves the base prop untouched.
 */
export const LOADING_SENTINEL: unique symbol = Symbol('binding.loading');

// Memoization per (binding, scope-snapshot). Scopes are immutable snapshots
// (every push* returns a new object), so caching by scope identity then by
// expression string is sound within (and across) render passes: identical
// inputs are pure and yield identical output. The WeakMap lets a render
// pass's scope objects be collected once the pass is done.
const memo = new WeakMap<BindingScope, Map<string, unknown>>();

function resolveBinding(scope: BindingScope, binding: ReadBinding): unknown {
  let perScope = memo.get(scope);
  if (!perScope) {
    perScope = new Map<string, unknown>();
    memo.set(scope, perScope);
  }
  const key = binding.expression;
  if (perScope.has(key)) return perScope.get(key);

  const parsed = parseExpression(binding.expression);
  const value = parsed ? evaluateExpression(parsed, scope) : undefined;
  perScope.set(key, value);
  return value;
}

/** Immutably set a dotted path (e.g. `style.color`) on a props bag, cloning
 *  each intermediate object so the caller's `baseProps` is never mutated. */
function setDeep(target: Props, path: string[], value: unknown): void {
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i];
    const next = cursor[segment];
    cursor[segment] =
      next && typeof next === 'object' && !Array.isArray(next)
        ? { ...(next as Record<string, unknown>) }
        : {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]] = value;
}

/**
 * Apply a node's READ bindings to its props against a scope.
 *
 * - `children` (and other plain slots) merge into the top-level prop. For a
 *   Text node this drives `props.children`.
 * - Dot-path slots (e.g. `style.color`) merge into the nested object.
 * - A slot whose expression cannot be parsed, or resolves to `undefined`, is
 *   left as the base value (no overwrite).
 * - Any slot resolving to `LOADING_SENTINEL` flips `isLoading` to true and is
 *   left as the base value.
 *
 * Non-read bindings (`write` / `two-way`) are ignored in Phase 1. The input
 * `baseProps` is never mutated; a shallow-then-deep copy is returned.
 */
export function applyBindings(
  node: ComponentNode,
  baseProps: Props,
  scope: BindingScope,
): { resolvedProps: Props; isLoading: boolean } {
  const resolvedProps: Props = { ...baseProps };
  let isLoading = false;

  const bindings = node.bindings ?? {};
  for (const [slot, entry] of Object.entries(bindings)) {
    if (!entry || entry.mode !== 'read') continue;

    const value = resolveBinding(scope, entry);
    if (value === LOADING_SENTINEL) {
      isLoading = true;
      continue;
    }
    if (value === undefined) continue;

    if (slot.includes('.')) {
      setDeep(resolvedProps, slot.split('.'), value);
    } else {
      resolvedProps[slot] = value;
    }
  }

  return { resolvedProps, isLoading };
}
