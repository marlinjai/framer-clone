// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { BudgetExceeded, IMPORT_LIMITS, createImportBudget } from '../budget';
import { DETAILS } from '../report';
import { importAndPost, importSource, type ImportOutcome } from '../source';

const limitOf = (run: () => void) => {
  try {
    run();
  } catch (error) {
    return error instanceof BudgetExceeded ? error.limit : 'other';
  }
  return undefined;
};

describe('the conversion budget', () => {
  it('holds the contract figures', async () => {
    expect(IMPORT_LIMITS).toMatchObject({
      files: 64, bytesPerFile: 524_288, bytesInAll: 2_097_152, astDepth: 256, evalDepth: 32,
      outputNodes: 5_000, outputDepth: 256, conversionSteps: 100_000, evaluatedBytes: 4_194_304, unrolledItems: 5_000, inliningDepth: 16, deadlineMs: 20_000,
    });
  });

  it('counts across charges, and lets the last one that fits through', async () => {
    const budget = createImportBudget();
    budget.chargeNodes(IMPORT_LIMITS.outputNodes);
    expect(limitOf(() => budget.chargeNodes(1))).toBe('nodes');
  });

  it('keeps each measure apart', async () => {
    const budget = createImportBudget();
    budget.chargeEvaluated(IMPORT_LIMITS.evaluatedBytes);
    budget.chargeUnrolled(IMPORT_LIMITS.unrolledItems);
    budget.chargeNodes(IMPORT_LIMITS.outputNodes);
    expect(limitOf(() => budget.chargeEvaluated(1))).toBe('evaluated');
    expect(limitOf(() => budget.chargeUnrolled(1))).toBe('unrolled');
  });

  it('sees a component on its own stack, and only there', async () => {
    const budget = createImportBudget();
    budget.enterComponent('A');
    budget.enterComponent('B');
    expect(limitOf(() => budget.enterComponent('A'))).toBe('recursive-component');
    budget.leaveComponent();
    budget.enterComponent('B');
  });

  it('stops at 16 levels of different components', async () => {
    const budget = createImportBudget();
    for (let i = 0; i < IMPORT_LIMITS.inliningDepth; i += 1) budget.enterComponent(`C${i}`);
    expect(limitOf(() => budget.enterComponent('Next'))).toBe('inlining-depth');
  });
});

// The hostile shapes of the review, here because this suite runs on every push and needs no
// browser. Each ended a worker's deadline or a process's memory before the budget paid for it.
// Well under what these took unpaid (20 seconds to minutes), and wide enough for a loaded machine.
const LIMIT_MS = 15_000;
vi.setConfig({ testTimeout: 30_000 });

async function timed(text: string) {
  const started = performance.now();
  const outcome = await importSource([{ name: 'p.tsx', text }]);
  const milliseconds = performance.now() - started;
  expect(milliseconds).toBeLessThan(LIMIT_MS);
  return outcome;
}

const detailsOf = (outcome: ImportOutcome) => outcome.report.lines.map((line) => line.detail);

async function expectStopped(text: string, detail: string) {
  const outcome = await timed(text);
  expect(outcome.root).toBeUndefined();
  expect(outcome.report.verdict).toBe('not-imported');
  expect(detailsOf(outcome)).toContain(detail);
}

describe('a value is paid for each time it is written', () => {
  const NUMBERS = `[${'0,'.repeat(60_000)}0]`;
  const chain = (links: number) => {
    const constants = ['const a0=1;'];
    for (let i = 1; i < links; i += 1) constants.push(`const a${i}=a${i - 1};`);
    return `${constants.join('')}\n<div ${Array.from({ length: links }, (_, i) => `title={a${i}}`).join(' ')} />`;
  };

  it('a large string in thousands of attributes', async () => {
    const text = `const s0="${'x'.repeat(200_000)}";\nconst s1=\`\${s0}\${s0}\`;\nconst s2=\`\${s1}\${s1}\`;\nconst s3=\`\${s2}\${s2}\`;\n<div>${'<i title={s3} />'.repeat(4_900)}</div>`;
    expect(text.length).toBeLessThan(IMPORT_LIMITS.bytesPerFile);
    await expectStopped(text, DETAILS.overEvaluated);
  });

  it('a string written out plainly', async () => {
    await expectStopped(`const s="${'x'.repeat(250_000)}";\n<div>${'<i title={s} />'.repeat(4_900)}</div>`, DETAILS.overEvaluated);
  });

  it('text, which always paid', async () => {
    await expectStopped(`const s="${'x'.repeat(250_000)}";\n<div>${'<i>{s}</i>'.repeat(4_900)}</div>`, DETAILS.overEvaluated);
  });

  it('an array in an attribute, walked each time', async () => {
    await expectStopped(`const a=${NUMBERS};\n<div>${'<i title={a} />'.repeat(4_900)}</div>`, DETAILS.overEvaluated);
  });

  it('a style object', async () => {
    const declarations = Array.from({ length: 2_000 }, (_, i) => `a${i}:"${'x'.repeat(100)}"`).join(',');
    await expectStopped(`const s={${declarations}};\n<div>${'<i style={s} />'.repeat(4_900)}</div>`, DETAILS.overEvaluated);
  });

  it('keeps the output of what fits to the budget, as text a save can write', async () => {
    const { root } = await timed(`const s="${'x'.repeat(100_000)}";\n<div>${'<i title={s} />'.repeat(30)}</div>`);
    expect(JSON.stringify(root).length).toBeLessThan(IMPORT_LIMITS.evaluatedBytes);
  });

  it('a large declaration read by thousands of attributes is walked once', async () => {
    await timed(`const a=[${'0,'.repeat(200_000)}0];\n<div ${'title={a[0]} '.repeat(6_000)} />`);
  });

  it('a chain of constants, whose read sets grow', async () => {
    await expectStopped(chain(4_000), DETAILS.overEvaluated);
    await expectStopped(chain(14_000), DETAILS.overEvaluated);
  });

  it('a short chain costs next to nothing', async () => {
    expect((await timed(chain(30))).report.verdict).toBe('imported');
  });
});

