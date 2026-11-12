// The FX scene rows of the score (test/score/data/fx-scenes.json): three reference
// scenes of Lumitra FX, the WebGL effects engine an FX scene box draws
// (docs/plans/2026-11-08-lumitra-fx-in-sites.md, slice F4).
//
//   format    the strict reader (src/lib/fxScene) gives exactly the scene the
//             engine's own loader gives, repairs nothing, and reading what it
//             stores gives the same scene again
//   renderer  this app draws the same pixels as the engine as lumitra-web runs
//             it: the frozen copy in test/fx-oracle against this app's engine,
//             mounted by the same module the published island mounts it with
//             (src/lib/fxScene/mount), at the reduced motion frame with the clock
//             stopped, within the plan's tolerance
//
// The canvas, the panel and the generator are not built for FX scenes yet (slices
// F5 and F6), so those cells are not measured here and fail in the report.
//
// Not a Next build: the mount module is bundled by esbuild, as the behaviour runtime
// is for its rows. The island, the lazy chunk of a real build and WebKit are proven
// in test/behaviour/fx.spec.ts and fxOracle.spec.ts.

import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { PNG } from 'pngjs';
import { PRESETS, deserializeScene, serializeScene } from '@/lib/fx/format';
import { parseFxProp, storedFxProp } from '@/lib/fxScene/fxScene';
import {
  CHANNEL_TOLERANCE,
  MAX_DIFFERING_SHARE,
  ORACLE_CONTEXT,
  STOP_THE_CLOCK,
  buildReferenceBundle,
  colours,
  difference,
  drawReference,
  serveStage,
  settledCanvas,
  type OracleScene,
} from '../fx-oracle/oracle';
import fxScenes from './data/fx-scenes.json';
import { writeOut } from './lib/io';
import { rowKey, type Cell, type SurfaceResults } from './lib/types';
import { fxSceneEntries } from './lib/universe';

const preset = (id: string): OracleScene => serializeScene(PRESETS.find((p) => p.id === id)!.load()) as unknown as OracleScene;

const SCENES: Readonly<Record<string, OracleScene>> = {
  // The lumitra.co hub hero is the engine's first preset.
  'hub-hero': preset('gold-noise-gradient'),
  'godrays-hero': preset('godrays-hero'),
  'noise-gradient': preset('noise-gradient'),
};

const SITES_ORIGIN = 'http://fx-sites.test';

const key = (id: string) => rowKey('fx-scene', `scene:${id}`);
const pass = (note?: string): Cell => ({ status: 'pass', ...(note ? { note } : {}) });
const fail = (note: string): Cell => ({ status: 'fail', gap: 'fx-scene', note });

/** A stored FX prop holding the scene, drawn at once and held still for reduced motion. */
const stored = (scene: OracleScene) => ({ version: 1, scene, start: 'immediate', calm: 'frame' });

/** Format: the strict reader against the engine's own loader, and a store and read round trip. */
function formatCell(scene: OracleScene): Cell {
  const read = parseFxProp(stored(scene));
  if (!read.ok) return fail(`refused: ${read.message}`);
  if (read.notes.length > 0) return fail(`repaired: ${read.notes.join(' ')}`);
  if (JSON.stringify(serializeScene(read.fx.scene)) !== JSON.stringify(serializeScene(deserializeScene(scene)))) {
    return fail("the strict reader's scene differs from the engine loader's");
  }
  const again = parseFxProp(JSON.parse(JSON.stringify(storedFxProp(read.fx))));
  if (!again.ok || again.notes.length > 0 || JSON.stringify(again.fx) !== JSON.stringify(read.fx)) return fail('storing and reading again changed the scene');
  return pass();
}

/** This app's engine and reader as one script: `window.__mountSites(stored)` mounts into `#stage` and resolves with what happened. */
async function bundleSites(): Promise<string> {
  const { build } = await import('esbuild');
  const bundled = await build({
    stdin: {
      contents: `
        import { mountFxScene } from '@/lib/fxScene/mount';
        window.__mountSites = (stored) =>
          new Promise((resolve) => {
            mountFxScene(document.getElementById('stage'), stored, { onLive: () => resolve('live'), onOff: (reason) => resolve('off: ' + reason) });
          });
      `,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    alias: { '@': path.resolve('src') },
    logLevel: 'silent',
  });
  return bundled.outputFiles[0].text;
}

describe('FX scene promises', () => {
  let browser: Browser;
  let reference: string;
  let sites: string;

  beforeAll(async () => {
    [reference, sites, browser] = await Promise.all([buildReferenceBundle(), bundleSites(), chromium.launch()]);
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
  });

  const fresh = async (): Promise<Page> => {
    const context = await browser.newContext(ORACLE_CONTEXT);
    const page = await context.newPage();
    await page.addInitScript(STOP_THE_CLOCK);
    return page;
  };

  /** The scene as this app's engine draws it, mounted as the published island mounts it. */
  const drawSites = async (scene: OracleScene): Promise<PNG> => {
    const page = await fresh();
    try {
      await serveStage(page, SITES_ORIGIN, { '/sites.js': sites });
      await page.goto(`${SITES_ORIGIN}/`);
      const outcome = await page.evaluate((value) => (window as unknown as { __mountSites: (stored: unknown) => Promise<string> }).__mountSites(value), stored(scene));
      if (outcome !== 'live') throw new Error(`the scene did not draw (${outcome})`);
      return await settledCanvas(page, '#stage canvas');
    } finally {
      await page.context().close();
    }
  };

  const drawFrozen = async (scene: OracleScene): Promise<PNG> => {
    const page = await fresh();
    try {
      return await drawReference(page, reference, scene);
    } finally {
      await page.context().close();
    }
  };

  async function rendererCell(scene: OracleScene): Promise<Cell> {
    try {
      const [ours, theirs] = [await drawSites(scene), await drawFrozen(scene)];
      if (colours(ours) < 50 || colours(theirs) < 50) return fail('a blank or flat frame, so equal pixels would mean nothing');
      const result = difference(ours, theirs);
      const seen = `${result.differing} pixels differ by more than ${CHANNEL_TOLERANCE} in a channel (${(result.share * 100).toFixed(4)} percent), largest difference ${result.largest}`;
      return result.share <= MAX_DIFFERING_SHARE ? pass(seen) : fail(seen);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  it('measures the format and the renderer of every reference scene, and names nothing that is not a row', async () => {
    expect(Object.keys(SCENES).sort()).toEqual([...fxScenes.scenes].sort());
    const format: SurfaceResults = {};
    const renderer: SurfaceResults = {};
    for (const [id, scene] of Object.entries(SCENES)) {
      format[key(id)] = formatCell(scene);
      renderer[key(id)] = await rendererCell(scene);
    }
    const rows = new Set(fxSceneEntries().map((e) => rowKey(e.kind, e.id)));
    for (const name of [...Object.keys(format), ...Object.keys(renderer)]) expect(rows.has(name), name).toBe(true);
    writeOut('fx-scenes', { format, renderer });
  }, 300_000);

  it('the comparison can fail: one changed colour is far over the tolerance', async () => {
    const changed = JSON.parse(JSON.stringify(SCENES['hub-hero'])) as OracleScene;
    const layer = changed.layers.find((l) => Object.values(l.params).some((value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)))!;
    const param = Object.entries(layer.params).find(([, value]) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value))![0];
    layer.params[param] = '#00ff00';
    const result = difference(await drawSites(changed), await drawFrozen(SCENES['hub-hero']));
    expect(result.share).toBeGreaterThan(MAX_DIFFERING_SHARE * 10);
  }, 180_000);
});
