// src/lib/color/cssColor.ts
//
// One strict CSS colour parser, shared by everything that has to agree with a browser
// about what a colour is: the theme's token grammar (src/lib/site/theme.ts) and, once
// #261 is on main, the consent banner's legibility guard, whose `parseColor` reads the
// same grammar from here (parseColor below is its drop-in shape).
//
// Strict means: a value is accepted only when Chromium and WebKit both read it as a
// colour (test/renderGate/theme.gate.ts asserts `CSS.supports('color', v)` for every
// accepted value of a fixed list and a generated sweep). A lenient parser would read
// `rgb(1, 2 3)` as a colour while the browser paints nothing, which is how a contrast
// check passes on a page nobody can read.
//
// The grammar, per function:
//   - Modern form: exactly three components separated by ASCII spaces, then an optional
//     `/ alpha`. `none` is allowed in any component and in the alpha.
//   - Comma form: only `rgb`, `rgba`, `hsl` and `hsla`, with exactly three or four
//     values, no `none`, and no spaces or slashes mixed in.
//   - Units: an angle only in a hue slot; a percentage only where the function takes one
//     (never in a hue); `rgb` in the comma form takes all numbers or all percentages,
//     `hsl` in the comma form takes percentages for saturation and lightness.
//   - Numbers: the CSS number token, so a dot needs a digit after it (`0.` is refused).
//   - White space: ASCII only. JavaScript's `\s` and `trim()` also take U+00A0, U+2028,
//     U+FEFF and U+3000, which CSS reads as part of a token, so neither is used here.
//   - `color()` takes `srgb`, `srgb-linear` or `display-p3` as its first word.
// Plus `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, the CSS Color 4 names and `transparent`.

import { NAMED_COLOR_HEX } from './namedColors';

export const COLOR_FUNCTIONS = ['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color'] as const;
export type ColorFunction = (typeof COLOR_FUNCTIONS)[number];

export const COLOR_SPACES = ['srgb', 'srgb-linear', 'display-p3'] as const;
export type ColorSpace = (typeof COLOR_SPACES)[number];

export type AngleUnit = 'deg' | 'grad' | 'rad' | 'turn';

/** One component as written: a number, a percentage, an angle, or `none`. */
export type ColorComponent =
  | { kind: 'number'; value: number }
  | { kind: 'percent'; value: number }
  | { kind: 'angle'; value: number; unit: AngleUnit }
  | { kind: 'none' };

export type CssColor =
  | { form: 'hex'; hex: string }
  | { form: 'named'; name: string; hex: string }
  | { form: 'transparent' }
  | {
      form: 'function';
      fn: ColorFunction;
      /** `color()` only. */
      space?: ColorSpace;
      /** Exactly three. */
      components: ColorComponent[];
      alpha?: ColorComponent;
      /** The comma form. */
      legacy: boolean;
    };

const NAMED: Readonly<Record<string, string>> = Object.assign(Object.create(null), NAMED_COLOR_HEX);

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** `name(body)` with no bracket inside the body. */
const CALL = /^([a-z][a-z0-9-]*)\(([^()]*)\)$/i;
/** The CSS number token: digits with an optional fraction that has a digit, or a leading-dot fraction, and an exponent. */
const NUMBER_SOURCE = '[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const NUMBER = new RegExp(`^${NUMBER_SOURCE}$`);
const PERCENT = new RegExp(`^${NUMBER_SOURCE}%$`);
const ANGLE = new RegExp(`^(${NUMBER_SOURCE})(deg|grad|rad|turn)$`, 'i');
/** ASCII white space as CSS defines it. */
const ASCII_SPACE = /^[ \t\n\r\f]+|[ \t\n\r\f]+$/g;
/** Inside a call: one or more U+0020 only. */
const SPACES = / +/;

/** What a slot may hold. `none` is decided per form, not per slot. */
type Slot = 'number' | 'percent' | 'number-percent' | 'hue';

