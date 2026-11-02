// The structure family of presets, as the palette's own functions store them, through the
// real parser, the real route and a real build: feed, data grid, tree view and tree grid.
// Real keys and a real finger, at phone width and with scripts off, and forward, back, a
// reload and coming back. See docs/plans/2026-11-02-behaviour-model.md, "Presets", slice B8.

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

describe.each(ENGINES)('in %s', (name, engine) => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let problems: string[];
  const TAB = name === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';

  const el = (id: string, on: Page = page) => on.locator(`[data-t="${id}"]`).first();
  const focused = (on: Page = page) => on.evaluate(() => {
    const at = document.activeElement as HTMLElement;
    return at.dataset.t ?? at.tagName;
  });
  const press = async (key: string, want: string): Promise<void> => {
    await page.keyboard.press(key);
    await expect.poll(() => focused()).toBe(want);
  };
  const shown = (id: string, on: Page = page) => el(id, on).isVisible();

  const open = async (slug: string, on: Page = page): Promise<void> => {
    await on.goto(`${origin}/${slug}`);
    await on.waitForFunction((attr) => document.documentElement.hasAttribute(attr) && !!(window as unknown as { __fcB?: unknown }).__fcB, GATE_ATTR);
    await on.waitForLoadState('networkidle');
  };
  const withoutScripts = async <T>(slug: string, read: (target: Page) => Promise<T>): Promise<T> => {
    const off = await browser.newContext({ javaScriptEnabled: false, viewport: PHONE.viewport });
    const target = await off.newPage();
    await target.goto(`${origin}/${slug}`);
    const out = await read(target);
    await off.close();
    return out;
  };
  const onPhone = async <T>(slug: string, read: (target: Page) => Promise<T>): Promise<T> => {
    const phone = await browser.newContext(engine === webkit ? { viewport: PHONE.viewport, hasTouch: true } : PHONE);
    const target = await phone.newPage();
    await open(slug, target);
    const out = await read(target);
    await phone.close();
    return out;
  };
  const wider = (target: Page) => target.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

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

  describe('feed', () => {
    it('pages through its articles and leaves on Ctrl+End and Ctrl+Home, one Tab stop', async () => {
      await open('preset-feed');
      await el('before').focus();
      await press(TAB, 'news-article-0');
      await press('PageDown', 'news-article-1');
      await press('PageDown', 'news-article-2');
      await press('PageUp', 'news-article-1');
      await press('Control+End', 'after');
      await el('news-article-1').focus();
      await press('Control+Home', 'before');
      await press(TAB, 'news-article-1');
      await press(TAB, 'after');
      expect(problems).toEqual([]);
    });

    it('leaves every article a Tab stop without a script', async () => {
      const stops = await withoutScripts('preset-feed', (target) => target.locator('[data-t="news"] article[tabindex="0"]').count());
      expect(stops).toBe(3);
    });

    it('fits a phone', async () => {
      await onPhone('preset-feed', async (target) => expect(await wider(target)).toBe(false));
    });
  });

  describe('data grid', () => {
    it('walks its cells by row and column, one Tab stop that comes back where it was', async () => {
      await open('preset-grid');
      await el('before').focus();
      await press(TAB, 'prices-cell-0-0');
      await press('ArrowRight', 'prices-cell-0-1');
      await press('ArrowDown', 'prices-cell-1-1');
      await press('End', 'prices-cell-1-2');
      await press('Home', 'prices-cell-1-0');
      await press('Control+End', 'prices-cell-2-2');
      await press('Control+Home', 'prices-cell-0-0');
      await press('PageDown', 'prices-cell-2-0');
      await press('ArrowUp', 'prices-cell-1-0');
      await press(TAB, 'after');
      await el('before').focus();
      await press(TAB, 'prices-cell-1-0');
      expect(problems).toEqual([]);
    });

    it('is a plain table without a script', async () => {
      const stops = await withoutScripts('preset-grid', (target) => target.locator('[data-t="prices"] [tabindex]').count());
      expect(stops).toBe(0);
    });

    it('fits a phone', async () => {
      await onPhone('preset-grid', async (target) => expect(await wider(target)).toBe(false));
    });
  });

  describe('tree view', () => {
    it('opens and enters a branch, comes back to it, closes it, and Enter opens it again', async () => {
      await open('preset-tree');
      await el('files-0').focus();
      expect(await shown('files-0-0')).toBe(false);
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => shown('files-0-0')).toBe(true);
      expect(await el('files-0').getAttribute('aria-expanded')).toBe('true');
      await press('ArrowRight', 'files-0-0');
      await press('ArrowDown', 'files-0-1');
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => shown('files-0-1-0')).toBe(true);
      await press('ArrowRight', 'files-0-1-0');
      // Left on a leaf goes to its parent and leaves the branch around it open.
      await press('ArrowLeft', 'files-0-1');
      expect(await shown('files-0-1-0')).toBe(true);
      await page.keyboard.press('ArrowLeft');
      await expect.poll(() => shown('files-0-1-0')).toBe(false);
      await press('ArrowLeft', 'files-0');
      expect(await shown('files-0-0')).toBe(true);
      await page.keyboard.press('ArrowLeft');
      await expect.poll(() => shown('files-0-0')).toBe(false);
      await press('End', 'files-2');
      await press('Home', 'files-0');
      await press('v', 'files-1');
      await page.keyboard.press('Enter');
      await expect.poll(() => shown('files-1-0')).toBe(true);
      expect(problems).toEqual([]);
    });

    it('starts with every branch closed after a reload, and one Tab stop on where it was', async () => {
      await open('preset-tree');
      await el('files-0').focus();
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => shown('files-0-0')).toBe(true);
      await press('ArrowDown', 'files-0-0');
      await el('before').focus();
      await press(TAB, 'files-0-0');
      await page.reload();
      await open('preset-tree');
      expect(await shown('files-0-0')).toBe(false);
    });

    it('shows every branch open without a script', async () => {
      const all = await withoutScripts('preset-tree', async (target) => [await shown('files-0-0', target), await shown('files-0-1-1', target), await shown('files-1-1', target)]);
      expect(all).toEqual([true, true, true]);
    });

    it('fits a phone', async () => {
      await onPhone('preset-tree', async (target) => expect(await wider(target)).toBe(false));
    });
  });

  describe('tree grid', () => {
    it('opens a row, enters it, goes back to its parent and closes it', async () => {
      await open('preset-treegrid');
      await el('before').focus();
      await press(TAB, 'mail-row-0');
      expect(await shown('mail-row-0-0')).toBe(false);
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => shown('mail-row-0-0')).toBe(true);
      expect(await el('mail-row-0').getAttribute('aria-expanded')).toBe('true');
      await press('ArrowRight', 'mail-row-0-0');
      await press('ArrowDown', 'mail-row-0-1');
      await press('ArrowLeft', 'mail-row-0');
      await page.keyboard.press('ArrowLeft');
      await expect.poll(() => shown('mail-row-0-0')).toBe(false);
      await press('ArrowDown', 'mail-row-1');
      await press('Home', 'mail-row-0');
      await press('End', 'mail-row-1');
      await page.keyboard.press(name === 'webkit' && process.platform === 'darwin' ? 'Alt+Shift+Tab' : 'Shift+Tab');
      await expect.poll(() => focused()).toBe('before');
      expect(problems).toEqual([]);
    });

    it('starts closed after a reload, and shows every row without a script', async () => {
      await open('preset-treegrid');
      await el('mail-row-0').focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => shown('mail-row-0-0')).toBe(true);
      await page.reload();
      await open('preset-treegrid');
      expect(await shown('mail-row-0-0')).toBe(false);
      const all = await withoutScripts('preset-treegrid', async (target) => [await shown('mail-row-0-0', target), await shown('mail-row-0-1', target)]);
      expect(all).toEqual([true, true]);
    });

    it('fits a phone', async () => {
      await onPhone('preset-treegrid', async (target) => expect(await wider(target)).toBe(false));
    });
  });
});
