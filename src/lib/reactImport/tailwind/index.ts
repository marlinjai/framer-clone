// Layer 2: an import's classes to `style` and `rules`. Class strings are untrusted, so
// nothing here decides that a result is safe: every output goes through the real rule
// parser, what it refuses is a line, and a candidate with no output is a line too.
//
// This is async because Tailwind's compiler is. A `BudgetExceeded` leaves through the
// caller, whose one catch turns it into a line.
//
// The contract is docs/plans/2026-11-02-react-import.md, "Layer 2: Tailwind".

import type { AtRule } from 'postcss';
import { scanValue } from '@/lib/responsive/responsiveCss';
import { safeInlineStyle } from '@/lib/renderer/blockedNodes';
import { MAX_RULES_PER_NODE, parseRule, reachesInsideNode, readRules, type DefinitionRule, type SelectorRule, type StoredRule } from '@/lib/rules/rules';
import { IMPORT_LIMITS, type ImportBudget } from '../budget';
import type { DetailKey } from '../report';
import { DEFAULT_BREAKPOINT_IDS, isWidthWrapper, mapBreakpoints, type BreakpointIds, type NormalDeclaration } from './breakpoints';
import { compileCandidates, refusedBeforeCompile, type CompiledSheet } from './compile';
import { familyOf, mergeRules, type Declaration } from './flatten';
import { orderEntries, placeClasses, type ClassSource, type PlacedClasses } from './order';
import { DARK_SELECTOR, SYSTEM_DARK, keptClassName, keptSourceClass, keyframesName, readsClass, renameCustomProperties, rewriteEntry, storedValue, styleKey, styleOf, type ClassReader, type RewrittenEntry } from './rewrites';
import { alwaysWritten, emptySheet, reachedTokens, readStylesheet, variablesIn, type SourceSheet, type TailwindLine } from './tokens';

export type { ClassSource, VariantTable } from './order';
export type { TailwindLine } from './tokens';
export { variantSelector } from './order';

export interface ElementClasses extends ClassSource {
  key: string;
  /** The element around this one, so a line can depend on what a child really sets. */
  parent?: string;
  /** A piece of the class string is only known when the component runs. */
  dynamic?: boolean;
}

export interface TailwindInput {
  elements: readonly ElementClasses[];
  /** The element that holds tokens and definitions. */
  rootKey: string;
  /** The developer's stylesheet. Read as data. */
  stylesheet?: string;
  budget: ImportBudget;
  /** `use-system-dark`, a person's choice: `dark:` as the media query, which works on a page. */
  systemDark?: boolean;
  breakpoints?: BreakpointIds;
}

/** What lands on one node. */
export interface ConvertedNode {
  style?: Record<string, unknown>;
  rules?: StoredRule[];
  className?: string;
}

export interface TailwindResult {
  nodes: Map<string, ConvertedNode>;
  lines: TailwindLine[];
}

const NAMED_MARKER = /^(?:group|peer)(?:\/.+)?$/;
const BORDER_LINE = /^border(?:Top|Right|Bottom|Left|Block|Inline|BlockStart|BlockEnd|InlineStart|InlineEnd)?(?:Width|Style)?$/;
const BORDER_COLOR = /^border(?:Top|Right|Bottom|Left|Block|Inline|BlockStart|BlockEnd|InlineStart|InlineEnd)?Color$/;
const U_TW_NAME = /--u-tw-[A-Za-z0-9-]+/g;
const WORD = /[A-Za-z_-][A-Za-z0-9_-]*/g;

/** One attempt at a value in Normal: fine, kept with an accept, or why it is refused. */
type NormalCheck = { ok: true; external: boolean } | { ok: false; reason: string };

const sizeOfStyle = (style: Record<string, unknown>): number =>
  Object.entries(style).reduce((sum, [key, value]) => sum + key.length + (typeof value === 'string' ? value.length : 0), 0);

/** Normal is allowed an external address, and a rule is not. Only that exact refusal differs: anything else is refused the same. */
function checkNormal(key: string, value: unknown): NormalCheck {
  const parsed = parseRule({ id: 'n', selector: '&', style: { [key]: value } });
  if (safeInlineStyle({ [key]: value })[key] === undefined) return { ok: false, reason: 'the render gate refuses this declaration' };
  if (parsed.ok) return { ok: true, external: false };
  const problem = typeof value === 'string' ? scanValue(value) : null;
  return problem?.kind === 'address' && problem.reason === parsed.reason ? { ok: true, external: true } : { ok: false, reason: parsed.reason };
}

