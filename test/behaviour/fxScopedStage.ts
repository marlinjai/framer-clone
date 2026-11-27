// The stage the scoped effects proofs (fxScoped.spec.ts and fxScopedMounted.spec.ts) draw on: the engine bundled
// from source with esbuild and mounted on a blank page in real Chromium, and the helpers both files use. Moved here
// unchanged from fxScoped.spec.ts on 2026-11-28 so the proofs run as two files on two CI runners (376 s in one).
// Each spec file calls registerScopedStage() once at its top, which registers the hooks; vitest gives every file its own
// copy of this module, so the two files never share a browser.

import { afterAll, afterEach, beforeAll, expect } from 'vitest';
import { build } from 'esbuild';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import path from 'node:path';
import { type PNG } from 'pngjs';
import { CHANNEL_TOLERANCE, HEIGHT, ORACLE_CONTEXT, STOP_THE_CLOCK, WIDTH, serveStage, settledCanvas } from '../fx-oracle/oracle';

export type Raw = Record<string, unknown>;
export const ORIGIN = 'http://fx-scoped.test';

export const layer = (id: string, type: string, params: Raw = {}, extra: Raw = {}): Raw => ({ id, type, name: id, visible: true, blend: 'normal', params, ...extra });
export const scene = (layers: Raw[]): Raw => ({ version: 1, id: 'scoped', size: { mode: 'fill' }, background: '#10131a', fps: 60, dpr: [1, 1], layers });

export const gradient = () => layer('g', 'gradient');
export const text = (extra: Raw = {}) => layer('t', 'text', {}, extra);
export const pixelate = (target?: string, granularity = 32) => layer('px', 'pixelate', { granularity }, target ? { target } : {});

export let bundle: string;
export let devBundle: string;
export let browser: Browser;
export const contexts: BrowserContext[] = [];

export const bundleFor = async (mode: 'production' | 'development'): Promise<string> => {
  const entry = path.resolve('test/behaviour/fxScoped.entry.tsx');
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': `"${mode}"` },
    nodePaths: [path.resolve('node_modules')],
    alias: { '@': path.resolve('src') },
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
};

/** Registers the stage's hooks: the two bundles and the browser before the file, a fresh context per test. */
export function registerScopedStage(): void {
  beforeAll(async () => {
    bundle = await bundleFor('production');
    devBundle = await bundleFor('development');
    browser = await chromium.launch();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map((context) => context.close()));
  });
}

/** Counts the WebGL textures and framebuffers alive on the page (created minus deleted). */
export const COUNT_GL_OBJECTS = (): void => {
  const live = { textures: 0, framebuffers: 0 };
  (window as unknown as { __gl: typeof live }).__gl = live;
  for (const Context of [WebGL2RenderingContext, WebGLRenderingContext]) {
    const proto = Context.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const [kind, key] of [['textures', 'Texture'], ['framebuffers', 'Framebuffer']] as const) {
      const create = proto[`create${key}`];
      const remove = proto[`delete${key}`];
      proto[`create${key}`] = function (this: unknown, ...args: unknown[]) {
        live[kind] += 1;
        return create.apply(this, args);
      };
      proto[`delete${key}`] = function (this: unknown, ...args: unknown[]) {
        if (args[0]) live[kind] -= 1;
        return remove.apply(this, args);
      };
    }
  }
};

/** Counts the animation frames the page asks for: a scene drawn on demand asks for one per frame it draws. */
export const COUNT_FRAME_REQUESTS = (): void => {
  const w = window as unknown as { __raf: number; requestAnimationFrame: (cb: FrameRequestCallback) => number };
  w.__raf = 0;
  const original = w.requestAnimationFrame.bind(window);
  w.requestAnimationFrame = (cb) => {
    w.__raf += 1;
    return original(cb);
  };
};

