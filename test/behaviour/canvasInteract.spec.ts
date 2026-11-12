// The Interact tool, slice B10 of docs/plans/2026-11-02-behaviour-model.md ("Interact: the
// page runs, in the frame"). The real editor, bundled for a plain page
// (test/score/lib/canvasBundle.ts), in real Chromium and WebKit, with a real pointer, real
// keys and a real finger, and no `dispatchEvent` anywhere: a script that sends an event
// proves nothing about a person. The tool is entered and left with the toolbar's own button.
//
//   - Each frame runs the page with its own state, nothing is selected or moved, and nothing
//     the page does reaches the project or its undo history.
//   - Keys in a frame are the page's. Escape outside a frame, and Shift+Escape from anywhere,
//     also from a modal holding the focus, return to Select.
//   - Ids across frames, links, a form, a wheel over a scroller, and the landmark change.
//   - The four paths of a stateful flow: forward, back (an edit while it runs, then undo),
//     resume (a new editor is on Select, at first values) and re-entry (leaving and entering
//     again, or another page, starts from first values).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type BrowserType, type Locator, type Page } from 'playwright';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { bundleEditor, enterInteract, openEditor, placeTree } from '../score/lib/canvasBundle';

const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

const node = (id: string, type: string, props: Record<string, unknown> = {}, ...children: ComponentNode[]): ComponentNode => ({ id, type, props, children });

/** One page holding every case: a disclosure by stored behaviour, and what the frame handles. */
const page = (): ComponentNode =>
  node(
    'item',
    'div',
    { behaviour: { state: [{ id: 'open', name: 'Open', type: 'boolean', initial: false }] } },
    node('btn', 'button', {
      type: 'button',
      children: 'Details',
      behaviour: { on: [{ id: 't1', on: 'click', do: [{ toggle: 'open' }] }], bind: [{ attr: 'aria-expanded', from: { get: 'open' } }] },
    }),
    node('panel', 'div', { children: 'The details', behaviour: { showWhen: { state: 'open', eq: true } } }),
    // Near the top, so at 390 pixels it is on the screen above the phone's bar, whatever the fonts.
    node(
      'scroller',
      'div',
      { style: { height: '60px', width: '200px', overflow: 'auto' } },
      ...[0, 1, 2].map((index) => node(`row-${index}`, 'div', { children: `Row ${index}`, style: { height: '60px' } })),
    ),
    node('more', 'details', {}, node('more-summary', 'summary', { children: 'More' }), node('more-body', 'p', { children: 'Inside more' })),
    node('agree', 'input', { id: 'agree', type: 'checkbox' }),
    node('agree-label', 'label', { htmlFor: 'agree', children: 'Agree' }),
    node('name-label', 'label', { htmlFor: 'name', children: 'Name' }),
    node('name', 'input', { id: 'name', type: 'text' }),
    node('about-link', 'a', { href: '/about', children: 'About' }),
    node('away-link', 'a', { href: 'https://away.test/page', children: 'Away' }),
    node('jump', 'a', { href: '#target', children: 'Jump' }),
    // As wide as its word, so a double press at its centre lands on the text.
    node('target', 'p', { id: 'target', children: 'Target', style: { width: 'fit-content' } }),
    node('sheet', 'form', { action: '/sink' }, node('q', 'input', { type: 'text', name: 'q', 'aria-label': 'Query' }), node('send', 'button', { type: 'submit', children: 'Send' })),
    node('show', 'button', { type: 'button', children: 'Show dialog', behaviour: { on: [{ id: 't2', on: 'click', do: [{ dialog: 'dlg', op: 'showModal' }] }] } }),
    node('dlg', 'dialog', { id: 'dlg' }, node('inside', 'button', { type: 'button', children: 'Inside' })),
    node('hoverer', 'p', {
      children: 'Hover me',
      style: { color: 'rgb(255, 0, 0)', width: 'fit-content' },
      rules: [
        { id: 'k', define: '@keyframes b10-spin', blocks: [{ selector: 'from', style: { opacity: '0.5' } }, { selector: 'to', style: { opacity: '1' } }] },
        { id: 'h', selector: '&:hover', style: { color: 'rgb(0, 0, 255)' } },
        { id: 'a', selector: '&', style: { animation: 'b10-spin 2s linear infinite' } },
      ],
    }),
  );

