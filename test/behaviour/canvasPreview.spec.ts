// Page state on the editor's two surfaces, slice B9 of docs/plans/2026-11-02-behaviour-model.md
// ("The editor canvas"). The real editor, bundled for a plain page (test/score/lib/canvasBundle.ts),
// in real Chromium and WebKit, with a real pointer, real keys and a real finger, and no
// `dispatchEvent` anywhere: a script that sends an event proves nothing about a person.
//
//   - Select runs nothing. A Show when hides its node on every frame, picking that layer in
//     Layers previews the state that shows it, on every frame, and the notice names it.
//   - The preview runs the page: a press in it flips the state, and the rule reading it follows.
//   - The four paths of a stateful flow: forward, back (a deleted state, then undo), resume
//     (a new editor is at first values) and re-entry (the preview opens at first values again).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type BrowserType, type Locator, type Page } from 'playwright';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { bundleEditor, openEditor, placeTree } from '../score/lib/canvasBundle';

const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

const STATE = { state: [{ id: 'open', name: 'Open', type: 'boolean', initial: false }] };

/** A disclosure: the button flips the state, the panel shows while it holds and turns green by a rule. */
const disclosure = (): ComponentNode => ({
  id: 'item',
  type: 'div',
  props: { behaviour: STATE },
  children: [
    {
      id: 'btn',
      type: 'button',
      props: {
        type: 'button',
        children: 'Details',
        behaviour: { on: [{ id: 't1', on: 'click', do: [{ toggle: 'open' }] }], bind: [{ attr: 'aria-expanded', from: { get: 'open' } }] },
      },
    },
    {
      id: 'panel',
      type: 'div',
      props: {
        children: 'The details',
        style: { color: 'rgb(255, 0, 0)' },
        rules: [{ id: 'r1', selector: '&', when: { state: 'open', eq: true }, style: { color: 'rgb(0, 128, 0)' } }],
        behaviour: { showWhen: { state: 'open', eq: true } },
      },
    },
  ],
});

interface EditorWindow {
  __editor: {
    setBehaviour: (id: string, behaviour: Record<string, unknown> | undefined) => void;
    undo: () => void;
    previewState: () => Record<string, unknown>;
    undoLevels: () => number;
    setPreviewOpen: (open: boolean) => void;
  };
}

const editor = <T,>(page: Page, call: (api: EditorWindow['__editor']) => T): Promise<T> =>
  page.evaluate((source) => new Function('api', `return (${source})(api)`)((window as unknown as EditorWindow).__editor), call.toString()) as Promise<T>;

const displays = (copies: Locator) => copies.evaluateAll((els) => els.map((el) => getComputedStyle(el).display));
const colors = (copies: Locator) => copies.evaluateAll((els) => els.map((el) => getComputedStyle(el).color));

let bundle: string;

beforeAll(async () => {
  bundle = await bundleEditor();
}, 120_000);

