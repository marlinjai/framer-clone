// The particle ring's pixel oracle (docs/plans/2026-11-08-lumitra-fx-in-sites.md, addendum "the particle ring
// as a built-in FX layer"): Lumitra's brand light drawn twice, once by the `<lumitra-light>` web component of
// @marlinjai/suite-theme-core as it ships (test/fx-oracle/README.md) and once by this app's published page
// through the particle ring layer, and the two pictures compared pixel by pixel.
//
// THE REFERENCE is the component's file, unchanged, on a blank page. It draws from Math.random and from the
// clock, so it is made repeatable from outside: Math.random is replaced just before the component loads by
// the generator the layer uses (its own source, from particleRingCore), and the clock is stopped:
// performance.now and the time every animation frame is given are both 0, so each frame it draws, whichever
// observer asks for it, is the frame at its starting time (7 seconds). Reduced motion is asked for on both
// sides, as in F4's oracle.
//
// THIS APP'S SIDE is the real thing: a stored page published through the real repository, served by the real
// route of a real production build, drawn by FxIsland.
//
// Each comparison can fail: both sides reproduce themselves exactly from a fresh page, another seed on this
// app's side and one changed colour stop on the reference's side are both far over the tolerance.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type BrowserContext, type BrowserType, type Locator, type Page } from 'playwright';
import { PNG } from 'pngjs';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { PRESETS, mulberry32, serializeScene } from '@/lib/fx/format';
import { FX_ATTR, FX_MARKER, FX_PROP } from '@/lib/fxScene/marker';
import { CHANNEL_TOLERANCE, MAX_DIFFERING_SHARE, colours, difference, type OracleScene as Scene } from '../fx-oracle/oracle';
import { node, type StoredNode } from './pages';
import { publishPages } from './site';

const ARCHIVE = path.resolve('test/fx-oracle/suite-theme-lumitra-light-2105604.js.gz');
const ARCHIVE_SHA256 = '12d21c5b37e747aed787f3d7b5f380a8ca0e02584f87fc097456515dfc78b13b';
const FILE_SHA256 = 'babca5425511d1c8a3eebc240cd24f8ee5f48e68de20307ab7fd9b80f419545b';
const REFERENCE_ORIGIN = 'http://ring-oracle.test';
const SEED = 1;

/** The component's file, checked against both checksums. */
function referenceSource(): string {
  const archive = fs.readFileSync(ARCHIVE);
  const archiveSum = createHash('sha256').update(archive).digest('hex');
  if (archiveSum !== ARCHIVE_SHA256) throw new Error(`${ARCHIVE} is not the archive this oracle was written for (sha256 ${archiveSum})`);
  const file = gunzipSync(archive);
  const fileSum = createHash('sha256').update(file).digest('hex');
  if (fileSum !== FILE_SHA256) throw new Error(`the file inside ${ARCHIVE} is not lumitra-light.js at 2105604 (sha256 ${fileSum})`);
  return file.toString('utf8');
}

/** One colour stop of the component's palette (the mint at 0.3, which colours most of the ring) made red: a different picture, on purpose. */
const CHANGED_STOP = '[0.3, [82, 255, 165]]';
const changedReference = (source: string): string => {
  if (!source.includes(CHANGED_STOP)) throw new Error('the component no longer has the stop this test changes');
  return source.replace(CHANGED_STOP, '[0.3, [255, 0, 0]]');
};

/** Stops the page's clock: performance.now and the time every animation frame is given are 0. */
const STOP_THE_CLOCK = (): void => {
  performance.now = () => 0;
  const request = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => request(() => callback(0));
};

interface Size {
  name: string;
  width: number;
  height: number;
  dpr: number;
}

// The box sizes compared: a wide box (the height decides the radius), the same at the highest pixel ratio a
// scene draws at (the format keeps it at 1.75 at most; the component draws at up to 2, so at 1.75 both draw the
// same number of pixels), and a tall phone box (the width decides the radius).
const SIZES: readonly Size[] = [
  { name: 'wide', width: 960, height: 540, dpr: 1 },
  { name: 'wide at 1.75', width: 960, height: 540, dpr: 1.75 },
  { name: 'tall', width: 390, height: 700, dpr: 1 },
  // 390 x 1.75 is 682.5: both canvases are 682 pixels wide, and the ring's own buffer must be too.
  { name: 'tall at 1.75', width: 390, height: 700, dpr: 1.75 },
];

