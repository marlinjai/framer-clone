"use client";

/**
 * Interactivity bus (spec section 3).
 *
 * A single, refcounted window-level subscriber to pointer + scroll events.
 * Layers don't each attach their own listeners; they call `useInteractivity`
 * and get a smoothed, per-layer target lerped with their declared
 * `momentum` / `spring` constraint, clamped to the configured `axes`.
 *
 * The shape mirrors what the spec calls the "Track-mouse / Momentum / Spring
 * / Mouse-axes" knobs Unicorn exposes per element:
 *
 *   - `trackMouse`: 0..1 how much of the raw pointer feeds the target.
 *   - `momentum`:   0..1 inertia weight, smooths bursty motion.
 *   - `spring`:     0..1 how aggressively to chase the target each frame.
 *   - `axes`:       which axes the layer is allowed to move on.
 *
 * Mathematically per frame:
 *   target  = rawPointer * trackMouse                    (axes-masked)
 *   velocity += (target - current) * spring
 *   velocity *= (1 - 0.15) * (1 - 0.85 * momentum)        (damped, more momentum = more carry)
 *   current  += velocity
 *
 * The hook returns a stable ref the caller mutates / reads from `useFrame`,
 * which keeps the engine off React state for per-frame motion.
 */

import { useEffect, useMemo, useState } from "react";
import { Vector2 } from "three";

import type { InteractivitySpec } from "./types";

type Snapshot = {
  /** Normalized pointer in [-1, 1], y-up to match three's NDC convention. */
  pointer: { x: number; y: number };
  /** Per-frame pointer delta, also in [-1, 1] space. */
  velocity: { x: number; y: number };
  /** Scroll progress in [0, 1]: 0 at top, 1 at bottom of the document. */
  scroll: number;
};

/**
 * Module-level singleton: there's one window, one mouse, one scroll bar. We
 * refcount listener attachment so the bus is only live when at least one
 * layer is subscribed.
 */
class InteractivityBus {
  private state: Snapshot = {
    pointer: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    scroll: 0,
  };
  private lastPointer = { x: 0, y: 0 };
  private refcount = 0;
  private installed = false;

  /** Snapshot read by layers each frame. Mutated in place to keep alloc-free. */
  read(): Snapshot {
    return this.state;
  }

  /** Increment refcount; install DOM listeners on the first subscriber. */
  acquire(): () => void {
    this.refcount += 1;
    if (this.refcount === 1) this.install();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.refcount -= 1;
      if (this.refcount === 0) this.uninstall();
    };
  }

  private install(): void {
    if (this.installed || typeof window === "undefined") return;
    window.addEventListener("pointermove", this.onPointerMove, { passive: true });
    window.addEventListener("scroll", this.onScroll, { passive: true });
    // Seed scroll once at install so the first read isn't a stale 0 if the
    // page already loaded mid-scroll (e.g. on a back-nav restore).
    this.onScroll();
    this.installed = true;
  }

  private uninstall(): void {
    if (!this.installed || typeof window === "undefined") return;
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("scroll", this.onScroll);
    this.installed = false;
  }

  private onPointerMove = (e: PointerEvent): void => {
    // Map clientX/Y to normalized [-1, 1], y-up. Matches three's pointer
    // convention so layers reading `state.pointer` from r3f and ours line up.
    const x = (e.clientX / window.innerWidth) * 2 - 1;
    const y = -((e.clientY / window.innerHeight) * 2 - 1);
    // Velocity is the per-event delta. Layers smooth it further if they want
    // momentum; this is just the raw measurement.
    this.state.velocity.x = x - this.lastPointer.x;
    this.state.velocity.y = y - this.lastPointer.y;
    this.state.pointer.x = x;
    this.state.pointer.y = y;
    this.lastPointer.x = x;
    this.lastPointer.y = y;
  };

  private onScroll = (): void => {
    if (typeof document === "undefined") return;
    const max = Math.max(
      0,
      (document.documentElement?.scrollHeight ?? 0) - window.innerHeight,
    );
    const y = window.scrollY ?? 0;
    this.state.scroll = max <= 0 ? 0 : Math.min(1, Math.max(0, y / max));
  };
}

const bus = new InteractivityBus();

/** Public read-only handle; mostly useful for debugging/leva. */
export function readInteractivity(): Snapshot {
  return bus.read();
}

/** Built-in default applied when a layer doesn't declare interactivity. */
export const DEFAULT_INTERACTIVITY: InteractivitySpec = {
  trackMouse: 0,
  momentum: 0,
  spring: 0,
  axes: "both",
};

