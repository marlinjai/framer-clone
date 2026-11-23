// The editor's still-frame queue (../stillQueue): one job at a time, only in idle time, shared by askers
// of the same picture, dropped or aborted when its askers leave, kept for a while, failures not retried.
// The renderer and the idle wait are stood in for; the real engine: test/behaviour/fxCanvas.spec.ts.

import { describe, expect, it } from 'vitest';
import { createStillQueue, stillPixelRatio, STILL_KEEP, STILL_MIN_PIXEL_RATIO, STILL_PIXEL_BUDGET, type StillOutcome, type StillPicture, type StillTarget } from '../stillQueue';

interface Job {
  target: StillTarget;
  signal: AbortSignal;
  resolve: (picture: StillPicture) => void;
  reject: (reason: string) => void;
}

function harness(keep?: number) {
  const jobs: Job[] = [];
  const idle: (() => void)[] = [];
  const queue = createStillQueue({
    render: (target, signal) =>
      new Promise<StillPicture>((resolve, reject) => {
        const job = { target, signal, resolve, reject };
        jobs.push(job);
        signal.addEventListener('abort', () => reject('aborted'));
      }),
    whenIdle: (run) => {
      idle.push(run);
      return () => {
        const at = idle.indexOf(run);
        if (at >= 0) idle.splice(at, 1);
      };
    },
    keep,
  });
  const host = () => document.createElement('div');
  const target = (stored: unknown = 'scene') => () => ({ host: host(), stored, pixelRatio: 1 });
  const ask = (key: string, into: StillOutcome[] = [], make = target()) => ({ leave: queue.request(key, make, (o) => into.push(o)), into });
  const runIdle = () => idle.splice(0).forEach((run) => run());
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));
  const picture = (width = 10): StillPicture => ({ width, height: 10 }) as unknown as StillPicture;
  return { queue, jobs, idle, ask, runIdle, settle, picture, target };
}

