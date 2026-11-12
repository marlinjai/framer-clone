// The pure half of the AI's use of the site theme (../generatedTheme.ts): reading a model's
// proposed tokens, adopting them into a theme, judging a style value's references, and
// deciding the tokens again at apply. Plan: docs/plans/2026-11-02-theme-and-head.md, T5.

import { describe, expect, it } from 'vitest';
import {
  adoptProposedTokens,
  judgeReferences,
  parseProposedTokens,
  reconcileGeneratedTokens,
  remapGeneratedIds,
  scanReferences,
  withLocalIds,
  MAX_GENERATED_TOKENS,
  type ReferenceContext,
} from '../generatedTheme';
import { EMPTY_THEME, type SiteTheme } from '@/lib/site/theme';

const ACCENT = 'ab12cd34';
const DISPLAY = 'ef56gh78';
const GONE = 'zz99yy88';

const THEME: SiteTheme = {
  mode: 'system',
  tokens: [
    { id: ACCENT, name: 'Accent', kind: 'color', light: '#b4532a', dark: '#e07a4f' },
    { id: DISPLAY, name: 'Display', kind: 'font', family: 'system' },
    { id: GONE, name: 'Old', kind: 'color', light: '#111111', deleted: true },
  ],
  document: {},
};

const ref = (id: string) => `var(--fc-t-${id})`;
const context = (over: Partial<ReferenceContext> = {}): ReferenceContext => ({
  theme: THEME,
  held: new Set(),
  idByRef: new Map(),
  strict: true,
  ...over,
});

describe('parseProposedTokens', () => {
  it('reads a colour and a font', () => {
    const out = parseProposedTokens({
      tokens: [
        { ref: 'new-1', name: ' Sand ', kind: 'color', light: '#eee', dark: '#222' },
        { ref: 'new-2', name: 'Body', kind: 'font', family: 'system' },
      ],
    });
    expect(out).toEqual({
      ok: true,
      tokens: [
        { ref: 'new-1', name: 'Sand', kind: 'color', light: '#eee', dark: '#222' },
        { ref: 'new-2', name: 'Body', kind: 'font', family: 'system' },
      ],
    });
  });

  it('accepts no tokens at all', () => {
    expect(parseProposedTokens({})).toEqual({ ok: true, tokens: [] });
    expect(parseProposedTokens({ tokens: [] })).toEqual({ ok: true, tokens: [] });
  });

  it.each([
    ['not an object', 'x'],
    ['a list', []],
    ['a mode', { mode: 'dark', tokens: [] }],
    ['a document block', { document: {}, tokens: [] }],
    ['tokens that are not a list', { tokens: {} }],
  ])('refuses %s', (_label, raw) => {
    expect(parseProposedTokens(raw).ok).toBe(false);
  });

  it(`refuses more than ${MAX_GENERATED_TOKENS} tokens and says so`, () => {
    const tokens = Array.from({ length: MAX_GENERATED_TOKENS + 1 }, (_, i) => ({ ref: `new-${i + 1}`, name: `T${i}`, kind: 'color', light: '#fff' }));
    const out = parseProposedTokens({ tokens });
    expect(out).toMatchObject({ ok: false });
    expect(JSON.stringify(out)).toContain('at most 12');
  });

  it.each([
    ['an id instead of a local name', { ref: 'ab12cd34', name: 'A', kind: 'color', light: '#fff' }],
    ['a local name with no number', { ref: 'new-', name: 'A', kind: 'color', light: '#fff' }],
    ['a local name with a leading zero', { ref: 'new-01', name: 'A', kind: 'color', light: '#fff' }],
    ['a name that is blank', { ref: 'new-1', name: '  ', kind: 'color', light: '#fff' }],
    ['a kind that is neither', { ref: 'new-1', name: 'A', kind: 'size', light: '1px' }],
    ['a colour with no light value', { ref: 'new-1', name: 'A', kind: 'color' }],
    ['a colour with a family', { ref: 'new-1', name: 'A', kind: 'color', light: '#fff', family: 'system' }],
    ['a font with no family', { ref: 'new-1', name: 'A', kind: 'font' }],
    ['a font with a colour value', { ref: 'new-1', name: 'A', kind: 'font', family: 'system', light: '#fff' }],
    ['a field it does not hold', { ref: 'new-1', name: 'A', kind: 'color', light: '#fff', id: 'ab12cd34' }],
    ['a value that is not text', { ref: 'new-1', name: 'A', kind: 'color', light: 4 }],
  ])('refuses %s', (_label, token) => {
    expect(parseProposedTokens({ tokens: [token] }).ok).toBe(false);
  });

  it('refuses a local name used twice', () => {
    const out = parseProposedTokens({ tokens: [
      { ref: 'new-1', name: 'A', kind: 'color', light: '#fff' },
      { ref: 'new-1', name: 'B', kind: 'color', light: '#000' },
    ] });
    expect(out.ok).toBe(false);
  });
});

