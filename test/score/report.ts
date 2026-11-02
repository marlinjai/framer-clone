// Turns one run's probe results into the score: latest.json for machines, latest.md
// for people, and the ratchet against baseline.json. No probe logic here: every
// number comes from a test's output.

import fs from 'node:fs';
import path from 'node:path';
import { componentEntries, dataVersions, scoredEntries } from './lib/universe';
import { REPORT_DIR, readOut } from './lib/io';
import { UNCAPTURED_PAGES, type UncapturedPage } from './busbasis/pages';
import {
  ACCEPTED_NOT_TAUGHT,
  GAPS,
  ROW_KINDS,
  SURFACES,
  rowKey,
  type Cell,
  type CorpusResult,
  type GapId,
  type RoundTripCase,
  type RowKind,
  type Surface,
  type SurfaceResults,
} from './lib/types';

interface PatternsOut {
  format: SurfaceResults;
  renderer: SurfaceResults;
  canvas: SurfaceResults;
  ai: SurfaceResults;
  vocabulary: Record<string, { tags: string[]; props: string[] }>;
}

interface PanelDetail {
  styleKeysWritten: string[];
  propKeysWritten: string[];
  typesWritten: string[];
  referencedNotDriven: string[];
  paletteTags: string[];
  /** The rows whose panel cell passes only through the text field for rules. */
  rawFieldRows: string[];
}

type Counts = { pass: number; fail: number; notTested: number; total: number };

const KIND_LABEL: Record<RowKind, string> = {
  'html-element': 'HTML elements',
  'html-global-attribute': 'HTML global attributes',
  'html-element-attribute': 'HTML attributes of single elements',
  'html-event-handler': 'HTML event handler attributes',
  'svg-element': 'SVG elements',
  'svg-attribute': 'SVG attributes',
  'mathml-element': 'MathML elements',
  'mathml-attribute': 'MathML attributes',
  'css-property': 'CSS properties',
  'css-value': 'CSS value types, functions and units',
  'css-selector': 'CSS selectors',
  'css-at-rule': 'CSS at-rules',
  'css-media-feature': 'CSS media features',
  'aria-pattern': 'WAI-ARIA patterns',
  component: 'Reusable component promises',
};

const SURFACE_LABEL: Record<Surface, string> = {
  format: 'Format stores it',
  renderer: 'Published renderer emits it',
  canvas: 'Editor canvas shows it',
  panel: 'Panel can edit it',
  ai: 'AI generator can produce it',
};

const blank = (): Counts => ({ pass: 0, fail: 0, notTested: 0, total: 0 });

function tally(counts: Counts, cell: Cell | undefined): void {
  counts.total += 1;
  if (cell?.status === 'pass') counts.pass += 1;
  else if (cell?.status === 'fail') counts.fail += 1;
  else counts.notTested += 1;
}

const percent = (part: number, whole: number) => (whole === 0 ? 'none' : `${((part / whole) * 100).toFixed(1)} percent`);
const ratio = (c: { pass: number; total: number }) => `${c.pass} of ${c.total} (${percent(c.pass, c.total)})`;

/** The panel cells that pass only through the text field for rules. */
const rawFieldCells = (score: Score): number => score.panel.rawFieldRows.length;

/** A pattern is editable only when every tag and prop it uses is. */
function patternPanelCells(patterns: PatternsOut, panel: SurfaceResults, detail: PanelDetail): SurfaceResults {
  const out: SurfaceResults = {};
  for (const [key, { tags, props }] of Object.entries(patterns.vocabulary)) {
    const missingTags = tags.filter((tag) => panel[rowKey('html-element', tag)]?.status !== 'pass');
    const missingProps = props.filter((prop) => prop !== 'style' && !detail.propKeysWritten.includes(prop));
    const missing = [...missingTags, ...missingProps];
    out[key] = missing.length === 0
      ? { status: 'pass' }
      : { status: 'fail', gap: missingTags.length > 0 ? 'panel-no-tag-choice' : 'panel-no-general-editor', note: `not editable: ${missing.join(', ')}` };
  }
  return out;
}

