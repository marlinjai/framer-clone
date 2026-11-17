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
// A native select is chosen with Playwright's selectOption in both modes, as no engine lets
// a script open its list. An element on the canvas is picked by pointer or finger in both
// modes: picking from the layers by keyboard is the layers panel's contract, not this one.

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

/** The texts in a section that are cut off: wider than their box where the box hides the rest. */
const clipped = (section: Locator) =>
  section.evaluate((root) =>
    [...root.querySelectorAll('span, p, label, button, li')]
      .filter((el) => {
        const style = getComputedStyle(el);
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
      const name = pageState().getByLabel(/^Name of /).first();
      await expect.poll(() => name.count()).toBe(1);
      await typeInto(name, 'Open');
      await expect.poll(() => pageState().getByLabel('Name of Open').count()).toBe(1);
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
      await draft.getByLabel('Event', { exact: true }).selectOption('mouseenter');
      await draft.getByLabel('Action 1', { exact: true }).selectOption('focus');
      await press(draft.getByRole('button', { name: 'Add this interaction' }));
      const refusal = draft.getByRole('alert');
      await expect.poll(() => refusal.textContent()).toMatch(/^Not saved: .+\.$/);
      expect(await editor(page, (api) => api.propsOf('btn')?.behaviour)).toBeUndefined();
      expect(await clipped(interactions())).toEqual([]);
      if (engineName === 'chromium' && mode === 'pointer') await interactions().screenshot({ path: path.join(SHOTS, `${layout}-interactions-refused.png`) });

      await draft.getByLabel('Event', { exact: true }).selectOption('click');
      await draft.getByLabel('Action 1', { exact: true }).selectOption('toggle');
      expect(await draft.getByLabel('Value to change in action 1').inputValue()).toBe(valueId);
      // A click can stop the browser's own response; its switch is named in full and its label is not cut off.
      expect(await draft.getByRole('switch', { name: "Stop the browser's own response" }).count()).toBe(1);
      expect(await clipped(interactions())).toEqual([]);
      await press(draft.getByRole('button', { name: 'Add this interaction' }));
      await expect.poll(() => interactions().getByRole('button', { name: /^Edit: On click, toggle Open/ }).count()).toBe(1);
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
