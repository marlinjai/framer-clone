// How long a published FX scene takes to appear, cold (a fresh browser profile: nothing cached) and warm
// (the same page again), on a real production build in real Chromium and WebKit, and what it costs the
// page meanwhile (long tasks on the main thread). The particle ring of `/services` (the lumitra-light
// preset) with `start: settled`, as Marlin reviews it. Plan docs/plans/2026-11-08-lumitra-fx-in-sites.md,
// addendum of 2026-11-23.
//
// The numbers are printed (one JSON line per run, `FX_TIMING`) so a change can be compared with main; the
// assertions are kept to what holds on any machine (the scene comes, the engine is what was measured, a page
// without a scene fetches no engine); the comparison with main is made from the numbers. Times are from
// navigation start. A local server has no network cost: cold here means an empty cache, not a slow line.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type BrowserType } from 'playwright';
import { PRESETS, serializeScene } from '@/lib/fx/format';
import { FX_ATTR, FX_MARKER, FX_PROP } from '@/lib/fxScene/marker';
import { node, type StoredNode } from './pages';
import { publishPages } from './site';

const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];
const RUNS = 5;

/** Where the numbers go (the runner keeps a test's console to itself): FX_TIMING_OUT, or test/behaviour/.out. */
const OUT = process.env.FX_TIMING_OUT ?? path.join(__dirname, '.out', 'fx-timing.jsonl');
const record = (line: unknown) => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.appendFileSync(OUT, `${JSON.stringify(line)}\n`);
};

const ring = serializeScene(PRESETS.find((p) => p.id === 'lumitra-light')!.load());
const BOX_STYLE = { position: 'relative', minHeight: '460px', background: '#04090B', color: '#e9fff4' };
const hero = (fx: boolean): StoredNode =>
  node('hero', 'div', fx ? { [FX_ATTR]: FX_MARKER, [FX_PROP]: { version: 1, scene: ring, start: 'settled', calm: 'frame' }, style: BOX_STYLE } : { style: BOX_STYLE }, node('hero-title', 'h1', { children: 'Beweis statt Behauptung' }));

const PAGES: Readonly<Record<string, () => StoredNode>> = {
  'time-ring': () => hero(true),
  'time-none': () => hero(false),
};

interface Run {
  engine: string;
  kind: 'cold' | 'warm';
  load: number;
  lcp: number | null;
  waiting: number | null;
  loading: number | null;
  live: number | null;
  placeholder: number | null;
  /** When the ring's own first frame was shown (src/lib/fxScene/ringStill.ts): the ring is visible from here. */
  still: number | null;
  engineStart: number | null;
  engineEnd: number | null;
  engineBytes: number;
  longTasks: number;
  longestTask: number;
}

/** Records, in the page, when the box changes state and when the placeholder shows, from navigation start. */
const RECORDER = () => {
  const marks: Record<string, number> = {};
  const tasks: number[] = [];
  (window as unknown as { __fxTiming: unknown }).__fxTiming = { marks, tasks };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) marks.lcp = entry.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {
    // No Largest Contentful Paint in this engine.
  }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) tasks.push(entry.duration);
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    // WebKit has no long-task timing: reported as none.
  }
  const look = () => {
    const box = document.querySelector('[data-t="hero"]');
    const state = box?.getAttribute('data-fc-fx-state');
    if (state && marks[state] === undefined) marks[state] = performance.now();
    if (box?.querySelector('[data-fc-fx-placeholder]') && marks.placeholder === undefined) marks.placeholder = performance.now();
    // The ring's own first frame (src/lib/fxScene/ringStill.ts): from here the visitor sees the ring.
    if (box?.querySelector('[data-fc-fx-ring-still]') && marks.still === undefined) marks.still = performance.now();
  };
  new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-fc-fx-state'] });
};

let origin: string;
beforeAll(async () => {
  origin = await publishPages(process.env.BEHAVIOUR_PORT!, { pages: PAGES });
});

const median = (values: (number | null)[]) => {
  const sorted = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : null;
};

