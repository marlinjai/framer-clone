// src/lib/site/theme.ts
//
// A site's theme: its shared colour and font tokens, the colour mode, and the
// document's default colours and font (contract docs/plans/2026-11-02-theme-and-head.md,
// slice T1). PURE: no MST, no Prisma, no React, so the model, the save path, the
// renderers and the tests share one shape and one parser.
//
// Where it lives: `siteSettings.theme` (src/lib/site/siteSettings.ts), so it needs no
// column of its own and the published copy freezes it with the rest of Site settings.
//
// The shape in one breath:
//   - A token has a stable id (`^[a-z0-9]{8}$`, minted once, never shown) and a name,
//     which is only a label. A style value refers to it as `var(--fc-t-<id>)`, exactly,
//     so a rename touches one field and no node.
//   - Deleting sets `deleted: true` (a tombstone): the token leaves the pickers and stays
//     in the sheet with its values, so nothing moves on any page. Only Clean up removes a
//     tombstone, and only one the reference scan finds no use of.
//   - A colour value has a closed grammar (parseColorValue), because the sheet is written
//     raw and applies to the whole document. A font token holds a FONT_LIBRARY id, never
//     text. A value that stops parsing keeps its text, is marked broken and is never emitted.
//   - `mode` is optional: absent means nobody chose, which shows light values, keeps every
//     stored rule and writes no `color-scheme`.
//
// themeCss is the only emitter, and it trusts nothing it reads: ids, kinds, values and the
// document block are checked again at emission, because a frozen published revision can
// predate any later tightening of these rules.

import { FONT_LIBRARY, SYSTEM_FONT_STACK, fontFaceCss, fontStack, getFontFamily } from '@/lib/fonts/registry';
import { parseCssColor, trimAsciiSpace } from '@/lib/color/cssColor';

// ---------------------------------------------------------------------------
// The stored shape
// ---------------------------------------------------------------------------

export const THEME_MODES = ['system', 'light', 'dark'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** Which values a renderer shows: the light ones or the dark ones. */
export type ColorScheme = 'light' | 'dark';

export interface ColorToken {
  /** `^[a-z0-9]{8}$`, minted once, never reused, never shown. */
  id: string;
  /** The label: 1 to 40 characters, unique among live tokens of its kind, ignoring case. */
  name: string;
  kind: 'color';
  /** The closed colour grammar (parseColorValue). Stored text when broken. */
  light: string;
  /** Absent: the light value in both modes. */
  dark?: string;
  /** A tombstone: out of the pickers, still in the sheet. */
  deleted?: true;
  /** A value that does not parse: kept as stored, never emitted. Recomputed on every read. */
  broken?: true;
}

export interface FontToken {
  id: string;
  name: string;
  kind: 'font';
  /** A FONT_LIBRARY id, or 'system'. An unknown id emits SYSTEM_FONT_STACK. */
  family: string;
  deleted?: true;
}

export type ThemeToken = ColorToken | FontToken;
export type TokenKind = ThemeToken['kind'];

/** The site's default for what a page inherits. A page's `:root` rule beats each of these. */
export interface DocumentStyles {
  /** Exactly a colour reference. */
  backgroundColor?: string;
  /** Exactly a colour reference. */
  color?: string;
  /** Exactly a font reference. */
  fontFamily?: string;
}

export const DOCUMENT_KEYS = ['backgroundColor', 'color', 'fontFamily'] as const;
export type DocumentKey = (typeof DOCUMENT_KEYS)[number];

/** The kind of token each document property must refer to. */
export const DOCUMENT_KEY_KIND: Record<DocumentKey, TokenKind> = {
  backgroundColor: 'color',
  color: 'color',
  fontFamily: 'font',
};

export interface SiteTheme {
  /** Absent: not chosen. */
  mode?: ThemeMode;
  /** Panel order; ids unique. */
  tokens: ThemeToken[];
  document: DocumentStyles;
}

export const EMPTY_THEME: SiteTheme = { tokens: [], document: {} };

/**
 * Caps, so the stored blob never grows without bound and the sheet on every page stays
 * bounded. Enforced at write (validateThemeWrite). A stored blob over a cap still loads
 * whole, and themeCss emits up to the cap and warns.
 */
export const THEME_LIMITS = {
  liveTokens: 200,
  tombstones: 500,
  name: 40,
  colorValue: 64,
  /** Broken text beyond this is replaced by nothing. */
  brokenText: 256,
} as const;

export const TOKEN_ID = /^[a-z0-9]{8}$/;
const REFERENCE = /^var\(--fc-t-([a-z0-9]{8})\)$/;
const REFERENCES = /var\(--fc-t-([a-z0-9]{8})\)/g;

/** The one way a value names a token. */
export function tokenReference(id: string): string {
  return `var(--fc-t-${id})`;
}

/** The token id when `value` is exactly a reference, else null. No spaces, no fallback. */
export function parseTokenReference(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = REFERENCE.exec(value);
  return match ? match[1] : null;
}

/** The custom property a token is emitted as on the platform. */
export function tokenVariable(id: string): string {
  return `--fc-t-${id}`;
}

// ---------------------------------------------------------------------------
// The colour grammar
// ---------------------------------------------------------------------------

/**
 * The colour a token may hold, or null: a value the shared strict parser
 * (src/lib/color/cssColor.ts) reads as a colour that Chromium and WebKit both accept,
 * at most 64 characters, with surrounding ASCII white space removed. A closed allowlist,
 * not a sanitizer: no value reaches the raw sheet that the grammar did not name, and none
 * that a browser would drop.
 *
 * The grammar only ever widens from here: a stored value this build accepted must be
 * accepted by every later build, or a frozen published page loses a colour. It was
 * narrowed once, before any token could be stored, to what browsers actually read.
 */
export function parseColorValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = trimAsciiSpace(value);
  if (text.length === 0 || text.length > THEME_LIMITS.colorValue) return null;
  return parseCssColor(text) ? text : null;
}

