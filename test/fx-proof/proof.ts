// The browser proof of the Lumitra FX plan (docs/plans/2026-11-08-lumitra-fx-in-sites.md),
// prepared so that the proof after a deploy is one run and not a session of improvising.
//
//  - collectFxProof: what slice F7 asks to be recorded for one published address: the
//    state of every FX box, how many WebGL contexts the page holds, which script files it
//    fetched and which of them carry the engine or the scene format, Content Security
//    Policy violations, console errors and FX warnings. Run it on a page with an FX scene
//    and on one without, with and without reduced motion.
//  - compareFxAddresses: what slice F8 asks for: the scene at two addresses, drawn at the
//    still frame with the clock stopped, compared pixel by pixel with the oracle's own
//    tolerance (test/fx-oracle/oracle.ts).
//
// Both only READ: they open addresses and look. They write nothing to a site.
//
// Everything is measured in the page itself and installed BEFORE the page loads (an init
// script): a context made before the counter existed would not be counted, and a clock
// stopped after the first frame would compare two different moments.
//
// Rehearsed on a real production build in test/behaviour/fx.spec.ts and fxOracle.spec.ts;
// run against live addresses with test/fx-proof/run.ts.

import type { Browser, BrowserContextOptions } from 'playwright';
import { PNG } from 'pngjs';
import { CHANNEL_TOLERANCE, MAX_DIFFERING_SHARE, STOP_THE_CLOCK, colours, difference } from '../fx-oracle/oracle';

/** Only in the engine's chunks: three.js's renderer class name survives minification as a string. */
export const ENGINE_MARK = 'WebGLRenderer';
/** Only in code that carries the scene format: a layer schema's label and a preset's id. */
export const FORMAT_MARKS = ['Noise Field', 'gold-noise-gradient'];

interface ProofWindow {
  __fxProof: { made: number; live: () => number; csp: { directive: string; blocked: string }[] };
}

/**
 * Run through tsx (the command in ./run.ts), every function this file hands to the page is
 * compiled with calls to a helper named `__name`, which exists in Node and not in a page:
 * the init script would throw before it had installed anything. The page gets a helper of
 * that name that does nothing, first. Under vitest the functions carry no such calls and
 * this changes nothing. Found by rehearsing the command, not by reading it.
 */
const NAME_HELPER = 'globalThis.__name = globalThis.__name || ((target) => target);';

/** Counts every WebGL context the page makes and records every Content Security Policy violation. */
export const WATCH_THE_PAGE = (): void => {
  const made: WebGLRenderingContext[] = [];
  const csp: { directive: string; blocked: string }[] = [];
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
    const context = (original as (...args: unknown[]) => unknown).call(this, kind, ...rest);
    if (context && /^webgl/.test(kind) && !made.includes(context as WebGLRenderingContext)) made.push(context as WebGLRenderingContext);
    return context;
  } as typeof HTMLCanvasElement.prototype.getContext;
  document.addEventListener('securitypolicyviolation', (event) => csp.push({ directive: event.effectiveDirective, blocked: event.blockedURI }));
  (window as unknown as { __fxProof: unknown }).__fxProof = {
    get made() {
      return made.length;
    },
    live: () => made.filter((context) => !context.isContextLost()).length,
    csp,
  };
};

export interface FxProof {
  url: string;
  /** The HTTP status of the document. */
  status: number | null;
  reducedMotion: boolean;
  viewport: { width: number; height: number };
  /** Every FX scene box in document order: what the island says it is doing, and whether it holds a canvas. */
  boxes: { state: string | null; canvas: boolean; layer: boolean }[];
  canvases: number;
  /** WebGL contexts still held when the page had settled, and all the page ever made (the probe's included). */
  liveContexts: number;
  madeContexts: number;
  /** Script files fetched from the app's own static path. */
  scripts: { url: string; bytes: number; wireBytes: number; engine: boolean; format: boolean }[];
  /** The engine's scripts as sent (compressed): what the bundle budget of slice F3 is about. */
  engineWireBytes: number;
  cspViolations: { directive: string; blocked: string }[];
  consoleErrors: string[];
  fxWarnings: string[];
}

export interface ProofOptions {
  reducedMotion?: boolean;
  viewport?: { width: number; height: number };
  /** How long to wait for every FX box to reach a state it stays in (live, calm, off). */
  settleMs?: number;
}

const SETTLED = new Set(['live', 'calm', 'off']);

