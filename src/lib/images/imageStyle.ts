// src/lib/images/imageStyle.ts
//
// Pure helpers for photos in styles, shared by the AI page generator (server
// and client) and the properties panel's Image section. Client-safe.
//
// Two jobs:
//
//   1. A container's photo background is ONE `backgroundImage` value whose
//      layers are listed top first: zero or more overlay layers (gradients,
//      the scrim that keeps text readable) and then the photo itself as a
//      url() layer, e.g.
//        linear-gradient(rgba(0, 0, 0, 0.45), rgba(0, 0, 0, 0.45)), url("https://images.unsplash.com/...")
//      splitLayers / photoUrlOf / overlayLayersOf / withPhotoUrl /
//      withScrimStrength read and rewrite those layers without touching the
//      others.
//
//   2. A crop's focal point is an `objectPosition` (img) or
//      `backgroundPosition` (background) in percent. parseFocalPosition reads
//      the keyword and percent forms the editor already writes ("center
//      center", "left top", "30% 70%"); formatFocalPosition writes "x% y%".

/** A focal point in percent of the image, 0 to 100 from the left and top edge. */
export interface FocalPoint {
  x: number;
  y: number;
}

/** The centre: what a crop shows when nothing better is known. */
export const CENTER_FOCAL_POINT: FocalPoint = { x: 50, y: 50 };

/**
 * Split a CSS layer list at its top-level commas (commas inside parentheses,
 * as in rgba() or a gradient's stops, belong to the layer). Empty layers are
 * dropped and each layer is trimmed.
 */
export function splitLayers(value: string): string[] {
  const layers: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      layers.push(value.slice(start, i));
      start = i + 1;
    }
  }
  layers.push(value.slice(start));
  return layers.map((l) => l.trim()).filter((l) => l.length > 0);
}

/** The URL inside one `url(...)` layer, without its quotes; undefined for any other layer. */
export function urlOfLayer(layer: string): string | undefined {
  const m = /^url\(\s*(['"]?)(.*?)\1\s*\)$/i.exec(layer.trim());
  return m && m[2].trim() ? m[2].trim() : undefined;
}

/** The photo of a background: the URL of its first url() layer. */
export function photoUrlOf(backgroundImage: unknown): string | undefined {
  if (typeof backgroundImage !== 'string') return undefined;
  for (const layer of splitLayers(backgroundImage)) {
    const url = urlOfLayer(layer);
    if (url) return url;
  }
  return undefined;
}

/** Every layer that is not a url() (gradients, the scrim), top first. */
export function overlayLayersOf(backgroundImage: unknown): string[] {
  if (typeof backgroundImage !== 'string') return [];
  return splitLayers(backgroundImage).filter((l) => urlOfLayer(l) === undefined);
}

/** A url() layer for a photo URL (double quotes; a quote inside the URL is escaped). */
export function urlLayer(url: string): string {
  return `url("${url.replace(/"/g, '%22')}")`;
}

/** Join layers into one backgroundImage value; '' when there are none. */
export function composeLayers(layers: string[]): string {
  return layers.filter((l) => l.trim().length > 0).join(', ');
}

/**
 * The background with its photo set to `url` (or removed when `url` is
 * empty), keeping every overlay layer on top in its order.
 */
export function withPhotoUrl(backgroundImage: unknown, url: string | undefined): string {
  const overlays = overlayLayersOf(backgroundImage);
  const clean = url?.trim();
  return composeLayers(clean ? [...overlays, urlLayer(clean)] : overlays);
}

const SCRIM_RE =
  /^linear-gradient\(\s*rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*(0|1|0?\.\d+)\s*\)\s*,\s*rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*(0|1|0?\.\d+)\s*\)\s*\)$/i;

/** An even black scrim of the given strength (0 to 1, rounded to two decimals). */
export function scrimLayer(strength: number): string {
  const a = Math.round(clamp(strength, 0, 1) * 100) / 100;
  return `linear-gradient(rgba(0, 0, 0, ${a}), rgba(0, 0, 0, ${a}))`;
}

/**
 * The strength of the background's scrim: 0 with no overlay layer, the alpha
 * of an even black scrim (what scrimLayer writes), and undefined for any
 * other overlay (a directional or coloured gradient the panel does not model
 * as one number).
 */
export function scrimStrengthOf(backgroundImage: unknown): number | undefined {
  const overlays = overlayLayersOf(backgroundImage);
  if (overlays.length === 0) return 0;
  if (overlays.length > 1) return undefined;
  const m = SCRIM_RE.exec(overlays[0]);
  if (!m || m[1] !== m[2]) return undefined;
  return Number(m[1]);
}

/**
 * The background with its overlay replaced by an even black scrim of
 * `strength` (none at 0). The photo layer stays as it is.
 */
export function withScrimStrength(backgroundImage: unknown, strength: number): string {
  const url = photoUrlOf(backgroundImage);
  const layers = strength > 0 ? [scrimLayer(strength)] : [];
  if (url) layers.push(urlLayer(url));
  return composeLayers(layers);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

const KEYWORD_X: Record<string, number> = { left: 0, center: 50, right: 100 };
const KEYWORD_Y: Record<string, number> = { top: 0, center: 50, bottom: 100 };

/**
 * Read an objectPosition / backgroundPosition into percent. Understands one
 * or two values of keywords (left, center, right, top, bottom, in either
 * order) and percentages; anything else (px offsets, four-value syntax, a
 * missing value) reads as the centre for that axis.
 */
export function parseFocalPosition(value: unknown): FocalPoint {
  if (typeof value !== 'string' || !value.trim()) return { ...CENTER_FOCAL_POINT };
  // A layered position ("50% 50%, 50% 50%") reads from its first layer.
  const parts = splitLayers(value)[0]?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  let x: number | undefined;
  let y: number | undefined;
  const pct = (p: string): number | undefined => {
    const m = /^(-?\d+(?:\.\d+)?)%$/.exec(p);
    return m ? clamp(Number(m[1]), 0, 100) : undefined;
  };
  if (parts.length === 1) {
    const p = parts[0];
    if (p in KEYWORD_Y && p !== 'center') y = KEYWORD_Y[p];
    else if (p in KEYWORD_X) x = KEYWORD_X[p];
    else x = pct(p);
  } else if (parts.length === 2) {
    const [a, b] = parts;
    // A vertical keyword first ("top left") swaps the axes.
    if ((a === 'top' || a === 'bottom') && (b in KEYWORD_X)) {
      y = KEYWORD_Y[a];
      x = KEYWORD_X[b];
    } else {
      x = a in KEYWORD_X ? KEYWORD_X[a] : pct(a);
      y = b in KEYWORD_Y ? KEYWORD_Y[b] : pct(b);
    }
  }
  return { x: x ?? 50, y: y ?? 50 };
}

/** Write a focal point as "x% y%" (whole percent, clamped to 0 to 100). */
export function formatFocalPosition(point: FocalPoint): string {
  const r = (n: number) => Math.round(clamp(Number.isFinite(n) ? n : 50, 0, 100));
  return `${r(point.x)}% ${r(point.y)}%`;
}

/**
 * Parse an aspect ratio ("16 / 9", "16/9", "1.5", 1.5) into width / height.
 * Undefined for "auto", zero, negative or malformed values.
 */
export function parseAspectRatio(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?)\s*)?$/.exec(value);
  if (!m) return undefined;
  const w = Number(m[1]);
  const h = m[2] === undefined ? 1 : Number(m[2]);
  return w > 0 && h > 0 ? w / h : undefined;
}
