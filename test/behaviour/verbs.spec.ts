// The DOM actions and focus groups, through the real parser, the real route and a real
// build, with real keys and a real pointer. The presets of the contract's prototype, stored
// as an author would store them, plus the two group axes the prototype never had.
// See docs/plans/2026-11-02-behaviour-model.md, slice B4.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type BrowserContext, type BrowserType, type Page } from 'playwright';
import { getPrismaClient } from '@/server/db';
import { GATE_ATTR } from '@/lib/behaviour/names';
import { FX_ATTR } from '@/lib/effects/effects';
import { publishPages } from './site';

let origin: string;

beforeAll(async () => {
  origin = await publishPages(process.env.BEHAVIOUR_PORT as string);
});

afterAll(async () => {
  await getPrismaClient().$disconnect();
});

const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];

describe.each(ENGINES)('in %s', (name, engine) => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let problems: string[];
  // Playwright's WebKit moves Tab between controls only with Alt held, as Safari does.
  const TAB = name === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';

  const el = (id: string) => page.locator(`[data-t="${id}"]`).first();
  /** What holds the focus, by its text or its `data-t`. */
  const focused = () => page.evaluate(() => {
    const at = document.activeElement as HTMLElement;
    return at.dataset.t ?? at.tagName;
  });
  const press = async (key: string, want: string): Promise<void> => {
    await page.keyboard.press(key);
    await expect.poll(focused).toBe(want);
  };
  const runtimeUp = () => page.waitForFunction((attr) => {
    const gate = (window as unknown as { __fcB?: { queue: unknown[] }; __up?: boolean });
    return document.documentElement.hasAttribute(attr) && gate.__up === true;
  }, GATE_ATTR);
  const open = async (slug: string, on: Page = page): Promise<void> => {
    await on.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      let held: { ready(): boolean } | undefined;
      Object.defineProperty(w, '__fcB', {
        configurable: true,
        get: () => held,
        set: (gate: { ready(): boolean }) => {
          const { ready } = gate;
          gate.ready = () => {
            const answer = ready();
            // The runtime carries on in this same task, so the page is live right after it.
            setTimeout(() => { w.__up = answer; });
            return answer;
          };
          held = gate;
        },
      });
    });
    await on.goto(`${origin}/${slug}`);
    await runtimeUp();
  };

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

  describe('a line group', () => {
    it('is one Tab stop with the runtime, and every control without it', async () => {
      await open('toolbar');
      await el('before').focus();
      await press(TAB, 'bold');
      await press('ArrowRight', 'italic');
      await press('End', 'under');
      await press('ArrowRight', 'bold');
      await press('Home', 'bold');
      await press(TAB, 'after');
      expect(problems).toEqual([]);

      const off = await browser.newContext({ javaScriptEnabled: false });
      const target = await off.newPage();
      await target.goto(`${origin}/toolbar`);
      expect(await target.locator('[data-t="tb"] [tabindex]').count()).toBe(0);
      await off.close();
    });

    it('returns to the item that last held the focus', async () => {
      await open('toolbar');
      await el('italic').click();
      await el('before').focus();
      await press(TAB, 'italic');
    });

    it('runs right to left: InlineEnd is the left arrow', async () => {
      await open('toolbar-rtl');
      await el('bold').focus();
      await press('ArrowLeft', 'italic');
      await press('ArrowRight', 'bold');
    });

    it('leaves a feed in both directions', async () => {
      await open('feed');
      await el('one').focus();
      await press('PageDown', 'two');
      await press('Control+End', 'post');
      await el('two').focus();
      await press('Control+Home', 'pre');
    });
  });

  describe('a grid group', () => {
    const cell = async (key: string, want: string) => press(key, want);

    it('moves by cell, by row and by page, and to both ends', async () => {
      await open('grid');
      await el('before').focus();
      await cell(TAB, 'c00');
      await cell('ArrowRight', 'c01');
      await cell('ArrowDown', 'c11');
      await cell('ArrowUp', 'c01');
      await cell('End', 'c02');
      await cell('Home', 'c00');
      await cell('PageDown', 'c20');
      await cell('PageUp', 'c00');
      await cell('Control+End', 'c22');
      await cell('Control+Home', 'c00');
      await cell(TAB, 'after');
    });
  });

  describe('a tree group', () => {
    it('runs through what is visible, enters and leaves a branch, and skips a closed one', async () => {
      await open('tree');
      await el('fruit').focus();
      await press('ArrowRight', 'apple');
      await press('ArrowDown', 'pear');
      await press('ArrowLeft', 'fruit');
      await press('End', 'veg');
      await press('Home', 'fruit');
      await el('shut').click();
      await el('fruit').focus();
      await press('ArrowDown', 'veg');
      await press('ArrowRight', 'veg');
    });

    it('moves the Tab stop off an item a closed branch hid', async () => {
      await open('tree');
      await el('fruit').focus();
      await press('ArrowRight', 'apple');
      await el('shut').click();
      await expect.poll(() => el('fruit').getAttribute('tabindex')).toBe('0');
    });
  });

  describe('the presets of the prototype', () => {
    it('slider-multithumb: thumbs cannot cross, and the track keeps its max', async () => {
      await open('slider');
      await el('low').focus();
      await page.keyboard.press('End');
      await expect.poll(() => el('low').inputValue()).toBe('8');
      expect(await el('high').inputValue()).toBe('8');
      expect(await el('low').getAttribute('max')).toBe('10');
      await el('high').focus();
      await page.keyboard.press('Home');
      await expect.poll(() => el('high').inputValue()).toBe('8');
    });

    it('windowsplitter: keys and a real drag, and motion after release does nothing', async () => {
      await open('splitter');
      await el('sep').focus();
      await page.keyboard.press('ArrowLeft');
      await expect.poll(() => el('sep').getAttribute('aria-valuenow')).toBe('45');
      const box = await el('sep').boundingBox();
      const wrap = await el('wrap').boundingBox();
      if (!box || !wrap) throw new Error('no layout');
      await page.mouse.move(box.x + 3, box.y + 20);
      await page.mouse.down();
      await page.mouse.move(wrap.x + 180, box.y + 20, { steps: 5 });
      await page.mouse.up();
      await expect.poll(async () => Math.abs(Number(await el('sep').getAttribute('aria-valuenow')) - 30)).toBeLessThanOrEqual(2);
      const now = await el('sep').getAttribute('aria-valuenow');
      const left = await el('left').boundingBox();
      expect(Math.abs((left?.width ?? 0) - 180)).toBeLessThan(12);
      await page.mouse.move(wrap.x + 400, box.y + 20);
      await page.waitForTimeout(100);
      expect(await el('sep').getAttribute('aria-valuenow')).toBe(now);
    });

    it('tooltip: hover, Escape on hover alone, leave then enter, and the pointer on it', async () => {
      await open('tooltip');
      const shown = () => el('tip').isVisible();
      await el('btn').hover();
      await expect.poll(shown).toBe(true);
      await page.keyboard.press('Escape');
      await expect.poll(shown).toBe(false);
      await page.mouse.move(0, 0);
      await page.waitForTimeout(200);
      await el('btn').hover();
      await expect.poll(shown).toBe(true);
      await page.mouse.move(0, 0);
      await page.waitForTimeout(40);
      await el('btn').hover();
      await page.waitForTimeout(250);
      expect(await shown()).toBe(true);
      await el('tip').hover();
      await page.waitForTimeout(250);
      expect(await shown()).toBe(true);
      await page.mouse.move(0, 0);
      await expect.poll(shown).toBe(false);
      await el('btn').focus();
      await expect.poll(shown).toBe(true);
    });

    it('menu-button: opens on the first item, wraps, types ahead, and aria-expanded never goes stale', async () => {
      await open('menu-button');
      const expanded = () => el('btn').getAttribute('aria-expanded');
      const opened = () => el('menu').isVisible();
      await el('btn').focus();
      await page.keyboard.press('Enter');
      await expect.poll(focused).toBe('copy');
      await expect.poll(expanded).toBe('true');
      await press('ArrowUp', 'delete');
      await press('p', 'paste');
      await page.keyboard.press('Escape');
      await expect.poll(opened).toBe(false);
      await expect.poll(focused).toBe('btn');
      await expect.poll(expanded).toBe('false');
      await page.keyboard.press('ArrowUp');
      await expect.poll(focused).toBe('delete');
      await page.mouse.click(5, 300);
      await expect.poll(opened).toBe(false);
      await expect.poll(expanded).toBe('false');
    });

    it('details and dialog: stored state follows, whatever closed them', async () => {
      await open('natives');
      const held = (state: string) => el('wrap').getAttribute(`data-fcs-${state}`);
      await el('sum').click();
      await expect.poll(() => held('dopen')).toBe('true');
      await el('open-more').click();
      await expect.poll(() => held('dopen')).toBe('false');
      await el('open-dlg').click();
      await expect.poll(() => held('mopen')).toBe('true');
      await page.keyboard.press('Escape');
      await expect.poll(() => held('mopen')).toBe('false');
    });

    it('combobox: filters as a person types, skips what it hid, and Enter copies the option', async () => {
      await open('combobox');
      const box = el('in');
      await box.focus();
      await page.keyboard.press('ArrowDown');
      await expect.poll(() => el('o1').isVisible()).toBe(true);
      expect(await box.getAttribute('aria-expanded')).toBe('true');
      await page.keyboard.press('Escape');
      await expect.poll(() => el('list').isVisible()).toBe(false);
      await page.keyboard.type('b');
      await expect.poll(() => el('o3').isVisible()).toBe(true);
      expect(await box.inputValue()).toBe('b');
      expect(await el('o2').isVisible()).toBe(false);
      expect(await box.getAttribute('aria-activedescendant')).toBeNull();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await expect.poll(() => box.getAttribute('aria-activedescendant')).toBe('o3');
      await page.keyboard.press('Enter');
      await expect.poll(() => box.inputValue()).toBe('Basel');
      await expect.poll(() => el('list').isVisible()).toBe(false);
      expect(await focused()).toBe('in');
    });
  });

  describe('the native and value actions', () => {
    const sound = (property: 'readyState' | 'paused' | 'currentTime' | 'playbackRate' | 'volume') =>
      el('sound').evaluate((audio, name) => (audio as HTMLAudioElement)[name], property);

    it('plays, pauses, seeks, sets the rate and keeps a volume in range', async () => {
      await open('actions');
      await expect.poll(() => sound('readyState')).toBeGreaterThanOrEqual(1);
      await el('play').click();
      await expect.poll(() => sound('paused')).toBe(false);
      await el('pause').click();
      await expect.poll(() => sound('paused')).toBe(true);
      await el('seek').click();
      await expect.poll(() => sound('currentTime')).toBe(0.5);
      await el('rate').click();
      expect(await sound('playbackRate')).toBe(2);
      await el('volume').click();
      expect(await sound('volume')).toBe(1);
    });

    it('moves focus, writes a property, and scrolls to what a press asked for', async () => {
      await open('actions');
      await el('take-focus').click();
      expect(await focused()).toBe('field');
      await el('check').click();
      expect(await el('tick').isChecked()).toBe(true);
      expect(await el('field').isDisabled()).toBe(true);
      await el('jump').click();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
    });

    it('plays a reveal a press asked for, through the effects chunk', async () => {
      await open('actions');
      expect(await el('far').getAttribute(FX_ATTR.shown)).toBeNull();
      await el('show-far').click();
      await expect.poll(() => el('far').getAttribute(FX_ATTR.shown)).toBe('');
    });

    it('resets a form, with a field named reset in it', async () => {
      await open('actions');
      await el('shadow').fill('typed');
      await el('clear').click();
      await expect.poll(() => el('shadow').inputValue()).toBe('first');
    });

    if (name === 'chromium') {
      it('goes fullscreen from a press', async () => {
        await open('actions');
        await el('full').click();
        await expect.poll(() => page.evaluate(() => (document.fullscreenElement as HTMLElement | null)?.dataset.t)).toBe('pane');
      });
    }

    it('navigates within the site from a press', async () => {
      await open('actions');
      await el('inside').click();
      await expect.poll(() => new URL(page.url()).pathname).toBe('/plain');
    });

    it('leaves the site only from a real press', async () => {
      await page.route('https://example.invalid/**', (route) => route.fulfill({ contentType: 'text/html', body: 'Away' }));
      await open('actions');
      await el('outside').click();
      await expect.poll(() => page.url()).toBe('https://example.invalid/away');
    });
  });
});
