// One compile and one build over every candidate of an import: compiling per class took
// 4.6 seconds for 384 in the probe. Selectors are unescaped back to candidates, so each
// entry is known by its class and its index in the output. A candidate with no entry is
// not an error to Tailwind, so it is reported by whoever asked for it.
//
// The contract is docs/plans/2026-11-02-react-import.md, "Layer 2: Tailwind".

import postcss, { type AtRule, type ChildNode, type Rule } from 'postcss';
import { compile } from 'tailwindcss';
import type { ImportBudget } from '../budget';
import { flattenRule, type FlatEntry } from './flatten';
import { buildPreamble, loadModule, loadStylesheet } from './preamble';
import type { SourceSheet } from './tokens';

export interface CompiledSheet {
  /** Each candidate's entries, in Tailwind's order. */
  entries: Map<string, FlatEntry[]>;
  /** Candidates whose selector could not be written, so their output is gone. */
  unwritable: Set<string>;
  /** Tailwind's own theme values this build reached, such as `--spacing`. */
  theme: Map<string, string>;
  keyframes: Map<string, AtRule>;
  properties: Map<string, AtRule>;
}

/** CSS unescaped: `\:` and the hex form Tailwind uses for a leading digit, as in `.\32 xl\:p-8`. */
export function unescapeClass(selector: string): string {
  return selector.replace(/^\./, '').replace(/\\([0-9a-fA-F]{1,6})[ \t\n]?|\\([\s\S])/g, (_, hex: string | undefined, plain: string | undefined) =>
    hex === undefined ? (plain as string) : String.fromCodePoint(Number.parseInt(hex, 16)));
}

function readUtilities(layer: AtRule, wanted: ReadonlySet<string>, sheet: CompiledSheet, budget: ImportBudget): void {
  let index = 0;
  const nextIndex = () => {
    index += 1;
    return index;
  };
  layer.each((node: ChildNode) => {
    budget.chargeSteps(1);
    if (node.type !== 'rule') return;
    const rule: Rule = node;
    const candidate = unescapeClass(rule.selector);
    if (!wanted.has(candidate)) return;
    const flat = flattenRule(rule, candidate, nextIndex, (name) => sheet.unwritable.add(name));
    budget.chargeSteps(flat.length);
    const own = sheet.entries.get(candidate);
    if (own) own.push(...flat);
    else sheet.entries.set(candidate, flat);
  });
}

function readTheme(layer: AtRule, into: Map<string, string>): void {
  layer.each((node) => {
    if (node.type !== 'rule') return;
    node.each((child) => {
      if (child.type === 'decl') into.set(child.prop, child.value);
    });
  });
}

/** Compiles, builds, and reads the output back as data. Only what was asked for is kept. */
export async function compileCandidates(candidates: readonly string[], sheet: Pick<SourceSheet, 'theme' | 'darkClass'>, budget: ImportBudget): Promise<CompiledSheet> {
  const compiler = await compile(buildPreamble(sheet), { base: '/', loadStylesheet, loadModule });
  const css = compiler.build([...candidates]);
  // Paid before it is parsed: arbitrary values make the output as long as they like.
  budget.chargeEvaluated(css.length);
  const root = postcss.parse(css);
  const wanted = new Set(candidates);
  const compiled: CompiledSheet = { entries: new Map(), unwritable: new Set(), theme: new Map(), keyframes: new Map(), properties: new Map() };
  root.each((node) => {
    if (node.type !== 'atrule') return;
    if (node.name === 'layer' && node.params === 'utilities') readUtilities(node, wanted, compiled, budget);
    else if (node.name === 'layer' && node.params === 'theme') readTheme(node, compiled.theme);
    else if (node.name === 'keyframes') compiled.keyframes.set(node.params, node);
    else if (node.name === 'property') compiled.properties.set(node.params, node);
  });
  return compiled;
}
