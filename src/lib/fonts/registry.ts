// src/lib/fonts/registry.ts
//
// The curated web-font library (plan docs/plans/2026-10-23-ai-design-quality-round-2.md,
// decision 3). Every family is openly licensed (SIL Open Font License 1.1),
// installed from a pinned @fontsource package and SELF-HOSTED: scripts/sync-fonts.mjs
// copies the woff2 files listed here into public/fonts/<id>/<version>/ at dev and
// build time, so a page never asks fonts.googleapis.com or gstatic for anything
// (the GDPR problem since LG Muenchen, 2022). Inter, Geist and Space Grotesk are
// deliberately absent: they mark a page as generated.
//
// Only the families a page actually uses are declared (collectPageFonts +
// fontFaceCss), in the editor canvas, the preview and the published page. A
// declared face costs nothing until text needs it: the browser fetches a face
// only for the weights, styles and unicode ranges it draws.
//
// PURE: no React, no MST, no Node APIs (the sync script reads the same data).

export type FontCategory = 'serif' | 'sans' | 'geometric' | 'condensed' | 'mono';

export const FONT_CATEGORIES: readonly { id: FontCategory; label: string }[] = [
  { id: 'serif', label: 'Serif' },
  { id: 'sans', label: 'Sans serif' },
  { id: 'geometric', label: 'Geometric' },
  { id: 'condensed', label: 'Condensed' },
  { id: 'mono', label: 'Monospace' },
];

export type FontSubset = 'latin' | 'latin-ext';

/** The unicode ranges of the two subsets, verbatim from @fontsource 5.3. German umlauts and ß are in latin. */
export const SUBSET_UNICODE_RANGE: Record<FontSubset, string> = {
  latin:
    'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  'latin-ext':
    'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
};

export interface FontFace {
  style: 'normal' | 'italic';
  subset: FontSubset;
  /** File name inside the package's `files/` directory (and the served directory). */
  file: string;
}

export interface FontFamilyDef {
  /** Stable id, also the served directory name. */
  id: string;
  /** Name shown in the font picker. */
  displayName: string;
  /** The CSS font-family name the @font-face rules declare and styles reference. */
  cssFamily: string;
  /** Fallback stack after the family, used until the face loads or if it cannot. */
  fallback: string;
  category: FontCategory;
  /** One line of character, for the picker and the generator. */
  character: string;
  /** Weight range [min, max]; equal for a single-weight family. */
  weight: readonly [number, number];
  /** Variable axes the files carry (wght, opsz), empty for a static family. */
  axes: readonly string[];
  /** The npm package the files come from, and its pinned version (package.json devDependencies). */
  pkg: string;
  version: string;
  faces: readonly FontFace[];
}

const SERIF_FALLBACK = "Georgia, 'Times New Roman', serif";
const SANS_FALLBACK = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const CONDENSED_FALLBACK = "'Arial Narrow', 'Roboto Condensed', Impact, sans-serif";
const MONO_FALLBACK = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

const FONTSOURCE_VERSION = '5.3.0';

/**
 * The faces of one family: latin and latin-ext for each style, named the way
 * @fontsource names its files (`<id>-<subset>-<variant>-<style>.woff2`).
 */
function faces(id: string, variant: string, styles: readonly ('normal' | 'italic')[]): FontFace[] {
  const out: FontFace[] = [];
  for (const style of styles) {
    for (const subset of ['latin', 'latin-ext'] as const) {
      out.push({ style, subset, file: `${id}-${subset}-${variant}-${style}.woff2` });
    }
  }
  return out;
}

const BOTH = ['normal', 'italic'] as const;
const UPRIGHT = ['normal'] as const;

