// src/lib/color/cssColor.ts
//
// One strict CSS colour parser, shared by everything that has to agree with a browser
// about what a colour is: the theme's token grammar (src/lib/site/theme.ts), the consent
// banner's and the default 404's legibility guard (src/lib/site/notFoundDefault.ts), and
// the visual review (src/lib/ai/review/layoutAudit.ts re-exports parseColor). So a colour
// a token may hold is always one the banner can judge.
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

/** Linear light to sRGB's transfer curve, in 0..255, clamped to the gamut. */
function encodeSrgb(linear: number): number {
  const v = clamp(linear, 1);
  return (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) * 255;
}

/** sRGB's (and Display P3's) transfer curve undone, keeping the sign. */
function decodeSrgb(encoded: number): number {
  const abs = Math.abs(encoded);
  const linear = abs <= 0.04045 ? abs / 12.92 : ((abs + 0.055) / 1.055) ** 2.4;
  return encoded < 0 ? -linear : linear;
}

type Triple = [number, number, number];

const fromLinearSrgb = ([r, g, b]: Triple): Triple => [encodeSrgb(r), encodeSrgb(g), encodeSrgb(b)];

/** CIE XYZ relative to D65 to linear sRGB. */
function xyzD65ToLinearSrgb([x, y, z]: Triple): Triple {
  return [
    3.2409699419045226 * x - 1.537383177570094 * y - 0.4986107602930034 * z,
    -0.9692436362808796 * x + 1.8759675015077202 * y + 0.04155505740717559 * z,
    0.05563007969699366 * x - 0.20397695888897652 * y + 1.0569715142428786 * z,
  ];
}

/** CIE XYZ relative to D50 to D65, by the Bradford transform CSS Color 4 uses. */
function d50ToD65([x, y, z]: Triple): Triple {
  return [
    0.955473421488075 * x - 0.02309845494876471 * y + 0.06325924320057072 * z,
    -0.0283697093338637 * x + 1.0099953980813041 * y + 0.021041441191917323 * z,
    0.012314014864481998 * x - 0.020507649298898964 * y + 1.330365926242124 * z,
  ];
}

/** CIE Lab (D50) to linear sRGB. */
function labToLinearSrgb(L: number, a: number, b: number): Triple {
  const kappa = 24389 / 27;
  const epsilon = 216 / 24389;
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const xr = fx ** 3 > epsilon ? fx ** 3 : (116 * fx - 16) / kappa;
  const yr = L > kappa * epsilon ? ((L + 16) / 116) ** 3 : L / kappa;
  const zr = fz ** 3 > epsilon ? fz ** 3 : (116 * fz - 16) / kappa;
  const white: Triple = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];
  return xyzD65ToLinearSrgb(d50ToD65([xr * white[0], yr * white[1], zr * white[2]]));
}

