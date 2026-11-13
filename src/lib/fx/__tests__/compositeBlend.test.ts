// @vitest-environment node
// The blend a group's composite quad draws with (../effects/compositeBlend): the one the
// target layer's own material has, copied in the frame that draws the quad. Regression for the
// race of the single demand frame under reduced motion: the quad's blend used to be set from the
// layer's stored `blend` in a passive effect, after that frame, and a text layer (which draws
// normally whatever `blend` says) was then composited with `add` or `screen` about one run in five
// on a software renderer, glyph interiors saturated.

import { describe, expect, it } from 'vitest';
import { AdditiveBlending, CustomBlending, MeshBasicMaterial, MultiplyBlending, NormalBlending, ShaderMaterial } from 'three';

import { COMPOSITE_MODE, copyBlendState } from '../effects/compositeBlend';
import { applyContentBlend } from '../layers/contentBlend';
import type { BlendMode } from '../types';

const quad = () => new ShaderMaterial({ transparent: true });
const blendOf = (m: ShaderMaterial | MeshBasicMaterial) => [m.blending, m.blendEquation, m.blendSrc, m.blendDst, m.blendEquationAlpha, m.blendSrcAlpha, m.blendDstAlpha];

describe('the composite quad blend', () => {
  it.each<[BlendMode, number]>([
    ['normal', COMPOSITE_MODE.alpha],
    ['add', COMPOSITE_MODE.alpha],
    ['screen', COMPOSITE_MODE.ignoresAlpha],
    ['overlay', COMPOSITE_MODE.ignoresAlpha],
    ['multiply', COMPOSITE_MODE.multiply],
  ])('draws a layer that applies %s with exactly that blend state', (blend, mode) => {
    const layer = new ShaderMaterial();
    applyContentBlend(layer, blend);
    const to = quad();
    expect(copyBlendState(layer, to)).toBe(mode);
    expect(blendOf(to)).toEqual(blendOf(layer));
  });

  it('keeps the blend state exact for every kind of blending the layers use', () => {
    const kinds = [NormalBlending, AdditiveBlending, MultiplyBlending, CustomBlending];
    for (const blending of kinds) {
      const layer = new ShaderMaterial();
      layer.blending = blending;
      const to = quad();
      copyBlendState(layer, to);
      expect(to.blending).toBe(blending);
    }
  });

  it('draws a layer that ignores its stored blend (the text lockup) normally, however the scene is stored', () => {
    // The text lockup's material never gets applyContentBlend: its stored blend is not what it draws with.
    const lockup = new MeshBasicMaterial({ transparent: true });
    const to = quad();
    to.blending = AdditiveBlending; // what a quad set up from the stored `add` would have
    expect(copyBlendState(lockup, to)).toBe(COMPOSITE_MODE.alpha);
    expect(to.blending).toBe(NormalBlending);
  });

  it('follows the layer when its blend changes between two frames', () => {
    const layer = new ShaderMaterial();
    const to = quad();
    applyContentBlend(layer, 'add');
    copyBlendState(layer, to);
    expect(to.blending).toBe(AdditiveBlending);
    applyContentBlend(layer, 'normal');
    expect(copyBlendState(layer, to)).toBe(COMPOSITE_MODE.alpha);
    expect(to.blending).toBe(NormalBlending);
  });
});
