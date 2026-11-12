// FX scenes where they really run (docs/plans/2026-11-08-lumitra-fx-in-sites.md,
// slice F3): stored pages, saved and published through the real repository, served
// by the real route of a real production build, in real Chromium and WebKit.
//
// The first test is the one everything else rests on: the engine, copied from
// lumitra-web (Next 16, React 19.2), draws a frame under this app's Next and
// React, in both engines, with a real WebGL context. No engine is skipped: a
// browser without WebGL here fails the test.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type BrowserContext, type BrowserContextOptions, type BrowserType, type Page } from 'playwright';
import { PNG } from 'pngjs';
import hubHero from '@/lib/fx/__tests__/fixtures/hub-hero.json';
import { PRESETS, serializeScene } from '@/lib/fx/format';
import { png } from '@/lib/images/__tests__/fixtures';
import { FX_ATTR, FX_MARKER, FX_PROP } from '@/lib/fxScene/marker';
import { node, type StoredNode } from './pages';
import { publishPages, publishPagesWithImages } from './site';

/** A preset as it is stored: the values `serializeScene` writes. */
const preset = (id: string) => serializeScene(PRESETS.find((p) => p.id === id)!.load());
const godraysHero = preset('godrays-hero');
const bokehFocuspull = preset('bokeh-focuspull');

const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];

/** The box's own CSS background: a blue no frame of the hub hero (gold on black) contains. */
const BLUE = { r: 20, g: 60, b: 200 };
const RED = { r: 255, g: 0, b: 0 };
const BOX_STYLE = { position: 'relative', minHeight: '400px', background: `rgb(${BLUE.r}, ${BLUE.g}, ${BLUE.b})` };

/** The content of a box: a heading and a plain red block, neither positioned, so only the layer's own stacking keeps them on top. */
const content = (id: string): StoredNode[] => [
  node(`${id}-title`, 'h1', { children: 'Over the scene', style: { color: 'rgb(255, 255, 255)', margin: '0px' } }),
  node(`${id}-block`, 'div', { style: { width: '120px', height: '120px', background: `rgb(${RED.r}, ${RED.g}, ${RED.b})` } }),
];

/** An FX scene box showing the lumitra.co hub hero. */
const fxBox = (id: string, fx: Record<string, unknown> = {}, style: Record<string, unknown> = BOX_STYLE): StoredNode =>
  node(id, 'div', { [FX_ATTR]: FX_MARKER, [FX_PROP]: { version: 1, scene: hubHero, start: 'immediate', calm: 'background', ...fx }, style }, ...content(id));

/** The same box without a scene: what every FX box falls back to. */
const plainBox = (id: string): StoredNode => node(id, 'div', { style: BOX_STYLE }, ...content(id));

const spacer = (id: string): StoredNode => node(id, 'div', { style: { height: '3000px' } });

/**
 * The moving full-screen layers at the top of their ranges, in black and white: a
 * gradient at full speed with the hardest edges under a distortion at full speed
 * and strength (see FASTEST for its kinds and densities). If any stored scene
 * could flash, one of these would. Two layers are left out on purpose, because each lowers the contrast
 * being tested: the noise field only drifts, and grain is a different random
 * pattern on every frame whose mean over any area stays the same (measured at
 * full opacity: every sixty-fourth of the box stayed within 0.11 of mid grey).
 */
/** The top of the distortion's speed range (src/lib/fx/schemas.ts); a stored value above it is clamped to it. */
const DISTORTION_TOP_SPEED = 3;

const fastestScene = (distortion: 'noise' | 'ripple' | 'texture', scale: number) => ({
  version: 1,
  id: 'fastest',
  size: { mode: 'fill' },
  background: '#000000',
  fps: 60,
  dpr: [1, 1],
  layers: [
    { id: 'gradient', type: 'gradient', name: 'Gradient', visible: true, blend: 'normal', params: { colorA: '#ffffff', colorB: '#000000', colorC: '#ffffff', colorD: '#000000', speed: 4, scale: 2.5, falloff: 6, opacity: 1 } },
    { id: 'distortion', type: 'distortion', name: 'Distortion', visible: true, blend: 'normal', params: { type: distortion, strength: 0.2, scale, speed: DISTORTION_TOP_SPEED, mouseInfluence: 0 } },
  ],
});

/**
 * The distortion in each of its three kinds, at both ends of its density: at the
 * coarsest (0.1) one wave spans the whole box, so the largest area moves as one,
 * which is where a flash would be; at the finest (20) the waves are small.
 */
const FASTEST: ReadonlyArray<[slug: string, kind: 'noise' | 'ripple' | 'texture', scale: number]> = [
  ['fx-fast-ripple-coarse', 'ripple', 0.1],
  ['fx-fast-ripple-mid', 'ripple', 1],
  ['fx-fast-ripple-fine', 'ripple', 20],
  ['fx-fast-noise-coarse', 'noise', 0.1],
  ['fx-fast-noise-mid', 'noise', 1],
  ['fx-fast-texture-coarse', 'texture', 0.1],
  ['fx-fast-texture-mid', 'texture', 1],
];

/**
 * Flashes in a series of relative luminance readings (0 to 1), as WCAG 2.3.1
 * counts them: a flash is a pair of opposing changes of at least 10 percent of
 * the maximum, where the darker reading is below 0.80. Returns the most flashes
 * found in any window of `windowFrames` readings.
 */
