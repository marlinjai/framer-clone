// The FX pixel oracle (docs/plans/2026-11-08-lumitra-fx-in-sites.md, slice F4): the
// same scene drawn twice, once by Lumitra FX as lumitra-web runs it and once by
// this app's published page, and the two pictures compared pixel by pixel.
//
// How the reference is made, what frame is compared and why the clock is stopped
// are in test/fx-oracle/oracle.ts. THIS APP'S SIDE here is the real thing: a stored
// page, published through the real repository, served by the real route of a real
// production build, drawn by FxIsland.
//
// Each comparison can fail: both sides must reproduce themselves exactly from a
// fresh page, and one changed parameter on one side must exceed the tolerance.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type BrowserContext, type BrowserType, type Page } from 'playwright';
import type { PNG } from 'pngjs';
import { PRESETS, serializeScene } from '@/lib/fx/format';
import { FX_ATTR, FX_MARKER, FX_PROP } from '@/lib/fxScene/marker';
import {
  CHANNEL_TOLERANCE,
  HEIGHT,
  MAX_DIFFERING_SHARE,
  ORACLE_CONTEXT,
  STOP_THE_CLOCK,
  WIDTH,
  buildReferenceBundle,
  colours,
  difference,
  drawReference,
  settledCanvas,
  type OracleScene as Scene,
} from '../fx-oracle/oracle';
import { node, type StoredNode } from './pages';
import { publishPages } from './site';

/** A preset as it is stored: the values `serializeScene` writes. */
const preset = (id: string): Scene => serializeScene(PRESETS.find((p) => p.id === id)!.load()) as unknown as Scene;

const SCENES: Readonly<Record<string, Scene>> = {
  // The lumitra.co hub hero is the engine's first preset.
  'hub-hero': preset('gold-noise-gradient'),
  'godrays-hero': preset('godrays-hero'),
  'noise-gradient': preset('noise-gradient'),
};

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The hub hero with one colour of its first layer changed: a different picture, on purpose. */
const changedHubHero = (): Scene => {
  const scene = clone(SCENES['hub-hero']);
  const layer = scene.layers.find((l) => Object.entries(l.params).some(([, value]) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)))!;
  const key = Object.entries(layer.params).find(([, value]) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value))![0];
  layer.params[key] = '#00ff00';
  return scene;
};

/** The hub hero without its grain: what the grain adds is the difference to it. */
const withoutGrain = (scene: Scene): Scene => ({ ...clone(scene), layers: clone(scene.layers).filter((l) => l.type !== 'grain') });

/** A published page that is nothing but one FX box of a fixed size, drawn at once, held still for reduced motion. */
const fxPage = (scene: Scene): StoredNode =>
  node('page-root', 'div', { style: { margin: '0px' } },
    node('hero', 'div', {
      [FX_ATTR]: FX_MARKER,
      [FX_PROP]: { version: 1, scene, start: 'immediate', calm: 'frame' },
      style: { position: 'relative', width: `${WIDTH}px`, height: `${HEIGHT}px`, background: '#000000' },
    }));

const PAGES: Readonly<Record<string, () => StoredNode>> = {
  ...Object.fromEntries(Object.entries(SCENES).map(([name, scene]) => [`oracle-${name}`, () => fxPage(scene)])),
  'oracle-hub-hero-changed': () => fxPage(changedHubHero()),
  'oracle-hub-hero-no-grain': () => fxPage(withoutGrain(SCENES['hub-hero'])),
};

let origin: string;
let referenceBundle: string;

beforeAll(async () => {
  referenceBundle = await buildReferenceBundle();
  origin = await publishPages(process.env.BEHAVIOUR_PORT!, { pages: PAGES });
}, 180_000);

describe.each([['chromium', chromium], ['webkit', webkit]] as [string, BrowserType][])('in %s', (name, engine) => {
  let browser: Browser;
  const contexts: BrowserContext[] = [];

  const newPage = async (): Promise<Page> => {
    const context = await browser.newContext(ORACLE_CONTEXT);
    contexts.push(context);
    const page = await context.newPage();
    await page.addInitScript(STOP_THE_CLOCK);
    return page;
  };

  /** The scene as this app's published page draws it. */
  const sites = async (slug: string): Promise<PNG> => {
    const page = await newPage();
    await page.goto(`${origin}/${slug}`);
    await page.waitForFunction(() => document.querySelector('[data-t="hero"]')?.getAttribute('data-fc-fx-state') === 'live', undefined, { timeout: 30_000 });
    await expect.poll(() => page.locator('[data-fc-fx-layer]').evaluate((layer) => getComputedStyle(layer).opacity), { timeout: 5000 }).toBe('1');
    return settledCanvas(page, '[data-t="hero"] canvas');
  };

  /** The scene as the frozen lumitra-web engine draws it, on a blank page. */
  const reference = async (scene: Scene): Promise<PNG> => drawReference(await newPage(), referenceBundle, scene);

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

  describe.each(Object.keys(SCENES))('%s', (sceneName) => {
    it('this app draws the same picture as the lumitra-web engine', async () => {
      const ours = await sites(`oracle-${sceneName}`);
      const theirs = await reference(SCENES[sceneName]);
      const result = difference(ours, theirs);
      console.info(`fx oracle (${name}, ${sceneName}): ${result.differing} of ${WIDTH * HEIGHT} pixels differ by more than ${CHANNEL_TOLERANCE} (${(result.share * 100).toFixed(4)} percent), largest difference in a channel ${result.largest}`);
      // Not a black or flat frame on either side.
      expect(colours(ours)).toBeGreaterThan(50);
      expect(colours(theirs)).toBeGreaterThan(50);
      expect(result.share).toBeLessThanOrEqual(MAX_DIFFERING_SHARE);
    });

    it('each side reproduces itself exactly from a fresh page', async () => {
      const [first, second] = [await sites(`oracle-${sceneName}`), await sites(`oracle-${sceneName}`)];
      expect(difference(first, second).differing).toBe(0);
      const [third, fourth] = [await reference(SCENES[sceneName]), await reference(SCENES[sceneName])];
      expect(difference(third, fourth).differing).toBe(0);
      // Four fresh pages, each waited on until its picture settles.
    }, 180_000);
  });

  describe('the comparison can fail', () => {
    it('one changed colour on this app\'s side is far over the tolerance', async () => {
      const result = difference(await sites('oracle-hub-hero-changed'), await reference(SCENES['hub-hero']));
      expect(result.share).toBeGreaterThan(MAX_DIFFERING_SHARE * 10);
    });

    it('one changed colour on the reference\'s side is far over the tolerance', async () => {
      const result = difference(await sites('oracle-hub-hero'), await reference(changedHubHero()));
      expect(result.share).toBeGreaterThan(MAX_DIFFERING_SHARE * 10);
    });

    it('the grain is in the picture on both sides: with the clock stopped it is still grain, not a flat frame', async () => {
      expect(SCENES['hub-hero'].layers.some((l) => l.type === 'grain')).toBe(true);
      const ours = difference(await sites('oracle-hub-hero'), await sites('oracle-hub-hero-no-grain'));
      const theirs = difference(await reference(SCENES['hub-hero']), await reference(withoutGrain(SCENES['hub-hero'])));
      console.info(`fx oracle (${name}): the grain changes ${(ours.share * 100).toFixed(1)} percent of pixels on this app's side and ${(theirs.share * 100).toFixed(1)} percent on the reference's`);
      expect(ours.share).toBeGreaterThan(0.05);
      expect(theirs.share).toBeGreaterThan(0.05);
    }, 180_000);
  });
});
