// The canvas column of the FX scene rows (docs/plans/2026-11-08-lumitra-fx-in-sites.md,
// slice F5), on the real EditorApp in real Chromium. A box holding the reference scene
// is put on the canvas. A cell passes only when all of this holds:
//
//  - by default every frame shows a still picture of the scene (a real picture that
//    fills the box, behind its content), with no live layer, and the context it was
//    drawn in released again (the plan's addendum "Still frames in every breakpoint");
//  - with "Live" on for the box, the scene is drawn live, in exactly one WebGL context;
//  - the live drawing fills the box, behind its content, and is a real picture (many
//    colours, not a blank or flat frame);
//  - Live off gives the box back as it was, with its still, and releases the context.
//
// A scene that cannot be drawn must be drawn NOWHERE: no still picture, no live
// canvas and no WebGL context at any time. Only then does the cell give the reader's
// reason ("not drawn (off:refused)"); anything drawn is reported as drawn.
//
// The pixels themselves are the renderer column's (fx.score.ts): the canvas draws with
// the same engine and the same strict reader, so this column asks whether the editor
// puts that drawing where it belongs.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { PNG } from 'pngjs';
import { PRESETS, serializeScene } from '@/lib/fx/format';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { colours } from '../fx-oracle/oracle';
import fxScenes from './data/fx-scenes.json';
import { bundleEditor, openEditor, placeTree } from './lib/canvasBundle';
import { writeOut } from './lib/io';
import { rowKey, type Cell, type SurfaceResults } from './lib/types';
import { fxSceneEntries } from './lib/universe';

const preset = (id: string) => serializeScene(PRESETS.find((p) => p.id === id)!.load());

/** The same three scenes as the format and renderer columns (fx.score.ts). */
const SCENES: Readonly<Record<string, unknown>> = {
  'hub-hero': preset('gold-noise-gradient'),
  'godrays-hero': preset('godrays-hero'),
  'noise-gradient': preset('noise-gradient'),
};

const key = (id: string) => rowKey('fx-scene', `scene:${id}`);
const fail = (note: string): Cell => ({ status: 'fail', gap: 'fx-scene', note });

const tree = (scene: unknown): ComponentNode =>
  ({
    id: 'fx-box',
    type: 'div',
    props: { 'data-fx': 'scene', fx: { version: 1, scene, start: 'immediate', calm: 'frame' }, style: { width: '100%', height: '360px', background: 'rgb(0, 0, 255)' } },
    children: [{ id: 'fx-title', type: 'h2', props: { children: 'Over the scene' } }],
  }) as unknown as ComponentNode;

interface ProbeWindow {
  __editor: { startFxLive: (id: string, frame: number | null) => void; stopFxLive: () => void; fxLiveStatus: () => string };
  __fxContexts: { made: () => number; live: () => number };
}

const BOX = '[data-viewport-content-id] [data-inner-component-id="fx-box"]';
const STILL = `${BOX} [data-fc-fx-still]`;
const LIVE = `${BOX} [data-fc-fx-layer]`;

/** Each frame's still: its state, and whether its picture canvas holds anything. */
const stillsOf = (page: Page) =>
  page.locator(STILL).evaluateAll((layers) =>
    layers.map((layer) => {
      const picture = layer.querySelector(':scope > canvas') as HTMLCanvasElement;
      return { state: layer.getAttribute('data-fc-fx-still'), drawn: picture.width > 0 && picture.height > 0 };
    }),
  );