/** The brand preset as it is stored, with changes on its one layer. */
const ringScene = (change: { seed?: number; withPost?: boolean; glow?: number } = {}): Scene => {
  const scene = serializeScene(PRESETS.find((p) => p.id === 'lumitra-light')!.load()) as unknown as Scene;
  if (change.seed !== undefined) scene.layers[0].params.seed = change.seed;
  if (change.glow !== undefined) scene.layers[0].params.glow = change.glow;
  // A vignette that changes nothing: the ring is drawn into a post pass's linear buffer and must come out the same.
  if (change.withPost) scene.layers.push({ id: 'neutral-vignette', type: 'vignette', name: 'Vignette', visible: true, blend: 'normal', params: { offset: 0, darkness: 0 } });
  return scene;
};

/** A published page that is nothing but one FX box of the given size, drawn at once, held still for reduced motion. */
const fxPage = (scene: Scene, size: Size): StoredNode =>
  node('page-root', 'div', { style: { margin: '0px' } },
    node('hero', 'div', {
      [FX_ATTR]: FX_MARKER,
      [FX_PROP]: { version: 1, scene, start: 'immediate', calm: 'frame' },
      style: { position: 'relative', width: `${size.width}px`, height: `${size.height}px`, background: '#04090b' },
    }));

const slug = (size: Size, variant: string): string => `ring-${size.name.replace(/[^a-z0-9]+/g, '-')}-${variant}`;

