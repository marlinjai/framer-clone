// @vitest-environment node
// The blend each content layer's material gets (../layers/contentBlend). Multiply used to be three.js's
// `MultiplyBlending`, which 0.184 refuses on a material that is not premultiplied (an error in the console)
// and then draws with whatever blend function was set before it, so a multiply layer drew as normal.
// Now it is custom blending from premultiplied colour. These tests read the material's blend state and
// work out what the GPU would do with it, so they fail on the old mapping.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  AdditiveBlending,
  CustomBlending,
  DstColorFactor,
  NormalBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  ZeroFactor,
  type Material,
  MeshBasicMaterial,
} from 'three';

import { applyContentBlend, isMultiplyBlend, premultiplyUniformOf, withPremultiplyUniform } from '../layers/contentBlend';
import type { BlendMode } from '../types';

/** A content layer's material: transparent, with the `uPremultiply` uniform every layer's shader has. */
const layerMaterial = () => new ShaderMaterial({ transparent: true, uniforms: { uPremultiply: { value: 0 } } });

type Rgb = [number, number, number];

/**
 * What a layer's shader writes for `colour` at `alpha` (plain, or multiplied by its alpha when uPremultiply is 1,
 * as the shaders do: `gl_FragColor.rgb *= mix(1.0, alpha, uPremultiply)`), and what the blend state does with it
 * over `dst`. Only the factors the layers use are known; anything else (and three.js's built-in multiply, which
 * is not custom blending) is an error here, so a mapping that leaves the built-in one fails.
 */
function draw(material: ShaderMaterial, colour: Rgb, alpha: number, dst: Rgb): Rgb {
  if (material.blending !== CustomBlending) throw new Error(`blending ${material.blending} is not custom blending`);
  const u = material.uniforms.uPremultiply.value as number;
  const src = colour.map((c) => c * (1 + (alpha - 1) * u)) as Rgb;
  const factor = (f: number, channel: number): number => {
    switch (f) {
      case ZeroFactor: return 0;
      case OneFactor: return 1;
      case DstColorFactor: return dst[channel];
      case OneMinusSrcAlphaFactor: return 1 - alpha;
      default: throw new Error(`factor ${f} is not one the layers use`);
    }
  };
  return src.map((s, i) => s * factor(material.blendSrc, i) + dst[i] * factor(material.blendDst, i)) as Rgb;
}

const close = (a: Rgb, b: Rgb) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 10));

describe('multiply', () => {
  const dst: Rgb = [1, 0.5, 0.25];
  const colour: Rgb = [0.5, 0.8, 1];

  it('is custom blending, not three.js MultiplyBlending (which refuses a material that is not premultiplied)', () => {
    const m = layerMaterial();
    applyContentBlend(m, 'multiply');
    expect(m.blending).toBe(CustomBlending);
    expect(m.blendSrc).toBe(DstColorFactor);
    expect(m.blendDst).toBe(OneMinusSrcAlphaFactor);
    expect(m.uniforms.uPremultiply.value).toBe(1);
  });

  it('is told apart from screen and overlay (the quad of a scoped layer needs to know)', () => {
    const m = layerMaterial();
    for (const [mode, expected] of [['multiply', true], ['screen', false], ['overlay', false], ['add', false], ['normal', false]] as Array<[BlendMode, boolean]>) {
      applyContentBlend(m, mode);
      expect(isMultiplyBlend(m), mode).toBe(expected);
    }
  });

  it('gives destination x source where the layer is fully drawn', () => {
    const m = layerMaterial();
    applyContentBlend(m, 'multiply');
    close(draw(m, colour, 1, dst), [dst[0] * colour[0], dst[1] * colour[1], dst[2] * colour[2]]);
  });

  it('leaves the destination alone where the layer is not drawn at all, whatever colour the layer has there', () => {
    const m = layerMaterial();
    applyContentBlend(m, 'multiply');
    for (const c of [[0, 0, 0], [0.5, 0.8, 1], [1, 1, 1]] as Rgb[]) close(draw(m, c, 0, dst), dst);
  });

  it('mixes the colour toward white by its alpha, times the destination, where it is partly drawn', () => {
    const m = layerMaterial();
    applyContentBlend(m, 'multiply');
    for (const a of [0.25, 0.5, 0.9]) {
      const mixed = colour.map((c) => 1 - a + a * c) as Rgb;
      close(draw(m, colour, a, dst), [dst[0] * mixed[0], dst[1] * mixed[1], dst[2] * mixed[2]]);
    }
  });

  it('keeps the destination alpha', () => {
    const m = layerMaterial();
    applyContentBlend(m, 'multiply');
    expect([m.blendSrcAlpha, m.blendDstAlpha]).toEqual([ZeroFactor, OneFactor]);
  });
});

