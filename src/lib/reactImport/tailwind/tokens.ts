// A developer's stylesheet, read as data. Only custom properties are taken from it, each
// name and value checked before it reaches the compile, and the developer's CSS never
// is compile input: `--*: initial` passes `postcss` and would reset the theme inside the
// hole, and `@plugin` and `tailwind.config.js` are programs. The rest of the file gets lines.
//
// `border` and `outline` colours come from the page's base layer, so no utility names
// `--border` or `--ring`. Reached alone, a foreign theme took the editor's colours with
// no error. So what the source's base names is written too, always.
//
// The contract is docs/plans/2026-11-02-react-import.md, "Tokens".

import postcss, { type AtRule, type ChildNode, type Rule } from 'postcss';
import { refusedRuleValue } from '@/lib/rules/rules';
import type { ImportBudget } from '../budget';
import type { DetailKey, LineKind, NextAction, Disposition } from '../report';

const TOKEN_NAME = /^--[a-z0-9-]+$/;
const DARK_VARIANT = 'dark (&:is(.dark *))';
/** Stylesheets the preamble holds already. Any other import is never followed. */
const KNOWN_IMPORTS: ReadonlySet<string> = new Set(['"tailwindcss"', "'tailwindcss'", '"tw-animate-css"', "'tw-animate-css'"]);
const ROOT_SELECTORS: ReadonlySet<string> = new Set([':root', ':host', ':root, :host', ':root,:host']);
/** What the page's own base reads, so a source that defines them has them written whether a class reaches them or not. */
const PAGE_BASE_TOKENS = ['--border', '--ring'];

/** One thing to report, in the shape a ledger line takes. `reason` and `source` live in the tab, like an excerpt. */
export interface TailwindLine {
  kind: LineKind;
  disposition: Disposition;
  detail: DetailKey;
  next: NextAction[];
  nodeKey?: string;
  /** The class, or stylesheet text, this line is about. Source, so never stored. */
  source?: string;
  /** Why the parser refused. It can quote what it refused, so never stored. */
  reason?: string;
  /** 1-based, when the line is about a stylesheet. */
  line?: number;
}

export interface SourceSheet {
  /** From `:root`. */
  root: Map<string, string>;
  /** From `.dark`. */
  dark: Map<string, string>;
  /** From `@theme`, the only text from the source that reaches the compile. */
  theme: Map<string, string>;
  /** The source says exactly `@custom-variant dark (&:is(.dark *))`. */
  darkClass: boolean;
  /** `@apply` classes in its base, compiled to find the tokens they reach. */
  baseCandidates: string[];
  /** Tokens its base names directly. */
  baseTokens: Set<string>;
  /** Its base gives every element a border colour, so a bare `border` has a colour of the page's. */
  hasBorderBase: boolean;
  lines: TailwindLine[];
}

export const emptySheet = (): SourceSheet => ({
  root: new Map(), dark: new Map(), theme: new Map(), darkClass: false, baseCandidates: [], baseTokens: new Set(), hasBorderBase: false, lines: [],
});

const lineNumber = (node: ChildNode): number | undefined => node.source?.start?.line;

