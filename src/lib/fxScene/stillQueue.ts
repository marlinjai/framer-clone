// src/lib/fxScene/stillQueue.ts
//
// The editor's still frames of FX scenes (src/components/fx/FxLayer.tsx, FxStillLayer): every breakpoint
// frame an FX scene box is NOT drawn live in shows one still frame of its scene, at that frame's own size.
// Each still frame needs a WebGL context for a moment, so they are made one at a time, here:
//
//  - ONE job runs at a time, so the canvas never holds more than the live scene's context and one
//    still frame's (the browser's context budget, plan docs/plans/2026-11-08-lumitra-fx-in-sites.md);
//  - a job starts only when the browser is idle (`whenIdle`), so typing, dragging and zooming go first;
//  - requests for the same picture (same scene, size and pixel ratio: the key) share one job and one
//    result;
//  - a request whose last asker leaves is dropped before it starts, and aborted while it runs;
//  - a result nobody shows any more is kept for a while (`keep` of them, the most recently shown), so a
//    frame that shows the box again (Live moved away from it) has its picture at once;
//  - a job that failed for good is not run again for the same key (a refused scene, no WebGL); one that
//    may pass (a lost context, a chunk that did not arrive) is forgotten, so the next request tries
//    again. Either way the askers keep the box's own background meanwhile, as the published page does.
//
// Pure: no React, no DOM beyond what the injected renderer does, no engine code (the renderer is handed in
// by the caller, which reaches the engine by a dynamic import only).

/** What a job draws: placed by one of the askers, where the scene is drawn for a moment. */
export interface StillTarget {
  /** The element the scene is drawn in while the job runs (a layer placed in the box, sized as it). */
  host: HTMLElement;
  /** The box's stored `fx` prop. */
  stored: unknown;
  /** The pixel ratio to draw at. */
  pixelRatio: number;
  /** Where a stored image address is fetched from on this surface (see renderFxScene). */
  resolveImage?: (src: string) => string | null;
}

/** The picture of one still frame. */
export type StillPicture = CanvasImageSource & { width: number; height: number };

/** What an asker is told: the picture, or why there is none. */
export type StillOutcome = { ok: true; picture: StillPicture } | { ok: false; reason: string };

/** Draws one still frame; rejects with a reason (a string) when it cannot, or `aborted`. */
export type StillRenderer = (target: StillTarget, signal: AbortSignal) => Promise<StillPicture>;

export interface StillQueueOptions {
  render: StillRenderer;
  /** Calls `run` when the browser is idle; returns a cancel. */
  whenIdle: (run: () => void) => () => void;
  /** How many pictures nobody shows are kept (the most recently shown). */
  keep?: number;
}

export interface StillQueue {
  /**
   * Ask for the picture of `key`. `target` is called when the job starts, on one of the askers that are
   * still there, so the scene is drawn in a box that exists. `listener` gets the outcome (at once, in a
   * microtask, when it is known already). Returns the leave.
   */
  request: (key: string, target: () => StillTarget | null, listener: (outcome: StillOutcome) => void) => () => void;
  /** What the queue holds now (for tests). */
  stats: () => { running: number; queued: number; kept: number; failed: number };
}

interface Asker {
  target: () => StillTarget | null;
  listener: (outcome: StillOutcome) => void;
}

interface Entry {
  key: string;
  askers: Set<Asker>;
  state: 'queued' | 'running' | 'done' | 'failed';
  outcome?: StillOutcome;
  abort?: AbortController;
  /** When a done picture was last shown, for keeping the most recent ones. */
  shownAt: number;
}

export const STILL_KEEP = 6;

/** Failures that do not pass by trying again with the same scene on the same browser: kept, never redrawn. */
export const LASTING_FAILURES: ReadonlySet<string> = new Set(['refused', 'no-webgl']);

/** The most pixels one still frame is drawn with: about a 1400 x 1400 picture, a bounded moment of GPU work and memory. Takes precedence over the ratio floor. */
export const STILL_PIXEL_BUDGET = 2_000_000;
/** The least pixel ratio a still frame is drawn at (a degenerate ratio of 0 is never asked for); the pixel budget wins over it, so a huge box is drawn below the floor. */
export const STILL_MIN_PIXEL_RATIO = 0.01;

/**
 * The pixel ratio a still frame of a `width` x `height` box is drawn at: the one the live scene would use on
 * this screen (the device's, up to the scene's own highest), lowered so the picture stays inside the budget.
 * Rounded to hundredths, so a key is stable.
 */
export function stillPixelRatio(width: number, height: number, sceneMax: number, device: number): number {
  let ratio = Math.min(device, sceneMax);
  const area = width * height;
  if (area > 0 && area * ratio * ratio > STILL_PIXEL_BUDGET) ratio = Math.sqrt(STILL_PIXEL_BUDGET / area);
  const rounded = Math.floor(ratio * 100) / 100;
  if (area <= 0) return Math.max(STILL_MIN_PIXEL_RATIO, rounded);
  // The floor keeps a degenerate ratio of 0 out, but never lifts a picture over the budget: a huge box is drawn smaller than the floor.
  const budgetRatio = Math.floor(Math.sqrt(STILL_PIXEL_BUDGET / area) * 1e6) / 1e6;
  return Math.min(Math.max(STILL_MIN_PIXEL_RATIO, rounded), budgetRatio);
}

