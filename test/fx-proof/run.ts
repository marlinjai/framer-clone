// The FX browser proof against real addresses (see ./proof.ts). It only reads pages.
//
//   pnpm tsx test/fx-proof/run.ts --fx <address with an FX scene> --plain <address without one> \
//     [--compare <address of the same scene elsewhere>] [--out <folder>]
//
// For each of Chromium and WebKit, at a desktop and a phone width, with and without
// reduced motion, it records what slice F7 of the plan asks for and says whether each
// reading is what it must be. With --compare it also draws the scene at both addresses at
// the still frame and compares the pictures (slice F8). The readings are printed as JSON
// and written, with the pictures, to the output folder (default test/fx-proof/.out).
//
// Exit code 0: every reading is as it must be. 1: at least one is not. 2: it could not run.

import fs from 'node:fs';
import path from 'node:path';
import { chromium, webkit, type BrowserType } from 'playwright';
import { PNG } from 'pngjs';
import { collectFxProof, compareFxAddresses, problemsOfDrawnScene, problemsOfNoScene, type FxProof } from './proof';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const fx = argument('fx');
const plain = argument('plain');
const compare = argument('compare');
const out = path.resolve(argument('out') ?? 'test/fx-proof/.out');

if (!fx || !plain) {
  console.error('usage: tsx test/fx-proof/run.ts --fx <address with an FX scene> --plain <address without one> [--compare <address>] [--out <folder>]');
  process.exit(2);
}

const ENGINES: [string, BrowserType][] = [
  ['chromium', chromium],
  ['webkit', webkit],
];
const WIDTHS = [
  { name: 'desktop', viewport: { width: 1440, height: 900 } },
  { name: 'phone', viewport: { width: 390, height: 844 } },
];

interface Reading {
  engine: string;
  width: string;
  page: 'fx' | 'plain';
  reducedMotion: boolean;
  problems: string[];
  proof: Omit<FxProof, 'scripts'> & { scripts: number; engineScripts: string[]; formatScripts: string[] };
}

async function main(fxUrl: string, plainUrl: string): Promise<number> {
  fs.mkdirSync(out, { recursive: true });
  const readings: Reading[] = [];
  const comparisons: Record<string, unknown>[] = [];
  for (const [engineName, engine] of ENGINES) {
    const browser = await engine.launch();
    try {
      for (const width of WIDTHS) {
        for (const reducedMotion of [false, true]) {
          for (const [kind, url] of [['fx', fxUrl], ['plain', plainUrl]] as const) {
            const proof = await collectFxProof(browser, url, { viewport: width.viewport, reducedMotion });
            // Under reduced motion a scene whose calm state is its background is not drawn, and one
            // whose calm state is a frame is: the page says which by its state.
            const drawn = kind === 'fx' && !(reducedMotion && proof.boxes[0]?.state === 'calm');
            const problems = drawn ? problemsOfDrawnScene(proof) : problemsOfNoScene(proof);
            const { scripts, ...rest } = proof;
            readings.push({
              engine: engineName,
              width: width.name,
              page: kind,
              reducedMotion,
              problems,
              proof: { ...rest, scripts: scripts.length, engineScripts: scripts.filter((s) => s.engine).map((s) => s.url), formatScripts: scripts.filter((s) => s.format).map((s) => s.url) },
            });
          }
        }
        if (compare) {
          try {
            const result = await compareFxAddresses(browser, { url: fxUrl }, { url: compare }, { viewport: width.viewport });
            const name = `${engineName}-${width.name}`;
            fs.writeFileSync(path.join(out, `${name}-a.png`), PNG.sync.write(result.pictures[0]));
            fs.writeFileSync(path.join(out, `${name}-b.png`), PNG.sync.write(result.pictures[1]));
            const { pictures: _pictures, ...numbers } = result;
            void _pictures;
            comparisons.push({ engine: engineName, width: width.name, ...numbers });
          } catch (error) {
            comparisons.push({ engine: engineName, width: width.name, same: false, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
    } finally {
      await browser.close();
    }
  }
  const report = { at: new Date().toISOString(), fx: fxUrl, plain: plainUrl, compare: compare ?? null, readings, comparisons };
  fs.writeFileSync(path.join(out, 'proof.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  const failed = readings.filter((reading) => reading.problems.length > 0).length + comparisons.filter((comparison) => comparison.same !== true).length;
  console.error(`\n${readings.length} readings and ${comparisons.length} comparisons, ${failed} not as they must be. Written to ${out}.`);
  return failed === 0 ? 0 : 1;
}

main(fx, plain).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(2);
  },
);
