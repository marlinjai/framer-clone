// src/lib/rules/states.ts
//
// The states the panel names. A state is nothing but a rule it knows how to name,
// so one that arrived some other way (an import, say) reads as that state too. See
// docs/plans/2026-11-02-selector-styling.md, "The named states".
//
// Their order is the order of the list: named states come first, in this order,
// and authored rules follow. Pressed is last because pressing also hovers, and a
// later rule wins a tie. A component's state rules come after both, in the order
// of the component's states, so a later state wins a tie whatever its kind (see
// docs/plans/2026-11-02-reusable-components.md, "How it composes").

import { isDefinitionRule, type RuleDraft, type StoredRule } from './rules';

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

/**
 * Control states a page sets on an element (a shop control's button while it is
 * disabled or working), named in the panel when stored as a plain rule. They are
 * not named states: nothing previews them on the canvas but the control's own
 * state picker (src/lib/commerce/parts.ts).
 */
const CONTROL_STATE_LABELS: Readonly<Record<string, string>> = {
  '&:disabled': 'Disabled',
  '&[aria-busy="true"]': 'Loading',
};

/** The name a rule goes by in the panel: its state, its selector, or its condition when it applies to the node itself. */
export function ruleLabel(rule: StoredRule): string {
  if (isDefinitionRule(rule)) return rule.define;
  const state = namedStateOf(rule);
  if (state) return state.label;
  if ((rule.at ?? []).length === 0 && Object.hasOwn(CONTROL_STATE_LABELS, rule.selector)) return CONTROL_STATE_LABELS[rule.selector];
  const condition = (rule.at ?? []).join(' ');
  if (rule.selector === '&' && condition) return condition;
  return condition ? `${condition} ${rule.selector}` : rule.selector;
}

/**
 * A rule as a person means it: typing `:hover` asks for the Hover state, which is that
 * selector behind its gate. Anything else is left as it was written.
 */
export function asNamedState(rule: RuleDraft): RuleDraft {
  if ('define' in rule) return rule;
  const state = NAMED_STATES.find((candidate) => candidate.selector === rule.selector);
  return state?.at && (rule.at ?? []).length === 0 ? { ...rule, at: [...state.at] } : rule;
}

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

/**
 * What previewing `id` activates on a node: the stored rules, by id, and whether its
 * hover preset shows with them. `id` is a stored rule's own or a state's, which may
 * have no rule yet: Hover over a preset and nothing else is exactly that case.
 */
export function previewedBy(rules: readonly StoredRule[], id: string): { ids: Set<string>; hover: boolean } {
  const index = findRuleIndex(rules, id);
  const state = index === -1 ? namedState(id) : namedStateOf(rules[index]);
  const active = state ? activeWith(state.id) : [id];
  const found = active.map((rule) => findRuleIndex(rules, rule)).filter((at) => at !== -1);
  return { ids: new Set(found.map((at) => rules[at].id)), hover: state !== undefined && active.includes('hover') };
}

/** The stored id of a component state's rule on a node. */
export const stateRuleId = (stateId: string): string => `state-${stateId}`;

/**
 * The component state a stored rule belongs to, or undefined. Such a rule is
 * refused by the parser until expansion compiles it (src/lib/components/expand.ts).
 */
export function componentStateOf(rule: unknown): string | undefined {
  if (!rule || typeof rule !== 'object' || !('componentState' in rule)) return undefined;
  const { componentState } = rule as { componentState: unknown };
  return typeof componentState === 'string' ? componentState : '';
}

const stateRank = (rule: StoredRule): number => {
  if (componentStateOf(rule) !== undefined) return NAMED_STATES.length + 1;
  const state = namedStateOf(rule);
  return state ? NAMED_STATES.indexOf(state) : NAMED_STATES.length;
};

/** Where a component state's rule stands among the others: by the component's states, unknown ones last. */
const componentRank = (rule: StoredRule, stateOrder: readonly string[]): number => {
  const state = componentStateOf(rule);
  if (state === undefined) return 0;
  const at = stateOrder.indexOf(state);
  return at === -1 ? stateOrder.length : at;
};

/**
 * The list with named states first, in their order, then everything else in its
 * order, then a component's state rules in `stateOrder`, the component's states.
 */
export function orderRules(rules: readonly StoredRule[], stateOrder: readonly string[] = []): StoredRule[] {
  return rules
    .map((rule, index) => ({ rule, index }))
    .sort(
      (a, b) =>
        stateRank(a.rule) - stateRank(b.rule) ||
        componentRank(a.rule, stateOrder) - componentRank(b.rule, stateOrder) ||
        a.index - b.index,
    )
    .map(({ rule }) => rule);
}

/**
 * The list with the rule at `id` moved to `toIndex`. A named state keeps its place,
 * as does a component state's rule, and an authored rule stays between them, so
 * the order above cannot be broken.
 */
export function moveRuleTo(rules: readonly StoredRule[], id: string, toIndex: number): StoredRule[] {
  const from = findRuleIndex(rules, id);
  if (from === -1 || namedStateOf(rules[from]) || componentStateOf(rules[from]) !== undefined) return [...rules];
  const firstAuthored = rules.filter((rule) => namedStateOf(rule)).length;
  const rest = rules.filter((_, index) => index !== from);
  const lastAuthored = rest.filter((rule) => componentStateOf(rule) === undefined).length;
  const to = Math.min(Math.max(toIndex, firstAuthored), lastAuthored);
  return [...rest.slice(0, to), rules[from], ...rest.slice(to)];
}