/** Everything one import's compile produced, each candidate rewritten once however many elements use it. */
interface Candidates {
  compiled: CompiledSheet;
  rewritten: Map<string, RewrittenEntry[]>;
  /** Why a candidate lost output, by candidate. */
  refused: Map<string, string[]>;
  /** Classes selectors name, by name in the source. */
  names: Set<string>;
  readers: ClassReader[];
  produced: Set<string>;
  /** Classes refused before the compile, which never reached it. */
  capped: Map<string, 'variants' | 'negations'>;
}

function rewriteCandidates(compiled: CompiledSheet, systemDark: boolean): Candidates {
  const produced = new Set(compiled.keyframes.keys());
  const candidates: Candidates = { compiled, rewritten: new Map(), refused: new Map(), names: new Set(), readers: [], produced, capped: new Map() };
  const refuse = (candidate: string, reason: string) => {
    const own = candidates.refused.get(candidate);
    if (own) own.push(reason);
    else candidates.refused.set(candidate, [reason]);
  };
  for (const candidate of compiled.unwritable) refuse(candidate, 'a selector list inside a selector list cannot be stored');
  for (const [candidate, entries] of compiled.entries) {
    const kept: RewrittenEntry[] = [];
    for (const entry of entries) {
      const rewritten = rewriteEntry(entry, { systemDark });
      if (rewritten.refused) {
        refuse(candidate, rewritten.refused);
        continue;
      }
      // The canvas writes every rule declaration with `!important` of its own, so a stored one would be written twice there.
      if (entry.declarations.some((declaration) => declaration.important)) {
        refuse(candidate, '!important is not stored: the canvas and the page give a rule its weight');
        continue;
      }
      // Decided here for what stays a rule. An external address in Normal is decided where Normal is written.
      const style = styleOf(rewritten.entry.declarations, produced);
      const parsed = parseRule({ id: 'c', selector: rewritten.entry.selector, ...(rewritten.entry.at.length > 0 ? { at: rewritten.entry.at } : {}), style });
      if (!parsed.ok && !(rewritten.entry.selector === '&' && rewritten.entry.at.length === 0)) {
        refuse(candidate, parsed.reason);
        continue;
      }
      for (const name of rewritten.names) candidates.names.add(name);
      candidates.readers.push(...rewritten.readers);
      kept.push(rewritten);
    }
    candidates.rewritten.set(candidate, kept);
  }
  return candidates;
}

const tokensOf = ({ classes, table }: ClassSource): string[] => [
  ...(classes ?? []),
  ...(table?.base ?? []),
  ...(table?.keys ?? []).flatMap(({ values }) => Object.values(values).flat()),
  ...(table?.compound ?? []).flatMap(({ classes: tokens }) => tokens),
];

function keptClasses(element: ElementClasses, classes: PlacedClasses | null, { names, readers }: Candidates, lines: TailwindLine[]): string[] {
  const own = new Set(classes?.placed.filter((each) => each.own).map((each) => each.token) ?? tokensOf(element));
  const kept = new Set<string>();
  for (const token of new Set(tokensOf(element))) {
    const name = names.has(token) ? keptClassName(token) : null;
    const reading = readers.filter((reader) => readsClass(reader, token));
    if (!name && reading.length === 0) continue;
    kept.add(name ?? keptSourceClass(token));
    // A class one value of a table brings is kept for all of them. That differs only where a reader matches it and
    // nothing the element always has: `size-9` beside a base class holding `size-` changes nothing `[class*='size-']` reads.
    const differs = !own.has(token) && (name !== null || reading.some((reader) => ![...own].some((each) => readsClass(reader, each))));
    lines.push({ kind: 'class', disposition: differs ? 'adapted' : 'converted', detail: differs ? 'classKeptVariant' : 'classKept', next: [], nodeKey: element.key, source: token });
  }
  return [...kept];
}

