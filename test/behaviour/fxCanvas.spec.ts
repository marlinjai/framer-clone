// The FX scene on the editor's canvas and in its preview, in real Chromium and WebKit,
// on the real EditorApp (docs/plans/2026-11-08-lumitra-fx-in-sites.md, slice F5).
//
// The canvas shows every breakpoint side by side and a browser allows only a handful
// of WebGL contexts, so the promise this file keeps is ONE: at no moment does the
// editor hold more than one live context, whatever is switched, edited or opened.
// The contexts are counted in the page itself, at the one place a context is made
// (`HTMLCanvasElement.getContext`), so a context no element shows any more is still
// counted until it is released.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type BrowserType, type Page } from 'playwright';
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
  __fxContexts: { made: number; live: () => number };
}

/** Counts every WebGL context the page makes, and how many of them are still held. */
const countContexts = (page: Page) =>
  page.addInitScript(() => {
    const made: WebGLRenderingContext[] = [];
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
      const context = (original as (...args: unknown[]) => unknown).call(this, kind, ...rest);
      if (context && /^webgl/.test(kind) && !made.includes(context as WebGLRenderingContext)) made.push(context as WebGLRenderingContext);
      return context;
    } as typeof HTMLCanvasElement.prototype.getContext;
    (window as unknown as { __fxContexts: unknown }).__fxContexts = {
      get made() {
        return made.length;
      },
      live: () => made.filter((context) => !context.isContextLost()).length,
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

  const open = async () => {
    warnings = [];
    const opened = await openEditor(browser, bundle, {}, async (fresh) => {
      await countContexts(fresh);
      fresh.on('console', (message) => {
        if (message.type() === 'warning' && message.text().includes('FX scene')) warnings.push(message.text());
      });
    });
    ({ page, crashes } = opened);
    await placeTree(page, crashes, tree(), { allFrames: true });
  };

  const editor = <T,>(call: (api: FxEditorWindow['__editor'], arg: never) => T, arg?: unknown): Promise<T> =>
    page.evaluate(([source, value]) => new Function('api', 'arg', `return (${source})(api, arg)`)((window as unknown as FxEditorWindow).__editor, value), [call.toString(), arg] as const) as Promise<T>;
  const status = () => editor((api) => api.fxLiveStatus());
  const liveContexts = () => page.evaluate(() => (window as unknown as FxEditorWindow).__fxContexts.live());
  const madeContexts = () => page.evaluate(() => (window as unknown as FxEditorWindow).__fxContexts.made);
  const canvases = () => page.locator('canvas').count();
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
  /** One context, and it is the one on screen. */
  const expectOne = async () => {
    await expect.poll(liveContexts, { timeout: 10_000 }).toBe(1);
    expect(await canvases()).toBe(1);
  };

  it('draws nothing by default: every frame shows the box with its own background', async () => {
    await open();
    expect(await page.locator('[data-viewport-content-id]').count()).toBeGreaterThan(1);
    expect(await page.locator('[data-fc-fx-layer]').count()).toBe(0);
    expect(await canvases()).toBe(0);
    expect(await madeContexts()).toBe(0);
    expect(await status()).toBe('idle');
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
    await page.evaluate(() => ((document.querySelector('canvas') as unknown as { __same: boolean }).__same = true));
    let scene: unknown = SCENE;
    for (const intensity of [0.2, 1.4, 0.6, 1.1, 0.9]) {
      scene = stored(setFxParam(scene, 'bloom', 'intensity', intensity));
      await editor((api, arg) => api.setFx('fxa', arg), scene);
      await page.waitForTimeout(150);
      expect(await liveContexts()).toBe(1);
    }
    expect(await madeContexts()).toBe(made);
    expect(await page.evaluate(() => (document.querySelector('canvas') as unknown as { __same?: boolean }).__same)).toBe(true);
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
    await expect.poll(liveContexts, { timeout: 10_000 }).toBe(0);
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
      const canvas = document.querySelector('canvas')!;
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
    await expect.poll(liveContexts, { timeout: 10_000 }).toBe(0);
    await editor((api, arg) => api.setFx('fxa', arg), SCENE);
    await waitLive();
    await expectOne();
    expect(crashes).toEqual([]);
  });
});
