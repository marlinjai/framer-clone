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

  it('picks nothing without the probe, as the published page runs', async () => {
    const { page } = await open(scene([layer('g', 'gradient'), box()]), false);
    expect(await pickAt(page, 0, 0)).toBeNull();
  }, 120_000);
});
