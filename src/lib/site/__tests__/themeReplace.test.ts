// The pure parts of the Theme panel (docs/plans/2026-11-02-theme-and-head.md, slice T4):
// Replace's walk, a reference's state, and what the panel warns about.
import { describe, expect, it } from 'vitest';
import {
  holdsColorSchemeRule,
  referenceState,
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
