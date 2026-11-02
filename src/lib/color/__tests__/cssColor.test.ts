// The shared strict colour parser: its structure, its numbers for a contrast check, and
// the grammar edges the T1 code review found. Which values a browser accepts is proven in
// Chromium and WebKit by test/renderGate/theme.gate.ts.

import { describe, expect, it } from 'vitest';
import { isCssColor, parseColor, parseCssColor, trimAsciiSpace } from '../cssColor';

describe('parseCssColor', () => {
  it('reads the modern form, with an optional alpha and none', () => {
    expect(parseCssColor('oklch(0.5 none 120deg / 50%)')).toEqual({
      form: 'function',
      fn: 'oklch',
      components: [{ kind: 'number', value: 0.5 }, { kind: 'none' }, { kind: 'angle', value: 120, unit: 'deg' }],
      alpha: { kind: 'percent', value: 50 },
      legacy: false,
    });
    expect(parseCssColor('color(Display-P3 1 0.5 0)')).toMatchObject({ fn: 'color', space: 'display-p3' });
  });

  it('reads the comma form for rgb and hsl only', () => {
    expect(parseCssColor('rgba(255, 0, 0, 0.5)')).toMatchObject({ fn: 'rgba', legacy: true, alpha: { kind: 'number', value: 0.5 } });
    expect(parseCssColor('hsl(120, 50%, 50%)')).toMatchObject({ legacy: true });
    for (const value of ['lab(1, 2, 3)', 'hwb(1, 2%, 3%)', 'oklch(1, 2, 3)', 'color(srgb, 1, 0, 0)']) expect(parseCssColor(value)).toBeNull();
  });

  it('holds each slot to its units', () => {
    expect(isCssColor('hsl(10deg 10% 10%)')).toBe(true);
    expect(isCssColor('hsl(10% 10% 10%)')).toBe(false);
    expect(isCssColor('rgb(0deg 0 0)')).toBe(false);
    expect(isCssColor('lch(50% 30 1turn)')).toBe(true);
    expect(isCssColor('lch(1turn 30 50)')).toBe(false);
    expect(isCssColor('rgb(1, 2%, 3)')).toBe(false);
    expect(isCssColor('hsl(10, 20, 30)')).toBe(false);
  });

  it('takes the CSS number token only', () => {
    for (const ok of ['rgb(.5 1e2 -1)', 'rgb(+1 1E-2 0)']) expect(isCssColor(ok)).toBe(true);
    for (const bad of ['rgb(0. 0 0)', 'rgb(1.e3 0 0)', 'rgb(1e 0 0)', 'rgb(0 0 0 / 0.)']) expect(isCssColor(bad)).toBe(false);
  });

  it('trims ASCII white space only, and takes only ASCII spaces inside', () => {
    expect(trimAsciiSpace('\t red \n')).toBe('red');
    expect(trimAsciiSpace(' red')).toBe(' red');
    expect(isCssColor(' red ')).toBe(true);
    for (const bad of [' red', 'rgb(0 0 0)', 'rgb(0\t0 0)', 'rgb(0　0 0)']) expect(isCssColor(bad)).toBe(false);
  });

  it('refuses anything that is not a string, and every name outside the table', () => {
    for (const bad of [null, 3, {}, 'reddish', 'currentcolor', 'inherit', '__proto__', 'constructor']) expect(parseCssColor(bad)).toBeNull();
  });
});

describe('parseColor, the banner guard shape', () => {
  it('reads names, hex, transparent, rgb, hsl and oklch as sRGB numbers', () => {
    expect(parseColor('RebeccaPurple')).toEqual({ r: 102, g: 51, b: 153, a: 1 });
    expect(parseColor('#0f08')).toEqual({ r: 0, g: 255, b: 0, a: 136 / 255 });
    expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseColor('rgb(100% 0% 0% / 50%)')).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });
    expect(parseColor('rgba(10, 20, 30, 2)')).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    const green = parseColor('hsl(120 100 25)')!;
    expect([Math.round(green.r), Math.round(green.g), Math.round(green.b)]).toEqual([0, 128, 0]);
    const white = parseColor('oklch(1 0 0)')!;
    expect([Math.round(white.r), Math.round(white.g), Math.round(white.b)]).toEqual([255, 255, 255]);
  });

  it('is undefined for a value a browser refuses, and for a function it cannot convert yet', () => {
    expect(parseColor('rgb(1, 2 3)')).toBeUndefined();
    expect(parseColor('lab(50% 20 30)')).toBeUndefined();
    expect(parseColor('var(--fc-t-ab12cd34)')).toBeUndefined();
  });
});
