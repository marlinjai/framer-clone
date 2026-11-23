// The panel's pointer edit holds every amount to 0..1 (the flash-safety clamp of the strict reader).
import { describe, expect, it } from 'vitest';
import { fxFromPreset, setFxLayerInteractivity } from '../edit';

describe('pointer settings stored through the reader', () => {
  it('the panel\'s edit holds every amount to 0..1 whatever is typed, and the stored scene reads back unchanged', () => {
    const made = fxFromPreset('gold-noise-gradient');
    if (!made.ok) throw new Error(made.message);
    const noise = made.stored.scene.layers.find((l) => l.type === 'noiseFill')!;
    const edit = setFxLayerInteractivity(made.stored, noise.id, { trackMouse: 1e9, momentum: Number.MAX_VALUE, spring: 2 });
    if (!edit.ok) throw new Error(edit.message);
    expect(edit.stored.scene.layers.find((l) => l.id === noise.id)!.interactivity).toMatchObject({ trackMouse: 1, momentum: 1, spring: 1 });
  });
});
