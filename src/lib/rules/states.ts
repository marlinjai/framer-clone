// src/lib/rules/states.ts
//
// The states the panel names. A state is nothing but a rule it knows how to name,
// so one that arrived some other way (an import, say) reads as that state too. See
// docs/plans/2026-11-02-selector-styling.md, "The named states".
//
// Their order is the order of the list: named states come first, in this order,
// and authored rules follow. Pressed is last because pressing also hovers, and a
// later rule wins a tie.

import { isDefinitionRule, type StoredRule } from './rules';

export type NamedStateId = 'hover' | 'focused' | 'pressed';

export interface NamedState {
  id: NamedStateId;
  label: string;
  selector: string;
  at?: readonly string[];
  /** The states also active whenever this one is, so a preview shows them together. */
  implies: readonly NamedStateId[];
}

/** A tap would otherwise leave hover stuck on a phone. */
export const HOVER_GATE = '@media (hover:hover) and (pointer:fine)';

export const NAMED_STATES: readonly NamedState[] = [
  { id: 'hover', label: 'Hover', selector: '&:hover', at: [HOVER_GATE], implies: [] },
  // Keyboard focus, without an outline after a mouse click on a button.
  { id: 'focused', label: 'Focused', selector: '&:focus-visible', implies: [] },
  { id: 'pressed', label: 'Pressed', selector: '&:active', implies: ['hover'] },
];

/** The named state with this id, if it is one. */
export function namedState(id: string): NamedState | undefined {
  return NAMED_STATES.find((state) => state.id === id);
}

/** The state a stored rule is, by what it does rather than by its id. */
export function namedStateOf(rule: StoredRule): NamedState | undefined {
  if (isDefinitionRule(rule)) return undefined;
  const at = rule.at ?? [];
  return NAMED_STATES.find(
    (state) =>
      state.selector === rule.selector &&
      (state.at ?? []).length === at.length &&
      (state.at ?? []).every((wrapper, index) => wrapper === at[index]),
  );
}

/**
 * The rules active while `id` is: what it implies first, then itself. Previewing
 * Pressed activates Hover too, because a pointer press shows Hover's values plus
 * Pressed's. Any other rule is just itself.
 */
export function activeWith(id: string): string[] {
  return [...(namedState(id)?.implies ?? []), id];
}

/** The index of the rule `id` names: its own id, or the state it is. -1 when absent. */
export function findRuleIndex(rules: readonly StoredRule[], id: string): number {
  const own = rules.findIndex((rule) => rule.id === id);
  return own !== -1 ? own : rules.findIndex((rule) => namedStateOf(rule)?.id === id);
}

const stateRank = (rule: StoredRule): number => {
  const state = namedStateOf(rule);
  return state ? NAMED_STATES.indexOf(state) : NAMED_STATES.length;
};

/** The list with named states first, in their order, and everything else in its order. */
export function orderRules(rules: readonly StoredRule[]): StoredRule[] {
  return rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => stateRank(a.rule) - stateRank(b.rule) || a.index - b.index)
    .map(({ rule }) => rule);
}

/**
 * The list with the rule at `id` moved to `toIndex`. A named state keeps its place
 * and an authored rule stays behind them, so the order above cannot be broken.
 */
export function moveRuleTo(rules: readonly StoredRule[], id: string, toIndex: number): StoredRule[] {
  const from = findRuleIndex(rules, id);
  if (from === -1 || namedStateOf(rules[from])) return [...rules];
  const firstAuthored = rules.filter((rule) => namedStateOf(rule)).length;
  const rest = rules.filter((_, index) => index !== from);
  const to = Math.min(Math.max(toIndex, firstAuthored), rest.length);
  return [...rest.slice(0, to), rules[from], ...rest.slice(to)];
}