describe('adoptProposedTokens', () => {
  const proposed = (over: Record<string, unknown> = {}) => ({ ref: 'new-1', name: 'Sand', kind: 'color' as const, light: '#eee', ...over });

  it('adds a token through the theme grammar, minting an id the model never chose', () => {
    const out = adoptProposedTokens(EMPTY_THEME, [proposed()], () => 0.5);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const id = out.idByRef.get('new-1')!;
    expect(id).toMatch(/^[a-z0-9]{8}$/);
    expect(out.added).toEqual([{ id, name: 'Sand', kind: 'color', light: '#eee' }]);
    expect(out.theme.tokens).toHaveLength(1);
  });

  it('refuses a value outside the colour grammar, naming the token', () => {
    const out = adoptProposedTokens(EMPTY_THEME, [proposed({ light: 'url(https://evil.example/x)' })]);
    expect(out).toMatchObject({ ok: false });
    if (!out.ok) expect(out.errors[0]).toContain('Sand');
  });

  it('refuses an unknown font family', () => {
    const out = adoptProposedTokens(EMPTY_THEME, [{ ref: 'new-1', name: 'Body', kind: 'font', family: 'comic-sans' }]);
    expect(out.ok).toBe(false);
  });

  it('reuses a token of the same name, kind and values, whatever the case of the name', () => {
    const out = adoptProposedTokens(THEME, [proposed({ name: 'accent', light: '#b4532a', dark: '#e07a4f' })]);
    expect(out).toMatchObject({ ok: true, added: [] });
    if (out.ok) expect(out.idByRef.get('new-1')).toBe(ACCENT);
  });

  it('refuses a name the site holds with other values, pointing at the existing token', () => {
    const out = adoptProposedTokens(THEME, [proposed({ name: 'Accent', light: '#000000' })]);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.errors[0]).toContain(ref(ACCENT));
      expect(out.errors[0]).toMatch(/never changes an existing token/);
    }
  });

  it('treats a missing dark value as different from a stored one', () => {
    const out = adoptProposedTokens(THEME, [proposed({ name: 'Accent', light: '#b4532a' })]);
    expect(out.ok).toBe(false);
  });

  it('refuses a font whose name is taken by another family', () => {
    const out = adoptProposedTokens(
      { ...THEME, tokens: [{ id: DISPLAY, name: 'Display', kind: 'font', family: 'inter' }] },
      [{ ref: 'new-1', name: 'Display', kind: 'font', family: 'system' }],
    );
    expect(out.ok).toBe(false);
  });

  it('a name only a deleted token holds is free, as in the panel', () => {
    const out = adoptProposedTokens(THEME, [proposed({ name: 'Old', light: '#222222' })]);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.added).toHaveLength(1);
  });

  it('two proposals under one name with the same values share a token, with different values refuse', () => {
    const same = adoptProposedTokens(EMPTY_THEME, [proposed(), proposed({ ref: 'new-2' })]);
    expect(same.ok).toBe(true);
    if (same.ok) {
      expect(same.added).toHaveLength(1);
      expect(same.idByRef.get('new-1')).toBe(same.idByRef.get('new-2'));
    }
    expect(adoptProposedTokens(EMPTY_THEME, [proposed(), proposed({ ref: 'new-2', light: '#000' })]).ok).toBe(false);
  });

  it('never edits the theme it was given', () => {
    const before = JSON.stringify(THEME);
    adoptProposedTokens(THEME, [proposed()]);
    expect(JSON.stringify(THEME)).toBe(before);
  });
});