/** True when `family` is a FONT_LIBRARY id or 'system'. */
export function isThemeFontFamily(family: unknown): family is string {
  return family === 'system' || (typeof family === 'string' && getFontFamily(family) !== undefined);
}

/** The text a font token emits: the registry's stack, never stored text. */
export function fontTokenStack(family: string): string {
  const def = family === 'system' ? undefined : getFontFamily(family);
  return def ? fontStack(def) : SYSTEM_FONT_STACK;
}

// ---------------------------------------------------------------------------
// Reading a stored theme
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A stored name, trimmed and never cut: cutting on read could turn two names that differ
 * past the limit into one, and a duplicate would then block every edit of the site. The
 * write check enforces the length.
 */
function tokenName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** A colour value as stored: kept when it parses, kept as text up to 256 characters when not. */
function storedColor(value: unknown): { text: string; ok: boolean } {
  const parsed = parseColorValue(value);
  if (parsed !== null) return { text: parsed, ok: true };
  const text = typeof value === 'string' ? value : '';
  return { text: text.length > THEME_LIMITS.brokenText ? '' : text, ok: false };
}

function normalizeToken(raw: unknown): ThemeToken | null {
  if (!isRecord(raw)) return null;
  const id = raw.id;
  // Only a token no reference can name is dropped.
  if (typeof id !== 'string' || !TOKEN_ID.test(id)) return null;
  const name = tokenName(raw.name);
  const deleted = raw.deleted === true ? { deleted: true as const } : {};
  if (raw.kind === 'color') {
    const light = storedColor(raw.light);
    const dark = raw.dark === undefined || raw.dark === null ? undefined : storedColor(raw.dark);
    // A stored `broken` is ignored: it is recomputed here, so a value an older build
    // marked reads as valid again under the build that accepts it.
    const broken = !light.ok || (dark !== undefined && !dark.ok);
    return {
      id,
      name,
      kind: 'color',
      light: light.text,
      ...(dark !== undefined ? { dark: dark.text } : {}),
      ...deleted,
      ...(broken ? { broken: true as const } : {}),
    };
  }
  if (raw.kind === 'font') {
    // An unknown family is kept as stored (it emits the system stack), so a family that
    // leaves the library does not take every reference on a live page with it.
    const family = typeof raw.family === 'string' ? raw.family.slice(0, THEME_LIMITS.brokenText) : '';
    return { id, name, kind: 'font', family, ...deleted };
  }
  // A kind this build does not know cannot be emitted or edited here. Colour and font are
  // the only kinds the contract defines; a new kind arrives with the build that reads it.
  return null;
}

