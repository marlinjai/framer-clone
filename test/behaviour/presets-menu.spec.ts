// The menu family of presets, as the palette's own functions store them, through the real
// parser, the real route and a real build: menu button, menubar, combobox, the two thumb
// slider and the window splitter. Real keys, a real pointer and a real finger, at phone
// width and with scripts off, and forward, back, a reload and coming back.
// See docs/plans/2026-11-02-behaviour-model.md, "Presets", slice B7.

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

  describe('menu button', () => {
    const expanded = () => el('acts-button').getAttribute('aria-expanded');

    it('opens on its first item and walks the whole key list, Escape giving the focus back', async () => {
      await open('preset-menu-button');
      await el('acts-button').focus();
      await press('Enter', 'acts-item-0');
      expect(await expanded()).toBe('true');
      await press('ArrowDown', 'acts-item-1');
      await press('End', 'acts-item-2');
      await press('ArrowDown', 'acts-item-0');
      await press('ArrowUp', 'acts-item-2');
      await press('Home', 'acts-item-0');
      await press('d', 'acts-item-2');
      await press('Escape', 'acts-button');
      expect(await shown('acts-menu')).toBe(false);
      // A popover's toggle event comes a task after it closed.
      await expect.poll(expanded).toBe('false');
      await press('ArrowUp', 'acts-item-2');
      await press('Escape', 'acts-button');
      expect(problems).toEqual([]);
    });

    it('closes on choosing an item, and on a press outside, the state following both', async () => {
      await open('preset-menu-button');
      await el('acts-button').click();
      await expect.poll(() => shown('acts-menu')).toBe(true);
      await el('acts-item-1').click();
      await expect.poll(() => shown('acts-menu')).toBe(false);
      await expect.poll(expanded).toBe('false');
      await expect.poll(() => focused()).toBe('acts-button');
      await el('acts-button').click();
      await expect.poll(() => expanded()).toBe('true');
      await page.mouse.click(5, 590);
      await expect.poll(() => expanded()).toBe('false');
    });

    it('starts closed after a reload', async () => {
      await open('preset-menu-button');
      await el('acts-button').click();
      await expect.poll(() => expanded()).toBe('true');
      await page.reload();
      await open('preset-menu-button');
      expect(await shown('acts-menu')).toBe(false);
      expect(await expanded()).toBe('false');
    });

    it('still opens without a script, its items reached by Tab', async () => {
      const seen = await withoutScripts('preset-menu-button', async (target) => {
        await el('acts-button', target).click();
        return { menu: await shown('acts-menu', target), item: await el('acts-item-0', target).isVisible() };
      });
      expect(seen).toEqual({ menu: true, item: true });
    });

    it('opens from a finger and fits a phone', async () => {
      await onPhone('preset-menu-button', async (target) => {
        await el('acts-button', target).tap();
        await expect.poll(() => shown('acts-menu', target)).toBe(true);
        expect(await wider(target)).toBe(false);
      });
    });
  });

  describe('menubar', () => {
    it('moves along the bar, into a menu and out of it, and back on Escape', async () => {
      await open('preset-menubar');
      await el('before').focus();
      await press(TAB, 'bar-0-top');
      await press('ArrowRight', 'bar-1-top');
      await press('ArrowRight', 'bar-0-top');
      await press('End', 'bar-1-top');
      await press('Home', 'bar-0-top');
      await press('ArrowDown', 'bar-0-link-0');
      expect(await el('bar-0-top').getAttribute('aria-expanded')).toBe('true');
      await press('ArrowDown', 'bar-0-link-1');
      await press('ArrowDown', 'bar-0-link-0');
      await press('o', 'bar-0-link-1');
      await press('ArrowRight', 'bar-1-top');
      expect(await shown('bar-0-menu')).toBe(false);
      await press('ArrowUp', 'bar-1-link-1');
      await press('Escape', 'bar-1-top');
      expect(await shown('bar-1-menu')).toBe(false);
      expect(await el('bar-1-top').getAttribute('aria-expanded')).toBe('false');
      await press(TAB, 'after');
      expect(problems).toEqual([]);
    });

    it('opens one menu at a time by pointer, a second press closing it', async () => {
      await open('preset-menubar');
      await el('bar-0-top').click();
      await expect.poll(() => shown('bar-0-menu')).toBe(true);
      await el('bar-1-top').click();
      await expect.poll(() => shown('bar-1-menu')).toBe(true);
      expect(await shown('bar-0-menu')).toBe(false);
      await el('bar-1-top').click();
      await expect.poll(() => shown('bar-1-menu')).toBe(false);
      expect(page.url().endsWith('/preset-menubar')).toBe(true);
    });

    it('starts with every menu closed after a reload', async () => {
      await open('preset-menubar');
      await el('bar-0-top').click();
      await expect.poll(() => shown('bar-0-menu')).toBe(true);
      await page.reload();
      await open('preset-menubar');
      expect(await shown('bar-0-menu')).toBe(false);
    });

    it('is a list of links without a script', async () => {
      const seen = await withoutScripts('preset-menubar', async (target) => ({
        menus: [await shown('bar-0-menu', target), await shown('bar-1-menu', target)],
        position: await el('bar-0-menu', target).evaluate((at) => getComputedStyle(at).position),
        href: await el('bar-1-link-0', target).getAttribute('href'),
      }));
      expect(seen).toEqual({ menus: [true, true], position: 'static', href: '#undo' });
    });

    it('opens from a finger and fits a phone', async () => {
      await onPhone('preset-menubar', async (target) => {
        await el('bar-1-top', target).tap();
        await expect.poll(() => shown('bar-1-menu', target)).toBe(true);
        expect(await wider(target)).toBe(false);
      });
    });
  });

  describe('combobox', () => {
    const field = () => el('city-field');
    const activeText = () => page.evaluate(() => {
      const id = document.querySelector('[data-t="city-field"]')?.getAttribute('aria-activedescendant');
      return id ? document.getElementById(id)?.textContent ?? null : null;
    });

    it('filters as a person types, skips what is hidden, and Enter copies the option', async () => {
      await open('preset-combobox');
      await field().focus();
      await page.keyboard.press('ArrowDown');
      await expect.poll(() => shown('city-list')).toBe(true);
      expect(await field().getAttribute('aria-expanded')).toBe('true');
      await page.keyboard.press('Escape');
      await expect.poll(() => shown('city-list')).toBe(false);
      await page.keyboard.type('b');
      await expect.poll(() => shown('city-option-1')).toBe(false);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await expect.poll(activeText).toBe('Basel');
      await page.keyboard.press('Enter');
      await expect.poll(() => field().inputValue()).toBe('Basel');
      expect(await shown('city-list')).toBe(false);
      expect(problems).toEqual([]);
    });

    it('goes back: clearing what was typed shows every option again', async () => {
      await open('preset-combobox');
      await field().focus();
      await page.keyboard.type('ge');
      await expect.poll(() => shown('city-option-0')).toBe(false);
      await page.keyboard.press('Backspace');
      await page.keyboard.press('Backspace');
      await expect.poll(() => shown('city-option-0')).toBe(true);
      expect(await shown('city-option-3')).toBe(true);
    });

    it('a pointer chooses an option as Enter does, and a reload starts empty', async () => {
      await open('preset-combobox');
      await field().focus();
      await page.keyboard.press('ArrowDown');
      await el('city-option-2').click();
      await expect.poll(() => field().inputValue()).toBe('Basel');
      await expect.poll(() => shown('city-list')).toBe(false);
      await page.reload();
      await open('preset-combobox');
      expect(await field().inputValue()).toBe('');
      expect(await shown('city-list')).toBe(false);
    });

    it('is a plain field with the list beside it without a script', async () => {
      const seen = await withoutScripts('preset-combobox', async (target) => ({ list: await shown('city-list', target), field: await el('city-field', target).isEditable() }));
      expect(seen).toEqual({ list: true, field: true });
    });

    it('takes a finger at phone width', async () => {
      await onPhone('preset-combobox', async (target) => {
        await el('city-field', target).tap();
        await target.keyboard.type('z');
        // The filter hides the options that do not match and moves the one left up: tap only after that,
        // or WebKit's touch lands where the option was a frame earlier.
        await expect.poll(() => shown('city-option-0', target)).toBe(false);
        await expect.poll(() => shown('city-option-1', target)).toBe(true);
        // The option chooses on the touch's release, so a real tap is all it takes, in every engine.
        await el('city-option-1', target).tap();
        await expect.poll(() => el('city-field', target).inputValue()).toBe('Zurich');
        await expect.poll(() => shown('city-list', target)).toBe(false);
        expect(await wider(target)).toBe(false);
      });
    });
  });

  describe('two thumb slider', () => {
    it('keeps the thumbs from crossing by key, both ways, and leaves the track alone', async () => {
      await open('preset-range');
      await el('price-low').focus();
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => el('price-low').inputValue()).toBe('3');
      await page.keyboard.press('End');
      await expect.poll(() => el('price-low').inputValue()).toBe('8');
      await el('price-high').focus();
      await page.keyboard.press('Home');
      await expect.poll(() => el('price-high').inputValue()).toBe('8');
      await page.keyboard.press('End');
      await expect.poll(() => el('price-high').inputValue()).toBe('10');
      await el('price-low').focus();
      await page.keyboard.press('Home');
      await expect.poll(() => el('price-low').inputValue()).toBe('0');
      expect(await el('price-low').getAttribute('max')).toBe('10');
      expect(problems).toEqual([]);
    });

    it('keeps them apart under a pointer too, and a reload starts where the page said', async () => {
      await open('preset-range');
      const box = await el('price-low').boundingBox();
      if (!box) throw new Error('no slider box');
      await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
      await expect.poll(() => el('price-low').inputValue()).toBe('8');
      await page.reload();
      await open('preset-range');
      expect(await el('price-low').inputValue()).toBe('2');
      expect(await el('price-high').inputValue()).toBe('8');
    });

    it('leaves two sliders that may cross without a script', async () => {
      const value = await withoutScripts('preset-range', async (target) => {
        await el('price-low', target).focus();
        await target.keyboard.press('End');
        return el('price-low', target).inputValue();
      });
      expect(value).toBe('10');
    });

    it('fits a phone', async () => {
      await onPhone('preset-range', async (target) => {
        expect(await wider(target)).toBe(false);
      });
    });
  });

  describe('window splitter', () => {
    const value = (on: Page = page) => el('split-separator', on).getAttribute('aria-valuenow');
    const firstWidth = (on: Page = page) => el('split-first', on).evaluate((at) => at.getBoundingClientRect().width);

    it('moves by key, collapses and comes back where it was', async () => {
      await open('preset-splitter');
      await el('split-separator').focus();
      await page.keyboard.press('ArrowLeft');
      await expect.poll(() => value()).toBe('45');
      await page.keyboard.press('Enter');
      await expect.poll(() => value()).toBe('0');
      expect(await firstWidth()).toBeLessThan(30);
      await page.keyboard.press('Enter');
      await expect.poll(() => value()).toBe('45');
      await page.keyboard.press('Enter');
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => value()).toBe('50');
      await page.keyboard.press('End');
      await expect.poll(() => value()).toBe('100');
      await page.keyboard.press('Home');
      await expect.poll(() => value()).toBe('0');
      expect(problems).toEqual([]);
    });

    it('follows a drag, and nothing after the release', async () => {
      await open('preset-splitter');
      const separator = await el('split-separator').boundingBox();
      const whole = await el('split').boundingBox();
      if (!separator || !whole) throw new Error('no splitter box');
      await page.mouse.move(separator.x + 4, separator.y + 20);
      await page.mouse.down();
      await page.mouse.move(whole.x + whole.width * 0.3, separator.y + 20, { steps: 6 });
      await page.mouse.up();
      await expect.poll(async () => Number(await value())).toBeGreaterThanOrEqual(27);
      const now = Number(await value());
      expect(now).toBeLessThanOrEqual(33);
      await page.mouse.move(whole.x + whole.width * 0.8, separator.y + 20, { steps: 3 });
      expect(Number(await value())).toBe(now);
      await page.reload();
      await open('preset-splitter');
      expect(await value()).toBe('50');
    });

    it('holds its first split without a script', async () => {
      const width = await withoutScripts('preset-splitter', async (target) => ({
        first: await firstWidth(target),
        whole: await el('split', target).evaluate((at) => at.getBoundingClientRect().width),
      }));
      expect(Math.abs(width.first / width.whole - 0.5)).toBeLessThan(0.05);
    });

    it('fits a phone', async () => {
      await onPhone('preset-splitter', async (target) => {
        expect(await wider(target)).toBe(false);
      });
    });
  });
});