describe('work that makes no node', () => {
  const fragmentTree = (levels: number, width: number) => {
    const lines = Array.from({ length: levels }, (_, i) => `function C${i}() { return <>${`<C${i + 1} />`.repeat(width)}</>; }`);
    return [...lines, `function C${levels}() { return <></>; }`, '<C0 />'].join('\n');
  };

  it.each([[15, 4], [15, 8], [15, 10]])('a tree of fragments, %i levels at width %i', async (levels, width) => {
    await expectStopped(fragmentTree(levels, width), DETAILS.overSteps);
  });

  it('a long list of empty children, inlined thousands of times', async () => {
    const text = `function D() { return <>${'{}'.repeat(100_000)}</>; }\n<>${'<D />'.repeat(50_000)}</>`;
    expect(text.length).toBeLessThanOrEqual(IMPORT_LIMITS.bytesPerFile);
    await expectStopped(text, DETAILS.overSteps);
  });

  it('a list of null children, the same way', async () => {
    await expectStopped(`function D() { return <>${'{null}'.repeat(30_000)}</>; }\n<>${'<D />'.repeat(50_000)}</>`, DETAILS.overSteps);
  });

  it('a fragment tree that fits still reads', async () => {
    expect((await timed(`${fragmentTree(3, 2)}`)).report.lines.map((line) => line.detail)).toContain(DETAILS.nothingToPlace);
  });

  it('a long body, inlined over and over', async () => {
    const body = 'const a = 1;'.repeat(20_000);
    await expectStopped(`function B() { ${body} return <i />; }\n<div>${'<B />'.repeat(4_000)}</div>`, DETAILS.overSteps);
  });

  it('a refused element holding a lot, inlined over and over', async () => {
    await timed(`function B() { return <script>{[${'0,'.repeat(100_000)}0]}</script>; }\n<div>${'<B />'.repeat(4_000)}</div>`);
  });
});

