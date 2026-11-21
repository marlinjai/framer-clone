// The Page state panel and the Interactions section, slice B11 of
// docs/plans/2026-11-02-behaviour-model.md, in the real editor (test/score/lib/canvasBundle.ts)
// in real Chromium and WebKit, at the desktop width and in the 390 pixel phone layout, by
// pointer (a click or a finger) and by keyboard (focus, Enter, typed text). A person:
//
//   - picks the drawer and adds a value to the page, renames it, and makes the drawer show
//     only while the value is on;
//   - picks the button and adds an interaction the parser refuses (focus on a hover), reads
//     the parser's reason, changes it into a click that toggles the value, and saves it;
//   - renames the value and takes it back with the editor's Undo, one step;
//   - presses the button in Interact, where the drawer follows, and on the published page,
//     rendered by renderPublishedPage and run by the real runtime, where it follows too.
//
// By keyboard, focus is put on the first control of a step and the spec then moves with Tab
// (Alt+Tab in WebKit on a Mac, as in Safari) and Enter, asserting where the focus is: the
// new value's name after Add value, the Event field when the editor opens, Add interaction
// after a save. A native select is chosen with Playwright's selectOption in both modes, as
// no engine lets a script open its list. An element on the canvas is picked by pointer or
// finger in both modes: picking from the layers by keyboard is the layers panel's contract.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type BrowserType, type Locator, type Page } from 'playwright';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { BehaviourProgram } from '@/lib/behaviour/program';
import { bundleEditor, enterInteract, openEditor, placeTree } from '../score/lib/canvasBundle';
import { renderThroughPublishedPage } from '../score/lib/published';
import { bundleRuntime, runtimeScripts } from '../score/lib/runtime';

const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const LAYOUTS: [string, Parameters<Browser['newPage']>[0]][] = [['desktop', {}], ['phone', PHONE]];
const MODES = ['pointer', 'keyboard'] as const;
type Mode = (typeof MODES)[number];

/** Screenshots of each section at the panel's width, for a person to look at (ignored by git). */
const SHOTS = path.resolve('test/score/.out/behaviour-panel');

const node = (id: string, type: string, props: Record<string, unknown> = {}, ...children: ComponentNode[]): ComponentNode => ({ id, type, props, children });

const tree = (): ComponentNode =>
  node(
    'b11',
    'div',
    {},
    node('btn', 'button', { type: 'button', children: 'Menu' }),
    node('drawer', 'nav', { children: 'Links' }),
  );

interface EditorWindow {
  __editor: { projectJson: () => string; propsOf: (id: string) => Record<string, unknown> | undefined; undoLevels: () => number; tool: () => string };
}

const editor = <T,>(page: Page, call: (api: EditorWindow['__editor']) => T): Promise<T> =>
  page.evaluate((source) => new Function('api', `return (${source})(api)`)((window as unknown as EditorWindow).__editor), call.toString()) as Promise<T>;

/** The page's whole tree as stored, the one holding `b11`: the value is on the page root. */
function storedPage(json: string): ComponentNode {
  let found: ComponentNode | undefined;
  const walk = (value: unknown) => {
    if (found || !value || typeof value !== 'object') return;
    const record = value as { children?: unknown[] };
    if (Array.isArray(record.children) && record.children.some((child) => (child as { id?: string })?.id === 'b11')) {
      found = value as ComponentNode;
      return;
    }
    for (const child of Object.values(value)) walk(child);
  };
  walk(JSON.parse(json));
  if (!found) throw new Error('the stored project holds no page with the tree');
  return found;
}

/**
 * The texts in a section that are cut off: wider than their box where the box hides the rest.
 * Text kept only for screen readers (a live region in a 1 pixel box) is never shown, so it is not counted.
 */
const clipped = (section: Locator) =>
  section.evaluate((root) =>
    [...root.querySelectorAll('span, p, label, button, li')]
      .filter((el) => {
        const style = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        if (box.width <= 1 && box.height <= 1) return false;
        return style.overflow !== 'visible' && el.scrollWidth > el.clientWidth + 1;
      })
      .map((el) => el.textContent ?? ''),
  );

let bundle: string;
let runtime: string;

beforeAll(async () => {
  bundle = await bundleEditor();
  runtime = await bundleRuntime();
  fs.mkdirSync(SHOTS, { recursive: true });
}, 120_000);