function mostFlashesPerWindow(series: readonly number[], windowFrames: number): number {
  const changes: number[] = [];
  let extreme = series[0];
  let direction = 0;
  for (let i = 1; i < series.length; i++) {
    const value = series[i];
    const delta = value - extreme;
    if (direction >= 0 && delta <= -0.1 && Math.min(value, extreme) < 0.8) {
      changes.push(i);
      direction = -1;
      extreme = value;
    } else if (direction <= 0 && delta >= 0.1 && Math.min(value, extreme) < 0.8) {
      changes.push(i);
      direction = 1;
      extreme = value;
    } else if ((direction >= 0 && value > extreme) || (direction <= 0 && value < extreme)) {
      extreme = value;
    }
  }
  let most = 0;
  for (let start = 0; start < changes.length; start++) {
    let count = 0;
    for (let i = start; i < changes.length && changes[i] - changes[start] < windowFrames; i++) count += 1;
    most = Math.max(most, Math.floor(count / 2));
  }
  return most;
}

const FX_PAGES: Readonly<Record<string, () => StoredNode>> = {
  'fx-immediate': () => fxBox('hero'),
  'fx-none': () => plainBox('hero'),
  'fx-settled': () => fxBox('hero', { start: 'settled' }),
  'fx-visible': () => node('wrap', 'div', {}, spacer('gap'), fxBox('hero', { start: 'visible' })),
  'fx-frame': () => fxBox('hero', { calm: 'frame' }),
  'fx-two': () => node('wrap', 'div', {}, fxBox('hero'), fxBox('second', { calm: 'frame' })),
  'fx-refused': () => fxBox('hero', { version: 9 }),
  // The fastest, highest-contrast scenes the format lets anyone store (see "flash safety" below).
  ...Object.fromEntries(FASTEST.map(([slug, kind, scale]) => [slug, () => fxBox('hero', { scene: fastestScene(kind, scale) })])),
  // A scene whose headline follows the pointer, with motion allowed.
  'fx-godrays': () => fxBox('hero', { scene: godraysHero }),
  // Scenes with an intro (a text reveal, a focus pull), held still for reduced motion.
  'fx-frame-godrays': () => fxBox('hero', { scene: godraysHero, calm: 'frame' }),
  'fx-frame-bokeh': () => fxBox('hero', { scene: bokehFocuspull, calm: 'frame' }),
  // No `position` on the box: the layer must still be contained by it.
  'fx-static': () => fxBox('hero', {}, { minHeight: '400px', background: BOX_STYLE.background }),
};

/**
 * What one FX scene may add to a page over the network, in bytes as sent
 * (compressed): the engine with three.js, react-three-fiber and postprocessing,
 * and the scene reader. Set from the first measurement plus 5 percent and held:
 * growth past it fails here and is a decision, not a drift.
 *
 * First measurement (2026-11-11, Next 15.5.28): 353,024 bytes in 7 scripts, of
 * which three.js itself is about 189,000 (it is imported whole, `import * as
 * THREE`, as the engine was written), the react-three packages with their own
 * reconciler about 113,000, postprocessing about 22,000, and the engine with the
 * scene reader about 29,000. The plan expected about 230,000.
 */
const FX_BUDGET_BYTES = 371_000;

/** Only in the engine's chunks: three.js's renderer class name survives minification as a string. */
const ENGINE_MARK = 'WebGLRenderer';

/** A scene that is one picture: an image layer at full opacity, filling the box. */
const pictureScene = (src: string) => ({
  version: 1,
  id: 'picture',
  size: { mode: 'fill' },
  background: '#000000',
  fps: 60,
  dpr: [1, 1],
  layers: [{ id: 'picture', type: 'image', name: 'Picture', visible: true, blend: 'normal', params: { src, fit: 'cover', opacity: 1, displace: 0, scale: 1 } }],
});

/** The uploaded picture: one flat green no other page here shows. */
const GREEN = { r: 30, g: 200, b: 90 };

let origin: string;
/** A second site, which stores an uploaded picture its FX scenes show. */
let pictureOrigin: string;
let picturePath: string;

beforeAll(async () => {
  origin = await publishPages(process.env.BEHAVIOUR_PORT!, { pages: FX_PAGES });
  pictureOrigin = await publishPagesWithImages(process.env.BEHAVIOUR_PORT!, { green: png(640, 360, [GREEN.r, GREEN.g, GREEN.b]) }, (paths) => {
    picturePath = paths.green;
    return {
      'fx-picture': () => fxBox('hero', { scene: pictureScene(paths.green) }),
      'fx-picture-frame': () => fxBox('hero', { scene: pictureScene(paths.green), calm: 'frame' }),
      // The same picture under a post pass that moves nothing, so the scene is drawn through the composer:
      // with and without a post pass a scene must come out in the same colours.
      'fx-picture-post': () => fxBox('hero', { scene: { ...pictureScene(paths.green), layers: [...pictureScene(paths.green).layers, { id: 'pass', type: 'chromaticAberration', name: 'Pass', visible: true, blend: 'normal', params: { offset: [0, 0] } }] } }),
    };
  });
});

