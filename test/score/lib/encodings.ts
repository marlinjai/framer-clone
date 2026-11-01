// How the matrix tries to write a rule that needs a selector or an at-rule into
// a node. The format has no slot for one today, so these are the two shapes an
// author would reach for: a nested rule key, and a state key inside a value's
// responsive map. When selector-level styling lands (step 4 of the plan), its
// real encoding replaces these two and the rows start passing by themselves.
//
// Presets never count: the three hover effects and the width breakpoints reach
// the page through their own fixed paths, not through a rule anyone wrote. A row
// passes only when the rule the author asked for is in the output.

import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';

const PROBE_COLOR = 'rgb(1, 2, 3)';

export function ruleEncodings(rule: string): Array<Record<string, unknown>> {
  return [{ [rule]: { color: PROBE_COLOR } }, { color: { base: 'red', [rule]: PROBE_COLOR } }];
}

export const ruleNode = (style: Record<string, unknown>): ComponentNode => ({ id: 'probe', type: 'div', props: { style } });

/** Whether a stylesheet holds the rule: its own text followed by a block carrying the probe. */
export function stylesheetHasRule(css: string, rule: string): boolean {
  const at = css.indexOf(rule);
  if (at < 0) return false;
  const value = PROBE_COLOR.replace(/ /g, '');
  return css.slice(at).replace(/ /g, '').includes(`color:${value}`);
}

/** The stylesheet text inside rendered markup, for a surface that emits it in the body. */
export function inlineStylesheets(html: string): string {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
}