/** The three slots of each function's modern form. */
const MODERN_SLOTS: Record<ColorFunction, readonly [Slot, Slot, Slot]> = {
  rgb: ['number-percent', 'number-percent', 'number-percent'],
  rgba: ['number-percent', 'number-percent', 'number-percent'],
  hsl: ['hue', 'number-percent', 'number-percent'],
  hsla: ['hue', 'number-percent', 'number-percent'],
  hwb: ['hue', 'number-percent', 'number-percent'],
  lab: ['number-percent', 'number-percent', 'number-percent'],
  lch: ['number-percent', 'number-percent', 'hue'],
  oklab: ['number-percent', 'number-percent', 'number-percent'],
  oklch: ['number-percent', 'number-percent', 'hue'],
  color: ['number-percent', 'number-percent', 'number-percent'],
};

function component(text: string, slot: Slot, allowNone: boolean): ColorComponent | null {
  if (text.toLowerCase() === 'none') return allowNone ? { kind: 'none' } : null;
  if (NUMBER.test(text)) return slot === 'percent' ? null : { kind: 'number', value: Number(text) };
  if (PERCENT.test(text)) return slot === 'hue' || slot === 'number' ? null : { kind: 'percent', value: Number(text.slice(0, -1)) };
  if (slot !== 'hue') return null;
  const angle = ANGLE.exec(text);
  return angle ? { kind: 'angle', value: Number(angle[1]), unit: angle[2].toLowerCase() as AngleUnit } : null;
}

/** The modern form: `a b c` or `a b c / alpha`, ASCII spaces only. */
function modern(fn: ColorFunction, body: string): CssColor | null {
  const slash = body.split('/');
  if (slash.length > 2) return null;
  const channels = slash[0].trim().split(SPACES);
  let space: ColorSpace | undefined;
  if (fn === 'color') {
    const first = channels.shift()?.toLowerCase();
    if (!first || !(COLOR_SPACES as readonly string[]).includes(first)) return null;
    space = first as ColorSpace;
  }
  if (channels.length !== 3 || channels.some((c) => c === '')) return null;
  const slots = MODERN_SLOTS[fn];
  const components: ColorComponent[] = [];
  for (let i = 0; i < 3; i += 1) {
    const read = component(channels[i], slots[i], true);
    if (!read) return null;
    components.push(read);
  }
  let alpha: ColorComponent | undefined;
  if (slash.length === 2) {
    const text = slash[1].trim();
    if (text === '' || SPACES.test(text)) return null;
    const read = component(text, 'number-percent', true);
    if (!read) return null;
    alpha = read;
  }
  return { form: 'function', fn, ...(space ? { space } : {}), components, ...(alpha ? { alpha } : {}), legacy: false };
}

/** The comma form, for rgb, rgba, hsl and hsla only: three or four values, nothing mixed in. */
function legacy(fn: ColorFunction, body: string): CssColor | null {
  if (fn !== 'rgb' && fn !== 'rgba' && fn !== 'hsl' && fn !== 'hsla') return null;
  const parts = body.split(',').map((p) => p.trim());
  if ((parts.length !== 3 && parts.length !== 4) || parts.some((p) => p === '' || / |\//.test(p))) return null;
  const isRgb = fn === 'rgb' || fn === 'rgba';
  const slots: Slot[] = isRgb ? ['number-percent', 'number-percent', 'number-percent'] : ['hue', 'percent', 'percent'];
  const components: ColorComponent[] = [];
  for (let i = 0; i < 3; i += 1) {
    const read = component(parts[i], slots[i], false);
    if (!read) return null;
    components.push(read);
  }
  // rgb in the comma form: all numbers or all percentages.
  if (isRgb && new Set(components.map((c) => c.kind)).size !== 1) return null;
  let alpha: ColorComponent | undefined;
  if (parts.length === 4) {
    const read = component(parts[3], 'number-percent', false);
    if (!read) return null;
    alpha = read;
  }
  return { form: 'function', fn, components, ...(alpha ? { alpha } : {}), legacy: true };
}

/** The value with surrounding ASCII white space removed, or the value unchanged when it has none. */
export function trimAsciiSpace(value: string): string {
  return value.replace(ASCII_SPACE, '');
}

/**
 * A colour as Chromium and WebKit both read it, or null. Accepts surrounding ASCII white
 * space; everything inside is held to the grammar above.
 */
export function parseCssColor(input: unknown): CssColor | null {
  if (typeof input !== 'string') return null;
  const text = trimAsciiSpace(input);
  if (text.length === 0) return null;
  if (HEX.test(text)) return { form: 'hex', hex: text.toLowerCase() };
  const lower = text.toLowerCase();
  if (lower === 'transparent') return { form: 'transparent' };
  if (/^[a-z]+$/.test(lower) && NAMED[lower]) return { form: 'named', name: lower, hex: NAMED[lower] };
  const call = CALL.exec(text);
  if (!call) return null;
  const fn = call[1].toLowerCase();
  if (!(COLOR_FUNCTIONS as readonly string[]).includes(fn)) return null;
  const body = call[2];
  // ASCII spaces, digits, letters, signs, dots, `%`, `/` and commas, and nothing else.
  if (!/^[0-9a-zA-Z.%+\-/, ]*$/.test(body)) return null;
  return body.includes(',') ? legacy(fn as ColorFunction, body) : modern(fn as ColorFunction, body);
}

/** True when Chromium and WebKit both read `input` as a colour. */
export function isCssColor(input: unknown): boolean {
  return parseCssColor(input) !== null;
}

// ---------------------------------------------------------------------------
// Numbers, for a contrast check
// ---------------------------------------------------------------------------

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));

