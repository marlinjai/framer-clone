// @vitest-environment node
// The blend a group's composite quad draws with (../effects/compositeBlend): the one the
// target layer's own material has, copied in the frame that draws the quad. Regression for the
// race of the single demand frame under reduced motion: the quad's blend used to be set from the
// layer's stored `blend` in a passive effect, after that frame, and a text layer (which draws
// normally whatever `blend` says) was then composited with `add` or `screen` in 9 and 10 of 20 runs
// on a software renderer (Linux, one container), glyph interiors saturated.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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
    const layer = new ShaderMaterial({ transparent: true, uniforms: { uPremultiply: { value: 0 } } }); // every content layer's material is transparent and has uPremultiply
    applyContentBlend(layer, blend);
    const to = quad();
    expect(copyBlendState(layer, to)).toBe(mode);
    expect(blendOf(to)).toEqual(blendOf(layer));
  });

  it('keeps the blend state exact for every kind of blending the layers use', () => {
    const kinds = [NormalBlending, AdditiveBlending, MultiplyBlending, CustomBlending];
    for (const blending of kinds) {
      const layer = new ShaderMaterial({ transparent: true, uniforms: { uPremultiply: { value: 0 } } }); // every content layer's material is transparent and has uPremultiply
      layer.blending = blending;
      const to = quad();
      copyBlendState(layer, to);
      expect(to.blending).toBe(blending);
    }
  });

  it('draws a layer that keeps normal blending normally, however the scene is stored', () => {
    // A material that never got applyContentBlend keeps normal blending, whatever the scene stored for it.
    const lockup = new MeshBasicMaterial({ transparent: true });
    const to = quad();
    to.blending = AdditiveBlending; // what a quad set up from the stored `add` would have
    expect(copyBlendState(lockup, to)).toBe(COMPOSITE_MODE.alpha);
    expect(to.blending).toBe(NormalBlending);
  });

  it('copies the premultiplied flag and the blend constants', () => {
    const layer = new ShaderMaterial({ transparent: true });
    layer.premultipliedAlpha = true;
    layer.blendAlpha = 0.5;
    layer.blendColor.set('#336699');
    const to = quad();
    copyBlendState(layer, to);
    expect(to.premultipliedAlpha).toBe(true);
    expect(to.blendAlpha).toBe(0.5);
    expect(to.blendColor.getHex()).toBe(layer.blendColor.getHex());
  });

  it('keeps the blend function of a layer that names one, whatever its transparency (three.js only drops NormalBlending)', () => {
    const layer = new ShaderMaterial({ transparent: false });
    layer.blending = AdditiveBlending;
    const to = quad();
    expect(copyBlendState(layer, to)).toBe(COMPOSITE_MODE.alpha);
    expect(to.blending).toBe(AdditiveBlending);
  });

  describe('every content layer draws a transparent material (the assumption copyBlendState documents)', () => {
    const dir = path.resolve(__dirname, '../layers');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.tsx'));

    /** What is wrong with a layer source's `transparent`, after comments are removed; empty when it is fine. */
    const problems = (source: string): string[] => {
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      const out: string[] = [];
      if (!/^\s*transparent\s*$/m.test(code)) out.push('no bare transparent prop');
      if (/\btransparent\b\s*[:=]\s*\{?\s*false/.test(code)) out.push('transparent is set to false');
      return out;
    };

    it('holds for all six layer sources', () => {
      expect(files.length).toBeGreaterThanOrEqual(6);
      for (const file of files) expect(problems(fs.readFileSync(path.join(dir, file), 'utf8')), file).toEqual([]);
    });

    it.each([
      ['the prop is removed and the word stays in a block comment', (t: string) => t.replace(/^\s*transparent\s*$/m, '/* transparent */')],
      ['the prop is removed and the word stays in a line comment', (t: string) => t.replace(/^\s*transparent\s*$/m, '// transparent')],
      ['the prop is removed and the word stays in a JSX comment', (t: string) => t.replace(/^\s*transparent\s*$/m, '{/* transparent */}')],
      ['the prop is false', (t: string) => t.replace(/^\s*transparent\s*$/m, 'transparent={false}')],
      ['the bare prop stays and the material is set to false', (t: string) => `${t}\nmat.transparent = false;`],
      ['the bare prop stays and an options object says false', (t: string) => `${t}\nconst o = { transparent: false };`],
    ])('fails a layer when %s', (_name, mutate) => {
      const text = fs.readFileSync(path.join(dir, 'text.tsx'), 'utf8'); // a throwaway copy of the source, in memory
      expect(problems(text)).toEqual([]);
      expect(problems(mutate(text)).length).toBeGreaterThan(0);
    });
  });

  it('follows the layer when its blend changes between two frames', () => {
    const layer = new ShaderMaterial({ transparent: true, uniforms: { uPremultiply: { value: 0 } } }); // every content layer's material is transparent and has uPremultiply
    const to = quad();
    applyContentBlend(layer, 'add');
    copyBlendState(layer, to);
    expect(to.blending).toBe(AdditiveBlending);
    applyContentBlend(layer, 'normal');
    expect(copyBlendState(layer, to)).toBe(COMPOSITE_MODE.alpha);
    expect(to.blending).toBe(NormalBlending);
  });
});
