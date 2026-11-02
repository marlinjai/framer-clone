// The ratchet floor, docs/primitives-score/baseline.json: what a run may not lose. It is
// kept per row, not as column totals, for two reasons. A total is one line every pull
// request rewrites, so a merge took one side's number whole and a deliberate lowering in
// the other was lost (#271 refused the ::picker() row, and #275 wrote its own totals back
// over it). And a total cannot say which row went, so a refused row came back unseen.
// Per row, a merge conflicts on the row two branches both changed and nowhere else, and a
// row lowered on purpose holds its gap and its reason, which no run writes over.
//
// Pure: no browser, no data packages. The run (run.ts) and the cheap check in CI
// (checkFloor.ts) use the same comparison.

import type { Score } from '../report';
import { GAPS, SURFACES, type GapId, type Surface } from './types';

/** A cell with no floor yet: whatever the run says is fine. */
export const NO_FLOOR = '-';
/** A cell that must stay a pass. */
export const PASS = 'pass';

/** `pass`, `-`, or the gap a cell was lowered to on purpose. */
export type FloorToken = typeof PASS | typeof NO_FLOOR | GapId;

export interface Floor {
  _doc: string;
  /**
   * One line per matrix row: five tokens in the order format, renderer, canvas, panel, ai.
   * `pass` must stay a pass. A gap id is a cell lowered on purpose: it must stay exactly
   * that gap, and the row's reason is in `lowered`. `-` holds nothing yet.
   */
  matrix: Record<string, string>;
  /** Why each row holding a gap id was lowered. Every such row has one, and only those. */
  lowered: Record<string, string>;
  corpusFixtures: string[];
  corpusChecks: number;
  /** The round trip cases that pass, by id. */
  roundTrip: string[];
  import: {
    /** Fixed at 0: a run that claims an import differs in nothing no line names. */
    honestyFailures: number;
    /** Fixed at 0. */
    conservationFailures: number;
    parityPassing: string[];
    coverage: Record<string, number>;
    forged: number;
    mutationNamed: number;
  };
}

export const FLOOR_DOC =
  'The ratchet floor, not a cache: pnpm score:primitives fails when the run loses anything here. ' +
  'matrix holds one line per row, five cells in the order format renderer canvas panel ai: "pass" must stay a pass, "-" holds nothing yet, ' +
  'and a gap id is a cell lowered on purpose, which must stay that gap and needs its reason in lowered. ' +
  'pnpm score:primitives --update-baseline only raises: it turns "-" into "pass" and adds passing fixtures and cases, and it writes nothing when the run dropped. ' +
  'Lowering is a hand edit in the same pull request as its cause: the row gets the gap id and lowered gets the reason. ' +
  'pnpm check:score-floor checks this file against latest.json row by row.';

const SURFACE_LABEL: Record<Surface, string> = {
  format: 'format',
  renderer: 'renderer',
  canvas: 'canvas',
  panel: 'panel',
  ai: 'ai',
};

const isGap = (token: string): token is GapId => Object.prototype.hasOwnProperty.call(GAPS, token);

/** The five tokens of a floor line, or why the line cannot be one. */
export function floorCells(line: unknown): FloorToken[] | string {
  if (typeof line !== 'string') return `is ${JSON.stringify(line)}, not a line of five cells`;
  const tokens = line.split(' ');
  if (tokens.length !== SURFACES.length) return `has ${tokens.length} cells, not ${SURFACES.length}`;
  const unknown = tokens.find((token) => token !== PASS && token !== NO_FLOOR && !isGap(token));
  if (unknown !== undefined) return `holds ${JSON.stringify(unknown)}, which is not "pass", "-" or a gap id`;
  return tokens as FloorToken[];
}

/**
 * What makes a floor file unusable on its own: a wrong shape, an old column total, a
 * lowered cell with no reason, a reason for a row that lowers nothing. Empty when sound.
 */
