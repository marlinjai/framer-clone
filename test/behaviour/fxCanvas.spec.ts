// The FX scene on the editor's canvas and in its preview, in real Chromium and WebKit,
// on the real EditorApp (docs/plans/2026-11-08-lumitra-fx-in-sites.md, slice F5).
//
// The canvas shows every breakpoint side by side and a browser allows only a handful
// of WebGL contexts, so the promise this file keeps is: at no moment does the editor
// hold more than ONE live scene's context, plus ONE short-lived context while a still
// frame is made (every frame a box is not drawn live in shows a still frame of its
// scene, src/components/fx/FxLayer.tsx FxStillLayer), whatever is switched, edited or
// opened. The contexts are counted in the page itself, at the one place a context is
// made (`HTMLCanvasElement.getContext`), so a context no element shows any more is
// still counted until it is released, and the most ever held at once is kept.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type BrowserType, type Page } from 'playwright';
import { PNG } from 'pngjs';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { fxFromPreset, setFxParam, setFxStart, type FxEdit } from '@/lib/fxScene/edit';
import { bundleEditor, openEditor, placeTree } from '../score/lib/canvasBundle';

const ENGINES: [string, BrowserType][] = [
  ['chromium', chromium],
  ['webkit', webkit],
];

function stored(edit: FxEdit) {
  if (!edit.ok) throw new Error(edit.message);
  return edit.stored;
}
const preset = fxFromPreset();
if (!preset.ok) throw new Error(preset.message);
/** Started at once, so the preview does not wait out the page's settle time. */
const SCENE = stored(setFxStart(preset.stored, 'immediate'));

const fxBox = (id: string): ComponentNode =>
  ({
    id,
    type: 'div',
    props: { 'data-fx': 'scene', fx: SCENE, style: { width: '100%', height: '240px', background: 'rgb(0, 0, 255)' } },
    children: [{ id: `${id}-title`, type: 'h2', props: { children: `Over ${id}` } }],
  }) as unknown as ComponentNode;

const tree = (): ComponentNode => ({ id: 'page', type: 'div', props: {}, children: [fxBox('fxa'), fxBox('fxb')] }) as unknown as ComponentNode;

interface FxEditorWindow {
  __editor: {
    selectIn: (id: string, frame: number) => void;
    startFxLive: (id: string, frame: number | null) => void;
    stopFxLive: () => void;
    fxLiveStatus: () => string;
    setFx: (id: string, stored: unknown) => void;
    setPreviewOpen: (open: boolean) => void;
    undoLevels: () => number;
  };
  __fxContexts: { made: number; live: () => number; most: () => number };
}

/** Counts every WebGL context the page makes, and how many of them are still held. */
const countContexts = (page: Page) =>
  page.addInitScript(() => {
    const made: WebGLRenderingContext[] = [];
    let most = 0;
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
      const context = (original as (...args: unknown[]) => unknown).call(this, kind, ...rest);
      // A canvas in the page: a scene's. The engine's own probe (a detached canvas, released at once) is not one.
      if (context && /^webgl/.test(kind) && this.isConnected && !made.includes(context as WebGLRenderingContext)) {
        made.push(context as WebGLRenderingContext);
        most = Math.max(most, made.filter((c) => !c.isContextLost()).length);
      }
      return context;
    } as typeof HTMLCanvasElement.prototype.getContext;
    (window as unknown as { __fxContexts: unknown }).__fxContexts = {
      get made() {
        return made.length;
      },
      live: () => made.filter((context) => !context.isContextLost()).length,
      most: () => most,
    };
  });

let bundle: string;

beforeAll(async () => {
  bundle = await bundleEditor();
}, 180_000);

