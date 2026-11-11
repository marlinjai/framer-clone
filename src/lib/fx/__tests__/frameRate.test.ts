// @vitest-environment node
// The frame rate sampler that drives the engine's one-way performance step down.

import { describe, expect, it } from 'vitest';

import { createFrameRateSampler, lowerBoundFor } from '../frameRate';

/** Feed frames at a steady rate for `seconds`; returns how often a decline was reported. */
function run(sampler: ReturnType<typeof createFrameRateSampler>, fps: number, seconds: number, startAt = 0): { declines: number; end: number } {
  const step = 1000 / fps;
  let declines = 0;
  let now = startAt;
  const end = startAt + seconds * 1000;
  while (now <= end) {
    if (sampler.frame(now)) declines++;
    now += step;
  }
  return { declines, end: now };
}

describe('lowerBoundFor', () => {
  it('holds a fast display to 60 and an ordinary one to 40', () => {
    expect(lowerBoundFor(120)).toBe(60);
    expect(lowerBoundFor(101)).toBe(60);
    expect(lowerBoundFor(100)).toBe(40);
    expect(lowerBoundFor(60)).toBe(40);
    expect(lowerBoundFor(0)).toBe(40);
  });
});

describe('createFrameRateSampler', () => {
  it('never declines at a steady 60 frames per second, however long it runs', () => {
    const sampler = createFrameRateSampler();
    expect(run(sampler, 60, 120).declines).toBe(0);
    expect(sampler.declined).toBe(false);
  });

  it('never declines at a steady 120 frames per second', () => {
    const sampler = createFrameRateSampler();
    expect(run(sampler, 120, 60).declines).toBe(0);
  });

  it('declines once after one full batch of slow windows', () => {
    const sampler = createFrameRateSampler();
    // 10 windows of 250 ms: not yet judged after 2 seconds.
    expect(run(sampler, 20, 2).declines).toBe(0);
    expect(sampler.declined).toBe(false);
    const rest = run(sampler, 20, 2, 2050);
    expect(rest.declines).toBe(1);
    expect(sampler.declined).toBe(true);
  });

  it('reports a decline only once and ignores frames after it', () => {
    const sampler = createFrameRateSampler();
    expect(run(sampler, 20, 60).declines).toBe(1);
    expect(run(sampler, 5, 60, 100_000).declines).toBe(0);
  });

  it('judges a fast display against 60: a drop to 45 declines there, not on a 60 Hz display', () => {
    const fast = createFrameRateSampler();
    // One batch at 120 teaches the sampler the display's rate.
    const warm = run(fast, 120, 3);
    expect(warm.declines).toBe(0);
    expect(run(fast, 45, 6, warm.end).declines).toBe(1);

    const ordinary = createFrameRateSampler();
    expect(run(ordinary, 45, 30).declines).toBe(0);
  });

  it('survives a single slow window (a paused tab, a collection pause)', () => {
    const sampler = createFrameRateSampler();
    const a = run(sampler, 60, 1);
    // One frame after a 2 second gap closes a window with a very low reading.
    expect(sampler.frame(a.end + 2000)).toBe(false);
    expect(run(sampler, 60, 10, a.end + 2016).declines).toBe(0);
  });

  it('needs more than the threshold share of slow windows', () => {
    // 4 windows per batch at 0.5: 2 slow of 4 is not more than half, 3 is.
    const notEnough = createFrameRateSampler({ iterations: 4, windowMs: 100, threshold: 0.5 });
    let t = 0;
    const window = (s: ReturnType<typeof createFrameRateSampler>, fps: number) => {
      const step = 1000 / fps;
      const until = t + 100;
      let declined = false;
      // Frames across one whole window, the last one closing it.
      for (; t < until; t += step) declined = s.frame(t) || declined;
      declined = s.frame(until) || declined;
      t = until + step;
      return declined;
    };
    expect([window(notEnough, 60), window(notEnough, 60), window(notEnough, 20), window(notEnough, 20)]).toEqual([false, false, false, false]);

    t = 0;
    const enough = createFrameRateSampler({ iterations: 4, windowMs: 100, threshold: 0.5 });
    expect([window(enough, 60), window(enough, 20), window(enough, 20), window(enough, 20)]).toEqual([false, false, false, true]);
  });

  it('starts the window again when the clock goes backwards, and ignores a non-finite time', () => {
    const sampler = createFrameRateSampler();
    expect(sampler.frame(5000)).toBe(false);
    expect(sampler.frame(100)).toBe(false);
    expect(sampler.frame(Number.NaN)).toBe(false);
    expect(run(sampler, 60, 30, 116).declines).toBe(0);
  });
});