/** What is wrong with the picture shown in `layer` (its place in the box, its colours), or null, with the number of colours. */
async function pictureIn(page: Page, layer: string): Promise<{ problem: string | null; seen: number }> {
  const placed = await page.evaluate(
    ([boxSelector, layerSelector]) => {
      const box = document.querySelector(boxSelector) as HTMLElement;
      const canvas = document.querySelector(`${layerSelector} > canvas, ${layerSelector} > * canvas`) as HTMLCanvasElement;
      const a = box.getBoundingClientRect();
      const b = canvas.getBoundingClientRect();
      const title = box.querySelector('[data-inner-component-id="fx-title"]') as HTMLElement;
      const t = title.getBoundingClientRect();
      return {
        fills: Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1,
        contentOnTop: document.elementFromPoint(t.x + 4, t.y + t.height / 2) === title,
      };
    },
    [BOX, layer] as const,
  );
  if (!placed.fills) return { problem: 'does not fill the box', seen: 0 };
  if (!placed.contentOnTop) return { problem: 'covers the content of the box', seen: 0 };
  const canvas = page.locator(`${layer} canvas`).first();
  // The fade has ended and the frame is on screen: the layer's own and the canvas's (the still fades its picture).
  await expect
    .poll(() => canvas.evaluate((el) => [getComputedStyle(el).opacity, getComputedStyle(el.closest('[data-fc-fx-still], [data-fc-fx-layer]') as Element).opacity].join(' ')), { timeout: 5000 })
    .toBe('1 1');
  // The screenshot is the page clipped to the canvas, so the heading over the scene is hidden first: its text must not supply the colours.
  const showTitle = (visibility: string) => page.evaluate((value) => ((document.querySelector('[data-inner-component-id="fx-title"]') as HTMLElement).style.visibility = value), visibility);
  await showTitle('hidden');
  const seen = colours(PNG.sync.read(await canvas.screenshot()));
  await showTitle('');
  return { problem: seen < 50 ? `is a blank or flat frame (${seen} colours)` : null, seen };
}

