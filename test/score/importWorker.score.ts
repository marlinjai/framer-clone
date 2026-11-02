// The contract's first [unproven] line: TypeScript parses a real file inside a Web Worker
// in a real browser, with no `ts.sys`. Everything else about the importer builds on this,
// so it is proven here before anything does. This closes no matrix row and writes no
// number: it runs here because this is where Chromium is.
//
// Hostile files run in the worker as well, because a stack in a worker is not the stack
// in Node, and the limits are only worth what they do where they will run.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { IMPORT_LIMITS } from '@/lib/reactImport/budget';
import { DETAILS } from '@/lib/reactImport/report';
import type { ImportOutcome, SourceInput } from '@/lib/reactImport/source';
import { bundleImportWorker, type WorkerBundle } from '@/lib/reactImport/__tests__/workerBundle';

const ORIGIN = 'http://import-worker.test';
const MEGABYTE = 1024 * 1024;

interface WorkerReply {
  outcome: ImportOutcome;
  hasSystem: boolean;
  milliseconds: number;
}

let browser: Browser;
let page: Page;
let bundle: WorkerBundle;
const requests: string[] = [];

/** One `importSource` in a worker of its own, as the dialog will run it, ended at the deadline. */
const inWorker = (files: SourceInput[], deadlineMs: number = IMPORT_LIMITS.deadlineMs) =>
  page.evaluate(({ files: input, deadline }) => new Promise<WorkerReply | 'terminated' | string>((resolve) => {
    const worker = new Worker('/worker.js');
    const timer = setTimeout(() => {
      worker.terminate();
      resolve('terminated');
    }, deadline);
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      clearTimeout(timer);
      resolve(`error: ${event.message}`);
    };
    worker.postMessage({ files: input });
  }), { files, deadline: deadlineMs });

const reply = async (files: SourceInput[]): Promise<WorkerReply> => {
  const result = await inWorker(files);
  if (typeof result === 'string') throw new Error(`the worker did not answer: ${result}`);
  return result;
};