/** One gap across the real pages: a blocked need counts once per page, a difference once per computed value. */
export interface BusbasisGap {
  id: GapId;
  pages: string[];
  needs: number;
  styleDifferences: number;
}

/** Ranked by how many real pages it stops, then by how much of them it moves. */
function busbasisGaps(pages: CorpusResult[]): BusbasisGap[] {
  const gaps = new Map<GapId, BusbasisGap>();
  const entry = (id: GapId) => {
    const found = gaps.get(id) ?? { id, pages: [], needs: 0, styleDifferences: 0 };
    gaps.set(id, found);
    return found;
  };
  for (const page of pages) {
    for (const failure of page.failures) {
      const gap = entry(failure.gap);
      if (!gap.pages.includes(page.fixture)) gap.pages.push(page.fixture);
      if (failure.state.startsWith('needs: ')) gap.needs += 1;
    }
    for (const difference of page.differences ?? []) {
      for (const [id, count] of Object.entries(difference.byGap)) {
        const gap = entry(id as GapId);
        if (!gap.pages.includes(page.fixture)) gap.pages.push(page.fixture);
        gap.styleDifferences += count as number;
      }
    }
  }
  return [...gaps.values()].sort((a, b) => b.pages.length - a.pages.length || b.styleDifferences - a.styleDifferences);
}

export interface Score {
  generatedAt: string;
  versions: Record<string, string>;
  durationSeconds?: number;
  matrix: {
    surfaces: Record<Surface, Counts>;
    /** AI passes the prompt does not teach: earned, but weaker than the column reads. */
    acceptedNotTaught: number;
    byKind: Record<RowKind, Record<Surface, Counts>>;
    included: number;
    excluded: Array<{ kind: RowKind; id: string; reason: string }>;
    /** One line per entry: `format renderer canvas panel ai`, each `pass`, `not-tested` or the failure's gap. */
    rows: Record<string, string>;
  };
  corpus: {
    passed: number;
    total: number;
    checks: CorpusResult['checks'];
    fixtures: CorpusResult[];
  };
  /** The held-out real pages. Kept apart from `corpus`, whose checks the ratchet sums. */
  busbasis: {
    passed: number;
    total: number;
    pages: CorpusResult[];
    gaps: BusbasisGap[];
    uncaptured: UncapturedPage[];
  };
  roundTrip: {
    nodesToJsxToNodes: { pass: number; total: number };
    jsxToNodesToRender: { pass: number; total: number };
    cases: RoundTripCase[];
  };
  gaps: Array<{
    id: GapId;
    description: string;
    matrixCells: number;
    corpusChecks: number;
    fixtures: string[];
    onlyGapOf: string[];
    roundTripCases: number;
    cost: number;
  }>;
  panel: PanelDetail;
}

