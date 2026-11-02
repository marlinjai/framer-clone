import { describe, expect, it } from 'vitest';
import { FLOOR_DOC, floorDrops, floorProblems, floorTotals, raiseFloor, type Floor, type Scored } from './floor';

const ROW = 'css-property:color';
const PICKER = 'css-selector:::picker()';
const REFUSED = 'top-layer-refused top-layer-refused top-layer-refused top-layer-refused top-layer-refused';

/** A score with only what the floor reads, every import check clean. */
function scored(rows: Record<string, string>, extra: { fixtures?: Array<[string, boolean]>; cases?: Array<[string, boolean]>; checks?: number } = {}): Scored {
  const check = { pass: extra.checks ?? 10, total: 10 };
  const fixture = ([fixture, pass]: [string, boolean]) => ({ fixture, pass, group: 'edge' as const, source: '', checks: { screenshot: check, 'computed-styles': check, 'accessibility-tree': check, interaction: check }, failures: [], notMeasured: [] });
  return {
    matrix: { surfaces: {} as Scored['matrix']['surfaces'], acceptedNotTaught: 0, byKind: {} as Scored['matrix']['byKind'], included: 0, excluded: [], rows },
    corpus: { passed: 0, total: 0, checks: { screenshot: check, 'computed-styles': { pass: 0, total: 0 }, 'accessibility-tree': { pass: 0, total: 0 }, interaction: { pass: 0, total: 0 } }, fixtures: (extra.fixtures ?? []).map(fixture) },
    busbasis: { passed: 0, total: 0, pages: [], gaps: [], uncaptured: [] },
    roundTrip: { nodesToJsxToNodes: { pass: 0, total: 0 }, jsxToNodesToRender: { pass: 0, total: 0 }, cases: (extra.cases ?? []).map(([id, pass]) => ({ id, pass, direction: 'nodes-jsx-nodes' as const })) },
    import: {
      honestyFailures: 0,
      conservationFailures: 0,
      parityPassing: [],
      coverage: {},
      forged: { pass: 1, total: 1 },
      mutation: { named: 1, conserved: 1, total: 1 },
      foreignThemeDistinct: true,
      honestySees: true,
      runs: [],
      excuses: [],
    },
  };
}

function floor(matrix: Record<string, string>, lowered: Record<string, string> = {}, rest: Partial<Floor> = {}): Floor {
  return {
    _doc: FLOOR_DOC,
    matrix,
    lowered,
    corpusFixtures: [],
    corpusChecks: 0,
    roundTrip: [],
    import: { honestyFailures: 0, conservationFailures: 0, parityPassing: [], coverage: {}, forged: 0, mutationNamed: 0 },
    ...rest,
  };
}

describe('the floor file', () => {
  it('accepts a sound floor', () => {
    expect(floorProblems(floor({ [ROW]: 'pass pass - pass -', [PICKER]: REFUSED }, { [PICKER]: 'the top layer covers the consent banner' }))).toEqual([]);
  });

  it('refuses a lowered row with no reason, or an empty one', () => {
    expect(floorProblems(floor({ [PICKER]: REFUSED }))).toEqual([`matrix ${PICKER} is lowered to top-layer-refused with no reason in lowered`]);
    expect(floorProblems(floor({ [PICKER]: REFUSED }, { [PICKER]: '  ' }))).toHaveLength(1);
  });

  it('refuses a reason for a row that lowers nothing, or that is not there', () => {
    expect(floorProblems(floor({ [ROW]: 'pass pass pass pass pass' }, { [ROW]: 'stale' }))).toEqual([`lowered ${ROW} gives a reason, but that row lowers nothing`]);
    expect(floorProblems(floor({}, { [PICKER]: 'gone' }))).toHaveLength(1);
  });

  it('refuses a line that is not five known cells', () => {
    expect(floorProblems(floor({ [ROW]: 'pass pass pass pass' }))[0]).toMatch(/has 4 cells/);
    expect(floorProblems(floor({ [ROW]: 'pass pass pass pass fail' }))[0]).toMatch(/"fail", which is not/);
    expect(floorProblems(floor({ [ROW]: 5 as unknown as string, [PICKER]: '- - - - -' }))[0]).toMatch(/not a line of five cells/);
  });

  it('names the old column totals, so a stale branch knows what to do', () => {
    expect(floorProblems({ matrix: { format: 1795, renderer: 1759 } })[0]).toMatch(/column totals, the old shape/);
  });
});