export function createStillQueue({ render, whenIdle, keep = STILL_KEEP }: StillQueueOptions): StillQueue {
  const entries = new Map<string, Entry>();
  const queue: Entry[] = [];
  let running: Entry | null = null;
  let cancelIdle: (() => void) | null = null;
  let tick = 0;

  const tell = (entry: Entry, outcome: StillOutcome) => {
    for (const asker of [...entry.askers]) asker.listener(outcome);
  };

  /** Keep at most `keep` settled keys (pictures and failures) that nobody shows: the most recently shown. */
  const trim = () => {
    const idle = [...entries.values()]
      .filter((e) => (e.state === 'done' || e.state === 'failed') && e.askers.size === 0)
      .sort((a, b) => b.shownAt - a.shownAt);
    for (const entry of idle.slice(keep)) entries.delete(entry.key);
  };

  const pump = () => {
    if (running || cancelIdle || queue.length === 0) return;
    cancelIdle = whenIdle(() => {
      cancelIdle = null;
      start();
    });
  };

  const start = () => {
    if (running) return;
    let entry = queue.shift();
    // Entries nobody asks for any more were dropped from the map; skip what is left of them.
    while (entry && (entries.get(entry.key) !== entry || entry.askers.size === 0)) entry = queue.shift();
    if (!entry) return;
    let target: StillTarget | null = null;
    for (const asker of entry.askers) {
      target = asker.target();
      if (target) break;
    }
    if (!target) {
      // No asker can place the scene now (their boxes are out of the page for the moment): nothing is drawn,
      // and they are told, so none of them waits for a picture that is not coming (they may ask again).
      entries.delete(entry.key);
      tell(entry, { ok: false, reason: 'no-host' });
      pump();
      return;
    }
    const job = entry;
    job.state = 'running';
    job.abort = new AbortController();
    running = job;
    render(target, job.abort.signal).then(
      (picture) => settle(job, { ok: true, picture }),
      (reason: unknown) => settle(job, { ok: false, reason: typeof reason === 'string' ? reason : 'renderer-error' }),
    );
  };

  const settle = (job: Entry, outcome: StillOutcome) => {
    if (running === job) running = null;
    job.abort = undefined;
    if (!outcome.ok && outcome.reason === 'aborted') {
      // Aborted because its askers left: if some came back meanwhile, it is drawn again for them.
      if (job.askers.size > 0 && entries.get(job.key) === job) {
        job.state = 'queued';
        queue.push(job);
      } else if (entries.get(job.key) === job) entries.delete(job.key);
      pump();
      return;
    }
    if (!outcome.ok && !LASTING_FAILURES.has(outcome.reason)) {
      // A failure that may pass (a chunk that did not arrive, a lost context, a renderer error): told, and
      // forgotten, so the next request for this picture tries again.
      if (entries.get(job.key) === job) entries.delete(job.key);
      tell(job, outcome);
      pump();
      return;
    }
    job.state = outcome.ok ? 'done' : 'failed';
    job.outcome = outcome;
    job.shownAt = ++tick;
    tell(job, outcome);
    trim();
    pump();
  };

  const request: StillQueue['request'] = (key, target, listener) => {
    const asker: Asker = { target, listener };
    let entry = entries.get(key);
    if (!entry) {
      entry = { key, askers: new Set(), state: 'queued', shownAt: 0 };
      entries.set(key, entry);
      queue.push(entry);
    }
    entry.askers.add(asker);
    const known = entry;
    if (known.outcome) {
      known.shownAt = ++tick;
      const outcome = known.outcome;
      queueMicrotask(() => {
        if (known.askers.has(asker)) asker.listener(outcome);
      });
    }
    pump();
    return () => {
      if (!known.askers.delete(asker) || known.askers.size > 0) return;
      if (known.state === 'queued') {
        // Only its own entry: a retired one (told no-host) may have been replaced under the same key.
        if (entries.get(known.key) === known) entries.delete(known.key);
      } else if (known.state === 'running') {
        known.abort?.abort();
      } else {
        // Done or failed: kept for a while (a failed key is not drawn again; whoever asks gets the reason at once).
        known.shownAt = ++tick;
        trim();
      }
    };
  };

  return {
    request,
    stats: () => {
      const all = [...entries.values()];
      return {
        running: running ? 1 : 0,
        queued: all.filter((e) => e.state === 'queued').length,
        kept: all.filter((e) => e.state === 'done').length,
        failed: all.filter((e) => e.state === 'failed').length,
      };
    },
  };
}

/** `requestIdleCallback` where there is one (bounded, so a busy page still gets its pictures), else a short timeout. */
export function whenBrowserIdle(run: () => void, timeout = 1000): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(() => run(), { timeout });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(run, 50);
  return () => window.clearTimeout(id);
}
