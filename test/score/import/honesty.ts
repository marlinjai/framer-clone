// Honesty: a fixture whose verdict says "imported" or "imported with differences" must not
// differ from its original in a way no line of its report names. Each row below is a
// detail of the report and the differences it names, with the reason that line covers
// them. A difference no row excuses is a Honesty failure, whatever the verdict.
//
// The rows are judgement, measured against what the score showed, and each says why. A
// row that excuses too much makes this measure blind, so a row names the properties and
// the element it is about, never "anything".

import { DETAILS } from '@/lib/reactImport/report';
import type { ImportLine } from '@/lib/reactImport/report';

export interface Difference {
  /** The parity id: `r` for the import's root, `r.0` for its first element child. */
  element: string;
  /** A computed property, or `missing`, `text`, `rendered text`, `::before`, `::after`. */
  property: string;
}

export interface ExcuseContext {
  /** The node id at each parity id of the replica, so a line about a node is matched to its element. */
  nodeAt: ReadonlyMap<string, string>;
  /** The CSS properties each replica element's own node writes, in its style or its rules. */
  writes: ReadonlyMap<string, ReadonlySet<string>>;
  lines: readonly ImportLine[];
}

/** The parity ids from the import's root down to this one: `r.0.1` is `r`, `r.0`, `r.0.1`. */
const pathTo = (element: string): string[] => element.split('.').map((_, i, parts) => parts.slice(0, i + 1).join('.'));

/** Whether nothing of the import on the way to this element writes the property, so it comes from the page. */
const inheritedFromPage = (element: string, property: string, context: ExcuseContext): boolean =>
  pathTo(element).every((each) => !context.writes.get(each)?.has(property));

interface Excuse {
  detail: string;
  /** Why this line covers these differences. */
  reason: string;
  covers: (difference: Difference, line: ImportLine, context: ExcuseContext) => boolean;
}

/**
 * What a page decides, and an import does not carry: the text colour and font a component inherits, and
 * the body itself. `basePage` says "Base styles stay with the page, such as the text colour", which is
 * exactly this. Only inherited properties, so a colour the import sets on a node stays measured.
 */
const PAGE_INHERITED: ReadonlySet<string> = new Set([
  'color', 'caret-color', 'text-decoration-color', 'text-emphasis-color', '-webkit-text-fill-color', '-webkit-text-stroke-color', 'column-rule-color',
  'font-family', '-webkit-font-smoothing', '-moz-osx-font-smoothing', 'font-feature-settings', 'font-variation-settings', 'text-rendering',
]);

/**
 * Properties an icon takes from `currentColor`, so they follow an inherited colour. Borders and outlines do
 * not: the page base gives every element `var(--border)` and `var(--ring)`, which the import writes.
 */
const FOLLOWS_COLOR: ReadonlySet<string> = new Set(['fill', 'stroke']);

const EXCUSES: readonly Excuse[] = [
  {
    detail: DETAILS.basePage,
    reason: 'The source\'s base gives `body` its text colour and font, which stay with the page: what the import inherits from the page without writing it itself.',
    covers: ({ element, property }, _line, context) => PAGE_INHERITED.has(property) && inheritedFromPage(element, property, context),
  },
];

/** Whether a difference follows from one the report names: a `currentcolor` property follows `color`. */
function followsExcused(difference: Difference, excused: (each: Difference) => boolean, context: ExcuseContext): boolean {
  return FOLLOWS_COLOR.has(difference.property) && inheritedFromPage(difference.element, difference.property, context)
    && excused({ element: difference.element, property: 'color' });
}

/** The differences no line of the report names. */
export function unnamed(differences: readonly Difference[], context: ExcuseContext): Difference[] {
  const named = (difference: Difference) => context.lines.some((line) => {
    if (line.disposition !== 'adapted' || line.invisible) return false;
    return EXCUSES.some((excuse) => excuse.detail === line.detail && excuse.covers(difference, line, context));
  });
  return differences.filter((difference) => !named(difference) && !followsExcused(difference, named, context));
}

/** The table, for the report. */
export const EXCUSE_ROWS = EXCUSES.map(({ detail, reason }) => ({ detail, reason }));
