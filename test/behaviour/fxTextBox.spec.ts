// The FX text box layer (kind `textBox`, plan docs/plans/2026-11-13-fx-layers-in-layers-panel.md, slice
// L3) in real Chromium and WebKit with a real WebGL context: it draws, where `position` and `anchor`
// put it, as one still frame under reduced motion, and a scene with a text box and one without it
// differ only where the text is.
//
// The mount module is bundled by esbuild and mounted on a blank stage, as test/score/fx.score.ts
// does, so the check needs no Postgres and no Next build of its own: it runs in this project because
// it is a browser check, next to the other FX specs.

import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type BrowserType, type Page } from 'playwright';
import type { PNG } from 'pngjs';
import { ORACLE_CONTEXT, STOP_THE_CLOCK, WIDTH, HEIGHT, colours, difference, serveStage, settledCanvas } from '../fx-oracle/oracle';

const ORIGIN = 'http://fx-textbox.test';
const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];

type Scene = Record<string, unknown>;

/** A black scene holding the given layers. */
const scene = (...layers: Record<string, unknown>[]): Scene => ({
  version: 1,
  id: 'textbox-check',
  size: { mode: 'fill' },
  background: '#000000',
  fps: 60,
  dpr: [1, 1],
  layers,
});

const textBox = (params: Record<string, unknown>) => ({ id: 'words', type: 'textBox', name: 'Words', visible: true, blend: 'normal', params });

/** White, bold, large text: easy to find on black. */
const WHITE = { color: '#ffffff', weight: '700', size: 0.2, font: 'Arial' };

const stored = (value: Scene) => ({ version: 1, scene: value, start: 'immediate', calm: 'frame' });

async function bundle(): Promise<string> {
  const { build } = await import('esbuild');
  const built = await build({
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
  return built.outputFiles[0].text;
}

/** The smallest rectangle holding every pixel that is clearly lit, or null when none is. */
function litBounds(png: PNG): { left: number; top: number; right: number; bottom: number; count: number } | null {
  let left = png.width;
  let top = png.height;
  let right = -1;
  let bottom = -1;
  let count = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      if (Math.max(png.data[i], png.data[i + 1], png.data[i + 2]) > 128) {
        count++;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  return count === 0 ? null : { left, top, right, bottom, count };
}

describe.each(ENGINES)('the text box layer in %s', (_name, engine) => {
  let browser: Browser;
  let script: string;

  beforeAll(async () => {
    [script, browser] = await Promise.all([bundle(), engine.launch()]);
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
  });

  /** The scene drawn under reduced motion (one still frame) with the clock stopped. */
  async function draw(value: Scene): Promise<PNG> {
    const context = await browser.newContext(ORACLE_CONTEXT);
    const page: Page = await context.newPage();
    const problems: string[] = [];
    page.on('pageerror', (error) => problems.push(error.message));
    try {
      await page.addInitScript(STOP_THE_CLOCK);
      await serveStage(page, ORIGIN, { '/sites.js': script });
      await page.goto(`${ORIGIN}/`);
      const outcome = await page.evaluate((v) => (window as unknown as { __mountSites: (s: unknown) => Promise<string> }).__mountSites(v), stored(value));
      if (outcome !== 'live') throw new Error(`the scene did not draw (${outcome})`);
      const shot = await settledCanvas(page, '#stage canvas');
      if (problems.length > 0) throw new Error(`the page threw: ${problems.join('; ')}`);
      return shot;
    } finally {
      await context.close();
    }
  }

  it('draws its text, at full strength and standing still, under reduced motion', async () => {
    const withText = await draw(scene(textBox({ ...WHITE, text: 'HELLO' })));
    const bounds = litBounds(withText);
    expect(bounds, 'no lit pixel: the text box drew nothing').not.toBeNull();
    // At its end state the text is at full strength, not mid-fade (a pure white glyph core).
    let brightest = 0;
    for (let i = 0; i < withText.data.length; i += 4) brightest = Math.max(brightest, withText.data[i], withText.data[i + 1], withText.data[i + 2]);
    expect(brightest).toBeGreaterThanOrEqual(250);
    expect(colours(withText)).toBeGreaterThan(2);
    // The same scene without the text box is plain black: the text is all that differs.
    const without = await draw(scene());
    expect(litBounds(without)).toBeNull();
    expect(difference(withText, without).differing).toBeGreaterThan(200);
  }, 120_000);

  it('puts the text at its position: centred by default', async () => {
    const bounds = litBounds(await draw(scene(textBox({ ...WHITE, text: 'HELLO' }))))!;
    const cx = (bounds.left + bounds.right) / 2;
    const cy = (bounds.top + bounds.bottom) / 2;
    expect(Math.abs(cx - WIDTH / 2)).toBeLessThan(WIDTH * 0.04);
    expect(Math.abs(cy - HEIGHT / 2)).toBeLessThan(HEIGHT * 0.06);
  }, 120_000);

  it('moves with its position and anchor: bottom left at the lower left of the scene', async () => {
    const bounds = litBounds(await draw(scene(textBox({ ...WHITE, text: 'HELLO', position: [0.1, 0.9], anchor: 'bottom left', width: 0.5 }))))!;
    expect(bounds.left).toBeGreaterThan(WIDTH * 0.05);
    expect(bounds.left).toBeLessThan(WIDTH * 0.2);
    expect(bounds.bottom).toBeGreaterThan(HEIGHT * 0.8);
    expect(bounds.bottom).toBeLessThan(HEIGHT * 0.95);
    expect(bounds.right).toBeLessThan(WIDTH * 0.6);
  }, 120_000);

  it('wraps inside its width and draws every line break', async () => {
    const line = litBounds(await draw(scene(textBox({ ...WHITE, size: 0.1, text: 'ONE TWO' }))))!;
    const lineHeight = line.bottom - line.top;
    // The same words in a box a third as wide wrap onto more lines and stay inside it.
    const narrow = litBounds(await draw(scene(textBox({ ...WHITE, size: 0.1, width: 0.2, text: 'ONE TWO' }))))!;
    expect(narrow.right - narrow.left).toBeLessThan((line.right - line.left) * 0.7);
    expect(narrow.bottom - narrow.top).toBeGreaterThan(lineHeight * 1.8);
    expect(narrow.right - narrow.left).toBeLessThanOrEqual(WIDTH * 0.2 + 2);
    // A line break in the text is a new line, however much room there is.
    const broken = litBounds(await draw(scene(textBox({ ...WHITE, size: 0.1, text: 'ONE\nTWO\nTHREE' }))))!;
    expect(broken.bottom - broken.top).toBeGreaterThan(lineHeight * 3);
  }, 120_000);

  it('can be the source of god rays: the rays leave the text and light the scene around it', async () => {
    const words = textBox({ ...WHITE, text: 'SUN' });
    const rays = { id: 'rays', type: 'godRays', name: 'God Rays', visible: true, blend: 'normal', params: { sourceLayerId: 'words', weight: 0.8, exposure: 0.5, density: 0.97, decay: 0.95 } };
    const plain = await draw(scene(words));
    const lit = await draw(scene(words, rays));
    expect(difference(plain, lit).differing, 'the rays changed nothing').toBeGreaterThan(500);
  }, 120_000);

  it('draws nothing for an empty text and does not stop the scene', async () => {
    expect(litBounds(await draw(scene(textBox({ ...WHITE, text: '' }))))).toBeNull();
  }, 120_000);
});
