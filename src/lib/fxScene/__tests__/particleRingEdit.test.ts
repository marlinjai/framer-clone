// The particle ring always adds (its schema fixes the blend, src/lib/fx/schemas.ts): the editor's edits must
// keep that, and must give a layer its usual blend back when it stops being a ring.

import { describe, expect, it } from 'vitest';

import { fxFromPreset, setFxLayerBlend, setFxLayerType } from '../edit';

describe('the one blend of the particle ring in the editor', () => {
  it('cannot be changed in the editor, and is taken or given back when a layer changes kind', () => {
    const made = fxFromPreset('lumitra-light');
    if (!made.ok) throw new Error(made.message);
    const ringId = made.fx.scene.layers[0].id;

    const refused = setFxLayerBlend(made.stored, ringId, 'screen');
    expect(refused.ok).toBe(false);
    expect(setFxLayerBlend(made.stored, ringId, 'add').ok).toBe(true);

    // Ring to noise field: back to "normal", not the ring's "add".
    const noise = setFxLayerType(made.stored, ringId, 'noiseFill');
    if (!noise.ok) throw new Error(noise.message);
    expect(noise.fx.scene.layers[0]).toMatchObject({ type: 'noiseFill', blend: 'normal' });

    // A noise field set to screen, made a ring: "add".
    const screened = setFxLayerBlend(noise.stored, noise.layerId!, 'screen');
    if (!screened.ok) throw new Error(screened.message);
    const ring = setFxLayerType(screened.stored, noise.layerId!, 'particleRing');
    if (!ring.ok) throw new Error(ring.message);
    expect(ring.fx.scene.layers[0]).toMatchObject({ type: 'particleRing', blend: 'add' });

    // Any other kind keeps its blend through a change of kind, as before.
    const gradient = setFxLayerType(screened.stored, noise.layerId!, 'gradient');
    if (!gradient.ok) throw new Error(gradient.message);
    expect(gradient.fx.scene.layers[0].blend).toBe('screen');
  });
});
