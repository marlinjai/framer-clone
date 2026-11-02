// The behaviour runtime where it really runs: stored pages, saved and published through
// the real repository, served by the real route of a real production build, hydrated by
// React, in real Chromium and WebKit, with real input. Nothing here dispatches an event.
// See docs/plans/2026-11-02-behaviour-model.md, slice B3.

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { chromium, webkit, type Browser, type BrowserContext, type BrowserType, type Page, type Response, type Route } from 'playwright';
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPrismaClient } from '@/server/db';
import { GATE_ATTR } from '@/lib/behaviour/names';
import { START_STATE_TIMEOUT_MS } from '@/lib/effects/effects';
import { renderPublishedPage } from '@/lib/renderer/server/renderPublishedPage';
import type { BehaviourProgram } from '@/lib/behaviour/program';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { HOSTILE_TEXT, PAGES, STATE_NAME } from './pages';
import { publishPages } from './site';

/** In the runtime chunk and nowhere else. */
const RUNTIME_MARK = 'Page behaviour stopped';
/** In the effects chunk and nowhere else: its observer's margin. */
const EFFECTS_MARK = '0px 0px -10% 0px';
const CHUNKS = '**/_next/static/chunks/**';

/** Where a run leaves what it measured. */
const MEASURES = path.join(os.tmpdir(), 'behaviour-measures.log');
const note = (line: string): void => fs.appendFileSync(MEASURES, `${line}\n`);

