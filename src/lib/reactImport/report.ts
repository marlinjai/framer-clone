// The report of one import: every construct of the source, and what became of it.
// A detail comes from the fixed table below and holds no source text, so a report can
// travel. Source appears only in `excerpt`, which lives in the tab and is never stored.
//
// The contract is docs/plans/2026-11-02-react-import.md, "The ledger".

/** converted: same meaning. adapted: kept, with a stated difference. rebuilt: AI, accepted by a person. left: not in the result. */
export type Disposition = 'converted' | 'adapted' | 'rebuilt' | 'left';

export type LineKind =
  | 'element' | 'attribute' | 'spread' | 'expression' | 'statement' | 'import'
  | 'class' | 'class-unknown' | 'css-rule' | 'token'
  | 'hook' | 'handler' | 'loop' | 'condition'
  | 'refused-rule' | 'refused-tag' | 'refused-attribute' | 'external-address' | 'taint' | 'secret'
  | 'cap' | 'unknown-component' | 'unknown-package';

export type NextAction = 'rewrite' | 'accept' | 'add-tokens' | 'add-entry' | 'rebuild-with-ai' | 'custom-code' | 'use-system-dark';

export interface ImportLine {
  file: string;
  line: number;
  column: number;
  endLine: number;
  /** At most 120 characters, whitespace collapsed. Lives in the tab, never stored. */
  excerpt?: string;
  /** The atom ids this line claims. */
  atoms: string[];
  kind: LineKind;
  disposition: Disposition;
  /** From `DETAILS`, so it holds no source text. */
  detail: string;
  next: NextAction[];
  /** The node it landed on or would have, so the report can select it. A `left` line with one blocks placing. */
  nodeKey?: string;
  /** An `adapted` line a visitor cannot see, which leaves the verdict alone. Absent means they can. */
  invisible?: true;
}

export type Verdict = 'imported' | 'imported-with-differences' | 'not-imported';

export interface ImportReport {
  lines: ImportLine[];
  counts: Record<Disposition, number>;
  verdict: Verdict;
}

