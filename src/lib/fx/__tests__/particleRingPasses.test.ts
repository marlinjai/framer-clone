// The particle ring's glow passes in the layer (src/lib/fx/layers/particleRing.tsx): both are always built, and
// each frame shows the ones a glow asks for with their strengths in one step, so no frame mixes the passes of
// one value with the strengths of another.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { applyGlowPasses } from '../layers/particleRing';
import { ringGlowWeights } from '../particleRingCore';

const pass = () => new THREE.Points(new THREE.BufferGeometry(), new THREE.RawShaderMaterial({ uniforms: { gain: { value: 1 } } }));
const state = (passes: THREE.Points[]) => passes.map((p) => [p.visible, (p.material as THREE.RawShaderMaterial).uniforms.gain.value]);

describe('the glow passes of a frame', () => {
  it('follow the glow, passes and strengths together, whatever came before', () => {
    const passes = [pass(), pass()];
    applyGlowPasses(passes, ringGlowWeights(0.5));
    expect(state(passes)).toEqual([[true, 0.5], [false, 0]]);
    // A jump (an undo, say) to 2: both passes at full strength in the same frame.
    applyGlowPasses(passes, ringGlowWeights(2));
    expect(state(passes)).toEqual([[true, 1], [true, 1]]);
    applyGlowPasses(passes, ringGlowWeights(1.3));
    expect(state(passes)[0]).toEqual([true, 1]);
    expect(state(passes)[1][0]).toBe(true);
    expect(state(passes)[1][1]).toBeCloseTo(0.3, 12);
    applyGlowPasses(passes, ringGlowWeights(0));
    expect(state(passes)).toEqual([[false, 0], [false, 0]]);
    applyGlowPasses(passes, ringGlowWeights(1));
    expect(state(passes)).toEqual([[true, 1], [false, 0]]);
  });
});