describe.each(ENGINES)('in %s', (_name, engine) => {
  let browser: Browser;
  let page: Page;
  let crashes: string[];
  let warnings: string[];

  beforeAll(async () => {
    browser = await engine.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });
  // A page left open keeps its WebGL contexts running beside the next test's: each test closes its own, failed or not.
  afterEach(async () => {
    await page?.context().close();
  });

  /** Wide enough that every breakpoint frame is on screen, as on a canvas zoomed out to show them all. */
  const WIDE = { viewport: { width: 4200, height: 1000 } };
  const open = async (options: Parameters<typeof openEditor>[2] = {}) => {
    warnings = [];
    const opened = await openEditor(browser, bundle, options, async (fresh) => {
      await countContexts(fresh);
      fresh.on('console', (message) => {
        if (message.type() === 'warning' && message.text().includes('FX scene')) warnings.push(message.text());
      });
    });
    ({ page, crashes } = opened);
    // The harness's own default is 1.5 seconds, for an editor that answers at once. A scene drawn
    // without a graphics card on a busy runner does not: these steps wait as long as the polls do.
    page.setDefaultTimeout(30_000);
    await placeTree(page, crashes, tree(), { allFrames: true });
  };

  const editor = <T,>(call: (api: FxEditorWindow['__editor'], arg: never) => T, arg?: unknown): Promise<T> =>
    page.evaluate(([source, value]) => new Function('api', 'arg', `return (${source})(api, arg)`)((window as unknown as FxEditorWindow).__editor, value), [call.toString(), arg] as const) as Promise<T>;
  const status = () => editor((api) => api.fxLiveStatus());
  const liveContexts = () => page.evaluate(() => (window as unknown as FxEditorWindow).__fxContexts.live());
  const madeContexts = () => page.evaluate(() => (window as unknown as FxEditorWindow).__fxContexts.made);
  const mostContexts = () => page.evaluate(() => (window as unknown as FxEditorWindow).__fxContexts.most());
  /** The live scene's canvases (the still frames' pictures are plain 2D canvases of their own layers). */
  const canvases = () => page.locator('[data-fc-fx-layer] canvas').count();
  /**
   * The still frames: frame, box, state, the picture's size against the layer's layout size, and whether
   * it shows the scene (pixels that are not the box's own blue background).
   */
  const stills = () =>
    page.evaluate(() => {
      const frames = [...document.querySelectorAll('[data-viewport-content-id]')];
      // A still frame under the live scene of its frame is hidden once that one is drawn: not counted.
      return [...document.querySelectorAll<HTMLElement>('[data-fc-fx-still]')].filter((layer) => layer.style.opacity !== '0').map((layer) => {
        const picture = layer.querySelector<HTMLCanvasElement>(':scope > canvas')!;
        let scene = false;
        if (picture.width > 0 && picture.height > 0) {
          const data = picture.getContext('2d')!.getImageData(0, 0, picture.width, picture.height).data;
          for (let i = 0; i < data.length && !scene; i += 4 * 97) scene = !(data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 255);
        }
        return {
          frame: frames.findIndex((frame) => frame.contains(layer)),
          box: layer.parentElement?.getAttribute('data-inner-component-id'),
          state: layer.getAttribute('data-fc-fx-still'),
          width: picture.width,
          height: picture.height,
          layoutWidth: layer.offsetWidth,
          layoutHeight: layer.offsetHeight,
          scene,
        };
      });
    });
  /** Every still frame there is drawn (or settled as off), and no still context is left. */
  const stillsSettled = async (count: number, state = 'live') => {
    await expect
      .poll(async () => (await stills()).filter((still) => still.state === state).length, { timeout: 60_000 })
      .toBe(count);
  };
  /** A fingerprint of a picture's pixels, to see that a still frame was drawn again. */
  const fingerprint = (frame: number, box: string) =>
    page.evaluate(([frameIndex, id]) => {
      const frames = [...document.querySelectorAll('[data-viewport-content-id]')];
      const layer = frames[frameIndex as number].querySelector(`[data-inner-component-id="${id}"] > [data-fc-fx-still]`);
      const picture = layer?.querySelector<HTMLCanvasElement>(':scope > canvas');
      if (!picture || picture.width === 0) return 'none';
      const data = picture.getContext('2d')!.getImageData(0, 0, picture.width, picture.height).data;
      let hash = 0;
      for (let i = 0; i < data.length; i += 4 * 31) hash = (hash * 31 + data[i] + data[i + 1] * 3 + data[i + 2] * 7) | 0;
      return String(hash);
    }, [frame, box] as const);
  /** Where the scene is drawn: the frame (its place in the row) and the box of each layer that holds a canvas. */
  const drawn = () =>
    page.evaluate(() => {
      const frames = [...document.querySelectorAll('[data-viewport-content-id]')];
      return [...document.querySelectorAll('[data-fc-fx-layer]')]
        .filter((layer) => layer.querySelector('canvas'))
        .map((layer) => ({
          frame: frames.findIndex((frame) => frame.contains(layer)),
          box: layer.parentElement?.getAttribute('data-inner-component-id'),
          preview: !!layer.closest('[data-preview-frame]'),
          state: layer.getAttribute('data-fc-fx-state'),
        }));
    });
  const waitLive = () => expect.poll(status, { timeout: 30_000 }).toBe('live');
  /** One context, and it is the live one on screen (every still frame's context is released). */
  const expectOne = async () => {
    await expect.poll(liveContexts, { timeout: 60_000 }).toBe(1);
    expect(await canvases()).toBe(1);
    expect(await mostContexts()).toBeLessThanOrEqual(2);
  };

  it('by default every frame shows a still frame of each box at its own size, made one context at a time, none left running', async () => {
    await open(WIDE);
    const frames = await page.locator('[data-viewport-content-id]').count();
    expect(frames).toBeGreaterThan(1);
    await stillsSettled(frames * 2);
    const all = await stills();
    expect(all).toHaveLength(frames * 2);
    const ratio = await page.evaluate(() => Math.min(window.devicePixelRatio || 1, 2));
    for (const still of all) {
      expect(still.scene).toBe(true);
      // The frame's own responsive size, at the pixel ratio the live scene would use (the preset allows up to 2).
      expect(Math.abs(still.width - Math.floor(still.layoutWidth * ratio))).toBeLessThanOrEqual(1);
      expect(Math.abs(still.height - Math.floor(still.layoutHeight * ratio))).toBeLessThanOrEqual(1);
    }
    // The frames differ in width, so do their pictures.
    expect(new Set(all.map((still) => still.width)).size).toBeGreaterThan(1);
    expect(await page.locator('[data-fc-fx-layer]').count()).toBe(0);
    expect(await mostContexts()).toBe(1);
    await expect.poll(liveContexts, { timeout: 60_000 }).toBe(0);
    expect(await status()).toBe('idle');
    expect(warnings).toEqual([]);
    expect(crashes).toEqual([]);
  });

  it('a frame that is not on screen asks for no still frame: no context, no engine work for it', async () => {
    // At this window size only the first frame is on screen; the others are beside it, out of sight.
    await open();
    const frames = await page.locator('[data-viewport-content-id]').count();
    await stillsSettled(2);
    await page.waitForTimeout(2000);
    const all = await stills();
    expect(all.filter((still) => still.state === 'live').map((still) => still.frame)).toEqual([0, 0]);
    expect(all.filter((still) => still.state === 'waiting')).toHaveLength((frames - 1) * 2);
    expect(await madeContexts()).toBe(1);
    expect(crashes).toEqual([]);
  });

  it('with Live on, the picked frame is live and every other frame keeps its still frame', async () => {
    await open(WIDE);
    const frames = await page.locator('[data-viewport-content-id]').count();
    await editor((api) => api.startFxLive('fxa', 0));
    await waitLive();
    await stillsSettled(frames * 2 - 1);
    await expectOne();
    expect(await drawn()).toEqual([{ frame: 0, box: 'fxa', preview: false, state: 'live' }]);
    const places = (await stills()).map((still) => `${still.box}@${still.frame}`).sort();
    expect(places).not.toContain('fxa@0');
    expect(places).toContain('fxa@1');
    expect(places).toContain('fxb@0');
    expect(crashes).toEqual([]);
  });

  it('a changed scene draws every still frame again once the edits settle, and the old picture stays until then', async () => {
    await open(WIDE);
    const frames = await page.locator('[data-viewport-content-id]').count();
    await stillsSettled(frames * 2);
    const before = await fingerprint(1, 'fxa');
    const made = await madeContexts();
    // A burst of edits 60 ms apart, as a slider sends them: drawn again once, after the last.
    let scene: unknown = SCENE;
    const burst: unknown[] = [];
    // Ending on another preset (the particle ring on black), so the new picture certainly differs from the old.
    for (const intensity of [1.6, 2.4]) burst.push((scene = stored(setFxParam(scene, 'bloom', 'intensity', intensity))));
    const ring = fxFromPreset('lumitra-light');
    if (!ring.ok) throw new Error(ring.message);
    burst.push(stored(setFxStart(ring.stored, 'immediate')));
    await editor(async (api, arg) => {
      for (const next of arg as unknown[]) {
        api.setFx('fxa', next);
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
    }, burst);
    // Never a blank frame in between: the old picture is shown until the new one is there.
    expect(await fingerprint(1, 'fxa')).toBe(before);
    // Every frame of the changed box gets its new picture: one new context per frame, the burst drawn once.
    await expect.poll(async () => (await madeContexts()) - made, { timeout: 60_000 }).toBe(frames);
    await expect.poll(() => fingerprint(1, 'fxa'), { timeout: 30_000 }).not.toBe(before);
    await page.waitForTimeout(1500);
    expect((await madeContexts()) - made).toBe(frames);
    expect(await mostContexts()).toBe(1);
    await expect.poll(liveContexts, { timeout: 60_000 }).toBe(0);
    expect(crashes).toEqual([]);
  });

  it('boxes removed while their still frames are being made leave no context and no layer behind', async () => {
    await open(WIDE);
    // The first still frame is being made (its context is open): the page loses both boxes.
    await expect.poll(madeContexts, { timeout: 60_000 }).toBeGreaterThan(0);
    await placeTree(page, crashes, { id: 'page', type: 'div', props: {}, children: [{ id: 'plain', type: 'h2', props: { children: 'No scene' } }] } as unknown as ComponentNode, { allFrames: true });
    await expect.poll(liveContexts, { timeout: 30_000 }).toBe(0);
    await page.waitForTimeout(2000);
    expect(await liveContexts()).toBe(0);
    expect(await page.locator('[data-fc-fx-still]').count()).toBe(0);
    expect(await page.locator('[data-fc-fx-layer]').count()).toBe(0);
    expect(crashes).toEqual([]);
  });

  it('a still frame is the frame the live scene draws under reduced motion, at the same size', async () => {
    await open({ ...WIDE, reducedMotion: 'reduce' });
    const frames = await page.locator('[data-viewport-content-id]').count();
    await stillsSettled(frames * 2);
    const boxIn = (frame: number) => page.locator('[data-viewport-content-id]').nth(frame).locator('[data-inner-component-id="fxa"]').first();
    // The box's heading hidden, so only the scene is compared.
    await page.addStyleTag({ content: '[data-inner-component-id="fxa-title"]{visibility:hidden}' });
    const still = PNG.sync.read(await boxIn(1).screenshot());
    await editor((api) => api.startFxLive('fxa', 1));
    await waitLive();
    // The still under it is hidden once the live one has faded in.
    await expect.poll(async () => (await stills()).filter((s) => s.frame === 1 && s.box === 'fxa').length, { timeout: 10_000 }).toBe(0);
    await page.waitForTimeout(500);
    const live = PNG.sync.read(await boxIn(1).screenshot());
    expect(live.width).toBe(still.width);
    expect(live.height).toBe(still.height);
    let total = 0;
    let far = 0;
    for (let i = 0; i < still.data.length; i += 4) {
      const d = Math.max(Math.abs(still.data[i] - live.data[i]), Math.abs(still.data[i + 1] - live.data[i + 1]), Math.abs(still.data[i + 2] - live.data[i + 2]));
      total += d;
      if (d > 24) far += 1;
    }
    const pixels = still.data.length / 4;
    const stats = `mean difference ${(total / pixels).toFixed(2)}, share far apart ${(far / pixels).toFixed(5)}`;
    // The same picture: the preset's grain is fresh noise in every frame drawn (measured: a mean difference of
    // about 3.4 levels of 255 and 0.01 percent of pixels more than 24 apart), anything else would be far apart.
    expect(far / pixels, stats).toBeLessThan(0.001);
    expect(total / pixels, stats).toBeLessThan(6);
    expect(crashes).toEqual([]);
  });

  it('a refused scene shows the box background in every frame, holds no context, and draws again once replaced', async () => {
    await open(WIDE);
    const frames = await page.locator('[data-viewport-content-id]').count();
    await stillsSettled(frames * 2);
    await editor((api, arg) => api.setFx('fxa', arg), { version: 99 });
    await stillsSettled(frames, 'off');
    for (const still of (await stills()).filter((s) => s.box === 'fxa')) expect(still.width).toBe(0);
    await expect.poll(liveContexts, { timeout: 60_000 }).toBe(0);
    await editor((api, arg) => api.setFx('fxa', arg), SCENE);
    await stillsSettled(frames * 2);
    expect(crashes).toEqual([]);
  });

  it('Live draws one box in one frame, with one context, and nothing of it reaches the project', async () => {
    await open();
    const levels = await editor((api) => api.undoLevels());
    await editor((api) => api.startFxLive('fxa', 0));
    await waitLive();
    await expectOne();
    expect(await drawn()).toEqual([{ frame: 0, box: 'fxa', preview: false, state: 'live' }]);
    // The layer is behind the content and takes no click: the heading over it is still what is hit.
    const hit = await page.evaluate(() => {
      const title = document.querySelector('[data-viewport-content-id] [data-inner-component-id="fxa-title"]')!;
      const rect = title.getBoundingClientRect();
      return document.elementFromPoint(rect.x + 4, rect.y + rect.height / 2)?.getAttribute('data-inner-component-id');
    });
    expect(hit).toBe('fxa-title');
    expect(await editor((api) => api.undoLevels())).toBe(levels);
    expect(warnings).toEqual([]);
    expect(crashes).toEqual([]);
  });

  it('a change of the scene is drawn in the same context, however many follow', async () => {
    await open();
    await editor((api) => api.startFxLive('fxa', 0));
    await waitLive();
    await expectOne();
    const made = await madeContexts();
    await page.evaluate(() => ((document.querySelector('[data-fc-fx-layer] canvas') as unknown as { __same: boolean }).__same = true));
    let scene: unknown = SCENE;
    for (const intensity of [0.2, 1.4, 0.6, 1.1, 0.9]) {
      scene = stored(setFxParam(scene, 'bloom', 'intensity', intensity));
      await editor((api, arg) => api.setFx('fxa', arg), scene);
      await page.waitForTimeout(150);
      // The live context, and at most one still frame's beside it.
      expect(await liveContexts()).toBeLessThanOrEqual(2);
    }
    // The live scene kept its one canvas, and so its context, through every change.
    expect(await page.evaluate(() => (document.querySelector('[data-fc-fx-layer] canvas') as unknown as { __same?: boolean }).__same)).toBe(true);
    await expectOne();
    expect(made).toBeGreaterThan(0);
    expect(await status()).toBe('live');
    expect(crashes).toEqual([]);
  });

  it('follows the box to the frame it is picked in, and moves to another box, one context at a time', async () => {
    await open();
    await editor((api) => api.startFxLive('fxa', 0));
    await waitLive();
    await editor((api) => api.selectIn('fxa', 1));
    await expect.poll(async () => (await drawn())[0]?.frame, { timeout: 30_000 }).toBe(1);
    await waitLive();
    await expectOne();
    expect(await drawn()).toEqual([{ frame: 1, box: 'fxa', preview: false, state: 'live' }]);

    await editor((api) => api.startFxLive('fxb', 2));
    await expect.poll(async () => (await drawn())[0]?.box, { timeout: 30_000 }).toBe('fxb');
    await waitLive();
    await expectOne();
    expect(await drawn()).toEqual([{ frame: 2, box: 'fxb', preview: false, state: 'live' }]);
    expect(crashes).toEqual([]);
  });

  it('a box that was not picked in a frame is drawn in one frame only', async () => {
    await open();
    await editor((api) => api.startFxLive('fxa', null));
    await waitLive();
    await expectOne();
    expect((await drawn()).map((layer) => layer.box)).toEqual(['fxa']);
    expect(crashes).toEqual([]);
  });

  it('the preview over the editor draws the scene itself and the canvas gives its context up; closing it gives it back', async () => {
    await open();
    await editor((api) => api.startFxLive('fxa', 0));
    await waitLive();
    await editor((api) => api.setPreviewOpen(true));
    await expect.poll(async () => (await drawn()).map((layer) => `${layer.preview}:${layer.state}`), { timeout: 30_000 }).toEqual(['true:live']);
    await expectOne();
    // The second scene of the page stays calm in the preview, as on the published page.
    const states = await page.evaluate(() => [...document.querySelectorAll('[data-preview-frame] [data-fc-fx-layer]')].map((layer) => layer.getAttribute('data-fc-fx-state')));
    expect(states).toEqual(['live', 'calm']);

    await editor((api) => api.setPreviewOpen(false));
    await expect.poll(async () => (await drawn()).map((layer) => `${layer.preview}:${layer.state}`), { timeout: 30_000 }).toEqual(['false:live']);
    await expectOne();
    expect(crashes).toEqual([]);
  });

  it('Live off releases the context and leaves the box as it was', async () => {
    await open();
    const before = await page.evaluate(() => (document.querySelector('[data-viewport-content-id] [data-inner-component-id="fxa"]') as HTMLElement).getAttribute('style'));
    await editor((api) => api.startFxLive('fxa', 0));
    await waitLive();
    await editor((api) => api.stopFxLive());
    await expect.poll(canvases).toBe(0);
    await expect.poll(liveContexts, { timeout: 60_000 }).toBe(0);
    expect(await page.locator('[data-fc-fx-layer]').count()).toBe(0);
    expect(await status()).toBe('idle');
    expect(await page.evaluate(() => (document.querySelector('[data-viewport-content-id] [data-inner-component-id="fxa"]') as HTMLElement).getAttribute('style'))).toBe(before);
    expect(crashes).toEqual([]);
  });

  it('when the context is lost, the panel is told why and the box shows its background', async () => {
    await open();
    await editor((api) => api.startFxLive('fxa', 0));
    await waitLive();
    await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-fc-fx-layer] canvas')!;
      const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext;
      gl.getExtension('WEBGL_lose_context')!.loseContext();
    });
    await expect.poll(status, { timeout: 10_000 }).toBe('off:context-lost');
    await expect.poll(canvases).toBe(0);
    expect(warnings).toHaveLength(1);
    // Off and on again starts it afresh.
    await editor((api) => api.stopFxLive());
    await editor((api) => api.startFxLive('fxa', 0));
    await waitLive();
    await expectOne();
    expect(crashes).toEqual([]);
  });

  it('a scene the reader refuses is not drawn, says so, and draws again once it is replaced', async () => {
    await open();
    await editor((api) => api.startFxLive('fxa', 0));
    await waitLive();
    await editor((api, arg) => api.setFx('fxa', arg), { version: 99 });
    await expect.poll(canvases).toBe(0);
    await expect.poll(liveContexts, { timeout: 60_000 }).toBe(0);
    await editor((api, arg) => api.setFx('fxa', arg), SCENE);
    await waitLive();
    await expectOne();
    expect(crashes).toEqual([]);
  });
});