describe.each(ENGINES)('in %s', (name, engine) => {
  let browser: Browser;
  // Playwright's WebKit moves Tab between controls only with Alt held, as Safari does.
  const TAB = name === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';

  beforeAll(async () => {
    browser = await engine.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function mount(options: Parameters<Browser['newPage']>[0] = {}) {
    const { page, crashes } = await openEditor(browser, bundle, options);
    await placeTree(page, crashes, disclosure(), { allFrames: true });
    return { page, crashes };
  }

  const canvasPanels = (page: Page) => page.locator('[data-viewport-content-id] [data-inner-component-id="panel"]');
  const canvasButtons = (page: Page) => page.locator('[data-viewport-content-id] [data-inner-component-id="btn"]');

  it('Select runs nothing: the panel is hidden on every frame, and a press on the button only selects it', async () => {
    const { page, crashes } = await mount();
    const frames = await page.locator('[data-viewport-content-id]').count();
    expect(frames).toBeGreaterThan(1);
    expect(await displays(canvasPanels(page))).toEqual(Array(frames).fill('none'));
    expect(await canvasButtons(page).evaluateAll((els) => els.map((el) => el.getAttribute('aria-expanded')))).toEqual(Array(frames).fill('false'));
    await canvasButtons(page).first().click();
    expect(await displays(canvasPanels(page))).toEqual(Array(frames).fill('none'));
    expect(await editor(page, (api) => api.previewState())).toEqual({});
    expect(crashes).toEqual([]);
    await page.close();
  });

  it('forward: picking the hidden layer in Layers shows it on every frame, at the state that shows it, and names it', async () => {
    const { page, crashes } = await mount();
    const frames = await page.locator('[data-viewport-content-id]').count();
    const undoBefore = await editor(page, (api) => api.undoLevels());
    await page.locator('[data-layer-row="panel"]').first().click();
    await expect.poll(() => displays(canvasPanels(page))).toEqual(Array(frames).fill('block'));
    expect(await colors(canvasPanels(page))).toEqual(Array(frames).fill('rgb(0, 128, 0)'));
    expect(await canvasButtons(page).evaluateAll((els) => els.map((el) => el.getAttribute('aria-expanded')))).toEqual(Array(frames).fill('true'));
    const notice = page.getByRole('status').filter({ hasText: 'Previewing Open' });
    expect(await notice.count()).toBe(1);
    // A preview is not an edit.
    expect(await editor(page, (api) => api.undoLevels())).toBe(undoBefore);

    // The badge's own control, by keyboard: focus reaches it and Enter ends the preview.
    const reset = page.getByRole('button', { name: 'Show first values' });
    await reset.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => displays(canvasPanels(page))).toEqual(Array(frames).fill('none'));
    expect(await editor(page, (api) => api.previewState())).toEqual({});
    expect(crashes).toEqual([]);
    await page.close();
  });

  it('back: a deleted state leaves the panel visible, the safe side, and one undo hides it again', async () => {
    const { page, crashes } = await mount();
    const frames = await page.locator('[data-viewport-content-id]').count();
    await editor(page, (api) => api.setBehaviour('item', undefined));
    await expect.poll(() => displays(canvasPanels(page))).toEqual(Array(frames).fill('block'));
    expect(await colors(canvasPanels(page))).toEqual(Array(frames).fill('rgb(255, 0, 0)'));
    await editor(page, (api) => api.undo());
    await expect.poll(() => displays(canvasPanels(page))).toEqual(Array(frames).fill('none'));
    expect(crashes).toEqual([]);
    await page.close();
  });

  it('resume: a new editor on the same page starts from first values', async () => {
    const first = await mount();
    await first.page.locator('[data-layer-row="panel"]').first().click();
    expect(await editor(first.page, (api) => api.previewState())).toEqual({ open: true });
    await first.page.close();
    const again = await mount();
    expect(await editor(again.page, (api) => api.previewState())).toEqual({});
    expect(new Set(await displays(canvasPanels(again.page)))).toEqual(new Set(['none']));
    await again.page.close();
  });

  it('the preview runs the page: a press, then keys, flip the state and the rule follows', async () => {
    const { page, crashes } = await mount();
    const undoBefore = await editor(page, (api) => api.undoLevels());
    await editor(page, (api) => api.setPreviewOpen(true));
    const frame = page.locator('[data-preview-frame]');
    const button = frame.locator('[data-inner-component-id="btn"]');
    const panel = frame.locator('[data-inner-component-id="panel"]');
    await button.waitFor();
    expect(await panel.evaluate((el) => getComputedStyle(el).display)).toBe('none');

    await button.click();
    await expect.poll(() => panel.evaluate((el) => getComputedStyle(el).display)).toBe('block');
    expect(await panel.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(0, 128, 0)');
    expect(await button.getAttribute('aria-expanded')).toBe('true');

    // Keyboard. Focus is placed, as a reader landing on it would have it, and the keys are
    // real presses: Enter and Space on a focused button are the browser's own activation.
    await button.focus();
    expect(await button.evaluate((el) => el === document.activeElement)).toBe(true);
    await page.keyboard.press('Enter');
    await expect.poll(() => button.getAttribute('aria-expanded')).toBe('false');
    expect(await panel.evaluate((el) => getComputedStyle(el).display)).toBe('none');
    await page.keyboard.press('Space');
    await expect.poll(() => button.getAttribute('aria-expanded')).toBe('true');
    // Tab moves on from it as on any page: the preview holds no key the page did not ask for.
    await page.keyboard.press(TAB);
    expect(await button.evaluate((el) => el === document.activeElement)).toBe(false);

    // Nothing the runtime did reached the page.
    expect(await editor(page, (api) => api.undoLevels())).toBe(undoBefore);
    expect(await editor(page, (api) => api.previewState())).toEqual({});

    // Re-entry: leaving the preview and opening it again starts from first values.
    await editor(page, (api) => api.setPreviewOpen(false));
    await editor(page, (api) => api.setPreviewOpen(true));
    const reopened = page.locator('[data-preview-frame] [data-inner-component-id="btn"]');
    await reopened.waitFor();
    expect(await reopened.getAttribute('aria-expanded')).toBe('false');
    expect(crashes).toEqual([]);
    await page.close();
  });

  it('at 390 pixels, a finger runs the preview', async () => {
    const { page, crashes } = await mount(PHONE);
    await editor(page, (api) => api.setPreviewOpen(true));
    const button = page.locator('[data-preview-frame] [data-inner-component-id="btn"]');
    const panel = page.locator('[data-preview-frame] [data-inner-component-id="panel"]');
    await button.waitFor();
    await button.tap();
    await expect.poll(() => panel.evaluate((el) => getComputedStyle(el).display)).toBe('block');
    await button.tap();
    await expect.poll(() => panel.evaluate((el) => getComputedStyle(el).display)).toBe('none');
    expect(crashes).toEqual([]);
    await page.close();
  });
});
