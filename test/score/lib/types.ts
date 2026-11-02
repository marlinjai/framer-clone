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

/** A cell the prompt does not teach: acceptance alone earned it. */
export const ACCEPTED_NOT_TAUGHT = 'accepted, not taught';

export const ROW_KINDS = [
  'html-element',
  'html-global-attribute',
  'html-element-attribute',
  'html-event-handler',
  'svg-element',
  'svg-attribute',
  'mathml-element',
  'mathml-attribute',
  'css-property',
  'css-value',
  'css-selector',
  'css-at-rule',
  'css-media-feature',
  'aria-pattern',
  'component',
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
  'page-level-css': 'CSS that applies to the document rather than a node (view transitions, `@page`, `@layer`): the route owns `html`. A rule on `:root` on the page root is the one form held today.',
  'mixed-text': 'Text mixed with elements: text beside an element is lost or lands out of order.',
  'behaviour-state': 'Behaviour and state: no way to say that one element changes another.',
  'blocked-embedded-content': 'What the render gate refuses (blockedNodes.ts and renderVocabulary.ts): embedded content (iframe, object, embed, ...), although these are ordinary content elements, and attributes that act by themselves (ping, the shadow root ones).',
  'panel-no-general-editor': 'What the Custom section of the properties panel, the general style and attribute editor, cannot write: SVG and MathML attributes.',
  'panel-no-tag-choice': 'The tag picker of the Custom section does not offer SVG and MathML elements.',
  'ai-rule-refused': 'A rule that reads what a visitor does or looks beyond its node: stored and rendered, but refused to the generator on purpose, because a generation must not be able to report a visitor. See "AI output" in the selector styling plan.',
  'ai-style-allowlist': 'The AI generator validator drops a CSS property it does not know.',
  'ai-tag-allowlist': 'The AI generator validator refuses this tag on purpose: blocked in every renderer, or a raw form control, which only works through the form presets.',
  'ai-attribute-allowlist': 'The AI generator validator refuses this attribute on purpose, or a tree lost a raw form control (see the tag gap).',
  'ai-value-refused': 'The AI generator validator keeps the property but refuses this value.',
  'attribute-read-as-style': 'An HTML attribute whose name is also a CSS property (width, height) is read as a style, so the editor loses the attribute: a canvas bitmap size or an image size hint is not the same as a declaration.',
  'blocked-event-handlers': 'A stored event handler attribute is a string of code, so both renderers drop it on purpose (blockedNodes.ts). A cell here means no stored action ran from a real cause: the note says why, and the published page and the format already run most of them (events.score.ts). The canvas, the panel and the AI columns still wait for slices B10 to B12.',
  'canvas-editor-context': 'The contract passes on the published page, but the mounted editor changes the outcome: Space pans, a link does not navigate, and the editor\'s own main element stops a header inside it being a banner. Closing it takes an interact mode on the canvas.',
  'registry-tag-collision': 'A tag that is also a component registry id renders as that entry instead: type "form" comes out as a div.',
  'renderer-drops-value': 'A stored value a renderer refuses, overwrites or loses.',
  'empty-custom-property': 'A custom property with an empty value, such as `--tw-blur: ;`, is dropped on its way into the page stylesheet, so every var() list that reads it goes invalid. Tailwind writes these for filter, backdrop-filter and gradients.',
  'react-attribute-handling': 'React drops or rewrites an attribute that is valid HTML.',
  'roundtrip-not-representable': 'A construct that cannot survive nodes to JSX and back, because the format has nowhere to put it.',
  'import-dynamic-logic': 'JSX that is a program, not markup: reported as left over by the static import, as the plan requires.',
  'reusable-components': 'A promise of the reusable component format (an input type, a placement, a state or an interaction) that this surface does not keep yet.',
  'published-base': 'The published route ships the root layout\'s sheet to every visitor (Tailwind\'s reset, the theme, the base layer), and the page base of a site takes that out again. A check here fails with that sheet in place and passes on a page without it, so the page base left something behind. Measured, not guessed: the same replica matches its original on a page without the base.',
  'shop-feature-missing': 'A real BusBasis page depends on a shop feature that is not built: the page stays failed however close its pixels are.',
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

/** How far one real page is from its original in one state, for the ranked gap list. */
export interface PageDifference {
  viewport: string;
  state: string;
  ratio: number;
  elementsCompared: number;
  elementsDiffering: number;
  differences: number;
  byGap: Partial<Record<GapId, number>>;
  byProperty: [string, number][];
}

export interface CorpusResult {
  fixture: string;
  group: 'edge' | 'component' | 'held-out';
  source: string;
  pass: boolean;
  /** Check counts over every viewport and state. */
  checks: Record<CheckName, { pass: number; total: number }>;
  failures: CorpusFailure[];
  notMeasured: string[];
  /** A corpus fixture: its untouched page per breakpoint on the default page base, all three checks at once. */
  defaultBase?: { pass: number; total: number };
  /** A held-out page: what kind of page it is, and its differences per viewport. */
  pageType?: string;
  differences?: PageDifference[];
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
