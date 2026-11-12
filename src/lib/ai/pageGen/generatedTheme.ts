// src/lib/ai/pageGen/generatedTheme.ts
//
// How a generated page uses the site theme (docs/plans/2026-11-02-theme-and-head.md,
// "What the AI may read and write", slice T5). Pure, no model, no store:
//
//   - A generated style value may refer to a live token as `var(--fc-t-<id>)`, exactly
//     (src/lib/site/theme.ts, tokenReference). Anything else that names `--fc-` is refused,
//     because it is either a typo that paints nothing or an attempt to reach a platform
//     variable. A refusal is an ERROR, so it drives the repair round: a value dropped with
//     a warning would ship a page whose colour is silently missing.
//   - A generation may add up to MAX_GENERATED_TOKENS tokens, in a `theme.tokens` field of
//     its output. It writes each under a local name (`new-1`) and refers to it as
//     `var(--fc-t-new-1)`. The hyphen means a local name can never pass as an id. The
//     validator mints the real id and rewrites the references, so a model never chooses one.
//   - A name that exists with the same values is reused. With different values it is
//     refused: adding "Accent 2" quietly is how palettes rot.
//   - Both halves are decided twice: on the server at validation (against the theme the
//     request carried) and in the editor at apply (against the theme as it is by then),
//     which is `reconcileGeneratedTokens`.
//
// Never edits, deletes or renames a token, and never touches `mode` or the document block.

import {
  addColorToken,
  addFontToken,
  findToken,
  liveTokens,
  normalizeTheme,
  parseColorValue,
  tokenUsage,
  validateThemeWrite,
  isThemeFontFamily,
  type ColorToken,
  type FontToken,
  type SiteTheme,
  type ThemeToken,
  type TokenKind,
} from '@/lib/site/theme';

/** Most tokens one generation may add. */
export const MAX_GENERATED_TOKENS = 12;

/** The local name a generation gives a token it adds: `new-1`, `new-2`. A real id has no hyphen. */
const LOCAL_NAME = /^new-([1-9][0-9]?)$/;
const ID_REFERENCE = /var\(--fc-t-([a-z0-9]{8})\)/g;
const LOCAL_REFERENCE = /var\(--fc-t-(new-[1-9][0-9]?)\)/g;
/**
 * Any spelling of a token variable, whatever case or spacing. The platform's other variables
 * (`--fc-sticky-cta-h`) are no token and a value may still read them, as before.
 */
const PLATFORM_TEXT = /--fc-t-/i;

/** One token as the model proposes it. */
export interface ProposedToken {
  /** The local name, `new-1`. */
  ref: string;
  name: string;
  kind: TokenKind;
  /** A colour: the light value, and optionally the dark one. */
  light?: string;
  dark?: string;
  /** A font: a library id or `system`. */
  family?: string;
}

export type ProposalOutcome = { ok: true; tokens: ProposedToken[] } | { ok: false; errors: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const PROPOSAL_KEYS = new Set(['ref', 'name', 'kind', 'light', 'dark', 'family']);

/**
 * The `theme` field of the model's output, read strictly. Nothing here judges a value:
 * `adoptProposedTokens` does that through the theme's own grammar. What is judged here is
 * the shape, so that a field the model invented is named in the repair message.
 */
export function parseProposedTokens(raw: unknown): ProposalOutcome {
  if (!isPlainObject(raw)) return { ok: false, errors: ['theme must be an object like {"tokens": [...]}'] };
  const stray = Object.keys(raw).filter((key) => key !== 'tokens');
  if (stray.length > 0) {
    return { ok: false, errors: [`theme holds only "tokens"; remove ${stray.map((k) => JSON.stringify(k)).join(', ')} (a generation never changes the mode or the document colours)`] };
  }
  const list = raw.tokens;
  if (list === undefined) return { ok: true, tokens: [] };
  if (!Array.isArray(list)) return { ok: false, errors: ['theme.tokens must be a list'] };
  if (list.length > MAX_GENERATED_TOKENS) {
    return { ok: false, errors: [`theme.tokens holds ${list.length} tokens; add at most ${MAX_GENERATED_TOKENS}, and use the site's own tokens where they fit`] };
  }
  const errors: string[] = [];
  const tokens: ProposedToken[] = [];
  const seen = new Set<string>();
  list.forEach((entry, index) => {
    const at = `theme.tokens[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${at} must be an object`);
      return;
    }
    const extra = Object.keys(entry).filter((key) => !PROPOSAL_KEYS.has(key));
    if (extra.length > 0) errors.push(`${at}: unknown ${extra.map((k) => JSON.stringify(k)).join(', ')}; a token holds ref, name, kind and its values`);
    const { ref, name, kind } = entry;
    if (typeof ref !== 'string' || !LOCAL_NAME.test(ref)) {
      errors.push(`${at}.ref must be a local name like "new-1" (then refer to it as var(--fc-t-new-1))`);
      return;
    }
    if (seen.has(ref)) {
      errors.push(`${at}.ref "${ref}" is used twice`);
      return;
    }
    seen.add(ref);
    if (typeof name !== 'string' || name.trim().length === 0) {
      errors.push(`${at}.name must be the token's label, such as "Accent"`);
      return;
    }
    if (kind !== 'color' && kind !== 'font') {
      errors.push(`${at}.kind must be "color" or "font"`);
      return;
    }
    const text = (field: string): string | undefined | null => {
      const value = entry[field];
      if (value === undefined) return undefined;
      return typeof value === 'string' ? value : null;
    };
    const light = text('light');
    const dark = text('dark');
    const family = text('family');
    if (light === null || dark === null || family === null) {
      errors.push(`${at}: light, dark and family must be text`);
      return;
    }
    if (kind === 'color') {
      if (light === undefined) errors.push(`${at}: a colour needs "light"`);
      if (family !== undefined) errors.push(`${at}: a colour has no "family"`);
    } else {
      if (family === undefined) errors.push(`${at}: a font needs "family"`);
      if (light !== undefined || dark !== undefined) errors.push(`${at}: a font has no "light" or "dark"`);
    }
    tokens.push({
      ref,
      name: name.trim(),
      kind,
      ...(light !== undefined ? { light } : {}),
      ...(dark !== undefined ? { dark } : {}),
      ...(family !== undefined ? { family } : {}),
    });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, tokens };
}