/** Open `url` in a fresh context and record what F7 asks for. The context is closed again. */
export async function collectFxProof(browser: Browser, url: string, options: ProofOptions = {}): Promise<FxProof> {
  const viewport = options.viewport ?? { width: 1280, height: 800 };
  const reducedMotion = options.reducedMotion === true;
  const context = await browser.newContext({ viewport, reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
  try {
    await context.addInitScript({ content: NAME_HELPER });
    const page = await context.newPage();
    await page.addInitScript(WATCH_THE_PAGE);
    const consoleErrors: string[] = [];
    const fxWarnings: string[] = [];
    const scripts: Promise<FxProof['scripts'][number]>[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
      if (message.type() === 'warning' && message.text().includes('FX scene')) fxWarnings.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    page.on('response', (response) => {
      const address = response.url();
      if (!address.includes('/_next/static/') || !address.split('?')[0].endsWith('.js')) return;
      // `bytes` is the script as text; `wireBytes` what travelled (the body as sent, compressed).
      const wire = response
        .request()
        .sizes()
        .then(
          (sizes) => sizes.responseBodySize,
          () => 0,
        );
      scripts.push(
        response.text().then(
          async (text) => ({ url: address, bytes: text.length, wireBytes: await wire, engine: text.includes(ENGINE_MARK), format: FORMAT_MARKS.some((mark) => text.includes(mark)) }),
          () => ({ url: address, bytes: 0, wireBytes: 0, engine: false, format: false }),
        ),
      );
    });

    const response = await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
    const boxState = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[data-fx="scene"]')].map((box) => ({
          state: box.getAttribute('data-fc-fx-state'),
          canvas: !!box.querySelector('canvas'),
          layer: !!box.querySelector('[data-fc-fx-layer]'),
        })),
      );
    // Hydration writes the first state, which can come after the load event: give it a moment to appear.
    const deadline = Date.now() + (options.settleMs ?? 30_000);
    let boxes = await boxState();
    const firstState = Date.now() + 5000;
    while (Date.now() < firstState && boxes.length > 0 && boxes.every((box) => box.state === null)) {
      await page.waitForTimeout(100);
      boxes = await boxState();
    }
    // Every box the page will draw reaches a state it stays in; a box whose scene was refused never gets one.
    while (Date.now() < deadline && boxes.some((box) => box.state !== null && !SETTLED.has(box.state))) {
      await page.waitForTimeout(250);
      boxes = await boxState();
    }
    // The page's own late requests (a chunk fetched after the scene started) are part of the list.
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    boxes = await boxState();
    const watched = await page.evaluate(() => {
      const proof = (window as unknown as ProofWindow).__fxProof;
      return { live: proof.live(), made: proof.made, csp: proof.csp };
    });
    const fetched = await Promise.all(scripts);
    return {
      url,
      status: response?.status() ?? null,
      reducedMotion,
      viewport,
      boxes,
      canvases: await page.locator('canvas').count(),
      liveContexts: watched.live,
      madeContexts: watched.made,
      scripts: fetched,
      engineWireBytes: fetched.filter((script) => script.engine).reduce((sum, script) => sum + script.wireBytes, 0),
      cspViolations: watched.csp,
      consoleErrors,
      fxWarnings,
    };
  } finally {
    await context.close();
  }
}

/** What a proof must show for a page with one FX scene that is drawn, or the reasons it does not. */
export function problemsOfDrawnScene(proof: FxProof): string[] {
  const problems: string[] = [];
  if (proof.status !== 200) problems.push(`the page answered ${proof.status}`);
  if (proof.boxes.length === 0) problems.push('the page has no FX scene box');
  if (proof.boxes[0]?.state !== 'live') problems.push(`the first FX scene is ${proof.boxes[0]?.state ?? 'not started'}, not live`);
  if (proof.boxes.slice(1).some((box) => box.canvas)) problems.push('a second FX scene holds a canvas: a page draws one');
  if (proof.liveContexts !== 1) problems.push(`the page holds ${proof.liveContexts} WebGL contexts, not one`);
  if (proof.canvases !== 1) problems.push(`the page shows ${proof.canvases} canvases, not one`);
  if (!proof.scripts.some((script) => script.engine)) problems.push('no engine script was fetched');
  if (proof.cspViolations.length > 0) problems.push(`Content Security Policy violations: ${proof.cspViolations.map((v) => `${v.directive} ${v.blocked}`).join(', ')}`);
  if (proof.consoleErrors.length > 0) problems.push(`console errors: ${proof.consoleErrors.slice(0, 3).join(' | ')}`);
  if (proof.fxWarnings.length > 0) problems.push(`FX warnings: ${proof.fxWarnings.join(' | ')}`);
  return problems;
}

/** What a proof must show for a page that draws no scene: one without an FX box, or one kept calm. */
export function problemsOfNoScene(proof: FxProof): string[] {
  const problems: string[] = [];
  if (proof.status !== 200) problems.push(`the page answered ${proof.status}`);
  if (proof.boxes.some((box) => box.canvas || box.layer)) problems.push('an FX scene is drawn');
  if (proof.canvases !== 0) problems.push(`the page shows ${proof.canvases} canvases`);
  if (proof.liveContexts !== 0) problems.push(`the page holds ${proof.liveContexts} WebGL contexts`);
  const engine = proof.scripts.filter((script) => script.engine);
  if (engine.length > 0) problems.push(`the engine was fetched: ${engine.map((script) => script.url).join(', ')}`);
  if (proof.cspViolations.length > 0) problems.push(`Content Security Policy violations: ${proof.cspViolations.map((v) => `${v.directive} ${v.blocked}`).join(', ')}`);
  if (proof.consoleErrors.length > 0) problems.push(`console errors: ${proof.consoleErrors.slice(0, 3).join(' | ')}`);
  return problems;
}