export function buildScore(durationSeconds?: number): Score {
  const results: Record<Surface, SurfaceResults> = {
    format: readOut('format'),
    renderer: readOut('renderer'),
    canvas: readOut('canvas'),
    panel: readOut('panel'),
    ai: readOut('ai'),
  };
  const patterns = readOut<PatternsOut>('patterns');
  const events = readOut<SurfaceResults>('events');
  const detail = readOut<PanelDetail>('panel-detail');
  const namespaces = readOut<SurfaceResults>('namespaces');
  const fixtures = readOut<CorpusResult[]>('corpus');
  const cases = readOut<RoundTripCase[]>('roundtrip');
  const pages = readOut<CorpusResult[]>('busbasis');

  // Markup that holds the tag is not yet an SVG or MathML element: the browser decides that.
  for (const [key, cell] of Object.entries(namespaces)) {
    if (cell.status !== 'pass' && results.renderer[key]?.status === 'pass') results.renderer[key] = cell;
  }

  // An event row asks whether a stored action runs from a real cause, on both.
  Object.assign(results.format, events);
  Object.assign(results.renderer, events);

  Object.assign(results.format, patterns.format);
  Object.assign(results.renderer, patterns.renderer);
  Object.assign(results.canvas, patterns.canvas);
  Object.assign(results.ai, patterns.ai);
  Object.assign(results.panel, patternPanelCells(patterns, results.panel, detail));

  // A promise nothing has measured yet fails, so it can never count as kept.
  const measured = {
    ...readOut<Partial<Record<Surface, SurfaceResults>>>('components'),
    canvas: readOut<SurfaceResults>('components-canvas'),
  };
  for (const entry of componentEntries()) {
    const key = rowKey(entry.kind, entry.id);
    for (const surface of SURFACES) {
      results[surface][key] = measured[surface]?.[key] ?? { status: 'fail', gap: 'reusable-components' };
    }
  }

  const entries = scoredEntries();
  const included = entries.filter((e) => !e.excluded);
  const surfaces = Object.fromEntries(SURFACES.map((s) => [s, blank()])) as Record<Surface, Counts>;
  const byKind = Object.fromEntries(
    ROW_KINDS.map((k) => [k, Object.fromEntries(SURFACES.map((s) => [s, blank()]))]),
  ) as Record<RowKind, Record<Surface, Counts>>;
  const gapCells = new Map<GapId, number>();
  const rows: Score['matrix']['rows'] = {};
  let acceptedNotTaught = 0;

  for (const entry of included) {
    const key = rowKey(entry.kind, entry.id);
    const cells: string[] = [];
    for (const surface of SURFACES) {
      const cell = results[surface][key];
      if (!cell) throw new Error(`no ${surface} result for ${key}: a probe skipped it`);
      cells.push(cell.status === 'fail' ? (cell.gap ?? 'fail') : cell.status);
      tally(surfaces[surface], cell);
      tally(byKind[entry.kind][surface], cell);
      if (cell.status === 'fail' && cell.gap) gapCells.set(cell.gap, (gapCells.get(cell.gap) ?? 0) + 1);
      if (cell.status === 'pass' && cell.note === ACCEPTED_NOT_TAUGHT) acceptedNotTaught += 1;
    }
    rows[key] = cells.join(' ');
  }

  const corpusChecks: CorpusResult['checks'] = {
    screenshot: { pass: 0, total: 0 },
    'computed-styles': { pass: 0, total: 0 },
    'accessibility-tree': { pass: 0, total: 0 },
    interaction: { pass: 0, total: 0 },
  };
  for (const fixture of fixtures) {
    for (const name of Object.keys(corpusChecks) as Array<keyof typeof corpusChecks>) {
      corpusChecks[name].pass += fixture.checks[name].pass;
      corpusChecks[name].total += fixture.checks[name].total;
    }
  }

  const direction = (d: RoundTripCase['direction']) => {
    const list = cases.filter((c) => c.direction === d);
    return { pass: list.filter((c) => c.pass).length, total: list.length };
  };

  const gapIds = Object.keys(GAPS) as GapId[];
  const gaps = gapIds
    .map((id) => {
      // A page's needs are declared, not measured, so they rank in the BusBasis table only.
      const measured = (x: CorpusResult['failures'][number]) => x.gap === id && !x.state.startsWith('needs: ');
      const inFixtures = [...fixtures, ...pages].filter((f) => f.failures.some(measured));
      const corpusFailures = [...fixtures, ...pages].flatMap((f) => f.failures.filter(measured)).length;
      const onlyGapOf = inFixtures.filter((f) => f.failures.every((x) => x.gap === id)).map((f) => f.fixture);
      const roundTripCases = cases.filter((c) => !c.pass && c.gap === id).length;
      const matrixCells = gapCells.get(id) ?? 0;
      return {
        id,
        description: GAPS[id],
        matrixCells,
        corpusChecks: corpusFailures,
        fixtures: inFixtures.map((f) => f.fixture),
        onlyGapOf,
        roundTripCases,
        cost: matrixCells + corpusFailures + roundTripCases,
      };
    })
    .filter((g) => g.cost > 0)
    .sort((a, b) => b.cost - a.cost);

  return {
    generatedAt: new Date().toISOString(),
    versions: dataVersions(),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    matrix: {
      surfaces,
      acceptedNotTaught,
      byKind,
      included: included.length,
      excluded: entries.filter((e) => e.excluded).map((e) => ({ kind: e.kind, id: e.id, reason: e.excluded as string })),
      rows,
    },
    corpus: { passed: fixtures.filter((f) => f.pass).length, total: fixtures.length, checks: corpusChecks, fixtures },
    // The total includes page types not captured yet, so the stop condition cannot read as met while any remain.
    busbasis: { passed: pages.filter((p) => p.pass).length, total: pages.length + UNCAPTURED_PAGES.length, pages, gaps: busbasisGaps(pages), uncaptured: UNCAPTURED_PAGES },
    roundTrip: { nodesToJsxToNodes: direction('nodes-jsx-nodes'), jsxToNodesToRender: direction('jsx-nodes-render'), cases },
    gaps,
    panel: detail,
  };
}