export const FONT_LIBRARY: readonly FontFamilyDef[] = [
  // Editorial serifs.
  {
    id: 'fraunces', displayName: 'Fraunces', cssFamily: 'Fraunces', fallback: SERIF_FALLBACK, category: 'serif',
    character: 'soft, characterful old-style serif with optical sizes; warm editorial headlines',
    weight: [100, 900], axes: ['wght', 'opsz'], pkg: '@fontsource-variable/fraunces', version: FONTSOURCE_VERSION,
    faces: faces('fraunces', 'standard', BOTH),
  },
  {
    id: 'instrument-serif', displayName: 'Instrument Serif', cssFamily: 'Instrument Serif', fallback: SERIF_FALLBACK, category: 'serif',
    character: 'narrow, elegant display serif; single weight 400, headlines at large sizes only',
    weight: [400, 400], axes: [], pkg: '@fontsource/instrument-serif', version: FONTSOURCE_VERSION,
    faces: faces('instrument-serif', '400', BOTH),
  },
  {
    id: 'newsreader', displayName: 'Newsreader', cssFamily: 'Newsreader', fallback: SERIF_FALLBACK, category: 'serif',
    character: 'calm, readable news serif; long body text and quiet headlines',
    weight: [200, 800], axes: ['wght'], pkg: '@fontsource-variable/newsreader', version: FONTSOURCE_VERSION,
    faces: faces('newsreader', 'wght', BOTH),
  },
  {
    id: 'dm-serif-display', displayName: 'DM Serif Display', cssFamily: 'DM Serif Display', fallback: SERIF_FALLBACK, category: 'serif',
    character: 'high-contrast display serif; single weight 400, headings only',
    weight: [400, 400], axes: [], pkg: '@fontsource/dm-serif-display', version: FONTSOURCE_VERSION,
    faces: faces('dm-serif-display', '400', BOTH),
  },
  {
    id: 'playfair-display', displayName: 'Playfair Display', cssFamily: 'Playfair Display', fallback: SERIF_FALLBACK, category: 'serif',
    character: 'classic high-contrast transitional serif; fashion, food and luxury headlines',
    weight: [400, 900], axes: ['wght'], pkg: '@fontsource-variable/playfair-display', version: FONTSOURCE_VERSION,
    faces: faces('playfair-display', 'wght', BOTH),
  },
  // Grotesk and humanist sans.
  {
    id: 'bricolage-grotesque', displayName: 'Bricolage Grotesque', cssFamily: 'Bricolage Grotesque', fallback: SANS_FALLBACK, category: 'sans',
    character: 'quirky grotesk with optical sizes; expressive headlines, friendly body',
    weight: [200, 800], axes: ['wght', 'opsz', 'wdth'], pkg: '@fontsource-variable/bricolage-grotesque', version: FONTSOURCE_VERSION,
    faces: faces('bricolage-grotesque', 'standard', UPRIGHT),
  },
  {
    id: 'manrope', displayName: 'Manrope', cssFamily: 'Manrope', fallback: SANS_FALLBACK, category: 'sans',
    character: 'open, modern semi-geometric sans; clean body text and interfaces',
    weight: [200, 800], axes: ['wght'], pkg: '@fontsource-variable/manrope', version: FONTSOURCE_VERSION,
    faces: faces('manrope', 'wght', UPRIGHT),
  },
  {
    id: 'plus-jakarta-sans', displayName: 'Plus Jakarta Sans', cssFamily: 'Plus Jakarta Sans', fallback: SANS_FALLBACK, category: 'sans',
    character: 'crisp contemporary grotesk; product and service body text',
    weight: [200, 800], axes: ['wght'], pkg: '@fontsource-variable/plus-jakarta-sans', version: FONTSOURCE_VERSION,
    faces: faces('plus-jakarta-sans', 'wght', BOTH),
  },
  {
    id: 'hanken-grotesk', displayName: 'Hanken Grotesk', cssFamily: 'Hanken Grotesk', fallback: SANS_FALLBACK, category: 'sans',
    character: 'neutral, sturdy grotesk; the workhorse for body text',
    weight: [100, 900], axes: ['wght'], pkg: '@fontsource-variable/hanken-grotesk', version: FONTSOURCE_VERSION,
    faces: faces('hanken-grotesk', 'wght', BOTH),
  },
  {
    id: 'familjen-grotesk', displayName: 'Familjen Grotesk', cssFamily: 'Familjen Grotesk', fallback: SANS_FALLBACK, category: 'sans',
    character: 'Scandinavian grotesk with sharp details; confident headings and body, weights 400 to 700',
    weight: [400, 700], axes: ['wght'], pkg: '@fontsource-variable/familjen-grotesk', version: FONTSOURCE_VERSION,
    faces: faces('familjen-grotesk', 'wght', BOTH),
  },
  {
    id: 'archivo', displayName: 'Archivo', cssFamily: 'Archivo', fallback: SANS_FALLBACK, category: 'sans',
    character: 'robust, slightly technical grotesk; bold headlines and dense layouts',
    weight: [100, 900], axes: ['wght'], pkg: '@fontsource-variable/archivo', version: FONTSOURCE_VERSION,
    faces: faces('archivo', 'wght', BOTH),
  },
  // Geometric display.
  {
    id: 'outfit', displayName: 'Outfit', cssFamily: 'Outfit', fallback: SANS_FALLBACK, category: 'geometric',
    character: 'round geometric sans; friendly, bold display and short body',
    weight: [100, 900], axes: ['wght'], pkg: '@fontsource-variable/outfit', version: FONTSOURCE_VERSION,
    faces: faces('outfit', 'wght', UPRIGHT),
  },
  {
    id: 'sora', displayName: 'Sora', cssFamily: 'Sora', fallback: SANS_FALLBACK, category: 'geometric',
    character: 'wide geometric sans with a technical feel; tech and finance headlines',
    weight: [100, 800], axes: ['wght'], pkg: '@fontsource-variable/sora', version: FONTSOURCE_VERSION,
    faces: faces('sora', 'wght', UPRIGHT),
  },
  // Condensed display.
  {
    id: 'big-shoulders', displayName: 'Big Shoulders', cssFamily: 'Big Shoulders', fallback: CONDENSED_FALLBACK, category: 'condensed',
    character: 'tall condensed industrial display; posters, sport, big figures, uppercase headlines',
    weight: [100, 900], axes: ['wght', 'opsz'], pkg: '@fontsource-variable/big-shoulders', version: FONTSOURCE_VERSION,
    faces: faces('big-shoulders', 'standard', UPRIGHT),
  },
  // Mono for small labels and figures.
  {
    id: 'jetbrains-mono', displayName: 'JetBrains Mono', cssFamily: 'JetBrains Mono', fallback: MONO_FALLBACK, category: 'mono',
    character: 'clear monospace; small labels, prices, figures, never body text',
    weight: [100, 800], axes: ['wght'], pkg: '@fontsource-variable/jetbrains-mono', version: FONTSOURCE_VERSION,
    faces: faces('jetbrains-mono', 'wght', BOTH),
  },
];

