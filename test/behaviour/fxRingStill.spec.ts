// The particle ring's own first frame on the published page (src/lib/fxScene/ringStill.ts; plan
// docs/plans/2026-11-08-lumitra-fx-in-sites.md, addendum of 2026-11-24): drawn by the island with plain WebGL
// before the engine is there, at the box's exact size and pixel ratio, and handed over to the live scene with no
// jump and no dip in brightness.
//
// THE PICTURE is held to the live scene's own first frame: the engine's chunks are held back by the test, the
// still is read, the engine is let through, and the live frame is read at the same size. Under reduced motion
// (with a frame as the calm state) the live scene holds exactly that frame, so the two must be the same pixels.
// Without reduced motion the live scene moves on from it, so there the proof is the order of things (the still
// leaves only once the live layer is fully opaque over it).
//
// Real production build, real Chromium and WebKit, the real route.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type BrowserContext, type BrowserType, type Page, type Route } from 'playwright';
import { PNG } from 'pngjs';
import { PRESETS, serializeScene } from '@/lib/fx/format';
import { FX_ATTR, FX_MARKER, FX_PROP } from '@/lib/fxScene/marker';
import { difference } from '../fx-oracle/oracle';
import { node, type StoredNode } from './pages';
import { publishPages } from './site';

const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];

/** Where the pictures compared below are written for a person to look at, when set (FX_STILL_SHOTS). */
const SHOTS = process.env.FX_STILL_SHOTS;
const keep = (file: string, png: PNG) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, file), PNG.sync.write(png));
};

const ring = serializeScene(PRESETS.find((p) => p.id === 'lumitra-light')!.load());
const noise = serializeScene(PRESETS.find((p) => p.id === 'noise-gradient')!.load());

const box = (id: string, fx: Record<string, unknown>, style: Record<string, unknown>): StoredNode =>
  node(id, 'div', { [FX_ATTR]: FX_MARKER, [FX_PROP]: { version: 1, scene: ring, start: 'immediate', calm: 'frame', ...fx }, style }, node(`${id}-title`, 'h1', { children: 'Over the ring', style: { margin: '0px', padding: '24px', color: '#e9fff4', position: 'relative' } }));

interface Size {
  name: string;
  width: number;
  height: number;
  dpr: number;
  /** The scene's background, when not the preset's hex colour. */
  background?: string;
}

// A wide box (the height decides the radius), the same at the highest ratio a scene draws at, and a tall phone
// box (the width decides it) at a fractional canvas width (390 x 1.75 = 682.5).
const SIZES: readonly Size[] = [
  { name: 'wide', width: 960, height: 540, dpr: 1 },
  { name: 'wide at 1.75', width: 960, height: 540, dpr: 1.75 },
  { name: 'tall at 1.75', width: 390, height: 700, dpr: 1.75 },
  // A background the format accepts in another notation: the still reads it as the browser does, the engine as three.js does.
  { name: 'wide on hsl', width: 960, height: 540, dpr: 1, background: 'hsl(200, 45%, 9%)' },
];
const slug = (size: Size) => `still-${size.name.replace(/[^a-z0-9]+/g, '-')}`;
const sized = (size: Size) => ({ position: 'relative', width: `${size.width}px`, height: `${size.height}px`, background: '#04090b' });
const HERO = { position: 'relative', minHeight: '460px', background: '#04090b' };

const PAGES: Readonly<Record<string, () => StoredNode>> = {
  ...Object.fromEntries(SIZES.map((size) => [slug(size), () => node('page-root', 'div', { style: { margin: '0px' } }, box('hero', size.background ? { scene: { ...ring, background: size.background } } : {}, sized(size)))])),
  'still-hero': () => box('hero', { start: 'settled' }, HERO),
  'still-calm-background': () => box('hero', { calm: 'background' }, HERO),
  'still-visible': () => node('page-root', 'div', {}, node('spacer', 'div', { style: { height: '3000px' } }), box('hero', { start: 'visible' }, HERO)),
  'still-two': () => node('page-root', 'div', {}, box('hero', {}, HERO), box('second', {}, HERO)),
  'still-noise': () => box('hero', { scene: noise }, HERO),
};