export interface AdoptedTokens {
  /** The theme with the new tokens in it. */
  theme: SiteTheme;
  /** Local name to the id it became (a reused token's id, or a newly minted one). */
  idByRef: ReadonlyMap<string, string>;
  /** The tokens that were new (not reused), with their minted ids, in the order proposed. */
  added: ThemeToken[];
}

export type AdoptOutcome = ({ ok: true } & AdoptedTokens) | { ok: false; errors: string[] };

/** A name as it may stand in a message sent back to the model: owner and model text, so no control, format or line-separator character, no quote that could close the message's own quoting, and no angle bracket. Cut on whole characters. */
export const plainName = (name: string): string =>
  Array.from(name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}"<>]/gu, ' ').replace(/\s+/g, ' ').trim()).slice(0, 40).join('');

const KIND_WORD: Record<TokenKind, string> = { color: 'colour', font: 'font' };

function sameColor(a: ColorToken, light: string | null, dark: string | null | undefined): boolean {
  return a.light === light && (a.dark ?? null) === (dark ?? null);
}

/**
 * Put the proposed tokens into `theme`: a live token of the same kind and name with the same
 * values is reused, one with other values refuses the whole proposal (naming the existing
 * token so the model can use it), anything else is added through the theme's own `addColorToken`
 * and `addFontToken`, so every rule of the Theme panel applies: the grammar, the name, the cap.
 * A name already taken by a deleted token is free, as in the panel.
 */
