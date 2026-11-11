// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { MAX_TEXTURE_EDGE, textureSize } from '../textureSize';

describe('textureSize', () => {
  it('leaves a picture that fits as it is, the limit included', () => {
    expect(textureSize(1200, 630)).toEqual({ width: 1200, height: 630, scaled: false });
    expect(textureSize(MAX_TEXTURE_EDGE, MAX_TEXTURE_EDGE)).toEqual({ width: MAX_TEXTURE_EDGE, height: MAX_TEXTURE_EDGE, scaled: false });
  });

  it('scales the largest upload a site accepts down to the limit, keeping its shape', () => {
    expect(textureSize(8000, 8000)).toEqual({ width: 2560, height: 2560, scaled: true });
    expect(textureSize(8000, 4000)).toEqual({ width: 2560, height: 1280, scaled: true });
    expect(textureSize(1000, 8000)).toEqual({ width: 320, height: 2560, scaled: true });
    expect(textureSize(MAX_TEXTURE_EDGE + 1, 10)).toMatchObject({ width: MAX_TEXTURE_EDGE, scaled: true });
  });

  it('never gives a side of zero', () => {
    expect(textureSize(8000, 1)).toEqual({ width: 2560, height: 1, scaled: true });
  });

  it('answers a size that is not one with a single pixel', () => {
    for (const [w, h] of [[0, 0], [-5, 10], [Number.NaN, 10], [10, Number.POSITIVE_INFINITY]]) {
      expect(textureSize(w, h)).toEqual({ width: 1, height: 1, scaled: false });
    }
  });
});