/** Rules in cascade order, with Normal's share of each moved to `style`. */
function assembleNode(element: ElementClasses, classes: PlacedClasses, input: TailwindInput, sheet: SourceSheet, candidates: Candidates, lines: TailwindLine[]): { node: ConvertedNode; mapped: boolean; literalWidth: boolean } {
  const { key } = element;
  const { rewritten, produced } = candidates;
  const line = (entry: Omit<TailwindLine, 'nodeKey'>) => lines.push({ ...entry, nodeKey: key });
  const placedEntries = orderEntries(classes, (token) => rewritten.get(token) ?? []);
  const normal: NormalDeclaration[] = [];
  const drafts: (SelectorRule & { fromNormal: boolean })[] = [];
  let hoverGated = false;
  let raisedKeys: string[] = [];
  for (const { rewritten: each, condition } of placedEntries) {
    const { entry } = each;
    const style = styleOf(entry.declarations, produced);
    input.budget.chargeEvaluated(sizeOfStyle(style));
    hoverGated ||= each.hoverGated;
    if (each.raisesWeight) raisedKeys = [...raisedKeys, ...Object.keys(style)];
    const selector = `&${condition}${entry.selector.slice(1)}`;
    const atWidth = entry.at.length === 1 && isWidthWrapper(entry.at[0]);
    const inNormal = selector === '&';
    if (inNormal && (entry.at.length === 0 || atWidth)) {
      for (const [property, value] of Object.entries(style)) normal.push({ key: property, value, at: entry.at });
    }
    if (!inNormal || entry.at.length > 0) {
      drafts.push({ id: '', selector, ...(entry.at.length > 0 ? { at: entry.at } : {}), style, fromNormal: inNormal && atWidth });
    }
  }
  if (hoverGated) line({ kind: 'css-rule', disposition: 'adapted', detail: 'hoverGate', next: [] });

  const { style, mappedKeys } = mapBreakpoints(normal, input.breakpoints ?? DEFAULT_BREAKPOINT_IDS);
  const remaining = drafts.flatMap((draft) => {
    if (!draft.fromNormal) return [draft];
    const left = Object.fromEntries(Object.entries(draft.style).filter(([property]) => !mappedKeys.has(property)));
    return Object.keys(left).length > 0 ? [{ ...draft, style: left }] : [];
  });

  // Bare `border` is `currentcolor` in a source with no base rule for it, and the page's own rule would colour it. [unproven]
  const finalStyle = sheet.hasBorderBase ? style : withCurrentColor(style, placedEntries.map(({ rewritten: each }) => each), produced);
  const merged = mergeRules(sheet.hasBorderBase ? remaining : remaining.map(borderRule));

  const checked: Record<string, unknown> = {};
  for (const [property, value] of Object.entries(finalStyle)) {
    const results = (value !== null && typeof value === 'object' ? Object.values(value) : [value]).map((each) => checkNormal(property, each));
    const refused = results.find((result) => !result.ok);
    if (refused && !refused.ok) {
      line({ kind: 'refused-rule', disposition: 'left', detail: 'refusedRule', next: ['accept', 'rewrite'], reason: refused.reason, source: property });
      continue;
    }
    if (results.some((result) => result.ok && result.external)) line({ kind: 'external-address', disposition: 'adapted', detail: 'styleExternal', next: ['accept'] });
    checked[property] = value;
  }

  const rules: SelectorRule[] = [];
  for (const draft of merged) {
    const rule = { selector: draft.selector, ...(draft.at ? { at: draft.at } : {}), style: draft.style };
    const stored: SelectorRule = { id: `r${rules.length + 1}`, ...rule };
    const parsed = parseRule(stored);
    if (parsed.ok) rules.push(stored);
    else line({ kind: 'refused-rule', disposition: 'left', detail: 'refusedRule', next: ['accept', 'rewrite'], reason: parsed.reason, source: rule.selector });
  }
  return {
    node: {
      ...(Object.keys(checked).length > 0 ? { style: checked } : {}),
      ...(rules.length > 0 ? { rules } : {}),
    },
    mapped: mappedKeys.size > 0,
    literalWidth: rules.some((rule) => (rule.at ?? []).some(isWidthWrapper)),
  };
}

const setsBorderLine = (keys: readonly string[]): boolean => keys.some((key) => BORDER_LINE.test(key));
const setsBorderColor = (keys: readonly string[]): boolean => keys.some((key) => BORDER_COLOR.test(key));

