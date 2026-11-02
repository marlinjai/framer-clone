// @vitest-environment node
// The hostile list of the contract, each shape from its probes. Every one of these
// returns a report: a file from a stranger is never allowed to throw.

import { describe, expect, it } from 'vitest';
import { IMPORT_LIMITS } from '../budget';
import { DETAILS } from '../report';
import { importSource, type SourceInput } from '../source';

const paste = (text: string, name = 'paste.tsx'): SourceInput[] => [{ name, text }];
const details = (input: SourceInput[]) => importSource(input).report.lines.map((line) => line.detail);

function expectRefused(input: SourceInput[], detail: string) {
  const outcome = importSource(input);
  expect(outcome.root).toBeUndefined();
  expect(outcome.report.verdict).toBe('not-imported');
  expect(outcome.report.lines.map((line) => line.detail)).toContain(detail);
}

const repeat = (text: string, count: number) => text.repeat(count);

describe('input limits, before anything is parsed', () => {
  it('refuses more than 64 files', () => {
    expectRefused(Array.from({ length: IMPORT_LIMITS.files + 1 }, (_, i) => ({ name: `f${i}.tsx`, text: '<p />' })), DETAILS.tooManyFiles);
  });

  it('takes exactly 64', () => {
    const files = Array.from({ length: IMPORT_LIMITS.files }, (_, i) => ({ name: `f${i}.tsx`, text: '<p />' }));
    expect(importSource(files).report.verdict).toBe('imported');
  });

  it('refuses a file over 512 kilobytes, counted in bytes rather than characters', () => {
    expectRefused(paste('x'.repeat(IMPORT_LIMITS.bytesPerFile + 1)), DETAILS.fileTooLarge);
    expectRefused(paste('ä'.repeat(IMPORT_LIMITS.bytesPerFile / 2 + 1)), DETAILS.fileTooLarge);
  });

  it('refuses more than 2 megabytes together, each file under its own limit', () => {
    const text = 'x'.repeat(IMPORT_LIMITS.bytesPerFile);
    expectRefused(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, text })), DETAILS.inputTooLarge);
  });

  it('says so when there is nothing at all', () => {
    expectRefused([], DETAILS.nothingToPlace);
    expectRefused(paste(''), DETAILS.nothingToPlace);
    expectRefused(paste('const a = 1;'), DETAILS.nothingToPlace);
  });
});

describe('files that overflow the parser or a walker', () => {
  // Each of these overflowed `ts.createSourceFile` or a recursive walker in hostile.mjs and hostile2.mjs.
  const shapes: Array<[string, string]> = [
    ['nested parentheses', `${repeat('(', 100_000)}1${repeat(')', 100_000)}`],
    ['nested elements', `${repeat('<div>', 50_000)}${repeat('</div>', 50_000)}`],
    ['an unterminated div run', repeat('<div>', 100_000)],
    ['not, at bracket depth 0', `const a = ${repeat('!', 100_000)}1;`],
    ['typeof, at bracket depth 0', `const a = ${repeat('typeof ', 60_000)}1;`],
    ['new, at bracket depth 0', `const a = ${repeat('new ', 100_000)}A;`],
    ['arrows, at bracket depth 0', `const a = ${repeat('a=>', 100_000)}1;`],
    ['ternaries, at bracket depth 0', `const a = ${repeat('a?b:', 100_000)}1;`],
    ['labels, at bracket depth 0', repeat('a:', 200_000)],
    ['a long sum that parses', `const a = ${repeat('a+', 100_000)}a;`],
    ['a long call chain that parses', `const a = a${repeat('()', 100_000)};`],
  ];

  it.each(shapes)('refuses %s', (_name, text) => {
    const outcome = importSource(paste(text));
    expect(outcome.root).toBeUndefined();
    expect(outcome.report.verdict).toBe('not-imported');
    expect(outcome.report.lines.length).toBeGreaterThan(0);
    expect(outcome.report.lines.length).toBeLessThanOrEqual(IMPORT_LIMITS.reportLines);
  });

  it('leaves the parser working after an overflow', () => {
    importSource(paste(`${repeat('(', 100_000)}1${repeat(')', 100_000)}`));
    expect(importSource(paste('<p>Fine</p>')).root?.type).toBe('p');
  });

  it('takes a real depth', () => {
    const depth = 40;
    const outcome = importSource(paste(`${repeat('<div>', depth)}x${repeat('</div>', depth)}`));
    expect(outcome.report.verdict).toBe('imported');
  });
});

describe('a file that does not parse', () => {
  it('converts nothing, and says where', () => {
    const outcome = importSource(paste('const a = 1;\nconst b = <div;\n'));
    expect(outcome.root).toBeUndefined();
    const line = outcome.report.lines.find((each) => each.detail === DETAILS.syntaxError);
    expect(line?.line).toBe(2);
  });
});

