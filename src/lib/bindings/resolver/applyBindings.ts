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
import { isSafeSrc, safeHrefFromData } from '@/lib/links/safeHref';
import { cssValueText, isStyleMap, unsafeDeclaration } from '@/lib/responsive/responsiveCss';

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

const warnedStyles = new Set<string>();

function warnRefusedStyle(slot: string): void {
  if (warnedStyles.has(slot)) return;
  warnedStyles.add(slot);
  console.warn(`[bindings] left out a bound value of ${slot}: it would break out of its declaration`);
}

/**
 * A bound style value is checked as the stylesheet checks its own. A node with
 * only plain styles goes inline through React, which writes a value as it is, so
 * `red;background:url(https://track.example/x)` from a CMS cell would reach the
 * page. A responsive map, from a colour input, is checked per value.
 */
function isSafeBoundStyle(key: string, value: unknown): boolean {
  if (key.includes('.')) return true;
  const values = isStyleMap(value) ? Object.values(value) : [value];
  return values.every(entry => unsafeDeclaration(key, cssValueText(key, entry)) === null);
}

/** `{{input.image}}` or `{{input.image.src}}` on a background: an address, which CSS wants inside url(). */
function backgroundFromInput(value: unknown): unknown {
  const src = isStyleMap(value) ? value.src : value;
  if (typeof src !== 'string' || !isSafeSrc(src)) return value;
  return `url("${src.trim().replace(/"/g, '%22')}")`;
}

/** True when a binding reads the input frame. */
export function readsInput(binding: ReadBinding): boolean {
  return parseExpression(binding.expression)?.path[0] === 'input';
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
 * - The `href` slot only takes a safe link target (safeHrefFromData); anything
 *   else leaves the base value.
 * - A `style.*` slot only takes a value the stylesheet would take; anything else
 *   leaves the base value, with a warning.
 * - The `visible` slot is not a prop: the renderer reads it (hydrateBindings).
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
    if (!entry || entry.mode !== 'read' || slot === 'visible') continue;
    // Nothing is bound into a behaviour: the one way in is a component's `state`.
    if (slot === 'behaviour' || slot.startsWith('behaviour.')) continue;

    const resolved = resolveBinding(scope, entry);
    const value = slot === 'style.backgroundImage' && readsInput(entry) ? backgroundFromInput(resolved) : resolved;
    if (value === LOADING_SENTINEL) {
      isLoading = true;
      continue;
    }
    if (value === undefined) continue;
    // A bound link target comes from data (a CMS cell, a product): only a safe
    // one (src/lib/links/safeHref.ts, spaces encoded) replaces the element's own
    // address, so a `javascript:` value never reaches a published page.
    if (slot === 'href') {
      const href = safeHrefFromData(value);
      if (href !== null) resolvedProps.href = href;
      continue;
    }

    if (slot.startsWith('style.') && !isSafeBoundStyle(slot.slice('style.'.length), value)) {
      warnRefusedStyle(slot);
      continue;
    }

    if (slot.includes('.')) {
      setDeep(resolvedProps, slot.split('.'), value);
    } else {
      resolvedProps[slot] = value;
    }
  }

  return { resolvedProps, isLoading };
}