function withCurrentColor(style: Record<string, unknown>, entries: readonly RewrittenEntry[], produced: ReadonlySet<string>): Record<string, unknown> {
  const own = entries.filter(({ entry }) => entry.selector === '&').map(({ entry }) => Object.keys(styleOf(entry.declarations, produced))).flat();
  return setsBorderLine(own) && !setsBorderColor(own) ? { borderColor: 'currentcolor', ...style } : style;
}

/** The same for a rule that draws a border on something inside the node, which the node's Normal cannot reach. */
function borderRule<T extends SelectorRule>(rule: T): T {
  const keys = Object.keys(rule.style);
  if (!reachesInsideNode(rule.selector) || !setsBorderLine(keys) || setsBorderColor(keys)) return rule;
  return { ...rule, style: { borderColor: 'currentcolor', ...rule.style } };
}

/** A definition as the rule format stores it. */
function propertyDefinition(rule: AtRule, id: string): DefinitionRule {
  const style: Record<string, unknown> = {};
  rule.each((child) => {
    if (child.type === 'decl') style[styleKey(child.prop)] = child.value;
  });
  return { id, define: `@property ${renameCustomProperties(rule.params)}`, style };
}

function keyframesDefinition(rule: AtRule, id: string, produced: ReadonlySet<string>): DefinitionRule {
  const blocks: { selector: string; style: Record<string, unknown> }[] = [];
  rule.each((child) => {
    if (child.type !== 'rule') return;
    const declarations: Declaration[] = [];
    child.each((each) => {
      if (each.type === 'decl') declarations.push({ property: each.prop, value: each.value, important: false });
    });
    blocks.push({ selector: child.selector, style: styleOf(declarations, produced) });
  });
  return { id, define: `@keyframes ${keyframesName(rule.params)}`, blocks };
}

const textsOf = (node: ConvertedNode): string[] => {
  const of = (style: Record<string, unknown> | undefined): string[] =>
    Object.entries(style ?? {}).flatMap(([key, value]) => [key, ...(value !== null && typeof value === 'object' ? Object.values(value) : [value]).map(String)]);
  return [...of(node.style), ...(node.rules ?? []).flatMap((rule) => of(rule.style))];
};

/** Tokens, `.dark` values and definitions, which all stand on the import's root. True when it wrote `.dark` values. */
function writeRoot(root: ConvertedNode, nodes: ReadonlyMap<string, ConvertedNode>, input: TailwindInput, sheet: SourceSheet, candidates: Candidates, lines: TailwindLine[]): boolean {
  const { compiled, produced } = candidates;
  const line = (entry: Omit<TailwindLine, 'nodeKey'>) => lines.push({ ...entry, nodeKey: input.rootKey });
  const texts = [...nodes.values()].flatMap(textsOf);
  const values = new Map([...compiled.theme, ...sheet.root]);
  const seeds = [...texts.flatMap(variablesIn), ...sheet.baseTokens, ...alwaysWritten(sheet)];
  for (const candidate of sheet.baseCandidates) {
    for (const { entry } of candidates.rewritten.get(candidate) ?? []) seeds.push(...entry.declarations.flatMap(({ value }) => variablesIn(value)));
  }
  const reached = reachedTokens(seeds, values, input.budget);
  const dark = [...reached].filter((name) => sheet.dark.has(name));
  for (const name of reachedTokens(dark.flatMap((each) => variablesIn(sheet.dark.get(each) as string)), values, input.budget)) reached.add(name);

  const tokens: Record<string, unknown> = {};
  for (const name of reached) {
    const stored = storedValue(name, values.get(name) as string, produced);
    const parsed = parseRule({ id: 't', selector: '&', style: { [name]: stored } });
    if (parsed.ok) tokens[name] = stored;
    else line({ kind: 'token', disposition: 'left', detail: 'tokenValue', next: ['accept', 'rewrite'], reason: parsed.reason, source: name });
  }
  const style = { ...tokens, ...root.style };
  if (Object.keys(style).length > 0) root.style = style;

  const rules: StoredRule[] = [...(root.rules ?? [])];
  const darkValues = Object.fromEntries(dark.map((name) => [name, storedValue(name, sheet.dark.get(name) as string, produced)]));
  if (dark.length > 0) {
    rules.push(input.systemDark
      ? { id: 'dark', selector: '&', at: [SYSTEM_DARK], style: darkValues }
      : { id: 'dark', selector: `&${DARK_SELECTOR}`, style: darkValues });
  }

  // What the page keeps, and the only definitions worth a place: those a kept value uses.
  const kept = [...texts, ...Object.values(tokens).map(String), ...Object.values(darkValues)];
  const definitions: DefinitionRule[] = [];
  const animated = new Set(kept.flatMap((text) => text.match(WORD) ?? []));
  for (const [name, rule] of compiled.keyframes) {
    if (animated.has(keyframesName(name))) definitions.push(keyframesDefinition(rule, `k${definitions.length + 1}`, produced));
  }
  const defined = new Set([...kept, ...definitions.map((definition) => JSON.stringify(definition.blocks))].flatMap((text) => text.match(U_TW_NAME) ?? []));
  for (const [name, rule] of compiled.properties) {
    if (defined.has(renameCustomProperties(name))) definitions.push(propertyDefinition(rule, `p${definitions.length + 1}`));
  }
  for (const definition of definitions) {
    const parsed = parseRule(definition);
    if (parsed.ok) rules.push(definition);
    else line({ kind: 'refused-rule', disposition: 'left', detail: 'refusedRule', next: ['accept', 'rewrite'], reason: parsed.reason, source: definition.define });
  }
  if (rules.length > 0) root.rules = rules;
  return dark.length > 0;
}