/**
 * Any stored or submitted value -> a complete SiteTheme. Never throws, and keeps what is
 * stored: it drops only a token whose id fails its pattern (or a repeated id, or a kind
 * this build does not know), so a frozen revision never loses a referenced token. It does
 * not cut at the caps (themeCss does, when emitting). Idempotent: normalizing twice equals
 * normalizing once, so a working copy and a server copy compare equal.
 */
export function normalizeTheme(raw: unknown): SiteTheme {
  const t = isRecord(raw) ? raw : {};
  const mode = THEME_MODES.includes(t.mode as ThemeMode) ? (t.mode as ThemeMode) : undefined;
  const tokens: ThemeToken[] = [];
  const seen = new Set<string>();
  if (Array.isArray(t.tokens)) {
    for (const rawToken of t.tokens) {
      const token = normalizeToken(rawToken);
      if (!token || seen.has(token.id)) continue;
      seen.add(token.id);
      tokens.push(token);
    }
  }
  const doc = isRecord(t.document) ? t.document : {};
  const document: DocumentStyles = {};
  for (const key of DOCUMENT_KEYS) {
    // Only the exact reference form can ever be valid here, so nothing else is kept.
    if (parseTokenReference(doc[key]) !== null) document[key] = doc[key] as string;
  }
  return { ...(mode ? { mode } : {}), tokens, document };
}

/** True when the theme emits nothing at all: no mode chosen, no token, no document value. */
export function isEmptyTheme(theme: SiteTheme): boolean {
  return theme.mode === undefined && theme.tokens.length === 0 && Object.keys(theme.document).length === 0;
}

export function liveTokens(theme: SiteTheme): ThemeToken[] {
  return theme.tokens.filter((t) => !t.deleted);
}

export function tombstones(theme: SiteTheme): ThemeToken[] {
  return theme.tokens.filter((t) => t.deleted);
}