describe('scanReferences', () => {
  it('finds exact references and local names', () => {
    expect(scanReferences(`1px solid ${ref(ACCENT)}`)).toMatchObject({ ids: [ACCENT], locals: [], malformed: false, whole: false });
    expect(scanReferences('var(--fc-t-new-3)')).toMatchObject({ ids: [], locals: ['new-3'], whole: true });
    expect(scanReferences(ref(ACCENT))).toMatchObject({ whole: true });
  });

  it.each([
    'var(--fc-t-ab12cd34, red)',
    'var( --fc-t-ab12cd34)',
    'var(--fc-t-ab12cd34 )',
    'var(--FC-T-ab12cd34)',
    'VAR(--fc-t-ab12cd34)x',
    'var(--fc-t-AB12CD34)',
    'var(--fc-t-ab12cd3)',
    'var(--fc-t-ab12cd345)',
    'var(--fc-t-new-0)',
    'var(--fc-t-new-100)',
    'calc(var(--fc-t-ab12cd34 + 1))',
    '--fc-t-ab12cd34',
  ])('flags %s as malformed', (value) => {
    expect(scanReferences(value).malformed).toBe(true);
  });

  it('leaves the platform variables that are no token alone', () => {
    expect(scanReferences('var(--fc-sticky-cta-h)').malformed).toBe(false);
  });
});

describe('judgeReferences', () => {
  it('passes a value that names no token untouched', () => {
    expect(judgeReferences('color', '#111', context())).toEqual({ value: '#111', used: [] });
    expect(judgeReferences('paddingBottom', 'var(--fc-sticky-cta-h)', context())).toEqual({ value: 'var(--fc-sticky-cta-h)', used: [] });
  });

  it('passes a live colour, alone or inside a gradient and a shadow', () => {
    expect(judgeReferences('color', ref(ACCENT), context())).toMatchObject({ used: [ACCENT] });
    expect(judgeReferences('backgroundImage', `linear-gradient(${ref(ACCENT)}, #fff)`, context()).problem).toBeUndefined();
    expect(judgeReferences('boxShadow', `0 4px 12px ${ref(ACCENT)}`, context()).problem).toBeUndefined();
  });

  it('passes a live font only as the whole fontFamily', () => {
    expect(judgeReferences('fontFamily', ref(DISPLAY), context()).problem).toBeUndefined();
    expect(judgeReferences('fontFamily', `${ref(DISPLAY)}, serif`, context()).problem).toMatch(/as the whole value/);
    expect(judgeReferences('color', ref(DISPLAY), context()).problem).toMatch(/is a font/);
    expect(judgeReferences('font', ref(DISPLAY), context()).problem).toMatch(/is a font/);
    expect(judgeReferences('fontFamily', ref(ACCENT), context()).problem).toMatch(/is a colour/);
  });

  it('refuses a token that is not in the site, naming the rule', () => {
    expect(judgeReferences('color', ref('nope1234'), context()).problem).toMatch(/not a token of this site/);
  });

  it('refuses a deleted token, unless the target already held it', () => {
    expect(judgeReferences('color', ref(GONE), context()).problem).toMatch(/was deleted/);
    expect(judgeReferences('color', ref(GONE), context({ held: new Set([GONE]) })).problem).toBeUndefined();
  });

  it('lets a replace echo back an id the target held that the theme never had', () => {
    expect(judgeReferences('color', ref('nope1234'), context({ held: new Set(['nope1234']) })).problem).toBeUndefined();
  });

  it('refuses an undeclared local name and rewrites a declared one', () => {
    expect(judgeReferences('color', 'var(--fc-t-new-1)', context()).problem).toMatch(/new-1 is not declared/);
    const adopted = context({ theme: { ...THEME, tokens: [...THEME.tokens, { id: 'qq11ww22', name: 'Sand', kind: 'color', light: '#eee' }] }, idByRef: new Map([['new-1', 'qq11ww22']]) });
    expect(judgeReferences('color', 'var(--fc-t-new-1)', adopted)).toEqual({ value: ref('qq11ww22'), used: ['qq11ww22'] });
  });

  it('refuses every malformed spelling', () => {
    for (const value of ['var(--fc-t-ab12cd34, red)', 'var( --fc-t-ab12cd34)', 'var(--FC-T-ab12cd34)']) {
      expect(judgeReferences('color', value, context()).problem).toMatch(/exactly/);
    }
  });
});

