// Builds the "Framer, native" comparison from a published primitive score (latest.json): every
// matrix row gets a Framer verdict (mapping.ts), shown next to our own published renderer and
// panel cells for the same row. Pure: no clock, no network, so two runs over the same input are
// byte for byte equal.

import { KIND_LABEL, ROW_KINDS, SURFACES, type RowKind, type Surface } from '../types';
import { FRAMER_VERDICTS, classifyFramer, type FramerVerdict, type FramerVerdictName } from './mapping';
import { FRAMER_DOCS, FRAMER_PLUGIN } from './typings';

/** The slice of latest.json this report reads. */
export interface PublishedScore {
  generatedAt: string;
  matrix: {
    included: number;
    /** `"<kind>:<id>"` to the cells in SURFACES order, joined by spaces: `pass` or a gap id. */
    rows: Record<string, string>;
  };
}

export type VerdictCounts = Record<FramerVerdictName, number>;

export interface FramerKindScore {
  kind: RowKind;
  label: string;
  total: number;
  framer: VerdictCounts;
  /** native plus partial: a typed path exists. */
  framerTyped: number;
  ourRenderer: number;
  ourPanel: number;
  /** Rows Framer types (native or partial) that our published renderer fails. */
  framerTypedOursFails: number;
  /** Rows our published renderer passes that Framer does not type (code-only or unknown). */
  oursPassesFramerUntyped: number;
  /** Rows Framer types (native or partial) that our panel cannot edit. */
  framerTypedPanelFails: number;
}

export interface FramerRow extends FramerVerdict {
  key: string;
  kind: RowKind;
  id: string;
  ourRenderer: boolean;
  ourPanel: boolean;
}

export interface FramerScore {
  comparedWith: { file: string; generatedAt: string; included: number };
  framerPlugin: typeof FRAMER_PLUGIN;
  totals: { rows: number; framer: VerdictCounts; framerTyped: number; ourRenderer: number; ourPanel: number; documentedNotMeasured: number };
  byKind: FramerKindScore[];
  rows: FramerRow[];
}

const SURFACE_INDEX = (surface: Surface): number => SURFACES.indexOf(surface);

function emptyCounts(): VerdictCounts {
  return Object.fromEntries(FRAMER_VERDICTS.map((v) => [v, 0])) as VerdictCounts;
}

function parseCells(key: string, cells: string): string[] {
  const parts = cells.split(' ');
  if (parts.length !== SURFACES.length) {
    throw new Error(`row ${key} has ${parts.length} cells, expected ${SURFACES.length} (${SURFACES.join(', ')})`);
  }
  return parts;
}

export function buildFramerScore(published: PublishedScore, file = 'docs/primitives-score/latest.json'): FramerScore {
  const keys = Object.keys(published.matrix.rows).sort();
  if (keys.length !== published.matrix.included) {
    throw new Error(`latest.json lists ${keys.length} rows but says ${published.matrix.included} are included`);
  }

  const rows: FramerRow[] = keys.map((key) => {
    const separator = key.indexOf(':');
    if (separator <= 0) throw new Error(`row key "${key}" has no kind`);
    const kind = key.slice(0, separator);
    const id = key.slice(separator + 1);
    const verdict = classifyFramer(kind, id);
    const cells = parseCells(key, published.matrix.rows[key]);
    return {
      key,
      kind: kind as RowKind,
      id,
      ...verdict,
      ourRenderer: cells[SURFACE_INDEX('renderer')] === 'pass',
      ourPanel: cells[SURFACE_INDEX('panel')] === 'pass',
    };
  });

  const byKind: FramerKindScore[] = ROW_KINDS.map((kind) => {
    const kindRows = rows.filter((r) => r.kind === kind);
    const framer = emptyCounts();
    for (const r of kindRows) framer[r.verdict] += 1;
    const typed = (r: FramerRow) => r.verdict === 'native' || r.verdict === 'partial';
    return {
      kind,
      label: KIND_LABEL[kind],
      total: kindRows.length,
      framer,
      framerTyped: framer.native + framer.partial,
      ourRenderer: kindRows.filter((r) => r.ourRenderer).length,
      ourPanel: kindRows.filter((r) => r.ourPanel).length,
      framerTypedOursFails: kindRows.filter((r) => typed(r) && !r.ourRenderer).length,
      oursPassesFramerUntyped: kindRows.filter((r) => !typed(r) && r.ourRenderer).length,
      framerTypedPanelFails: kindRows.filter((r) => typed(r) && !r.ourPanel).length,
    };
  });

  const totalsFramer = emptyCounts();
  for (const k of byKind) for (const v of FRAMER_VERDICTS) totalsFramer[v] += k.framer[v];
  const counted = byKind.reduce((sum, k) => sum + k.total, 0);
  const verdictSum = FRAMER_VERDICTS.reduce((sum, v) => sum + totalsFramer[v], 0);
  if (counted !== keys.length || verdictSum !== keys.length) {
    throw new Error(`rows in ${keys.length}, rows counted by kind ${counted}, rows with a verdict ${verdictSum}: a row was dropped`);
  }

  return {
    comparedWith: { file, generatedAt: published.generatedAt, included: published.matrix.included },
    framerPlugin: FRAMER_PLUGIN,
    totals: {
      rows: rows.length,
      framer: totalsFramer,
      framerTyped: totalsFramer.native + totalsFramer.partial,
      ourRenderer: rows.filter((r) => r.ourRenderer).length,
      ourPanel: rows.filter((r) => r.ourPanel).length,
      documentedNotMeasured: rows.filter((r) => r.documentedNotMeasured).length,
    },
    byKind,
    rows,
  };
}