export function findToken(theme: SiteTheme, id: string): ThemeToken | undefined {
  return theme.tokens.find((t) => t.id === id);
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

export type ThemeScope = 'published' | 'surface' | 'export';

/** A token as it reaches a sheet: its variable name and its value per scheme. */
interface EmittedToken {
  token: ThemeToken;
  /** null: broken, so left out wherever the light scheme shows. */
  light: string | null;
  /** The dark value, else the light one. A broken dark value counts as absent. */
  dark: string | null;
}

/**
 * A colour token's values as a sheet may write them, each checked again. A broken value is
 * left out on its own: a broken dark value counts as no dark value, so the light one shows
 * in both schemes, and a broken light value leaves the token out wherever light shows.
 */
function colorValues(token: { light?: unknown; dark?: unknown }): { light: string | null; dark: string | null } {
  const light = parseColorValue(token.light);
  const dark = token.dark === undefined ? null : parseColorValue(token.dark);
  return { light, dark: dark ?? light };
}

/**
 * The tokens a sheet may hold, each checked again: id pattern, kind, and value through
 * parseColorValue. A broken colour is left out (references behave as missing). Over a cap,
 * the first tokens up to the cap are emitted, with a warning.
 */
function emittableTokens(theme: SiteTheme): EmittedToken[] {
  const out: EmittedToken[] = [];
  let live = 0;
  let dead = 0;
  let overCap = false;
  for (const token of Array.isArray(theme.tokens) ? theme.tokens : []) {
    if (!isRecord(token) || typeof token.id !== 'string' || !TOKEN_ID.test(token.id)) continue;
    if (token.deleted === true) {
      if (dead >= THEME_LIMITS.tombstones) { overCap = true; continue; }
      dead += 1;
    } else {
      if (live >= THEME_LIMITS.liveTokens) { overCap = true; continue; }
      live += 1;
    }
    if (token.kind === 'color') {
      const { light, dark } = colorValues(token);
      if (light === null && dark === null) continue;
      out.push({ token, light, dark });
    } else if (token.kind === 'font') {
      const stack = fontTokenStack(typeof token.family === 'string' ? token.family : '');
      out.push({ token, light: stack, dark: stack });
    }
  }
  if (overCap) {
    console.warn(
      `[theme] the stored theme holds more than ${THEME_LIMITS.liveTokens} tokens or ${THEME_LIMITS.tombstones} deleted ones; only the first up to each cap are emitted.`,
    );
  }
  return out;
}

/** The document block's declarations, each an exact reference, in a fixed order. */
function documentDeclarations(theme: SiteTheme, rename: (id: string) => string | null): string[] {
  const doc = isRecord(theme.document) ? theme.document : {};
  const property: Record<DocumentKey, string> = {
    backgroundColor: 'background-color',
    color: 'color',
    fontFamily: 'font-family',
  };
  const out: string[] = [];
  for (const key of DOCUMENT_KEYS) {
    const id = parseTokenReference(doc[key]);
    if (id === null) continue;
    const name = rename(id);
    if (name !== null) out.push(`${property[key]}:var(${name})`);
  }
  return out;
}

function block(selector: string, declarations: string[]): string {
  return declarations.length > 0 ? `${selector}{${declarations.join(';')}}` : '';
}

/** `color-scheme` for a chosen mode; nothing when nobody chose. */
function colorSchemeValue(mode: ThemeMode | undefined): string | null {
  if (mode === 'system') return 'light dark';
  if (mode === 'light' || mode === 'dark') return mode;
  return null;
}

/**
 * The name each token takes in an export: a slug of its name (`Accent Blue` ->
 * `--accent-blue`), unique within the theme. A name with no usable letter, a slug starting
 * `fc-` (reserved on the platform, so a re-import would refuse it) or `u-` (the namespace of
 * stored `@property` and `cssVar` names), or a slug already taken, uses `--token-<id>`.
 */
export function exportTokenNames(theme: SiteTheme): Map<string, string> {
  const names = new Map<string, string>();
  const taken = new Set<string>();
  // The fallback names are claimed first, so a slug can never collide with one.
  for (const token of theme.tokens) taken.add(`--token-${token.id}`);
  for (const token of theme.tokens) {
    if (!TOKEN_ID.test(token.id)) continue;
    const slug = token.name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const candidate = `--${slug}`;
    const usable = /[a-z]/.test(slug) && !slug.startsWith('fc-') && !slug.startsWith('u-') && !taken.has(candidate);
    const name = usable ? candidate : `--token-${token.id}`;
    taken.add(name);
    names.set(token.id, name);
  }
  return names;
}

/** Rewrite every platform reference in an exported value to its export name. Unknown ids stay as they are. */
export function exportReferences(value: string, names: ReadonlyMap<string, string>): string {
  return value.replace(REFERENCES, (whole, id: string) => {
    const name = names.get(id);
    return name ? `var(${name})` : whole;
  });
}

export interface ThemeCssOptions {
  /**
   * `published`: on `:root`, with the font faces and the document block on `body`, for the
   * `(site)` layout. `surface`: on `[data-fc-theme]`, for the canvas and preview, which share
   * the editor's document and must never touch its `:root`. `export`: named variables for a
   * site off the platform, with no `html`, `body` or faces.
   */
  scope?: ThemeScope;
}

/**
 * The theme as CSS: the only emitter. An empty theme with no chosen mode emits '' on every
 * scope, so every existing page stays byte for byte the same.
 *
 * | mode    | values                       | color-scheme  |
 * | absent  | light                        | not written   |
 * | light   | light                        | light         |
 * | dark    | dark ?? light                | dark          |
 * | system  | light, dark under the media  | light dark    |
 */
export function themeCss(raw: SiteTheme, options: ThemeCssOptions = {}): string {
  const scope = options.scope ?? 'published';
  // Trust nothing: the input may be a frozen revision read without normalizing.
  const theme = isRecord(raw) ? raw : EMPTY_THEME;
  const mode = THEME_MODES.includes(theme.mode as ThemeMode) ? theme.mode : undefined;
  const tokens = emittableTokens(theme);
  const exportNames = scope === 'export' ? exportTokenNames(normalizeTheme(theme)) : null;
  const variable = (id: string) => (exportNames ? exportNames.get(id) ?? `--token-${id}` : tokenVariable(id));
  const emitted = new Set(tokens.map((t) => t.token.id));
  const rename = (id: string) => (emitted.has(id) ? variable(id) : null);

  const forcedDark = mode === 'dark';
  const base = tokens.flatMap(({ token, light, dark }) => {
    const shown = forcedDark ? dark : light;
    return shown === null ? [] : [`${variable(token.id)}:${shown}`];
  });
  const darkOnly = mode === 'system'
    ? tokens.filter((t) => t.dark !== null && t.dark !== t.light).map(({ token, dark }) => `${variable(token.id)}:${dark}`)
    : [];
  const scheme = colorSchemeValue(mode);
  const docDecls = documentDeclarations(theme, rename);

  if (scope === 'export') {
    // `color-scheme` and the document block would restyle whoever installs the export.
    return [
      block(':root', base),
      darkOnly.length > 0 ? `@media (prefers-color-scheme:dark){${block(':root', darkOnly)}}` : '',
    ].join('');
  }

  if (scope === 'surface') {
    // A frame shows one mode, from its `data-fc-theme-mode` attribute. Only a `system` site
    // has a second mode to preview; a forced site shows its mode and a site with no choice
    // shows light.
    const darkDecls = mode === 'system' ? [...darkOnly, 'color-scheme:dark'] : [];
    return [
      block('[data-fc-theme]', scheme ? [...base, `color-scheme:${mode === 'system' ? 'light' : scheme}`] : base),
      mode === 'system' ? block('[data-fc-theme][data-fc-theme-mode=dark]', darkDecls) : '',
      block('[data-fc-theme=frame]', docDecls),
    ].join('');
  }

  // Published. A declared face costs nothing until text needs it, and no tree scan finds a
  // family behind a reference, so every font token's faces travel with the sheet.
  const fontIds = tokens
    .filter((t) => t.token.kind === 'font')
    .map((t) => (t.token as FontToken).family)
    .filter((family) => FONT_LIBRARY.some((f) => f.id === family));
  return [
    fontIds.length > 0 ? fontFaceCss(fontIds) : '',
    block(':root', scheme ? [...base, `color-scheme:${scheme}`] : base),
    darkOnly.length > 0 ? `@media (prefers-color-scheme:dark){${block(':root', darkOnly)}}` : '',
    block('body', docDecls),
  ].join('');
}

/**
 * Replace every token reference in `value` with that token's value in `scheme`: a colour's
 * light or dark text, a font's registry stack. A missing or broken token's reference stays as
 * it is, so a reader that cannot parse a `var()` treats it as unknown. Tombstones resolve,
 * because they are still in the sheet.
 */
export function resolveTokenRefs(value: string, theme: SiteTheme, scheme: ColorScheme): string {
  return value.replace(REFERENCES, (whole, id: string) => {
    const token = findToken(theme, id);
    if (!token) return whole;
    if (token.kind === 'font') return fontTokenStack(token.family);
    const { light, dark } = colorValues(token);
    return (scheme === 'dark' ? dark : light) ?? whole;
  });
}

/**
 * The scheme a site forces, or undefined when it forces none (`system` or no choice).
 * Only a forced mode decides what a stored `prefers-color-scheme` rule means
 * (src/lib/rules/colorMode.ts), and only forced `dark` writes `class="dark"` on `html`.
 */
export function themeColorMode(theme: SiteTheme | undefined): ColorScheme | undefined {
  const mode = isRecord(theme) ? theme.mode : undefined;
  return mode === 'light' || mode === 'dark' ? mode : undefined;
}

/**
 * The document background as a literal colour per scheme the page can show, for the
 * browser's own surfaces (`theme-color`), which take no `var()`. Empty when the document
 * block sets no background, and a scheme whose value the strict parser cannot read is
 * left out.
 */
export function documentBackgroundColors(theme: SiteTheme | undefined): { scheme: ColorScheme; color: string }[] {
  if (!isRecord(theme) || !isRecord(theme.document)) return [];
  const reference = theme.document.backgroundColor;
  if (parseTokenReference(reference) === null) return [];
  const normalized = normalizeTheme(theme);
  return schemesInForce(normalized.mode).flatMap((scheme) => {
    const color = parseColorValue(resolveTokenRefs(reference as string, normalized, scheme));
    return color === null ? [] : [{ scheme, color }];
  });
}

/** The schemes a page can show under a mode: both with `system`, else the one in force. */
export function schemesInForce(mode: ThemeMode | undefined): ColorScheme[] {
  if (mode === 'system') return ['light', 'dark'];
  return mode === 'dark' ? ['dark'] : ['light'];
}

// ---------------------------------------------------------------------------
// Where tokens are used
// ---------------------------------------------------------------------------

/**
 * How often each token id is referenced anywhere in `value`: a deep walk of every string in
 * a project snapshot (pages, floating nodes, rules, keyframe blocks, definitions, placement
 * overrides, inputs and `siteSettings.theme.document`), because a reference is a string
 * wherever it sits. Content collection values are not part of a project snapshot, so they are
 * not scanned; Clean up says so.
 */
export function tokenUsage(value: unknown): Map<string, number> {
  const counts = new Map<string, number>();
  const stack: unknown[] = [value];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === 'string') {
      if (!item.includes('--fc-t-')) continue;
      for (const match of item.matchAll(REFERENCES)) {
        counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
      }
    } else if (item && typeof item === 'object') {
      if (seen.has(item)) continue;
      seen.add(item);
      if (Array.isArray(item)) stack.push(...item);
      else stack.push(...Object.values(item as Record<string, unknown>));
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Editing: pure operations, each a new theme or a refusal
// ---------------------------------------------------------------------------

export type ThemeEdit = { ok: true; theme: SiteTheme } | { ok: false; error: string };

const KIND_LABEL: Record<TokenKind, string> = { color: 'colour', font: 'font' };

export const TOMBSTONE_CAP_MESSAGE =
  `This site already keeps ${THEME_LIMITS.tombstones} deleted tokens, the most it holds. Detach or Replace the uses of a deleted token, then Clean up unused removes it, and Delete works again.`;

/** A fresh id: 8 characters of `a-z0-9`, never one the theme holds, tombstones included. */
export function mintTokenId(
  taken: Iterable<string>,
  random: () => number = Math.random,
): string {
  const used = new Set(taken);
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    let id = '';
    for (let i = 0; i < 8; i += 1) id += alphabet[Math.floor(random() * alphabet.length) % alphabet.length];
    if (!used.has(id)) return id;
  }
  throw new Error('[theme] could not mint an unused token id');
}

function nameProblem(theme: SiteTheme, kind: TokenKind, name: string, exceptId?: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'Give the token a name.';
  if (trimmed.length > THEME_LIMITS.name) return `Keep the name to ${THEME_LIMITS.name} characters.`;
  const lower = trimmed.toLowerCase();
  const clash = theme.tokens.some(
    (t) => !t.deleted && t.kind === kind && t.id !== exceptId && t.name.toLowerCase() === lower,
  );
  return clash ? `Another ${KIND_LABEL[kind]} is already called ${trimmed}.` : null;
}

const COLOR_HINT = 'Use a colour like #1a2b3c, rgb(26 43 60), oklch(0.5 0.1 250) or a colour name.';

/** Add a colour token. `dark` is optional. */
export function addColorToken(
  theme: SiteTheme,
  input: { name: string; light: string; dark?: string },
  random?: () => number,
): ThemeEdit & { id?: string } {
  const problem = nameProblem(theme, 'color', input.name);
  if (problem) return { ok: false, error: problem };
  const light = parseColorValue(input.light);
  const dark = input.dark === undefined ? undefined : parseColorValue(input.dark);
  if (light === null || dark === null) return { ok: false, error: COLOR_HINT };
  if (liveTokens(theme).length >= THEME_LIMITS.liveTokens) {
    return { ok: false, error: `A site holds at most ${THEME_LIMITS.liveTokens} tokens.` };
  }
  const id = mintTokenId(theme.tokens.map((t) => t.id), random);
  const token: ColorToken = { id, name: input.name.trim(), kind: 'color', light, ...(dark !== undefined ? { dark } : {}) };
  return { ok: true, id, theme: { ...theme, tokens: [...theme.tokens, token] } };
}

/** Add a font token holding a FONT_LIBRARY id or 'system'. */
export function addFontToken(
  theme: SiteTheme,
  input: { name: string; family: string },
  random?: () => number,
): ThemeEdit & { id?: string } {
  const problem = nameProblem(theme, 'font', input.name);
  if (problem) return { ok: false, error: problem };
  if (!isThemeFontFamily(input.family)) return { ok: false, error: 'Pick a font from the library, or system fonts.' };
  if (liveTokens(theme).length >= THEME_LIMITS.liveTokens) {
    return { ok: false, error: `A site holds at most ${THEME_LIMITS.liveTokens} tokens.` };
  }
  const id = mintTokenId(theme.tokens.map((t) => t.id), random);
  return { ok: true, id, theme: { ...theme, tokens: [...theme.tokens, { id, name: input.name.trim(), kind: 'font', family: input.family }] } };
}

function replaceToken(theme: SiteTheme, id: string, next: ThemeToken): SiteTheme {
  return { ...theme, tokens: theme.tokens.map((t) => (t.id === id ? next : t)) };
}

/** Rename: the name changes, and nothing else, anywhere. */
export function renameToken(theme: SiteTheme, id: string, name: string): ThemeEdit {
  const token = findToken(theme, id);
  if (!token || token.deleted) return { ok: false, error: 'That token no longer exists.' };
  const problem = nameProblem(theme, token.kind, name, id);
  if (problem) return { ok: false, error: problem };
  return { ok: true, theme: replaceToken(theme, id, { ...token, name: name.trim() }) };
}

/** Set a colour token's values. `dark: null` removes the dark value; undefined leaves it. */
export function setColorValues(
  theme: SiteTheme,
  id: string,
  input: { light?: string; dark?: string | null },
): ThemeEdit {
  const token = findToken(theme, id);
  if (!token || token.deleted || token.kind !== 'color') return { ok: false, error: 'That colour no longer exists.' };
  const light = input.light === undefined ? token.light : parseColorValue(input.light);
  const dark = input.dark === undefined ? token.dark : input.dark === null ? undefined : parseColorValue(input.dark);
  if (light === null || dark === null) return { ok: false, error: COLOR_HINT };
  const next: ColorToken = {
    id: token.id,
    name: token.name,
    kind: 'color',
    light,
    ...(dark !== undefined ? { dark } : {}),
  };
  // A value left as stored keeps its broken mark; a fresh one parsed above.
  if (parseColorValue(next.light) === null || (next.dark !== undefined && parseColorValue(next.dark) === null)) {
    next.broken = true;
  }
  return { ok: true, theme: replaceToken(theme, id, next) };
}

/** Point a font token at another library family. */
export function setFontFamily(theme: SiteTheme, id: string, family: string): ThemeEdit {
  const token = findToken(theme, id);
  if (!token || token.deleted || token.kind !== 'font') return { ok: false, error: 'That font no longer exists.' };
  if (!isThemeFontFamily(family)) return { ok: false, error: 'Pick a font from the library, or system fonts.' };
  return { ok: true, theme: replaceToken(theme, id, { ...token, family }) };
}

/**
 * Delete: the token becomes a tombstone, out of the pickers and still in the sheet with its
 * values, so no page changes. Refused at the tombstone cap.
 */
export function deleteToken(theme: SiteTheme, id: string): ThemeEdit {
  const token = findToken(theme, id);
  if (!token || token.deleted) return { ok: false, error: 'That token no longer exists.' };
  if (tombstones(theme).length >= THEME_LIMITS.tombstones) return { ok: false, error: TOMBSTONE_CAP_MESSAGE };
  return { ok: true, theme: replaceToken(theme, id, { ...token, deleted: true }) };
}

/**
 * Clean up unused: remove the tombstones `usage` (tokenUsage of the project) finds no use
 * of. Live tokens are never removed. `removed` names what went, for the panel to say.
 */
export function cleanUpUnused(
  theme: SiteTheme,
  usage: ReadonlyMap<string, number>,
): { theme: SiteTheme; removed: ThemeToken[] } {
  const removed = theme.tokens.filter((t) => t.deleted && (usage.get(t.id) ?? 0) === 0);
  if (removed.length === 0) return { theme, removed };
  const gone = new Set(removed.map((t) => t.id));
  return { theme: { ...theme, tokens: theme.tokens.filter((t) => !gone.has(t.id)) }, removed };
}

/** Choose a mode, or `undefined` to return to not chosen. Values are untouched either way. */
export function setThemeMode(theme: SiteTheme, mode: ThemeMode | undefined): SiteTheme {
  const rest: SiteTheme = { tokens: theme.tokens, document: theme.document };
  return mode ? { ...rest, mode } : rest;
}

/** Set or clear one document property. The value must be a reference to a live token of the right kind. */
export function setDocumentStyle(theme: SiteTheme, key: DocumentKey, value: string | undefined): ThemeEdit {
  const document = { ...theme.document };
  if (value === undefined) {
    delete document[key];
    return { ok: true, theme: { ...theme, document } };
  }
  const id = parseTokenReference(value);
  const token = id ? findToken(theme, id) : undefined;
  if (!token || token.deleted || token.kind !== DOCUMENT_KEY_KIND[key]) {
    return { ok: false, error: `Pick a ${KIND_LABEL[DOCUMENT_KEY_KIND[key]]} token.` };
  }
  document[key] = value;
  return { ok: true, theme: { ...theme, document } };
}

// ---------------------------------------------------------------------------
// The write check (ProjectModel.updateTheme, the AI apply, the import placing)
// ---------------------------------------------------------------------------

/**
 * Every reason `next` may not replace `current`, in plain language. Empty when it may.
 * Both are normalized themes. A stored oddity that is unchanged (a broken value, an unknown
 * family, a name made long by an older build, a duplicate name) never blocks an unrelated
 * edit; a change must
 * be valid. Nothing may remove a live token outright: delete makes a tombstone, and only a
 * tombstone may be removed. A count over a cap may shrink but never grow.
 */
export function validateThemeWrite(next: SiteTheme, current: SiteTheme): string[] {
  const errors: string[] = [];
  const before = new Map(current.tokens.map((t) => [t.id, t]));
  const after = new Map(next.tokens.map((t) => [t.id, t]));

  const nextLive = liveTokens(next).length;
  const nextDead = tombstones(next).length;
  if (nextLive > THEME_LIMITS.liveTokens && nextLive > liveTokens(current).length) {
    errors.push(`A site holds at most ${THEME_LIMITS.liveTokens} tokens.`);
  }
  if (nextDead > THEME_LIMITS.tombstones && nextDead > tombstones(current).length) {
    errors.push(TOMBSTONE_CAP_MESSAGE);
  }

  for (const old of current.tokens) {
    if (!old.deleted && !after.has(old.id)) {
      errors.push(`${old.name || 'A token'} cannot be removed outright: delete it, and Clean up removes it once nothing uses it.`);
    }
  }

  // Each live token's name key, and whether this write gives it that name: a new token, a
  // rename, or a token coming back from a tombstone. A duplicate counts only when one of its
  // tokens takes part in this write, so a duplicate already stored never blocks an edit of
  // something else.
  const byName = new Map<string, Array<{ token: ThemeToken; named: boolean }>>();
  for (const token of next.tokens) {
    const old = before.get(token.id);
    if (old && old.kind !== token.kind) {
      errors.push(`${token.name || 'A token'} cannot change from a ${KIND_LABEL[old.kind]} to a ${KIND_LABEL[token.kind]}.`);
      continue;
    }
    if (token.deleted) continue;
    const named = !old || old.deleted === true || old.name !== token.name;
    if (named) {
      if (token.name.length === 0) errors.push('Give every token a name.');
      else if (token.name.length > THEME_LIMITS.name) errors.push(`${token.name.slice(0, THEME_LIMITS.name)}...: keep a name to ${THEME_LIMITS.name} characters.`);
    }
    if (token.kind === 'color') {
      const valuesChanged = !old || old.kind !== 'color' || old.light !== token.light || old.dark !== token.dark;
      if (valuesChanged && token.broken) errors.push(`${token.name || 'A colour'}: ${COLOR_HINT}`);
    } else {
      const familyChanged = !old || old.kind !== 'font' || old.family !== token.family;
      if (familyChanged && !isThemeFontFamily(token.family)) {
        errors.push(`${token.name || 'A font'}: pick a font from the library, or system fonts.`);
      }
    }
    if (token.name.length === 0) continue;
    const key = `${token.kind}:${token.name.toLowerCase()}`;
    byName.set(key, [...(byName.get(key) ?? []), { token, named }]);
  }
  for (const group of byName.values()) {
    if (group.length > 1 && group.some((entry) => entry.named)) {
      const token = group.find((entry) => entry.named)!.token;
      errors.push(`Two ${KIND_LABEL[token.kind]}s are called ${token.name}.`);
    }
  }

  for (const key of DOCUMENT_KEYS) {
    const value = next.document[key];
    if (value === undefined || value === current.document[key]) continue;
    const id = parseTokenReference(value);
    const token = id ? after.get(id) : undefined;
    if (!token || token.deleted || token.kind !== DOCUMENT_KEY_KIND[key]) {
      errors.push(`The page ${key === 'fontFamily' ? 'font' : key === 'color' ? 'text colour' : 'background'} must be a ${KIND_LABEL[DOCUMENT_KEY_KIND[key]]} token.`);
    }
  }
  return [...new Set(errors)];
}