describe.each(ENGINES)('in %s', (engineName, engine) => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await engine.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  // Playwright's WebKit moves Tab between controls only with Alt held, as Safari does.
  const TAB = engineName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';

  // A quote in a value's name once made the focus after "Keep it" build an invalid selector,
  // and the error took the whole editor down. By keyboard, at the desktop width.
  it('a value named with a quote can be deleted and kept, and the editor stays up', async () => {
    const { page, crashes } = await openEditor(browser, bundle, {});
    page.setDefaultTimeout(5000);
    await placeTree(page, crashes, tree());
    const isFocused = (target: Locator) => target.evaluate((el) => el === document.activeElement);
    await page.locator('[data-viewport-content-id] [data-inner-component-id="btn"]').first().click();
    const pageState = page.getByTestId('page-state-panel');
    const interactions = page.getByTestId('interactions-section');
    await expect.poll(() => interactions.count()).toBe(1);
    await pageState.getByRole('button', { name: 'Add a value to the page' }).focus();
    await page.keyboard.press('Enter');
    const name = pageState.getByLabel(/^Name of /).first();
    await expect.poll(() => isFocused(name)).toBe(true);
    await name.selectText();
    await page.keyboard.type('Say "hi"');
    await page.keyboard.press('Enter');
    await expect.poll(() => pageState.getByLabel('Name of Say "hi"').count()).toBe(1);
    // Something reads it, so deleting it asks first.
    await interactions.getByRole('button', { name: 'Add interaction' }).focus();
    await page.keyboard.press('Enter');
    await interactions.getByRole('button', { name: 'Add this interaction' }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => pageState.getByText(/^Read by one element/).count()).toBe(1);
    const row = pageState.locator('[data-state-id]').filter({ has: page.getByLabel('Name of Say "hi"') });
    await row.locator('button[data-delete-value]').focus();
    await page.keyboard.press('Enter');
    // The question takes the focus on Keep it, so Enter keeps the value.
    const question = pageState.getByRole('group', { name: 'Delete Say "hi"?' });
    await expect.poll(() => isFocused(question.getByRole('button', { name: 'Keep it' }))).toBe(true);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    expect(crashes).toEqual([]);
    expect(await page.getByTestId('page-state-panel').count()).toBe(1);
    expect(await page.locator('[data-viewport-content-id]').count()).toBeGreaterThan(0);
    await expect.poll(() => isFocused(row.locator('button[data-delete-value]'))).toBe(true);
    expect(await question.count()).toBe(0);
    expect(await pageState.getByLabel('Name of Say "hi"').count()).toBe(1);
    await page.close();
  }, 60_000);

  describe.each(LAYOUTS)('at the %s width', (layout, options) => {
    const phone = layout === 'phone';

    it.each(MODES)('by %s, a value and an interaction authored in the panel run in Interact and on the published page', async (mode: Mode) => {
      const { page, crashes } = await openEditor(browser, bundle, options);
      page.setDefaultTimeout(5000);
      await placeTree(page, crashes, tree(), { allFrames: phone });
      const bar = page.getByTestId('phone-bottom-bar');
      const sheet = page.getByTestId('properties-sheet');
      const inFrame = (id: string) => {
        // The phone opens fitted to its own frame, the last one.
        const copies = page.locator(`[data-viewport-content-id] [data-inner-component-id="${id}"]`);
        return phone ? copies.last() : copies.first();
      };

      const isFocused = (target: Locator) => target.evaluate((el) => el === document.activeElement);
      /** By keyboard: Tab (or Shift+Tab) until `target` has the focus, which proves it is reachable in that order. */
      const tabTo = async (target: Locator, back = false) => {
        for (let step = 0; step < 30; step++) {
          if (await isFocused(target)) return;
          await page.keyboard.press(back ? `Shift+${TAB}` : TAB);
        }
        throw new Error('Tab never reached the control');
      };
      /** A button the keyboard reaches with Tab from where the focus is, or the pointer presses. */
      const pressNext = async (target: Locator, back = false) => {
        if (mode === 'keyboard') {
          await tabTo(target, back);
          await page.keyboard.press('Enter');
        } else if (phone) await target.tap();
        else await target.click();
      };
      /** A select the keyboard reaches with Tab, then chosen. */
      const chooseNext = async (target: Locator, value: string, back = false) => {
        if (mode === 'keyboard') await tabTo(target, back);
        await target.selectOption(value);
      };

      /** A button pressed as the mode presses it. */
      const press = async (target: Locator) => {
        if (mode === 'keyboard') {
          await target.focus();
          await page.keyboard.press('Enter');
        } else if (phone) await target.tap();
        else await target.click();
      };
      /** Text typed into a field and committed with Enter. */
      const typeInto = async (field: Locator, text: string) => {
        if (mode === 'keyboard') await field.focus();
        else if (phone) await field.tap();
        else await field.click();
        await field.selectText();
        await page.keyboard.type(text);
        await page.keyboard.press('Enter');
      };
      /** Picks an element on the canvas, and on a phone opens its properties. */
      const pick = async (id: string) => {
        if (phone) {
          await inFrame(id).tap();
          await bar.getByRole('button', { name: /^Edit / }).tap();
          await sheet.waitFor({ state: 'visible' });
          const expand = sheet.getByRole('button', { name: 'Expand Properties' });
          if (await expand.count()) await expand.tap();
        } else {
          await inFrame(id).click();
        }
        await expect.poll(() => page.evaluate(() => document.querySelector('[data-testid="interactions-section"]') !== null)).toBe(true);
      };
      const closeSheet = async () => {
        if (phone) await sheet.getByRole('button', { name: 'Close Properties' }).tap();
      };
      const panel = () => (phone ? sheet : page);
      const pageState = () => panel().getByTestId('page-state-panel');
      const interactions = () => panel().getByTestId('interactions-section');

      // Forward: the drawer, a value on the page, renamed, and the drawer shown while it is on.
      await pick('drawer');
      await press(pageState().getByRole('button', { name: 'Add a value to the page' }));
      // The new value's name takes the focus, so it is typed straight away.
      const name = pageState().getByLabel(/^Name of /).first();
      await expect.poll(() => isFocused(name)).toBe(true);
      await name.selectText();
      await page.keyboard.type('Open');
      await page.keyboard.press('Enter');
      await expect.poll(() => pageState().getByLabel('Name of Open').count()).toBe(1);
      // A second value, a number, for a step action: its type changes only on the button.
      await press(pageState().getByRole('button', { name: 'Add a value to the page' }));
      const second = pageState().getByLabel(/^Name of Value/);
      await expect.poll(() => isFocused(second)).toBe(true);
      await second.selectText();
      await page.keyboard.type('Count');
      await page.keyboard.press('Enter');
      await chooseNext(pageState().getByLabel('Type of Count'), 'number');
      await pressNext(pageState().getByRole('button', { name: 'Change to Number' }));
      const countType = async () => {
        const state = ((storedPage(await editor(page, (api) => api.projectJson())).props?.behaviour as { state?: { name: string; type: string }[] } | undefined)?.state) ?? [];
        return state.find((entry) => entry.name === 'Count')?.type;
      };
      await expect.poll(countType).toBe('number');
      expect(await pageState().getByRole('button', { name: 'Change to Number' }).count()).toBe(0);
      const showWhen = interactions().getByLabel('Show when value');
      const valueId = await showWhen.locator('option', { hasText: 'Open' }).getAttribute('value');
      expect(valueId).toMatch(/^v-[a-z0-9]{8}$/);
      await showWhen.selectOption(valueId!);
      await expect.poll(() => editor(page, (api) => JSON.stringify(api.propsOf('drawer')?.behaviour))).toContain(valueId!);
      expect(await editor(page, (api) => api.propsOf('drawer')?.behaviour)).toMatchObject({ showWhen: { state: valueId, eq: true } });

      expect(await clipped(pageState())).toEqual([]);
      expect(await clipped(interactions())).toEqual([]);
      if (engineName === 'chromium' && mode === 'pointer') {
        await pageState().screenshot({ path: path.join(SHOTS, `${layout}-page-state.png`) });
        await interactions().screenshot({ path: path.join(SHOTS, `${layout}-interactions-show-when.png`) });
      }
      await closeSheet();

      // Backtrack: an interaction the parser refuses says why and writes nothing, and the same
      // draft, changed, is saved.
      await pick('btn');
      await press(interactions().getByRole('button', { name: 'Add interaction' }));
      const draft = interactions().getByRole('group', { name: 'Interaction' });
      // The editor takes the focus on its first field.
      await expect.poll(() => isFocused(draft.getByLabel('Event', { exact: true }))).toBe(true);
      await draft.getByLabel('Event', { exact: true }).selectOption('mouseenter');
      await chooseNext(draft.getByLabel('Action 1', { exact: true }), 'focus');
      // A step action, seen once so its Wrap around switch is checked for cut-off text, then taken out.
      await pressNext(draft.getByRole('button', { name: 'Add action' }));
      await chooseNext(draft.getByLabel('Action 2', { exact: true }), 'step', true);
      expect(await draft.getByRole('switch', { name: 'Wrap around in action 2' }).count()).toBe(1);
      expect(await clipped(interactions())).toEqual([]);
      if (engineName === 'chromium' && mode === 'pointer') await interactions().screenshot({ path: path.join(SHOTS, `${layout}-interactions-step.png`) });
      await pressNext(draft.getByRole('button', { name: 'Remove action 2' }));
      await pressNext(draft.getByRole('button', { name: 'Add this interaction' }));
      const refusal = draft.getByRole('alert');
      await expect.poll(() => refusal.textContent()).toMatch(/^Not saved: .+\.$/);
      expect(await editor(page, (api) => api.propsOf('btn')?.behaviour)).toBeUndefined();
      expect(await clipped(interactions())).toEqual([]);
      if (engineName === 'chromium' && mode === 'pointer') await interactions().screenshot({ path: path.join(SHOTS, `${layout}-interactions-refused.png`) });

      await chooseNext(draft.getByLabel('Event', { exact: true }), 'click', true);
      await chooseNext(draft.getByLabel('Action 1', { exact: true }), 'toggle');
      expect(await draft.getByLabel('Value to change in action 1').inputValue()).toBe(valueId);
      // A click can stop the browser's own response; its switch is named in full and its label is not cut off.
      expect(await draft.getByRole('switch', { name: "Stop the browser's own response" }).count()).toBe(1);
      expect(await clipped(interactions())).toEqual([]);
      await pressNext(draft.getByRole('button', { name: 'Add this interaction' }));
      await expect.poll(() => interactions().getByRole('button', { name: /^Edit: On click, toggle Open/ }).count()).toBe(1);
      // The focus is back on Add interaction, and the addition is announced.
      await expect.poll(() => isFocused(interactions().getByRole('button', { name: 'Add interaction' }))).toBe(true);
      expect(await interactions().getByRole('status').textContent()).toBe('Added: On click, toggle Open');
      expect(await editor(page, (api) => api.propsOf('btn')?.behaviour)).toMatchObject({ on: [{ on: 'click', do: [{ toggle: valueId }] }] });
      if (engineName === 'chromium' && mode === 'pointer') await interactions().screenshot({ path: path.join(SHOTS, `${layout}-interactions-saved.png`) });

      // Undo: a rename is one step, and the editor's own Undo takes it back.
      const levels = await editor(page, (api) => api.undoLevels());
      await typeInto(pageState().getByLabel('Name of Open'), 'Wrong');
      await expect.poll(() => pageState().getByLabel('Name of Wrong').count()).toBe(1);
      expect(await editor(page, (api) => api.undoLevels())).toBe(levels + 1);
      await closeSheet();
      await press(phone ? bar.getByRole('button', { name: 'Undo' }) : page.getByRole('button', { name: 'Undo', exact: true }));
      await expect.poll(() => editor(page, (api) => api.undoLevels())).toBe(levels);
      const project = await editor(page, (api) => api.projectJson());
      expect(project).toContain('"name":"Open"');
      expect(project).not.toContain('"name":"Wrong"');

      // Interact: the button runs the page in the frame.
      if (phone) {
        await bar.getByRole('button', { name: 'Interact' }).tap();
        await page.waitForFunction(() => [...document.querySelectorAll('[data-viewport-content-id]')].every((frame) => frame.hasAttribute('data-surface-running')));
      } else await enterInteract(page);
      const shown = () => inFrame('drawer').evaluate((el) => getComputedStyle(el).display);
      expect(await shown()).toBe('none');
      if (mode === 'keyboard') {
        await inFrame('btn').focus();
        await page.keyboard.press('Enter');
      } else if (phone) await inFrame('btn').tap();
      else await inFrame('btn').click();
      await expect.poll(shown).toBe('block');
      if (mode === 'keyboard') await page.keyboard.press('Enter');
      else if (phone) await inFrame('btn').tap();
      else await inFrame('btn').click();
      await expect.poll(shown).toBe('none');
      expect(await editor(page, (api) => api.projectJson())).toBe(project);
      expect(crashes).toEqual([]);

      // The published page, from what the editor stored.
      const { html, behaviour } = await renderThroughPublishedPage({ tree: storedPage(project), definitions: {} });
      const published = await browser.newPage(options);
      published.setDefaultTimeout(5000);
      await published.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${html}${runtimeScripts(runtime, behaviour as BehaviourProgram)}</body></html>`);
      const button = published.getByRole('button', { name: 'Menu' });
      const drawer = published.getByText('Links');
      expect(await drawer.isVisible()).toBe(false);
      if (mode === 'keyboard') {
        await button.focus();
        await published.keyboard.press('Enter');
      } else if (phone) await button.tap();
      else await button.click();
      await expect.poll(() => drawer.isVisible()).toBe(true);
      await published.close();
      await page.close();
    }, 90_000);
  });
});