const escapeCell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const table = (head: string[], body: string[][]) =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...body.map((r) => `| ${r.map(escapeCell).join(' | ')} |`)].join('\n');

function rowDetail(r: FramerRow): string {
  const parts = [r.restriction ? `${r.restriction}.` : '', `${r.reason}.`];
  if (r.documentedNotMeasured) parts.push(`Documented, not measured: ${r.docUrl ?? r.source}.`);
  return parts.filter(Boolean).join(' ');
}

export function renderFramerReport(score: FramerScore): string {
  const { totals, byKind, framerPlugin, comparedWith } = score;
  const lines: string[] = [];
  const push = (...text: string[]) => lines.push(...text, '');

  push(
    '---',
    'type: documentation',
    'title: "Primitive score: Framer, native"',
    'summary: "Generated by pnpm score:framer. What Framer\'s plugin API can store natively for each of the coverage matrix entries, read from its typings, next to our own published renderer and panel columns."',
    'tags: [framer-clone, primitives, framer, comparison]',
    'projects: [framer-clone]',
    '---',
    '',
    '# Primitive score: Framer, native',
  );
  push(
    `Generated by \`pnpm score:framer\` from \`${comparedWith.file}\` (the primitive score of ${comparedWith.generatedAt}). Do not edit by hand: the verdicts come from \`test/score/lib/framer/mapping.ts\`, and \`framer.json\` beside this file holds every row.`,
  );
  push(
    `**What this measures:** what Framer's plugin API can store natively, read from its official typings, npm package \`${framerPlugin.name}\` ${framerPlugin.version} (\`dist/index.d.ts\`, sha256 \`${framerPlugin.typingsSha256}\`), for the same ${totals.rows} entries as our coverage matrix. The tests prove that every typings symbol a row cites is declared there and that every enumeration the mapping quotes equals the typings literally.`,
    `**What it does not measure:** this is not a render test of Framer's published pages. That is a later step that rebuilds the corpus fixtures in Framer. Nor is it a test of Framer's editor: where the editor has a feature the plugin API does not expose, the row says \`unknown\` or \`code-only\`, so this column can understate the editor.`,
  );
  push(
    '**One measured fact (2026-11-01, framer.app):** on a published Framer page a component hover state is applied by script (a `hover` class and an inline style). There is no CSS `:hover` rule for it, and with scripts blocked hover did nothing.',
  );

  push('## Verdicts');
  push(
    table(
      ['Verdict', 'Meaning'],
      [
        ['native', 'A typed node kind, trait attribute or enumeration in the typings expresses the entry directly.'],
        ['partial', 'A typed path exists with a named restriction (a smaller enumeration, px only, one colour for four sides, a component variant rather than a selector).'],
        ['code-only', `No typed node, trait or enumeration expresses it, and no fetched Framer page documents an editor feature for it. Reachable through Framer's Embed, code components (\`createCodeFile\`) or site custom code (\`setCustomCode\`).`],
        ['unknown', 'The typings do not settle it: a near miss exists (a component property control, a plain string type, a site-level setting) or Framer documents an editor feature the plugin API does not expose.'],
      ],
    ),
  );
  push(
    `Rows marked documented-not-measured (${totals.documentedNotMeasured}) rest on Framer's documentation of an editor feature (interactions, variants, overlays, events, the Appear effect, form inputs), each with the page it cites, or, for "Click start", on our own test of Framer's editor (no public page was found). None of them was measured.`,
  );

  push('## Totals');
  push(
    table(
      ['', 'Rows'],
      [
        ['Framer: native', `${totals.framer.native} of ${totals.rows}`],
        ['Framer: partial', `${totals.framer.partial} of ${totals.rows}`],
        ['Framer: code-only', `${totals.framer['code-only']} of ${totals.rows}`],
        ['Framer: unknown', `${totals.framer.unknown} of ${totals.rows}`],
        ['Framer: typed (native or partial)', `${totals.framerTyped} of ${totals.rows}`],
        ['Ours: published renderer emits it', `${totals.ourRenderer} of ${totals.rows}`],
        ['Ours: panel can edit it', `${totals.ourPanel} of ${totals.rows}`],
      ],
    ),
  );

  push('## By kind');
  push(
    table(
      ['Kind', 'Native', 'Partial', 'Code-only', 'Unknown', 'Ours: published renderer', 'Ours: panel', 'Framer typed, our renderer fails', 'Our renderer passes, Framer untyped', 'Framer typed, our panel fails'],
      byKind.map((k) => [
        k.label,
        String(k.framer.native),
        String(k.framer.partial),
        String(k.framer['code-only']),
        String(k.framer.unknown),
        `${k.ourRenderer} of ${k.total}`,
        `${k.ourPanel} of ${k.total}`,
        String(k.framerTypedOursFails),
        String(k.oursPassesFramerUntyped),
        String(k.framerTypedPanelFails),
      ]),
    ),
  );
  push(
    'The SVG partial rows all rest on one opaque `svg` string per SVG node, so they are not separate capabilities: Framer stores the markup, and nothing inside it is editable or styleable per element.',
  );
  push(
    'The two columns are not the same test. Ours is measured: the published renderer emits the entry. Framer\'s is read from typings: the plugin API can store it. "Framer typed, our renderer fails" names rows where Framer has a typed path and we do not emit the entry; the rows are listed next. "Framer typed, our panel fails" names rows Framer\'s plugin API can store but our properties panel cannot edit; our format and renderer may still hold them.',
  );

  const framerAhead = score.rows.filter((r) => (r.verdict === 'native' || r.verdict === 'partial') && !r.ourRenderer);
  push('## Rows Framer types and our published renderer fails');
  push(
    framerAhead.length === 0
      ? 'None.'
      : table(
          ['Row', 'Framer', 'Why'],
          framerAhead.map((r) => [`\`${r.key}\``, r.verdict, rowDetail(r)]),
        ),
  );

  push('## Sources');
  push(
    [
      `- Typings: \`${framerPlugin.name}@${framerPlugin.version}\`, a pinned devDependency, read at run time by the tests.`,
      `- Nodes: ${FRAMER_DOCS.nodes}`,
      `- Traits compatibility matrix: ${FRAMER_DOCS.traits}`,
      `- Interactions and effects: ${FRAMER_DOCS.animations}`,
      `- Triggers, overlays and Set Component Variant: ${FRAMER_DOCS.triggers}`,
      `- Events from a nested component: ${FRAMER_DOCS.events}`,
      `- Appear effect: ${FRAMER_DOCS.appear}`,
      `- Form inputs: ${FRAMER_DOCS.forms}`,
      '- Our test of Framer\'s editor and a published framer.app page, 2026-11-01: [the complete primitives plan](../plans/2026-11-01-complete-primitives.md), "What Framer does".',
    ].join('\n'),
  );

  push('## Every row');
  for (const k of byKind) {
    push(`### ${k.label}`);
    push(
      table(
        ['Row', 'Framer', 'Symbols', 'Why', 'Ours: renderer', 'Ours: panel'],
        score.rows
          .filter((r) => r.kind === k.kind)
          .map((r) => [
            `\`${r.id}\``,
            r.verdict,
            r.symbols.map((s) => `\`${s}\``).join(', '),
            rowDetail(r),
            r.ourRenderer ? 'pass' : 'fail',
            r.ourPanel ? 'pass' : 'fail',
          ]),
      ),
    );
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