describe('the blend actually set follows the mode, in any order', () => {
  const state = (m: Material) => [m.blending, m.blendSrc, m.blendDst];

  it('normal, multiply, add, multiply, screen, normal: each leaves exactly that mode on the material', () => {
    const m = layerMaterial();
    const seen: Array<[BlendMode, number, number]> = [];
    for (const mode of ['normal', 'multiply', 'add', 'multiply', 'screen', 'normal'] as BlendMode[]) {
      applyContentBlend(m, mode);
      seen.push([mode, m.blending, m.uniforms.uPremultiply.value as number]);
    }
    expect(seen).toEqual([
      ['normal', NormalBlending, 0],
      ['multiply', CustomBlending, 1],
      ['add', AdditiveBlending, 0],
      ['multiply', CustomBlending, 1],
      ['screen', CustomBlending, 0],
      ['normal', NormalBlending, 0],
    ]);
    // The second multiply is the same as the first, not whatever was set between.
    const a = layerMaterial();
    applyContentBlend(a, 'multiply');
    const b = layerMaterial();
    applyContentBlend(b, 'normal');
    applyContentBlend(b, 'add');
    applyContentBlend(b, 'multiply');
    expect(state(b)).toEqual(state(a));
  });

  it('draws normally, and says so, on a material without the uniform (multiply would brighten the pixels the layer does not cover)', () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const m = new ShaderMaterial({ transparent: true });
      applyContentBlend(m, 'multiply');
      expect(m.blending).toBe(NormalBlending);
      expect(errors).toHaveLength(1);
      // Other modes do not need the uniform.
      applyContentBlend(m, 'add');
      expect(m.blending).toBe(AdditiveBlending);
      expect(errors).toHaveLength(1);
    } finally {
      console.error = original;
    }
  });
});

describe('every layer that applies a blend draws multiply from premultiplied colour', () => {
  // Their shaders are strings inside React components, so the guard reads the sources: a layer that loses the
  // uniform or the premultiply line would multiply plain colour and brighten what it does not cover.
  const dir = path.resolve(__dirname, '../layers');
  it.each(['noiseFill', 'gradient', 'shape', 'image'])('%s', (name) => {
    const source = fs.readFileSync(path.join(dir, `${name}.tsx`), 'utf8');
    expect(source, 'declares the uniform').toMatch(/uniform float uPremultiply;/);
    expect(source, 'starts it at 0').toMatch(/uPremultiply: \{ value: 0 \}/);
    const colourSpace = source.indexOf('#include <colorspace_fragment>');
    const premultiply = source.indexOf('gl_FragColor.rgb *= mix(1.0, clamp(gl_FragColor.a, 0.0, 1.0), uPremultiply);');
    const clampAlpha = source.indexOf('gl_FragColor.a = mix(gl_FragColor.a, clamp(gl_FragColor.a, 0.0, 1.0), uPremultiply);');
    expect(colourSpace, 'converts to the output colour space').toBeGreaterThan(-1);
    expect(premultiply, 'premultiplies after the conversion, as the quad does').toBeGreaterThan(colourSpace);
    expect(clampAlpha, 'clamps the alpha factor for multiply only, after the premultiply').toBeGreaterThan(premultiply);
  });
});