/** A node over the cap would lose rules at the emitter, with only a console warning. So none are stored, and a line says so. */
function enforceCap(key: string, node: ConvertedNode, lines: TailwindLine[]): void {
  const { rules, refused } = readRules({ rules: node.rules });
  if ((node.rules?.length ?? 0) > MAX_RULES_PER_NODE) {
    delete node.rules;
    lines.push({ kind: 'cap', disposition: 'left', detail: 'overRules', next: ['rewrite'], nodeKey: key });
    return;
  }
  // Nothing reaches here that one parse refused, so this holds what the list as a whole can still refuse: a repeated id.
  if (refused.length > 0 || rules.length !== (node.rules?.length ?? 0)) {
    delete node.rules;
    lines.push({ kind: 'refused-rule', disposition: 'left', detail: 'refusedRule', next: ['accept', 'rewrite'], nodeKey: key, reason: refused[0]?.reason });
  }
}

/** A line per class that came to nothing, or to less than it says. */
function classLines(element: ElementClasses, classes: PlacedClasses, sheet: SourceSheet, candidates: Candidates, kept: readonly string[], lines: TailwindLine[]): void {
  const { key } = element;
  const hasTokens = sheet.root.size > 0 || sheet.theme.size > 0;
  for (const token of new Set(classes.placed.map((each) => each.token))) {
    const capped = candidates.capped.get(token);
    if (capped) {
      lines.push({ kind: 'cap', disposition: 'left', detail: capped === 'variants' ? 'overVariants' : 'overNegations', next: ['accept', 'rewrite'], nodeKey: key, source: token });
      continue;
    }
    const refused = candidates.refused.get(token);
    for (const reason of new Set(refused)) lines.push({ kind: 'refused-rule', disposition: 'left', detail: 'refusedRule', next: ['accept', 'rewrite'], nodeKey: key, reason, source: token });
    if (refused || (candidates.rewritten.get(token)?.length ?? 0) > 0) continue;
    if (NAMED_MARKER.test(token) || candidates.names.has(token) || kept.includes(keptSourceClass(token))) continue;
    lines.push({ kind: 'class', disposition: 'left', detail: 'classNoOutput', next: hasTokens ? ['accept', 'rewrite'] : ['add-tokens', 'accept', 'rewrite'], nodeKey: key, source: token });
  }
  for (const token of classes.removed) lines.push({ kind: 'class', disposition: 'converted', detail: 'classMerged', next: [], nodeKey: key, source: token });
}

/** `mb-8` under `space-y-4` is 32 pixels in the original and 16 here. A line on every use would hide real lines, so only where a child sets it. */
function raisedWeightLines(input: TailwindInput, nodes: ReadonlyMap<string, ConvertedNode>, candidates: Candidates, lines: TailwindLine[]): void {
  const families = new Map<string, Set<string>>();
  for (const element of input.elements) {
    for (const token of tokensOf(element)) {
      for (const { raisesWeight, entry } of candidates.rewritten.get(token) ?? []) {
        if (!raisesWeight) continue;
        const own = families.get(element.key) ?? new Set();
        for (const { property } of entry.declarations) own.add(familyOf(styleKey(property)));
        families.set(element.key, own);
      }
    }
  }
  for (const { key, parent } of input.elements) {
    const raised = parent === undefined ? undefined : families.get(parent);
    if (raised && Object.keys(nodes.get(key)?.style ?? {}).some((property) => raised.has(familyOf(property)))) {
      lines.push({ kind: 'css-rule', disposition: 'adapted', detail: 'raisedWeight', next: [], nodeKey: key });
    }
  }
}

