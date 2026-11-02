// The theme model (contract docs/plans/2026-11-02-theme-and-head.md, slice T1): the
// colour grammar both ways, reading a stored theme, the emitted sheet on all three
// scopes, resolving references, the reference scan and the pure edits. The browser's
// own reading of the emitted sheet, hostile values included, is test/renderGate/theme.gate.ts.

import { describe, expect, it, vi } from 'vitest';
import { FONT_LIBRARY, SYSTEM_FONT_STACK, fontStack } from '@/lib/fonts/registry';
import {
  EMPTY_THEME,
  THEME_LIMITS,
  TOMBSTONE_CAP_MESSAGE,
  addColorToken,
  addFontToken,
  cleanUpUnused,
  deleteToken,
  exportReferences,
  exportTokenNames,
  mintTokenId,
  normalizeTheme,
  parseColorValue,
  parseTokenReference,
  renameToken,
  resolveTokenRefs,
  schemesInForce,
  setColorValues,
  setDocumentStyle,
  setFontFamily,
  setThemeMode,
  themeCss,
  tokenReference,
  tokenUsage,
  validateThemeWrite,
  type ColorToken,
  type SiteTheme,
  type ThemeToken,
} from '../theme';
import { ACCEPTED_COLORS, REFUSED_COLORS, REVIEW_PROBE_VALUES, REVIEW_REFUSED } from './themeValues';

const FRAUNCES = FONT_LIBRARY.find((f) => f.id === 'fraunces')!;

const ACCEPTED = ACCEPTED_COLORS;
const REFUSED = REFUSED_COLORS;

const color = (id: string, light: string, extra: Partial<ColorToken> = {}): ColorToken => ({
  id, name: id, kind: 'color', light, ...extra,
});

describe('parseColorValue', () => {
  it.each(ACCEPTED)('accepts %s', (value) => {
    expect(parseColorValue(value)).toBe(value.trim());
  });

  it.each(REFUSED)('refuses %s', (_label, value) => {
    expect(parseColorValue(value)).toBeNull();
  });

  it('accepts exactly 64 characters and refuses 65', () => {
    const at = `rgb(${'1'.repeat(55)} 0 0)`;
    expect(at).toHaveLength(64);
    expect(parseColorValue(at)).toBe(at);
    expect(parseColorValue(`rgb(${'1'.repeat(56)} 0 0)`)).toBeNull();
  });
});

describe('references', () => {
  it('is exactly var(--fc-t-<id>), with no spaces and no fallback', () => {
    expect(tokenReference('ab12cd34')).toBe('var(--fc-t-ab12cd34)');
    expect(parseTokenReference('var(--fc-t-ab12cd34)')).toBe('ab12cd34');
    for (const bad of ['var( --fc-t-ab12cd34)', 'var(--fc-t-ab12cd34, red)', 'var(--fc-t-AB12CD34)', 'var(--fc-t-ab12cd3)', ' var(--fc-t-ab12cd34)', 7]) {
      expect(parseTokenReference(bad)).toBeNull();
    }
  });
});

