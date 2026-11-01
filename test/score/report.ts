// Turns one run's probe results into the score: latest.json for machines, latest.md
// for people, and the ratchet against baseline.json. No probe logic here: every
// number comes from a test's output.

import fs from 'node:fs';
import path from 'node:path';
import { allEntries, dataVersions } from './lib/universe';
import { REPORT_DIR, readOut } from './lib/io';
import {
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
}

type Counts = { pass: number; fail: number; notTested: number; total: number };

const KIND_LABEL: Record<RowKind, string> = {
  'html-element': 'HTML elements',
  'html-global-attribute': 'HTML global attributes',
  'css-property': 'CSS properties',
  'css-selector': 'CSS selectors',
  'css-at-rule': 'CSS at-rules',
  'css-media-feature': 'CSS media features',
  'aria-pattern': 'WAI-ARIA patterns',
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

export interface Score {
  generatedAt: string;
  versions: Record<string, string>;
  durationSeconds?: number;
  matrix: {
    surfaces: Record<Surface, Counts>;
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
  const detail = readOut<PanelDetail>('panel-detail');
  const fixtures = readOut<CorpusResult[]>('corpus');
  const cases = readOut<RoundTripCase[]>('roundtrip');

  Object.assign(results.format, patterns.format);
  Object.assign(results.renderer, patterns.renderer);
  Object.assign(results.canvas, patterns.canvas);
  Object.assign(results.ai, patterns.ai);
  Object.assign(results.panel, patternPanelCells(patterns, results.panel, detail));

  const entries = allEntries();
  const included = entries.filter((e) => !e.excluded);
  const surfaces = Object.fromEntries(SURFACES.map((s) => [s, blank()])) as Record<Surface, Counts>;
  const byKind = Object.fromEntries(
    ROW_KINDS.map((k) => [k, Object.fromEntries(SURFACES.map((s) => [s, blank()]))]),
  ) as Record<RowKind, Record<Surface, Counts>>;
  const gapCells = new Map<GapId, number>();
  const rows: Score['matrix']['rows'] = {};

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
      const inFixtures = fixtures.filter((f) => f.failures.some((x) => x.gap === id));
      const corpusFailures = fixtures.flatMap((f) => f.failures.filter((x) => x.gap === id)).length;
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
      byKind,
      included: included.length,
      excluded: entries.filter((e) => e.excluded).map((e) => ({ kind: e.kind, id: e.id, reason: e.excluded as string })),
      rows,
    },
    corpus: { passed: fixtures.filter((f) => f.pass).length, total: fixtures.length, checks: corpusChecks, fixtures },
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
  const { matrix, corpus, roundTrip, gaps } = score;
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
        ['Round trip: all cases', ratio({ pass: rtPass, total: rtTotal })],
      ],
    ),
  );

  push('## Coverage matrix');
  push(
    `Entries: ${matrix.included} included, ${matrix.excluded.length} excluded with a reason (listed at the end). Sources: mdn-data ${score.versions['mdn-data']}, @mdn/browser-compat-data ${score.versions['@mdn/browser-compat-data']}, and the pattern index of the WAI-ARIA Authoring Practices Guide (the web standard's catalogue of accordions, tabs, dialogs and so on), hand-listed because no package carries it.`,
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
    '- **Format stores it:** the entry is written into a node, survives `ComponentModel.create`, a snapshot, JSON and a second create, and is read back unchanged through `getResolvedProps`. For a selector, at-rule or media feature the bytes alone prove nothing (props are opaque JSON and hold anything), so it also needs a reader that gives it a meaning: the rule has to reach the page.',
    '- **Published renderer emits it:** the node goes through `applyResponsiveStyles` and `renderComponentNode`. An element or attribute must be in the markup. A CSS property must be there both ways a declaration reaches a page: inline, and in the page stylesheet as a responsive value. The value is `initial` for every property, so this measures that the property name survives, not the property\'s value grammar. A WAI-ARIA pattern must pass its keyboard contract in real Chromium.',
    '- **Editor canvas shows it:** the same entry through the real `ComponentRenderer` with a real store, rendered to markup. WAI-ARIA contracts do not run there yet, so that row is not tested.',
    '- **Panel can edit it:** the real `RightSidebar` is mounted for a node of each component category and every control is operated. A key counts only if an action changed it in the node. An element counts when a palette entry produces it or a panel action sets it. A pattern counts when every tag and prop it uses does.',
    '- **AI generator can produce it:** `validateGeneration` is given a node with the entry, and the entry must still be there afterwards. A tag rewritten to `div` is a fail.',
  );
  push(
    `The panel writes ${score.panel.styleKeysWritten.length} style keys and ${score.panel.propKeysWritten.length} other props across every category. Palette tags: ${score.panel.paletteTags.map((t) => `\`${t}\``).join(', ')}.`,
  );

  push('## Parity corpus');
  push(
    'Each fixture is an original next to the closest node tree, rendered through the published path, in Playwright\'s Chromium, at the three default breakpoints and in each scripted state. A check fails on more than 0.1 percent of pixels differing (per-pixel threshold 0.1), any computed style difference on matched elements including `::before` and `::after` content, or any difference in the accessibility tree. A fixture passes only when every check passes. The interaction check is not independent: it passes when the other three pass in that scripted state, so one failed state counts up to four times in the check totals and in a gap\'s cost. Which gap a difference goes to comes from the state it appeared in or from the fixture\'s declared purpose, except that text missing from an untouched page is always `mixed-text` and a differing `::before` or `::after` is always `selector-styles`.',
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
    '- **CSS value grammar.** Every property is probed with `initial`, so a value the stylesheet refuses shows up only where a fixture happens to use one (`stylesheet-values`).',
    '- **Attributes of single elements** (`href`, `src`, `type`, ...), event handler attributes, SVG and MathML elements, and ARIA roles and attributes beyond one sample each. The lists cover HTML elements and global attributes, as the plan says.',
    '- **The mounted canvas.** The canvas column renders `ComponentRenderer` to markup. Nothing runs in a browser with the editor around it, so interactions on the canvas, which the plan requires, are not tested (the 30 WAI-ARIA rows).',
    '- **Whether a panel control is any good.** A key counts as editable when a control changed it, whatever range or units that control offers. Only the properties panel and the palette are covered: the quick toolbar, context menus and the Layers panel were searched for tag changes and none found, not driven.',
    '- **The whole published page.** The corpus uses `applyResponsiveStyles` and `renderComponentNode`, without `hydrateBindings`, effects, the sticky bar, or the consent and font wrappers, and only in Chromium.',
    '- **WAI-ARIA conformance.** A contract is the primary keyboard path of a pattern, not its whole page in the Guide.',
    '- **Page-level items and reuse:** head tags, design tokens, page-wide scripts and reusable components (gaps 4 and 5 of the plan) have no rows, and script and style elements are excluded with a reason.',
    '- **The BusBasis storefront,** the part of the corpus that would say how often a real shop hits each gap. So the corpus is 13 small fixtures chosen to find gaps, and its pass rate is no estimate of real pages.',
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
        return [escapeCell(reason), String(list.length), escapeCell(names.slice(0, 12).join(', ') + (names.length > 12 ? ', and more' : ''))];
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
    corpusFixtures: score.corpus.fixtures.filter((f) => f.pass).map((f) => f.fixture),
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
