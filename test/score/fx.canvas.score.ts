// The canvas column of the FX scene rows (docs/plans/2026-11-08-lumitra-fx-in-sites.md,
// slice F5), on the real EditorApp in real Chromium. A box holding the reference scene
// is put on the canvas. A cell passes only when all of this holds:
//
//  - by default the canvas draws the box with its own background and no scene at all
//    (no layer, no canvas, no WebGL context);
//  - with "Live" on for the box, the scene is drawn, in exactly one WebGL context;
//  - the drawing fills the box, behind its content, and is a real picture (many
//    colours, not a blank or flat frame);
//  - Live off gives the box back as it was and releases the context.
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
  __fxContexts: { live: () => number };
}

const BOX = '[data-viewport-content-id] [data-inner-component-id="fx-box"]';

async function canvasCell(browser: Browser, bundle: string, scene: unknown): Promise<Cell> {
  let page: Page | undefined;
  try {
    const opened = await openEditor(browser, bundle, {}, async (fresh) => {
      await fresh.addInitScript(() => {
        const made: WebGLRenderingContext[] = [];
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
          const context = (original as (...args: unknown[]) => unknown).call(this, kind, ...rest);
          if (context && /^webgl/.test(kind) && !made.includes(context as WebGLRenderingContext)) made.push(context as WebGLRenderingContext);
          return context;
        } as typeof HTMLCanvasElement.prototype.getContext;
        (window as unknown as { __fxContexts: unknown }).__fxContexts = { live: () => made.filter((context) => !context.isContextLost()).length };
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
    const styleOf = () => view.locator(BOX).first().getAttribute('style');

    const before = await styleOf();
    if ((await view.locator('canvas').count()) > 0 || (await view.locator('[data-fc-fx-layer]').count()) > 0 || (await contexts()) > 0) return fail('the canvas draws a scene without Live');

    await view.evaluate(() => (window as unknown as ProbeWindow).__editor.startFxLive('fx-box', 0));
    await expect.poll(status, { timeout: 60_000 }).not.toBe('loading');
    const drawn = await status();
    if (drawn !== 'live') return fail(`with Live on the scene is not drawn (${drawn})`);
    if ((await contexts()) !== 1 || (await view.locator('canvas').count()) !== 1) return fail(`Live holds ${await contexts()} WebGL contexts and ${await view.locator('canvas').count()} canvases, not one`);

    const placed = await view.evaluate((selector) => {
      const box = document.querySelector(selector) as HTMLElement;
      const canvas = box.querySelector('canvas') as HTMLCanvasElement;
      const a = box.getBoundingClientRect();
      const b = canvas.getBoundingClientRect();
      const title = box.querySelector('[data-inner-component-id="fx-title"]') as HTMLElement;
      const t = title.getBoundingClientRect();
      return {
        fills: Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1,
        contentOnTop: document.elementFromPoint(t.x + 4, t.y + t.height / 2) === title,
      };
    }, BOX);
    if (!placed.fills) return fail('the drawing does not fill the box');
    if (!placed.contentOnTop) return fail('the drawing covers the content of the box');
    // The fade has ended and the frame is on screen.
    await expect.poll(() => view.locator(`${BOX} [data-fc-fx-layer]`).first().evaluate((layer) => getComputedStyle(layer).opacity), { timeout: 5000 }).toBe('1');
    // The screenshot is the page clipped to the canvas, so the heading over the scene is hidden first: its text must not supply the colours.
    await view.evaluate(() => ((document.querySelector('[data-inner-component-id="fx-title"]') as HTMLElement).style.visibility = 'hidden'));
    const seen = colours(PNG.sync.read(await view.locator(`${BOX} canvas`).first().screenshot()));
    if (seen < 50) return fail(`the drawing is a blank or flat frame (${seen} colours)`);

    await view.evaluate(() => (window as unknown as ProbeWindow).__editor.stopFxLive());
    await expect.poll(contexts, { timeout: 10_000 }).toBe(0);
    if ((await view.locator('canvas').count()) > 0 || (await styleOf()) !== before) return fail('Live off does not give the box back as it was');
    if (opened.crashes.length > 0) return fail(`the editor crashed: ${opened.crashes[0]}`);
    return { status: 'pass', note: `nothing drawn by default; Live draws it in one WebGL context, filling the box behind its content (${seen} colours); off releases it` };
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
