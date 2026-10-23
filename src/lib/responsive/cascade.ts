// src/lib/responsive/cascade.ts
//
// The one rule for responsive values (styles and responsive props), used by
// the editor canvas, the properties panel and the published page. See
// docs/plans/2026-10-23-breakpoint-style-inheritance.md.
//
// Desktop-first, like Framer: breakpoints are ordered by min width and the
// largest is the primary. A value for breakpoint B is B's own value, else the
// next larger breakpoint's, and so on up to the largest, else `base`. So an
// edit on Tablet reaches Phone unless Phone overrides it, and never reaches
// Desktop.
//
// Storage: `{ base, <breakpointId>: value, ... }`. Edits on the largest
// breakpoint write `base`; older projects may hold a value under the primary's
// id instead, which counts as the largest breakpoint's own value.

export interface BreakpointRef {
  id: string;
  minWidth: number;
}

/** Where a resolved value came from. */
export type CascadeSource =
  | { kind: 'own' }
  | { kind: 'inherited'; breakpointId: string }
  | { kind: 'base' }
  | { kind: 'none' };

export interface Resolved<T = unknown> {
  value: T | undefined;
  source: CascadeSource;
}

const has = (map: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(map, key) && map[key] !== undefined && map[key] !== '';

/** Largest first: the order values cascade in. */
export function largestFirst(breakpoints: readonly BreakpointRef[]): BreakpointRef[] {
  return [...breakpoints].sort((a, b) => b.minWidth - a.minWidth);
}

/** True for a stored responsive map (a plain object keyed by `base` or a breakpoint id). */
export function isResponsiveMap(value: unknown, breakpointIds: ReadonlySet<string>): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).some(k => k === 'base' || breakpointIds.has(k));
}

/**
 * Resolve a stored value for one breakpoint, with where it came from. A plain
 * (non-map) value applies everywhere and reports as `base`. An empty string
 * counts as unset, so a cleared override inherits again.
 */
export function resolveCascade<T = unknown>(
  stored: unknown,
  breakpointId: string | undefined,
  breakpoints: readonly BreakpointRef[],
): Resolved<T> {
  const ids = new Set(breakpoints.map(b => b.id));
  if (!isResponsiveMap(stored, ids)) {
    return stored === undefined || stored === ''
      ? { value: undefined, source: { kind: 'none' } }
      : { value: stored as T, source: { kind: 'base' } };
  }
  const map = stored;
  const ordered = largestFirst(breakpoints);
  // An unknown or missing breakpoint reads as the largest.
  const found = breakpointId ? ordered.findIndex(b => b.id === breakpointId) : 0;
  const start = Math.max(0, found);
  // Walk from B up to the largest (index 0).
  for (let i = start; i >= 0; i--) {
    const id = ordered[i]?.id;
    if (id && has(map, id)) {
      return { value: map[id] as T, source: i === start ? { kind: 'own' } : { kind: 'inherited', breakpointId: id } };
    }
  }
  if (has(map, 'base')) {
    // The base is the largest breakpoint's value: its own there, inherited
    // from it everywhere smaller.
    const primaryId = ordered[0]?.id;
    return {
      value: map.base as T,
      source: start === 0 || !primaryId ? { kind: 'own' } : { kind: 'inherited', breakpointId: primaryId },
    };
  }
  return { value: undefined, source: { kind: 'none' } };
}

/**
 * The stored value after an edit on `breakpointId`. The largest breakpoint (or
 * no breakpoint) writes `base` and drops a legacy primary-id key; a smaller one
 * writes its own override. An empty value on a smaller breakpoint removes the
 * override, so it inherits again. A map left with only `base` collapses to the
 * plain value.
 */
export function writeCascade(
  stored: unknown,
  value: unknown,
  breakpointId: string | undefined,
  breakpoints: readonly BreakpointRef[],
): unknown {
  const ids = new Set(breakpoints.map(b => b.id));
  const ordered = largestFirst(breakpoints);
  const primaryId = ordered[0]?.id;
  const isPrimary = !breakpointId || breakpointId === primaryId || !ids.has(breakpointId);
  const map: Record<string, unknown> = isResponsiveMap(stored, ids)
    ? { ...stored }
    : stored === undefined || stored === '' ? {} : { base: stored };

  if (isPrimary) {
    if (primaryId) delete map[primaryId];
    if (value === undefined || value === '') delete map.base;
    else map.base = value;
  } else if (value === undefined || value === '') {
    delete map[breakpointId!];
  } else {
    map[breakpointId!] = value;
  }

  const keys = Object.keys(map);
  if (keys.length === 0) return undefined;
  if (keys.length === 1 && keys[0] === 'base') return map.base;
  return map;
}

/** Remove the override on `breakpointId` (it inherits again). No-op on the largest breakpoint. */
export function resetCascade(stored: unknown, breakpointId: string, breakpoints: readonly BreakpointRef[]): unknown {
  const primaryId = largestFirst(breakpoints)[0]?.id;
  if (breakpointId === primaryId) return stored;
  return writeCascade(stored, undefined, breakpointId, breakpoints);
}