export function floorProblems(floor: unknown): string[] {
  if (typeof floor !== 'object' || floor === null) return ['baseline.json is not an object'];
  const f = floor as Partial<Floor>;
  const problems: string[] = [];
  if (typeof f.matrix !== 'object' || f.matrix === null) return ['baseline.json has no matrix'];
  const values = Object.values(f.matrix);
  if (values.length > 0 && values.every((value) => typeof value === 'number')) {
    return ['baseline.json holds column totals, the old shape: take the file from main and run pnpm score:primitives --update-baseline'];
  }
  const lowered = f.lowered ?? {};
  if (typeof lowered !== 'object' || lowered === null) problems.push('baseline.json: lowered is not an object');
  for (const [key, line] of Object.entries(f.matrix)) {
    const cells = floorCells(line);
    if (typeof cells === 'string') {
      problems.push(`matrix ${key} ${cells}`);
      continue;
    }
    const gaps = cells.filter(isGap);
    const reason = (lowered as Record<string, unknown>)[key];
    if (gaps.length > 0 && (typeof reason !== 'string' || reason.trim() === '')) {
      problems.push(`matrix ${key} is lowered to ${[...new Set(gaps)].join(', ')} with no reason in lowered`);
    }
  }
  for (const key of Object.keys(lowered)) {
    const cells = floorCells(f.matrix[key]);
    if (typeof cells === 'string' || !cells.some(isGap)) problems.push(`lowered ${key} gives a reason, but that row lowers nothing`);
  }
  if (!Array.isArray(f.corpusFixtures)) problems.push('baseline.json: corpusFixtures is not a list');
  if (typeof f.corpusChecks !== 'number') problems.push('baseline.json: corpusChecks is not a number');
  if (!Array.isArray(f.roundTrip)) problems.push('baseline.json: roundTrip is not a list of case ids');
  if (typeof f.import !== 'object' || f.import === null) problems.push('baseline.json: import is missing');
  return problems;
}

/** The part of a score the floor reads. latest.json holds every field of it. */
export type Scored = Pick<Score, 'matrix' | 'corpus' | 'busbasis' | 'roundTrip' | 'import'>;

const passingFixtures = (score: Scored) => [...score.corpus.fixtures, ...score.busbasis.pages].filter((f) => f.pass).map((f) => f.fixture);
const corpusCheckPasses = (score: Scored) => Object.values(score.corpus.checks).reduce((sum, c) => sum + c.pass, 0);
const passingCases = (score: Scored) => score.roundTrip.cases.filter((c) => c.pass).map((c) => c.id);

/** The drops against the floor; empty when nothing dropped. Expects a floor without problems. */
export function floorDrops(score: Scored, floor: Floor): string[] {
  const drops: string[] = [];
  for (const [key, line] of Object.entries(floor.matrix)) {
    const cells = floorCells(line) as FloorToken[];
    const measured = score.matrix.rows[key];
    if (measured === undefined) {
      if (cells.some((cell) => cell !== NO_FLOOR)) drops.push(`matrix ${key}: the run has no such row, so its floor cannot hold`);
      continue;
    }
    const now = measured.split(' ');
    SURFACES.forEach((surface, index) => {
      const want = cells[index];
      const got = now[index];
      if (want === PASS && got !== PASS) drops.push(`matrix ${key}, ${SURFACE_LABEL[surface]}: was pass, now ${got}`);
      else if (want !== PASS && want !== NO_FLOOR && got !== want) {
        drops.push(
          got === PASS
            ? `matrix ${key}, ${SURFACE_LABEL[surface]}: lowered to ${want} on purpose, and it passes now. If that is meant, set the cell to pass and drop the reason in lowered`
            : `matrix ${key}, ${SURFACE_LABEL[surface]}: lowered to ${want} on purpose, now ${got}. Restate the gap and its reason`,
        );
      }
    });
  }
  const fixtures = passingFixtures(score);
  for (const fixture of floor.corpusFixtures) if (!fixtures.includes(fixture)) drops.push(`corpus: ${fixture} no longer passes`);
  const checks = corpusCheckPasses(score);
  if (checks < floor.corpusChecks) drops.push(`corpus checks: ${floor.corpusChecks} became ${checks}`);
  const cases = new Set(passingCases(score));
  for (const id of floor.roundTrip) if (!cases.has(id)) drops.push(`round trip: ${id} no longer passes`);
  drops.push(...importDrops(score.import, floor.import));
  return drops;
}

