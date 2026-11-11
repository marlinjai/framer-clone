/**
 * Frame rate sampling for the one-way performance step down.
 *
 * Replaces the `PerformanceMonitor` the engine used from @react-three/drei
 * (lumitra-web commit 8a77254), so Sites does not carry drei for one
 * component. Same sampling as drei's: frames are counted over windows of
 * `windowMs`, each window yields one frames-per-second reading, and after
 * `iterations` readings the batch is judged against a lower bound that depends
 * on the fastest rate seen (a 120 Hz display is held to 60, a 60 Hz one to 40).
 * The batch declines when more than `threshold` of its readings are below that
 * bound.
 *
 * Deliberate difference from drei: only a decline is reported, once, and
 * sampling stops there. The engine's step down is sticky (it never steps back
 * up, because that produces a visible jank cycle), so nothing after the first
 * decline can change the outcome. drei also counted batches that were FASTER
 * than the upper bound as "flips" and called its fallback after four of them,
 * which the engine routed to the same step down: a machine that held its frame
 * rate lost its heavy passes after about ten seconds. That was never the
 * intent ("drop the pixel budget when the frame rate stays low"), so it is not
 * carried over.
 */

export interface FrameRateSamplerOptions {
  /** Readings per batch. */
  iterations?: number;
  /** Length of one sampling window in milliseconds. */
  windowMs?: number;
  /** Share of a batch that must be below the lower bound to decline. */
  threshold?: number;
}

export interface FrameRateSampler {
  /**
   * Record one rendered frame at time `now` (milliseconds, monotonic).
   * Returns true exactly once: on the frame that completes a declining batch.
   */
  frame(now: number): boolean;
  /** True once a decline was reported; further frames are ignored. */
  readonly declined: boolean;
}

/** The lower bound for a display whose fastest observed rate is `refreshRate`. */
export function lowerBoundFor(refreshRate: number): number {
  return refreshRate > 100 ? 60 : 40;
}

export function createFrameRateSampler(options: FrameRateSamplerOptions = {}): FrameRateSampler {
  const iterations = Math.max(1, Math.floor(options.iterations ?? 10));
  const windowMs = Math.max(1, options.windowMs ?? 250);
  const threshold = options.threshold ?? 0.75;

  let frames: number[] = [];
  let readings: number[] = [];
  let refreshRate = 0;
  let declined = false;

  return {
    get declined() {
      return declined;
    },
    frame(now: number): boolean {
      if (declined || !Number.isFinite(now)) return false;
      frames.push(now);
      const elapsed = now - frames[0];
      // A clock that went backwards (a tab restored from the back/forward
      // cache) would yield a negative window: start the window again.
      if (elapsed < 0) {
        frames = [now];
        return false;
      }
      if (elapsed < windowMs) return false;

      const fps = Math.round((frames.length / elapsed) * 1000);
      frames = [];
      refreshRate = Math.max(refreshRate, fps);
      readings.push(fps);
      if (readings.length < iterations) return false;

      const lower = lowerBoundFor(refreshRate);
      const slow = readings.filter((value) => value < lower).length;
      readings = [];
      if (slow > iterations * threshold) {
        declined = true;
        return true;
      }
      return false;
    },
  };
}
