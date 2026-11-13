// Effects that apply to one content layer (src/lib/fx, `Layer.target`), drawn by the real
// engine in real Chromium. The engine is bundled from source with esbuild and mounted on a
// blank page, like the pixel oracle does for the frozen reference (test/fx-oracle): no
// server and no build of the app is needed, only the browser.
//
// Every claim has a positive control: a picture must DIFFER from the same scene without
// the effect, otherwise "the effect stayed inside its layer" would also pass when
// targeting does nothing at all.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import path from 'node:path';
import type { PNG } from 'pngjs';
import { CHANNEL_TOLERANCE, HEIGHT, ORACLE_CONTEXT, STOP_THE_CLOCK, WIDTH, difference, serveStage, settledCanvas } from '../fx-oracle/oracle';

type Raw = Record<string, unknown>;
const ORIGIN = 'http://fx-scoped.test';

const layer = (id: string, type: string, params: Raw = {}, extra: Raw = {}): Raw => ({ id, type, name: id, visible: true, blend: 'normal', params, ...extra });
const scene = (layers: Raw[]): Raw => ({ version: 1, id: 'scoped', size: { mode: 'fill' }, background: '#10131a', fps: 60, dpr: [1, 1], layers });

const gradient = () => layer('g', 'gradient');
const text = (extra: Raw = {}) => layer('t', 'text', {}, extra);
const pixelate = (target?: string, granularity = 32) => layer('px', 'pixelate', { granularity }, target ? { target } : {});

let bundle: string;
let browser: Browser;
const contexts: BrowserContext[] = [];

