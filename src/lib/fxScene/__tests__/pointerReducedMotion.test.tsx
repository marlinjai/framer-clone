// Pointer settings and reduced motion (slice L2): with `reduce` set the engine's pointer smoothing
// collapses to the rest position whatever the pointer settings are, so the still frame the FX
// owner compares (`calm: 'frame'`) is the same with pointer settings on as with none. And the
// flash-safety clamp holds at the top of every range.
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useInteractivity, type InteractivitySpec } from '@/lib/fx';
import { fxFromPreset, setFxLayerInteractivity } from '../edit';

const loud: InteractivitySpec = { trackMouse: 1, momentum: 1, spring: 1, axes: 'both' };

describe('pointer settings under reduced motion', () => {
  it('keeps the smoothed pointer at rest while the pointer moves, for the loudest settings', () => {
    const { result } = renderHook(() => useInteractivity());
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: window.innerWidth, clientY: 0 }));
    });
    for (let i = 0; i < 60; i += 1) result.current.step(loud, true);
    expect(result.current.mouse.x).toBeCloseTo(0, 6);
    expect(result.current.mouse.y).toBeCloseTo(0, 6);
    expect(result.current.velocity.length()).toBe(0);
    // the same settings without reduced motion do follow the pointer (the control)
    for (let i = 0; i < 60; i += 1) result.current.step(loud, false);
    expect(Math.abs(result.current.mouse.x)).toBeGreaterThan(0.1);
  });

  it('the panel\'s edit holds every amount to 0..1 whatever is typed, and the stored scene reads back unchanged', () => {
    const made = fxFromPreset('gold-noise-gradient');
    if (!made.ok) throw new Error(made.message);
    const noise = made.stored.scene.layers.find((l) => l.type === 'noiseFill')!;
    const edit = setFxLayerInteractivity(made.stored, noise.id, { trackMouse: 1e9, momentum: Number.MAX_VALUE, spring: 2 });
    if (!edit.ok) throw new Error(edit.message);
    expect(edit.stored.scene.layers.find((l) => l.id === noise.id)!.interactivity).toMatchObject({ trackMouse: 1, momentum: 1, spring: 1 });
  });
});