/** Families that must never be offered or kept (plan, tell 5). */
export const BANNED_FONT_FAMILIES: readonly string[] = ['Inter', 'Geist', 'Space Grotesk'];

/** The stack the panel offers for "system fonts" (no download at all). */
export const SYSTEM_FONT_STACK = SANS_FALLBACK;

const BY_ID = new Map(FONT_LIBRARY.map((f) => [f.id, f]));
const BY_NAME = new Map(FONT_LIBRARY.map((f) => [f.cssFamily.toLowerCase(), f]));

export function getFontFamily(id: string): FontFamilyDef | undefined {
  return BY_ID.get(id);
}

/** The library family a single CSS family name refers to (quotes and case ignored). */
export function findLibraryFamily(name: string): FontFamilyDef | undefined {
  return BY_NAME.get(unquote(name).toLowerCase());
}

/** The full font-family value for a library family: the family, then its fallback stack. */
export function fontStack(family: FontFamilyDef): string {
  return `'${family.cssFamily}', ${family.fallback}`;
}

/** The public URL a face is served at (same origin, versioned so it can be cached forever). */
export function faceUrl(family: FontFamilyDef, face: FontFace): string {
  return `/fonts/${family.id}/${family.version}/${face.file}`;
}

function unquote(name: string): string {
  return name.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
}