describe('files that expand', () => {
  /** `const a1=[...a0,...a0]`, the contract's doubling constant, read by the markup. */
  const doubling = (levels: number, make: (previous: string) => string) => {
    const lines = ['const a0 = ["xxxxxxxxxxxxxxxx"];'];
    for (let i = 1; i <= levels; i += 1) lines.push(`const a${i} = ${make(`a${i - 1}`)};`);
    return lines;
  };

  /** Read through a chain of steps, each within the evaluator's depth limit, so the depth limit is not what stops it. */
  const readAll = (lines: string[], levels: number) => {
    // Evaluating from the bottom up makes each level a table lookup, as a real file's order would.
    const reads = Array.from({ length: levels + 1 }, (_, i) => `<i title={a${i}[0]} />`).join('');
    return `${lines.join('\n')}\n<div>${reads}</div>`;
  };

  it('stops a spread that doubles per level', () => {
    const started = performance.now();
    expectRefused(paste(readAll(doubling(40, (a) => `[...${a}, ...${a}]`), 40)), DETAILS.overEvaluated);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('stops a table that doubles by sharing, which costs no memory until walked', () => {
    expectRefused(paste(readAll(doubling(40, (a) => `[${a}, ${a}]`), 40)), DETAILS.overEvaluated);
  });

  it('stops an object that doubles', () => {
    expectRefused(paste(readAll(doubling(40, (a) => `{ a: ${a}, b: ${a} }`), 40)), DETAILS.overEvaluated);
  });

  it('stops a template string that doubles', () => {
    const lines = ['const a0 = "xxxxxxxxxxxxxxxx";'];
    for (let i = 1; i <= 40; i += 1) lines.push(`const a${i} = \`\${a${i - 1}}\${a${i - 1}}\`;`);
    const reads = Array.from({ length: 41 }, (_, i) => `<i title={a${i}} />`).join('');
    expectRefused(paste(`${lines.join('\n')}\n<div>${reads}</div>`), DETAILS.overEvaluated);
  });

  it('stops more than 5,000 nodes', () => {
    expectRefused(paste(`<div>${repeat('<a />', IMPORT_LIMITS.outputNodes + 1)}</div>`), DETAILS.overNodes);
  });

  it('takes exactly 5,000 nodes', () => {
    const outcome = importSource(paste(`<div>${repeat('<i />', IMPORT_LIMITS.outputNodes - 1)}</div>`));
    expect(outcome.root?.children).toHaveLength(IMPORT_LIMITS.outputNodes - 1);
  });

  it('stops an element with attributes past the budget', () => {
    expectRefused(paste(`<div ${repeat('x="1" ', 80_000)} />`), DETAILS.overEvaluated);
  });

  it('refuses a component that renders itself', () => {
    expectRefused(paste('function A() { return <A />; }'), DETAILS.recursive);
  });

  it('refuses two components using each other twice', () => {
    expectRefused(paste('function A() { return <div><B /><B /></div>; }\nfunction B() { return <div><A /><A /></div>; }\nexport default A;'), DETAILS.recursive);
  });

  it('refuses a chain deeper than 16', () => {
    const names = Array.from({ length: 20 }, (_, i) => `C${i}`);
    const lines = names.map((name, i) => `function ${name}() { return <div>${i + 1 < names.length ? `<${names[i + 1]} />` : 'x'}</div>; }`);
    expectRefused(paste(`${lines.join('\n')}\nexport default C0;`), DETAILS.overInlining);
  });

  it('stops a fan-out of components, which no stack depth sees', () => {
    const names = Array.from({ length: 15 }, (_, i) => `C${i}`);
    const lines = names.map((name, i) => `function ${name}() { return <div>${i + 1 < names.length ? `<${names[i + 1]} /><${names[i + 1]} />` : 'x'}</div>; }`);
    expectRefused(paste(`${lines.join('\n')}\nexport default C0;`), DETAILS.overNodes);
  });
});

describe('a report over a million statements', () => {
  it('stays bounded and still accounts for all of it', () => {
    const outcome = importSource(paste(repeat('1;', 250_000)));
    expect(outcome.report.lines.length).toBeLessThanOrEqual(IMPORT_LIMITS.reportLines);
    expect(outcome.report.lines.at(-1)?.detail).toBe(DETAILS.overLines);
    // A statement and its literal, on one line each stretch.
    expect(outcome.report.lines.reduce((sum, line) => sum + line.atoms.length, 0)).toBe(500_000);
  });
});

describe('the one catch', () => {
  it('turns anything thrown into a refusal', () => {
    const hostile = { name: 'x.tsx', get text(): string { throw new Error('boom'); } };
    const outcome = importSource([hostile]);
    expect(outcome.report.verdict).toBe('not-imported');
    expect(details([hostile])).toContain(DETAILS.failed);
  });
});

describe('what a report may hold', () => {
  it('keeps source out of a detail, and out of the report altogether when asked', () => {
    const secret = 'planted-source-text';
    const text = `<div onClick={() => go("${secret}")} title={x("${secret}")}>{y("${secret}")}</div>`;
    expect(importSource(paste(text)).report.lines.some((line) => line.excerpt?.includes(secret))).toBe(true);
    expect(importSource(paste(text)).report.lines.some((line) => line.detail.includes(secret))).toBe(false);
    expect(JSON.stringify(importSource(paste(text), { excerpts: false }).report)).not.toContain(secret);
  });

  it('keeps an excerpt to 120 characters with whitespace collapsed', () => {
    const outcome = importSource(paste(`<div title={x(\n\n   "${'a'.repeat(300)}")} />`));
    const line = outcome.report.lines.find((each) => each.detail === DETAILS.dynamicAttribute);
    expect(line?.excerpt?.length).toBeLessThanOrEqual(120);
    expect(line?.excerpt).toMatch(/^title=\{x\( "a+$/);
  });
});

describe('files beside the entry', () => {
  it('reports a stylesheet and an unknown file, and does not read them', () => {
    const outcome = importSource([...paste('<p>Hi</p>'), { name: 'a.css', text: '@plugin "x";' }, { name: 'a.png', text: 'xx' }]);
    expect(outcome.root?.type).toBe('p');
    const byDetail = Object.fromEntries(outcome.report.lines.map((line) => [line.detail, line]));
    expect(byDetail[DETAILS.stylesheet]).toMatchObject({ file: 'a.css', kind: 'css-rule', disposition: 'left' });
    expect(byDetail[DETAILS.notRead]).toMatchObject({ file: 'a.png', disposition: 'left' });
  });
});