/** Whole numbers of glow other than the brand's 1, compared with the component as it is (its `glow` attribute). */
const WHOLE_GLOWS = [0, 2] as const;
/** Glow between whole numbers (the component has no such picture): the light must rise with the value. */
const GLOW_STEPS = [0, 0.01, 0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;
/** The light a quarter of glow may add, as a share of the light of a whole step: no dead zone, no jump. */
const QUARTER_SHARE = { min: 0.08, max: 0.5 } as const;
const glowVariant = (glow: number): string => `glow-${String(glow).replace('.', '-')}`;

const PAGES: Readonly<Record<string, () => StoredNode>> = Object.fromEntries([
  ...SIZES.flatMap((size) => [
    [slug(size, 'brand'), () => fxPage(ringScene(), size)],
    [slug(size, 'seed-2'), () => fxPage(ringScene({ seed: 2 }), size)],
    [slug(size, 'post'), () => fxPage(ringScene({ withPost: true }), size)],
  ]),
  ...GLOW_STEPS.map((glow) => [slug(SIZES[0], glowVariant(glow)), () => fxPage(ringScene({ glow }), SIZES[0])]),
]);

/** A canvas's size in pixels (its backing store, not its box). */
const backingSize = (canvas: Locator): Promise<number[]> => canvas.evaluate((element) => [(element as HTMLCanvasElement).width, (element as HTMLCanvasElement).height]);

/**
 * What a failed comparison says besides the count, since the pictures themselves are not kept: the box around the
 * differing pixels (the whole ring, or a part of it) and each side's summed light (one side dimmer, or only moved).
 */
function whereTheyDiffer(ours: PNG, theirs: PNG): string {
  let left = ours.width, top = ours.height, right = -1, bottom = -1, ourLight = 0, theirLight = 0;
  for (let i = 0; i < ours.data.length; i += 4) {
    let delta = 0;
    for (let c = 0; c < 3; c++) {
      ourLight += ours.data[i + c];
      theirLight += theirs.data[i + c];
      delta = Math.max(delta, Math.abs(ours.data[i + c] - theirs.data[i + c]));
    }
    if (delta <= CHANNEL_TOLERANCE) continue;
    const x = (i / 4) % ours.width;
    const y = Math.floor(i / 4 / ours.width);
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  const box = right < 0 ? 'none' : `x ${left} to ${right}, y ${top} to ${bottom} of ${ours.width}x${ours.height}`;
  return `differing pixels: ${box}; summed light: this app ${ourLight}, the component ${theirLight}`;
}

/**
 * One line per captured picture, in passing runs too: a short hash of its pixels, and the renderer and samples of
 * its canvas. A picture that differs from the other side's can then be held against the same case in a green run,
 * which says which side drew something else. It never fails a case: what cannot be read is said in the line.
 */
async function describeCapture(canvas: Locator, label: string, shot: PNG): Promise<void> {
  const hash = createHash('sha256').update(shot.data).digest('hex').slice(0, 12);
  const drawnBy = await canvas
    .evaluate((element) => {
      const gl = (element as HTMLCanvasElement).getContext('webgl2');
      if (!gl) return 'no webgl2 context to read';
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      return `renderer ${gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)}, samples ${gl.getParameter(gl.SAMPLES)}, antialias ${gl.getContextAttributes()?.antialias}`;
    })
    .catch((error: unknown) => `not read: ${String(error)}`);
  console.info(`ring oracle picture (${label}): ${hash}, ${drawnBy}`);
}

/** The canvas at `selector`, once it has the box's size in device pixels and two screenshots apart are the same. */
async function settled(page: Page, selector: string, size: Size, label: string): Promise<PNG> {
  const canvas = page.locator(selector);
  await canvas.waitFor({ state: 'attached', timeout: 30_000 });
  // A canvas's size in pixels is the box times the ratio rounded down (the browser truncates it; three.js floors it).
  const want = [Math.floor(size.width * size.dpr), Math.floor(size.height * size.dpr)];
  const deadline = Date.now() + 15_000;
  for (;;) {
    const got = await backingSize(canvas);
    if (got[0] === want[0] && got[1] === want[1]) break;
    if (Date.now() > deadline) throw new Error(`the canvas at ${selector} is ${got[0]}x${got[1]}, not ${want[0]}x${want[1]}`);
    await page.waitForTimeout(100);
  }
  let previous = PNG.sync.read(await canvas.screenshot({ scale: 'device' }));
  for (let attempt = 0; attempt < 40; attempt++) {
    await page.waitForTimeout(350);
    const next = PNG.sync.read(await canvas.screenshot({ scale: 'device' }));
    if (difference(previous, next).differing === 0) {
      // A screenshot has the box's size whatever the canvas holds, so a canvas that was resized since the wait
      // above would be compared scaled: say so here, not as a count of differing pixels.
      const now = await backingSize(canvas);
      if (now[0] !== want[0] || now[1] !== want[1]) throw new Error(`the canvas at ${selector} became ${now[0]}x${now[1]} while it was captured, from ${want[0]}x${want[1]}`);
      await describeCapture(canvas, label, next);
      return next;
    }
    previous = next;
  }
  throw new Error(`the canvas at ${selector} never settled`);
}

let origin: string;
let source: string;

beforeAll(async () => {
  source = referenceSource();
  origin = await publishPages(process.env.BEHAVIOUR_PORT!, { pages: PAGES });
}, 180_000);

describe.each([['chromium', chromium], ['webkit', webkit]] as [string, BrowserType][])('in %s', (name, engine) => {
  let browser: Browser;
  const contexts: BrowserContext[] = [];

  const newPage = async (size: Size): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height + 100 }, deviceScaleFactor: size.dpr, reducedMotion: 'reduce' });
    contexts.push(context);
    const page = await context.newPage();
    await page.addInitScript(STOP_THE_CLOCK);
    return page;
  };

  /** The ring as this app's published page draws it. */
  const sites = async (size: Size, variant: string): Promise<PNG> => {
    const page = await newPage(size);
    await page.goto(`${origin}/${slug(size, variant)}`);
    await page.waitForFunction(() => document.querySelector('[data-t="hero"]')?.getAttribute('data-fc-fx-state') === 'live', undefined, { timeout: 30_000 });
    await expect.poll(() => page.locator('[data-fc-fx-layer]').evaluate((layer) => getComputedStyle(layer).opacity), { timeout: 5000 }).toBe('1');
    // The live layer's canvas (the ring's first still sits beside it until the layer's fade is over).
    return settled(page, '[data-t="hero"] [data-fc-fx-layer] canvas', size, `${name}, this app, ${slug(size, variant)}`);
  };

  /** The ring as the component draws it, seeded and with the clock stopped, on a blank page. */
  const reference = async (size: Size, script = source, glow?: number): Promise<PNG> => {
    const page = await newPage(size);
    const problems: string[] = [];
    page.on('pageerror', (error) => problems.push(error.message));
    const html =
      '<!doctype html><meta charset="utf-8"><title>Ring oracle</title>' +
      '<style>html,body{margin:0;background:#000}</style>' +
      // The element has the box's background, as the Sites box has: at a fractional size (682.5 pixels) the last
      // column of the screenshot is half canvas and half what is behind it, on both sides alike.
      `<lumitra-light${glow === undefined ? '' : ` glow="${glow}"`} style="display:block;width:${size.width}px;height:${size.height}px;background:#04090b"></lumitra-light>` +
      // Seeded just before the component loads, so nothing else draws from the generator first.
      // Counted, so a picture that differs can be told from one whose generator something else drew from too.
      `<script>{ const next = (${mulberry32.toString()})(${SEED}); window.ringDraws = 0; Math.random = () => { window.ringDraws += 1; return next(); }; }</script>` +
      '<script type="module" src="/lumitra-light.js"></script>';
    await page.route(`${REFERENCE_ORIGIN}/**`, (route) =>
      new URL(route.request().url()).pathname === '/lumitra-light.js'
        ? route.fulfill({ contentType: 'text/javascript', body: script })
        : route.fulfill({ contentType: 'text/html', body: html }),
    );
    await page.goto(`${REFERENCE_ORIGIN}/`);
    const variant = `${size.name}${glow === undefined ? '' : `, glow ${glow}`}${script === source ? '' : ', a changed stop'}`;
    const shot = await settled(page, 'lumitra-light canvas', size, `${name}, the component, ${variant}`);
    console.info(`ring oracle draws (${name}, the component, ${variant}): ${await page.evaluate(() => (window as unknown as { ringDraws: number }).ringDraws)} from the seeded generator`);
    if (problems.length > 0) throw new Error(`the reference page threw: ${problems.join('; ')}`);
    return shot;
  };

  beforeAll(async () => {
    browser = await engine.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(() => {
    contexts.length = 0;
  });
  afterEach(async () => {
    await Promise.all(contexts.map((context) => context.close()));
  });

  describe.each(SIZES.map((size) => [size.name, size] as const))('%s', (sizeName, size) => {
    it('this app draws the same picture as the component', async () => {
      const ours = await sites(size, 'brand');
      const theirs = await reference(size);
      const result = difference(ours, theirs);
      const pixels = ours.width * ours.height;
      console.info(`ring oracle (${name}, ${sizeName}): ${result.differing} of ${pixels} pixels differ by more than ${CHANNEL_TOLERANCE} (${(result.share * 100).toFixed(4)} percent), largest difference in a channel ${result.largest}`);
      // Not a black or flat frame on either side.
      expect(colours(ours)).toBeGreaterThan(50);
      expect(colours(theirs)).toBeGreaterThan(50);
      // Measured: no pixel differs by more than the channel tolerance, so none may (stricter than F4's share).
      expect(result.differing, whereTheyDiffer(ours, theirs)).toBe(0);
    }, 120_000);

    it('a post pass after the ring leaves it as it is', async () => {
      const ours = await sites(size, 'post');
      const theirs = await reference(size);
      const result = difference(ours, theirs);
      console.info(`ring oracle (${name}, ${sizeName}, with a post pass): ${(result.share * 100).toFixed(4)} percent differ, largest ${result.largest}`);
      expect(result.differing, whereTheyDiffer(ours, theirs)).toBe(0);
    }, 120_000);
  });

  describe.each(WHOLE_GLOWS.map((glow) => [glow] as const))('glow %s, a whole number', (glow) => {
    it('this app draws the same picture as the component with that glow', async () => {
      const size = SIZES[0];
      const app = await sites(size, glowVariant(glow));
      const component = await reference(size, source, glow);
      const result = difference(app, component);
      console.info(`ring oracle (${name}, glow ${glow}): ${result.differing} pixels differ by more than ${CHANNEL_TOLERANCE}, largest difference in a channel ${result.largest}`);
      expect(colours(app)).toBeGreaterThan(50);
      expect(result.differing, whereTheyDiffer(app, component)).toBe(0);
    }, 120_000);
  });

  it('between whole numbers the light rises with the glow, a hundredth at a time, and meets the whole numbers', async () => {
    const size = SIZES[0];
    const light: number[] = [];
    for (const glow of GLOW_STEPS) {
      const shot = await sites(size, glowVariant(glow));
      // FX_GLOW_SHOTS=<folder>: keep each picture, for a person to compare the steps.
      if (process.env.FX_GLOW_SHOTS) fs.writeFileSync(path.join(process.env.FX_GLOW_SHOTS, `${name}-glow-${glow}.png`), PNG.sync.write(shot));
      let sum = 0;
      for (let i = 0; i < shot.data.length; i += 4) sum += shot.data[i] + shot.data[i + 1] + shot.data[i + 2];
      light.push(sum);
    }
    const line = Object.fromEntries(GLOW_STEPS.map((glow, i) => [glow, light[i]]));
    if (process.env.FX_GLOW_OUT) fs.appendFileSync(process.env.FX_GLOW_OUT, `${JSON.stringify({ engine: name, light: line })}\n`);
    // More glow is always more light, already at the first hundredth.
    for (let i = 1; i < light.length; i++) expect(light[i], `glow ${GLOW_STEPS[i]} against ${GLOW_STEPS[i - 1]}: ${JSON.stringify(line)}`).toBeGreaterThan(light[i - 1]);
    // And with no dead zone and no jump: every quarter between two whole numbers adds a fair part of the light of
    // the whole step (measured 2026-11-25 in both engines: 16 to 35 percent from 0 to 1, 18 to 33 percent from 1 to 2; the share
    // falls as more glow points overlap and the 8-bit sum clips, as on the component's canvas).
    const at = (glow: number) => light[GLOW_STEPS.indexOf(glow as (typeof GLOW_STEPS)[number])];
    for (const low of [0, 1]) {
      for (const quarter of [0, 0.25, 0.5, 0.75]) {
        const gained = (at(low + quarter + 0.25) - at(low + quarter)) / (at(low + 1) - at(low));
        expect(gained, `glow ${low + quarter} to ${low + quarter + 0.25}: ${(gained * 100).toFixed(1)} percent of the step`).toBeGreaterThan(QUARTER_SHARE.min);
        expect(gained, `glow ${low + quarter} to ${low + quarter + 0.25}: ${(gained * 100).toFixed(1)} percent of the step`).toBeLessThan(QUARTER_SHARE.max);
      }
    }
  }, 300_000);

  it('each side reproduces itself exactly from a fresh page', async () => {
    const size = SIZES[0];
    expect(difference(await sites(size, 'brand'), await sites(size, 'brand')).differing).toBe(0);
    expect(difference(await reference(size), await reference(size)).differing).toBe(0);
  }, 180_000);

  describe('the comparison can fail', () => {
    it("another seed on this app's side is far over the tolerance", async () => {
      const size = SIZES[0];
      expect(difference(await sites(size, 'seed-2'), await reference(size)).share).toBeGreaterThan(MAX_DIFFERING_SHARE * 10);
    }, 120_000);

    it("one changed colour stop on the reference's side is far over the tolerance", async () => {
      const size = SIZES[0];
      expect(difference(await sites(size, 'brand'), await reference(size, changedReference(source))).share).toBeGreaterThan(MAX_DIFFERING_SHARE * 10);
    }, 120_000);
  });
});