/** Split a font-family list into unquoted names, respecting quoted names with commas. */
export function parseFontFamilyList(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map(unquote).filter((n) => n.length > 0);
}

/**
 * The family list inside a `font` shorthand ("italic 600 48px/1.1 'Fraunces', serif"):
 * everything after the size token (a length or a size keyword, with an optional
 * /line-height). Returns '' when no size token is found.
 */
export function familiesFromFontShorthand(value: string): string {
  const m = value.match(
    /(?:^|\s)(?:[\d.]+(?:px|em|rem|%|pt|vw|vh|ch|ex)|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)(?:\s*\/\s*[^\s]+)?\s+(.+)$/i,
  );
  return m ? m[1] : '';
}

/** Every library family named anywhere in a font-family list. */
export function libraryFamiliesIn(value: string): FontFamilyDef[] {
  const out: FontFamilyDef[] = [];
  for (const name of parseFontFamilyList(value)) {
    const f = findLibraryFamily(name);
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

/**
 * The @font-face rules for a set of family ids (unknown ids are ignored), in
 * library order so the text is deterministic. Every value comes from this
 * registry, never from page data, so the text is safe inside a <style>.
 */
export function fontFaceCss(ids: Iterable<string>): string {
  const wanted = new Set(ids);
  const rules: string[] = [];
  for (const family of FONT_LIBRARY) {
    if (!wanted.has(family.id)) continue;
    const [min, max] = family.weight;
    const weight = min === max ? String(min) : `${min} ${max}`;
    for (const face of family.faces) {
      // Every browser that reads woff2 also reads variable woff2 under plain format('woff2').
      rules.push(
        `@font-face{font-family:'${family.cssFamily}';font-style:${face.style};font-weight:${weight};` +
          `font-display:swap;src:url('${faceUrl(family, face)}') format('woff2');` +
          `unicode-range:${SUBSET_UNICODE_RANGE[face.subset]}}`,
      );
    }
  }
  return rules.join('\n');
}

/** The face to preload for a family: its latin upright file. */
export function preloadFaceUrl(family: FontFamilyDef): string | undefined {
  const face = family.faces.find((f) => f.subset === 'latin' && f.style === 'normal');
  return face ? faceUrl(family, face) : undefined;
}

// ---------------------------------------------------------------------------
// Page scan
// ---------------------------------------------------------------------------

/**
 * The tree shape both the editor (MST ComponentInstance) and the published
 * page (ComponentNode) share: a tag, props with a style whose values may be
 * responsive maps, and children.
 */
export interface FontScanNode {
  type?: string;
  props?: unknown;
  children?: Iterable<FontScanNode> | null;
}

function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.values(value as Record<string, unknown>).filter((v): v is string => typeof v === 'string');
  }
  return [];
}

/** The library families one style object references (fontFamily and the font shorthand, responsive maps included). */
export function styleFontFamilies(style: unknown): FontFamilyDef[] {
  if (!style || typeof style !== 'object') return [];
  const s = style as Record<string, unknown>;
  const out: FontFamilyDef[] = [];
  const add = (list: FontFamilyDef[]) => {
    for (const f of list) if (!out.includes(f)) out.push(f);
  };
  for (const v of stringsOf(s.fontFamily)) add(libraryFamiliesIn(v));
  for (const v of stringsOf(s.font)) add(libraryFamiliesIn(familiesFromFontShorthand(v)));
  return out;
}

export interface PageFonts {
  /** Library family ids the page uses, in order of first appearance. */
  ids: string[];
  /** The family of the first h1 (else h2), inherited from its ancestors when it sets none: the one to preload. */
  displayId?: string;
}