describe('the composite quad of a scoped multiply layer', () => {
  // The group's buffer is half float, so alpha above 1 survives into the quad: it must clamp rgb and alpha the way the
  // layers do (the browser rows cannot see it, the noise's alpha peaks at 1.008). The quad shader is a string in the component.
  const source = fs.readFileSync(path.resolve(__dirname, '../effects/ScopedGroup.tsx'), 'utf8');
  const quad = source.slice(source.indexOf('const QUAD_FRAG'), source.indexOf('`;', source.indexOf('const QUAD_FRAG') + 20));

  it('premultiplies after the colour space conversion, with the alpha clamped', () => {
    const colourSpace = quad.indexOf('#include <colorspace_fragment>');
    const premultiply = quad.indexOf('gl_FragColor.rgb *= clamp(gl_FragColor.a, 0.0, 1.0);');
    const clampAlpha = quad.indexOf('gl_FragColor.a = clamp(gl_FragColor.a, 0.0, 1.0);');
    expect(colourSpace, 'conversion').toBeGreaterThan(-1);
    expect(premultiply, 'premultiply after the conversion').toBeGreaterThan(colourSpace);
    expect(clampAlpha, 'alpha clamp after the premultiply').toBeGreaterThan(premultiply);
  });

  it('does it for multiply only (mode 2), so the other modes draw exactly what they did', () => {
    const multiplyBranch = quad.slice(quad.indexOf('if (uMode > 1.5)'));
    expect(multiplyBranch).toContain('gl_FragColor.rgb *= clamp(');
    expect(quad.indexOf('clamp(gl_FragColor.a'), 'no clamp before the multiply branch').toBeGreaterThan(quad.indexOf('if (uMode > 1.5)'));
  });
});

describe('the text layers (basic materials) take their blend like the shader layers', () => {
  it('a basic material with the premultiply uniform multiplies like a shader layer, without an error', () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const m = new MeshBasicMaterial({ transparent: true });
      expect(premultiplyUniformOf(m), 'none before').toBeUndefined();
      withPremultiplyUniform(m);
      applyContentBlend(m, 'multiply');
      expect(m.blending).toBe(CustomBlending);
      expect(isMultiplyBlend(m)).toBe(true);
      expect(premultiplyUniformOf(m)?.value).toBe(1);
      applyContentBlend(m, 'add');
      expect(m.blending).toBe(AdditiveBlending);
      expect(premultiplyUniformOf(m)?.value).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      console.error = original;
    }
  });

  it('swaps three.js premultiply step of the basic shader for the uniform, keeping the uniform shared with the material', () => {
    const m = new MeshBasicMaterial({ transparent: true });
    withPremultiplyUniform(m);
    withPremultiplyUniform(m); // once
    const shader = { uniforms: {} as Record<string, unknown>, fragmentShader: 'void main() {\n#include <colorspace_fragment>\n#include <premultiplied_alpha_fragment>\n}' };
    (m.onBeforeCompile as unknown as (s: typeof shader) => void)(shader);
    expect(shader.uniforms.uPremultiply).toBe(premultiplyUniformOf(m));
    expect(shader.fragmentShader).toContain('uniform float uPremultiply;');
    expect(shader.fragmentShader).not.toContain('#include <premultiplied_alpha_fragment>');
    expect(shader.fragmentShader.indexOf('uPremultiply);')).toBeGreaterThan(shader.fragmentShader.indexOf('#include <colorspace_fragment>'));
    expect(m.customProgramCacheKey()).toBe('fx-premultiply-uniform');
  });
});

describe('a content layer cannot forget its blend', () => {
  // Every file in layers/ is a content layer. The blend is applied from the material's ref callback, and
  // multiply needs the premultiply uniform: declared in the shader (the shader layers) or given to the basic
  // material (the text layers). A new layer that does neither draws its stored blend as normal, silently.
  const dir = path.resolve(__dirname, '../layers');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.tsx'));

  it('finds the layers', () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it.each(files)('%s applies the blend and supports multiply', (file) => {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    expect(source, 'applies the blend').toMatch(/applyContentBlend\(/);
    const shaderLayer = /uniform float uPremultiply;/.test(source);
    const basicLayer = /withPremultiplyUniform\(/.test(source);
    expect(shaderLayer || basicLayer, 'the premultiply uniform').toBe(true);
    expect(shaderLayer && basicLayer, 'one of the two').toBe(false);
  });
});
