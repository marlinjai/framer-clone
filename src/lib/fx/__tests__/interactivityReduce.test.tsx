// Pointer settings and reduced motion (slice L2): with `reduce` set the engine's pointer smoothing
// collapses to the rest position whatever the pointer settings are, so the still frame the FX
// owner compares (`calm: 'frame'`) is the same with pointer settings on as with none.
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DEFAULT_INTERACTIVITY, useInteractivity, type InteractivityTarget } from '../interactivity';
import { followPointerPlainly } from '../layers/noiseFill';
import { pointerBaseOf } from '../layerOps';
import type { InteractivitySpec } from '../types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const loud: InteractivitySpec = { trackMouse: 1, momentum: 1, spring: 1, axes: 'both' };

function mountTarget(): { target: () => InteractivityTarget; unmount: () => void } {
  let current: InteractivityTarget | null = null;
  const Probe = () => {
    current = useInteractivity();
    return null;
  };
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() => root.render(<Probe />));
  return { target: () => current!, unmount: () => act(() => root.unmount()) };
}

describe('pointer settings under reduced motion', () => {
  it('keeps the smoothed pointer at rest while the pointer moves, for the loudest settings', () => {
    const probe = mountTarget();
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: window.innerWidth, clientY: 0 }));
    });
    const t = probe.target();
    for (let i = 0; i < 60; i += 1) t.step(loud, true);
    expect(t.mouse.x).toBeCloseTo(0, 6);
    expect(t.mouse.y).toBeCloseTo(0, 6);
    expect(t.velocity.length()).toBe(0);
    // the same settings without reduced motion do follow the pointer (the control)
    for (let i = 0; i < 60; i += 1) t.step(loud, false);
    expect(Math.abs(t.mouse.x)).toBeGreaterThan(0.1);
    probe.unmount();
  });
});


describe('the noise field\'s pointer base reproduces its old plain follow', () => {
  // Without pointer settings the noise field runs `mouse += (pointer - mouse) * 0.04` (layers/noiseFill.tsx).
  // A first edit stores pointerBaseOf('noiseFill') and the engine's second-order smoothing takes over:
  // the two must be the same motion, or changing one value (the axes) would change the feel too.
  it('follows a pointer step like the lerp does, within a small tolerance, and neither passes the target', () => {
    const probe = mountTarget();
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: window.innerWidth, clientY: window.innerHeight / 2 }));
    });
    const t = probe.target();
    const base = pointerBaseOf('noiseFill') as InteractivitySpec;
    let legacy = 0;
    let worst = 0;
    let peakEngine = 0;
    let peakLegacy = 0;
    for (let frame = 1; frame <= 180; frame += 1) {
      legacy += (1 - legacy) * 0.04;
      t.step(base, false);
      worst = Math.max(worst, Math.abs(t.mouse.x - legacy));
      peakEngine = Math.max(peakEngine, t.mouse.x);
      peakLegacy = Math.max(peakLegacy, legacy);
    }
    expect(worst).toBeLessThan(0.02);
    expect(peakEngine).toBeLessThanOrEqual(1.001);
    expect(peakLegacy).toBeLessThanOrEqual(1);
    expect(t.mouse.x).toBeGreaterThan(0.99);
    probe.unmount();
  });

  it('the earlier base (momentum 0, spring 0.04) is NOT that motion: it overshoots, which is why it was replaced', () => {
    const probe = mountTarget();
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: window.innerWidth, clientY: window.innerHeight / 2 }));
    });
    const t = probe.target();
    let peak = 0;
    for (let frame = 0; frame < 180; frame += 1) {
      t.step({ trackMouse: 1, momentum: 0, spring: 0.04, axes: 'both' }, false);
      peak = Math.max(peak, t.mouse.x);
    }
    expect(peak).toBeGreaterThan(1.1);
    probe.unmount();
  });
});


describe('a noise field without pointer settings keeps the engine\'s pointer target in step', () => {
  const zero: InteractivitySpec = DEFAULT_INTERACTIVITY;
  const pointer = { x: 0.8, y: -0.4 };

  it('(c) the engine step that runs just before does not undo the copied position: two frames, settings added, one frame, no jump', () => {
    const probe = mountTarget();
    const engine = probe.target();
    const uMouse = new THREE.Vector2(0, 0);
    // what the component does every frame for a layer without settings: step with the default spec, then follow plainly
    for (let frame = 0; frame < 120; frame += 1) {
      engine.step(zero, false);
      followPointerPlainly(uMouse, pointer, engine);
    }
    expect(uMouse.x).toBeGreaterThan(0.7);
    // two more frames: the engine target sits where the field is (the step's easing toward 0 was overwritten)
    for (let frame = 0; frame < 2; frame += 1) {
      engine.step(zero, false);
      followPointerPlainly(uMouse, pointer, engine);
      expect(engine.mouse.x).toBeCloseTo(uMouse.x, 9);
      expect(engine.mouse.y).toBeCloseTo(uMouse.y, 9);
      expect(engine.velocity.length()).toBe(0);
    }
    // settings added (the first edit): one engine frame carries on from where the field is
    const before = uMouse.clone();
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: ((pointer.x + 1) / 2) * window.innerWidth, clientY: ((1 - pointer.y) / 2) * window.innerHeight }));
    });
    engine.step(pointerBaseOf('noiseFill') as InteractivitySpec, false);
    expect(Math.abs(engine.mouse.x - before.x)).toBeLessThan(0.05);
    expect(Math.abs(engine.mouse.y - before.y)).toBeLessThan(0.05);
    probe.unmount();
  });

  it('(b) writing one layer\'s pointer target is not read by another layer of the same scene (one target per layer component)', () => {
    const a = mountTarget();
    const b = mountTarget();
    expect(a.target()).not.toBe(b.target());
    const uMouse = new THREE.Vector2(0, 0);
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: window.innerWidth, clientY: 0 }));
    });
    for (let frame = 0; frame < 60; frame += 1) followPointerPlainly(uMouse, pointer, a.target());
    expect(Math.abs(a.target().mouse.x)).toBeGreaterThan(0.5);
    expect(b.target().mouse.x).toBe(0);
    expect(b.target().mouse.y).toBe(0);
    expect(b.target().velocity.length()).toBe(0);
    a.unmount();
    b.unmount();
  });
});