describe('normalizeTheme', () => {
  it('reads anything without throwing, and an absent theme is empty with no mode', () => {
    for (const raw of [undefined, null, 3, 'x', [], { tokens: 'x', document: 4, mode: 'night' }]) {
      expect(normalizeTheme(raw)).toEqual(EMPTY_THEME);
    }
    expect('mode' in normalizeTheme({ mode: 'night' })).toBe(false);
  });

  it('drops only a token whose id fails its pattern, a repeated id, or an unknown kind', () => {
    const theme = normalizeTheme({
      tokens: [
        color('ab12cd34', '#111111'),
        color('AB12CD34', '#222222'),
        color('short', '#333333'),
        { id: 'ab12cd34', name: 'again', kind: 'color', light: '#444444' },
        { id: 'zz99zz99', name: 'gap', kind: 'spacing', value: '4px' },
        'junk',
        { id: 'ff00ff00', name: 'Serif', kind: 'font', family: 'fraunces' },
      ],
    });
    expect(theme.tokens.map((t) => t.id)).toEqual(['ab12cd34', 'ff00ff00']);
    expect(theme.tokens[0]).toEqual(color('ab12cd34', '#111111'));
  });

  it('keeps a value that does not parse as stored text, marked broken', () => {
    const theme = normalizeTheme({ tokens: [color('ab12cd34', 'red;x:y'), color('cd34ef56', '#fff', { dark: 'url(x)' })] });
    expect(theme.tokens[0]).toEqual({ ...color('ab12cd34', 'red;x:y'), broken: true });
    expect(theme.tokens[1]).toEqual({ ...color('cd34ef56', '#fff', { dark: 'url(x)' }), broken: true });
  });

  it('cuts broken text over 256 characters to nothing, and keeps it at 256', () => {
    const at = 'x'.repeat(256);
    expect(normalizeTheme({ tokens: [color('ab12cd34', at)] }).tokens[0]).toMatchObject({ light: at, broken: true });
    expect(normalizeTheme({ tokens: [color('ab12cd34', `${at}y`)] }).tokens[0]).toMatchObject({ light: '', broken: true });
  });

  it('recomputes broken on every read, so a stored flag on a valid value is ignored', () => {
    const theme = normalizeTheme({ tokens: [{ ...color('ab12cd34', '#123456'), broken: true }] });
    expect(theme.tokens[0]).toEqual(color('ab12cd34', '#123456'));
  });

  it('keeps a font token with an unknown family as stored', () => {
    const theme = normalizeTheme({ tokens: [{ id: 'ab12cd34', name: 'Old', kind: 'font', family: 'gone-family' }] });
    expect(theme.tokens[0]).toEqual({ id: 'ab12cd34', name: 'Old', kind: 'font', family: 'gone-family' });
  });

  it('keeps document values only in the exact reference form', () => {
    const theme = normalizeTheme({
      document: { backgroundColor: 'var(--fc-t-ab12cd34)', color: 'red', fontFamily: 'var(--fc-t-ab12cd34, serif)', overflowX: 'hidden' },
    });
    expect(theme.document).toEqual({ backgroundColor: 'var(--fc-t-ab12cd34)' });
  });

  it('does not cut a stored blob over a cap', () => {
    const tokens = Array.from({ length: THEME_LIMITS.liveTokens + 3 }, (_, i) => color(`a${String(i).padStart(7, '0')}`, '#000'));
    expect(normalizeTheme({ tokens }).tokens).toHaveLength(THEME_LIMITS.liveTokens + 3);
  });

  it('is idempotent, so a working copy and a server copy compare equal', () => {
    const raw = {
      mode: 'system',
      tokens: [color('ab12cd34', ' #123456 ', { dark: 'bad;' }), { id: 'ff00ff00', name: '  Serif  ', kind: 'font', family: 'x' }, { ...color('11aa22bb', '#fff'), deleted: true }],
      document: { color: 'var(--fc-t-ab12cd34)' },
    };
    const once = normalizeTheme(raw);
    expect(normalizeTheme(once)).toEqual(once);
    expect(normalizeTheme(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });
});

/** A small site: a text colour with a dark value, a background without, a font, the document block. */
const SITE: SiteTheme = {
  tokens: [
    color('ab12cd34', '#112233', { dark: '#eeddcc', name: 'Ink' }),
    color('11aa22bb', 'oklch(1 0 0)', { name: 'Paper' }),
    { id: 'cd34ef56', name: 'Display', kind: 'font', family: 'fraunces' },
  ],
  document: { backgroundColor: 'var(--fc-t-11aa22bb)', color: 'var(--fc-t-ab12cd34)', fontFamily: 'var(--fc-t-cd34ef56)' },
};
const STACK = fontStack(FRAUNCES);
const FACES = themeCss({ tokens: [SITE.tokens[2]], document: {} }).split(':root')[0];

describe('themeCss, published', () => {
  it('emits nothing for an empty theme with no chosen mode', () => {
    expect(themeCss(EMPTY_THEME)).toBe('');
    expect(themeCss(EMPTY_THEME, { scope: 'surface' })).toBe('');
    expect(themeCss(EMPTY_THEME, { scope: 'export' })).toBe('');
  });

  it('with no chosen mode: light values and no color-scheme', () => {
    expect(themeCss(SITE)).toBe(
      `${FACES}:root{--fc-t-ab12cd34:#112233;--fc-t-11aa22bb:oklch(1 0 0);--fc-t-cd34ef56:${STACK}}` +
        'body{background-color:var(--fc-t-11aa22bb);color:var(--fc-t-ab12cd34);font-family:var(--fc-t-cd34ef56)}',
    );
  });

  it('holds the faces of every font token, from the registry', () => {
    expect(FACES).toContain("@font-face{font-family:'Fraunces'");
    expect(FACES).toContain('/fonts/fraunces/');
  });

  it('light: light values and color-scheme light', () => {
    expect(themeCss({ ...SITE, mode: 'light' })).toContain(`:root{--fc-t-ab12cd34:#112233;--fc-t-11aa22bb:oklch(1 0 0);--fc-t-cd34ef56:${STACK};color-scheme:light}`);
    expect(themeCss({ ...SITE, mode: 'light' })).not.toContain('@media');
  });

  it('dark: the dark value, else the light one, and color-scheme dark', () => {
    expect(themeCss({ ...SITE, mode: 'dark' })).toContain(`:root{--fc-t-ab12cd34:#eeddcc;--fc-t-11aa22bb:oklch(1 0 0);--fc-t-cd34ef56:${STACK};color-scheme:dark}`);
  });

  it('system: light, then the dark values under the media query, and color-scheme light dark', () => {
    const css = themeCss({ ...SITE, mode: 'system' });
    expect(css).toContain(`:root{--fc-t-ab12cd34:#112233;--fc-t-11aa22bb:oklch(1 0 0);--fc-t-cd34ef56:${STACK};color-scheme:light dark}`);
    expect(css).toContain('@media (prefers-color-scheme:dark){:root{--fc-t-ab12cd34:#eeddcc}}');
  });

  it('a chosen mode takes effect with no tokens at all', () => {
    expect(themeCss({ ...EMPTY_THEME, mode: 'dark' })).toBe(':root{color-scheme:dark}');
  });

  it('keeps a tombstone in the sheet with both values, so nothing on a page moves', () => {
    const css = themeCss({ mode: 'system', tokens: [color('ab12cd34', '#111111', { dark: '#222222', deleted: true })], document: {} });
    expect(css).toBe(':root{--fc-t-ab12cd34:#111111;color-scheme:light dark}@media (prefers-color-scheme:dark){:root{--fc-t-ab12cd34:#222222}}');
  });

  it('leaves out a broken colour, and a font with an unknown family emits the system stack', () => {
    const theme = normalizeTheme({
      tokens: [color('ab12cd34', 'red}body{display:none'), { id: 'cd34ef56', name: 'Gone', kind: 'font', family: 'gone' }],
    });
    expect(themeCss(theme)).toBe(`:root{--fc-t-cd34ef56:${SYSTEM_FONT_STACK}}`);
  });

  it('trusts nothing it reads: forged ids, kinds, values and document entries never reach the sheet', () => {
    const forged = {
      mode: 'night',
      tokens: [
        { id: 'x}body{display:none', name: 'a', kind: 'color', light: '#111' },
        { id: 'ab12cd34', name: 'b', kind: 'color', light: 'red;background:url(https://evil.test/x)' },
        { id: 'cd34ef56', name: 'c', kind: 'color', light: '#fff', dark: '</style><script>window.__ran=1</script>' },
        { id: 'ef56ab12', name: 'd', kind: 'font', family: "x;}body{background:url('https://evil.test/f')}" },
        { id: '11aa22bb', name: 'e', kind: 'script', light: '#000' },
        { id: '22bb33cc', name: 'f', kind: 'color', light: '#123456' },
      ],
      document: { backgroundColor: 'red;}html{display:none', color: 'var(--fc-t-22bb33cc)', fontFamily: 'var(--fc-t-ef56ab12)}' },
    } as unknown as SiteTheme;
    const css = themeCss(forged);
    // cd34ef56's dark value is broken, so only that value is left out: its light one stays.
    expect(css).toBe(`:root{--fc-t-cd34ef56:#fff;--fc-t-ef56ab12:${SYSTEM_FONT_STACK};--fc-t-22bb33cc:#123456}body{color:var(--fc-t-22bb33cc)}`);
    expect(themeCss(forged, { scope: 'surface' })).not.toMatch(/evil|script|display:none/);
    expect(themeCss(forged, { scope: 'export' })).not.toMatch(/evil|script|display:none/);
  });

  it('over a cap: emits the first tokens up to it, and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tokens = Array.from({ length: THEME_LIMITS.liveTokens + 2 }, (_, i) => color(`a${String(i).padStart(7, '0')}`, '#000'));
    const dead = Array.from({ length: THEME_LIMITS.tombstones + 1 }, (_, i) => color(`b${String(i).padStart(7, '0')}`, '#fff', { deleted: true }));
    const css = themeCss({ tokens: [...tokens, ...dead], document: {} });
    expect(css.match(/--fc-t-a/g)).toHaveLength(THEME_LIMITS.liveTokens);
    expect(css.match(/--fc-t-b/g)).toHaveLength(THEME_LIMITS.tombstones);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('never writes a character a value could break out with, whatever is stored', () => {
    const values = [...REFUSED.map(([, v]) => v), ...ACCEPTED];
    const theme = normalizeTheme({
      mode: 'system',
      tokens: values.map((v, i) => color(`c${String(i).padStart(7, '0')}`, String(v), { dark: String(v) })),
    });
    const css = themeCss(theme);
    const declarations = css.replace(/@media \(prefers-color-scheme:dark\)\{/, '').split(/[{}]/).filter(Boolean);
    for (const part of declarations) expect(part).not.toMatch(/[<>\\"']|\/\*/);
    expect(css.split('{').length).toBe(css.split('}').length);
    expect(css).not.toMatch(/url\(|evil|<\/style|initial|var\(--fc-t-b\)/i);
  });
});

describe('themeCss, surface', () => {
  it('writes the values on the frame attribute, never on :root', () => {
    const css = themeCss({ ...SITE, mode: 'system' }, { scope: 'surface' });
    expect(css).toBe(
      `[data-fc-theme]{--fc-t-ab12cd34:#112233;--fc-t-11aa22bb:oklch(1 0 0);--fc-t-cd34ef56:${STACK};color-scheme:light}` +
        '[data-fc-theme][data-fc-theme-mode=dark]{--fc-t-ab12cd34:#eeddcc;color-scheme:dark}' +
        '[data-fc-theme=frame]{background-color:var(--fc-t-11aa22bb);color:var(--fc-t-ab12cd34);font-family:var(--fc-t-cd34ef56)}',
    );
    expect(css).not.toContain(':root');
    expect(css).not.toContain('@font-face');
  });

  it('with no chosen mode: no color-scheme and no second mode', () => {
    expect(themeCss(SITE, { scope: 'surface' })).toBe(
      `[data-fc-theme]{--fc-t-ab12cd34:#112233;--fc-t-11aa22bb:oklch(1 0 0);--fc-t-cd34ef56:${STACK}}` +
        '[data-fc-theme=frame]{background-color:var(--fc-t-11aa22bb);color:var(--fc-t-ab12cd34);font-family:var(--fc-t-cd34ef56)}',
    );
  });

  it('a forced mode shows that mode only', () => {
    expect(themeCss({ ...SITE, mode: 'dark' }, { scope: 'surface' })).toMatch(/^\[data-fc-theme\]\{--fc-t-ab12cd34:#eeddcc;.*color-scheme:dark\}\[data-fc-theme=frame\]/);
    expect(themeCss({ ...SITE, mode: 'light' }, { scope: 'surface' })).not.toContain('data-fc-theme-mode');
  });
});

describe('themeCss, export', () => {
  it('writes named variables from the token names, with no html, body, faces or color-scheme', () => {
    const css = themeCss({ ...SITE, mode: 'system' }, { scope: 'export' });
    expect(css).toBe(`:root{--ink:#112233;--paper:oklch(1 0 0);--display:${STACK}}@media (prefers-color-scheme:dark){:root{--ink:#eeddcc}}`);
  });

  it('a name with no usable letter, a reserved slug, or a taken slug uses --token-<id>', () => {
    const theme: SiteTheme = {
      tokens: [
        color('aa000001', '#000', { name: 'Accent Blue' }),
        color('aa000002', '#000', { name: 'accent  blue' }),
        color('aa000003', '#000', { name: 'FC Text' }),
        color('aa000004', '#000', { name: 'U Spin' }),
        color('aa000005', '#000', { name: '123' }),
        color('aa000006', '#000', { name: 'Grün' }),
        color('aa000007', '#000', { name: 'token aa000001' }),
      ],
      document: {},
    };
    expect([...exportTokenNames(theme).values()]).toEqual([
      '--accent-blue', '--token-aa000002', '--token-aa000003', '--token-aa000004', '--token-aa000005', '--grun', '--token-aa000007',
    ]);
  });

  it('rewrites references in exported values to those names', () => {
    const names = exportTokenNames(SITE);
    expect(exportReferences('1px solid var(--fc-t-ab12cd34), var(--fc-t-zzzzzzzz)', names)).toBe('1px solid var(--ink), var(--fc-t-zzzzzzzz)');
  });
});

describe('resolveTokenRefs', () => {
  it('replaces each reference with its value in the scheme asked for', () => {
    const value = 'linear-gradient(var(--fc-t-ab12cd34), var(--fc-t-11aa22bb))';
    expect(resolveTokenRefs(value, SITE, 'light')).toBe('linear-gradient(#112233, oklch(1 0 0))');
    expect(resolveTokenRefs(value, SITE, 'dark')).toBe('linear-gradient(#eeddcc, oklch(1 0 0))');
    expect(resolveTokenRefs('var(--fc-t-cd34ef56)', SITE, 'light')).toBe(STACK);
  });

  it('leaves a missing or broken token as a reference, and resolves a tombstone', () => {
    const theme = normalizeTheme({ tokens: [color('ab12cd34', 'bad;'), color('cd34ef56', '#010203', { deleted: true })] });
    expect(resolveTokenRefs('var(--fc-t-ab12cd34) var(--fc-t-zzzzzzzz) var(--fc-t-cd34ef56)', theme, 'dark')).toBe(
      'var(--fc-t-ab12cd34) var(--fc-t-zzzzzzzz) #010203',
    );
  });

  it('the schemes in force: both with system, else the one shown', () => {
    expect(schemesInForce(undefined)).toEqual(['light']);
    expect(schemesInForce('light')).toEqual(['light']);
    expect(schemesInForce('dark')).toEqual(['dark']);
    expect(schemesInForce('system')).toEqual(['light', 'dark']);
  });
});

describe('tokenUsage', () => {
  it('finds a reference wherever a string holds one, and counts each use', () => {
    const snapshot = {
      pages: {
        a: { appComponentTree: { props: { style: { color: { base: 'var(--fc-t-ab12cd34)', tablet: '#222' } }, rules: [{ body: { boxShadow: '0 0 1px var(--fc-t-ab12cd34)' } }] } } },
      },
      components: { d: { inputs: [{ default: 'var(--fc-t-cd34ef56)' }], keyframes: '@keyframes u-a{to{color:var(--fc-t-ab12cd34)}}' } },
    };
    expect(Object.fromEntries(tokenUsage(snapshot))).toEqual({ ab12cd34: 3, cd34ef56: 1 });
  });

  it('counts a token used only as the page background', () => {
    const usage = tokenUsage({ siteSettings: { theme: SITE } });
    expect(usage.get('11aa22bb')).toBe(1);
  });

  it('survives a shared or cyclic object', () => {
    const shared: Record<string, unknown> = { v: 'var(--fc-t-ab12cd34)' };
    shared.self = shared;
    expect(tokenUsage({ a: shared, b: shared }).get('ab12cd34')).toBe(1);
  });
});

describe('edits', () => {
  const seq = (...values: number[]) => {
    let i = 0;
    return () => values[i++ % values.length];
  };

  it('add mints a fresh id, never one the theme holds, tombstones included', () => {
    const theme: SiteTheme = { tokens: [color('aaaaaaaa', '#000', { deleted: true })], document: {} };
    // The first draw repeats the tombstone's id, so the next is taken.
    const result = addColorToken(theme, { name: 'Accent', light: '#ff0000' }, seq(0, 0, 0, 0, 0, 0, 0, 0, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99));
    expect(result.ok && result.id).toBe('99999999');
    expect(mintTokenId([], () => 0.5)).toMatch(/^[a-z0-9]{8}$/);
  });

  it('add refuses a taken name ignoring case, a bad value, and a dark value outside the grammar', () => {
    const theme = addColorToken(EMPTY_THEME, { name: 'Accent', light: '#f00' }) as { theme: SiteTheme };
    expect(addColorToken(theme.theme, { name: 'ACCENT', light: '#0f0' })).toMatchObject({ ok: false, error: 'Another colour is already called ACCENT.' });
    expect(addColorToken(theme.theme, { name: 'Other', light: 'red;' }).ok).toBe(false);
    expect(addColorToken(theme.theme, { name: 'Other', light: '#fff', dark: 'initial' }).ok).toBe(false);
    expect(addColorToken(theme.theme, { name: ' ', light: '#fff' }).ok).toBe(false);
    expect(addColorToken(theme.theme, { name: 'x'.repeat(41), light: '#fff' }).ok).toBe(false);
    // The same name of another kind is fine.
    expect(addFontToken(theme.theme, { name: 'Accent', family: 'fraunces' }).ok).toBe(true);
    expect(addFontToken(theme.theme, { name: 'Body', family: 'Comic Sans' }).ok).toBe(false);
  });

  it('rename changes the name and nothing else', () => {
    const result = renameToken(SITE, 'ab12cd34', 'Text');
    if (!result.ok) throw new Error(result.error);
    expect(result.theme.tokens[0]).toEqual({ ...SITE.tokens[0], name: 'Text' });
    expect(result.theme.tokens.slice(1)).toEqual(SITE.tokens.slice(1));
    expect(result.theme.document).toBe(SITE.document);
  });

  it('set values: a dark value can be set and removed, and a bad one is refused', () => {
    const set = setColorValues(SITE, '11aa22bb', { dark: '#000000' });
    expect(set.ok && set.theme.tokens[1]).toEqual(color('11aa22bb', 'oklch(1 0 0)', { name: 'Paper', dark: '#000000' }));
    const cleared = setColorValues(SITE, 'ab12cd34', { dark: null });
    expect(cleared.ok && cleared.theme.tokens[0]).toEqual(color('ab12cd34', '#112233', { name: 'Ink' }));
    expect(setColorValues(SITE, 'ab12cd34', { light: 'url(x)' }).ok).toBe(false);
    expect(setColorValues(SITE, 'cd34ef56', { light: '#fff' }).ok).toBe(false);
    expect(setFontFamily(SITE, 'cd34ef56', 'system').ok).toBe(true);
  });

  it('delete leaves a tombstone with its values, and a deleted name can be taken again by a new id', () => {
    const deleted = deleteToken(SITE, 'ab12cd34');
    if (!deleted.ok) throw new Error(deleted.error);
    expect(deleted.theme.tokens[0]).toEqual({ ...SITE.tokens[0], deleted: true });
    expect(themeCss(deleted.theme)).toBe(themeCss(SITE));
    const again = addColorToken(deleted.theme, { name: 'Ink', light: '#000' });
    expect(again.ok && again.id).not.toBe('ab12cd34');
    expect(deleteToken(deleted.theme, 'ab12cd34').ok).toBe(false);
  });

  it('delete is refused at the tombstone cap, pointing at Detach, Replace and Clean up', () => {
    const dead = Array.from({ length: THEME_LIMITS.tombstones }, (_, i) => color(`b${String(i).padStart(7, '0')}`, '#fff', { deleted: true }));
    const theme: SiteTheme = { tokens: [...dead, color('ab12cd34', '#000')], document: {} };
    const result = deleteToken(theme, 'ab12cd34');
    expect(result).toEqual({ ok: false, error: TOMBSTONE_CAP_MESSAGE });
    expect(TOMBSTONE_CAP_MESSAGE).toMatch(/Detach.*Replace.*Clean up/);
  });

  it('clean up removes only the tombstones nothing uses, and never a live token', () => {
    const theme: SiteTheme = {
      tokens: [color('aa000001', '#000', { deleted: true }), color('aa000002', '#111', { deleted: true }), color('aa000003', '#222')],
      document: { backgroundColor: 'var(--fc-t-aa000002)' },
    };
    const usage = tokenUsage({ pages: {}, siteSettings: { theme } });
    const { theme: next, removed } = cleanUpUnused(theme, usage);
    expect(removed.map((t) => t.id)).toEqual(['aa000001']);
    expect(next.tokens.map((t) => t.id)).toEqual(['aa000002', 'aa000003']);
    expect(cleanUpUnused(next, usage).removed).toEqual([]);
  });

  it('going system, light, system keeps every dark value, and clearing mode returns to not chosen', () => {
    const system = setThemeMode(SITE, 'system');
    const light = setThemeMode(system, 'light');
    const back = setThemeMode(light, 'system');
    expect(back.tokens).toEqual(SITE.tokens);
    expect(themeCss(light)).not.toContain('#eeddcc');
    expect(themeCss(back)).toContain('#eeddcc');
    const cleared = setThemeMode(back, undefined);
    expect('mode' in cleared).toBe(false);
    expect(themeCss(cleared)).toBe(themeCss(SITE));
  });

  it('the document block takes only a live token of the right kind', () => {
    expect(setDocumentStyle(SITE, 'fontFamily', 'var(--fc-t-ab12cd34)').ok).toBe(false);
    expect(setDocumentStyle(SITE, 'color', 'var(--fc-t-zzzzzzzz)').ok).toBe(false);
    expect(setDocumentStyle(SITE, 'color', '#000').ok).toBe(false);
    const cleared = setDocumentStyle(SITE, 'color', undefined);
    expect(cleared.ok && cleared.theme.document).toEqual({ backgroundColor: 'var(--fc-t-11aa22bb)', fontFamily: 'var(--fc-t-cd34ef56)' });
  });
});

describe('validateThemeWrite', () => {
  const ok = (next: SiteTheme, current: SiteTheme = EMPTY_THEME) => validateThemeWrite(normalizeTheme(next), normalizeTheme(current));

  it('accepts the edits above', () => {
    expect(ok(SITE)).toEqual([]);
    expect(ok({ ...SITE, tokens: SITE.tokens.map((t) => ({ ...t, deleted: true as const })) }, SITE)).toEqual([]);
  });

  it('refuses removing a live token outright, but lets a tombstone go', () => {
    expect(ok({ ...SITE, tokens: SITE.tokens.slice(1), document: {} }, SITE)).toEqual([
      'Ink cannot be removed outright: delete it, and Clean up removes it once nothing uses it.',
    ]);
    const withDead: SiteTheme = { tokens: [color('aa000001', '#000', { deleted: true })], document: {} };
    expect(ok(EMPTY_THEME, withDead)).toEqual([]);
  });

  it('refuses a duplicate live name, a changed kind, a new broken value and a bad family', () => {
    const tokens: ThemeToken[] = [color('aa000001', '#000', { name: 'A' }), color('aa000002', '#000', { name: 'a' })];
    expect(ok({ tokens, document: {} })).toContain('Two colours are called A.');
    expect(ok({ tokens: [{ id: 'aa000001', name: 'A', kind: 'font', family: 'fraunces' }], document: {} }, { tokens: [tokens[0]], document: {} })).toEqual([
      'A cannot change from a colour to a font.',
    ]);
    expect(ok({ tokens: [color('aa000001', 'red;', { name: 'A' })], document: {} })[0]).toMatch(/^A: Use a colour/);
    expect(ok({ tokens: [{ id: 'aa000001', name: 'F', kind: 'font', family: 'nope' }], document: {} })[0]).toMatch(/^F: pick a font/);
  });

  it('lets an unchanged broken value stay, so it never blocks another edit', () => {
    const current: SiteTheme = { tokens: [color('aa000001', 'red;', { name: 'Old' })], document: {} };
    const next = addColorToken(normalizeTheme(current), { name: 'New', light: '#000' });
    expect(next.ok && ok(next.theme, current)).toEqual([]);
  });

  it('refuses a document value that is not a live token of its kind, and keeps one that points at a tombstone', () => {
    expect(ok({ ...SITE, document: { color: 'var(--fc-t-cd34ef56)' } })).toHaveLength(1);
    const deleted = { ...SITE, tokens: SITE.tokens.map((t) => (t.id === '11aa22bb' ? { ...t, deleted: true as const } : t)) };
    expect(ok(deleted, SITE)).toEqual([]);
  });

  it('refuses a write over either cap, and lets a stored blob over one shrink', () => {
    const live = (n: number) => Array.from({ length: n }, (_, i) => color(`a${String(i).padStart(7, '0')}`, '#000'));
    expect(ok({ tokens: live(THEME_LIMITS.liveTokens), document: {} })).toEqual([]);
    expect(ok({ tokens: live(THEME_LIMITS.liveTokens + 1), document: {} })).toEqual([`A site holds at most ${THEME_LIMITS.liveTokens} tokens.`]);
    const over = { tokens: live(THEME_LIMITS.liveTokens + 2), document: {} };
    const smaller = { tokens: [...live(THEME_LIMITS.liveTokens + 1), { ...live(THEME_LIMITS.liveTokens + 2)[THEME_LIMITS.liveTokens + 1], deleted: true as const }], document: {} };
    expect(ok(smaller, over)).toEqual([]);
    const dead = (n: number) => Array.from({ length: n }, (_, i) => color(`b${String(i).padStart(7, '0')}`, '#fff', { deleted: true }));
    expect(ok({ tokens: dead(THEME_LIMITS.tombstones + 1), document: {} }, { tokens: dead(THEME_LIMITS.tombstones), document: {} })).toEqual([TOMBSTONE_CAP_MESSAGE]);
  });
});

describe('the T1 code review payloads', () => {
  it.each(REVIEW_REFUSED)('refuses %j, which browsers refuse', (value) => {
    expect(parseColorValue(value)).toBeNull();
  });

  it('accepts far fewer of the review probe values than the 257 the old grammar did', () => {
    // The browser gate proves each one left is a colour in Chromium and WebKit.
    const accepted = REVIEW_PROBE_VALUES.filter((v) => parseColorValue(v) !== null);
    expect(accepted.length).toBeLessThan(257 - 190 + 1);
    expect(accepted).toEqual(expect.arrayContaining(['rgb(.5 .5 .5)', 'oklch(0 0 0 / 50%)', 'color(srgb 1 0 0)', 'color(SRGB 1 0 0)', '#abc', 'RED']));
  });

  it('a stored duplicate name does not block an edit of another token', () => {
    const stored = normalizeTheme({ tokens: [
      color('aaaaaaaa', '#fff', { name: 'Accent' }),
      color('bbbbbbbb', '#000', { name: 'accent' }),
      color('cccccccc', '#111', { name: 'Other' }),
    ], document: {} });
    const renamed = must(renameToken(stored, 'cccccccc', 'Other 2'));
    expect(validateThemeWrite(renamed, stored)).toEqual([]);
    // Taking part in the duplicate still counts: renaming one of them to the other's name, or a third into it.
    expect(renameToken(stored, 'aaaaaaaa', 'ACCENT')).toEqual({ ok: false, error: 'Another colour is already called ACCENT.' });
    const both = { ...stored, tokens: stored.tokens.map((t) => (t.id === 'aaaaaaaa' ? { ...t, name: 'ACCENT' } : t)) };
    expect(validateThemeWrite(both, stored)).toEqual(['Two colours are called ACCENT.']);
    const third = { ...stored, tokens: stored.tokens.map((t) => (t.id === 'cccccccc' ? { ...t, name: 'Accent' } : t)) };
    expect(validateThemeWrite(third, stored)).toEqual(['Two colours are called Accent.']);
  });

  it('reading never cuts a name, so two long names stay two, and the write check enforces the length', () => {
    const long = normalizeTheme({ tokens: [
      color('aaaaaaaa', '#fff', { name: `${'A'.repeat(45)}1` }),
      color('bbbbbbbb', '#000', { name: `${'A'.repeat(45)}2` }),
    ], document: {} });
    expect(long.tokens.map((t) => t.name.length)).toEqual([46, 46]);
    expect(validateThemeWrite(long, long)).toEqual([]);
    const recoloured = must(setColorValues(long, 'aaaaaaaa', { light: '#123456' }));
    expect(validateThemeWrite(recoloured, long)).toEqual([]);
    const renamed = { ...long, tokens: long.tokens.map((t) => (t.id === 'aaaaaaaa' ? { ...t, name: `${'B'.repeat(41)}` } : t)) };
    expect(validateThemeWrite(renamed, long)).toEqual([`${'B'.repeat(40)}...: keep a name to 40 characters.`]);
  });

  it('a rename of a token with a stored broken value is not refused for the value', () => {
    const stored = normalizeTheme({ tokens: [color('aaaaaaaa', 'rgb(1, 2 3)', { name: 'Old' })], document: {} });
    expect(stored.tokens[0]).toMatchObject({ broken: true });
    expect(validateThemeWrite(must(renameToken(stored, 'aaaaaaaa', 'New')), stored)).toEqual([]);
  });

  it('a broken dark value leaves out only that value: the light one shows wherever it would', () => {
    const theme = normalizeTheme({ tokens: [color('aaaaaaaa', '#112233', { dark: 'rgb(1, 2 3)' })], document: {} });
    expect(theme.tokens[0]).toMatchObject({ broken: true });
    expect(themeCss(theme)).toBe(':root{--fc-t-aaaaaaaa:#112233}');
    expect(themeCss(setThemeMode(theme, 'light'))).toBe(':root{--fc-t-aaaaaaaa:#112233;color-scheme:light}');
    expect(themeCss(setThemeMode(theme, 'system'))).toBe(':root{--fc-t-aaaaaaaa:#112233;color-scheme:light dark}');
    expect(themeCss(setThemeMode(theme, 'dark'))).toBe(':root{--fc-t-aaaaaaaa:#112233;color-scheme:dark}');
    expect(resolveTokenRefs('var(--fc-t-aaaaaaaa)', theme, 'dark')).toBe('#112233');
  });

  it('a broken light value with a good dark one shows the dark one where dark shows, and nothing in light', () => {
    const theme = normalizeTheme({ mode: 'system', tokens: [color('aaaaaaaa', 'rgb(1 2)', { dark: '#445566' })], document: {} });
    expect(themeCss(theme)).toBe(':root{color-scheme:light dark}@media (prefers-color-scheme:dark){:root{--fc-t-aaaaaaaa:#445566}}');
    expect(resolveTokenRefs('var(--fc-t-aaaaaaaa)', theme, 'light')).toBe('var(--fc-t-aaaaaaaa)');
  });
});

function must<T extends { ok: boolean }>(result: T): SiteTheme {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return (result as unknown as { theme: SiteTheme }).theme;
}