describe('a run against the floor', () => {
  it('passes a run that keeps every pass and every refusal', () => {
    const f = floor({ [ROW]: 'pass pass - pass -', [PICKER]: REFUSED }, { [PICKER]: 'reason' });
    expect(floorDrops(scored({ [ROW]: 'pass pass pass pass ai-style-allowlist', [PICKER]: REFUSED }), f)).toEqual([]);
  });

  it('names the cell that lost its pass, whatever it became', () => {
    const f = floor({ [ROW]: 'pass pass pass pass pass' });
    expect(floorDrops(scored({ [ROW]: 'pass pass pass not-tested ai-style-allowlist' }), f)).toEqual([
      `matrix ${ROW}, panel: was pass, now not-tested`,
      `matrix ${ROW}, ai: was pass, now ai-style-allowlist`,
    ]);
  });

  it('fails a refused row that passes again, so un-refusing is a decision, not an accident', () => {
    const f = floor({ [PICKER]: REFUSED }, { [PICKER]: 'reason' });
    const drops = floorDrops(scored({ [PICKER]: 'pass top-layer-refused top-layer-refused top-layer-refused top-layer-refused' }), f);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatch(/format: lowered to top-layer-refused on purpose, and it passes now/);
  });

  it('fails a refused row that fails for another reason, so the reason cannot go stale', () => {
    const f = floor({ [PICKER]: REFUSED }, { [PICKER]: 'reason' });
    expect(floorDrops(scored({ [PICKER]: REFUSED.replace(/^top-layer-refused/, 'unclassified') }), f)[0]).toMatch(/now unclassified\. Restate/);
  });

  it('fails a floor row the run does not have, unless the row holds nothing', () => {
    expect(floorDrops(scored({}), floor({ [ROW]: 'pass - - - -' }))).toEqual([`matrix ${ROW}: the run has no such row, so its floor cannot hold`]);
    expect(floorDrops(scored({}), floor({ [ROW]: '- - - - -' }))).toEqual([]);
  });

  it('holds fixtures, checks, round trip cases and the import', () => {
    const f = floor({}, {}, { corpusFixtures: ['a'], corpusChecks: 10, roundTrip: ['c1'], import: { honestyFailures: 0, conservationFailures: 0, parityPassing: ['x/repo'], coverage: { 'x/repo': 0.5 }, forged: 1, mutationNamed: 1 } });
    const run = scored({}, { fixtures: [['a', false]], cases: [['c1', false]], checks: 9 });
    run.import.coverage = { 'x/repo': 0.4 };
    run.import.honestyFailures = 1;
    expect(floorDrops(run, f)).toEqual([
      'corpus: a no longer passes',
      'corpus checks: 10 became 9',
      'round trip: c1 no longer passes',
      'import honesty: 1 runs claim an import and differ in something no line names',
      'import parity: x/repo no longer passes',
      'import coverage, x/repo: 0.5 became 0.4',
    ]);
  });
});

describe('raising the floor', () => {
  it('turns a passing "-" into pass and adds new rows, and touches nothing else', () => {
    const f = floor({ [ROW]: '- pass - - -', [PICKER]: REFUSED }, { [PICKER]: 'reason' });
    const raised = raiseFloor(f, scored({ [ROW]: 'pass pass ai-style-allowlist - pass', [PICKER]: REFUSED, 'css-property:top': 'pass fail fail fail fail' }));
    expect(raised.matrix).toEqual({ 'css-property:top': 'pass - - - -', [ROW]: 'pass pass - - pass', [PICKER]: REFUSED });
    expect(raised.lowered).toEqual({ [PICKER]: 'reason' });
  });

  it('never brings back a refused row, even from a run on a branch that predates the refusal', () => {
    const f = floor({ [PICKER]: REFUSED }, { [PICKER]: 'reason' });
    const raised = raiseFloor(f, scored({ [PICKER]: 'pass pass pass pass pass' }));
    expect(raised.matrix[PICKER]).toBe(REFUSED);
    expect(floorTotals(raised)).toEqual({ format: 0, renderer: 0, canvas: 0, panel: 0, ai: 0 });
  });

  it('never lowers a number or drops a listed item', () => {
    const f = floor({}, {}, { corpusFixtures: ['a'], corpusChecks: 10, roundTrip: ['c1'], import: { honestyFailures: 0, conservationFailures: 0, parityPassing: ['x/repo'], coverage: { 'x/repo': 0.5 }, forged: 3, mutationNamed: 3 } });
    const raised = raiseFloor(f, scored({}, { fixtures: [['b', true]], cases: [['c2', true]], checks: 4 }));
    expect(raised.corpusFixtures).toEqual(['a', 'b']);
    expect(raised.corpusChecks).toBe(10);
    expect(raised.roundTrip).toEqual(['c1', 'c2']);
    expect(raised.import).toMatchObject({ parityPassing: ['x/repo'], coverage: { 'x/repo': 0.5 }, forged: 3, mutationNamed: 3 });
  });

  it('refuses to raise a floor that is not sound', () => {
    expect(() => raiseFloor(floor({ [PICKER]: REFUSED }), scored({}))).toThrow(/no reason in lowered/);
  });

  it('writes the first floor from a run when there is none', () => {
    expect(raiseFloor(undefined, scored({ [ROW]: 'pass fail pass pass pass' })).matrix).toEqual({ [ROW]: 'pass - pass pass pass' });
  });
});
