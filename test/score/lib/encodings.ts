// How the matrix writes a rule that needs a selector or an at-rule into a node:
// the real format, `props.rules` (src/lib/rules/rules.ts). Each row becomes one
// stored rule and the text that rule must leave in the page stylesheet, so a row
// passes only when what the author asked for is in the output.
//
// Presets never count: the three hover effects and the width breakpoints reach
// the page through their own fixed paths, not through a rule anyone wrote.

import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { StoredRule } from '@/lib/rules/rules';
import samples from '../data/samples.json';

const PROBE_COLOR = 'rgb(1, 2, 3)';
/** What `&` becomes for the probe node: it is resolved in the sheet, never emitted. */
const NODE = '.fc_r-probe.fc_r-probe';

const squeeze = (text: string): string => text.replace(/\s+/g, '');
const declared = `{color:${squeeze(PROBE_COLOR)}`;

/** A row as a stored rule, and the texts that prove it reached the sheet. */
export interface RuleProbe {
  rule: StoredRule;
  expected: string[];
}

/** A selector row. A bare sample such as `:hover` is tried as the panel would write it. */
export function selectorProbe(id: string, sample: string): RuleProbe {
  const selector = sample.startsWith('&') ? sample : `&${sample}`;
  const wrapper = (samples.selectorWrappers as Record<string, string>)[id];
  const parts = selector.split(/,(?![^(]*\))/).map((part) => part.trim().slice(1));
  return {
    rule: { id: 'probe', selector, ...(wrapper ? { at: [wrapper] } : {}), style: { color: PROBE_COLOR } },
    expected: parts.map((part) => squeeze(`${wrapper ? `${wrapper}{` : ''}${NODE}${part}${declared}`)),
  };
}

/** A condition, such as an `@media` sample, wrapped around a rule on the node itself. */
export function wrapperProbe(at: string): RuleProbe {
  return {
    rule: { id: 'probe', selector: '&', at: [at], style: { color: PROBE_COLOR } },
    expected: [squeeze(`${at}{${NODE}${declared}`)],
  };
}

interface DefinitionBody {
  style?: Record<string, unknown>;
  blocks?: { selector: string; style: Record<string, unknown> }[];
  marker: string;
}

/** An at-rule row: a definition with a real body, or a wrapper when it has no body to hold. */
export function atRuleProbe(id: string, sample: string): RuleProbe {
  const body = (samples.definitionBodies as Record<string, DefinitionBody>)[id];
  if (!body) return wrapperProbe(sample);
  const { marker, ...stored } = body;
  return { rule: { id: 'probe', define: sample, ...stored }, expected: [squeeze(`${sample}{${marker}`)] };
}

export const ruleNode = (rule: StoredRule): ComponentNode => ({ id: 'probe', type: 'div', props: { rules: [rule] } as never });

export const styleNode = (style: Record<string, unknown>): ComponentNode => ({ id: 'probe', type: 'div', props: { style } });

/** Whether a stylesheet holds the rule. Whitespace is not what a row is about. */
export function stylesheetHasRule(css: string, probe: RuleProbe): boolean {
  const sheet = squeeze(css);
  return probe.expected.every((text) => sheet.includes(text));
}

/** Rows that apply to the document, which a node cannot reach: see `page-level-css`. */
export function isPageLevelRow(id: string): boolean {
  return samples.pageLevelRows.includes(id);
}

/** The stylesheet text inside rendered markup, for a surface that emits it in the body. */
export function inlineStylesheets(html: string): string {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
}
