// Pointer settings and reduced motion (slice L2): with `reduce` set the engine's pointer smoothing
// collapses to the rest position whatever the pointer settings are, so the still frame the FX
// owner compares (`calm: 'frame'`) is the same with pointer settings on as with none.
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { useInteractivity, type InteractivityTarget } from '../interactivity';
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