function table(head: string[], rows: string[][]): string {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

const escapeCell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderReport(score: Score): string {
  const { matrix, corpus, busbasis, roundTrip, gaps } = score;
  const lines: string[] = [];
  const push = (...text: string[]) => lines.push(...text, '');

  push(
    '---',
    'type: documentation',
    'title: "Primitive score: what framer-clone can express"',
    'summary: "Generated by pnpm score:primitives. The coverage matrix, parity corpus and round trip of the complete primitives plan, with every failure sorted into a named gap."',
    'tags: [framer-clone, primitives, expressiveness, parity]',
    'projects: [framer-clone]',
    '---',
    '',
    '# Primitive score',
  );
  push(
    `Generated by \`pnpm score:primitives\` on ${score.generatedAt.slice(0, 10)}. Do not edit by hand: the numbers come from tests, and \`latest.json\` beside this file holds every cell. The method is step 1 of [the complete primitives plan](../plans/2026-11-01-complete-primitives.md). "Not tested" never counts as a pass.`,
  );

  push('## Scores');
  const rtTotal = roundTrip.nodesToJsxToNodes.total + roundTrip.jsxToNodesToRender.total;
  const rtPass = roundTrip.nodesToJsxToNodes.pass + roundTrip.jsxToNodesToRender.pass;
  push(
    table(
      ['Instrument', 'Score'],
      [
        ...SURFACES.map((s) => [`Matrix: ${SURFACE_LABEL[s]}`, ratio(matrix.surfaces[s])]),
        ['Parity corpus: fixtures that pass entirely', ratio({ pass: corpus.passed, total: corpus.total })],
        ['BusBasis pages: held-out real pages that pass entirely', ratio({ pass: busbasis.passed, total: busbasis.total })],
        ['Round trip: all cases', ratio({ pass: rtPass, total: rtTotal })],
      ],
    ),
  );

  push('## Coverage matrix');
  push(
    `Entries: ${matrix.included} included, ${matrix.excluded.length} excluded with a reason (listed at the end). Sources: mdn-data ${score.versions['mdn-data']}, @mdn/browser-compat-data ${score.versions['@mdn/browser-compat-data']} (its html, svg, mathml and api trees), and the pattern index of the WAI-ARIA Authoring Practices Guide (the web standard's catalogue of accordions, tabs, dialogs and so on), hand-listed because no package carries it. CSS value rows are one per entry of mdn-data's types, functions and units. Chromium proves every value sample valid and compares the event handler rows with what it reflects, and a mismatch stops the run.`,
  );
  push(
    table(
      ['Kind', ...SURFACES.map((s) => SURFACE_LABEL[s])],
      ROW_KINDS.map((kind) => [
        KIND_LABEL[kind],
        ...SURFACES.map((s) => {
          const c = matrix.byKind[kind][s];
          return `${c.pass} of ${c.total}${c.notTested > 0 ? ` (${c.notTested} not tested)` : ''}`;
        }),
      ]),
    ),
  );
  push('What each cell means:');
  push(
    '- **Format stores it:** the entry is written into a node, survives `ComponentModel.create`, a snapshot, JSON and a second create, and is read back unchanged through `getResolvedProps`. For a selector, at-rule, media feature or event handler the bytes alone prove nothing (props are opaque JSON and hold anything), so it also needs a reader that gives it a meaning: it has to reach the page. An attribute named like a CSS property comes back as a style, which counts as stored.',
    '- **Published renderer emits it:** the node goes through `applyResponsiveStyles` and `renderComponentNode`. An element or attribute must be in the markup, an attribute on the opening tag of its own element, and when that element is missing the attribute takes the element\'s gap. An SVG or MathML entry sits inside its root element and Chromium must parse the tag into that namespace. A CSS property must be there both ways a declaration reaches a page: inline, and in the page stylesheet as a responsive value, with `initial` as the value. A value row does the same with its sample on a host property. A WAI-ARIA pattern must pass its keyboard contract in real Chromium.',
    '- **Editor canvas shows it:** the same entry through the real `ComponentRenderer` with a real store, rendered to markup. An SVG attribute that arrives as a style declaration passes, because SVG maps those to the same property; an HTML one is `attribute-read-as-style`. A WAI-ARIA pattern runs its contract on the mounted editor instead: the real `EditorApp` in Chromium with the tree on a page, its server edge stubbed. A contract that passes when published and fails there is `canvas-editor-context`. A rule row renders the canvas sheet beside it and reads the text that sheet holds: pointer states and conditions on the editor must be dead until previewed, and the frame must answer a width.',
    '- **Panel can edit it:** the real `RightSidebar` is mounted for a node of each component category and every control is operated. A key counts only if an action changed it in the node, and an attribute only on the tag the action changed it on. An element counts when a palette entry produces it or a panel action sets it. A pattern counts when every tag and prop it uses does. A value row counts only for the kinds the driver types (a length, a color, a number) and when a control kept what was typed.',
    '- **AI generator can produce it:** `validateGeneration` is given a node with the entry, and the entry must still be there afterwards. A tag rewritten to `div` is a fail. A value row needs the exact value back. A sample on a host property outside the allowlist fails as `ai-style-allowlist`, so it says nothing about the value. A rule row needs its stored rule back unchanged, and carries the note `accepted, not taught` unless the prompt teaches that form. A rule that reads a visitor or looks past its node is `ai-rule-refused`: that is a safety decision, not a missing feature.',
    '- **A reusable component row** is a promise of the format, not a web standard entry. Format: it survives the snapshot round trip with a reader. Published: it is emitted through `renderPublishedPage`. Canvas: it renders through the real `ComponentRenderer`. Panel: it changes through the real section. AI: it survives `validateGeneration`. A pass here proves less than it reads: the corpus is the test.',
  );
  push(
    `The panel writes ${score.panel.styleKeysWritten.length} style keys and ${score.panel.propKeysWritten.length} other props across every category. Palette tags: ${score.panel.paletteTags.map((t) => `\`${t}\``).join(', ')}.`,
    '',
    `Of the panel's passing cells, ${rawFieldCells(score)} are the \`raw field\`: a person typed the CSS, and no control exists for it. They pass, and they say less than a control would.`,
    `Of the AI generator's passing cells, ${matrix.acceptedNotTaught} are \`accepted, not taught\`: the validator keeps the rule, and the prompt never asks for it. They pass, and they say the generator can write the form, not that it will.`,
  );

  push('## Parity corpus');
  push(
    'Each fixture is an original next to the closest node tree, rendered through the published path, in Playwright\'s Chromium, at the three default breakpoints and in each scripted state. A check fails on more than 0.1 percent of pixels differing (per-pixel threshold 0.1), any computed style difference on matched elements including `::before` and `::after` content, or any difference in the accessibility tree. A fixture passes only when every check passes. The interaction check is not independent: it passes when the other three pass in that scripted state, so one failed state counts up to four times in the check totals and in a gap\'s cost. A check that fails on the published page but passes on the same output without the page base goes to `published-base`. Any other difference goes to a gap that comes from the state it appeared in or from the fixture\'s declared purpose, except that text missing from an untouched page is `mixed-text` and a differing `::before` or `::after` is `selector-styles`.',
  );
  push(
    table(
      ['Fixture', 'Source', 'Result', 'Screenshots', 'Computed styles', 'Accessibility tree', 'Interactions', 'Gaps'],
      corpus.fixtures.map((f) => [
        f.fixture,
        escapeCell(f.source),
        f.pass ? 'pass' : 'fail',
        `${f.checks.screenshot.pass}/${f.checks.screenshot.total}`,
        `${f.checks['computed-styles'].pass}/${f.checks['computed-styles'].total}`,
        `${f.checks['accessibility-tree'].pass}/${f.checks['accessibility-tree'].total}`,
        `${f.checks.interaction.pass}/${f.checks.interaction.total}`,
        [...new Set(f.failures.map((x) => x.gap))].join(', ') || 'none',
      ]),
    ),
  );

  push('## BusBasis pages (held out)');
  push(
    `The stop condition of the primitive stream is that every BusBasis page passes, so these are real pages of basiscampberlin.de frozen from the live site, not small fixtures, and ${UNCAPTURED_PAGES.length} more page types are listed below as not captured. Each tree is lifted mechanically by \`test/score/busbasis/lift.ts\`, one rule set for all pages, with no page-specific code. The checks are the corpus checks, except that custom properties are not compared (their effect shows in what reads them) and images and video are same-size placeholders, so image content is not compared. A page also fails on everything under "needs": a page that matches pixel for pixel is not that page while what it exists for does not work. The files are held out: nothing in \`test/score/corpus/busbasis\` changes without a new capture, and the run stops when a hash does not match.`,
  );
  const worst = (page: CorpusResult, read: (d: NonNullable<CorpusResult['differences']>[number]) => number) => Math.max(0, ...(page.differences ?? []).map(read));
  push(
    table(
      ['Page type', 'Source', 'Result', 'Screenshots', 'Computed styles', 'Accessibility tree', 'Hover', 'Worst pixels differing', 'Worst elements differing', 'Blocked by'],
      busbasis.pages.map((p) => {
        const needs = p.failures.filter((f) => f.state.startsWith('needs: '));
        const hover = { pass: p.checks.interaction.pass, total: p.checks.interaction.total - needs.length };
        const compared = worst(p, (d) => d.elementsCompared);
        return [
          escapeCell(p.pageType ?? p.fixture),
          escapeCell(p.source),
          p.pass ? 'pass' : 'fail',
          `${p.checks.screenshot.pass}/${p.checks.screenshot.total}`,
          `${p.checks['computed-styles'].pass}/${p.checks['computed-styles'].total}`,
          `${p.checks['accessibility-tree'].pass}/${p.checks['accessibility-tree'].total}`,
          `${hover.pass}/${hover.total}`,
          `${(worst(p, (d) => d.ratio) * 100).toFixed(1)} percent`,
          `${worst(p, (d) => d.elementsDiffering)} of ${compared}`,
          escapeCell(needs.map((f) => f.state.slice('needs: '.length)).join('; ') || 'none'),
        ];
      }),
    ),
  );
  push('Gaps on these pages, most pages first. "Needs" counts pages a missing feature stops; "Style differences" counts computed values across every viewport.');
  push(
    table(
      ['Gap', 'Pages', 'Needs', 'Style differences', 'What it is'],
      busbasis.gaps.map((g) => [`\`${g.id}\``, String(g.pages.length), String(g.needs), String(g.styleDifferences), escapeCell(GAPS[g.id])]),
    ),
  );
  push('Not captured, and still counted against the stop condition:');
  push(table(['Page type', 'Address', 'Why'], busbasis.uncaptured.map((p) => [escapeCell(p.pageType), escapeCell(p.path), escapeCell(p.reason)])));

  push('## Round trip');
  push(
    `Nodes to JSX (React's markup syntax) to nodes, over the plan's normalised form: ${ratio(roundTrip.nodesToJsxToNodes)}. Static JSX to nodes, rendered against what React renders from the same JSX, and exported again: ${ratio(roundTrip.jsxToNodesToRender)}. The export and import live in \`test/score/roundtrip/jsx.ts\` and go no further than this test needs.`,
  );
  const failedCases = roundTrip.cases.filter((c) => !c.pass);
  if (failedCases.length > 0) {
    push(
      table(
        ['Case', 'Gap', 'What happened'],
        failedCases.map((c) => [escapeCell(c.id), c.gap ?? '', escapeCell((c.leftOver ?? [c.detail ?? '']).join('; ').slice(0, 160))]),
      ),
    );
  }

  push('## Named gaps, by cost');
  push(
    'Cost is matrix cells, failed corpus checks and failed round-trip cases added up, so a wide gap ranks above a deep one, and a row that fails in all five columns costs five. It says how much of the lists a gap covers, not how often a real page hits it: text mixed with elements has no matrix row at all and only one fixture so far, so its low cost says nothing about how common it is. "Alone blocks" lists the fixtures where this is the only gap left, which is where fixing it turns a fixture green.',
  );
  push(
    table(
      ['Gap', 'Cost', 'Matrix cells', 'Corpus checks', 'Round trip', 'Fixtures', 'Alone blocks', 'What it is'],
      gaps.map((g) => [
        `\`${g.id}\``,
        String(g.cost),
        String(g.matrixCells),
        String(g.corpusChecks),
        String(g.roundTripCases),
        String(g.fixtures.length),
        g.onlyGapOf.join(', ') || 'none',
        escapeCell(g.description),
      ]),
    ),
  );

  push('## What this does not measure yet');
  push(
    '- **CSS value grammar per property.** A value row is one sample on one host property, so it proves the value type survives, not that every property takes every type. Named syntaxes in mdn-data below the level of a type (such as `<bg-size>`) have no row.',
    '- **Attribute value grammar.** An attribute row proves the name reaches the page with one value. SVG and MathML samples are not checked for meaning, MathML attribute value notes have no row, and ARIA roles and attributes are still one sample each.',
    '- **Handlers on `body` and `window`** (`onbeforeunload`, `onhashchange`, ...), because `body` is excluded. An event row is one stored action run once from one real cause, in Chromium, on the published path with the runtime bundled in. On the canvas and in the panel it still asks the old question until slices B10 and B11.',
    '- **Canvas markup beyond the patterns.** Only the WAI-ARIA rows run on the mounted editor, and only by keyboard: their contracts never click, so a click that selects shows up through Enter and Space. Everything else in the canvas column is rendered to markup. `canvasRules.score.ts` runs stored rules on the mounted editor with a real pointer, as a gate that counts for no row, so a canvas cell for a rule says the text is in the sheet and that gate says what the text does. Dragging under a rule is not tested.',
    '- **Whether a panel control is any good.** A key counts as editable when a control changed it, whatever range or units that control offers. Only the properties panel and the palette are covered: the quick toolbar, context menus and the Layers panel were searched for tag changes and none found, not driven.',
    '- **The whole published page.** The corpus uses `applyResponsiveStyles` and `renderComponentNode`, without `hydrateBindings`, effects, the sticky bar, or the consent and font wrappers, and only in Chromium. The page around it is real: the sheet of a production build (`test/score/data/published-base.css`, refreshed by `pnpm score:refresh-base`). Its utilities also follow classes in `test` and `docs`, which the deployed image does not scan, so it can hold a few the live sheet lacks.',
    '- **WAI-ARIA conformance.** A contract is the primary keyboard path of a pattern, not its whole page in the Guide.',
    '- **Page-level items:** head tags, design tokens and page-wide scripts (gap 5 of the plan) have no rows, and script and style elements are excluded with a reason.',
    '- **Script on the BusBasis pages.** A frozen page holds no script, so menus, modals, filters and the gallery cannot run on the original. They stand under "needs" as failures rather than as compared states. A page is frozen in one state: logged out, no cart, the first visit.',
    '- **React import beyond static JSX.** Tailwind classes, props as inputs and the AI rebuild step of the plan are not built.',
  );

  push('## Excluded entries');
  const grouped = new Map<string, Array<{ kind: RowKind; id: string }>>();
  for (const e of matrix.excluded) grouped.set(e.reason, [...(grouped.get(e.reason) ?? []), e]);
  push(
    table(
      ['Reason', 'Count', 'Entries'],
      [...grouped.entries()].map(([reason, list]) => {
        const names = list.map((e) => e.id);
        return [escapeCell(reason), String(list.length), escapeCell(names.slice(0, 12).map((n) => `\`${n}\``).join(', ') + (names.length > 12 ? ', and more' : ''))];
      }),
    ),
  );

  return lines.join('\n');
}