let origin: string;
/** The runtime as a plain script, for what only a write before hydration can show. */
let runtimeScript: string;

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  origin = await publishPages(process.env.BEHAVIOUR_PORT as string);
  const bundled = await build({
    stdin: { contents: `import { startBehaviour } from '@/lib/behaviour/runtime'; window.__start = startBehaviour;`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    alias: { '@': path.resolve('src') },
  });
  runtimeScript = bundled.outputFiles[0].text;
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

  const watch = (target: Page): void => {
    target.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    target.on('pageerror', (error) => problems.push(error.message));
  };
  const el = (id: string, on: Page = page) => on.locator(`[data-t="${id}"]`).first();
  const gate = (on: Page = page) => on.evaluate((attr) => document.documentElement.hasAttribute(attr), GATE_ATTR);
  /** The runtime has taken over from the boot script. */
  const isReady = (on: Page = page) =>
    on.waitForFunction(() => {
      const held = (window as unknown as { __fcB?: { queue: unknown[] } }).__fcB;
      return held !== undefined && (window as unknown as { __behaviourReady?: boolean }).__behaviourReady === true;
    });
  /** Notes when `__fcB.ready` was called, without any code in the page for it. */
  const noteReady = (on: Page = page) =>
    on.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      let held: { ready(): boolean } | undefined;
      Object.defineProperty(w, '__fcB', {
        configurable: true,
        get: () => held,
        set: (gateObject: { ready(): boolean }) => {
          w.__behaviourBootAt = performance.now();
          const ready = gateObject.ready;
          gateObject.ready = () => {
            const answer = ready();
            w.__behaviourReadyAt = performance.now();
            w.__behaviourReady = answer;
            return answer;
          };
          held = gateObject;
        },
      });
    });
  /**
   * A real mouse press. WebKit paints nothing while the scripts are held, so its frames
   * never tell Playwright the button stands still: `force` skips only that wait.
   */
  const pressBeforePaint = () => el('btn').click({ force: true });
  const open = async (slug: string, on: Page = page): Promise<Response | null> => {
    await noteReady(on);
    return on.goto(`${origin}/${slug}`);
  };
  const openReady = async (slug: string): Promise<void> => {
    await open(slug);
    await isReady();
  };

  beforeAll(async () => {
    browser = await engine.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
    problems = [];
    watch(page);
  });
  afterEach(async () => {
    await context?.close();
  });

  describe('a page with no trigger', () => {
    /** Every script a page fetched, with its text. */
    const scriptsOf = async (slug: string): Promise<{ url: string; body: string }[]> => {
      const seen: Promise<{ url: string; body: string }>[] = [];
      page.on('response', (response) => {
        if (response.url().endsWith('.js') || response.url().includes('.js?')) {
          seen.push(response.text().then((body) => ({ url: response.url(), body })));
        }
      });
      await page.goto(`${origin}/${slug}`, { waitUntil: 'networkidle' });
      return Promise.all(seen);
    };

    it.each(['plain', 'still'])('fetches no byte of the runtime on /%s', async (slug) => {
      const scripts = await scriptsOf(slug);
      expect(scripts.length).toBeGreaterThan(0);
      expect(scripts.filter(({ body }) => body.includes(RUNTIME_MARK))).toEqual([]);
      expect(await page.evaluate(() => '__fcB' in window)).toBe(false);
      expect(await page.locator('[data-fc-behaviour-boot]').count()).toBe(0);
      expect((await page.content()).match(/data-fc-(?:b|n|scope)/)).toBeNull();
    });

    it('fetches it on a page with one, which shows what the test above looks for', async () => {
      const scripts = await scriptsOf('accordion');
      expect(scripts.filter(({ body }) => body.includes(RUNTIME_MARK))).toHaveLength(1);
    });

    it('fetches no byte of the motion code either, until a page has an effect', async () => {
      expect((await scriptsOf('plain')).filter(({ body }) => body.includes(EFFECTS_MARK))).toEqual([]);
      await page.close();
      page = await context.newPage();
      expect((await scriptsOf('effects')).filter(({ body }) => body.includes(EFFECTS_MARK))).toHaveLength(1);
      expect(await el('moved').isVisible()).toBe(true);
    });
  });

  describe('hydration', () => {
    it('hydrates, and answers a press', async () => {
      await openReady('accordion');
      expect(await el('panel').isVisible()).toBe(false);
      expect(await el('btn').getAttribute('aria-expanded')).toBe('false');
      await el('btn').click();
      expect(await el('panel').isVisible()).toBe(true);
      expect(await el('btn').getAttribute('aria-expanded')).toBe('true');
      expect(await el('label').textContent()).toBe('open');
      await el('btn').click();
      expect(await el('panel').isVisible()).toBe(false);
      expect(await el('label').textContent()).toBe('closed');
      expect(problems).toEqual([]);
    });

    it('keeps the server\'s elements: React rebuilt nothing', async () => {
      let release = () => {};
      const held = new Promise<void>((resolve) => { release = resolve; });
      await page.route(CHUNKS, async (route) => {
        await held;
        await route.continue();
      });
      await noteReady();
      await page.goto(`${origin}/accordion`, { waitUntil: 'commit' });
      await el('other').waitFor();
      await el('other').evaluate((target) => { (target as unknown as { mark: number }).mark = 1; });
      release();
      await isReady();
      expect(await el('other').evaluate((target) => (target as unknown as { mark?: number }).mark)).toBe(1);
      expect(problems).toEqual([]);
    });

    it('survives writes made before React attaches: attributes and a marked text are kept, with no error 418', async () => {
      const { behaviour } = await renderPublishedPage({
        root: { id: 'root', type: 'div', props: {}, children: [PAGES.accordion()] } as unknown as ComponentNode,
        pageParams: {},
        cmsRepo: {} as never,
        breakpoints: [],
      });
      let release = () => {};
      const held = new Promise<void>((resolve) => { release = resolve; });
      await page.route(CHUNKS, async (route) => {
        await held;
        await route.continue();
      });
      await page.goto(`${origin}/accordion`, { waitUntil: 'commit' });
      await el('other').waitFor();
      await el('other').evaluate((target) => { (target as unknown as { mark: number }).mark = 1; });
      await page.addScriptTag({ content: runtimeScript });
      await page.evaluate((program) => {
        const start = (window as unknown as { __start: (options: unknown) => () => void }).__start;
        (window as unknown as { __stop: () => void }).__stop = start({ container: document, program, surface: 'preview' });
      }, behaviour as BehaviourProgram);
      await pressBeforePaint();
      expect(await el('label').textContent()).toBe('open');
      expect(await el('btn').getAttribute('aria-expanded')).toBe('true');
      await page.evaluate(() => (window as unknown as { __stop: () => void }).__stop());
      release();
      await page.waitForLoadState('networkidle');
      await page.waitForFunction(() => (window as unknown as { __fcB?: unknown }).__fcB !== undefined);
      await expect.poll(() => page.evaluate(() => Object.keys(document.querySelector('[data-t="btn"]') as object).some((key) => key.startsWith('__react')))).toBe(true);
      expect(await el('label').textContent()).toBe('open');
      expect(await el('btn').getAttribute('aria-expanded')).toBe('true');
      expect(await el('other').evaluate((target) => (target as unknown as { mark?: number }).mark)).toBe(1);
      expect(problems.join()).not.toContain('418');
    });
  });

  describe('a press before the runtime', () => {
    const holdChunks = async (): Promise<() => void> => {
      let release = () => {};
      const held = new Promise<void>((resolve) => { release = resolve; });
      await page.route(CHUNKS, async (route) => {
        await held;
        await route.continue();
      });
      return release;
    };

    it('is not lost, and runs once', async () => {
      const release = await holdChunks();
      await noteReady();
      await page.goto(`${origin}/accordion`, { waitUntil: 'commit' });
      await el('btn').waitFor();
      await pressBeforePaint();
      expect(await el('panel').isVisible()).toBe(false);
      release();
      await isReady();
      await expect.poll(() => el('panel').isVisible()).toBe(true);
      expect(await el('btn').getAttribute('aria-expanded')).toBe('true');
      await el('btn').click();
      expect(await el('panel').isVisible()).toBe(false);
      expect(problems).toEqual([]);
    });

    it('holds nothing typed into a field, and replays no key from one', async () => {
      const release = await holdChunks();
      await noteReady();
      await page.goto(`${origin}/fields`, { waitUntil: 'commit' });
      await el('field').waitFor();
      await el('field').focus();
      await page.keyboard.press('a');
      expect(await page.evaluate(() => (window as unknown as { __fcB: { queue: unknown[] } }).__fcB.queue.length)).toBe(0);
      release();
      await isReady();
      expect(await el('count').textContent()).toBe('0');
      expect(await el('field').inputValue()).toBe('a');
    });
  });

  describe('when the runtime fails', () => {
    /** Refuses the one chunk holding the runtime, whatever the build named it. */
    const refuseRuntime = (target: Page) =>
      target.route(CHUNKS, async (route: Route) => {
        const response = await route.fetch();
        if ((await response.text()).includes(RUNTIME_MARK)) await route.abort();
        else await route.fulfill({ response });
      });

    it('drops the gate at once when the chunk does not arrive, and the page reads without a script', async () => {
      await refuseRuntime(page);
      await page.goto(`${origin}/accordion`);
      await expect.poll(() => gate()).toBe(false);
      expect(await el('panel').isVisible()).toBe(true);
      expect(await el('btn').isVisible()).toBe(false);
      expect(problems.join()).toContain('Page behaviour did not load');
    });

    it('drops the gate after 3 seconds when nothing ever starts, and stays down if the runtime comes late', async () => {
      await page.route(CHUNKS, () => { /* never answers */ });
      await page.goto(`${origin}/accordion`, { waitUntil: 'commit' });
      await el('panel').waitFor({ state: 'attached' });
      await expect.poll(() => gate(), { timeout: 5000 }).toBe(false);
      expect(await el('panel').isVisible()).toBe(true);
      expect(problems.join()).toContain('did not start');
    });

    it('comes down for good on a later failure, so nothing stays hidden behind a dead runtime', async () => {
      await openReady('accordion');
      await page.evaluate(() => {
        performance.now = () => { throw new Error('broken'); };
      });
      await el('btn').click();
      await expect.poll(() => gate()).toBe(false);
      expect(await el('panel').isVisible()).toBe(true);
      expect(problems.join()).toContain('Page behaviour stopped');
      const before = await el('item').getAttribute('data-fcs-s1');
      await el('other').click();
      expect(await el('item').getAttribute('data-fcs-s1')).toBe(before);
    });
  });

  describe('with scripts off', () => {
    it('shows every panel and hides the button that would do nothing', async () => {
      const off = await browser.newContext({ javaScriptEnabled: false });
      const target = await off.newPage();
      await target.goto(`${origin}/accordion`);
      expect(await el('panel', target).isVisible()).toBe(true);
      expect(await el('btn', target).isVisible()).toBe(false);
      expect(await target.locator(`html[${GATE_ATTR}]`).count()).toBe(0);
      await off.close();
    });
  });

  describe('what leaves the server', () => {
    it('cannot end a script from a literal, a state name or a text value, and sends no name or preset', async () => {
      const response = await open('hostile');
      const html = (await response?.text()) ?? '';
      await isReady();
      expect(await page.evaluate(() => (window as unknown as { __hostile?: unknown }).__hostile)).toBeUndefined();
      expect(html).not.toContain(STATE_NAME);
      expect(html).not.toContain('"preset"');
      expect(html.match(/<script>window\.__hostile/g)).toBeNull();
      expect(await el('said').textContent()).toBe(`${HOSTILE_TEXT}!`);
      await el('btn').click();
      expect(await el('said').textContent()).toBe(HOSTILE_TEXT);
      expect(await el('kept').textContent()).toBe(HOSTILE_TEXT);
      expect(await page.evaluate(() => (window as unknown as { __hostile?: unknown }).__hostile)).toBeUndefined();
      expect(problems).toEqual([]);
    });
  });

  describe('finding 8: a modal no press asked for', () => {
    it('opens once per page load, and a press still opens it', async () => {
      await openReady('modal-cycle');
      const opened = () => el('modal').evaluate((dialog) => (dialog as HTMLDialogElement).open);
      await expect.poll(opened).toBe(true);
      await el('shut').click();
      expect(await opened()).toBe(false);
      await expect.poll(() => el('sentinel').isVisible()).toBe(true);
      await page.waitForTimeout(300);
      expect(await opened()).toBe(false);
      await el('opener').click();
      expect(await opened()).toBe(true);
    });
  });

  describe('finding 9: what a person types into a field', () => {
    const count = () => el('count').textContent();

    it.each(['field', 'area', 'note'])('fires nothing on a wrapper around a real %s', async (id) => {
      await openReady('fields');
      await el(id).click();
      await page.keyboard.type('ab c');
      expect(await count()).toBe('0');
    });

    it('still lets a named key through', async () => {
      await openReady('fields');
      await el('field').click();
      await page.keyboard.press('Enter');
      await expect.poll(() => el('form-area').getAttribute('data-fcs-named')).toBe('true');
      await expect.poll(count).toBe('1');
    });

    it('answers the same keys on what is no field', async () => {
      await openReady('fields');
      await el('plain').focus();
      await page.keyboard.press('b');
      await expect.poll(count).toBe('2');
    });
  });

  describe('what a value may become', () => {
    it('reads a range as a number, kept to its state, and a select to its options', async () => {
      await openReady('values');
      await el('range').focus();
      await page.keyboard.press('End');
      await expect.poll(() => el('number').textContent()).toBe('8');
      expect(await el('values').getAttribute('data-fcs-n')).toBe('8');
      await el('pick').selectOption('b');
      await expect.poll(() => el('choice').textContent()).toBe('b');
      await el('pick').selectOption('z');
      await page.waitForTimeout(50);
      expect(await el('choice').textContent()).toBe('b');
      expect(await el('values').getAttribute('data-fcs-c')).toBe('b');
    });
  });

  describe('a program that loops', () => {
    const warningsOf = (target: Page): string[] => {
      const warnings: string[] = [];
      target.on('console', (message) => {
        if (message.type() === 'warning') warnings.push(message.text());
      });
      return warnings;
    };
    const stillAlive = async (): Promise<void> => {
      const stall = await page.evaluate(() => new Promise<number>((resolve) => {
        const from = performance.now();
        setTimeout(() => resolve(performance.now() - from), 10);
      }));
      expect(stall).toBeLessThan(200);
      await el('still-works').click();
      await expect.poll(() => el('shows').textContent()).toBe('true');
      expect(await gate()).toBe(true);
    };

    it('stops a fan of delays, warns, and the page stays alive', async () => {
      const warnings = warningsOf(page);
      await openReady('loop');
      await el('storm').click();
      await expect.poll(() => warnings.filter((text) => text.includes('ran too often')).length).toBeGreaterThanOrEqual(1);
      await stillAlive();
    });

    it('stops a cycle through real toggle events, and the page stays alive', async () => {
      const warnings = warningsOf(page);
      await openReady('loop');
      await el('starter').click();
      await expect.poll(() => warnings.filter((text) => text.includes('unprompted')).length, { timeout: 10_000 }).toBe(1);
      await stillAlive();
    });
  });

  if (name === 'chromium') {
    describe('over the network, measured', () => {
      /** Bytes on the wire per URL, from the browser's own count. */
      const measure = async (slug: string): Promise<{ total: number; scripts: number; urls: Map<string, number> }> => {
        const session = await context.newCDPSession(page);
        await session.send('Network.enable');
        await session.send('Network.setCacheDisabled', { cacheDisabled: true });
        const urls = new Map<string, string>();
        const bytes = new Map<string, number>();
        session.on('Network.responseReceived', ({ requestId, response }) => urls.set(requestId, response.url));
        session.on('Network.loadingFinished', ({ requestId, encodedDataLength }) => {
          const url = urls.get(requestId);
          if (url) bytes.set(url, encodedDataLength);
        });
        await page.goto(`${origin}/${slug}`, { waitUntil: 'networkidle' });
        const entries = [...bytes];
        return {
          total: entries.reduce((sum, [, size]) => sum + size, 0),
          scripts: entries.filter(([url]) => url.includes('.js')).reduce((sum, [, size]) => sum + size, 0),
          urls: bytes,
        };
      };

      it('adds no script to a page with no trigger, and one small chunk to a page with one', async () => {
        const plain = await measure('plain');
        await page.close();
        page = await context.newPage();
        const scripted = await measure('accordion');
        const added = [...scripted.urls].filter(([url]) => url.includes('.js') && !plain.urls.has(url));
        note(`bytes on the wire: /plain ${plain.total} (scripts ${plain.scripts}), /accordion ${scripted.total} (scripts ${scripted.scripts}), scripts only /accordion fetched: ${JSON.stringify(added)}`);
        expect(added).toHaveLength(1);
        expect(added[0][1]).toBeLessThan(6000);
      });
    });

    describe('time to ready on a throttled profile', () => {
      it('is measured on an ordinary page, and comes before the gate falls', async () => {
        const session = await context.newCDPSession(page);
        await session.send('Network.enable');
        await session.send('Network.setCacheDisabled', { cacheDisabled: true });
        // Slow 4G and a phone's processor, the profile Lighthouse uses.
        await session.send('Network.emulateNetworkConditions', { offline: false, latency: 562.5, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
        await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        await openReady('ordinary');
        const timing = await page.evaluate(() => {
          const w = window as unknown as { __behaviourReadyAt: number; __behaviourBootAt: number };
          return { paint: performance.getEntriesByName('first-paint')[0]?.startTime ?? 0, ready: w.__behaviourReadyAt, boot: w.__behaviourBootAt };
        });
        const leftOfTheGate = START_STATE_TIMEOUT_MS - (timing.ready - timing.boot);
        // A shared runner under this throttle says nothing about the margin, so there it is only recorded.
        note(`throttled: boot script ${Math.round(timing.boot)} ms, first paint ${Math.round(timing.paint)} ms, runtime ready ${Math.round(timing.ready)} ms, paint to ready ${Math.round(timing.ready - timing.paint)} ms, left of the 3 second gate ${Math.round(leftOfTheGate)} ms`);
        if (!process.env.CI) expect(leftOfTheGate).toBeGreaterThan(0);
        expect(problems).toEqual([]);
      });
    });
  }
});
