// The FX pixel oracle's shared parts: the reference (Lumitra FX as lumitra-web runs
// it, from the archive beside this file), the page it is drawn on, the stopped clock
// and the comparison. Used by test/behaviour/fxOracle.spec.ts (this app's side is the
// real published page of a real build) and by test/score/fx.score.ts (the score's
// "FX scene promises" rows).
//
// THE REFERENCE is the engine's source at the lumitra-web commit it was copied from.
// It is unpacked, bundled with esbuild and mounted on a blank page. Two of its imports
// are replaced by stand-ins when bundling, because this app does not carry those
// packages: leva (the tuning panel, hidden unless `?tune=1`) and drei's
// PerformanceMonitor (the frame rate step down, which would drop passes at moments no
// test controls). Neither draws a pixel of the scene. The reference runs on this app's
// React and on the three.js and react-three versions lumitra-web resolves. lumitra.co
// itself, on its own Next and React, is compared in slice F8 of the plan.
//
// WHAT IS COMPARED is the frame a visitor with reduced motion gets, with the clock
// stopped. Under reduced motion every layer pins its own time to a constant, so the
// picture does not depend on when it is taken. One pass still reads a clock, the grain
// (its noise is seeded with the time the composer has counted), so the page's clock
// (`performance.now`) is held at zero on both sides: no time passes, the seed stays
// where it starts, and the grain is the same pattern on both. It is still grain, which
// the oracle checks. The two sides draw different numbers of frames (the reference
// draws every frame, this app draws on demand), which is exactly why nothing that
// counts frames or time may reach the picture.

import { build } from 'esbuild';
import { PNG } from 'pngjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';

export const ARCHIVE = path.resolve('test/fx-oracle/lumitra-web-fx-8a77254.tar.gz');
export const ARCHIVE_SHA256 = 'e04a4967341b20559443ca5fc21e0e3b6661278958e8b157a97b7c0a3c97242d';

/** The plan's tolerance: at most half a percent of pixels may differ by more than 2 in any channel. */
export const CHANNEL_TOLERANCE = 2;
export const MAX_DIFFERING_SHARE = 0.005;

/** The size every picture is drawn at, at a device pixel ratio of 1. */
export const WIDTH = 960;
export const HEIGHT = 540;

/** The browser context both sides are drawn in. */
export const ORACLE_CONTEXT = { viewport: { width: WIDTH, height: HEIGHT + 100 }, deviceScaleFactor: 1, reducedMotion: 'reduce' as const };

/** The origin the reference page is served under (answered by `serveReference`, no server). */
export const REFERENCE_ORIGIN = 'http://fx-oracle.test';

/** A stored scene: what `serializeScene` writes. */
export type OracleScene = Record<string, unknown> & {
  layers: Array<Record<string, unknown> & { id: string; type: string; params: Record<string, unknown> }>;
};

/** Stops the page's clock at zero. Pass to `page.addInitScript` before the page loads. */
export const STOP_THE_CLOCK = (): void => {
  performance.now = () => 0;
};

/**
 * The frozen lumitra-web engine as one script. It defines `window.__mountReference(scene)`,
 * which draws a stored scene into `#stage`. The archive is checked against its checksum first.
 */
export async function buildReferenceBundle(): Promise<string> {
  const actual = createHash('sha256').update(fs.readFileSync(ARCHIVE)).digest('hex');
  if (actual !== ARCHIVE_SHA256) throw new Error(`${ARCHIVE} is not the archive this oracle was written for (sha256 ${actual})`);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-oracle-'));
  try {
    execFileSync('tar', ['-xzf', ARCHIVE, '-C', workDir]);
    if (!fs.existsSync(path.join(workDir, 'packages/fx/src/LumitraScene.tsx'))) throw new Error('the archive does not hold packages/fx/src');

    // The stand-ins for the two packages this app does not carry (see the header).
    const stubs = path.join(workDir, 'stubs');
    fs.mkdirSync(stubs);
    fs.writeFileSync(
      path.join(stubs, 'leva.ts'),
      'export const Leva = () => null;\nexport const useControls = () => [{}, () => {}];\nexport const folder = (schema: unknown) => schema;\nexport const button = (fn: unknown) => fn;\n',
    );
    fs.writeFileSync(path.join(stubs, 'drei.ts'), 'export const PerformanceMonitor = () => null;\n');
    const entry = path.join(workDir, 'entry.tsx');
    fs.writeFileSync(
      entry,
      [
        "import { createElement } from 'react';",
        "import { createRoot } from 'react-dom/client';",
        "import { LumitraScene } from './packages/fx/src/LumitraScene';",
        "import { deserializeScene } from './packages/fx/src/serialize';",
        '(window as unknown as { __mountReference: (scene: unknown) => void }).__mountReference = (scene) => {',
        "  createRoot(document.getElementById('stage')!).render(createElement(LumitraScene, { config: deserializeScene(scene) }));",
        '};',
      ].join('\n'),
    );
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
      // Packages resolve from this app's node_modules: the archive holds source only.
      nodePaths: [path.resolve('node_modules')],
      alias: { leva: path.join(stubs, 'leva.ts'), '@react-three/drei': path.join(stubs, 'drei.ts') },
      logLevel: 'silent',
    });
    const bundle = result.outputFiles[0].text;
    // The reference really is the frozen copy, not this app's engine: it still asks for drei's
    // monitor and has none of what this app added (the pipeline planner, the frame rate sampler).
    if (!bundle.includes('PerformanceMonitor') || bundle.includes('planPipeline') || bundle.includes('createFrameRateSampler')) {
      throw new Error('the reference bundle is not the frozen lumitra-web engine');
    }
    return bundle;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** A blank page of the oracle's size with one `#stage` and the given scripts, in order. */