export const DETAILS = {
  element: 'Became an element.',
  text: 'Became text.',
  fragment: 'A fragment: its children stand in its place.',
  attribute: 'Kept as an attribute.',
  style: 'Kept as an inline style.',
  styleExternal: 'Kept as an inline style. It loads a file from another address, so a visitor reaches that address: needs your accept.',
  attributeExternal: 'Kept as an attribute. It loads a file from another address, so a visitor reaches that address: needs your accept.',
  key: 'Dropped: key has no meaning in a stored tree.',
  emptyValue: 'Dropped: this value renders nothing.',
  constant: 'A constant, read into the values that use it.',
  component: 'A component with no props: its markup stands in its place.',
  wrapper: 'Several roots share one added div, because a placement has one root.',
  left: 'Not converted.',
  leftInTree: 'Not converted, and it can change what this component renders.',
  classPending: 'Classes are not converted yet.',
  classConverted: 'Classes became styles and rules.',
  classNoOutput: 'Tailwind produced nothing for this class.',
  classDynamic: 'Part of this class string is only known when the component runs.',
  classMerged: 'Removed, as tailwind-merge removes it in the original.',
  classKept: 'Kept as a class, because a selector reads it.',
  classKeptVariant: 'Kept as a class for every value, because a selector reads it, and the original has it for one value only.',
  classTable: 'A variant key or value here cannot be written as an attribute.',
  refusedRule: 'The rule parser refuses this output.',
  hoverGate: 'Hover uses the Hover state, so a device with hover and a coarse primary pointer shows none.',
  darkClass: 'Dark styles depend on a dark class, which a published page does not set: use the system setting instead, or accept.',
  raisedWeight: 'This value loses to a rule on its parent, where in the original it wins.',
  breakpointRem: 'A breakpoint here follows the frames in pixels, where the original follows the browser font size.',
  breakpointFrames: 'Some values follow the page frames and some stay at fixed widths, so on frames that are not the defaults they can move apart.',
  sheetRule: 'A rule in the stylesheet is not read yet, and it can change how this renders.',
  sheetAtRule: 'This at-rule is not read: it can be a program, or a utility nothing compiles.',
  sheetImport: 'This stylesheet import is never followed.',
  sheetSyntax: 'This stylesheet does not parse.',
  basePage: 'Base styles stay with the page, such as the text colour.',
  tokenName: 'This token name is refused, because it could reset the theme.',
  tokenValue: 'This token value is refused.',
  handler: 'An event handler is not converted yet.',
  ref: 'A ref is not converted.',
  childrenAttribute: 'Children given as an attribute are not converted.',
  spread: 'Spread props are not converted yet.',
  dynamicAttribute: 'This value is only known when the component runs.',
  dynamicChild: 'This child is only known when the component runs.',
  rootNotMarkup: 'What this returns is only known when the component runs.',
  entity: 'This character reference is not in the known table.',
  refusedTag: 'The render gate refuses this tag.',
  refusedAttribute: 'The render gate refuses this attribute or its value.',
  refusedStyle: 'The render gate refuses a declaration in this style.',
  platformAttribute: 'This attribute means something to the platform, so a source may not set it.',
  form: 'A form on a site works through the form island: use the form presets.',
  bareText: 'A browser moves text out of this element.',
  voidChildren: 'This element takes no content.',
  unknownComponent: 'An unknown component: it is not local, and its package is not read yet.',
  componentWithProps: 'A component that takes props or children is not inlined yet.',
  familyNoEntry: 'Several components and no usage: paste one that shows how they fit together.',
  nothingToPlace: 'Nothing here renders.',
  syntaxError: 'This file does not parse.',
  stylesheet: 'A stylesheet is not read yet, and it can change how this renders.',
  notRead: 'This file type is not read.',
  tailwindConfig: 'A Tailwind config is a program and is never run: put the theme in your CSS.',
  tooManyFiles: 'Too many files: an import takes at most 64.',
  fileTooLarge: 'A file is over 512 kilobytes.',
  inputTooLarge: 'These files are over 2 megabytes together.',
  tooDeep: 'Nested too deeply to read safely.',
  overNodes: 'Over 5,000 nodes: conversion stopped.',
  overDepth: 'Nodes nested more than 256 deep: conversion stopped.',
  overSteps: 'Too much markup to visit: conversion stopped.',
  overEvaluated: 'Evaluating this source passes 4 megabytes: conversion stopped.',
  overUnrolled: 'Over 5,000 repeated items: conversion stopped.',
  overInlining: 'Components nested more than 16 deep: conversion stopped.',
  overCandidates: 'Over 4,000 distinct classes: conversion stopped.',
  overVariants: 'This class stacks more than 8 variants, so it is not compiled.',
  overNegations: 'This class stacks more than two not- or has- variants, which can exhaust memory, so it is not compiled.',
  overRules: 'More rules than a node can hold, so none were stored.',
  recursive: 'A component that renders itself never ends: conversion stopped.',
  overLines: 'The rest of this source, which the report has no room to list line by line.',
  failed: 'The conversion failed on this source, so nothing was imported.',
} as const;

export type DetailKey = keyof typeof DETAILS;

const isSeenDifference = (line: ImportLine): boolean => line.disposition === 'adapted' && !line.invisible;

/** A verdict from the lines alone, so a stated one can be recomputed. */
export function verdictOf(lines: readonly ImportLine[], hasResult: boolean): Verdict {
  if (!hasResult || lines.some((line) => line.disposition === 'left' && line.nodeKey !== undefined)) return 'not-imported';
  return lines.some(isSeenDifference) ? 'imported-with-differences' : 'imported';
}

export function buildReport(lines: ImportLine[], hasResult: boolean): ImportReport {
  const counts: Record<Disposition, number> = { converted: 0, adapted: 0, rebuilt: 0, left: 0 };
  for (const line of lines) counts[line.disposition] += 1;
  return { lines, counts, verdict: verdictOf(lines, hasResult) };
}