/**
 * Layer-side state container. Mutated in place each frame by `step()`. Mirrors
 * what a layer would otherwise reach for state.pointer + a hand-rolled lerp
 * for, but with the spec's spring/momentum/axes semantics applied.
 */
export interface InteractivityTarget {
  /** Smoothed pointer, [-1, 1], axes-masked. Feeds uMouse uniforms. */
  mouse: Vector2;
  /** Smoothed pointer velocity, useful for trail/inertia effects. */
  velocity: Vector2;
  /** Scroll progress, [0, 1]. Feeds uScroll uniforms. */
  scroll: number;
  /** Step the target one frame forward using the supplied spec / reduce flag. */
  step: (spec: InteractivitySpec, reduce: boolean) => void;
}

function axisMask(axes: InteractivitySpec["axes"]): { x: number; y: number } {
  if (axes === "x") return { x: 1, y: 0 };
  if (axes === "y") return { x: 0, y: 1 };
  return { x: 1, y: 1 };
}

/**
 * Hook a layer into the interactivity bus. Returns a stable handle whose
 * `mouse`/`velocity`/`scroll` are advanced when the layer calls `step()` from
 * its own `useFrame` (gives the layer control over reduce-motion behavior).
 *
 * The hook does the listener acquire/release dance through `useEffect`, so a
 * layer that mounts/unmounts (e.g. toggled visible) doesn't leak handlers.
 */
function createTarget(): InteractivityTarget {
  const mouse = new Vector2(0, 0);
  const velocity = new Vector2(0, 0);
  const target: InteractivityTarget = {
    mouse,
    velocity,
    scroll: 0,
    step: () => undefined,
  };
  target.step = (spec, reduce) => {
    const snap = bus.read();
    target.scroll = snap.scroll;
    if (reduce || spec.trackMouse <= 0) {
      // Reduce-motion or "track mouse: off": collapse to the rest position.
      // We don't suddenly snap (jumpy), we ease toward 0 with the same
      // spring/momentum the layer asked for; with trackMouse:0 the target
      // is just (0,0) and the spring naturally settles there.
      mouse.x += (0 - mouse.x) * Math.max(spec.spring, 0.08);
      mouse.y += (0 - mouse.y) * Math.max(spec.spring, 0.08);
      velocity.set(0, 0);
      return;
    }
    const mask = axisMask(spec.axes);
    const tx = snap.pointer.x * spec.trackMouse * mask.x;
    const ty = snap.pointer.y * spec.trackMouse * mask.y;
    // Spring chases the target; momentum decides how much carry survives
    // each frame. spring=1, momentum=0 is the existing v7 "lerp 0.04"
    // feel turned all the way up; spring=0.06, momentum=0.85 is a soft,
    // glidey response (the Unicorn defaults we're targeting).
    const k = Math.max(0, Math.min(1, spec.spring));
    const damp = 1 - 0.15 - 0.7 * Math.max(0, Math.min(1, spec.momentum));
    velocity.x = (velocity.x + (tx - mouse.x) * k) * damp;
    velocity.y = (velocity.y + (ty - mouse.y) * k) * damp;
    mouse.x += velocity.x;
    mouse.y += velocity.y;
  };
  return target;
}

export function useInteractivity(): InteractivityTarget {
  // useState's lazy initializer keeps the target stable across renders
  // without a ref read at render time (the project's react-hooks plugin
  // forbids `ref.current` reads during render).
  const [target] = useState<InteractivityTarget>(createTarget);

  // Refcount the bus so the global listeners only run while a subscribed
  // layer is alive. Strict-mode double-mount handles itself: acquire/release
  // are symmetric.
  useEffect(() => {
    const release = bus.acquire();
    return release;
  }, []);

  return target;
}

/**
 * Convenience: pull the layer's `interactivity` spec or the default, memoized
 * so a per-frame call doesn't allocate.
 */
export function useInteractivitySpec(
  spec: InteractivitySpec | undefined,
): InteractivitySpec {
  // Memo key threads the four fields so prop-equal-but-not-identical specs
  // (common with leva re-emits) don't churn the downstream memo.
  const trackMouse = spec?.trackMouse;
  const momentum = spec?.momentum;
  const spring = spec?.spring;
  const axes = spec?.axes;
  return useMemo<InteractivitySpec>(
    () =>
      trackMouse === undefined
        ? DEFAULT_INTERACTIVITY
        : {
            trackMouse,
            momentum: momentum ?? 0,
            spring: spring ?? 0,
            axes: axes ?? "both",
          },
    [trackMouse, momentum, spring, axes],
  );
}