const usesClassDark = (candidates: Candidates): boolean =>
  [...candidates.rewritten.values()].some((entries) => entries.some((each) => each.dark));

/** The classes of an import as what they mean on a stored node, with a line for everything that is not the same. */
export async function convertClasses(input: TailwindInput): Promise<TailwindResult> {
  const { elements, rootKey, stylesheet, budget, systemDark = false } = input;
  const sheet = stylesheet === undefined ? emptySheet() : readStylesheet(stylesheet, rootKey, budget);
  const lines: TailwindLine[] = [...sheet.lines];
  const nodes = new Map<string, ConvertedNode>();

  const placements = new Map<string, PlacedClasses | null>();
  const wanted = new Set(sheet.baseCandidates);
  for (const element of elements) {
    const tokens = tokensOf(element);
    budget.chargeSteps(tokens.length + 1);
    budget.chargeEvaluated(tokens.reduce((sum, token) => sum + token.length, 0));
    for (const token of tokens) wanted.add(token);
    if (element.dynamic) lines.push({ kind: 'class-unknown', disposition: 'left', detail: 'classDynamic', next: ['accept', 'rewrite'], nodeKey: element.key });
    const placed = placeClasses(element);
    placements.set(element.key, placed);
    if (placed === null) lines.push({ kind: 'class', disposition: 'left', detail: 'classTable', next: ['accept', 'rewrite'], nodeKey: element.key });
  }
  // Checked on the text before anything compiles: a stacked negation runs out of memory inside the compiler.
  const capped = new Map<string, 'variants' | 'negations'>();
  for (const token of wanted) {
    const reason = refusedBeforeCompile(token);
    if (reason) capped.set(token, reason);
  }
  for (const token of capped.keys()) wanted.delete(token);
  if (wanted.size > IMPORT_LIMITS.candidates) {
    lines.push({ kind: 'cap', disposition: 'left', detail: 'overCandidates', next: ['rewrite'], nodeKey: rootKey });
    return { nodes, lines };
  }

  let compiled: CompiledSheet;
  try {
    compiled = await compileCandidates([...wanted], sheet, budget);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    lines.push({ kind: 'cap', disposition: 'left', detail: 'tooDeep', next: ['rewrite'], nodeKey: rootKey });
    return { nodes, lines };
  }
  const candidates = rewriteCandidates(compiled, systemDark);
  for (const [token, reason] of capped) candidates.capped.set(token, reason);

  let anyMapped = false;
  let anyLiteralWidth = false;
  for (const element of elements) {
    const classes = placements.get(element.key);
    if (!classes) continue;
    const kept = keptClasses(element, classes, candidates, lines);
    classLines(element, classes, sheet, candidates, kept, lines);
    const { node, mapped, literalWidth } = assembleNode(element, classes, input, sheet, candidates, lines);
    if (kept.length > 0) node.className = kept.join(' ');
    nodes.set(element.key, node);
    anyMapped ||= mapped;
    anyLiteralWidth ||= literalWidth;
    if (Object.keys(node).length > 0) lines.push({ kind: 'class', disposition: 'converted', detail: 'classConverted', next: [], nodeKey: element.key });
  }

  const root = nodes.get(rootKey) ?? {};
  nodes.set(rootKey, root);
  const wroteDark = writeRoot(root, nodes, input, sheet, candidates, lines);
  for (const [key, node] of nodes) enforceCap(key, node, lines);
  raisedWeightLines(input, nodes, candidates, lines);

  const line = (detail: DetailKey, next: TailwindLine['next'] = []) => lines.push({ kind: 'css-rule', disposition: 'adapted', detail, next, nodeKey: rootKey });
  if (!systemDark && (usesClassDark(candidates) || wroteDark)) line('darkClass', ['use-system-dark', 'accept']);
  if (anyMapped) line('breakpointRem');
  if (anyMapped && anyLiteralWidth) line('breakpointFrames');
  return { nodes, lines };
}