describe('the parser exponential family', () => {
  const family: Array<[string, (levels: number) => string]> = [
    ['a default', (n) => `const x = ${'async(a='.repeat(n)}1${')'.repeat(n)};`],
    ['no default', (n) => `const x = ${'async('.repeat(n)}1${')'.repeat(n)};`],
    ['an array pattern', (n) => `const x = ${'async([a='.repeat(n)}1${'])'.repeat(n)};`],
    ['an object pattern', (n) => `const x = ${'async({a:'.repeat(n)}1${'})'.repeat(n)};`],
    ['type arguments', (n) => `const x = ${'async<T>(a='.repeat(n)}1${')'.repeat(n)};`],
    ['inside a tag', (n) => `<a b={${'async(a='.repeat(n)}1${')'.repeat(n)}} />`],
    ['with spaces', (n) => `const x = ${'async ( a = '.repeat(n)}1${' )'.repeat(n)};`],
    ['unclosed', (n) => `const x = ${'async(a='.repeat(n)}`],
  ];

  it.each(family)('%s', async (_name, make) => {
    for (const levels of [16, 20, 26, 200]) (await expectStopped(make(levels), DETAILS.tooDeep));
  });

  const levels = (open: string, closer: string, n: number) => `${open.repeat(n)}a${closer.repeat(n)}`;
  const blinded: Array<[string, (n: number) => string]> = [
    ['a quote in text', (n) => `<p>don't {${levels('async(a=', ')', n)}}</p>`],
    ['a double quote in text', (n) => `<p>say "hi {${levels('async(a=', ')', n)}}</p>`],
    ['a link in text', (n) => `<p>http://example.com {${levels('async(a=', ')', n)}}</p>`],
    ['a backtick on the line before', (n) => `<p>\`</p>;\nconst x = ${levels('async(a=', ')', n)};`],
    ['a comment opener on the line before', (n) => `<p>see /* here</p>;\nconst x = ${levels('async(a=', ')', n)};`],
    ['a quote in a regular expression', (n) => `const r = /'/; const x = ${levels('async(a=', ')', n)};`],
    ['a token between', (n) => `const x = ${levels('async ! ( ', ' )', n)};`],
    ['a fuzzed class body', (n) => `class K { ${levels('async > in ( ', ' )', n)}`],
    ['another fuzzed class body', (n) => `class K { ${levels('async ! keyof ( ', ' )', n)}`],
  ];

  it.each(blinded)('%s', async (_name, make) => {
    for (const n of [20, 22, 26]) (await expectStopped(make(n), DETAILS.tooDeep));
  });

  it('leaves real async code alone', async () => {
    const text = '<button title="x">Go</button>;\nconst load = async () => { await a(async (b) => { await c(async () => d(async (e) => e)); }); };\nconst more = [async () => 1, async () => 2, async () => 3, async () => 4, async () => 5, async () => 6, async () => 7, async () => 8, async () => 9, async () => 10];\n<p />';
    expect(detailsOf((await timed(text)))).not.toContain(DETAILS.tooDeep);
  });

  it('is linear itself, on the largest file', async () => {
    await timed(`const x = ${'async(1);'.repeat(50_000)}`);
  });
});

describe('patterns a line of spaces makes quadratic', () => {
  it.each<[string, string]>([
    ['trailing spaces in text', `<p>${' '.repeat(500_000)}x\n</p>`],
    ['trailing spaces on many lines', `<p>${`${' '.repeat(50_000)}x\n`.repeat(9)}</p>`],
    ['spaces after an opening url', `<div style={{ background: "url(${' '.repeat(500_000)}x" }} />`],
    ['spaces after a less than in a quoted style value', `<div style={{ content: '"<${' '.repeat(100_000)}x"' }} />`],
    ['spaces in a closed url', `<div style={{ background: "url(${' '.repeat(100_000)}x)" }} />`],
    ['many opening urls', `<div style={{ background: "${'url( '.repeat(90_000)}" }} />`],
    ['spaces after a less than in a style', `<div style={{ background: "<${' '.repeat(100_000)}" }} />`],
    ['spaces in a fill url', `<svg><rect fill="url(${' '.repeat(100_000)}x" /></svg>`],
    ['a source set of separators', `<img srcSet="${' ,'.repeat(100_000)}" />`],
  ])('%s', async (_name, text) => {
    expect(text.length).toBeLessThanOrEqual(IMPORT_LIMITS.bytesPerFile);
    await timed(text);
  });

  it('reads the text the same after the change', async () => {
    expect((await timed(`<p>one   \n  two  </p>`)).root?.props?.children).toBe('one two  ');
  });
});

describe('the report cap', () => {
  it('folds no line that names a node, and is said to', async () => {
    const { report } = await timed(`<div ${'a-b="1" '.repeat(40_000)} />`);
    expect(report.lines.length).toBeGreaterThan(IMPORT_LIMITS.reportLines);
    expect(report.lines.every((line) => line.nodeKey !== undefined)).toBe(true);
  });
});

describe('the one catch reaches delivery', () => {
  it('turns a result too big to clone into a report', async () => {
    const posted: ImportOutcome[] = [];
    await importAndPost([{ name: 'p.tsx', text: '<p>x</p>' }], {}, (outcome) => {
      posted.push(outcome);
      if (posted.length === 1) throw new DOMException('Data cannot be cloned, out of memory.', 'DataCloneError');
    });
    expect(posted[0].root?.type).toBe('p');
    expect(posted[1].root).toBeUndefined();
    expect(posted[1].report.verdict).toBe('not-imported');
    expect(detailsOf(posted[1])).toEqual([DETAILS.failed]);
  });

  it('posts once when nothing goes wrong', async () => {
    const posted: ImportOutcome[] = [];
    await importAndPost([{ name: 'p.tsx', text: '<p>x</p>' }], {}, (outcome) => posted.push(outcome));
    expect(posted).toHaveLength(1);
  });

  it('survives input that is not what the types say', async () => {
    expect((await importSource(null as never)).report.verdict).toBe('not-imported');
    expect((await importSource([{ name: 'p.tsx', text: null as never }])).report.verdict).toBe('not-imported');
  });
});