beforeAll(async () => {
  const entry = path.resolve('test/behaviour/fxScoped.entry.tsx');
  const result = await build({
    entryPoints: [entry],
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

/** A scene as the real engine draws it, held still (reduced motion, stopped clock). `touch` is a phone: the step down starts on. */
async function draw(raw: Raw, options: { touch?: boolean } = {}): Promise<{ picture: PNG; notes: string[] }> {
  const context = await browser.newContext({ ...ORACLE_CONTEXT, ...(options.touch ? { isMobile: true, hasTouch: true } : {}) });
  contexts.push(context);
  const page: Page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  await page.addInitScript(STOP_THE_CLOCK);
  await serveStage(page, ORIGIN, { '/scoped.js': bundle });
  await page.goto(`${ORIGIN}/`);
  const notes = await page.evaluate((config) => (window as unknown as { __mount: (scene: unknown) => string[] }).__mount(config), raw);
  const picture = await settledCanvas(page, '#stage canvas');
  expect(problems).toEqual([]);
  return { picture, notes };
}

const px = (png: PNG, x: number, y: number): [number, number, number] => {
  const i = (y * png.width + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
};

/** Pixels (as a share of the picture) that differ by more than the tolerance, optionally only inside or outside a box. */
function differing(a: PNG, b: PNG, box?: { x0: number; y0: number; x1: number; y1: number; inside: boolean }): number {
  let count = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (box) {
        const inBox = x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1;
        if (inBox !== box.inside) continue;
      }
      const [r1, g1, b1] = px(a, x, y);
      const [r2, g2, b2] = px(b, x, y);
      if (Math.max(Math.abs(r1 - r2), Math.abs(g1 - g2), Math.abs(b1 - b2)) > CHANNEL_TOLERANCE) count++;
    }
  }
  return count;
}

/** The box the text lockup covers, grown by `margin`: found by drawing the gradient with and without it. */
async function textBox(margin: number) {
  const [without, withText] = [(await draw(scene([gradient()]))).picture, (await draw(scene([gradient(), text()]))).picture];
  let x0 = WIDTH, y0 = HEIGHT, x1 = 0, y1 = 0;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const [r1, g1, b1] = px(without, x, y);
      const [r2, g2, b2] = px(withText, x, y);
      if (Math.max(Math.abs(r1 - r2), Math.abs(g1 - g2), Math.abs(b1 - b2)) > 6) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
  }
  expect(x1).toBeGreaterThan(x0); // the text is on the picture at all
  return { x0: Math.max(0, x0 - margin), y0: Math.max(0, y0 - margin), x1: Math.min(WIDTH, x1 + margin), y1: Math.min(HEIGHT, y1 + margin), inside: false };
}

describe('effects that apply to one layer', () => {
  it('pixelate on the text changes the text and nothing else (positive control: it differs from the plain scene)', async () => {
    const plain = (await draw(scene([gradient(), text()]))).picture;
    const scoped = (await draw(scene([gradient(), text(), pixelate('t')]))).picture;
    const wholeScene = (await draw(scene([gradient(), text(), pixelate()]))).picture;
    const box = await textBox(40);
    expect(differing(scoped, plain, { ...box, inside: true })).toBeGreaterThan(200); // the effect is there
    expect(differing(scoped, plain, box)).toBe(0); // and stays inside the layer's area
    expect(differing(wholeScene, plain, box)).toBeGreaterThan(200); // the same effect on the whole scene does reach outside
  }, 120_000);

  it('works on a layer that is not the text (a gradient), and a different chain of two effects gives a different picture', async () => {
    const plain = (await draw(scene([gradient(), text()]))).picture;
    const scoped = (await draw(scene([gradient(), text(), pixelate('g')]))).picture;
    expect(difference(scoped, plain).share).toBeGreaterThan(0.01);
    // A convolution effect (bloom) is a pass of its own, which changes where the finished picture sits.
    const chain = (await draw(scene([gradient(), text(), pixelate('t'), layer('bl', 'bloom', { intensity: 2.5, threshold: 0.1, radius: 0.9 }, { target: 't' })]))).picture;
    const single = (await draw(scene([gradient(), text(), pixelate('t')]))).picture;
    expect(difference(chain, single).differing).toBeGreaterThan(100);
    expect(difference(chain, plain).differing).toBeGreaterThan(100);
  }, 120_000);

  it('grain on the text leaves the pixels outside the text unchanged', async () => {
    const plain = (await draw(scene([gradient(), text()]))).picture;
    const scoped = (await draw(scene([gradient(), text(), layer('gr', 'grain', { opacity: 1 }, { target: 't' })]))).picture;
    const box = await textBox(8);
    expect(differing(scoped, plain, { ...box, inside: true })).toBeGreaterThan(100);
    expect(differing(scoped, plain, box)).toBe(0);
  }, 120_000);

  it('a hidden target draws without its effect, never on the whole scene', async () => {
    const hidden = (await draw(scene([gradient(), text({ visible: false }), pixelate('t')]))).picture;
    const plain = (await draw(scene([gradient(), text({ visible: false })]))).picture;
    expect(difference(hidden, plain).differing).toBe(0);
  }, 120_000);

  it('a target that is not valid is dropped with a note and the effect applies to the whole scene', async () => {
    const dangling = await draw(scene([gradient(), text(), pixelate('gone')]));
    const whole = (await draw(scene([gradient(), text(), pixelate()]))).picture;
    expect(dangling.notes.join(' ')).toContain('not a layer of this scene');
    expect(difference(dangling.picture, whole).differing).toBe(0);
  }, 120_000);

  it('keeps the order of two layers at the same depth', async () => {
    const shape = (id: string, colorA: string) => layer(id, 'shape', { colorA, colorB: colorA, colorC: colorA, colorD: colorA });
    const noop = (target?: string) => layer('vg', 'vignette', { darkness: 0 }, target ? { target } : {});
    const plain = (await draw(scene([shape('s1', '#ff0000'), shape('s2', '#00ff00')]))).picture;
    const scoped = (await draw(scene([shape('s1', '#ff0000'), shape('s2', '#00ff00'), noop('s1')]))).picture;
    expect(px(plain, WIDTH / 2, HEIGHT / 2)[1]).toBeGreaterThan(px(plain, WIDTH / 2, HEIGHT / 2)[0]); // the later layer is on top
    expect(difference(scoped, plain).share).toBeLessThan(0.002);
  }, 120_000);

  it('a no-op effect on a layer with a screen or multiply blend leaves the picture as it was', async () => {
    for (const blend of ['screen', 'multiply', 'add']) {
      const noop = layer('vg', 'vignette', { darkness: 0 }, { target: 't' });
      const plain = (await draw(scene([gradient(), text({ blend })]))).picture;
      const scoped = (await draw(scene([gradient(), text({ blend }), noop]))).picture;
      expect(difference(scoped, plain).share, blend).toBeLessThan(0.002);
    }
  }, 180_000);

  it('on a phone the step down leaves out a heavy effect of a group, and the layer is drawn plainly', async () => {
    const bloom = layer('bl', 'bloom', { intensity: 2.5, threshold: 0.1, radius: 0.9 }, { target: 't' });
    const plainPhone = (await draw(scene([gradient(), text()]), { touch: true })).picture;
    const phone = (await draw(scene([gradient(), text(), bloom]), { touch: true })).picture;
    expect(difference(phone, plainPhone).differing).toBe(0);
    // Positive control: on a desktop the same bloom is there.
    const desktopPlain = (await draw(scene([gradient(), text()]))).picture;
    const desktop = (await draw(scene([gradient(), text(), bloom]))).picture;
    expect(difference(desktop, desktopPlain).differing).toBeGreaterThan(100);
  }, 180_000);

  it('retargeting from one layer to the whole scene and back draws the same picture as drawing it fresh', async () => {
    const first = (await draw(scene([gradient(), text(), pixelate('t')]))).picture;
    const again = (await draw(scene([gradient(), text(), pixelate('t')]))).picture;
    expect(difference(first, again).differing).toBe(0);
  }, 120_000);
});