/** Oklab to linear sRGB. */
function oklabToLinearSrgb(L: number, A: number, B: number): Triple {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Display P3 (encoded) to linear sRGB. */
function displayP3ToLinearSrgb(r: number, g: number, b: number): Triple {
  const [lr, lg, lb] = [decodeSrgb(r), decodeSrgb(g), decodeSrgb(b)];
  return xyzD65ToLinearSrgb([
    0.4865709486482162 * lr + 0.26566769316909306 * lg + 0.1982172852343625 * lb,
    0.2289745640697488 * lr + 0.6917385218365064 * lg + 0.079286914093745 * lb,
    0 * lr + 0.04511338185890264 * lg + 1.043944368900976 * lb,
  ]);
}

/** Polar to rectangular, for lch and oklch. */
function polar(chroma: number, hue: number): [number, number] {
  const radians = (hue * Math.PI) / 180;
  return [chroma * Math.cos(radians), chroma * Math.sin(radians)];
}

/** A `none` hue beside a chroma above zero, which the engines paint apart (cssColorToRgba). */
const huelessChroma = (chroma: ColorComponent, hue: ColorComponent): boolean =>
  hue.kind === 'none' && chroma.kind !== 'none' && chroma.value > 0;

/** In the modern form a bare number for hsl's or hwb's second and third value means percent. */
const percentOf = (c: ColorComponent): number => (c.kind === 'number' ? c.value / 100 : value(c, 1));

/**
 * A parsed colour as sRGB numbers, for a contrast check: the whole grammar, by the
 * conversions CSS Color 4 defines, clamped to the sRGB gamut (a contrast check reads what
 * an sRGB screen shows). `none` reads as zero, as CSS says it does where it is not
 * carried forward. test/renderGate/theme.gate.ts holds every accepted value to what
 * Chromium and WebKit paint.
 *
 * Undefined where the engines paint a value differently, or in a way the specification
 * leaves open, so it cannot be judged here and a guard reading it fails closed: a Display
 * P3 colour with a channel outside 0 to 1 (`color(display-p3 0 0 100)` paints a light
 * blue, not the clipped blue), an hwb colour with a negative whiteness or blackness
 * (Chromium paints `hwb(1 -1% 0)` as green 2, WebKit as green 4), and an lch or oklch
 * colour with a `none` hue and some chroma (Chromium and WebKit on macOS read the hue as
 * zero, WebKit on Linux paints the chroma away, so `lch(50% 50% none)` is pink in one
 * and grey in the other).
 */
export function cssColorToRgba(color: CssColor): Rgba | undefined {
  if (color.form === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (color.form === 'hex' || color.form === 'named') return hexToRgba(color.hex);
  const [c1, c2, c3] = color.components;
  const a = alphaOf(color.alpha);
  const rgb = (triple: Triple): Rgba => ({ r: triple[0], g: triple[1], b: triple[2], a });
  switch (color.fn) {
    case 'rgb':
    case 'rgba':
      return { r: clamp(value(c1, 255), 255), g: clamp(value(c2, 255), 255), b: clamp(value(c3, 255), 255), a };
    case 'hsl':
    case 'hsla':
      return rgb(hslToRgb(value(c1, 1), percentOf(c2), percentOf(c3)));
    case 'hwb': {
      const white = percentOf(c2);
      const black = percentOf(c3);
      if (white < 0 || black < 0) return undefined;
      if (white + black >= 1) {
        const gray = clamp((white / (white + black)) * 255, 255);
        return { r: gray, g: gray, b: gray, a };
      }
      const scale = 1 - white - black;
      const [r, g, b] = hslToRgb(value(c1, 1), 1, 0.5);
      const channel = (v: number) => clamp(v * scale + white * 255, 255);
      return { r: channel(r), g: channel(g), b: channel(b), a };
    }
    case 'lab':
      return rgb(fromLinearSrgb(labToLinearSrgb(clamp(value(c1, 100), 100), value(c2, 125), value(c3, 125))));
    case 'lch': {
      if (huelessChroma(c2, c3)) return undefined;
      const [labA, labB] = polar(Math.max(0, value(c2, 150)), value(c3, 1));
      return rgb(fromLinearSrgb(labToLinearSrgb(clamp(value(c1, 100), 100), labA, labB)));
    }
    case 'oklab':
      return rgb(fromLinearSrgb(oklabToLinearSrgb(clamp(value(c1, 1), 1), value(c2, 0.4), value(c3, 0.4))));
    case 'oklch': {
      if (huelessChroma(c2, c3)) return undefined;
      const [labA, labB] = polar(Math.max(0, value(c2, 0.4)), value(c3, 1));
      return rgb(fromLinearSrgb(oklabToLinearSrgb(clamp(value(c1, 1), 1), labA, labB)));
    }
    case 'color': {
      const [r, g, b] = [value(c1, 1), value(c2, 1), value(c3, 1)];
      if (color.space === 'srgb-linear') return rgb(fromLinearSrgb([r, g, b]));
      if (color.space === 'display-p3') {
        if ([r, g, b].some((channel) => channel < 0 || channel > 1)) return undefined;
        return rgb(fromLinearSrgb(displayP3ToLinearSrgb(r, g, b)));
      }
      return { r: clamp(r, 1) * 255, g: clamp(g, 1) * 255, b: clamp(b, 1) * 255, a };
    }
  }
}

/**
 * A colour as sRGB numbers, or undefined for anything a browser refuses: the one parser
 * the consent banner's guard, the default 404 and the visual review all read
 * (src/lib/ai/review/layoutAudit.ts re-exports it). `var()`, `color-mix()`,
 * `currentColor` and `inherit` have no value here.
 */
export function parseColor(input: string): Rgba | undefined {
  const parsed = parseCssColor(input);
  return parsed ? cssColorToRgba(parsed) : undefined;
}
