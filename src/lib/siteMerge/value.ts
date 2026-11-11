// src/lib/siteMerge/value.ts
//
// The three-way merge of one value (docs/plans/2026-11-10-site-branches.md, section 5, rules 1, 2, 3 and 5):
// base, main and branch. A side that left the value as it was in the base takes the other side's; the same
// change on both sides is taken once; two different changes are a conflict. A value the caller says is split
// (a node's `props`, its style, a responsive value, the business data) is merged per key, so changes to
// different keys never conflict; anything else (text, a list, a binding) is one value, never spliced.
//
// PURE: no React, no MobX. Client and server safe.

import { stableStringify } from '@/lib/ai/serializers/normalize';

/** Where a value sits inside its unit, as keys (`['props', 'style', 'color', 'base']`). */
export type ValuePath = readonly string[];

/** A part both sides changed differently: the person picks main's value or the branch's. */
export interface ValueConflict {
  path: ValuePath;
  base: unknown;
  main: unknown;
  branch: unknown;
}

/**
 * Whether the value at `path` is merged per key (only ever asked when every side that has it is a plain
 * object). `sides` are base, main and branch at that path, so a rule can look at the shape (a responsive value).
 */
export type SplitRule = (path: ValuePath, sides: readonly [unknown, unknown, unknown]) => boolean;

/** The answer to a conflict at a path, when one was given and still applies. */
export type PickAt = (path: ValuePath, conflict: ValueConflict) => 'main' | 'branch' | undefined;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Deep equality of JSON values. A key holding `undefined` equals a missing key, as in stored JSON. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (typeof a !== typeof b || typeof a !== 'object') return false;
  // Dates (a loaded document's timestamps) compare by time.
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => jsonEqual(item, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const key of keys) if (!jsonEqual(ao[key], bo[key])) return false;
  return true;
}

/**
 * A short fingerprint of some values (FNV-1a, 64 bits as two 32-bit halves, hex). Not a secret and not
 * collision-proof against an attacker: it tells an answer given for these values from one given for others.
 */
export function fingerprint(...values: unknown[]): string {
  // Sorted keys, `undefined` left out, dates as text: equal values give equal text (`undefined` gives '').
  const text = values.map((value) => stableStringify(value) ?? '').join('\u0000');
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export interface ValueMerge {
  /** The merged value; `undefined` means absent. Where a conflict has no answer, main's value stands in. */
  value: unknown;
  /** The conflicts without an answer that still applies. */
  conflicts: ValueConflict[];
  /** Whether the branch changed anything here (the merged value differs from main's). */
  changed: boolean;
}

/**
 * Merge one value three ways. `split` names the paths merged per key; `pick` answers a conflict at a path
 * (main's or the branch's value), or leaves it open (main's value stands in and the conflict is reported).
 */
export function mergeValue(
  base: unknown,
  main: unknown,
  branch: unknown,
  options: { path?: ValuePath; split?: SplitRule; pick?: PickAt } = {},
): ValueMerge {
  const path = options.path ?? [];
  const conflicts: ValueConflict[] = [];
  const value = merge(base, main, branch, path, options.split ?? (() => false), options.pick, conflicts);
  return { value, conflicts, changed: !jsonEqual(value, main) };
}

function merge(
  base: unknown,
  main: unknown,
  branch: unknown,
  path: ValuePath,
  split: SplitRule,
  pick: PickAt | undefined,
  conflicts: ValueConflict[],
): unknown {
  if (jsonEqual(main, branch)) return main; // rule 2, and nothing changed
  if (jsonEqual(base, main)) return branch; // rule 1 (and 5: removed on the branch)
  if (jsonEqual(base, branch)) return main; // rule 1 (and 5: removed on main)
  const sides = [base, main, branch].filter((v) => v !== undefined);
  if (main !== undefined && branch !== undefined && sides.every(isPlainObject) && split(path, [base, main, branch])) {
    const b = (base ?? {}) as Record<string, unknown>;
    const m = main as Record<string, unknown>;
    const r = branch as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    // Own properties only: a key such as `constructor` or `__proto__` is data, never inherited.
    const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
    const get = (o: Record<string, unknown>, k: string) => (has(o, k) ? o[k] : undefined);
    // Main's key order first, then keys only the branch has, in its order.
    const keys = [...Object.keys(m), ...Object.keys(r).filter((k) => !has(m, k)), ...Object.keys(b).filter((k) => !has(m, k) && !has(r, k))];
    for (const key of keys) {
      const merged = merge(get(b, key), get(m, key), get(r, key), [...path, key], split, pick, conflicts);
      if (merged !== undefined) Object.defineProperty(out, key, { value: merged, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  const conflict: ValueConflict = { path, base, main, branch };
  const answer = pick?.(path, conflict);
  if (answer === 'branch') return branch;
  if (answer === 'main') return main;
  conflicts.push(conflict); // rule 3
  return main;
}