describe('still queue', () => {
  it('runs one job at a time, each only when the browser is idle', async () => {
    const h = harness();
    const a = h.ask('a');
    const b = h.ask('b');
    expect(h.jobs).toHaveLength(0);
    h.runIdle();
    expect(h.jobs).toHaveLength(1);
    // The second waits for the first, even when idle time comes.
    h.runIdle();
    expect(h.jobs).toHaveLength(1);
    expect(h.queue.stats()).toMatchObject({ running: 1, queued: 1 });
    h.jobs[0].resolve(h.picture());
    await h.settle();
    expect(a.into).toEqual([{ ok: true, picture: h.picture() }]);
    expect(h.jobs).toHaveLength(1);
    h.runIdle();
    expect(h.jobs).toHaveLength(2);
    h.jobs[1].resolve(h.picture(20));
    await h.settle();
    expect(b.into[0]).toMatchObject({ ok: true });
  });

  it('askers of the same picture share one job and one result; a later asker gets it at once', async () => {
    const h = harness();
    const first = h.ask('same');
    const second = h.ask('same');
    h.runIdle();
    h.jobs[0].resolve(h.picture());
    await h.settle();
    expect(h.jobs).toHaveLength(1);
    expect(first.into).toHaveLength(1);
    expect(second.into).toHaveLength(1);
    const late = h.ask('same');
    await h.settle();
    expect(late.into).toHaveLength(1);
    expect(h.idle).toHaveLength(0);
    expect(h.jobs).toHaveLength(1);
  });

  it('a request whose askers all leave before it starts is never drawn', async () => {
    const h = harness();
    const a = h.ask('gone');
    a.leave();
    h.runIdle();
    expect(h.jobs).toHaveLength(0);
    expect(h.queue.stats()).toEqual({ running: 0, queued: 0, kept: 0, failed: 0 });
  });

  it('a running job whose askers leave is aborted, and nothing is kept of it', async () => {
    const h = harness();
    const a = h.ask('busy');
    h.runIdle();
    a.leave();
    expect(h.jobs[0].signal.aborted).toBe(true);
    await h.settle();
    expect(h.queue.stats()).toEqual({ running: 0, queued: 0, kept: 0, failed: 0 });
    // The next request starts once the aborted one has settled.
    h.ask('next');
    h.runIdle();
    expect(h.jobs).toHaveLength(2);
  });

  it('an asker that comes back while its aborted job settles gets the picture drawn again', async () => {
    const h = harness();
    const a = h.ask('back');
    h.runIdle();
    a.leave();
    const again = h.ask('back');
    await h.settle();
    h.runIdle();
    expect(h.jobs).toHaveLength(2);
    h.jobs[1].resolve(h.picture());
    await h.settle();
    expect(again.into).toHaveLength(1);
  });

  it('is drawn in a box that is still there: an asker whose box went is passed over', async () => {
    const h = harness();
    h.queue.request('k', () => null, () => {});
    const kept = h.ask('k');
    h.runIdle();
    expect(h.jobs).toHaveLength(1);
    h.jobs[0].resolve(h.picture());
    await h.settle();
    expect(kept.into).toHaveLength(1);
  });

  it('a failed picture is not drawn again for the same key; the reason reaches every asker', async () => {
    const h = harness();
    const a = h.ask('broken');
    h.runIdle();
    h.jobs[0].reject('no-webgl');
    await h.settle();
    expect(a.into).toEqual([{ ok: false, reason: 'no-webgl' }]);
    const b = h.ask('broken');
    await h.settle();
    h.runIdle();
    expect(h.jobs).toHaveLength(1);
    expect(b.into).toEqual([{ ok: false, reason: 'no-webgl' }]);
  });

  it('a failure that may pass (a lost context) is told, and the next request tries again', async () => {
    const h = harness();
    const a = h.ask('flaky');
    h.runIdle();
    h.jobs[0].reject('context-lost');
    await h.settle();
    expect(a.into).toEqual([{ ok: false, reason: 'context-lost' }]);
    a.leave();
    h.ask('flaky');
    h.runIdle();
    expect(h.jobs).toHaveLength(2);
  });

  it(`keeps at most ${STILL_KEEP} pictures nobody shows, the most recently shown`, async () => {
    const h = harness(2);
    for (const key of ['1', '2', '3']) {
      const a = h.ask(key);
      h.runIdle();
      h.jobs.at(-1)!.resolve(h.picture());
      await h.settle();
      a.leave();
    }
    expect(h.queue.stats().kept).toBe(2);
    // '1' was dropped: asking again draws it again; '3' is still there.
    h.ask('3');
    await h.settle();
    h.runIdle();
    expect(h.jobs).toHaveLength(3);
    h.ask('1');
    h.runIdle();
    expect(h.jobs).toHaveLength(4);
  });

  it('askers whose boxes are all out of the page when the job starts are told, and may ask again', async () => {
    const h = harness();
    const into: StillOutcome[] = [];
    const leave = h.queue.request('k', () => null, (o) => into.push(o));
    h.runIdle();
    expect(h.jobs).toHaveLength(0);
    expect(into).toEqual([{ ok: false, reason: 'no-host' }]);
    leave();
    const again = h.ask('k');
    h.runIdle();
    expect(h.jobs).toHaveLength(1);
    h.jobs[0].resolve(h.picture());
    await h.settle();
    expect(again.into).toHaveLength(1);
  });
});

describe('stillPixelRatio', () => {
  it('is the live scene ratio on this screen, up to the scene highest', () => {
    expect(stillPixelRatio(400, 300, 1.75, 2)).toBe(1.75);
    expect(stillPixelRatio(400, 300, 2, 1)).toBe(1);
  });
  it('stays inside the pixel budget for any box, and never below the floor', () => {
    const ratio = stillPixelRatio(1600, 1600, 2, 2);
    expect(1600 * 1600 * ratio * ratio).toBeLessThanOrEqual(STILL_PIXEL_BUDGET);
    expect(ratio).toBeGreaterThan(0.8);
    const huge = stillPixelRatio(20000, 20000, 2, 2);
    expect(huge).toBeGreaterThanOrEqual(STILL_MIN_PIXEL_RATIO);
    expect(20000 * 20000 * huge * huge).toBeLessThanOrEqual(STILL_PIXEL_BUDGET);
  });
});