/** Makes WebGL report a graphics card as its renderer (UNMASKED_RENDERER_WEBGL), whatever draws underneath. */
const SAY_GRAPHICS_CARD = () => {
  const UNMASKED_RENDERER = 0x9246;
  for (const proto of [WebGL2RenderingContext.prototype, WebGLRenderingContext.prototype]) {
    const original = proto.getParameter;
    proto.getParameter = function (this: WebGLRenderingContext, name: number) {
      return name === UNMASKED_RENDERER ? 'Test graphics card (fxRingStill.spec)' : original.call(this, name);
    } as typeof original;
  }
};

let origin: string;
beforeAll(async () => {
  origin = await publishPages(process.env.BEHAVIOUR_PORT!, { pages: PAGES });
}, 180_000);

describe.each(ENGINES)('in %s', (name, engine) => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let warnings: string[];
  let problems: string[];
  /** The engine's chunks, by address: learnt once from a page that loads them. */
  let engineUrls: Set<string>;

  const newPage = async (options: { size?: Size; reducedMotion?: 'reduce' | 'no-preference'; software?: boolean } = {}) => {
    await context?.close();
    const size = options.size;
    context = await browser.newContext({
      viewport: size ? { width: size.width, height: size.height + 100 } : { width: 1000, height: 700 },
      deviceScaleFactor: size?.dpr ?? 1,
      reducedMotion: options.reducedMotion ?? 'no-preference',
    });
    page = await context.newPage();
    // The test machines draw WebGL on the processor (SwiftShader), where the still is left out on purpose
    // (isSoftwareRenderer). These tests are about the still, so the renderer names a graphics card; the one test
    // about software rendering opens its page without this.
    if (!options.software) await page.addInitScript(SAY_GRAPHICS_CARD);
    warnings = [];
    problems = [];
    page.on('console', (message) => {
      if (message.type() === 'warning') warnings.push(message.text());
      if (message.type() === 'error') problems.push(message.text());
    });
    page.on('pageerror', (error) => problems.push(error.message));
  };

  /** Holds the engine's chunks back until the returned release is called. */
  const holdEngine = async (): Promise<() => void> => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/_next/static/chunks/**', async (route: Route) => {
      if (engineUrls.has(route.request().url())) await gate;
      await route.continue().catch(() => {});
    });
    return release;
  };

  const hero = (id = 'hero') => page.locator(`[data-t="${id}"]`).first();
  const state = (id = 'hero') => hero(id).getAttribute('data-fc-fx-state');
  const waitForState = (wanted: string, id = 'hero') =>
    page.waitForFunction(([target, value]) => document.querySelector(`[data-t="${target}"]`)?.getAttribute('data-fc-fx-state') === value, [id, wanted] as const, { timeout: 30_000 });
  const stills = (id = 'hero') => hero(id).locator('[data-fc-fx-ring-still]');
  const fxWarnings = () => warnings.filter((text) => text.includes('FX scene'));
  /** The still, shown and faded in. */
  const stillShown = async (id = 'hero') => {
    await stills(id).waitFor({ state: 'attached', timeout: 30_000 });
    await expect.poll(() => stills(id).evaluate((el) => getComputedStyle(el).opacity), { timeout: 5000 }).toBe('1');
  };
  const shot = async (size: Size) => {
    const png = PNG.sync.read(await hero().screenshot({ scale: 'device' }));
    expect([png.width, png.height]).toEqual([Math.ceil(size.width * size.dpr), Math.ceil(size.height * size.dpr)]);
    return png;
  };

  beforeAll(async () => {
    browser = await engine.launch();
    await newPage();
    const found: Promise<string | null>[] = [];
    page.on('response', (response) => {
      if (!response.url().includes('/_next/static/chunks/')) return;
      found.push(response.text().then((text) => (text.includes('WebGLRenderer') ? response.url() : null), () => null));
    });
    await page.goto(`${origin}/still-hero`);
    await waitForState('live');
    engineUrls = new Set((await Promise.all(found)).filter((url): url is string => url !== null));
    expect(engineUrls.size).toBeGreaterThan(0);
  }, 60_000);
  afterAll(async () => {
    await context?.close();
    await browser?.close();
  });
  beforeEach(async () => {
    await newPage();
  });
  afterEach(() => {
    expect(problems.filter((text) => !/Failed to load resource|net::ERR_FAILED|access control checks/i.test(text))).toEqual([]);
  });

  describe.each(SIZES.map((size) => [size.name, size] as const))('a %s box', (sizeName, size) => {
    it('the still is the live first frame, pixel for pixel, and the hand-over between them is that picture throughout', async () => {
      await newPage({ size, reducedMotion: 'reduce' });
      const release = await holdEngine();
      await page.goto(`${origin}/${slug(size)}`);
      await stillShown();
      // The heading hidden, so only the scene is compared.
      await page.addStyleTag({ content: '[data-t="hero-title"]{visibility:hidden}' });
      expect(['waiting', 'loading']).toContain(await state());
      const still = await shot(size);
      release();
      await waitForState('live');
      // Mid fade: the live layer half over the still. A two-sided cross-fade would dip here; this is the same picture.
      await page.waitForTimeout(120);
      const midFade = await shot(size);
      await expect.poll(() => stills().count(), { timeout: 5000 }).toBe(0);
      await page.waitForTimeout(300);
      const live = await shot(size);
      const label = `${name}-${slug(size)}`;
      keep(`${label}-still.png`, still);
      keep(`${label}-mid-fade.png`, midFade);
      keep(`${label}-live.png`, live);
      const pixels = still.width * still.height;
      const atEnd = difference(still, live);
      const during = difference(midFade, live);
      console.info(`ring still (${name}, ${sizeName}): ${atEnd.differing} of ${pixels} pixels differ by more than 2 (largest ${atEnd.largest}); mid fade ${during.differing} (largest ${during.largest})`);
      expect(atEnd.share).toBeLessThan(0.0005);
      expect(during.share).toBeLessThan(0.0005);
    }, 120_000);
  });

  it('shows the still before the engine is there, and takes it away only once the live layer is fully opaque', async () => {
    const release = await holdEngine();
    await page.addInitScript(() => {
      const marks: Record<string, number> = {};
      (window as unknown as { __marks: unknown }).__marks = marks;
      new MutationObserver(() => {
        const hero = document.querySelector('[data-t="hero"]');
        const now = performance.now();
        if (hero?.querySelector('[data-fc-fx-ring-still]')) marks.still ??= now;
        else if (marks.still !== undefined) marks.stillGone ??= now;
        if (hero?.getAttribute('data-fc-fx-state') === 'live') marks.live ??= now;
      }).observe(document, { subtree: true, childList: true, attributes: true });
    });
    await page.goto(`${origin}/still-hero`);
    await stillShown();
    // One canvas on the page while the engine is held back: the still, a 2D canvas (its WebGL context is already gone).
    expect(await page.locator('canvas').count()).toBe(1);
    expect(await stills().evaluate((el) => (el as HTMLCanvasElement).getContext('webgl2') === null && (el as HTMLCanvasElement).getContext('webgl') === null)).toBe(true);
    // Behind the content, taking no pointer, hidden from assistive technology.
    expect(await stills().evaluate((el) => [el.getAttribute('aria-hidden'), getComputedStyle(el).zIndex, getComputedStyle(el).pointerEvents])).toEqual(['true', '-2', 'none']);
    await hero('hero-title').click({ trial: true });
    // No loading placeholder over or beside it.
    expect(await page.locator('[data-fc-fx-placeholder]').count()).toBe(0);
    release();
    await waitForState('live');
    await expect.poll(() => stills().count(), { timeout: 5000 }).toBe(0);
    const marks = await page.evaluate(() => (window as unknown as { __marks: Record<string, number> }).__marks);
    // The live layer fades in over 300 ms; the still stays under it all that time.
    expect(marks.stillGone - marks.live).toBeGreaterThanOrEqual(290);
    expect(await page.locator('[data-fc-fx-layer]').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    // The box given back: the live layer holds it now, the still's hold is gone with it.
    expect(await page.locator('canvas').count()).toBe(1);
  });

  it('when the engine chunk does not arrive: the still stays as the picture, the box says off, one warning', async () => {
    await page.route('**/_next/static/chunks/**', (route) => (engineUrls.has(route.request().url()) ? route.abort() : route.continue()));
    await page.goto(`${origin}/still-hero`);
    await waitForState('off');
    expect(await stills().count()).toBe(1);
    // The engine fails fast here, possibly before the still's own fade in is over.
    await expect.poll(() => stills().evaluate((el) => getComputedStyle(el).opacity), { timeout: 5000 }).toBe('1');
    expect(fxWarnings()).toHaveLength(1);
    expect(fxWarnings()[0]).toContain('did not load');
  });

  it('under reduced motion with the background as the calm state: no still, nothing drawn', async () => {
    await newPage({ reducedMotion: 'reduce' });
    await page.goto(`${origin}/still-calm-background`);
    await waitForState('calm');
    await page.waitForTimeout(500);
    expect(await page.locator('canvas').count()).toBe(0);
  });

  it('start visible: no still while the box is far below; it comes with the engine once the box comes near', async () => {
    const release = await holdEngine();
    await page.goto(`${origin}/still-visible`);
    await waitForState('waiting');
    await page.waitForTimeout(800);
    expect(await stills().count()).toBe(0);
    await hero().scrollIntoViewIfNeeded();
    await stillShown();
    release();
    await waitForState('live');
    await expect.poll(() => stills().count(), { timeout: 5000 }).toBe(0);
  });

  it('two rings on a page: the first shows its still and draws, the second stays calm with neither', async () => {
    const release = await holdEngine();
    await page.goto(`${origin}/still-two`);
    await stillShown();
    expect(await state('second')).toBe('calm');
    expect(await stills('second').count()).toBe(0);
    release();
    await waitForState('live');
    // The still leaves once the live layer's fade is over: then the live canvas is the only one.
    await expect.poll(() => page.locator('canvas').count(), { timeout: 5000 }).toBe(1);
  });

  it('where WebGL draws on the processor: no still (it would hold the page), the placeholder instead', async () => {
    await newPage({ software: true });
    const renderer = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    });
    if (!/swiftshader|llvmpipe|softpipe|software|basic render|lavapipe/i.test(renderer)) {
      console.info(`ring still (${name}): this machine draws WebGL on a graphics card (${renderer}); the software case is not checked here`);
      return;
    }
    const release = await holdEngine();
    await page.goto(`${origin}/still-hero`);
    await page.locator('[data-fc-fx-placeholder]').waitFor({ state: 'attached', timeout: 10_000 });
    expect(await stills().count()).toBe(0);
    release();
    await waitForState('live');
  });

  it('a scene that is not one ring gets no still: the loading placeholder is its sign of life', async () => {
    const release = await holdEngine();
    await page.goto(`${origin}/still-noise`);
    await page.locator('[data-fc-fx-placeholder]').waitFor({ state: 'attached', timeout: 10_000 });
    expect(await page.locator('[data-fc-fx-ring-still]').count()).toBe(0);
    release();
    await waitForState('live');
  });

  it('a preference change while the still shows: one still afterwards, drawn again, and nothing left behind', async () => {
    const release = await holdEngine();
    await page.goto(`${origin}/still-hero`);
    await stillShown();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stillShown();
    expect(await stills().count()).toBe(1);
    release();
    await waitForState('live');
    await expect.poll(() => page.locator('[data-fc-fx-ring-still]').count(), { timeout: 5000 }).toBe(0);
    expect(await page.locator('canvas').count()).toBe(1);
  });
});