const sameColour = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }, tolerance = 6): boolean =>
  Math.abs(a.r - b.r) <= tolerance && Math.abs(a.g - b.g) <= tolerance && Math.abs(a.b - b.b) <= tolerance;

describe.each(ENGINES)('in %s', (name, engine) => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let problems: string[];
  let warnings: string[];
  /** Every script the page fetched, with whether it holds the engine. */
  let scripts: Promise<{ url: string; engine: boolean }>[];

  const box = (id = 'hero') => page.locator(`[data-t="${id}"]`).first();
  const state = (id = 'hero') => box(id).getAttribute('data-fc-fx-state');
  const waitForState = (wanted: string, id = 'hero') =>
    page.waitForFunction(([target, value]) => document.querySelector(`[data-t="${target}"]`)?.getAttribute('data-fc-fx-state') === value, [id, wanted] as const, {
      timeout: 30_000,
    });
  const fxWarnings = () => warnings.filter((text) => text.includes('FX scene'));
  const engineScripts = async (): Promise<string[]> => (await Promise.all(scripts)).filter((script) => script.engine).map((script) => script.url);
  const canvases = () => page.locator('canvas').count();

  /** The colour of one pixel of the page, read from a real screenshot. */
  const pixel = async (x: number, y: number): Promise<{ r: number; g: number; b: number }> => {
    const png = PNG.sync.read(await page.screenshot({ clip: { x, y, width: 1, height: 1 } }));
    return { r: png.data[0], g: png.data[1], b: png.data[2] };
  };
  /** A point of the box that no content covers: right of the heading and the block. */
  const openPoint = async (id = 'hero') => {
    const rect = (await box(id).boundingBox())!;
    return { x: Math.round(rect.x + rect.width - 60), y: Math.round(rect.y + 300) };
  };
  const blockCentre = async (id = 'hero') => {
    const rect = (await box(`${id}-block`).boundingBox())!;
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  };

  const newPage = async (options: BrowserContextOptions = {}): Promise<void> => {
    await context?.close();
    context = await browser.newContext({ viewport: { width: 1000, height: 700 }, ...options });
    page = await context.newPage();
    problems = [];
    warnings = [];
    scripts = [];
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
      if (message.type() === 'warning') warnings.push(message.text());
    });
    page.on('pageerror', (error) => problems.push(error.message));
    page.on('response', (response) => {
      const url = response.url();
      if (!url.includes('/_next/static/') || !url.split('?')[0].endsWith('.js')) return;
      scripts.push(response.text().then((text) => ({ url, engine: text.includes(ENGINE_MARK) }), () => ({ url, engine: false })));
    });
  };

  beforeAll(async () => {
    browser = await engine.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    await newPage();
  });
  afterEach(async () => {
    await context?.close();
  });

  it('draws the lumitra.co hub hero: a real WebGL context, a first frame, the layer behind the content', async () => {
    await page.goto(`${origin}/fx-immediate`);
    await waitForState('live');

    const drawn = await box().evaluate((element) => {
      const layer = element.firstElementChild as HTMLElement;
      const canvas = layer.querySelector('canvas');
      const gl = canvas ? ((canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null) : null;
      return {
        layerIsFirstChild: layer.hasAttribute('data-fc-fx-layer'),
        ariaHidden: layer.getAttribute('aria-hidden'),
        pointerEvents: getComputedStyle(layer).pointerEvents,
        canvases: element.querySelectorAll('canvas').length,
        hasContext: gl !== null,
        contextLost: gl ? gl.isContextLost() : null,
        width: canvas?.width ?? 0,
        height: canvas?.height ?? 0,
        title: element.querySelector('h1')?.textContent,
      };
    });
    expect(drawn).toMatchObject({
      layerIsFirstChild: true,
      ariaHidden: 'true',
      pointerEvents: 'none',
      canvases: 1,
      hasContext: true,
      contextLost: false,
      title: 'Over the scene',
    });
    expect(drawn.width).toBeGreaterThan(0);
    expect(drawn.height).toBeGreaterThan(0);
    expect(await engineScripts()).not.toEqual([]);
    expect(problems).toEqual([]);
    expect(fxWarnings()).toEqual([]);
  });

  it('paints the scene over the box background and under the content, and takes no click', async () => {
    await page.goto(`${origin}/fx-immediate`);
    await waitForState('live');
    // The fade has ended.
    await expect.poll(() => box().evaluate((element) => getComputedStyle(element.firstElementChild as Element).opacity), { timeout: 5000 }).toBe('1');

    const open = await openPoint();
    expect(sameColour(await pixel(open.x, open.y), BLUE), 'the scene, not the box background, shows where nothing covers it').toBe(false);
    const block = await blockCentre();
    expect(sameColour(await pixel(block.x, block.y), RED), 'content that is not positioned stays above the scene').toBe(true);

    // A click where only the scene is lands on the box itself.
    const hit = await page.evaluate(({ x, y }) => (document.elementFromPoint(x, y) as HTMLElement | null)?.getAttribute('data-t'), open);
    expect(hit).toBe('hero');
  });

  it('contains the layer in a box the author left without a position', async () => {
    await page.goto(`${origin}/fx-static`);
    await waitForState('live');
    const rects = await box().evaluate((element) => {
      const layer = element.firstElementChild as HTMLElement;
      const a = element.getBoundingClientRect();
      const b = layer.getBoundingClientRect();
      return { box: [a.x, a.y, a.width, a.height], layer: [b.x, b.y, b.width, b.height] };
    });
    expect(rects.layer).toEqual(rects.box);
    const block = await blockCentre();
    expect(sameColour(await pixel(block.x, block.y), RED)).toBe(true);
  });

  it('fetches no byte of the engine on a page without a scene', async () => {
    await page.goto(`${origin}/fx-none`, { waitUntil: 'networkidle' });
    expect((await Promise.all(scripts)).length).toBeGreaterThan(0);
    expect(await engineScripts()).toEqual([]);
    expect(await page.locator('[data-fc-fx]').count()).toBe(0);
    expect(await canvases()).toBe(0);
    const open = await openPoint();
    expect(sameColour(await pixel(open.x, open.y), BLUE)).toBe(true);
  });

  it('draws a box whose scene is refused as the plain box, with no island and no engine', async () => {
    await page.goto(`${origin}/fx-refused`, { waitUntil: 'networkidle' });
    expect(await page.locator('[data-fx="scene"]').count()).toBe(1);
    expect(await page.locator('[data-fc-fx]').count()).toBe(0);
    expect(await state()).toBeNull();
    expect(await engineScripts()).toEqual([]);
    expect(await canvases()).toBe(0);
    expect(fxWarnings()).toEqual([]);
  });

  it('without WebGL: fetches nothing, keeps the box as the server sent it, warns once', async () => {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
        if (kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl') return null;
        return (original as (...args: unknown[]) => unknown).call(this, kind, ...rest);
      } as typeof HTMLCanvasElement.prototype.getContext;
    });
    await page.goto(`${origin}/fx-immediate`, { waitUntil: 'networkidle' });
    await waitForState('off');
    expect(await engineScripts()).toEqual([]);
    expect(await canvases()).toBe(0);
    expect(await box().locator('[data-fc-fx-layer]').count()).toBe(0);
    const open = await openPoint();
    expect(sameColour(await pixel(open.x, open.y), BLUE)).toBe(true);
    expect(await box('hero-title').textContent()).toBe('Over the scene');
    expect(fxWarnings()).toHaveLength(1);
    expect(problems).toEqual([]);
  });

  it('under reduced motion with the background as the calm state: fetches nothing and draws nothing', async () => {
    await newPage({ reducedMotion: 'reduce' });
    await page.goto(`${origin}/fx-immediate`, { waitUntil: 'networkidle' });
    await waitForState('calm');
    expect(await engineScripts()).toEqual([]);
    expect(await canvases()).toBe(0);
    const open = await openPoint();
    expect(sameColour(await pixel(open.x, open.y), BLUE)).toBe(true);
    expect(fxWarnings()).toEqual([]);
  });

  it('under reduced motion with a frame as the calm state: draws one frame that does not move', async () => {
    await newPage({ reducedMotion: 'reduce' });
    await page.goto(`${origin}/fx-frame`);
    await waitForState('live');
    await expect.poll(() => box().evaluate((element) => getComputedStyle(element.firstElementChild as Element).opacity), { timeout: 5000 }).toBe('1');
    const shot = async () => PNG.sync.read(await box().screenshot()).data;
    const first = await shot();
    await page.waitForTimeout(700);
    const second = await shot();
    let differing = 0;
    for (let i = 0; i < first.length; i += 4) {
      if (Math.abs(first[i] - second[i]) > 2 || Math.abs(first[i + 1] - second[i + 1]) > 2 || Math.abs(first[i + 2] - second[i + 2]) > 2) differing += 1;
    }
    expect(differing / (first.length / 4)).toBeLessThan(0.001);
    // And it is the scene, not the background.
    const open = await openPoint();
    expect(sameColour(await pixel(open.x, open.y), BLUE)).toBe(false);
  });

  it.each(['fx-frame-godrays', 'fx-frame-bokeh'])('under reduced motion, a scene with an intro is held at its end: the headline shows and nothing moves (/%s)', async (slug) => {
    await newPage({ reducedMotion: 'reduce' });
    await page.goto(`${origin}/${slug}`);
    await waitForState('live');
    await expect.poll(() => box().evaluate((element) => getComputedStyle(element.firstElementChild as Element).opacity), { timeout: 5000 }).toBe('1');
    // The layer alone: the box's own heading and block are hidden, so what is bright is the scene's text.
    await page.addStyleTag({ content: '[data-t="hero-title"],[data-t="hero-block"]{visibility:hidden}' });
    const shot = async () => PNG.sync.read(await box().screenshot());
    // Post passes that read a content layer join one frame after it (the composer waits for the
    // layer's object), so the picture settles a moment after the first frame.
    await page.waitForTimeout(1500);
    const first = await shot();
    await page.waitForTimeout(900);
    const second = await shot();
    let differing = 0;
    let bright = 0;
    for (let i = 0; i < first.data.length; i += 4) {
      if (Math.abs(first.data[i] - second.data[i]) > 2 || Math.abs(first.data[i + 1] - second.data[i + 1]) > 2 || Math.abs(first.data[i + 2] - second.data[i + 2]) > 2) differing += 1;
      if (first.data[i] > 170 && first.data[i + 1] > 170 && first.data[i + 2] > 170) bright += 1;
    }
    const pixels = first.data.length / 4;
    expect(differing / pixels).toBeLessThan(0.001);
    // The lockup's light text is drawn in full (a reveal stopped half way would leave it dim or absent).
    expect(bright / pixels).toBeGreaterThan(0.004);
  });

  it.each(['fx-frame', 'fx-frame-godrays', 'fx-frame-bokeh'])('under reduced motion, draws no frame at all once the scene has settled (/%s)', async (slug) => {
    await newPage({ reducedMotion: 'reduce' });
    // Every frame the engine draws starts by clearing a buffer: counting those calls counts frames.
    await page.addInitScript(() => {
      const counter = window as unknown as { __fxClears: number };
      counter.__fxClears = 0;
      for (const proto of [WebGL2RenderingContext.prototype, WebGLRenderingContext.prototype]) {
        const clear = proto.clear;
        proto.clear = function (this: WebGLRenderingContext, mask: number) {
          counter.__fxClears += 1;
          return clear.call(this, mask);
        };
      }
    });
    await page.goto(`${origin}/${slug}`);
    await waitForState('live');
    const clears = () => page.evaluate(() => (window as unknown as { __fxClears: number }).__fxClears);
    await page.waitForTimeout(1500);
    const settled = await clears();
    expect(settled).toBeGreaterThan(0);
    await page.waitForTimeout(1500);
    expect(await clears()).toBe(settled);
  });

  it('follows the pointer although the canvas takes no pointer: the headline shifts with the mouse', async () => {
    await page.goto(`${origin}/fx-godrays`);
    await waitForState('live');
    // The layer alone: the box's own heading and block are hidden, so what is bright is the scene's headline.
    await page.addStyleTag({ content: '[data-t="hero-title"],[data-t="hero-block"]{visibility:hidden}' });
    const rect = (await box().boundingBox())!;
    /** The horizontal centre of the bright pixels of the box, in pixels from its left edge. */
    const headlineCentre = async (): Promise<number> => {
      const shot = PNG.sync.read(await box().screenshot());
      let sum = 0;
      let count = 0;
      for (let y = 0; y < shot.height; y++) {
        for (let x = 0; x < shot.width; x++) {
          const at = (y * shot.width + x) * 4;
          if (shot.data[at] > 190 && shot.data[at + 1] > 190 && shot.data[at + 2] > 190) {
            sum += x;
            count += 1;
          }
        }
      }
      expect(count, 'the headline is drawn').toBeGreaterThan(200);
      return sum / count;
    };
    // The reveal has ended and the headline has eased to where the pointer puts it.
    await page.mouse.move(rect.x + 5, rect.y + rect.height / 2);
    await page.waitForTimeout(4500);
    const atLeft = await headlineCentre();
    await page.mouse.move(rect.x + rect.width - 5, rect.y + rect.height / 2);
    await page.waitForTimeout(3500);
    const atRight = await headlineCentre();
    expect(atRight - atLeft).toBeGreaterThan(8);
    // And the box still gets the click.
    const hit = await page.evaluate(({ x, y }) => (document.elementFromPoint(x, y) as HTMLElement | null)?.getAttribute('data-t'), { x: rect.x + rect.width - 60, y: rect.y + 300 });
    expect(hit).toBe('hero');
  });

  describe('an image layer', () => {
    const imageRequests = () => {
      const seen: { url: string; status: number }[] = [];
      page.on('response', (response) => {
        if (new URL(response.url()).pathname.startsWith('/site-images/')) seen.push({ url: response.url(), status: response.status() });
      });
      return seen;
    };

    it.each(['fx-picture', 'fx-picture-post'])("draws a picture uploaded to the site in its own colours, fetched from the site's own image route (/%s)", async (slug) => {
      const requests = imageRequests();
      await page.goto(`${pictureOrigin}/${slug}`);
      await waitForState('live');
      await expect.poll(() => box().evaluate((element) => getComputedStyle(element.firstElementChild as Element).opacity), { timeout: 5000 }).toBe('1');
      const open = await openPoint();
      await expect.poll(async () => sameColour(await pixel(open.x, open.y), GREEN, 12), { timeout: 10_000 }).toBe(true);
      expect(picturePath).toMatch(/^\/site-images\/[0-9a-f]{64}\.png$/);
      expect(requests).toEqual([{ url: `${pictureOrigin}${picturePath}`, status: 200 }]);
      expect(fxWarnings()).toEqual([]);
      expect(problems).toEqual([]);
    });

    it('draws it under reduced motion too: the picture arrives after the first frame and still gets drawn', async () => {
      await newPage({ reducedMotion: 'reduce' });
      const requests = imageRequests();
      await page.goto(`${pictureOrigin}/fx-picture-frame`);
      await waitForState('live');
      const open = await openPoint();
      await expect.poll(async () => sameColour(await pixel(open.x, open.y), GREEN, 12), { timeout: 10_000 }).toBe(true);
      expect(requests).toHaveLength(1);
    });
  });

  describe('when the reduced motion preference changes on an open page', () => {
    it('a scene whose calm state is the background stops drawing, and draws again when motion is allowed again', async () => {
      await page.goto(`${origin}/fx-immediate`);
      await waitForState('live');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await waitForState('calm');
      expect(await canvases()).toBe(0);
      expect(await box().evaluate((element) => (element as HTMLElement).style.isolation)).toBe('');
      const open = await openPoint();
      expect(sameColour(await pixel(open.x, open.y), BLUE)).toBe(true);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await waitForState('live');
      expect(await canvases()).toBe(1);
      expect(fxWarnings()).toEqual([]);
    });

    it('a scene whose calm state is a frame keeps one canvas and holds still', async () => {
      await page.addInitScript(() => {
        const counter = window as unknown as { __fxClears: number };
        counter.__fxClears = 0;
        for (const proto of [WebGL2RenderingContext.prototype, WebGLRenderingContext.prototype]) {
          const clear = proto.clear;
          proto.clear = function (this: WebGLRenderingContext, mask: number) {
            counter.__fxClears += 1;
            return clear.call(this, mask);
          };
        }
      });
      await page.goto(`${origin}/fx-frame`);
      await waitForState('live');
      const clears = () => page.evaluate(() => (window as unknown as { __fxClears: number }).__fxClears);
      // With motion allowed the scene draws every frame.
      const moving = await clears();
      await page.waitForTimeout(500);
      expect(await clears()).toBeGreaterThan(moving);

      // The scene is mounted afresh for the new preference: wait for a canvas that is not the old one.
      await box().evaluate((element) => element.querySelector('canvas')!.setAttribute('data-old', ''));
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.waitForFunction(() => {
        const hero = document.querySelector('[data-t="hero"]');
        return hero?.getAttribute('data-fc-fx-state') === 'live' && hero.querySelector('canvas:not([data-old])') !== null;
      });
      expect(await canvases()).toBe(1);
      await page.waitForTimeout(1500);
      const settled = await clears();
      await page.waitForTimeout(1500);
      expect(await clears()).toBe(settled);
    });
  });

  it('when the engine chunk does not arrive: keeps the box, warns once, throws nothing', async () => {
    // Which chunks hold the engine is the build's business: learn it from a page that loads them.
    await page.goto(`${origin}/fx-immediate`);
    await waitForState('live');
    const engineUrls = new Set(await engineScripts());
    expect(engineUrls.size).toBeGreaterThan(0);

    await newPage();
    await page.route('**/_next/static/**', (route) => (engineUrls.has(route.request().url()) ? route.abort() : route.continue()));
    await page.goto(`${origin}/fx-immediate`);
    await waitForState('off');
    expect(await canvases()).toBe(0);
    const open = await openPoint();
    expect(sameColour(await pixel(open.x, open.y), BLUE)).toBe(true);
    expect(await box('hero-title').textContent()).toBe('Over the scene');
    expect(fxWarnings()).toHaveLength(1);
    expect(fxWarnings()[0]).toContain('did not load');
    // The refused request is the browser's own console line; the page itself threw nothing.
    expect(problems.filter((text) => !/Failed to load resource|net::ERR_FAILED|access control checks|due to access control/i.test(text))).toEqual([]);
  });

  it('when the WebGL context is lost: takes the layer out and gives the box back as it was', async () => {
    await page.goto(`${origin}/fx-immediate`);
    await waitForState('live');
    const before = await box().evaluate((element) => ({ isolation: (element as HTMLElement).style.isolation }));
    expect(before.isolation).toBe('isolate');
    await box().evaluate((element) => {
      const canvas = element.querySelector('canvas')!;
      const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext;
      gl.getExtension('WEBGL_lose_context')!.loseContext();
    });
    await waitForState('off');
    expect(await canvases()).toBe(0);
    expect(await box().locator('[data-fc-fx-layer]').count()).toBe(0);
    expect(await box().evaluate((element) => (element as HTMLElement).style.isolation)).toBe('');
    const open = await openPoint();
    expect(sameColour(await pixel(open.x, open.y), BLUE)).toBe(true);
    expect(fxWarnings()).toHaveLength(1);
    expect(fxWarnings()[0]).toContain('context-lost');
  });

  it('keeps to one WebGL context on a page with two scenes: the first draws, the second stays calm', async () => {
    await page.goto(`${origin}/fx-two`);
    await waitForState('live');
    expect(await state('second')).toBe('calm');
    expect(await canvases()).toBe(1);
    expect(await box('second').locator('canvas').count()).toBe(0);
    await box('second').scrollIntoViewIfNeeded();
    const open = await openPoint('second');
    expect(sameColour(await pixel(open.x, open.y), BLUE)).toBe(true);
    expect(fxWarnings()).toEqual([]);
  });

  it('start settled: waits for the page to load and 1.5 seconds more before it fetches the engine', async () => {
    await page.goto(`${origin}/fx-settled`, { waitUntil: 'load' });
    // The island writes its state when the page is hydrated, which can come after the
    // `load` event (the island arms its timer then): wait for the state, never read it once.
    await waitForState('waiting');
    expect(await engineScripts()).toEqual([]);
    await waitForState('live');
    const timing = await page.evaluate((mark) => {
      const load = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).loadEventStart;
      const chunks = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter((entry) => entry.name.includes('/_next/static/') && entry.startTime > load);
      return { load, firstAfterLoad: Math.min(...chunks.map((entry) => entry.startTime)), mark };
    }, ENGINE_MARK);
    expect(timing.firstAfterLoad - timing.load).toBeGreaterThanOrEqual(1450);
    expect(await engineScripts()).not.toEqual([]);
  });

  it('start visible: fetches nothing while the box is far below, and draws once it comes near', async () => {
    await page.goto(`${origin}/fx-visible`, { waitUntil: 'networkidle' });
    await waitForState('waiting');
    await page.waitForTimeout(500);
    expect(await engineScripts()).toEqual([]);
    expect(await canvases()).toBe(0);
    await box().scrollIntoViewIfNeeded();
    await waitForState('live');
    expect(await canvases()).toBe(1);
  });

  it('gives up its context when the page is put away, and starts again when it is shown again', async () => {
    await page.goto(`${origin}/fx-immediate`);
    await waitForState('live');
    // The back/forward cache cannot be driven from a test, so its two events are sent as the browser sends them.
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await expect.poll(canvases).toBe(0);
    expect(await state()).toBeNull();
    expect(await box().evaluate((element) => (element as HTMLElement).style.isolation)).toBe('');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await waitForState('live');
    expect(await canvases()).toBe(1);
    expect(fxWarnings()).toEqual([]);
  });

  it('leaves no canvas and no context behind when the scene is cancelled before it started', async () => {
    await page.goto(`${origin}/fx-settled`, { waitUntil: 'load' });
    await waitForState('waiting');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await page.waitForTimeout(2200);
    expect(await canvases()).toBe(0);
    expect(await engineScripts()).toEqual([]);
    expect(await state()).toBeNull();
  });

  it('without JavaScript: the box, its background and its content, as the server sent them', async () => {
    await newPage({ javaScriptEnabled: false });
    await page.goto(`${origin}/fx-immediate`);
    expect(await box('hero-title').textContent()).toBe('Over the scene');
    const open = await openPoint();
    expect(sameColour(await pixel(open.x, open.y), BLUE)).toBe(true);
    const block = await blockCentre();
    expect(sameColour(await pixel(block.x, block.y), RED)).toBe(true);
  });

  describe('flash safety', () => {
    it('counts flashes the way the test below relies on', () => {
      const wave = (hertz: number) => Array.from({ length: 240 }, (_, frame) => (Math.sin((frame / 60) * hertz * 2 * Math.PI) > 0 ? 0.9 : 0.1));
      expect(mostFlashesPerWindow(wave(5), 60)).toBeGreaterThan(3);
      expect(mostFlashesPerWindow(wave(2), 60)).toBeLessThanOrEqual(3);
      expect(mostFlashesPerWindow(Array.from({ length: 240 }, () => 0.5), 60)).toBe(0);
      // A change of less than 10 percent, or between two bright readings, is no flash.
      expect(mostFlashesPerWindow(Array.from({ length: 240 }, (_, frame) => (frame % 2 ? 0.5 : 0.55)), 60)).toBe(0);
      expect(mostFlashesPerWindow(Array.from({ length: 240 }, (_, frame) => (frame % 2 ? 0.85 : 1)), 60)).toBe(0);
    });

    it.each(FASTEST)('the fastest scene the format accepts stays under three flashes a second, anywhere on the box (/%s)', async (slug) => {
      // The engine's clock is made to advance exactly one sixtieth of a second per drawn frame, so
      // every frame the engine draws is read, at the speed a visitor would see it. Reading on real
      // time would miss frames wherever drawing is slow (software rendering), and with them a flash.
      await page.addInitScript(() => {
        let frame = 0;
        const realRaf = window.requestAnimationFrame.bind(window);
        performance.now = () => frame * (1000 / 60);
        window.requestAnimationFrame = (callback: FrameRequestCallback) => realRaf(() => callback(performance.now()));
        const tick = () => {
          realRaf(() => {
            frame += 1;
            tick();
          });
        };
        tick();
      });
      await page.goto(`${origin}/${slug}`);
      await waitForState('live');

      const GRID = 8;
      const FRAMES = 240;
      const readings = await box().evaluate(
        (element, { grid, frames }) =>
          new Promise<number[][]>((resolve) => {
            const canvas = element.querySelector('canvas')!;
            const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGL2RenderingContext;
            const width = gl.drawingBufferWidth;
            const height = gl.drawingBufferHeight;
            const pixels = new Uint8Array(width * height * 4);
            const linear = (channel: number) => Math.pow(channel / 255, 2.2);
            const series: number[][] = Array.from({ length: grid * grid }, () => []);
            let seen = 0;
            const read = () => {
              // Registered after the engine's own frame callback, so it runs after this frame was
              // drawn and before the browser presents it: the drawing buffer still holds the frame.
              const bound = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
              gl.bindFramebuffer(gl.FRAMEBUFFER, null);
              gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
              gl.bindFramebuffer(gl.FRAMEBUFFER, bound);
              const sums = new Float64Array(grid * grid);
              const counts = new Uint32Array(grid * grid);
              // Every fourth pixel in both directions is plenty for a mean.
              for (let y = 0; y < height; y += 4) {
                const row = Math.min(grid - 1, Math.floor((y / height) * grid));
                for (let x = 0; x < width; x += 4) {
                  const cell = row * grid + Math.min(grid - 1, Math.floor((x / width) * grid));
                  const at = (y * width + x) * 4;
                  sums[cell] += 0.2126 * linear(pixels[at]) + 0.7152 * linear(pixels[at + 1]) + 0.0722 * linear(pixels[at + 2]);
                  counts[cell] += 1;
                }
              }
              for (let cell = 0; cell < series.length; cell++) series[cell].push(sums[cell] / counts[cell]);
              seen += 1;
              if (seen >= frames) resolve(series);
              else requestAnimationFrame(read);
            };
            requestAnimationFrame(read);
          }),
        { grid: GRID, frames: FRAMES },
      );

      expect(readings).toHaveLength(GRID * GRID);
      for (const series of readings) expect(series).toHaveLength(FRAMES);
      const all = readings.flat();
      const range = Math.max(...all) - Math.min(...all);
      const swings = readings.map((series) => Math.max(...series) - Math.min(...series));
      const moving = swings.filter((swing) => swing > 0.02).length;
      const worst = Math.max(...readings.map((series) => mostFlashesPerWindow(series, 60)));
      const wholeBox = Array.from({ length: FRAMES }, (_, frame) => readings.reduce((sum, series) => sum + series[frame], 0) / readings.length);
      console.info(
        `fx flash safety (${name}, /${slug}): luminance ${Math.min(...all).toFixed(3)} to ${Math.max(...all).toFixed(3)}, largest swing of one cell ${Math.max(...swings).toFixed(3)}, ` +
          `${moving} of ${readings.length} cells move; most flashes in any second: per cell ${worst}, whole box ${mostFlashesPerWindow(wholeBox, 60)}`,
      );
      // The scene really is drawn, has contrast and really moves: otherwise "no flash" would mean nothing.
      expect(range).toBeGreaterThan(0.2);
      expect(moving).toBeGreaterThan(GRID);
      // WCAG 2.3.1 allows three; the ranges are set to stay under it.
      expect(worst).toBeLessThan(3);
      expect(mostFlashesPerWindow(wholeBox, 60)).toBeLessThan(3);
    });
  });

  if (name === 'chromium') {
    it('sends the same HTML for the box as for a box without a scene, apart from its two marks', async () => {
      const boxHtml = async (slug: string): Promise<string> => {
        const html = await (await fetch(`${origin}/${slug}`)).text();
        // From the box's own tag (whatever order its attributes come in) to the first script after it:
        // the box is the last element of the page content.
        const start = html.search(/<div(?=[^>]*\sdata-t="hero")[^>]*>/);
        expect(start).toBeGreaterThan(-1);
        const end = html.indexOf('<script', start);
        expect(end).toBeGreaterThan(start);
        return html.slice(start, end);
      };
      const withScene = await boxHtml('fx-immediate');
      const plain = await boxHtml('fx-none');
      expect(withScene).toContain('data-fx="scene"');
      expect(withScene).toContain('data-fc-fx="0"');
      expect(withScene).not.toContain('noiseFill');
      expect(withScene.replace(' data-fx="scene"', '').replace(' data-fc-fx="0"', '')).toBe(plain);
    });

    it('measures what a scene adds over the network, and holds it to the budget', async () => {
      const measure = async (slug: string, until: () => Promise<unknown>): Promise<Map<string, number>> => {
        await newPage();
        const session = await context.newCDPSession(page);
        await session.send('Network.enable');
        await session.send('Network.setCacheDisabled', { cacheDisabled: true });
        const urls = new Map<string, string>();
        const bytes = new Map<string, number>();
        session.on('Network.responseReceived', ({ requestId, response }) => urls.set(requestId, response.url));
        session.on('Network.loadingFinished', ({ requestId, encodedDataLength }) => {
          const url = urls.get(requestId);
          if (url) bytes.set(url, encodedDataLength);
        });
        await page.goto(`${origin}/${slug}`, { waitUntil: 'networkidle' });
        await until();
        await page.waitForLoadState('networkidle');
        return bytes;
      };
      const plain = await measure('fx-none', async () => {});
      const scene = await measure('fx-immediate', () => waitForState('live'));
      const added = [...scene].filter(([url]) => url.split('?')[0].endsWith('.js') && !plain.has(url));
      const addedBytes = added.reduce((sum, [, size]) => sum + size, 0);
      // Scripts both pages fetch: the page's own code must not grow with a scene on it.
      const shared = (bytesOf: Map<string, number>) => [...bytesOf].filter(([url]) => url.split('?')[0].endsWith('.js') && plain.has(url) && scene.has(url)).reduce((sum, [, size]) => sum + size, 0);
      console.info(`fx bundle: a scene adds ${addedBytes} bytes on the wire in ${added.length} script(s): ${JSON.stringify(added.map(([url, size]) => [url.split('/').pop(), size]))}; shared scripts ${shared(plain)} (plain) and ${shared(scene)} (scene)`);
      expect(added.length).toBeGreaterThan(0);
      expect(addedBytes).toBeLessThanOrEqual(FX_BUDGET_BYTES);
      // The budget is a ceiling held within 5 percent: a build far under it means the number is stale.
      expect(addedBytes).toBeGreaterThan(FX_BUDGET_BYTES * 0.8);
    });
  }
});