const VARIABLE = /var\(\s*(--[A-Za-z0-9_-]+)/g;

/** Every custom property a value reads. */
export const variablesIn = (value: string): string[] => [...value.matchAll(VARIABLE)].map((match) => match[1]);

export function readStylesheet(text: string, rootKey: string, budget: ImportBudget): SourceSheet {
  const sheet = emptySheet();
  const left = (node: ChildNode | undefined, kind: LineKind, detail: DetailKey, reason?: string): void => {
    const line = node ? lineNumber(node) : undefined;
    sheet.lines.push({ kind, disposition: 'left', detail, next: ['accept', 'rewrite'], nodeKey: rootKey, ...(line ? { line } : {}), ...(reason ? { reason } : {}) });
  };

  const readTokens = (container: Rule | AtRule, into: Map<string, string>): void => {
    container.each((child) => {
      budget.chargeSteps(1);
      if (child.type === 'comment') return;
      if (child.type !== 'decl' || !child.prop.startsWith('--')) {
        left(child, 'css-rule', 'sheetRule');
        return;
      }
      if (!TOKEN_NAME.test(child.prop)) {
        left(child, 'token', 'tokenName');
        return;
      }
      const reason = child.important ? 'a token cannot be !important' : refusedRuleValue(child.prop, child.value);
      if (reason) left(child, 'token', 'tokenValue', reason);
      else into.set(child.prop, child.value);
    });
  };

  // Border and outline colours on `*` are what the written tokens reproduce. Anything else in the base stays the page's.
  let keptOnPage: Rule | undefined;
  const readBase = (rule: Rule): void => {
    const universal = rule.selector === '*';
    if (!universal && rule.selector !== 'html' && rule.selector !== 'body') {
      left(rule, 'css-rule', 'sheetRule');
      return;
    }
    if (!universal) keptOnPage ??= rule;
    rule.each((child) => {
      budget.chargeSteps(1);
      if (child.type === 'atrule' && child.name === 'apply') {
        const classes = child.params.split(/\s+/).filter(Boolean);
        sheet.baseCandidates.push(...classes);
        if (universal && classes.some((name) => name.startsWith('border-'))) sheet.hasBorderBase = true;
        if (universal && classes.some((name) => !/^(?:border|outline)-/.test(name))) keptOnPage ??= rule;
      } else if (child.type === 'decl') {
        for (const name of variablesIn(child.value)) sheet.baseTokens.add(name);
        if (universal && child.prop === 'border-color') sheet.hasBorderBase = true;
        if (universal && child.prop !== 'border-color' && child.prop !== 'outline-color') keptOnPage ??= rule;
      } else if (child.type !== 'comment') {
        left(child, 'css-rule', 'sheetRule');
      }
    });
  };

  const readAtRule = (rule: AtRule): void => {
    const name = rule.name.toLowerCase();
    if (name === 'import') {
      if (!KNOWN_IMPORTS.has(rule.params.trim())) left(rule, 'css-rule', 'sheetImport');
    } else if (name === 'theme') {
      readTokens(rule, sheet.theme);
    } else if (name === 'custom-variant' && rule.params.trim() === DARK_VARIANT) {
      sheet.darkClass = true;
    } else if (name === 'layer' && rule.params.trim() === 'base' && rule.nodes) {
      rule.each((child) => {
        budget.chargeSteps(1);
        if (child.type === 'rule') readBase(child);
        else if (child.type !== 'comment') left(child, 'css-rule', 'sheetRule');
      });
    } else {
      // `@utility`, `@plugin`, `@config`, `@source`, another `@layer`, and whatever comes next.
      left(rule, 'css-rule', 'sheetAtRule');
    }
  };

  budget.chargeEvaluated(text.length);
  let root;
  try {
    root = postcss.parse(text);
  } catch (error) {
    if (error instanceof RangeError) throw error;
    left(undefined, 'css-rule', 'sheetSyntax');
    return sheet;
  }
  root.each((node) => {
    budget.chargeSteps(1);
    if (node.type === 'comment') return;
    if (node.type === 'atrule') readAtRule(node);
    else if (node.type === 'rule' && ROOT_SELECTORS.has(node.selector)) readTokens(node, sheet.root);
    else if (node.type === 'rule' && node.selector === '.dark') readTokens(node, sheet.dark);
    else left(node, 'css-rule', 'sheetRule');
  });
  if (keptOnPage) sheet.lines.push({ kind: 'css-rule', disposition: 'adapted', detail: 'basePage', next: [], nodeKey: rootKey, line: lineNumber(keptOnPage) });
  return sheet;
}

/** The tokens a set of names reaches, through each other, each once. Cycles end here. */
export function reachedTokens(seeds: Iterable<string>, values: ReadonlyMap<string, string>, budget: ImportBudget): Set<string> {
  const reached = new Set<string>();
  const waiting = [...seeds];
  while (waiting.length > 0) {
    const name = waiting.pop() as string;
    if (reached.has(name) || name.startsWith('--tw-') || name.startsWith('--u-tw-')) continue;
    budget.chargeSteps(1);
    const value = values.get(name);
    if (value === undefined) continue;
    reached.add(name);
    waiting.push(...variablesIn(value));
  }
  return reached;
}

/** The tokens that are written whether or not a class reaches them. */
export const alwaysWritten = (sheet: SourceSheet): string[] => [...PAGE_BASE_TOKENS, ...sheet.baseTokens];
