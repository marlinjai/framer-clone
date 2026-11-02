// What the page generator's output does on a real page: the validator's own output for the
// form the prompt teaches and for two preset requests, saved and published through the real
// route of a real build, with real keys, a real pointer and a real finger, at phone width and
// with scripts off, in Chromium and WebKit. The four paths of a stateful flow run on the
// taught form: forward, back, a reload, and coming back after leaving.
// See docs/plans/2026-11-02-behaviour-model.md, "AI output", slice B12.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type BrowserContext, type BrowserType, type Page } from 'playwright';
import { getPrismaClient } from '@/server/db';
import { GATE_ATTR } from '@/lib/behaviour/names';
import { publishPages } from './site';

let origin: string;

beforeAll(async () => {
  origin = await publishPages(process.env.BEHAVIOUR_PORT as string);
});

afterAll(async () => {
  await getPrismaClient().$disconnect();
});

const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

describe.each(ENGINES)('generated output in %s', (name, engine) => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let problems: string[];
  // Playwright's WebKit moves Tab between controls only with Alt held, as Safari does.
  const TAB = name === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';

  const focusedText = (on: Page = page) => on.evaluate(() => document.activeElement?.textContent ?? '');
  const open = async (slug: string, on: Page = page): Promise<void> => {
    await on.goto(`${origin}/${slug}`);
    await on.waitForFunction((attr) => document.documentElement.hasAttribute(attr) && !!(window as unknown as { __fcB?: unknown }).__fcB, GATE_ATTR);
    await on.waitForLoadState('networkidle');
  };
  const details = (on: Page = page) => on.getByText('The details');
  const reveal = (on: Page = page) => on.getByRole('button', { name: 'Show details' });

  beforeAll(async () => {
    browser = await engine.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext({ viewport: { width: 900, height: 600 } });
    page = await context.newPage();
    problems = [];
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    page.on('pageerror', (error) => problems.push(error.message));
  });
  afterEach(async () => {
    await context?.close();
  });

  describe('the taught form: a press shows and hides a part', () => {
    it('goes forward and back from the keyboard, aria-expanded following', async () => {
      await open('generated-reveal');
      expect(await details().isVisible()).toBe(false);
      await page.getByText('Before').focus();
      await page.keyboard.press(TAB);
      expect(await focusedText()).toBe('Show details');
      await page.keyboard.press('Enter');
      await expect.poll(() => details().isVisible()).toBe(true);
      expect(await reveal().getAttribute('aria-expanded')).toBe('true');
      await page.keyboard.press('Space');
      await expect.poll(() => details().isVisible()).toBe(false);
      expect(await reveal().getAttribute('aria-expanded')).toBe('false');
      expect(problems).toEqual([]);
    });

    it('starts closed again after a reload, and after leaving and coming back', async () => {
      await open('generated-reveal');
      await reveal().click();
      await expect.poll(() => details().isVisible()).toBe(true);
      await page.reload();
      await page.waitForLoadState('networkidle');
      expect(await details().isVisible()).toBe(false);
      await reveal().click();
      await expect.poll(() => details().isVisible()).toBe(true);
      await open('plain');
      await page.goBack();
      await page.waitForLoadState('networkidle');
      await expect.poll(() => details().isVisible()).toBe(false);
      await reveal().click();
      await expect.poll(() => details().isVisible()).toBe(true);
    });

    it('opens to a finger at phone width without widening the page', async () => {
      const phone = await browser.newContext(engine === webkit ? { viewport: PHONE.viewport, hasTouch: true } : PHONE);
      const target = await phone.newPage();
      await open('generated-reveal', target);
      await reveal(target).tap();
      await expect.poll(() => details(target).isVisible()).toBe(true);
      expect(await target.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
      await phone.close();
    });

    it('shows the part and hides the button that needs a script, with scripts off', async () => {
      const off = await browser.newContext({ javaScriptEnabled: false, viewport: PHONE.viewport });
      const target = await off.newPage();
      await target.goto(`${origin}/generated-reveal`);
      expect(await details(target).isVisible()).toBe(true);
      expect(await target.getByText('Show details').isVisible()).toBe(false);
      await off.close();
    });
  });

  describe('a tabs preset request', () => {
    const shownPanel = async (on: Page = page) => {
      const out: string[] = [];
      for (const panel of await on.getByRole('tabpanel').all()) if (await panel.isVisible()) out.push((await panel.textContent()) ?? '');
      return out;
    };

    it('walks its keys with one Tab stop, selection following the focus', async () => {
      await open('generated-tabs');
      await page.getByText('Before').focus();
      await page.keyboard.press(TAB);
      expect(await focusedText()).toBe('One');
      expect(await shownPanel()).toEqual(['Panel one']);
      for (const [key, tab, panel] of [['ArrowRight', 'Two', 'Panel two'], ['End', 'Three', 'Panel three'], ['ArrowRight', 'One', 'Panel one'], ['ArrowLeft', 'Three', 'Panel three'], ['Home', 'One', 'Panel one']]) {
        await page.keyboard.press(key);
        await expect.poll(() => focusedText()).toBe(tab);
        expect(await shownPanel()).toEqual([panel]);
      }
      expect(await page.getByRole('tab', { name: 'One' }).getAttribute('aria-selected')).toBe('true');
      await page.keyboard.press(TAB);
      expect(await focusedText()).toBe('Panel one');
      expect(problems).toEqual([]);
    });

    it('selects with a pointer, and with a finger at phone width', async () => {
      await open('generated-tabs');
      await page.getByRole('tab', { name: 'Three' }).click();
      await expect.poll(() => shownPanel()).toEqual(['Panel three']);
      const phone = await browser.newContext(engine === webkit ? { viewport: PHONE.viewport, hasTouch: true } : PHONE);
      const target = await phone.newPage();
      await open('generated-tabs', target);
      await target.getByRole('tab', { name: 'Two' }).tap();
      await expect.poll(() => shownPanel(target)).toEqual(['Panel two']);
      await phone.close();
    });

    it('shows every panel and no tab list with scripts off', async () => {
      const off = await browser.newContext({ javaScriptEnabled: false });
      const target = await off.newPage();
      await target.goto(`${origin}/generated-tabs`);
      for (const text of ['Panel one', 'Panel two', 'Panel three']) expect(await target.getByText(text).isVisible()).toBe(true);
      expect(await target.getByRole('tablist').isVisible()).toBe(false);
      await off.close();
    });
  });

  describe('a menu button preset request', () => {
    it('opens on Enter at the first item and gives the focus back on Escape', async () => {
      await open('generated-menu');
      const button = page.getByRole('button', { name: 'Actions' });
      await button.focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => page.getByRole('menu').isVisible()).toBe(true);
      await expect.poll(() => focusedText()).toBe('Copy');
      expect(await button.getAttribute('aria-expanded')).toBe('true');
      await page.keyboard.press('ArrowDown');
      await expect.poll(() => focusedText()).toBe('Paste');
      await page.keyboard.press('Escape');
      await expect.poll(() => page.getByRole('menu').isVisible()).toBe(false);
      await expect.poll(() => focusedText()).toBe('Actions');
      await expect.poll(() => button.getAttribute('aria-expanded')).toBe('false');
      expect(problems).toEqual([]);
    });
  });
});