export function writeScore(score: Score): void {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORT_DIR, 'latest.json'), `${JSON.stringify(score, null, 2)}\n`);
  fs.writeFileSync(path.join(REPORT_DIR, 'latest.md'), renderReport(score));
}

interface Baseline {
  _doc: string;
  matrix: Record<Surface, number>;
  corpusFixtures: string[];
  corpusChecks: number;
  roundTrip: number;
}

const BASELINE_FILE = () => path.join(REPORT_DIR, 'baseline.json');

function baselineOf(score: Score): Baseline {
  return {
    _doc: 'The ratchet floor, not a cache: pnpm score:primitives fails when any number drops below this. Raising it is a deliberate commit: pnpm score:primitives --update-baseline.',
    matrix: Object.fromEntries(SURFACES.map((s) => [s, score.matrix.surfaces[s].pass])) as Record<Surface, number>,
    corpusFixtures: [...score.corpus.fixtures, ...score.busbasis.pages].filter((f) => f.pass).map((f) => f.fixture),
    corpusChecks: Object.values(score.corpus.checks).reduce((sum, c) => sum + c.pass, 0),
    roundTrip: score.roundTrip.nodesToJsxToNodes.pass + score.roundTrip.jsxToNodesToRender.pass,
  };
}

/** The drops against the committed floor; empty when nothing dropped. */
export function checkRatchet(score: Score): string[] {
  const file = BASELINE_FILE();
  if (!fs.existsSync(file)) return [`no baseline at ${file}: run pnpm score:primitives --update-baseline`];
  const floor = JSON.parse(fs.readFileSync(file, 'utf8')) as Baseline;
  const now = baselineOf(score);
  const drops: string[] = [];
  for (const surface of SURFACES) {
    if (now.matrix[surface] < floor.matrix[surface]) {
      drops.push(`matrix, ${SURFACE_LABEL[surface]}: ${floor.matrix[surface]} became ${now.matrix[surface]}`);
    }
  }
  for (const fixture of floor.corpusFixtures) {
    if (!now.corpusFixtures.includes(fixture)) drops.push(`corpus: ${fixture} no longer passes`);
  }
  if (now.corpusChecks < floor.corpusChecks) drops.push(`corpus checks: ${floor.corpusChecks} became ${now.corpusChecks}`);
  if (now.roundTrip < floor.roundTrip) drops.push(`round trip: ${floor.roundTrip} became ${now.roundTrip}`);
  return drops;
}

export function writeBaseline(score: Score): void {
  fs.writeFileSync(BASELINE_FILE(), `${JSON.stringify(baselineOf(score), null, 2)}\n`);
}
