/**
 * The size an image is drawn at as a texture.
 *
 * A layer fills its box, and a box is at most a screen, so a picture larger
 * than a screen at the engine's highest pixel ratio adds memory and upload
 * time and no visible detail: an 8000 by 8000 pixel picture decodes to 256 MB.
 * Images above `MAX_TEXTURE_EDGE` on their longer side are scaled down, keeping
 * their shape, before they reach the GPU.
 *
 * RENDER-FREE: no React, no three.js.
 */

/** 2560 pixels covers a 1440 pixel wide box at the engine's top pixel ratio of 1.75. */
export const MAX_TEXTURE_EDGE = 2560;

/** The size to draw `width` by `height` at: unchanged when it fits, else scaled to fit `max` on the longer side. */
export function textureSize(width: number, height: number, max: number = MAX_TEXTURE_EDGE): { width: number; height: number; scaled: boolean } {
  const valid = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
  if (!valid) return { width: 1, height: 1, scaled: false };
  const longer = Math.max(width, height);
  if (longer <= max) return { width, height, scaled: false };
  const factor = max / longer;
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
    scaled: true,
  };
}
