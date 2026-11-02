// src/lib/behaviour/behaviourDom.ts
//
// What a behaviour writes into a page before anything runs, and how a condition
// reads it back. See docs/plans/2026-11-02-behaviour-model.md, "From stored data to
// a page". The published pass uses this now and the preview surface will, so both
// write the same attributes.
//
// State reaches CSS as `data-fcs-<id>` on the scope that declares it, so a rule class
// shared across rows reads each row's own ancestor. `text` state is never written:
// what a visitor types has no attribute. Everything here takes parsed behaviour,
// which is the only place a state id or a choice's value can have come from, and
// both are checked by the parser to be safe inside an attribute selector.
//
// PURE and client-safe: no React, no MST.

import { staticValue, type Binding, type Condition, type Expression, type StateValue } from './format';

/** Marks a scope: a node declaring state, a clone root, a placement root. */
export const SCOPE_ATTR = 'data-fc-scope';
/** The node's key: what a reference resolves and what keys the program. */
export const NODE_ATTR = 'data-fc-n';
/** A clone's position in its Collection. */
export const ROW_ATTR = 'data-fc-i';
/** Which of a shared key's program entries this element runs. Absent means the first. */
export const VARIANT_ATTR = 'data-fc-v';
/** The value of one state on its scope. */
export const stateAttribute = (id: string): string => `data-fcs-${id}`;
/** True for a stored attribute only this step may write, because the selectors and the runtime honour it. */
export const isIssuedAttribute = (name: string): boolean => /^data-fc(?:s-|-n$|-i$|-v$|-scope$)/i.test(name);

/** Written by a showWhen that compares with the row, which a shared rule class cannot. */
export const SHOW_ATTR = 'data-u-on';

const BOOLEAN_ATTRIBUTES: ReadonlySet<string> = new Set(['inert', 'open', 'disabled']);
/** A `value` prop would make React own the field, so a person could not change it. */
const FORM_CONTROLS: ReadonlySet<string> = new Set(['input', 'textarea', 'select']);

/** The attributes a scope writes for its state. `text` has none. */
export function stateAttributes(states: readonly StateValue[]): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const state of states) {
    if (state.type !== 'text') attributes[stateAttribute(state.id)] = String(state.initial);
  }
  return attributes;
}

/** One `eq` as a selector on the element or anything inside it. */
function stateSelector(id: string, eq: unknown): string {
  const holds = `[${stateAttribute(id)}="${String(eq)}"]`;
  return `:where(${holds} *, ${holds})`;
}

/**
 * A condition as selector text with no specificity, to chain onto a rule's class. A
 * parsed `when` holds no row, which a class shared across rows cannot read.
 */
export function conditionSelector(condition: Condition): string {
  if ('state' in condition) return stateSelector(condition.state, condition.eq);
  if ('not' in condition) return `:where(:not(${conditionSelector(condition.not)}))`;
  if ('all' in condition) return condition.all.map(conditionSelector).join('');
  return `:where(${condition.any.map(conditionSelector).join(', ')})`;
}

/** True when a condition compares with the row, so it has to become a binding. */
export function readsRow(condition: Condition): boolean {
  if ('state' in condition) return typeof condition.eq === 'object';
  if ('not' in condition) return readsRow(condition.not);
  return ('all' in condition ? condition.all : condition.any).some(readsRow);
}

/** A condition as an expression, for a binding. Parsed conditions are in the depth limit of both. */
export function conditionExpression(condition: Condition): Expression {
  if ('state' in condition) return { eq: [{ get: condition.state }, condition.eq] };
  if ('not' in condition) return { not: conditionExpression(condition.not) };
  if ('all' in condition) return { and: condition.all.map(conditionExpression) };
  return { or: condition.any.map(conditionExpression) };
}

/** True when an expression reads no state, so its value never changes on one element. */
export function isConstant(expression: Expression): boolean {
  if (typeof expression !== 'object') return true;
  if ('get' in expression || 'map' in expression) return false;
  if ('not' in expression) return isConstant(expression.not);
  for (const operator of ['eq', 'gt', 'lt', 'and', 'or', 'add', 'clamp'] as const) {
    if (operator in expression) return (expression as unknown as Record<string, Expression[]>)[operator].every(isConstant);
  }
  return 'row' in expression;
}

export interface BindingDom {
  attributes: Record<string, unknown>;
  /** Custom properties, for `style`. */
  style: Record<string, string>;
  /** The text of a text binding, when it has one at the first value. */
  text?: string;
}

function attributeOf(attr: string, value: unknown, tag: string | null): [string, unknown] {
  if (BOOLEAN_ATTRIBUTES.has(attr)) return [attr, Boolean(value)];
  return [attr === 'value' && tag !== null && FORM_CONTROLS.has(tag) ? 'defaultValue' : attr, String(value)];
}

/**
 * What bindings write at the first value of the state in reach. `read` gives a state's
 * initial value and `row` the clone's index, when there is one. A value that cannot be
 * known yet is left out: the runtime writes it.
 */
export function bindingDom(bindings: readonly Binding[], read: (id: string) => unknown, row: number | undefined, tag: string | null): BindingDom {
  const dom: BindingDom = { attributes: {}, style: {} };
  for (const binding of bindings) {
    const value = staticValue('text' in binding ? binding.text : binding.from, read, row);
    if (value === undefined) continue;
    if ('text' in binding) dom.text = String(value);
    else if ('cssVar' in binding) dom.style[binding.cssVar] = `${String(value)}${binding.unit ?? ''}`;
    else {
      const [name, written] = attributeOf(binding.attr, value, tag);
      dom.attributes[name] = written;
    }
  }
  return dom;
}