interface EditorWindow {
  __editor: {
    setBehaviour: (id: string, behaviour: Record<string, unknown> | undefined) => void;
    undo: () => void;
    previewState: () => Record<string, unknown>;
    undoLevels: () => number;
    setPreviewValue: (stateId: string, value: string | number | boolean | undefined) => void;
    tool: () => string;
    selectedId: () => string | undefined;
    projectJson: () => string;
    addPage: (title: string) => string;
    pageSlug: () => string | undefined;
    notice: () => string | undefined;
  };
}

const editor = <T,>(page: Page, call: (api: EditorWindow['__editor']) => T): Promise<T> =>
  page.evaluate((source) => new Function('api', `return (${source})(api)`)((window as unknown as EditorWindow).__editor), call.toString()) as Promise<T>;

/**
 * Resolves once a scroller has stopped moving: its position is the same over 200 ms of frames in a row. The
 * browser's own `scrollend` would say it too, but only for a scroll that is still running when it is asked.
 */
const scrollAtRest = (scroller: Locator) =>
  scroller.evaluate(
    (el) =>
      new Promise<void>((resolve) => {
        let last = el.scrollTop;
        let since = performance.now();
        const look = () => {
          const now = performance.now();
          if (el.scrollTop !== last) {
            last = el.scrollTop;
            since = now;
          }
          if (now - since >= 200) resolve();
          else requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
      }),
  );

const displays = (copies: Locator) => copies.evaluateAll((els) => els.map((el) => getComputedStyle(el).display));
const camera = (page: Page) => page.locator('[data-camera-transform]').getAttribute('data-camera-transform');

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

  async function mount(options: Parameters<Browser['newPage']>[0] = {}, tree = page()) {
    const opened = await openEditor(browser, bundle, options);
    await placeTree(opened.page, opened.crashes, tree, { allFrames: true });
    return opened;
  }

  const inFrames = (page: Page, id: string) => page.locator(`[data-viewport-content-id] [data-inner-component-id="${id}"]`);
  const frames = (page: Page) => page.locator('[data-viewport-content-id]');

  /** The toolbar's own button, pressed. */
  const enterSelect = (page: Page) => page.getByRole('button', { name: 'Select (V)' }).click();

  /** A wheel over the first frame, where nothing scrolls: it pans the camera, as in every tool. */
  async function panToSecondFrame(page: Page) {
    const first = await frames(page).first().boundingBox();
    const second = await frames(page).nth(1).boundingBox();
    if (!first || !second) throw new Error('the frames have no box');
    await page.mouse.move(first.x + 300, first.y + 600);
    await page.mouse.wheel(second.x - first.x, 0);
    await expect.poll(async () => (await frames(page).nth(1).boundingBox())?.x ?? 0).toBeLessThan(first.x + 1);
  }

  it('forward: each frame runs the page with its own state, nothing is selected, and nothing reaches the project', async () => {
    const { page, crashes } = await mount();
    const count = await frames(page).count();
    expect(count).toBeGreaterThan(1);
    // Select first: a press selects, and runs nothing.
    await inFrames(page, 'btn').first().click();
    expect(await editor(page, (api) => api.selectedId())).toBe('btn');
    expect(await displays(inFrames(page, 'panel'))).toEqual(Array(count).fill('none'));
    const project = await editor(page, (api) => api.projectJson());
    const undo = await editor(page, (api) => api.undoLevels());

    const overlay = page.getByTestId('primary-selection-overlay');
    await expect.poll(() => overlay.isVisible()).toBe(true);
    await enterInteract(page);
    expect(await editor(page, (api) => api.tool())).toBe('interact');
    // The HUD lets go of the selection while the page runs, and the toolbar says which tool.
    await expect.poll(() => overlay.isVisible()).toBe(false);
    expect(await page.getByRole('button', { name: 'Interact' }).getAttribute('aria-pressed')).toBe('true');
    await inFrames(page, 'btn').first().click();
    expect(await displays(inFrames(page, 'panel'))).toEqual(['block', ...Array(count - 1).fill('none')]);
    expect(await inFrames(page, 'btn').first().getAttribute('aria-expanded')).toBe('true');

    await panToSecondFrame(page);
    await inFrames(page, 'btn').nth(1).click();
    expect(await displays(inFrames(page, 'panel'))).toEqual(['block', 'block', ...Array(count - 2).fill('none')]);
    await inFrames(page, 'btn').nth(1).click();
    expect(await displays(inFrames(page, 'panel'))).toEqual(['block', ...Array(count - 1).fill('none')]);

    // Nothing was selected, moved or written.
    expect(await editor(page, (api) => api.selectedId())).toBe('btn');
    expect(await overlay.isVisible()).toBe(false);
    expect(await editor(page, (api) => api.projectJson())).toBe(project);
    expect(await editor(page, (api) => api.undoLevels())).toBe(undo);
    expect(crashes).toEqual([]);
    await page.close();
  });

  it('keys in a frame are the page\'s; Escape outside a frame returns to Select', async () => {
    const { page, crashes } = await mount();
    await enterInteract(page);
    const button = inFrames(page, 'btn').first();
    const before = await camera(page);
    await button.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => button.getAttribute('aria-expanded')).toBe('true');
    // Space presses the button, it does not pan.
    await page.keyboard.press('Space');
    await expect.poll(() => button.getAttribute('aria-expanded')).toBe('false');
    expect(await camera(page)).toBe(before);
    // Tab moves through the page as on any page.
    await page.keyboard.press(TAB);
    expect(await button.evaluate((el) => el === document.activeElement)).toBe(false);

    // A letter typed into a field is typed, not a tool shortcut.
    await inFrames(page, 'name').first().click();
    await page.keyboard.type('vh');
    expect(await inFrames(page, 'name').first().inputValue()).toBe('vh');
    // Text in the page can be selected, which the canvas otherwise takes away.
    await inFrames(page, 'target').first().dblclick();
    expect(await page.evaluate(() => getSelection()?.toString().trim())).toBe('Target');
    expect(await editor(page, (api) => api.tool())).toBe('interact');
    // Escape in a frame is the page's.
    await inFrames(page, 'name').first().focus();
    await page.keyboard.press('Escape');
    expect(await editor(page, (api) => api.tool())).toBe('interact');

    // Outside every frame, Escape is the editor's: back to Select.
    const box = await frames(page).first().boundingBox();
    if (!box) throw new Error('the frame has no box');
    await page.mouse.click(box.x + 20, box.y + box.height + 30);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => editor(page, (api) => api.tool())).toBe('select');
    expect(crashes).toEqual([]);
    await page.close();
  });

  it('Shift+Escape leaves from a modal holding the focus; plain Escape closes it as the page would', async () => {
    const { page, crashes } = await mount();
    await enterInteract(page);
    const dialog = inFrames(page, 'dlg').first();
    await inFrames(page, 'show').first().click();
    await expect.poll(() => dialog.evaluate((el) => (el as HTMLDialogElement).open && el.matches(':modal'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => dialog.evaluate((el) => (el as HTMLDialogElement).open)).toBe(false);
    expect(await editor(page, (api) => api.tool())).toBe('interact');

    await inFrames(page, 'show').first().click();
    await expect.poll(() => dialog.evaluate((el) => el.matches(':modal'))).toBe(true);
    await inFrames(page, 'inside').first().focus();
    await page.keyboard.press('Shift+Escape');
    await expect.poll(() => editor(page, (api) => api.tool())).toBe('select');
    expect(await page.locator('dialog[open]').count()).toBe(0);
    // The editor is not inert: its own button takes a real press again.
    await enterInteract(page);
    expect(crashes).toEqual([]);
    await page.close();
  });

  it('a dialog closes from its own dialog form, by the form method or the button\'s formmethod, and nothing is refused', async () => {
    const opener = (id: string, dialog: string) =>
      node(id, 'button', { type: 'button', children: `Open ${dialog}`, behaviour: { on: [{ id: `o-${id}`, on: 'click', do: [{ dialog, op: 'showModal' }] }] } });
    const tree = node(
      'dialogs',
      'div',
      {},
      opener('open-a', 'dlg-a'),
      node('dlg-a', 'dialog', { id: 'dlg-a' }, node('form-a', 'form', { method: 'dialog' }, node('ok-a', 'button', { type: 'submit', value: 'ok-a', children: 'OK' }))),
      opener('open-b', 'dlg-b'),
      node('dlg-b', 'dialog', { id: 'dlg-b' }, node('form-b', 'form', {}, node('ok-b', 'button', { type: 'submit', formMethod: 'dialog', value: 'ok-b', children: 'Done' }))),
    );
    const { page, crashes } = await mount({}, tree);
    await enterInteract(page);
    for (const id of ['a', 'b']) {
      const dialog = inFrames(page, `dlg-${id}`).first();
      await inFrames(page, `open-${id}`).first().click();
      await expect.poll(() => dialog.evaluate((el) => el.matches(':modal'))).toBe(true);
      await inFrames(page, `ok-${id}`).first().click();
      // The browser's own dialog submission closes it, and hands it the button's value.
      await expect.poll(() => dialog.evaluate((el) => (el as HTMLDialogElement).open)).toBe(false);
      expect(await dialog.evaluate((el) => (el as HTMLDialogElement).returnValue)).toBe(`ok-${id}`);
    }
    expect(await editor(page, (api) => api.notice())).toBeUndefined();
    expect(await editor(page, (api) => api.tool())).toBe('interact');
    expect(crashes).toEqual([]);
    await page.close();
  });

  it('re-entry: leaving resets what the page changed natively, and entering again starts from first values', async () => {
    const { page, crashes } = await mount();
    await enterInteract(page);
    await inFrames(page, 'more-summary').first().click();
    await inFrames(page, 'btn').first().click();
    expect(await inFrames(page, 'more').first().evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
    expect(await inFrames(page, 'btn').first().getAttribute('aria-expanded')).toBe('true');

    await enterSelect(page);
    expect(await editor(page, (api) => api.tool())).toBe('select');
    expect(await inFrames(page, 'more').first().evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
    expect(await inFrames(page, 'btn').first().getAttribute('aria-expanded')).toBe('false');
    expect(new Set(await displays(inFrames(page, 'panel')))).toEqual(new Set(['none']));

    await enterInteract(page);
    expect(await inFrames(page, 'btn').first().getAttribute('aria-expanded')).toBe('false');
    await inFrames(page, 'btn').first().click();
    expect((await displays(inFrames(page, 'panel')))[0]).toBe('block');
    expect(crashes).toEqual([]);
    await page.close();
  });

  it('a Select preview ends on entering: the page runs from its real first values', async () => {
    const { page, crashes } = await mount();
    await editor(page, (api) => api.setPreviewValue('open', true));
    await expect.poll(async () => (await displays(inFrames(page, 'panel')))[0]).toBe('block');
    await enterInteract(page);
    expect(await editor(page, (api) => api.previewState())).toEqual({});
    expect(new Set(await displays(inFrames(page, 'panel')))).toEqual(new Set(['none']));
    expect(crashes).toEqual([]);
    await page.close();
  });

  it('back: an edit while it runs restarts the page, and one undo puts it back', async () => {
    const { page, crashes } = await mount();
    await enterInteract(page);
    await inFrames(page, 'btn').first().click();
    expect((await displays(inFrames(page, 'panel')))[0]).toBe('block');
    // Deleting the state, as the panel would: the Show when refers to nothing, so the panel shows.
    await editor(page, (api) => api.setBehaviour('item', undefined));
    await expect.poll(async () => new Set(await displays(inFrames(page, 'panel')))).toEqual(new Set(['block']));
    await editor(page, (api) => api.undo());
    await expect.poll(async () => new Set(await displays(inFrames(page, 'panel')))).toEqual(new Set(['none']));
    // The runtime runs the restored program.
    await expect.poll(() => frames(page).first().getAttribute('data-surface-running')).toBe('');
    await inFrames(page, 'btn').first().click();
    await expect.poll(async () => (await displays(inFrames(page, 'panel')))[0]).toBe('block');
    expect(crashes).toEqual([]);
    await page.close();
  });

  it('the sheet runs too: a pointer state follows the real pointer and an animation plays, which Select holds still', async () => {
    const { page, crashes } = await mount();
    const hoverer = inFrames(page, 'hoverer').first();
    const looks = () => hoverer.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).animationDuration]);
    await hoverer.hover();
    expect(await looks()).toEqual(['rgb(255, 0, 0)', '0s']);
    await enterInteract(page);
    await inFrames(page, 'target').first().hover();
    await expect.poll(looks).toEqual(['rgb(255, 0, 0)', '2s']);
    await hoverer.hover();
    await expect.poll(looks).toEqual(['rgb(0, 0, 255)', '2s']);
    await enterSelect(page);
    await hoverer.hover();
    await expect.poll(looks).toEqual(['rgb(255, 0, 0)', '0s']);
    expect(crashes).toEqual([]);
    await page.close();
  });

  it('resume: a new editor is on Select, at first values', async () => {
    const first = await mount();
    await enterInteract(first.page);
    await inFrames(first.page, 'btn').first().click();
    await first.page.close();
    const again = await mount();
    expect(await editor(again.page, (api) => api.tool())).toBe('select');
    expect(new Set(await displays(inFrames(again.page, 'panel')))).toEqual(new Set(['none']));
    await again.page.close();
  });

  it('ids resolve inside the frame that was pressed', async () => {
    const { page, crashes } = await mount();
    await enterInteract(page);
    // In the first frame the browser's own resolution is right, and stays the browser's.
    const checked = () => inFrames(page, 'agree').evaluateAll((els) => els.map((el) => (el as HTMLInputElement).checked));
    await inFrames(page, 'agree-label').nth(0).click();
    await expect.poll(async () => (await checked())[0]).toBe(true);
    // A label in the second frame presses the checkbox of its own frame, not the first one's.
    await panToSecondFrame(page);
    await inFrames(page, 'agree-label').nth(1).click();
    await expect.poll(async () => (await checked())[1]).toBe(true);
    expect((await checked())[0]).toBe(true);
    await inFrames(page, 'agree-label').nth(1).click();
    await expect.poll(async () => (await checked())[1]).toBe(false);
    expect((await checked())[0]).toBe(true);
    await inFrames(page, 'name-label').nth(1).click();
    await expect.poll(() => inFrames(page, 'name').nth(1).evaluate((el) => el === document.activeElement)).toBe(true);
    expect(crashes).toEqual([]);
    await page.close();
  });

  it('links: a site path opens that page, an outside address a new tab, an anchor stays; a form does not send', async () => {
    const { page, crashes } = await mount();
    await page.context().route('https://away.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>Away</title>' }));
    // The harness page is not a secure context, which the editor's ids need: a stand-in for the test only.
    await page.evaluate(() => {
      if (!crypto.randomUUID) Object.assign(crypto, { randomUUID: () => `${Date.now()}-${Math.random().toString(16).slice(2)}-4000-8000-000000000000` });
    });
    await editor(page, (api) => api.addPage('About'));
    await enterInteract(page);
    const editorUrl = page.url();

    await inFrames(page, 'jump').first().click();
    expect(page.url()).toBe(`${editorUrl}#target`);
    expect(await editor(page, (api) => api.tool())).toBe('interact');

    const [tab] = await Promise.all([page.context().waitForEvent('page'), inFrames(page, 'away-link').first().click()]);
    await tab.waitForLoadState();
    expect(tab.url()).toBe('https://away.test/page');
    await tab.close();
    expect(page.url()).toBe(`${editorUrl}#target`);

    await inFrames(page, 'send').first().click();
    await expect.poll(() => editor(page, (api) => api.notice())).toContain('does not send');
    expect(page.url()).toBe(`${editorUrl}#target`);

    await inFrames(page, 'about-link').first().click();
    await expect.poll(() => editor(page, (api) => api.pageSlug())).toBe('about');
    expect(await editor(page, (api) => api.tool())).toBe('interact');
    // The editor itself stayed: same document, only its `?page=` follows the page shown.
    expect(new URL(page.url()).pathname).toBe(new URL(editorUrl).pathname);
    expect(new URL(page.url()).origin).toBe(new URL(editorUrl).origin);
    expect(crashes).toEqual([]);
    await page.close();
  });

  it('a wheel over a scroller in the page scrolls it; over the rest of the page it pans', async () => {
    const { page, crashes } = await mount();
    await enterInteract(page);
    const scroller = inFrames(page, 'scroller').first();
    const before = await camera(page);
    await scroller.hover();
    await page.mouse.wheel(0, 50);
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await camera(page)).toBe(before);
    await inFrames(page, 'target').first().hover();
    await page.mouse.wheel(0, 50);
    await expect.poll(() => camera(page)).not.toBe(before);
    expect(crashes).toEqual([]);
    await page.close();
  });

  it('landmarks: a header in the page is a banner in Interact, and the editor keeps its main outside it', async () => {
    const tree = node('marks', 'div', {}, node('top', 'header', { children: 'Top' }), node('content', 'main', { children: 'Content' }));
    const { page, crashes } = await mount({}, tree);
    const frame = frames(page).first();
    expect(await page.getByRole('main').first().evaluate((el) => el.hasAttribute('data-viewport-content-id') || el.tagName)).not.toBe('MAIN');
    expect(await frame.getByRole('banner').count()).toBe(0);
    await enterInteract(page);
    expect(await frame.getByRole('banner').count()).toBe(1);
    await enterSelect(page);
    expect(await frame.getByRole('banner').count()).toBe(0);
    expect(crashes).toEqual([]);
    await page.close();
  });

  it('at 390 pixels, a finger enters Interact, runs the page, and leaves', async () => {
    const { page, crashes } = await mount(PHONE);
    const bar = page.getByTestId('phone-bottom-bar');
    await bar.getByRole('button', { name: 'Interact' }).tap();
    await expect.poll(() => frames(page).evaluateAll((els) => els.every((el) => el.hasAttribute('data-surface-running')))).toBe(true);
    // The phone opens fitted to its own frame, the last one.
    const button = inFrames(page, 'btn').last();
    const panel = inFrames(page, 'panel').last();
    await button.tap();
    await expect.poll(() => panel.evaluate((el) => getComputedStyle(el).display)).toBe('block');
    await button.tap();
    await expect.poll(() => panel.evaluate((el) => getComputedStyle(el).display)).toBe('none');
    expect(await editor(page, (api) => api.selectedId())).not.toBe('btn');
    // A finger's pan over a scroller in the page scrolls it, through the browser's own
    // gesture pipeline. Chromium only: Playwright has no touch drag for WebKit.
    if (name === 'chromium') {
      const scroller = inFrames(page, 'scroller').last();
      const box = await scroller.boundingBox();
      if (!box) throw new Error('the scroller has no box');
      // At its centre: near an edge, Chromium's touch adjustment would move the finger to
      // the clickable summary below it.
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      // The finger has to land on the scroller itself, not off the screen or on the editor's bar.
      expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-inner-component-id="scroller"]'), point)).toBe(true);
      const before = await camera(page);
      // Real touch events at the browser's input layer, the one Playwright's own tap uses,
      // not a DOM dispatchEvent: Chromium turns them into a scroll as it does a finger's.
      // Not Input.synthesizeScrollGesture: its touch source scrolls nothing in headless
      // Chromium on Linux, even on a bare page.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      for (let step = 1; step <= 8; step++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y - step * 5 }] });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      expect(await camera(page)).toBe(before);
      // The finger left the scroller moving, so it coasts on for a moment. A person lets it stop before
      // pressing something else, and so does this: Chromium on Linux takes a tap that lands on a coasting
      // scroll as "stop", not as a press, wherever on the screen it lands. Chromium on macOS does not, which
      // is why this only ever failed in continuous integration. Measured in Linux Chromium with this editor
      // and these steps: without the wait the tool stayed on Interact in 21 of 25 runs, with it in 0 of 25
      // (on a bare page with no editor: 11 of 30 against 0 of 30).
      await scrollAtRest(scroller);
    }
    await bar.getByRole('button', { name: 'Select tool' }).tap();
    // Polled: the tool changes on the tap's handler, which can land after the tap resolves.
    await expect.poll(() => editor(page, (api) => api.tool())).toBe('select');
    expect(crashes).toEqual([]);
    await page.close();
  });
});