describe('withLocalIds', () => {
  it('rewrites only declared local names', () => {
    const map = new Map([['new-1', 'qq11ww22']]);
    expect(withLocalIds('a var(--fc-t-new-1) b var(--fc-t-new-2)', map)).toBe('a var(--fc-t-qq11ww22) b var(--fc-t-new-2)');
  });
});

describe('reconcileGeneratedTokens, at apply', () => {
  const sand = { id: 'qq11ww22', name: 'Sand', kind: 'color' as const, light: '#eee' };

  it('adds the token under the id the server minted', () => {
    const out = reconcileGeneratedTokens(THEME, [sand], new Set([ACCENT, sand.id]));
    expect(out).toMatchObject({ ok: true });
    if (out.ok) {
      expect(out.added).toEqual([sand]);
      expect(out.theme.tokens.map((t) => t.id)).toContain('qq11ww22');
      expect(out.idMap.get('qq11ww22')).toBe('qq11ww22');
    }
  });

  it('mints another id when the server\'s is taken by now', () => {
    const taken = { ...THEME, tokens: [...THEME.tokens, { id: 'qq11ww22', name: 'Other', kind: 'color' as const, light: '#000' }] };
    const out = reconcileGeneratedTokens(taken, [sand], new Set(), () => 0.1);
    expect(out.ok).toBe(true);
    if (out.ok) {
      const id = out.idMap.get('qq11ww22')!;
      expect(id).not.toBe('qq11ww22');
      expect(out.theme.tokens.find((t) => t.id === id)).toMatchObject({ name: 'Sand', light: '#eee' });
    }
  });

  it('reuses a token the site grew meanwhile with the same values', () => {
    const grown = { ...THEME, tokens: [...THEME.tokens, { id: 'mm44nn55', name: 'sand', kind: 'color' as const, light: '#eee' }] };
    const out = reconcileGeneratedTokens(grown, [sand], new Set());
    expect(out).toMatchObject({ ok: true, added: [] });
    if (out.ok) expect(out.idMap.get('qq11ww22')).toBe('mm44nn55');
  });

  it('refuses, changing nothing, when the name now holds other values', () => {
    const grown = { ...THEME, tokens: [...THEME.tokens, { id: 'mm44nn55', name: 'Sand', kind: 'color' as const, light: '#999' }] };
    const out = reconcileGeneratedTokens(grown, [sand], new Set());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/Sand/);
  });

  it('refuses when a token the page uses was removed from the site meanwhile', () => {
    const out = reconcileGeneratedTokens({ ...THEME, tokens: THEME.tokens.filter((t) => t.id !== ACCENT) }, [], new Set([ACCENT]));
    expect(out.ok).toBe(false);
  });

  it('accepts a tombstone: it is still in the sheet', () => {
    expect(reconcileGeneratedTokens(THEME, [], new Set([GONE])).ok).toBe(true);
  });

  it('refuses the whole write when the site is at its cap', () => {
    const tokens = Array.from({ length: 200 }, (_, i) => ({ id: `t${String(i).padStart(7, '0')}`, name: `T${i}`, kind: 'color' as const, light: '#fff' }));
    const out = reconcileGeneratedTokens({ ...THEME, tokens }, [sand], new Set());
    expect(out.ok).toBe(false);
  });
});

describe('remapGeneratedIds', () => {
  it('rewrites at any depth and in one pass, so a chain of ids is not followed', () => {
    const value = { a: [`1px solid ${ref('aaaaaaaa')}`], b: { c: ref('bbbbbbbb') } };
    const out = remapGeneratedIds(value, new Map([['aaaaaaaa', 'bbbbbbbb'], ['bbbbbbbb', 'cccccccc']]));
    expect(out).toEqual({ a: [`1px solid ${ref('bbbbbbbb')}`], b: { c: ref('cccccccc') } });
  });

  it('returns the value as it is when nothing moves', () => {
    const value = { a: ref('aaaaaaaa') };
    expect(remapGeneratedIds(value, new Map([['aaaaaaaa', 'aaaaaaaa']]))).toBe(value);
  });
});
