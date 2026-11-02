// What the security review of B3 and B4 broke, kept broken: each page here is what got
// through, stored as an author could, on the real route of a real build. A page that may
// hang gets raw input only, because a locator's click fails on a clobbered page, and
// discarding that error once read as "alive" while the tab was frozen.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, webkit, type Browser, type BrowserContext, type BrowserType, type Page } from 'playwright';
import { getPrismaClient } from '@/server/db';
import { SHADOWED } from './pages';
import { publishPages } from './site';

let origin: string;
let withBanner: string;

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  origin = await publishPages(process.env.BEHAVIOUR_PORT as string);
  withBanner = await publishPages(process.env.BEHAVIOUR_PORT as string, { analytics: true });
});

afterAll(async () => {
  await getPrismaClient().$disconnect();
});

const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];
const WAIT_FOR_RUNTIME_MS = 1500;

describe.each(ENGINES)('in %s', (_name, engine) => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let warnings: string[];

  const el = (id: string) => page.locator(`[data-t="${id}"]`).first();
  const goTo = async (slug: string, host = origin): Promise<void> => {
    await page.goto(`${host}/${slug}`);
    await page.waitForTimeout(WAIT_FOR_RUNTIME_MS);
  };
  /** Whether the page's main thread answers at all. */
  const alive = () =>
    Promise.race([page.evaluate(() => 'alive'), new Promise((resolve) => { setTimeout(() => resolve('FROZEN'), 3000); })]);
  /** A real press at a stored node, found without any locator. */
  const rawPress = async (id: string): Promise<void> => {
    const at = await page.evaluate((target) => {
      const box = Document.prototype.querySelector.call(document, `[data-t="${target}"]`)?.getBoundingClientRect();
      return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
    }, id);
    if (!at) throw new Error(`no ${id} on the page`);
    await Promise.race([page.mouse.click(at.x, at.y), new Promise((resolve) => { setTimeout(resolve, 2500); })]);
  };
  const dialogOpen = () => page.evaluate(() => (Document.prototype.querySelector.call(document, 'dialog') as HTMLDialogElement).open);

  beforeAll(async () => {
    browser = await engine.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    page = await context.newPage();
    warnings = [];
    page.on('console', (message) => {
      if (message.type() === 'warning') warnings.push(message.text());
    });
  });
  afterEach(async () => {
    await Promise.race([context.close(), new Promise((resolve) => { setTimeout(resolve, 3000); })]);
  });

  describe('finding 1: a field named after what the runtime reads', () => {
    const CASES = SHADOWED.flatMap((member) => [[member, 'id'], [member, 'name']]);

    it.each(CASES)('leaves the tab alive with a field called %s by its %s', async (member, attribute) => {
      await goTo(`shadow-${attribute}-${member.toLowerCase()}`);
      await rawPress('press-sheet');
      expect(await alive()).toBe('alive');
      await rawPress('in-sheet');
      expect(await alive()).toBe('alive');
      await rawPress('outside');
      expect(await alive()).toBe('alive');
      const value = await page.evaluate(() => Element.prototype.getAttribute.call(Document.prototype.querySelector.call(document, '[data-t="shadowed"]'), 'data-fcs-s'));
      expect(value === 'true' || value === 'false').toBe(true);
    });

    it('is why the render gate alone is not enough: an id stays on the page, a name does not', async () => {
      await goTo('shadow-name-parentelement');
      expect(await page.evaluate(() => Document.prototype.querySelector.call(document, '[data-t="in-sheet"]')?.hasAttribute('name'))).toBe(false);
      await goTo('shadow-id-parentelement');
      expect(await page.evaluate(() => {
        const form = Document.prototype.querySelector.call(document, 'form') as HTMLFormElement;
        return form.parentElement === form.querySelector('input');
      })).toBe(true);
    });

    it('keeps <img name="querySelector"> off the page, and the panel on it', async () => {
      await goTo('img-query-selector');
      expect(await el('image').getAttribute('name')).toBeNull();
      await el('btn').click();
      expect(await el('panel').isVisible()).toBe(true);
    });
  });

  describe('finding 2: nothing but state hears the whole page', () => {
    it('leaves every press where it was: no capture, no redirect and no modal', async () => {
      await goTo('reaching-presses');
      await page.evaluate(() => {
        (window as unknown as { hits: number }).hits = 0;
        document.querySelector('[data-t="pay"]')?.addEventListener('click', () => { (window as unknown as { hits: number }).hits += 1; });
      });
      await el('pay').click();
      expect(await page.evaluate(() => (window as unknown as { hits: number }).hits)).toBe(1);
      expect(page.url()).toContain(origin);
      expect(await dialogOpen()).toBe(false);
    });

    it('leaves the real consent banner working beside a page-wide key', async () => {
      await goTo('consent', withBanner);
      const decline = page.locator('[data-fc-consent-decline]');
      await expect.poll(() => decline.isVisible()).toBe(true);
      await page.keyboard.press('Escape');
      await decline.click();
      await expect.poll(() => decline.isVisible()).toBe(false);
      expect(page.url()).toContain(withBanner);
    });
  });

  describe('finding 3: a modal cannot hold the page', () => {
    it.each(['escape-keyup-node', 'escape-keyup-page'])('stays closed after Escape on /%s', async (slug) => {
      await goTo(slug);
      await el('opener').focus();
      await page.keyboard.press('Enter');
      await expect.poll(dialogOpen).toBe(true);
      for (let press = 0; press < 3; press += 1) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(100);
        expect(await dialogOpen()).toBe(false);
      }
    });

    it('closes on Escape when nobody asked for it, though closedby="none" was stored', async () => {
      await goTo('wall');
      expect(await dialogOpen()).toBe(true);
      await page.keyboard.press('Escape');
      await expect.poll(dialogOpen).toBe(false);
      await el('pay').click();
    });
  });

  describe('finding 4: the screen and the sound need a press, right then', () => {
    it('never takes the page fullscreen from a timer or a delay', async () => {
      await goTo('timers');
      await el('pay').click();
      await page.waitForTimeout(1500);
      expect(await page.evaluate(() => document.fullscreenElement === null)).toBe(true);
    });
  });

  describe('finding 6: a loop through what the page itself causes', () => {
    it('turns off a real transition chasing its own state, below any rate, and warns', async () => {
      await goTo('slow-loop');
      await el('start').click();
      await expect.poll(() => warnings.filter((text) => text.includes('unprompted')).length, { timeout: 30_000 }).toBe(1);
      expect(await alive()).toBe('alive');
    });
  });
});
