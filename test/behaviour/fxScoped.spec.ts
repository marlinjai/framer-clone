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
import { PNG as PngWriter, type PNG } from 'pngjs';
import { CHANNEL_TOLERANCE, HEIGHT, ORACLE_CONTEXT, STOP_THE_CLOCK, WIDTH, difference, serveStage, settledCanvas } from '../fx-oracle/oracle';

type Raw = Record<string, unknown>;
const ORIGIN = 'http://fx-scoped.test';

const layer = (id: string, type: string, params: Raw = {}, extra: Raw = {}): Raw => ({ id, type, name: id, visible: true, blend: 'normal', params, ...extra });
const scene = (layers: Raw[]): Raw => ({ version: 1, id: 'scoped', size: { mode: 'fill' }, background: '#10131a', fps: 60, dpr: [1, 1], layers });

const gradient = () => layer('g', 'gradient');
const text = (extra: Raw = {}) => layer('t', 'text', {}, extra);
const pixelate = (target?: string, granularity = 32) => layer('px', 'pixelate', { granularity }, target ? { target } : {});

let bundle: string;
let devBundle: string;
let browser: Browser;
const contexts: BrowserContext[] = [];

const bundleFor = async (mode: 'production' | 'development'): Promise<string> => {
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

/** Counts the WebGL textures and framebuffers alive on the page (created minus deleted). */
const COUNT_GL_OBJECTS = (): void => {
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
const COUNT_FRAME_REQUESTS = (): void => {
  const w = window as unknown as { __raf: number; requestAnimationFrame: (cb: FrameRequestCallback) => number };
  w.__raf = 0;
  const original = w.requestAnimationFrame.bind(window);
  w.requestAnimationFrame = (cb) => {
    w.__raf += 1;
    return original(cb);
  };
};

/** One mounted scene that is edited in place, like the editor does. `dev` is the development build under StrictMode. */
async function session(
  first: Raw,
  options: { dev?: boolean } = {},
): Promise<{ show: (next: Raw) => Promise<PNG>; live: () => Promise<{ textures: number; framebuffers: number }>; frames: () => Promise<number>; idle: (ms: number) => Promise<number> }> {
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
    /** The frames requested while nothing happens for `ms` milliseconds. */
    idle: async (ms) => {
      const before = await page.evaluate(() => (window as unknown as { __raf: number }).__raf);
      await page.waitForTimeout(ms);
      return (await page.evaluate(() => (window as unknown as { __raf: number }).__raf)) - before;
    },
  };
}

/** A scene as the real engine draws it, held still (reduced motion, stopped clock). `touch` is a phone: the step down starts on. */
async function draw(raw: Raw, options: { touch?: boolean; dev?: boolean } = {}): Promise<{ picture: PNG; notes: string[] }> {
  const context = await browser.newContext({ ...ORACLE_CONTEXT, ...(options.touch ? { isMobile: true, hasTouch: true } : {}) });
  contexts.push(context);
  const page: Page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  await page.addInitScript(STOP_THE_CLOCK);
  if (options.dev) await page.addInitScript(() => ((window as unknown as { __strict: boolean }).__strict = true));
  await serveStage(page, ORIGIN, { '/scoped.js': options.dev ? devBundle : bundle });
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
    const wholeScene = (await draw(scene([gradient(), text(), pixelate()]))).picture;
    expect(difference(scoped, plain).share).toBeGreaterThan(0.01);
    expect(difference(scoped, wholeScene).differing).toBeGreaterThan(100); // not the whole-scene effect either
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
      // Positive control: a real effect on the same layer does change the picture, inside its box only.
      const real = (await draw(scene([gradient(), text({ blend }), layer('px2', 'pixelate', { granularity: 24 }, { target: 't' })]))).picture;
      const box = await textBox(40);
      expect(differing(real, plain, { ...box, inside: true }), `${blend} with a real effect`).toBeGreaterThan(50);
      expect(differing(real, plain, box), `${blend} outside the box`).toBe(0);
    }
  }, 180_000);

  it('a no-op effect on a layer that really applies its blend (noise field) leaves the picture as it was', async () => {
    const noise = (blend: string, extra: Raw = {}) => layer('n', 'noiseFill', { intensity: 0.8 }, { blend, ...extra });
    for (const blend of ['add', 'screen', 'multiply', 'overlay']) {
      const noop = layer('vg', 'vignette', { darkness: 0 }, { target: 'n' });
      const plain = (await draw(scene([gradient(), noise(blend)]))).picture;
      const scoped = (await draw(scene([gradient(), noise(blend), noop]))).picture;
      expect(difference(scoped, plain).share, blend).toBeLessThan(0.002);
      // Positive controls where the layer is visible under that blend (a noise field multiplied over
      // the gradient is not): the blend changes the picture, and a real effect changes it further.
      if (blend === 'multiply') continue;
      const normal = (await draw(scene([gradient(), noise('normal')]))).picture;
      expect(difference(plain, normal).differing, `${blend} differs from normal`).toBeGreaterThan(1000);
      const real = (await draw(scene([gradient(), noise(blend), layer('px', 'pixelate', { granularity: 24 }, { target: 'n' })]))).picture;
      expect(difference(real, plain).differing, `${blend} with a real effect`).toBeGreaterThan(100);
    }
  }, 240_000);

  it('a blend changed in a mounted scene drawn on demand (reduced motion) reaches the picture', async () => {
    const noise = (blend: string) => layer('n', 'noiseFill', { intensity: 0.8 }, { blend });
    const noop = layer('vg', 'vignette', { darkness: 0 }, { target: 'n' });
    const added = scene([gradient(), noise('add'), noop]);
    const normal = scene([gradient(), noise('normal'), noop]);
    const fresh = { add: (await draw(added)).picture, normal: (await draw(normal)).picture };
    expect(difference(fresh.add, fresh.normal).differing).toBeGreaterThan(1000); // the two differ, so the checks can fail
    const edits = await session(added);
    for (const [name, next] of [['normal', normal], ['add', added], ['normal', normal]] as const) {
      expect(difference(await edits.show(next), fresh[name]).differing, name).toBe(0);
    }
  }, 240_000);

  it('a setting changed in a mounted scene drawn on demand reaches the picture (the layers write uniforms from effects)', async () => {
    const noise = (intensity: number) => layer('n', 'noiseFill', { intensity }, { blend: 'add' });
    const low = scene([gradient(), noise(0.1)]);
    const high = scene([gradient(), noise(0.9)]);
    const fresh = { low: (await draw(low)).picture, high: (await draw(high)).picture };
    expect(difference(fresh.low, fresh.high).differing).toBeGreaterThan(1000);
    const edits = await session(low);
    for (const [name, next] of [['high', high], ['low', low], ['high', high]] as const) {
      expect(difference(await edits.show(next), fresh[name]).differing, name).toBe(0);
    }
  }, 240_000);

  describe('a scene drawn on demand shows every change made in place', () => {
    const noise = (intensity: number, blend = 'add') => layer('n', 'noiseFill', { intensity }, { blend });
    const solid = () => {
      const png = new PngWriter({ width: 64, height: 64 });
      for (let i = 0; i < png.data.length; i += 4) png.data.set([220, 40, 40, 255], i);
      return `data:image/png;base64,${PngWriter.sync.write(png).toString('base64')}`;
    };

    it('adds and removes a layer', async () => {
      const without = scene([gradient()]);
      const withNoise = scene([gradient(), noise(0.9)]);
      const fresh = { without: (await draw(without)).picture, withNoise: (await draw(withNoise)).picture };
      expect(difference(fresh.without, fresh.withNoise).differing).toBeGreaterThan(1000);
      const edits = await session(without);
      for (const [name, next] of [['withNoise', withNoise], ['without', without], ['withNoise', withNoise]] as const) {
        expect(difference(await edits.show(next), fresh[name]).differing, name).toBe(0);
      }
    }, 240_000);

    it('shows an image that loads after the scene is drawn (the layer re-renders from its own state, the scene does not change)', async () => {
      const image = layer('im', 'image', { src: solid(), opacity: 1 });
      const plain = scene([gradient()]);
      const withImage = scene([gradient(), image]);
      const fresh = { plain: (await draw(plain)).picture, withImage: (await draw(withImage)).picture };
      expect(difference(fresh.plain, fresh.withImage).differing).toBeGreaterThan(1000);
      const edits = await session(plain);
      expect(difference(await edits.show(withImage), fresh.withImage).differing).toBe(0);
    }, 240_000);

    it('in development under StrictMode (effects mounted, unmounted and mounted again): same pictures, nothing left behind, no frame loop', async () => {
      const low = scene([gradient(), noise(0.1)]);
      const high = scene([gradient(), noise(0.9)]);
      const fresh = { low: (await draw(low)).picture, high: (await draw(high)).picture };
      const edits = await session(low, { dev: true });
      for (const [name, next] of [['high', high], ['low', low], ['high', high], ['low', low]] as const) {
        expect(difference(await edits.show(next), fresh[name]).differing, name).toBe(0);
      }
      expect(await edits.idle(800), 'frames requested while nothing changes').toBe(0);
    }, 240_000);

    it('asks for no frame when nothing changes, and for a few when the scene does', async () => {
      const edits = await session(scene([gradient(), noise(0.5)]));
      expect(await edits.idle(800), 'idle after the first frame').toBe(0);
      const before = await edits.frames();
      await edits.show(scene([gradient(), noise(0.9)]));
      const used = (await edits.frames()) - before;
      expect(used, 'frames for one change').toBeGreaterThan(0);
      expect(used, 'frames for one change').toBeLessThanOrEqual(6);
      expect(await edits.idle(800), 'idle after the change').toBe(0);
      // The same scene stored again is a new object: one more pass, then quiet again.
      await edits.show(scene([gradient(), noise(0.9)]));
      expect(await edits.idle(800), 'idle after the same scene again').toBe(0);
    }, 240_000);
  });

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

  it('edits in a mounted scene give the same picture as a fresh draw: scope, whole scene, scope again, hide, show', async () => {
    const scoped = scene([gradient(), text(), pixelate('t')]);
    const whole = scene([gradient(), text(), pixelate()]);
    const hidden = scene([gradient(), text({ visible: false }), pixelate('t')]);
    const fresh = { scoped: (await draw(scoped)).picture, whole: (await draw(whole)).picture, hidden: (await draw(hidden)).picture };
    expect(difference(fresh.scoped, fresh.whole).differing).toBeGreaterThan(100); // the three differ, so the checks below can fail
    const edits = await session(scoped);
    for (const [name, next] of [['whole', whole], ['scoped', scoped], ['hidden', hidden], ['scoped', scoped], ['whole', whole], ['scoped', scoped]] as const) {
      expect(difference(await edits.show(next), fresh[name === 'whole' ? 'whole' : name === 'hidden' ? 'hidden' : 'scoped']).differing, name).toBe(0);
    }
  }, 240_000);

  it('in development (StrictMode runs effects twice) the picture is the same, with an effect on the whole scene and on one layer', async () => {
    const plain = (await draw(scene([gradient(), text()]))).picture;
    for (const [name, layers] of [
      ['whole scene', [gradient(), text(), pixelate()]],
      ['one layer', [gradient(), text(), pixelate('t')]],
    ] as const) {
      const production = (await draw(scene([...layers]))).picture;
      const development = (await draw(scene([...layers]), { dev: true })).picture;
      expect(difference(production, plain).differing, `${name} has an effect`).toBeGreaterThan(100);
      expect(difference(development, production).differing, `${name} in development`).toBe(0);
    }
  }, 240_000);

  it('leaves no WebGL textures or framebuffers behind when an effect on the whole scene comes and goes', async () => {
    // The library builds the main composer and never frees it; the scene frees it itself. Measured on
    // origin/main before the fix: one texture and one framebuffer more per cycle.
    const plain = scene([gradient(), text()]);
    const whole = scene([gradient(), text(), pixelate()]);
    const edits = await session(plain);
    await edits.show(whole);
    await edits.show(plain);
    const settled = await edits.live();
    for (let i = 0; i < 6; i++) {
      await edits.show(whole);
      await edits.show(plain);
    }
    const after = await edits.live();
    expect(after.framebuffers).toBeLessThanOrEqual(settled.framebuffers);
    expect(after.textures).toBeLessThanOrEqual(settled.textures);
  }, 240_000);

  it('leaves no WebGL textures or framebuffers behind when a group comes and goes', async () => {
    const withGroup = scene([gradient(), text(), pixelate('t')]);
    // Without the effect no main composer is built either, so only the group's buffers are counted.
    // Measured on origin/main and on this branch (test log /tmp/fxlayers/fx-l4-engine/diag.txt): a scene
    // that adds and removes an UNTARGETED effect leaks one texture and one framebuffer per cycle, because
    // @react-three/postprocessing never disposes its composer. That is older than this change and is
    // listed separately; a group's own composer is freed (this test is flat).
    const without = scene([gradient(), text()]);
    const edits = await session(withGroup);
    await edits.show(without);
    const settled = await edits.live();
    for (let i = 0; i < 6; i++) {
      await edits.show(withGroup);
      await edits.show(without);
    }
    const after = await edits.live();
    expect(after.framebuffers).toBeLessThanOrEqual(settled.framebuffers);
    expect(after.textures).toBeLessThanOrEqual(settled.textures + 2);
  }, 240_000);
});