/** Scan one or more trees for the library families their styles use. */
export function collectPageFonts(roots: Iterable<FontScanNode | null | undefined>): PageFonts {
  const ids: string[] = [];
  let h1: string | undefined;
  let h2: string | undefined;

  const visit = (node: FontScanNode, inherited: string | undefined) => {
    const props = node.props as { style?: unknown } | undefined;
    const families = styleFontFamilies(props?.style);
    for (const f of families) if (!ids.includes(f.id)) ids.push(f.id);
    const own = families[0]?.id ?? inherited;
    if (node.type === 'h1' && h1 === undefined && own) h1 = own;
    if (node.type === 'h2' && h2 === undefined && own) h2 = own;
    if (node.children) for (const child of node.children) if (child) visit(child, own);
  };

  for (const root of roots) if (root) visit(root, undefined);
  return { ids, displayId: h1 ?? h2 };
}

// ---------------------------------------------------------------------------
// Normalisation (generator output)
// ---------------------------------------------------------------------------

/** Faces every platform has, and the CSS generic keywords: a stack of these needs no download. */
const SYSTEM_FAMILIES = new Set(
  [
    'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif',
    'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong', '-apple-system', 'blinkmacsystemfont',
    'segoe ui', 'roboto', 'helvetica', 'helvetica neue', 'arial', 'arial narrow', 'georgia', 'times',
    'times new roman', 'iowan old style', 'palatino', 'palatino linotype', 'book antiqua', 'garamond',
    'courier', 'courier new', 'menlo', 'monaco', 'consolas', 'sf mono', 'sf pro', 'sf pro text',
    'sf pro display', 'verdana', 'tahoma', 'trebuchet ms', 'impact', 'inherit', 'initial', 'unset', 'revert',
  ],
);

/** The library family an unknown family maps to, by the generic family its stack ends in. */
export const CATEGORY_DEFAULTS: Record<'serif' | 'sans' | 'mono', string> = {
  serif: 'fraunces',
  sans: 'hanken-grotesk',
  mono: 'jetbrains-mono',
};

export interface NormalizedFontFamily {
  value: string;
  changed: boolean;
  /** Set only when the family was REPLACED (not merely given its canonical stack): why, for a validation warning. */
  reason?: string;
}

/**
 * Normalise a generated fontFamily value:
 *   - a stack led by a library family becomes that family's canonical stack;
 *   - a stack of system faces and generic keywords is kept as given;
 *   - anything else (a banned family such as Inter, or a font this app does
 *     not host) maps to the library default of its category, judged by the
 *     generic keyword in the stack (serif, monospace, else sans).
 */
export function normalizeFontFamily(raw: string): NormalizedFontFamily {
  const value = raw.trim();
  const names = parseFontFamilyList(value);
  const first = names[0];
  if (!first) return { value, changed: false };
  const lib = findLibraryFamily(first);
  if (lib) {
    const canonical = fontStack(lib);
    return canonical === value ? { value, changed: false } : { value: canonical, changed: true };
  }
  if (SYSTEM_FAMILIES.has(first.toLowerCase())) return { value, changed: false };
  const lower = names.map((n) => n.toLowerCase());
  const category: keyof typeof CATEGORY_DEFAULTS =
    lower.some((n) => n === 'monospace' || n === 'ui-monospace' || n.includes('mono'))
      ? 'mono'
      : lower.some((n) => n === 'serif' || n === 'ui-serif')
        ? 'serif'
        : 'sans';
  const fallback = getFontFamily(CATEGORY_DEFAULTS[category])!;
  const banned = BANNED_FONT_FAMILIES.some((b) => b.toLowerCase() === first.toLowerCase());
  return {
    value: fontStack(fallback),
    changed: true,
    reason: `"${first}" is ${banned ? 'a banned typeface' : 'not in the font library'}, replaced by ${fallback.cssFamily}`,
  };
}
