// Picking a layer on the live canvas, drawn by the real engine in real Chromium. The engine is
// bundled from source with esbuild and mounted on a blank page, like fxScoped.spec.ts: no server
// and no build of the app is needed, only the browser.
//
// Two things are proved here that a unit test cannot:
//  1. Holding every content layer in an identity group so it can be picked (the editor passes
//     `onProbe`) changes no pixel: each of the four presets is drawn with and without it, still
//     frame, and the two pictures are compared pixel by pixel.
//  2. A real ray against the real scene hits the layer that is drawn there, and no layer that
//     fills the frame, also for a layer that has its own effect (a render channel of its own).

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import path from 'node:path';
import type { PNG } from 'pngjs';
import { PRESETS, serializeScene } from '@/lib/fx/format';
import { ORACLE_CONTEXT, STOP_THE_CLOCK, difference, serveStage, settledCanvas } from '../fx-oracle/oracle';

type Raw = Record<string, unknown>;
const ORIGIN = 'http://fx-pick.test';

let bundle: string;
let browser: Browser;
const contexts: BrowserContext[] = [];

beforeAll(async () => {
  const result = await build({
    entryPoints: [path.resolve('test/behaviour/fxPick.entry.tsx')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    nodePaths: [path.resolve('node_modules')],
    alias: { '@': path.resolve('src') },
    logLevel: 'silent',
  });
  bundle = result.outputFiles[0].text;
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
});

type Win = {
  __mount: (scene: unknown, withProbe: boolean) => string[];
  __pick: (x: number, y: number) => string | null;
  __probe: () => boolean;
};

async function open(scene: unknown, withProbe: boolean) {
  const context = await browser.newContext(ORACLE_CONTEXT);
  contexts.push(context);
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  await page.addInitScript(STOP_THE_CLOCK);
  await serveStage(page, ORIGIN, { '/scoped.js': bundle });
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(([config, probe]) => (window as unknown as Win).__mount(config, probe as boolean), [scene, withProbe]);
  const picture: PNG = await settledCanvas(page, '#stage canvas');
  expect(problems).toEqual([]);
  return { page, picture };
}

const presetScene = (id: string): Raw => serializeScene(PRESETS.find((p) => p.id === id)!.load()) as unknown as Raw;

describe('holding every content layer in a group so it can be picked', () => {
  it.each(PRESETS.map((p) => p.id))('draws the preset %s with 0 differing pixels, with the probe and without', async (id) => {
    const scene = presetScene(id);
    const plain = await open(scene, false);
    const probed = await open(scene, true);
    expect(await probed.page.evaluate(() => (window as unknown as Win).__probe())).toBe(true);
    const diff = difference(probed.picture, plain.picture);
    expect(diff.differing).toBe(0);
  }, 120_000);
});

describe('holding the layers of every kind a pick can hit', () => {
  it('draws a scene with a text, a text box, an image, a shape and a targeted effect with 0 differing pixels, with the probe and without', async () => {
    const layer = (id: string, type: string, params: Raw = {}, extra: Raw = {}): Raw => ({ id, type, name: id, visible: true, blend: 'normal', params, ...extra });
    const scene: Raw = {
      version: 1,
      id: 'mixed',
      size: { mode: 'fill' },
      background: '#10131a',
      fps: 60,
      dpr: [1, 1],
      layers: [
        layer('g', 'gradient'),
        layer('s', 'shape', { shape: 'circle', size: 0.3, softness: 0.1 }),
        layer('i', 'image', { fit: 'contain', scale: 0.4 }),
        layer('t', 'text'),
        layer('tb', 'textBox', { text: 'Hello there', width: 0.5 }),
        layer('px', 'pixelate', { granularity: 24 }, { target: 'tb' }),
      ],
    };
    const plain = await open(scene, false);
    const probed = await open(scene, true);
    expect(await probed.page.evaluate(() => (window as unknown as Win).__probe())).toBe(true);
    expect(difference(probed.picture, plain.picture).differing).toBe(0);
  }, 120_000);
});

describe('a real ray against the real scene', () => {
  const layer = (id: string, type: string, params: Raw = {}, extra: Raw = {}): Raw => ({ id, type, name: id, visible: true, blend: 'normal', params, ...extra });
  const scene = (layers: Raw[]): Raw => ({ version: 1, id: 'pick', size: { mode: 'fill' }, background: '#10131a', fps: 60, dpr: [1, 1], layers });
  const box = () => layer('tb', 'textBox', { text: 'Hello there', width: 0.5, size: 0.12 });
  const pickAt = (page: Awaited<ReturnType<typeof open>>['page'], x: number, y: number) => page.evaluate(([px, py]) => (window as unknown as Win).__pick(px, py), [x, y]);

  it('hits the text box where it is drawn, and never the gradient or the noise that fill the frame', async () => {
    const { page } = await open(scene([layer('g', 'gradient'), layer('n', 'noiseFill'), box()]), true);
    expect(await pickAt(page, 0, 0)).toBe('tb');
    expect(await pickAt(page, 0.95, 0.9)).toBeNull();
    expect(await pickAt(page, -0.95, -0.9)).toBeNull();
  }, 120_000);

  it('hits a layer that has an effect of its own', async () => {
    const { page } = await open(scene([layer('g', 'gradient'), box(), layer('px', 'pixelate', { granularity: 32 }, { target: 'tb' })]), true);
    expect(await pickAt(page, 0, 0)).toBe('tb');
    expect(await pickAt(page, 0.95, 0.9)).toBeNull();
  }, 120_000);

  /** Every point of a grid (normalised device coordinates) at which a pick hits `id`. */
  const hitsOf = (page: Awaited<ReturnType<typeof open>>['page'], id: string, x: [number, number], y: [number, number], step = 0.02) =>
    page.evaluate(
      ([x0, x1, y0, y1, st, wanted]) => {
        const out: [number, number][] = [];
        for (let px = x0 as number; px <= (x1 as number); px += st as number) {
          for (let py = y0 as number; py <= (y1 as number); py += st as number) {
            if ((window as unknown as Win).__pick(px, py) === wanted) out.push([px, py]);
          }
        }
        return out;
      },
      [x[0], x[1], y[0], y[1], step, id] as const,
    );

  it('picks the text lockup on its ink and not on the transparent margin of its plane', async () => {
    const { page } = await open(scene([layer('g', 'gradient'), layer('lk', 'text')]), true);
    // Some point near the middle is on the headline.
    const hits = await hitsOf(page, 'lk', [-0.5, 0.5], [-0.4, 0.4]);
    expect(hits.length).toBeGreaterThan(5);
    // The corners of the lockup's plane (5 by 2.5 world units, ndc about 0.67 by 0.54 at z 0) hold no ink.
    expect(await pickAt(page, 0.62, 0.5)).toBeNull();
    expect(await pickAt(page, -0.62, -0.5)).toBeNull();
    expect(await pickAt(page, 0.62, -0.5)).toBeNull();
  }, 120_000);

  it('reads the texture the right way up: in a left-aligned box a long first line and a short second line are hit where they are', async () => {
    const { page } = await open(scene([layer('g', 'gradient'), layer('tb', 'textBox', { text: 'MMMMMMMM\nMM', align: 'left', width: 0.6, size: 0.1 })]), true);
    const hits = await hitsOf(page, 'tb', [-0.8, 0.8], [-0.5, 0.5]);
    expect(hits.length).toBeGreaterThan(10);
    const upper = hits.filter(([, y]) => y > 0);
    const lower = hits.filter(([, y]) => y < 0);
    expect(upper.length).toBeGreaterThan(0);
    expect(lower.length).toBeGreaterThan(0);
    const right = (points: [number, number][]) => Math.max(...points.map(([x]) => x));
    // The first line (above) is the long one, the second (below) the short one: read upside down it would be the other way round.
    expect(right(upper)).toBeGreaterThan(right(lower) + 0.15);
  }, 120_000);

  it('the browser keeps a one pixel mark in the quarter-size copy at every offset when the copy is drawn at high quality (and loses some at the default)', async () => {
    const { page } = await open(scene([layer('g', 'gradient'), box()]), false);
    const kept = await page.evaluate(() => {
      const survives = (quality: ImageSmoothingQuality | null, axis: 'row' | 'column', offset: number) => {
        const source = new OffscreenCanvas(64, 32);
        const sctx = source.getContext('2d')!;
        sctx.fillStyle = 'white';
        if (axis === 'row') sctx.fillRect(10, 8 + offset, 40, 1);
        else sctx.fillRect(16 + offset, 4, 1, 20);
        const copy = new OffscreenCanvas(16, 8);
        const ctx = copy.getContext('2d', { willReadFrequently: true })!;
        if (quality) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = quality;
        }
        ctx.drawImage(source, 0, 0, 64, 32, 0, 0, 16, 8);
        const data = ctx.getImageData(0, 0, 16, 8).data;
        let max = 0;
        for (let i = 3; i < data.length; i += 4) max = Math.max(max, data[i]);
        return max > 4;
      };
      const all = (quality: ImageSmoothingQuality | null) => [0, 1, 2, 3, 4, 5, 6, 7].map((o) => [survives(quality, 'row', o), survives(quality, 'column', o)]).flat();
      return { high: all('high'), standard: all(null) };
    });
    // The code relies on this: every offset of a row and of a column survives at high quality.
    expect(kept.high.every(Boolean)).toBe(true);
    // Control: the default drops some, so the setting is what makes the difference.
    expect(kept.standard.every(Boolean)).toBe(false);
  }, 120_000);

  it('overlapping text boxes at one depth, reordered while retained: the click picks the box that is drawn on top', async () => {
    // Two text boxes with the same text, place and size, in two colours: whichever is drawn on top shows its colour.
    const same = { text: 'MMMM', width: 0.6, size: 0.3, position: [0.5, 0.5] };
    const red = () => layer('a', 'textBox', { ...same, color: '#ff0000' });
    const blue = () => layer('b', 'textBox', { ...same, color: '#0000ff' });
    const { page, picture } = await open(scene([layer('g', 'gradient'), red(), blue()]), true);
    const onTop = (png: PNG) => {
      let r = 0;
      let b = 0;
      let first: [number, number] | null = null;
      for (let y = 0; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) {
          const i = (y * png.width + x) * 4;
          if (png.data[i] > 200 && png.data[i + 2] < 80) {
            r++;
            first ??= [x, y];
          } else if (png.data[i + 2] > 200 && png.data[i] < 80) {
            b++;
            first ??= [x, y];
          }
        }
      }
      expect(Math.max(r, b)).toBeGreaterThan(200);
      return { id: r > b ? 'a' : 'b', at: first!, png };
    };
    const ndcOf = (at: [number, number], png: PNG): [number, number] => [(at[0] / png.width) * 2 - 1, 1 - (at[1] / png.height) * 2];

    // A, then B: B is created last and drawn on top, and it is the one picked.
    const first = onTop(picture);
    expect(first.id).toBe('b');
    expect(await pickAt(page, ...ndcOf(first.at, picture))).toBe('b');

    // The same two layers, retained, in the other stored order: whatever the scene draws on top now is what a click picks.
    await page.evaluate(([config]) => (window as unknown as Win).__mount(config, true), [scene([layer('g', 'gradient'), blue(), red()])]);
    const after = await settledCanvas(page, '#stage canvas');
    const second = onTop(after);
    expect(await pickAt(page, ...ndcOf(second.at, after))).toBe(second.id);
  }, 120_000);

  it('picks nothing without the probe, as the published page runs', async () => {
    const { page } = await open(scene([layer('g', 'gradient'), box()]), false);
    expect(await pickAt(page, 0, 0)).toBeNull();
  }, 120_000);
});
