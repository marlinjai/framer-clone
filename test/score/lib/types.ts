// The shape of a primitive score run. See docs/plans/2026-11-01-complete-primitives.md,
// "The evaluation", for what the three instruments are.

/** The five questions the coverage matrix asks of every entry. */
export const SURFACES = ['format', 'renderer', 'canvas', 'panel', 'ai'] as const;
export type Surface = (typeof SURFACES)[number];

/** "not-tested" exists so an unmeasured cell can never count as a pass. */
export type CellStatus = 'pass' | 'fail' | 'not-tested';

export interface Cell {
  status: CellStatus;
  /** The named gap a failing cell belongs to. */
  gap?: GapId;
  /** What the test saw, when a plain pass or fail would mislead. */
  note?: string;
}

export const ROW_KINDS = [
  'html-element',
  'html-global-attribute',
  'css-property',
  'css-selector',
  'css-at-rule',
  'css-media-feature',
  'aria-pattern',
] as const;
export type RowKind = (typeof ROW_KINDS)[number];

/** One entry of the authoritative lists. */
export interface Entry {
  kind: RowKind;
  /** The name in the source data. */
  id: string;
  source: string;
  excluded?: string;
}

export type Row = Entry & { cells: Partial<Record<Surface, Cell>> };

/** A surface's results for one run, keyed by `rowKey`. */
export type SurfaceResults = Record<string, Cell>;

export function rowKey(kind: RowKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Every failure lands in one of these. `unclassified` is the only honest bucket
 * for a difference nobody has explained yet: it stays visible in the report.
 */
export const GAPS = {
  'selector-styles': 'CSS that needs a selector (states, pseudo-elements, structural selectors): a node only holds inline declarations, so no rule can be written.',
  'at-rules': 'At-rules: no way to store @keyframes, @container, @supports, @font-face and the rest.',
  'media-queries': 'Media queries beyond width: print, dark mode and reduced motion have no home.',
  'mixed-text': 'Text mixed with elements: a node holds one string or children, and the renderers drop the string.',
  'behaviour-state': 'Behaviour and state: no way to say that one element changes another.',
  'blocked-embedded-content': 'Embedded content dropped by blockedNodes.ts (iframe, object, embed, ...), although these are ordinary content elements.',
  'panel-no-general-editor': 'No general style or attribute editor in the properties panel: only what the hand-written sections expose.',
  'panel-no-tag-choice': 'No way to place or change to a given element from the editor: the palette offers few tags and the panel cannot change a tag.',
  'ai-style-allowlist': 'The AI generator validator only keeps style keys in CSS_PROP_SET.',
  'ai-tag-allowlist': 'The AI generator validator only keeps its tag list: anything else becomes a div or is dropped.',
  'ai-attribute-allowlist': 'The AI generator validator only keeps a short list of attributes.',
  'registry-tag-collision': 'A tag that is also a component registry id renders as that entry instead: type "form" comes out as a div.',
  'renderer-drops-value': 'A stored value a renderer refuses, overwrites or loses.',
  'react-attribute-handling': 'React drops or rewrites an attribute that is valid HTML.',
  'roundtrip-not-representable': 'A construct that cannot survive nodes to JSX and back, because the format has nowhere to put it.',
  'import-dynamic-logic': 'JSX that is a program, not markup: reported as left over by the static import, as the plan requires.',
  'layout-difference': 'Same declarations, different geometry or pixels, for a reason other than the gaps above.',
  'harness-limit': 'Not a product gap: the harness cannot yet decide this cell, so it is not counted as a pass.',
  unclassified: 'A difference no rule explains yet. Investigate before trusting the score.',
} as const;
export type GapId = keyof typeof GAPS;

/** The strongest statement a corpus check can make about one state of one fixture. */
export type CheckName = 'screenshot' | 'computed-styles' | 'accessibility-tree' | 'interaction';

export interface CorpusFailure {
  fixture: string;
  viewport: string;
  state: string;
  check: CheckName;
  gap: GapId;
  detail: string;
}

export interface CorpusResult {
  fixture: string;
  group: 'edge' | 'component';
  source: string;
  pass: boolean;
  /** Check counts over every viewport and state. */
  checks: Record<CheckName, { pass: number; total: number }>;
  failures: CorpusFailure[];
  notMeasured: string[];
}

export interface RoundTripCase {
  id: string;
  direction: 'nodes-jsx-nodes' | 'jsx-nodes-render';
  pass: boolean;
  gap?: GapId;
  detail?: string;
  /** What the import reported as not converted (never silently dropped). */
  leftOver?: string[];
}
