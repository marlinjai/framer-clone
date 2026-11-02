// A compiled utility to flat entries: one selector, one list of wrappers, its declarations.
// Declarations gathered so far are flushed before any recursion, because Tailwind nests a
// colour and its `@supports` twin in one rule, in order, and walking children first
// turned every `/90` colour into the opaque fallback.
//
// The contract is docs/plans/2026-11-02-react-import.md, "Flattening".

import type { Container, Rule } from 'postcss';

export interface Declaration {
  property: string;
  value: string;
  important: boolean;
}

export interface FlatEntry {
  candidate: string;
  /** Its place in Tailwind's output, which is the cascade. */
  index: number;
  selector: string;
  /** Outermost first. */
  at: string[];
  declarations: Declaration[];
}

/** The wrapper around Tailwind's colour-mix value. Every browser Tailwind 4 supports has it. */
export const COLOR_MIX_SUPPORTS = '(color: color-mix(in lab, red, red))';

/** True when the text holds a comma outside brackets and strings, so it is a list. */
export function isSelectorList(text: string): boolean {
  let depth = 0;
  let quote = '';
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) return true;
  }
  return false;
}

/**
 * A nested selector with its parent in place of `&`, or null for a list inside a list, which would multiply
 * per level and which the rule format has no way to hold. Null becomes a refused rule, not a guess.
 */
function nest(parent: string, child: string): string | null {
  if (parent === '&') return child.includes('&') ? child : `& ${child}`;
  if (isSelectorList(parent)) return null;
  return child.includes('&') ? child.replace(/&/g, () => parent) : `${parent} ${child}`;
}

/** The candidate's flat entries, in order. A selector this cannot write is named in `refused`. */
export function flattenRule(rule: Rule, candidate: string, nextIndex: () => number, refused: (candidate: string) => void): FlatEntry[] {
  const entries: FlatEntry[] = [];
  const walk = (container: Container, selector: string, at: string[]) => {
    let pending: Declaration[] = [];
    const flush = () => {
      if (pending.length > 0) entries.push({ candidate, index: nextIndex(), selector, at, declarations: pending });
      pending = [];
    };
    container.each((child) => {
      if (child.type === 'decl') {
        pending.push({ property: child.prop, value: child.value, important: child.important === true });
      } else if (child.type === 'rule') {
        flush();
        const nested = nest(selector, child.selector);
        if (nested === null) refused(candidate);
        else walk(child, nested, at);
      } else if (child.type === 'atrule') {
        flush();
        const removed = child.name === 'supports' && child.params === COLOR_MIX_SUPPORTS;
        walk(child, selector, removed ? at : [...at, `@${child.name} ${child.params}`.trim()]);
      }
    });
    flush();
  };
  walk(rule, '&', []);
  return entries;
}

/** What a property can overlap with: `paddingLeft` and `paddingInline` are one family, and a custom property only itself. */
export function familyOf(key: string): string {
  if (key.startsWith('--')) return key;
  if (key === 'top' || key === 'right' || key === 'bottom' || key === 'left') return 'inset';
  if (key === 'rowGap' || key === 'columnGap') return 'gap';
  return /^[A-Z]?[a-z]+/.exec(key)?.[0] ?? key;
}

const setsFamily = (style: Record<string, unknown>, keys: readonly string[]): boolean => {
  const families = new Set(keys.map(familyOf));
  return Object.keys(style).some((key) => families.has(familyOf(key)));
};

export interface MergeableRule {
  selector: string;
  at?: string[];
  style: Record<string, unknown>;
}

const ruleKey = (rule: MergeableRule): string => `${rule.selector}|${(rule.at ?? []).join('|')}`;

/**
 * Rules with one selector and one set of wrappers become one, also when not adjacent, as long as no rule
 * between them sets a property the moved one sets. A repeated key is deleted and re-added, so it stays last.
 * Merging by selector alone is shorter, and passes only by luck of order.
 */
export function mergeRules<T extends MergeableRule>(rules: readonly T[]): T[] {
  const merged: T[] = [];
  for (const rule of rules) {
    const key = ruleKey(rule);
    const keys = Object.keys(rule.style);
    let target: T | undefined;
    for (let i = merged.length - 1; i >= 0; i -= 1) {
      if (ruleKey(merged[i]) === key) {
        target = merged[i];
        break;
      }
      if (setsFamily(merged[i].style, keys)) break;
    }
    if (!target) {
      merged.push({ ...rule, style: { ...rule.style } });
      continue;
    }
    for (const property of keys) {
      delete target.style[property];
      target.style[property] = rule.style[property];
    }
  }
  return merged;
}
