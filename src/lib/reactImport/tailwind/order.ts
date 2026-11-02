// In what order an element's classes apply, which the source decides.
//
// With no `cn` or `twMerge` around the classes, Tailwind's output order is the cascade,
// never the order of the class string, because that is what the original does.
//
// With one around a table there is no single literal string: base, variant, size and
// `className` combine per placement. So rules go by source layer, with Tailwind's order
// inside a layer, and a later layer beats what `tailwind-merge` would have removed. The
// repo's own destructive button is the case: Tailwind sorts `ring-destructive` before
// `ring-ring`, so without layers the base's focus ring won.
//
// The contract is docs/plans/2026-11-02-react-import.md, "Order has two modes".

import { twMerge } from 'tailwind-merge';
import { familyOf } from './flatten';
import { styleKey, type RewrittenEntry } from './rewrites';

/** A `cva` table as data. Reading one from source is slice `import-props`. */
export interface VariantTable {
  base: readonly string[];
  /** In call order. */
  keys: readonly { key: string; values: Readonly<Record<string, readonly string[]>> }[];
  compound?: readonly { when: Readonly<Record<string, string>>; classes: readonly string[] }[];
}

/** One element's classes: a literal list, or a table. */
export interface ClassSource {
  classes?: readonly string[];
  table?: VariantTable;
  /** `cn` or `twMerge` wraps them, so the real `tailwind-merge` decides. */
  merged?: boolean;
}

/** One class in its place, with what must hold for it to apply. */
export interface PlacedClass {
  token: string;
  layer: number;
  /** Selector text after `&`: the `:where()` a variant or a displacement adds. It adds no specificity. */
  condition: string;
  /** The conditions under which `tailwind-merge` removes this class, each as attribute selectors. */
  displacedBy: string[];
  /** It stands in the base or a literal list, so it can reach Normal. */
  own: boolean;
}

export interface PlacedClasses {
  placed: PlacedClass[];
  /** Classes the real `tailwind-merge` removed from a literal list. */
  removed: string[];
  /** Order by layer, not by Tailwind's output alone. */
  layered: boolean;
}

const ATTRIBUTE_KEY = /^[a-z][a-z0-9-]*$/;
const ATTRIBUTE_VALUE = /^[A-Za-z0-9_-]+$/;

/** `iconPosition` to `icon-position`, the attribute's part of the name. Null for a key no attribute can hold. */
export function variantAttributeKey(key: string): string | null {
  const attribute = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  return ATTRIBUTE_KEY.test(attribute) ? attribute : null;
}

/** `[data-u-v-variant="outline"]`, or null. The element is given the attribute by slice `import-props`. */
export function variantSelector(key: string, value: string): string | null {
  const attribute = variantAttributeKey(key);
  return attribute !== null && ATTRIBUTE_VALUE.test(value) ? `[data-u-v-${attribute}="${value}"]` : null;
}

const mergedList = (tokens: readonly string[]): string[] => twMerge(tokens.join(' ')).split(/\s+/).filter(Boolean);

/** Base classes `tailwind-merge` removes when these join them. */
function displacedFrom(base: readonly string[], classes: readonly string[]): string[] {
  const kept = new Set(mergedList([...base, ...classes]));
  return base.filter((token) => !kept.has(token));
}

/** The order an element's classes apply in, and why, with no entry read yet. Null when a table's key or value cannot be an attribute. */
export function placeClasses(source: ClassSource): PlacedClasses | null {
  const { classes, table, merged = false } = source;
  if (!table) {
    const literal = classes ?? [];
    const kept = merged ? mergedList(literal) : [...literal];
    const remaining = new Set(kept);
    return {
      placed: kept.map((token) => ({ token, layer: 0, condition: '', displacedBy: [], own: true })),
      removed: literal.filter((token) => !remaining.has(token)),
      layered: false,
    };
  }
  const base = merged ? mergedList(table.base) : [...table.base];
  const placed: PlacedClass[] = base.map((token) => ({ token, layer: 0, condition: '', displacedBy: [], own: true }));
  const place = (tokens: readonly string[], layer: number, attributes: string): void => {
    const own = merged ? mergedList(tokens) : tokens;
    for (const token of own) placed.push({ token, layer, condition: `:where(${attributes})`, displacedBy: [], own: false });
    if (!merged) return;
    for (const token of displacedFrom(base, own)) {
      for (const each of placed) if (each.layer === 0 && each.token === token) each.displacedBy.push(attributes);
    }
  };
  let layer = 1;
  for (const { key, values } of table.keys) {
    for (const [value, tokens] of Object.entries(values)) {
      const attributes = variantSelector(key, value);
      if (attributes === null) return null;
      place(tokens, layer, attributes);
    }
    layer += 1;
  }
  for (const { when, classes: tokens } of table.compound ?? []) {
    const attributes = Object.entries(when).map(([key, value]) => variantSelector(key, value));
    if (attributes.length === 0 || attributes.some((each) => each === null)) return null;
    place(tokens, layer, attributes.join(''));
    layer += 1;
  }
  return { placed, removed: [], layered: merged };
}

/** One rewritten entry in its place. */
export interface PlacedEntry {
  rewritten: RewrittenEntry;
  placed: PlacedClass;
  /** The whole text after `&` this entry gains. */
  condition: string;
}

const entryKeys = ({ entry }: RewrittenEntry): string[] => entry.declarations.map(({ property }) => styleKey(property));
const sameTarget = (a: RewrittenEntry, b: RewrittenEntry): boolean =>
  a.entry.selector === b.entry.selector && a.entry.at.join('|') === b.entry.at.join('|');

/** Whether a later layer's entry beats this one by order alone: the same target, on a property it sets. */
function beatenByOrder(displaced: RewrittenEntry, winners: readonly RewrittenEntry[]): boolean {
  const families = new Set(entryKeys(displaced).map(familyOf));
  return winners.some((winner) => sameTarget(winner, displaced) && entryKeys(winner).some((key) => families.has(familyOf(key))));
}

/**
 * Every entry of an element in cascade order. A displaced entry under a selector no later layer shares cannot be
 * beaten by order, so it gains `:where(:not(...))`.
 */
export function orderEntries(classes: PlacedClasses, entriesOf: (token: string) => readonly RewrittenEntry[]): PlacedEntry[] {
  const byCondition = new Map<string, RewrittenEntry[]>();
  for (const { token, condition } of classes.placed) {
    if (condition === '') continue;
    const inner = condition.slice(':where('.length, -1);
    const own = byCondition.get(inner);
    if (own) own.push(...entriesOf(token));
    else byCondition.set(inner, [...entriesOf(token)]);
  }
  const placedEntries: PlacedEntry[] = [];
  for (const placed of classes.placed) {
    for (const rewritten of entriesOf(placed.token)) {
      const guards = placed.displacedBy
        .filter((attributes) => !beatenByOrder(rewritten, byCondition.get(attributes) ?? []))
        .map((attributes) => `:where(:not(${attributes}))`);
      placedEntries.push({ rewritten, placed, condition: `${placed.condition}${guards.join('')}` });
    }
  }
  const byOutput = (a: PlacedEntry, b: PlacedEntry) => a.rewritten.entry.index - b.rewritten.entry.index;
  return placedEntries.sort(classes.layered ? (a, b) => a.placed.layer - b.placed.layer || byOutput(a, b) : byOutput);
}