/** One mounted scene that is edited in place, like the editor does. `dev` is the development build under StrictMode. */
export async function session(
  first: Raw,
  options: { dev?: boolean } = {},
): Promise<{ show: (next: Raw) => Promise<PNG>; live: () => Promise<{ textures: number; framebuffers: number }>; frames: () => Promise<number>; idle: (ms: number) => Promise<number>; reflow: () => Promise<PNG> }> {
  const context = await browser.newContext(ORACLE_CONTEXT);
  contexts.push(context);
  const page = await context.newPage();
  await page.addInitScript(STOP_THE_CLOCK);
  await page.addInitScript(COUNT_GL_OBJECTS);
  await page.addInitScript(COUNT_FRAME_REQUESTS);
  if (options.dev) await page.addInitScript(() => ((window as unknown as { __strict: boolean }).__strict = true));
  await serveStage(page, ORIGIN, { '/scoped.js': options.dev ? devBundle : bundle });
  await page.goto(`${ORIGIN}/`);
  await page.evaluate((config) => (window as unknown as { __mount: (scene: unknown) => string[] }).__mount(config), first);
  await settledCanvas(page, '#stage canvas');
  return {
    show: async (next) => {
      await page.evaluate((config) => (window as unknown as { __update: (scene: unknown) => string[] }).__update(config), next);
      await page.waitForTimeout(400);
      return settledCanvas(page, '#stage canvas');
    },
    live: () => page.evaluate(() => (window as unknown as { __gl: { textures: number; framebuffers: number } }).__gl),
    frames: () => page.evaluate(() => (window as unknown as { __raf: number }).__raf),
    /** Makes the scene's box another size and back: the canvas asks for a frame of its own accord, long after the edit. */
    reflow: async () => {
      await page.evaluate(() => ((document.getElementById('stage') as HTMLElement).style.width = '700px'));
      await page.waitForTimeout(400);
      await page.evaluate((width) => ((document.getElementById('stage') as HTMLElement).style.width = `${width}px`), WIDTH);
      await page.waitForTimeout(400);
      return settledCanvas(page, '#stage canvas');
    },
    /** The frames requested while nothing happens for `ms` milliseconds. */
    idle: async (ms) => {
      const before = await page.evaluate(() => (window as unknown as { __raf: number }).__raf);
      await page.waitForTimeout(ms);
      return (await page.evaluate(() => (window as unknown as { __raf: number }).__raf)) - before;
    },
  };
}

/** A scene as the real engine draws it, held still (reduced motion, stopped clock). `touch` is a phone: the step down starts on. */
export async function draw(raw: Raw, options: { touch?: boolean; dev?: boolean } = {}): Promise<{ picture: PNG; notes: string[]; consoleErrors: string[] }> {
  const context = await browser.newContext({ ...ORACLE_CONTEXT, ...(options.touch ? { isMobile: true, hasTouch: true } : {}) });
  contexts.push(context);
  const page: Page = await context.newPage();
  const problems: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()));
  await page.addInitScript(STOP_THE_CLOCK);
  if (options.dev) await page.addInitScript(() => ((window as unknown as { __strict: boolean }).__strict = true));
  await serveStage(page, ORIGIN, { '/scoped.js': options.dev ? devBundle : bundle });
  await page.goto(`${ORIGIN}/`);
  const notes = await page.evaluate((config) => (window as unknown as { __mount: (scene: unknown) => string[] }).__mount(config), raw);
  const picture = await settledCanvas(page, '#stage canvas');
  expect(problems).toEqual([]);
  return { picture, notes, consoleErrors };
}

export const px = (png: PNG, x: number, y: number): [number, number, number] => {
  const i = (y * png.width + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
};

/** Pixels (as a share of the picture) that differ by more than the tolerance, optionally only inside or outside a box. */
export function differing(a: PNG, b: PNG, box?: { x0: number; y0: number; x1: number; y1: number; inside: boolean }): number {
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
export async function textBox(margin: number) {
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
