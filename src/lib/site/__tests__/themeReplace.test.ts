// The pure parts of the Theme panel (docs/plans/2026-11-02-theme-and-head.md, slice T4):
// Replace's walk, a reference's state, and what the panel warns about.
import { describe, expect, it } from 'vitest';
import {
  THEME_LIMITS,
  colorPartialProblem,
  colorReadability,
  holdsColorSchemeRule,
  normalizeTheme,
  referenceState,
  themeBoundsErrors,
  tokenUseKinds,
  replaceTokenReferences,
  themeWarnings,
  tokenReference,
  tokenUsage,
  type SiteTheme,
} from '../theme';

const A = tokenReference('aa000001');
const B = tokenReference('bb000002');

const theme = (extra: Partial<SiteTheme> = {}): SiteTheme => ({
  tokens: [
    { id: 'aa000001', name: 'Live', kind: 'color', light: '#111111' },
    { id: 'bb000002', name: 'Gone', kind: 'color', light: '#222222', deleted: true },
    { id: 'cc000003', name: 'Bad', kind: 'color', light: 'url(x)', broken: true },
  ],
  document: {},
  ...extra,
});

describe('replaceTokenReferences', () => {
  it('rewrites every reference the usage count finds, at any depth, and nothing else', () => {
    const value = { style: { color: A, border: `1px solid ${A}`, background: `linear-gradient(${A}, ${A})` }, rules: [{ style: { color: { base: A, tab: '#000' } } }], keep: 'var(--fc-t-aa0000011)' };
    const next = replaceTokenReferences(value, 'aa000001', 'bb000002');
    expect(tokenUsage(next).get('aa000001') ?? 0).toBe(0);
    expect(tokenUsage(next).get('bb000002')).toBe(tokenUsage(value).get('aa000001'));
    expect(next.rules[0].style.color.tab).toBe('#000');
    // `var(--fc-t-aa0000011)` names no token (nine characters), so the count did not find it either.
    expect(next.keep).toBe(value.keep);
  });

  it('returns the very same object when nothing refers to the token', () => {
    const value = { style: { color: B }, list: ['x'] };
    expect(replaceTokenReferences(value, 'aa000001', 'cc000003')).toBe(value);
  });

  it('copies a stored `__proto__` key as data and never as the prototype', () => {
    const value = JSON.parse(`{"__proto__": {"color": "${A}"}, "style": {"color": "${A}"}}`);
    const next = replaceTokenReferences(value, 'aa000001', 'bb000002');
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(next, '__proto__')).toBe(true);
    expect(JSON.stringify(next)).not.toContain('aa000001');
  });
});

describe('referenceState', () => {
  it('names live, deleted, broken and missing', () => {
    expect(referenceState(theme(), 'aa000001')).toBe('live');
    expect(referenceState(theme(), 'bb000002')).toBe('deleted');
    expect(referenceState(theme(), 'cc000003')).toBe('broken');
    expect(referenceState(theme(), 'zz000009')).toBe('missing');
  });

  it('follows what the sheet emits: broken only when no value reads, a partial failure stays live', () => {
    const stored = normalizeTheme({
      tokens: [
        { id: 'dd000001', name: 'Dark bad', kind: 'color', light: '#111111', dark: 'url(x)' },
        { id: 'dd000002', name: 'Light bad', kind: 'color', light: 'url(x)', dark: '#222222' },
        { id: 'dd000003', name: 'Both bad', kind: 'color', light: 'url(x)', dark: 'rgb(1 2)' },
        { id: 'dd000004', name: 'Fine', kind: 'color', light: '#111111', dark: '#222222' },
      ],
    });
    const token = (id: string) => stored.tokens.find((t) => t.id === id)!;
    expect(colorReadability(token('dd000001'))).toBe('dark-unreadable');
    expect(colorReadability(token('dd000002'))).toBe('light-unreadable');
    expect(colorReadability(token('dd000003'))).toBe('unreadable');
    expect(colorReadability(token('dd000004'))).toBe('ok');
    expect(referenceState(stored, 'dd000001')).toBe('live');
    expect(referenceState(stored, 'dd000002')).toBe('live');
    expect(referenceState(stored, 'dd000003')).toBe('broken');
    expect(colorPartialProblem(token('dd000001'))).toMatch(/light value shows in both/);
    expect(colorPartialProblem(token('dd000002'))).toMatch(/shows nothing in light mode and its dark value in dark mode/);
    expect(colorPartialProblem(token('dd000003'))).toBeNull();
    expect(colorPartialProblem(token('dd000004'))).toBeNull();
  });
});

describe('tokenUseKinds', () => {
  it('reads a use under fontFamily as a font, at any depth, and any other use as a colour', () => {
    const ref = tokenReference('zz000009');
    expect([...tokenUseKinds({ style: { fontFamily: { base: ref } } }, 'zz000009')]).toEqual(['font']);
    expect([...tokenUseKinds({ rules: [{ style: { color: ref } }] }, 'zz000009')]).toEqual(['color']);
    expect(tokenUseKinds({ style: { color: ref, fontFamily: ref } }, 'zz000009').size).toBe(2);
    expect(tokenUseKinds({ style: { color: A } }, 'zz000009').size).toBe(0);
  });
});

