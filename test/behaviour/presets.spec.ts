// The presets, as the palette's own functions store them, through the real parser, the
// real route and a real build, with real keys, a real pointer and a real finger. Each one
// runs its whole key list, at phone width and with scripts off, and the four paths of a
// stateful flow: forward, back, a reload, and coming back after leaving.
// See docs/plans/2026-11-02-behaviour-model.md, "Presets", slice B6.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type BrowserContext, type BrowserType, type Page } from 'playwright';
import { getPrismaClient } from '@/server/db';
import { GATE_ATTR } from '@/lib/behaviour/names';
import { collectionTabs } from '@/lib/behaviour/presets/tabs';
import { publishPages } from './site';
import { publishedDocument, renderThroughPublishedPage } from '../score/lib/published';
import { bundleRuntime } from '../score/lib/runtime';

let origin: string;
let runtime: string;

beforeAll(async () => {
  origin = await publishPages(process.env.BEHAVIOUR_PORT as string);
  runtime = await bundleRuntime();
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
  // Playwright's WebKit moves Tab between controls only with Alt held, as Safari does.
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
  const panels = async (ids: string[], on: Page = page): Promise<string[]> => {
    const out: string[] = [];
    for (const id of ids) if (await shown(id, on)) out.push(id);
    return out;
  };

  /** Opens a page and waits until the runtime holds it. */
  const open = async (slug: string, on: Page = page): Promise<void> => {
    await on.goto(`${origin}/${slug}`);
    await on.waitForFunction((attr) => document.documentElement.hasAttribute(attr) && !!(window as unknown as { __fcB?: unknown }).__fcB, GATE_ATTR);
    // The Tab stops are the last thing the runtime writes as it starts.
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
  /** Runs `read` on a phone with a real finger. */
  const onPhone = async <T>(slug: string, read: (target: Page) => Promise<T>): Promise<T> => {
    // WebKit on a desktop has no mobile emulation.
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

  const PANELS = ['tabs-panel-0', 'tabs-panel-1', 'tabs-panel-2'];

  describe('tabs', () => {
    it('walks the whole key list, one Tab stop, selection following the focus', async () => {
      await open('preset-tabs');
      await el('before').focus();
      await press(TAB, 'tabs-tab-0');
      expect(await panels(PANELS)).toEqual(['tabs-panel-0']);
      await press('ArrowRight', 'tabs-tab-1');
      expect(await panels(PANELS)).toEqual(['tabs-panel-1']);
      expect(await el('tabs-tab-1').getAttribute('aria-selected')).toBe('true');
      expect(await el('tabs-tab-0').getAttribute('aria-selected')).toBe('false');
      await press('End', 'tabs-tab-2');
      await press('ArrowRight', 'tabs-tab-0');
      await press('ArrowLeft', 'tabs-tab-2');
      await press('Home', 'tabs-tab-0');
      await press('End', 'tabs-tab-2');
      await press(TAB, 'tabs-panel-2');
      expect(problems).toEqual([]);
    });

    it('a pointer selects and moves the Tab stop, in a browser that does not focus a button on click too', async () => {
      await open('preset-tabs');
      await el('tabs-tab-1').click();
      expect(await panels(PANELS)).toEqual(['tabs-panel-1']);
      await el('before').focus();
      await press(TAB, 'tabs-tab-1');
    });

    it('goes back, reloads to the first tab, and comes back to where it was', async () => {
      await open('preset-tabs');
      await el('tabs-tab-0').focus();
      await press('ArrowRight', 'tabs-tab-1');
      await press('ArrowRight', 'tabs-tab-2');
      await press('ArrowLeft', 'tabs-tab-1');
      expect(await panels(PANELS)).toEqual(['tabs-panel-1']);
      await el('after').focus();
      await page.keyboard.press(name === 'webkit' && process.platform === 'darwin' ? 'Alt+Shift+Tab' : 'Shift+Tab');
      await expect.poll(() => focused()).toBe('tabs-panel-1');
      await page.reload();
      await open('preset-tabs');
      expect(await panels(PANELS)).toEqual(['tabs-panel-0']);
      expect(await el('tabs-tab-0').getAttribute('aria-selected')).toBe('true');
    });

    it('runs vertical on Up and Down, and right to left on the arrows that read that way', async () => {
      await open('preset-tabs-vertical');
      await el('tabs-tab-0').focus();
      await press('ArrowDown', 'tabs-tab-1');
      await press('ArrowUp', 'tabs-tab-0');
      await press('ArrowUp', 'tabs-tab-2');
      await open('preset-tabs-rtl');
      await el('tabs-tab-0').focus();
      await press('ArrowLeft', 'tabs-tab-1');
      await press('ArrowRight', 'tabs-tab-0');
    });

    it('keeps two uses on a page apart, and one inside another', async () => {
      await open('preset-tabs-twice');
      await el('one-tab-1').click();
      expect(await shown('one-panel-1')).toBe(true);
      expect(await shown('two-panel-0')).toBe(true);
      expect(await shown('two-panel-1')).toBe(false);
      await open('preset-tabs-nested');
      await el('inner-tab-1').click();
      expect(await shown('inner-panel-1')).toBe(true);
      expect(await shown('outer-panel-1')).toBe(false);
      await el('outer-tab-1').click();
      expect(await shown('outer-panel-1')).toBe(true);
      expect(await shown('inner-panel-1')).toBe(false);
    });

    it('a tab added after a person edited it works, and what the person stored still runs', async () => {
      await open('preset-tabs-edited');
      await el('edited-tab-0').focus();
      await press('End', 'edited-tab-3');
      await expect.poll(() => el('edited').getAttribute('data-fcs-edited-active')).toBe('3');
      expect(await el('edited-tab-3').textContent()).toBe('Delta');
      expect(await shown('edited-panel-3')).toBe(true);
      await el('edited-tab-0', page).click();
      await expect.poll(() => el('edited').getAttribute('data-fcs-edited-mine')).toBe('true');
    });

    it('without a script hides the list and shows every panel in order', async () => {
      const seen = await withoutScripts('preset-tabs', async (target) => ({ list: await shown('tabs-list', target), showing: await panels(PANELS, target) }));
      expect(seen).toEqual({ list: false, showing: PANELS });
    });

    it('takes a finger at phone width, and nothing runs off the side', async () => {
      await onPhone('preset-tabs', async (target) => {
        await el('tabs-tab-2', target).tap();
        expect(await panels(PANELS, target)).toEqual(['tabs-panel-2']);
        expect(await wider(target)).toBe(false);
      });
    });

    it('comes from a Collection, tab 3 selecting panel 3, each panel named by its row', async () => {
      const tree = collectionTabs({ seed: 'data', collection: 'c1', titleField: 'title', bodyField: 'body' });
      const rows = [{ title: 'Spring', body: 'Spring text' }, { title: 'Summer', body: 'Summer text' }, { title: 'Autumn', body: 'Autumn text' }];
      const output = await renderThroughPublishedPage({ tree: { ...tree, componentType: 'host' }, definitions: {}, rows });
      await page.setContent(publishedDocument(output, undefined, undefined, runtime));
      const tab = (title: string) => page.getByRole('tab', { name: title });
      await expect.poll(() => page.getByText('Spring text').isVisible()).toBe(true);
      expect(await page.getByText('Summer text').isVisible()).toBe(false);
      await tab('Autumn').click();
      expect(await page.getByText('Autumn text').isVisible()).toBe(true);
      expect(await page.getByText('Spring text').isVisible()).toBe(false);
      await tab('Autumn').focus();
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => page.getByText('Spring text').isVisible()).toBe(true);
      expect(await tab('Spring').getAttribute('aria-selected')).toBe('true');
      expect(await page.locator('[role="tabpanel"]').evaluateAll((all) => all.map((at) => at.getAttribute('aria-label')))).toEqual(['Spring', 'Summer', 'Autumn']);
      expect(await page.locator('[id]').evaluateAll((all) => all.length - new Set(all.map((at) => at.id)).size)).toBe(0);
    });
  });

  describe('toolbar', () => {
    it('is one Tab stop and walks its keys, and comes back to where it was', async () => {
      await open('preset-toolbar');
      await el('before').focus();
      await press(TAB, 'tools-item-0');
      await press('ArrowRight', 'tools-item-1');
      await press('End', 'tools-item-2');
      await press('ArrowRight', 'tools-item-0');
      await press('ArrowLeft', 'tools-item-2');
      await press('Home', 'tools-item-0');
      await press('ArrowRight', 'tools-item-1');
      await press(TAB, 'after');
      await el('before').focus();
      await press(TAB, 'tools-item-1');
      expect(problems).toEqual([]);
    });

    it('leaves every control a Tab stop without a script', async () => {
      expect(await withoutScripts('preset-toolbar', (target) => target.locator('[data-t="tools"] [tabindex]').count())).toBe(0);
    });

    it('wraps at phone width and takes a finger', async () => {
      await onPhone('preset-toolbar', async (target) => {
        await el('tools-item-2', target).tap();
        expect(await wider(target)).toBe(false);
      });
    });
  });

  describe('tooltip', () => {
    const tip = 'hint-tip';
    const control = 'hint-control';

    it('shows on focus and goes on blur and on Escape', async () => {
      await open('preset-tooltip');
      expect(await shown(tip)).toBe(false);
      await el(control).focus();
      await expect.poll(() => shown(tip)).toBe(true);
      await page.keyboard.press('Escape');
      await expect.poll(() => shown(tip)).toBe(false);
      await el('after').focus();
      await el(control).focus();
      await expect.poll(() => shown(tip)).toBe(true);
      await el('after').focus();
      await expect.poll(() => shown(tip)).toBe(false);
      expect(problems).toEqual([]);
    });

    it('holds on hover: Escape from hover alone, leave then enter, the pointer on the tooltip', async () => {
      await open('preset-tooltip');
      await el(control).hover();
      await expect.poll(() => shown(tip)).toBe(true);
      await page.keyboard.press('Escape');
      await expect.poll(() => shown(tip)).toBe(false);

      await page.mouse.move(0, 0);
      await page.waitForTimeout(200);
      await el(control).hover();
      await expect.poll(() => shown(tip)).toBe(true);
      await page.mouse.move(0, 0);
      await page.waitForTimeout(40);
      await el(control).hover();
      await page.waitForTimeout(250);
      expect(await shown(tip)).toBe(true);

      await el(tip).hover();
      await page.waitForTimeout(250);
      expect(await shown(tip)).toBe(true);
      await page.mouse.move(0, 0);
      await expect.poll(() => shown(tip)).toBe(false);
    });

    it('starts closed after a reload', async () => {
      await open('preset-tooltip');
      await el(control).focus();
      await expect.poll(() => shown(tip)).toBe(true);
      await page.reload();
      await open('preset-tooltip');
      expect(await shown(tip)).toBe(false);
    });

    it('stays as the control\'s description, in the flow, without a script', async () => {
      const seen = await withoutScripts('preset-tooltip', async (target) => ({
        shown: await shown(tip, target),
        position: await el(tip, target).evaluate((at) => getComputedStyle(at).position),
        described: await el(control, target).getAttribute('aria-describedby') === await el(tip, target).getAttribute('id'),
      }));
      expect(seen).toEqual({ shown: true, position: 'static', described: true });
    });

    it('shows from a finger and fits a phone', async () => {
      await onPhone('preset-tooltip', async (target) => {
        await el(control, target).tap();
        await expect.poll(() => shown(tip, target)).toBe(true);
        expect(await wider(target)).toBe(false);
      });
    });
  });

  describe('carousel', () => {
    const SLIDES = ['show-slide-0', 'show-slide-1', 'show-slide-2', 'show-slide-3'];

    it('moves by its buttons and wraps both ways, a reload starting over', async () => {
      await open('preset-carousel');
      expect(await panels(SLIDES)).toEqual(['show-slide-0']);
      await el('show-next').focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => panels(SLIDES)).toEqual(['show-slide-1']);
      await el('show-previous').focus();
      await page.keyboard.press('Space');
      await page.keyboard.press('Space');
      await expect.poll(() => panels(SLIDES)).toEqual(['show-slide-3']);
      await el('show-next').click();
      await expect.poll(() => panels(SLIDES)).toEqual(['show-slide-0']);
      expect(await el('show-slide-3').getAttribute('aria-label')).toBe('4 of 4');
      expect(await el('show-slides').getAttribute('aria-live')).toBe('polite');
      await page.reload();
      await open('preset-carousel');
      expect(await panels(SLIDES)).toEqual(['show-slide-0']);
      expect(problems).toEqual([]);
    });

    it('rotates only when asked, stops on hover and on focus, and a person can start it again', async () => {
      await open('preset-carousel-rotating');
      const at = () => panels(SLIDES.slice(0, 3));
      await expect.poll(at, { timeout: 2500 }).toEqual(['show-slide-1']);
      expect(await el('show-slides').getAttribute('aria-live')).toBe('off');

      await el('show-slides').hover();
      const held = await at();
      await page.waitForTimeout(1300);
      expect(await at()).toEqual(held);
      await page.mouse.move(0, 0);
      await expect.poll(at, { timeout: 2500 }).not.toEqual(held);

      await el('show-next').focus();
      const stopped = await at();
      expect(await el('show-rotation').textContent()).toBe('Start rotation');
      expect(await el('show-slides').getAttribute('aria-live')).toBe('polite');
      await page.waitForTimeout(1300);
      expect(await at()).toEqual(stopped);
      await el('show-rotation').focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => el('show-rotation').textContent()).toBe('Stop rotation');
      await expect.poll(at, { timeout: 2500 }).not.toEqual(stopped);
    });

    it('a pointer on the rotation control stops it, rather than stopping and starting it', async () => {
      await open('preset-carousel-rotating');
      await el('show-rotation').click();
      await expect.poll(() => el('show-rotation').textContent()).toBe('Start rotation');
      await page.mouse.move(0, 0);
      const stopped = await panels(SLIDES.slice(0, 3));
      await page.waitForTimeout(1300);
      expect(await panels(SLIDES.slice(0, 3))).toEqual(stopped);
      await el('show-rotation').click();
      await expect.poll(() => el('show-rotation').textContent()).toBe('Stop rotation');
    });

    it('never moves by itself under reduced motion, and offers no rotation', async () => {
      const calm = await browser.newContext({ reducedMotion: 'reduce' });
      const target = await calm.newPage();
      await open('preset-carousel-rotating', target);
      await target.waitForTimeout(1300);
      expect(await panels(SLIDES.slice(0, 3), target)).toEqual(['show-slide-0']);
      expect(await shown('show-rotation', target)).toBe(false);
      await el('show-next', target).click();
      await expect.poll(() => panels(SLIDES.slice(0, 3), target)).toEqual(['show-slide-1']);
      await calm.close();
    });

    it('shows every slide in order, and no button, without a script', async () => {
      const seen = await withoutScripts('preset-carousel', async (target) => ({ showing: await panels(SLIDES, target), next: await shown('show-next', target) }));
      expect(seen).toEqual({ showing: SLIDES, next: false });
    });

    it('takes a finger at phone width', async () => {
      await onPhone('preset-carousel', async (target) => {
        await el('show-next', target).tap();
        await expect.poll(() => panels(SLIDES, target)).toEqual(['show-slide-1']);
        expect(await wider(target)).toBe(false);
      });
    });
  });
});