export function adoptProposedTokens(theme: SiteTheme, proposed: readonly ProposedToken[], random?: () => number): AdoptOutcome {
  let working = theme;
  const idByRef = new Map<string, string>();
  const added: ThemeToken[] = [];
  const errors: string[] = [];
  for (const token of proposed) {
    const label = `"${plainName(token.name)}" (${token.ref})`;
    const same = liveTokens(working).find((t) => t.kind === token.kind && t.name.toLowerCase() === token.name.toLowerCase());
    if (token.kind === 'color') {
      const light = parseColorValue(token.light);
      const dark = token.dark === undefined ? undefined : parseColorValue(token.dark);
      if (same && same.kind === 'color' && same.broken) {
        errors.push(`${label}: the site has a colour called "${plainName(same.name)}" whose value cannot be read, so it cannot be used or reused. Pick another name.`);
        continue;
      }
      if (same && same.kind === 'color') {
        if (light !== null && dark !== null && sameColor(same, light, dark)) {
          idByRef.set(token.ref, same.id);
        } else {
          errors.push(`${label}: the site already has a colour called "${plainName(same.name)}", var(--fc-t-${same.id}), with other values. Use it, or pick another name; a generation never changes an existing token.`);
        }
        continue;
      }
      const edit = addColorToken(working, { name: token.name, light: token.light ?? '', ...(token.dark !== undefined ? { dark: token.dark } : {}) }, random);
      if (!edit.ok || edit.id === undefined) {
        errors.push(`${label}: ${edit.ok ? 'could not be added' : edit.error}`);
        continue;
      }
      working = edit.theme;
      idByRef.set(token.ref, edit.id);
      added.push(findToken(working, edit.id) as ColorToken);
    } else {
      if (same && same.kind === 'font') {
        if (same.family === token.family) idByRef.set(token.ref, same.id);
        else errors.push(`${label}: the site already has a font called "${plainName(same.name)}", var(--fc-t-${same.id}), with another family. Use it, or pick another name; a generation never changes an existing token.`);
        continue;
      }
      const edit = addFontToken(working, { name: token.name, family: token.family ?? '' }, random);
      if (!edit.ok || edit.id === undefined) {
        errors.push(`${label}: ${edit.ok ? 'could not be added' : edit.error}`);
        continue;
      }
      working = edit.theme;
      idByRef.set(token.ref, edit.id);
      added.push(findToken(working, edit.id) as FontToken);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, theme: working, idByRef, added };
}

/** What `scanReferences` found in one style value. */
export interface ReferenceScan {
  /** Real ids, in order of appearance. */
  ids: string[];
  /** Local names (`new-1`). */
  locals: string[];
  /** True when the value names a token variable (`--fc-t-`) in any form other than an exact reference. */
  malformed: boolean;
  /** True when the value holds nothing but one exact reference. */
  whole: boolean;
}

/**
 * Every token reference in a style value. The grammar is `var(--fc-t-<id>)`, exactly: no
 * space, no fallback, lower case. Whatever else spells `--fc-t-` is `malformed`, so a fallback
 * (`var(--fc-t-ab12cd34, red)`), a capital letter or a space cannot slip through as a
 * variable the browser would still resolve.
 */
export function scanReferences(value: string): ReferenceScan {
  const ids = [...value.matchAll(ID_REFERENCE)].map((m) => m[1]);
  const locals = [...value.matchAll(LOCAL_REFERENCE)].map((m) => m[1]);
  const rest = value.replace(ID_REFERENCE, '').replace(LOCAL_REFERENCE, '');
  const whole = rest.trim() === '' && ids.length + locals.length === 1 && value.trim().startsWith('var(');
  return { ids, locals, malformed: PLATFORM_TEXT.test(rest), whole };
}

/** The value with each local reference replaced by the id it became. */
export function withLocalIds(value: string, idByRef: ReadonlyMap<string, string>): string {
  return value.replace(LOCAL_REFERENCE, (whole, local: string) => {
    const id = idByRef.get(local);
    return id === undefined ? whole : `var(--fc-t-${id})`;
  });
}

/**
 * What the validator knows about the theme while it reads a style value. `theme` is the
 * request's theme, the added tokens included; `held` is every id the target already
 * carries (a replace echoes it back), which stays allowed even when the token was deleted
 * since or never existed, because it is the owner's and renders exactly as it did.
 */
export interface ReferenceContext {
  theme: SiteTheme;
  held: ReadonlySet<string>;
  idByRef: ReadonlyMap<string, string>;
  /** False for the streaming preview: an unknown reference is dropped with a warning, never an error. */
  strict: boolean;
}

export interface ReferenceVerdict {
  /** Why the value is refused. */
  problem?: string;
  /** The value with its local names rewritten, when it is kept. */
  value: string;
  /** The ids it refers to, for the usage count. */
  used: string[];
}

/** Judge one style value for the property it stands on. Pure: the caller decides error or warning. */
export function judgeReferences(property: string, value: string, ctx: ReferenceContext): ReferenceVerdict {
  if (!PLATFORM_TEXT.test(value)) return { value, used: [] };
  const scan = scanReferences(value);
  const rewritten = withLocalIds(value, ctx.idByRef);
  const fail = (problem: string): ReferenceVerdict => ({ problem, value, used: [] });
  if (scan.malformed) {
    return fail('a token is referred to as var(--fc-t-<id>), exactly: no space, no fallback, lower case');
  }
  for (const local of scan.locals) {
    if (!ctx.idByRef.has(local)) {
      return fail(`${local} is not declared: add it to theme.tokens first, or use a token the site already has`);
    }
  }
  const isFontProperty = property === 'fontFamily';
  for (const id of [...scan.ids, ...scan.locals.map((l) => ctx.idByRef.get(l) as string)]) {
    const token = findToken(ctx.theme, id);
    if (!token) {
      if (ctx.held.has(id)) continue;
      return fail(`var(--fc-t-${id}) is not a token of this site: use one from the site's list`);
    }
    if (token.kind === 'color' && token.broken) {
      return fail(`"${plainName(token.name)}" has no readable value, so it paints nothing: use another token`);
    }
    if (token.deleted && !ctx.held.has(id)) {
      return fail(`"${plainName(token.name)}" was deleted from the site: use a token that is still there`);
    }
    if (token.kind === 'font' && !(isFontProperty && scan.whole)) {
      return fail(`"${plainName(token.name)}" is a font: it goes in fontFamily, as the whole value, and nowhere else`);
    }
    if (token.kind === 'color' && isFontProperty) {
      return fail(`"${plainName(token.name)}" is a colour: fontFamily takes a font token`);
    }
  }
  if (isFontProperty && !scan.whole) {
    return fail('a font token is the whole fontFamily value, with no other family beside it');
  }
  return { value: rewritten, used: [...scan.ids, ...scan.locals.map((l) => ctx.idByRef.get(l) as string)] };
}

// ---------------------------------------------------------------------------
// At apply, in the editor
// ---------------------------------------------------------------------------

export type ReconcileOutcome =
  | { ok: true; theme: SiteTheme; idMap: ReadonlyMap<string, string>; added: ThemeToken[] }
  | { ok: false; reason: string };

/**
 * Decide the tokens of a validated generation again against the theme as it is now. The
 * server judged them against the theme the request carried; a second tab, a collaborator or
 * the owner may have changed it in the minutes the model took. So, per added token:
 *
 *   - a live token of the same kind and name with the same values now exists: it is reused
 *     (the generation's id maps to it);
 *   - one with other values exists: the whole apply is refused, never overwritten;
 *   - otherwise it is added, under the id the server minted unless that id is taken now.
 *
 * `references` are the ids the generated nodes use that were already in the site's theme at
 * request time: if one has been removed outright since, the apply is refused, because the
 * page would paint nothing there. A tombstone is fine: it is still in the sheet.
 */
export function reconcileGeneratedTokens(
  current: SiteTheme,
  added: readonly ThemeToken[],
  references: ReadonlySet<string>,
  random?: () => number,
): ReconcileOutcome {
  const addedIds = new Set(added.map((t) => t.id));
  for (const id of references) {
    if (addedIds.has(id)) continue;
    if (!findToken(current, id)) {
      return { ok: false, reason: 'A colour or font this page uses was removed from the site while it was being written. Generate it again.' };
    }
  }
  const idMap = new Map<string, string>();
  const takenIds = new Set(current.tokens.map((t) => t.id));
  let working = current;
  const kept: ThemeToken[] = [];
  for (const token of added) {
    const same = liveTokens(working).find((t) => t.kind === token.kind && t.name.toLowerCase() === token.name.toLowerCase());
    if (same) {
      const identical =
        token.kind === 'color' && same.kind === 'color'
          ? same.light === token.light && (same.dark ?? null) === (token.dark ?? null)
          : token.kind === 'font' && same.kind === 'font' && same.family === token.family;
      if (!identical) {
        return {
          ok: false,
          reason: `The site now has a ${KIND_WORD[token.kind]} called "${plainName(same.name)}" with other values than the one this page was written with. Nothing was changed; generate it again.`,
        };
      }
      idMap.set(token.id, same.id);
      continue;
    }
    const id = takenIds.has(token.id) ? mintFreeId(takenIds, random) : token.id;
    takenIds.add(id);
    idMap.set(token.id, id);
    const next = { ...token, id } as ThemeToken;
    kept.push(next);
    working = { ...working, tokens: [...working.tokens, next] };
  }
  const errors = validateThemeWrite(normalizeTheme(working), current);
  if (errors.length > 0) return { ok: false, reason: errors[0] };
  return { ok: true, theme: normalizeTheme(working), idMap, added: kept };
}

function mintFreeId(taken: ReadonlySet<string>, random: () => number = Math.random): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    let id = '';
    for (let i = 0; i < 8; i += 1) id += alphabet[Math.floor(random() * alphabet.length) % alphabet.length];
    if (!taken.has(id)) return id;
  }
  throw new Error('[theme] could not mint an unused token id');
}

/**
 * `value` with every reference to a remapped id pointing at its new id, at any depth, in one
 * pass (so an id mapped to another id that is itself mapped is not followed twice).
 */
export function remapGeneratedIds<T>(value: T, idMap: ReadonlyMap<string, string>): T {
  if ([...idMap].every(([from, to]) => from === to)) return value;
  const walk = (item: unknown): unknown => {
    if (typeof item === 'string') {
      if (!item.includes('--fc-t-')) return item;
      return item.replace(ID_REFERENCE, (whole, id: string) => {
        const to = idMap.get(id);
        return to === undefined ? whole : `var(--fc-t-${to})`;
      });
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') {
      const next: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(item as Record<string, unknown>)) {
        Object.defineProperty(next, key, { value: walk(v), enumerable: true, writable: true, configurable: true });
      }
      return next;
    }
    return item;
  };
  return walk(value) as T;
}

/** Every token id a value refers to (a snapshot, a list of nodes), through the theme's own scan. */
export function referencedIds(value: unknown): Set<string> {
  return new Set(tokenUsage(value).keys());
}

/** True when `family` is something a font token may hold (re-exported so callers need one import). */
export { isThemeFontFamily };