describe('themeBoundsErrors', () => {
  const colourToken = (i: number, extra: Record<string, unknown> = {}) => ({ id: `t${String(i).padStart(7, '0')}`, name: `C ${i}`, kind: 'color' as const, light: '#000000', ...extra });
  const many = (count: number, extra: Record<string, unknown> = {}) => normalizeTheme({ tokens: Array.from({ length: count }, (_, i) => colourToken(i, extra)) });

  it('refuses a theme that grows past the live or deleted cap', () => {
    expect(themeBoundsErrors(many(THEME_LIMITS.liveTokens + 1), many(0))).toEqual([`A site holds at most ${THEME_LIMITS.liveTokens} tokens.`]);
    expect(themeBoundsErrors(many(THEME_LIMITS.tombstones + 1, { deleted: true }), many(0))[0]).toMatch(/deleted tokens/);
    expect(themeBoundsErrors(many(THEME_LIMITS.liveTokens), many(0))).toEqual([]);
  });

  it('lets a stored count over a cap stay or shrink', () => {
    const over = many(THEME_LIMITS.liveTokens + 5);
    expect(themeBoundsErrors(over, over)).toEqual([]);
    expect(themeBoundsErrors(many(THEME_LIMITS.liveTokens + 2), over)).toEqual([]);
  });

  it('refuses a new or renamed name past the limit, and keeps a stored one', () => {
    const long = 'x'.repeat(THEME_LIMITS.name + 1);
    const withLong = normalizeTheme({ tokens: [colourToken(1, { name: long })] });
    expect(themeBoundsErrors(withLong, many(0))[0]).toMatch(/keep a name to 40 characters/);
    expect(themeBoundsErrors(withLong, normalizeTheme({ tokens: [colourToken(1)] }))).toHaveLength(1);
    expect(themeBoundsErrors(withLong, withLong)).toEqual([]);
    expect(themeBoundsErrors(normalizeTheme({ tokens: [colourToken(1, { name: 'x'.repeat(THEME_LIMITS.name) })] }), many(0))).toEqual([]);
  });

  it('bounds a new or renamed tombstone name too, and keeps a stored one', () => {
    const long = 'x'.repeat(THEME_LIMITS.name + 1);
    const tomb = normalizeTheme({ tokens: [colourToken(1, { name: long, deleted: true })] });
    expect(themeBoundsErrors(tomb, many(0))[0]).toMatch(/keep a name to 40 characters/);
    expect(themeBoundsErrors(tomb, normalizeTheme({ tokens: [colourToken(1, { deleted: true })] }))).toHaveLength(1);
    expect(themeBoundsErrors(tomb, tomb)).toEqual([]);
    // Deleting a live token with a stored long name changes nothing about the name.
    expect(themeBoundsErrors(tomb, normalizeTheme({ tokens: [colourToken(1, { name: long })] }))).toEqual([]);
  });
});

describe('themeWarnings', () => {
  const pages = [{ title: 'Home', rootRules: [{ id: 'r', selector: ':root', style: { colorScheme: 'dark' } }] }];

  it('warns about dark styles while no mode is chosen, and not once one is', () => {
    expect(themeWarnings(theme(), { holdsDarkRules: true, pages: [] })[0]).toMatch(/no mode is chosen/);
    expect(themeWarnings(theme({ mode: 'system', document: { backgroundColor: A } }), { holdsDarkRules: true, pages: [] })).toEqual([]);
  });

  it('warns about a dark or system site with no page background', () => {
    expect(themeWarnings(theme({ mode: 'dark' }), { holdsDarkRules: false, pages: [] })[0]).toMatch(/page background/);
    expect(themeWarnings(theme({ mode: 'system' }), { holdsDarkRules: false, pages: [] })[0]).toMatch(/page background/);
    expect(themeWarnings(theme({ mode: 'light' }), { holdsDarkRules: false, pages: [] })).toEqual([]);
  });

  it('names a page whose own colour scheme disagrees with a forced mode', () => {
    expect(themeWarnings(theme({ mode: 'light' }), { holdsDarkRules: false, pages })).toEqual([expect.stringMatching(/Home sets its own colour scheme/)]);
    expect(themeWarnings(theme({ mode: 'dark', document: { backgroundColor: A } }), { holdsDarkRules: false, pages })).toEqual([]);
    const responsive = [{ title: 'Shop', rootRules: [{ selector: ':root', style: { colorScheme: { base: 'only dark', mob: 'light' } } }] }];
    expect(themeWarnings(theme({ mode: 'dark', document: { backgroundColor: A } }), { holdsDarkRules: false, pages: responsive })).toHaveLength(1);
    expect(themeWarnings(theme({ mode: 'system', document: { backgroundColor: A } }), { holdsDarkRules: false, pages })).toEqual([]);
  });

  it('finds a dark rule anywhere in stored pages', () => {
    expect(holdsColorSchemeRule({ a: [{ rules: [{ at: ['@media (prefers-color-scheme: dark)'] }] }] })).toBe(true);
    expect(holdsColorSchemeRule({ a: [{ rules: [{ at: ['@media (min-width: 1px)'] }] }] })).toBe(false);
  });
});