// ---------- two addresses, one picture (F8) ----------

export interface ComparisonSide {
  url: string;
  /** The canvas to read. Default: the first canvas of the page. */
  canvas?: string;
}

export interface FxComparison {
  sizes: [[number, number], [number, number]];
  colours: [number, number];
  differing: number;
  share: number;
  largest: number;
  /** Within the oracle's tolerance, on two real pictures. */
  same: boolean;
  pictures: [PNG, PNG];
}

export interface ComparisonOptions {
  viewport?: { width: number; height: number };
  /** Extra context options for both sides (a device, a locale). */
  context?: BrowserContextOptions;
  timeoutMs?: number;
}

/**
 * The canvas of one address as a picture: reduced motion asked for, the clock stopped
 * before the page loads, everything on the page hidden but the canvas (two apps draw the
 * text over a scene differently, and it is the scene that is compared), and read once two
 * screenshots in a row are the same picture.
 */
async function pictureOf(browser: Browser, side: ComparisonSide, options: ComparisonOptions): Promise<{ picture: PNG; size: [number, number] }> {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    ...options.context,
    reducedMotion: 'reduce',
  });
  try {
    await context.addInitScript({ content: NAME_HELPER });
    const page = await context.newPage();
    await page.addInitScript(STOP_THE_CLOCK);
    await page.goto(side.url, { waitUntil: 'load', timeout: 60_000 });
    const canvas = page.locator(side.canvas ?? 'canvas').first();
    // The comparison asks for reduced motion, so a scene must draw its still frame there. One whose calm
    // state is the box background draws nothing, on purpose: say that, instead of waiting out a timeout.
    const deadline = Date.now() + (options.timeoutMs ?? 45_000);
    for (;;) {
      if ((await canvas.count()) > 0) break;
      const states = await page.evaluate(() => [...document.querySelectorAll('[data-fx="scene"]')].map((box) => box.getAttribute('data-fc-fx-state')));
      if (states[0] === 'calm') {
        throw new Error(
          `the FX scene at ${side.url} draws nothing under reduced motion (its calm state is the box background), so there is no picture to compare: set the scene's "With reduced motion" to "One still frame of the scene" (calm: "frame") and publish again`,
        );
      }
      if (states[0] === 'off') throw new Error(`the FX scene at ${side.url} is off (no WebGL, or the scene could not be drawn), so there is no picture to compare`);
      if (Date.now() > deadline) {
        throw new Error(
          `no canvas appeared at ${side.url} under reduced motion: the page may show a still background instead of its scene there, and then the two can only be compared by looking (the side by side recording)`,
        );
      }
      await page.waitForTimeout(250);
    }
    await canvas.evaluate((element) => {
      // Only the canvas is left to see: hidden content keeps its place, so nothing moves.
      const style = document.createElement('style');
      style.textContent = '*{visibility:hidden !important} [data-fx-proof-shown]{visibility:visible !important}';
      document.head.append(style);
      element.setAttribute('data-fx-proof-shown', '');
      // A layer that fades in must have ended its fade, whatever the page's own timing.
      for (let node = element.parentElement; node; node = node.parentElement) {
        node.style.setProperty('opacity', '1', 'important');
        node.style.setProperty('transition', 'none', 'important');
      }
    });
    let previous = PNG.sync.read(await canvas.screenshot());
    for (let attempt = 0; attempt < 60; attempt++) {
      await page.waitForTimeout(350);
      const next = PNG.sync.read(await canvas.screenshot());
      if (previous.width === next.width && previous.height === next.height && difference(previous, next).differing === 0 && colours(next) > 1) {
        return { picture: next, size: [next.width, next.height] };
      }
      previous = next;
    }
    throw new Error(`the picture at ${side.url} never settled`);
  } finally {
    await context.close();
  }
}

/** Draw the scene at two addresses and compare the pictures. Throws when they are not the same size: then nothing can be compared. */
export async function compareFxAddresses(browser: Browser, a: ComparisonSide, b: ComparisonSide, options: ComparisonOptions = {}): Promise<FxComparison> {
  const first = await pictureOf(browser, a, options);
  const second = await pictureOf(browser, b, options);
  if (first.size[0] !== second.size[0] || first.size[1] !== second.size[1]) {
    throw new Error(
      `the two canvases are not the same size (${first.size.join('x')} at ${a.url}, ${second.size.join('x')} at ${b.url}): give both boxes the same size at this window width, or pass a viewport at which they are`,
    );
  }
  const seen: [number, number] = [colours(first.picture), colours(second.picture)];
  const result = difference(first.picture, second.picture);
  return {
    sizes: [first.size, second.size],
    colours: seen,
    differing: result.differing,
    share: result.share,
    largest: result.largest,
    // A blank or flat frame on either side would make equal pixels mean nothing.
    same: seen[0] >= 50 && seen[1] >= 50 && result.share <= MAX_DIFFERING_SHARE,
    pictures: [first.picture, second.picture],
  };
}

export { CHANNEL_TOLERANCE, MAX_DIFFERING_SHARE };