beforeAll(async () => {
  bundle = await bundleImportWorker();
  console.log(`worker chunk: ${(bundle.bytes / MEGABYTE).toFixed(2)} megabytes, ${(bundle.gzipBytes / MEGABYTE).toFixed(2)} gzipped`);
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on('request', (request) => {
    requests.push(request.url());
  });
  await page.route(`${ORIGIN}/`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>x</title>' }));
  await page.route(`${ORIGIN}/worker.js`, (route) => route.fulfill({ contentType: 'text/javascript', body: bundle.code }));
  await page.goto(`${ORIGIN}/`);
});

afterAll(async () => {
  await browser?.close();
});

describe('the importer in a browser worker', () => {
  it('parses a real file, with no system to read', async () => {
    const text = readFileSync(path.resolve(__dirname, '../../src/components/ui/button.tsx'), 'utf8');
    const { outcome, hasSystem, milliseconds } = await reply([{ name: 'button.tsx', text }]);
    console.log(`button.tsx in the worker: ${milliseconds.toFixed(1)} milliseconds, ${outcome.report.lines.length} lines`);
    expect(hasSystem).toBe(false);
    expect(outcome.report.lines.length).toBeGreaterThan(5);
    expect(outcome.report.lines.flatMap((line) => line.atoms).length).toBeGreaterThan(100);
    // It reads the file: this far, the variants and the classes wait for their layers.
    expect(outcome.report.verdict).toBe('not-imported');
  });

  it('converts what it can read', async () => {
    const { outcome } = await reply([{ name: 'paste.tsx', text: 'const t = "Hi";\n<section style={{ padding: 16 }}><h1>{t}</h1></section>' }]);
    expect(outcome.report.verdict).toBe('imported');
    expect(outcome.root).toMatchObject({ type: 'section', props: { style: { padding: 16 } }, children: [{ type: 'h1', props: { children: 'Hi' } }] });
  });

  it('touches nothing beyond the page and its own chunk', () => {
    expect(new Set(requests)).toEqual(new Set([`${ORIGIN}/`, `${ORIGIN}/worker.js`]));
  });

  it.each<[string, string, string?]>([
    ['nested parentheses', `${'('.repeat(100_000)}1${')'.repeat(100_000)}`],
    ['nested elements', '<div>'.repeat(50_000) + '</div>'.repeat(50_000)],
    ['a run of negations', `const a = ${'!'.repeat(100_000)}1;`],
    ['a long sum', `const a = ${'a+'.repeat(100_000)}a;`],
    ['a doubling constant', `const a0 = ["xxxxxxxxxxxxxxxx"];\n${Array.from({ length: 40 }, (_, i) => `const a${i + 1} = [...a${i}, ...a${i}];`).join('\n')}\n<div>${Array.from({ length: 41 }, (_, i) => `<i title={a${i}[0]} />`).join('')}</div>`, DETAILS.overEvaluated],
    ['a component that renders itself', 'function A() { return <A />; }', DETAILS.recursive],
    ['the parser exponential family', `const x = ${'async(a='.repeat(26)}1${')'.repeat(26)};`, DETAILS.tooDeep],
    ['a tree of fragments', [...Array.from({ length: 15 }, (_, i) => `function C${i}() { return <>${`<C${i + 1} />`.repeat(8)}</>; }`), 'function C15() { return <></>; }', '<C0 />'].join('\n'), DETAILS.overSteps],
    ['a constant written out thousands of times', `const s0="${'x'.repeat(200_000)}";\nconst s1=\`\${s0}\${s0}\`;\nconst s2=\`\${s1}\${s1}\`;\nconst s3=\`\${s2}\${s2}\`;\n<div>${'<i title={s3} />'.repeat(4_900)}</div>`, DETAILS.overEvaluated],
  ])('answers %s with a refusal, inside the deadline', async (_name, text, detail) => {
    const { outcome, milliseconds } = await reply([{ name: 'paste.tsx', text }]);
    console.log(`${_name}: ${milliseconds.toFixed(1)} milliseconds`);
    expect(outcome.root).toBeUndefined();
    expect(outcome.report.verdict).toBe('not-imported');
    if (detail) expect(outcome.report.lines.map((line) => line.detail)).toContain(detail);
    expect(milliseconds).toBeLessThan(IMPORT_LIMITS.deadlineMs);
  });

  it('answers the worst the input limits allow, inside the deadline', async () => {
    const worst = Array.from({ length: 4 }, (_, i) => ({ name: `f${i}.tsx`, text: '1;'.repeat(IMPORT_LIMITS.bytesPerFile / 2 - 1) }));
    const { outcome, milliseconds } = await reply(worst);
    console.log(`the input limit in statements: ${milliseconds.toFixed(1)} milliseconds`);
    expect(outcome.report.lines.length).toBeLessThanOrEqual(IMPORT_LIMITS.reportLines);
    expect(milliseconds).toBeLessThan(IMPORT_LIMITS.deadlineMs);
  });

  it('refuses `async ! (`, which needs no trick', async () => {
    const { outcome } = await reply([{ name: 'paste.tsx', text: `const x = ${'async ! ( '.repeat(26)}a${' )'.repeat(26)};` }]);
    expect(outcome.report.lines.map((line) => line.detail)).toContain(DETAILS.tooDeep);
  });

  it('ends a real hang in the parser, one built to blind both scans, and the next import runs', async () => {
    // A quote in text blinds the tokens to this line, and a closer in a comment blinds the raw count.
    const blind = `<p>'</p>; const x = ${'async(/*)*/a='.repeat(30)}1${')'.repeat(30)};`;
    expect(await inWorker([{ name: 'paste.tsx', text: blind }], 3_000)).toBe('terminated');
    expect((await reply([{ name: 'paste.tsx', text: '<p>ok</p>' }])).outcome.report.verdict).toBe('imported');
  });
});
