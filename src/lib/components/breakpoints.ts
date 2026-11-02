// src/lib/components/breakpoints.ts
//
// A definition's breakpoints are its own, and they are mapped to a page's by
// width. Breakpoint ids are random per page, so a map keyed on one page's ids
// means nothing on another. `definitionBreakpointFor` is the one mapping, D(P) in
// docs/plans/2026-11-02-reusable-components.md:
//
//   D(P) = the definition breakpoint with the largest minWidth <= P.minWidth,
//          or the definition's smallest when none is.
//
// The published page rewrites each map through it. The canvas resolves live at
// D(P). Create component runs the same rewrite the other way, from a page's
// breakpoints to the new definition's.
//
// PURE: no React, no MST. Client and server safe.

import { isResponsiveMap, largestFirst, resolveCascade, type BreakpointRef } from '@/lib/responsive/cascade';

/** D(P): which of `breakpoints` serves a frame of this width. Undefined only when there are none. */
export function definitionBreakpointFor(
  minWidth: number,
  breakpoints: readonly BreakpointRef[],
): BreakpointRef | undefined {
  const ordered = largestFirst(breakpoints);
  return ordered.find(b => b.minWidth <= minWidth) ?? ordered[ordered.length - 1];
}

/**
 * A responsive map keyed on `from`, rewritten for `to`. The largest of `to` takes
 * `base`, and any other takes its own key only where it differs from the next
 * larger one's. With the same frames on both sides this is an exact rename. A
 * plain value passes through. With no frames in `to`, which the published path
 * allows, only the base survives: a map keyed on nothing would lose it.
 */
export function mapResponsiveValue(
  value: unknown,
  from: readonly BreakpointRef[],
  to: readonly BreakpointRef[],
): unknown {
  if (!isResponsiveMap(value, new Set(from.map(b => b.id)))) return value;
  const out: Record<string, unknown> = {};
  if (to.length === 0) {
    const base = resolveCascade(value, undefined, from).value;
    if (base !== undefined) out.base = base;
    return out;
  }
  let previous: unknown;
  largestFirst(to).forEach((target, index) => {
    const resolved = resolveCascade(value, definitionBreakpointFor(target.minWidth, from)?.id, from).value;
    if (index === 0) {
      if (resolved !== undefined) out.base = resolved;
    } else if (resolved !== undefined && resolved !== previous) {
      out[target.id] = resolved;
    }
    previous = resolved;
  });
  return out;
}

export function mapValues(record: unknown, from: readonly BreakpointRef[], to: readonly BreakpointRef[]): unknown {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, mapResponsiveValue(value, from, to)]));
}

/**
 * Every responsive map a node's props hold, rewritten: top-level props, `style`,
 * each rule's `style`, each `effects` group and, on a nested placement, its
 * input values. `children` and `query` are content, never maps.
 */
export function mapNodeProps(
  props: Record<string, unknown>,
  from: readonly BreakpointRef[],
  to: readonly BreakpointRef[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(props)) {
    if (name === 'children' || name === 'query') {
      out[name] = value;
    } else if (name === 'style' || name === 'effects' || name === 'inputs') {
      out[name] = mapValues(value, from, to);
    } else if (name === 'rules' && Array.isArray(value)) {
      out[name] = value.map(rule =>
        rule && typeof rule === 'object' && 'style' in rule
          ? { ...rule, style: mapValues((rule as { style: unknown }).style, from, to) }
          : rule,
      );
    } else {
      out[name] = mapResponsiveValue(value, from, to);
    }
  }
  return out;
}