describe.each(ENGINES)('in %s', (name, engine) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await engine.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  const measure = async (page: import('playwright').Page, kind: Run['kind']): Promise<Run> => {
    // The engine's chunks, known by their content (three.js's renderer class name survives minification).
    const engineUrls: Promise<string | null>[] = [];
    const onResponse = (response: import('playwright').Response) => {
      if (!response.url().includes('/_next/static/chunks/')) return;
      engineUrls.push(response.text().then((text) => (text.includes('WebGLRenderer') ? response.url() : null), () => null));
    };
    page.on('response', onResponse);
    await page.goto(`${origin}/time-ring`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('[data-t="hero"]')?.getAttribute('data-fc-fx-state') === 'live', undefined, { timeout: 30_000 });
    // The fade-in and whatever follows it on the main thread.
    await page.waitForTimeout(600);
    page.off('response', onResponse);
    const urls = (await Promise.all(engineUrls)).filter((url): url is string => url !== null);
    const raw = await page.evaluate((engine) => {
      const { marks, tasks } = (window as unknown as { __fxTiming: { marks: Record<string, number>; tasks: number[] } }).__fxTiming;
      const loadStart = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).loadEventStart;
      const late = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter((entry) => engine.includes(entry.name));
      return {
        load: loadStart,
        marks,
        tasks,
        engineStart: late.length ? Math.min(...late.map((e) => e.startTime)) : null,
        engineEnd: late.length ? Math.max(...late.map((e) => e.responseEnd)) : null,
        engineBytes: late.reduce((sum, e) => sum + (e.encodedBodySize || e.transferSize || 0), 0),
      };
    }, urls);
    const run: Run = {
      engine: name,
      kind,
      load: Math.round(raw.load),
      lcp: raw.marks.lcp === undefined ? null : Math.round(raw.marks.lcp),
      waiting: raw.marks.waiting ?? null,
      loading: raw.marks.loading ?? null,
      live: raw.marks.live ?? null,
      placeholder: raw.marks.placeholder ?? null,
      still: raw.marks.still ?? null,
      engineStart: raw.engineStart,
      engineEnd: raw.engineEnd,
      engineBytes: raw.engineBytes,
      longTasks: raw.tasks.length,
      longestTask: Math.round(Math.max(0, ...raw.tasks)),
    };
    for (const key of ['waiting', 'loading', 'live', 'placeholder', 'still', 'engineStart', 'engineEnd'] as const) if (run[key] !== null) run[key] = Math.round(run[key]!);
    record(run);
    return run;
  };

  it(`cold and warm: the scene is visible soon after load, its engine fetched while the page loads (${RUNS} runs each)`, async () => {
    const runs: Run[] = [];
    for (let i = 0; i < RUNS; i++) {
      // A fresh context has an empty cache: cold. The same page again in it: warm.
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await context.addInitScript(RECORDER);
      const page = await context.newPage();
      runs.push(await measure(page, 'cold'));
      runs.push(await measure(page, 'warm'));
      await context.close();
    }
    const summary = (kind: Run['kind']) => {
      const of = runs.filter((r) => r.kind === kind);
      return {
        engine: name,
        kind,
        load: median(of.map((r) => r.load)),
        lcp: median(of.map((r) => r.lcp)),
        engineBytes: median(of.map((r) => r.engineBytes)),
        live: median(of.map((r) => r.live)),
        liveAfterLoad: median(of.map((r) => (r.live === null ? null : r.live - r.load))),
        // The ring is seen from its still on, or from the live scene where there is no still.
        ringSeen: median(of.map((r) => r.still ?? r.live)),
        ringSeenAfterLcp: median(of.map((r) => (r.lcp === null ? null : (r.still ?? r.live ?? 0) - r.lcp))),
        engineStart: median(of.map((r) => r.engineStart)),
        placeholderShown: of.filter((r) => r.placeholder !== null).length,
        longestTask: median(of.map((r) => r.longestTask)),
      };
    };
    record({ summary: [summary('cold'), summary('warm')] });
    for (const run of runs) {
      expect(run.live).not.toBeNull();
      // The engine's chunks were found (about 343 KB compressed), so the timings above are about them.
      expect(run.kind === 'warm' || run.engineBytes > 100_000).toBe(true);
    }
  }, 300_000);

  it('a page without a scene fetches no engine', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const fetched: string[] = [];
    page.on('response', async (response) => {
      if (!response.url().includes('/_next/static/chunks/')) return;
      const text = await response.text().catch(() => '');
      if (text.includes('WebGLRenderer')) fetched.push(response.url());
    });
    await page.goto(`${origin}/time-none`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    expect(fetched).toEqual([]);
    expect(await page.locator('[data-fc-fx-placeholder]').count()).toBe(0);
    await context.close();
  });
});