export function stagePage(scripts: readonly string[]): string {
  return (
    '<!doctype html><meta charset="utf-8"><title>FX oracle</title>' +
    `<style>html,body{margin:0;background:#000}#stage{position:relative;width:${WIDTH}px;height:${HEIGHT}px}</style>` +
    '<div id="stage"></div>' +
    scripts.map((src) => `<script src="${src}"></script>`).join('')
  );
}

/** Answers `origin` on this page with a stage page and its scripts, without a server. */
export async function serveStage(page: Page, origin: string, scripts: Readonly<Record<string, string>>): Promise<void> {
  await page.route(`${origin}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    const script = scripts[pathname];
    if (script !== undefined) return route.fulfill({ contentType: 'text/javascript', body: script });
    return route.fulfill({ contentType: 'text/html', body: stagePage(Object.keys(scripts)) });
  });
}

export interface Difference {
  /** Pixels that differ by more than the channel tolerance. */
  differing: number;
  /** Their share of the picture, 0 to 1. */
  share: number;
  /** The largest difference in any channel of any pixel. */
  largest: number;
}

export function difference(a: PNG, b: PNG): Difference {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`the pictures differ in size: ${a.width}x${a.height} and ${b.width}x${b.height}`);
  let differing = 0;
  let largest = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const delta = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (delta > CHANNEL_TOLERANCE) differing += 1;
    if (delta > largest) largest = delta;
  }
  return { differing, share: differing / (a.data.length / 4), largest };
}

/** How many distinct colours a picture holds: a blank or flat frame has one. */
export function colours(png: PNG): number {
  const seen = new Set<number>();
  for (let i = 0; i < png.data.length; i += 4) seen.add((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]);
  return seen.size;
}

/** The canvas at `selector`, once it has the oracle's size and two screenshots a third of a second apart are the same picture. */
export async function settledCanvas(page: Page, selector: string): Promise<PNG> {
  const canvas = page.locator(selector);
  await canvas.waitFor({ state: 'attached', timeout: 30_000 });
  // The canvas takes its box's size one measure after it mounts.
  const deadline = Date.now() + 15_000;
  for (;;) {
    const size = await canvas.evaluate((element) => [(element as HTMLCanvasElement).width, (element as HTMLCanvasElement).height]);
    if (size[0] === WIDTH && size[1] === HEIGHT) break;
    if (Date.now() > deadline) throw new Error(`the canvas at ${selector} is ${size[0]}x${size[1]}, not ${WIDTH}x${HEIGHT}`);
    await page.waitForTimeout(100);
  }
  let previous = PNG.sync.read(await canvas.screenshot());
  for (let attempt = 0; attempt < 40; attempt++) {
    await page.waitForTimeout(350);
    const next = PNG.sync.read(await canvas.screenshot());
    if (difference(previous, next).differing === 0) return next;
    previous = next;
  }
  throw new Error(`the picture at ${selector} never settled`);
}

/** The scene as the frozen lumitra-web engine draws it. `page` must be fresh, with the clock stopped. */
export async function drawReference(page: Page, bundle: string, scene: OracleScene): Promise<PNG> {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  await serveStage(page, REFERENCE_ORIGIN, { '/reference.js': bundle });
  await page.goto(`${REFERENCE_ORIGIN}/`);
  await page.evaluate((config) => (window as unknown as { __mountReference: (scene: unknown) => void }).__mountReference(config), scene);
  const shot = await settledCanvas(page, '#stage canvas');
  if (problems.length > 0) throw new Error(`the reference page threw: ${problems.join('; ')}`);
  return shot;
}
