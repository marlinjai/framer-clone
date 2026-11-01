import { describe, expect, it } from 'vitest';
import { parseRule, type StoredRule } from '@/lib/rules/rules';
import {
  HOVER_GATE,
  NAMED_STATES,
  activeWith,
  findRuleIndex,
  moveRuleTo,
  namedState,
  namedStateOf,
  orderRules,
} from '@/lib/rules/states';

const hover: StoredRule = { id: 'r1', selector: '&:hover', at: [HOVER_GATE], style: {} };
const focused: StoredRule = { id: 'r2', selector: '&:focus-visible', style: {} };
const pressed: StoredRule = { id: 'r3', selector: '&:active', style: {} };
const custom = (id: string): StoredRule => ({ id, selector: '&:nth-child(2n)', style: {} });

describe('the named states', () => {
  it('are in the contract order, Pressed last because pressing also hovers', () => {
    expect(NAMED_STATES.map((state) => state.label)).toEqual(['Hover', 'Focused', 'Pressed']);
  });

  it('each parse as a rule', () => {
    for (const state of NAMED_STATES) {
      expect(parseRule({ id: state.id, selector: state.selector, at: state.at && [...state.at], style: {} })).toMatchObject({ ok: true });
    }
  });

  it('are gated on a real pointer for Hover, so a tap does not stick', () => {
    expect(namedState('hover')?.at).toEqual(['@media (hover:hover) and (pointer:fine)']);
    expect(namedState('focused')?.selector).toBe('&:focus-visible');
    expect(namedState('nope')).toBeUndefined();
  });

  it('are recognised by what a rule does, not by its id, so an import reads as Hover', () => {
    expect(namedStateOf(hover)?.id).toBe('hover');
    expect(namedStateOf(pressed)?.id).toBe('pressed');
    expect(namedStateOf({ id: 'hover', selector: '&:hover', style: {} })).toBeUndefined();
    expect(namedStateOf({ id: 'x', selector: '&:hover', at: [HOVER_GATE, '@media print'], style: {} })).toBeUndefined();
    expect(namedStateOf({ id: 'x', define: '@font-face', style: { fontFamily: 'u-x' } })).toBeUndefined();
  });

  it('activate what they imply, so previewing Pressed shows Hover too', () => {
    expect(activeWith('pressed')).toEqual(['hover', 'pressed']);
    expect(activeWith('hover')).toEqual(['hover']);
    expect(activeWith('focused')).toEqual(['focused']);
    expect(activeWith('r9')).toEqual(['r9']);
  });
});

describe('the order of the list', () => {
  it('puts named states first, in their order, and keeps authored rules in theirs', () => {
    const ordered = orderRules([custom('a'), pressed, custom('b'), hover, focused]);
    expect(ordered.map((rule) => rule.id)).toEqual(['r1', 'r2', 'r3', 'a', 'b']);
  });

  it('finds a rule by its own id first, then by the state it is', () => {
    const rules = [hover, custom('a')];
    expect(findRuleIndex(rules, 'a')).toBe(1);
    expect(findRuleIndex(rules, 'hover')).toBe(0);
    expect(findRuleIndex(rules, 'pressed')).toBe(-1);
  });

  it('moves an authored rule among authored rules', () => {
    const rules = [hover, custom('a'), custom('b'), custom('c')];
    expect(moveRuleTo(rules, 'c', 1).map((rule) => rule.id)).toEqual(['r1', 'c', 'a', 'b']);
    expect(moveRuleTo(rules, 'a', 3).map((rule) => rule.id)).toEqual(['r1', 'b', 'c', 'a']);
  });

  it('never lets an authored rule ahead of a named state', () => {
    expect(moveRuleTo([hover, focused, custom('a')], 'a', 0).map((rule) => rule.id)).toEqual(['r1', 'r2', 'a']);
    expect(moveRuleTo([hover, custom('a'), custom('b')], 'b', -5).map((rule) => rule.id)).toEqual(['r1', 'b', 'a']);
  });

  it('never moves a named state, an unknown rule or past the end', () => {
    const rules = [hover, custom('a')];
    expect(moveRuleTo(rules, 'r1', 1)).toEqual(rules);
    expect(moveRuleTo(rules, 'hover', 1)).toEqual(rules);
    expect(moveRuleTo(rules, 'nope', 1)).toEqual(rules);
    expect(moveRuleTo([hover, custom('a'), custom('b')], 'a', 99).map((rule) => rule.id)).toEqual(['r1', 'b', 'a']);
  });
});