async function canvasCell(browser: Browser, bundle: string, scene: unknown): Promise<Cell> {
  let page: Page | undefined;
  try {
    const opened = await openEditor(browser, bundle, {}, async (fresh) => {
      await fresh.addInitScript(() => {
        const made: WebGLRenderingContext[] = [];
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
          const context = (original as (...args: unknown[]) => unknown).call(this, kind, ...rest);
          // A canvas in the page: a scene's. The engine's own probe (a detached canvas, released at once) is not one.
          if (context && /^webgl/.test(kind) && this.isConnected && !made.includes(context as WebGLRenderingContext)) made.push(context as WebGLRenderingContext);
          return context;
        } as typeof HTMLCanvasElement.prototype.getContext;
        (window as unknown as { __fxContexts: unknown }).__fxContexts = { made: () => made.length, live: () => made.filter((context) => !context.isContextLost()).length };
      });
    });
    page = opened.page;
    const view = page;
    // The whole score runs beside this probe and the scene is drawn without a graphics card here:
    // the editor's own short default (1.5 seconds) would measure the machine's load, not the editor.
    view.setDefaultTimeout(60_000);
    await placeTree(view, opened.crashes, tree(scene));
    const status = () => view.evaluate(() => (window as unknown as ProbeWindow).__editor.fxLiveStatus());
    const contexts = () => view.evaluate(() => (window as unknown as ProbeWindow).__fxContexts.live());
    const everMade = () => view.evaluate(() => (window as unknown as ProbeWindow).__fxContexts.made());
    const styleOf = () => view.locator(BOX).first().getAttribute('style');
    const liveLayers = () => view.locator('[data-fc-fx-layer]').count();

    if ((await liveLayers()) > 0) return fail('the canvas draws a live scene without Live');
    // Every frame's still has settled (drawn, or given up), and the context the stills are drawn in is released.
    await expect.poll(async () => (await stillsOf(view)).map((s) => s.state).every((state) => state === 'live' || state === 'off'), { timeout: 60_000 }).toBe(true);
    await expect.poll(contexts, { timeout: 60_000 }).toBe(0);
    const stills = await stillsOf(view);
    if (stills.length === 0) return fail('the box has no still frame layer without Live');
    const still = stills.every((s) => s.state === 'live' && s.drawn);
    const nothingStill = stills.every((s) => s.state === 'off' && !s.drawn) && (await everMade()) === 0;
    if (!still && !nothingStill) return fail(`without Live the still frames are neither drawn nor left out (${JSON.stringify(stills)}, ${await everMade()} contexts made)`);
    if (still) {
      const picture = await pictureIn(view, STILL);
      if (picture.problem) return fail(`the still frame ${picture.problem}`);
      if ((await liveLayers()) > 0) return fail('the canvas draws a live scene without Live');
    }

    const before = await styleOf();
    await view.evaluate(() => (window as unknown as ProbeWindow).__editor.startFxLive('fx-box', 0));
    await expect.poll(status, { timeout: 60_000 }).not.toBe('loading');
    const drawn = await status();
    if (drawn !== 'live') {
      const nothing = nothingStill && (await everMade()) === 0 && (await view.locator('[data-fc-fx-layer] canvas').count()) === 0 && (await stillsOf(view)).every((s) => !s.drawn);
      if (!nothing) return fail(`a scene Live does not draw (${drawn}) is drawn on the canvas all the same (still frames: ${JSON.stringify(stills)}, ${await everMade()} contexts made)`);
      return fail(`with Live on the scene is not drawn (${drawn})`);
    }
    if (!still) return fail('without Live no still frame shows the scene Live draws');
    const canvases = () => view.locator('[data-fc-fx-layer] canvas').count();
    if ((await contexts()) !== 1 || (await canvases()) !== 1) return fail(`Live holds ${await contexts()} WebGL contexts and ${await canvases()} live canvases, not one`);
    const live = await pictureIn(view, LIVE);
    if (live.problem) return fail(`the live drawing ${live.problem}`);

    await view.evaluate(() => (window as unknown as ProbeWindow).__editor.stopFxLive());
    await expect.poll(async () => (await stillsOf(view)).every((s) => s.state === 'live' && s.drawn), { timeout: 60_000 }).toBe(true);
    await expect.poll(contexts, { timeout: 60_000 }).toBe(0);
    await expect.poll(styleOf, { timeout: 10_000 }).toBe(before);
    if ((await liveLayers()) > 0) return fail('Live off leaves the live layer in the box');
    if (opened.crashes.length > 0) return fail(`the editor crashed: ${opened.crashes[0]}`);
    return { status: 'pass', note: `a still frame by default, its context released; Live draws it in one WebGL context, filling the box behind its content (${live.seen} colours); off releases it and shows the still again` };
  } catch (err) {
    return fail(err instanceof Error ? err.message.split('\n')[0] : String(err));
  } finally {
    await page?.context().close();
  }
}

describe('FX scene promises: the canvas', () => {
  let browser: Browser;
  let bundle: string;

  beforeAll(async () => {
    [bundle, browser] = await Promise.all([bundleEditor(), chromium.launch()]);
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
  });

  it('measures the canvas for every reference scene, and names nothing that is not a row', async () => {
    expect(Object.keys(SCENES).sort()).toEqual([...fxScenes.scenes].sort());
    const canvas: SurfaceResults = {};
    for (const [id, scene] of Object.entries(SCENES)) canvas[key(id)] = await canvasCell(browser, bundle, scene);
    const rows = new Set(fxSceneEntries().map((e) => rowKey(e.kind, e.id)));
    for (const name of Object.keys(canvas)) expect(rows.has(name), name).toBe(true);
    writeOut('fx-scenes-canvas', { canvas });
  }, 600_000);

  it('the picture check can fail: a flat frame has too few colours to pass', () => {
    const flat = new PNG({ width: 64, height: 64 });
    flat.data.fill(255);
    expect(colours(PNG.sync.read(PNG.sync.write(flat)))).toBeLessThan(50);
  });

  it('the probe can fail: a scene the reader refuses is not drawn, and the cell says so', async () => {
    const cell = await canvasCell(browser, bundle, { background: '#000000', layers: 'none' });
    expect(cell.status).toBe('fail');
    expect(cell.note).toMatch(/not drawn \(off:refused\)/);
  }, 120_000);
});