function hexToRgba(hex: string): Rgba {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
  };
}

/** A component's value, `none` as zero, a percentage scaled to `full`. */
function value(c: ColorComponent, full: number): number {
  if (c.kind === 'none') return 0;
  if (c.kind === 'percent') return (c.value / 100) * full;
  if (c.kind === 'angle') return c.value * { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 }[c.unit];
  return c.value;
}

function alphaOf(c: ColorComponent | undefined): number {
  return c === undefined ? 1 : clamp(value(c, 1), 1);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sat = clamp(s, 1);
  const light = clamp(l, 1);
  const f = (n: number) => {
    const k = (n + ((h % 360) + 360) / 30) % 12;
    return (light - sat * Math.min(light, 1 - light) * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return [f(0), f(8), f(4)];
}

function oklchToRgb(L: number, C: number, h: number): [number, number, number] {
  const radians = (h * Math.PI) / 180;
  const A = C * Math.cos(radians);
  const B = C * Math.sin(radians);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const gamma = (linear: number) => {
    const v = clamp(linear, 1);
    return (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) * 255;
  };
  return [
    gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/**
 * A parsed colour as sRGB numbers, for a contrast check. Covers names, hex, `transparent`,
 * `rgb`, `hsl` and `oklch`, which is what the banner guard reads today. Any other function
 * returns undefined, which the guard treats as a colour it cannot judge (the neutral pair);
 * slice T2 of the theme contract teaches it `lab`, `lch`, `oklab`, `hwb` and `color()`.
 */
export function cssColorToRgba(color: CssColor): Rgba | undefined {
  if (color.form === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (color.form === 'hex' || color.form === 'named') return hexToRgba(color.hex);
  const [c1, c2, c3] = color.components;
  const a = alphaOf(color.alpha);
  switch (color.fn) {
    case 'rgb':
    case 'rgba':
      return { r: clamp(value(c1, 255), 255), g: clamp(value(c2, 255), 255), b: clamp(value(c3, 255), 255), a };
    case 'hsl':
    case 'hsla': {
      // In the modern form a bare number for saturation or lightness means percent.
      const pct = (c: ColorComponent) => (c.kind === 'number' ? c.value / 100 : value(c, 1));
      const [r, g, b] = hslToRgb(value(c1, 1), pct(c2), pct(c3));
      return { r, g, b, a };
    }
    case 'oklch': {
      const [r, g, b] = oklchToRgb(value(c1, 1), value(c2, 0.4), value(c3, 1));
      return { r, g, b, a };
    }
    default:
      return undefined;
  }
}

/** The banner guard's shape: a colour as sRGB numbers, or undefined for anything a browser refuses or this cannot convert. */
export function parseColor(input: string): Rgba | undefined {
  const parsed = parseCssColor(input);
  return parsed ? cssColorToRgba(parsed) : undefined;
}