/** The import's floor. Honesty and conservation are not ratcheted: any failure is a drop, whatever the floor says. */
function importDrops(now: Scored['import'], floor: Floor['import']): string[] {
  const drops: string[] = [];
  if (now.honestyFailures > 0) drops.push(`import honesty: ${now.honestyFailures} runs claim an import and differ in something no line names`);
  if (now.conservationFailures > 0) drops.push(`import conservation: ${now.conservationFailures} runs leave a construct off its line`);
  if (!now.foreignThemeDistinct) drops.push('import: the foreign theme shares a token value with the repo theme');
  if (!now.honestySees) drops.push('import: Honesty did not see tokens removed from a real import, so it is blind');
  if (now.mutation.conserved < now.mutation.total) drops.push(`import mutation run: ${now.mutation.total - now.mutation.conserved} inserted constructs are not conserved`);
  if (now.forged.pass < now.forged.total) drops.push(`import forged bundles: ${now.forged.total - now.forged.pass} read as more than they are`);
  for (const key of floor.parityPassing) if (!now.parityPassing.includes(key)) drops.push(`import parity: ${key} no longer passes`);
  for (const [key, value] of Object.entries(floor.coverage)) {
    if ((now.coverage[key] ?? 0) < value) drops.push(`import coverage, ${key}: ${value} became ${now.coverage[key] ?? 0}`);
  }
  if (now.forged.pass < floor.forged) drops.push(`import forged bundles: ${floor.forged} became ${now.forged.pass}`);
  if (now.mutation.named < floor.mutationNamed) drops.push(`import mutation run: ${floor.mutationNamed} named became ${now.mutation.named}`);
  return drops;
}

const sortedRecord = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])].sort();

/**
 * The floor raised by a run that dropped nothing: a `-` the run passes becomes `pass`, a new
 * row gets its passes, passing fixtures and cases are added, and a number only goes up.
 * A `pass` and a lowered cell are never touched, so a run cannot lower anything, and a run
 * on a branch that predates a refusal cannot bring the refused row back.
 */
export function raiseFloor(floor: Floor | undefined, score: Scored): Floor {
  const problems = floor ? floorProblems(floor) : [];
  if (problems.length > 0) throw new Error(`the floor cannot be raised until it is sound:\n  ${problems.join('\n  ')}`);
  const matrix: Record<string, string> = { ...(floor?.matrix ?? {}) };
  const blank = SURFACES.map(() => NO_FLOOR).join(' ');
  for (const [key, measured] of Object.entries(score.matrix.rows)) {
    const now = measured.split(' ');
    const cells = floorCells(matrix[key] ?? blank) as FloorToken[];
    matrix[key] = cells.map((cell, index) => (cell === NO_FLOOR && now[index] === PASS ? PASS : cell)).join(' ');
  }
  const coverage = { ...(floor?.import.coverage ?? {}) };
  for (const [key, value] of Object.entries(score.import.coverage)) coverage[key] = Math.max(coverage[key] ?? 0, value);
  return {
    _doc: FLOOR_DOC,
    matrix: sortedRecord(matrix),
    lowered: sortedRecord(floor?.lowered ?? {}),
    corpusFixtures: union(floor?.corpusFixtures ?? [], passingFixtures(score)),
    corpusChecks: Math.max(floor?.corpusChecks ?? 0, corpusCheckPasses(score)),
    roundTrip: union(floor?.roundTrip ?? [], passingCases(score)),
    import: {
      honestyFailures: 0,
      conservationFailures: 0,
      parityPassing: union(floor?.import.parityPassing ?? [], score.import.parityPassing),
      coverage: sortedRecord(coverage),
      forged: Math.max(floor?.import.forged ?? 0, score.import.forged.pass),
      mutationNamed: Math.max(floor?.import.mutationNamed ?? 0, score.import.mutation.named),
    },
  };
}

/** The pass count each column's floor holds, for the run's summary. */
export function floorTotals(floor: Floor): Record<Surface, number> {
  const totals = Object.fromEntries(SURFACES.map((s) => [s, 0])) as Record<Surface, number>;
  for (const line of Object.values(floor.matrix)) {
    const cells = floorCells(line);
    if (typeof cells === 'string') continue;
    SURFACES.forEach((surface, index) => {
      if (cells[index] === PASS) totals[surface] += 1;
    });
  }
  return totals;
}

/** One line per entry, so a merge conflicts per row and a diff reads per row. */
export function serializeFloor(floor: Floor): string {
  return `${JSON.stringify(floor, null, 2)}\n`;
}
