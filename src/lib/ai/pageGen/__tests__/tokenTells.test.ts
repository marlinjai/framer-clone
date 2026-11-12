// The tells screen on a page built from tokens (../tokenTells.ts): references are resolved per
// scheme the site can show before the colour tells read them, and a text and surface pair that
// reads badly in one scheme is a finding. The tree that is applied keeps its references.

import { describe, expect, it } from 'vitest';
import { autoFixTells, detectTells, type TellNode, type TellTree } from '../tells';
import { detectTokenTells, mergedTheme, resolvedViews } from '../tokenTells';
import type { SiteTheme } from '@/lib/site/theme';

const ref = (id: string) => `var(--fc-t-${id})`;
const PAPER = 'aaaaaaaa'; // white in light, near black in dark
const INK = 'bbbbbbbb'; // near black in light, white in dark
const MUTED = 'cccccccc'; // mid grey in light, the same grey in dark
const VIOLET = 'dddddddd';
const NIGHT = 'eeeeeeee';

function theme(mode: SiteTheme['mode'] = 'system'): SiteTheme {
  return {
    ...(mode ? { mode } : {}),
    tokens: [
      { id: PAPER, name: 'Paper', kind: 'color', light: '#ffffff', dark: '#0a0a0a' },
      { id: INK, name: 'Ink', kind: 'color', light: '#0a0a0a', dark: '#ffffff' },
      { id: MUTED, name: 'Muted', kind: 'color', light: '#777777' },
      { id: VIOLET, name: 'Violet', kind: 'color', light: '#7c3aed' },
      { id: NIGHT, name: 'Night', kind: 'color', light: '#050505' },
    ],
    document: {},
  };
}

function node(label: string, style: Record<string, unknown>, children: TellNode[] = [], text?: string): TellNode {
  return { id: label.toLowerCase(), type: text ? 'p' : 'div', label, props: { style, ...(text ? { children: text } : {}) }, children };
}
const tree = (...nodes: TellNode[]): TellTree => ({ nodes });

describe('detectTokenTells', () => {
  it('stays quiet on a pair that reads in every scheme the site can show', () => {
    const page = tree(node('Hero', { backgroundColor: ref(PAPER) }, [node('Copy', { color: ref(INK) }, [], 'Fresh bread')]));
    expect(detectTokenTells(page, theme(), ['desktop'])).toEqual([]);
  });

  it('fires on a pair that fails, with the ratio and the scheme in the message', () => {
    const page = tree(node('Hero', { backgroundColor: ref(PAPER) }, [node('Copy', { color: ref(PAPER) }, [], 'Fresh bread')]));
    const found = detectTokenTells(page, theme('light'), ['desktop']);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ tell: 'low-contrast', path: 'Hero > Copy', autoFixable: false });
    expect(found[0].detail).toMatch(/1\.0:1 against its background in light mode, and needs 4\.5:1/);
  });

  it('finds a pair that passes in light and fails in dark, and says dark', () => {
    // Dim is dark on white in light (passes) and a dark grey on near black in dark (fails).
    const dim = { ...theme('system'), tokens: [...theme('system').tokens, { id: 'dimdimdi', name: 'Dim', kind: 'color' as const, light: '#111111', dark: '#222222' }] };
    const page = tree(node('Hero', { backgroundColor: ref(PAPER) }, [node('Copy', { color: ref('dimdimdi') }, [], 'Fresh bread')]));
    const found = detectTokenTells(page, dim, ['desktop']);
    expect(found).toHaveLength(1);
    expect(found[0].detail).toContain('dark mode');
    // Fixed to light, the same page is fine: only the schemes the site can show are judged.
    expect(detectTokenTells(page, { ...dim, mode: 'light' }, ['desktop'])).toEqual([]);
    expect(detectTokenTells(page, { ...dim, mode: 'dark' }, ['desktop'])).toHaveLength(1);
    // And with no choice made the dark values are not emitted at all.
    const unchosen: SiteTheme = { tokens: dim.tokens, document: dim.document };
    expect(detectTokenTells(page, unchosen, ['desktop'])).toEqual([]);
  });

  it('a dark value that differs decides the dark verdict: ink on paper flips together, so it passes in both', () => {
    const page = tree(node('Hero', { backgroundColor: ref(PAPER), color: ref(INK) }, [], 'Fresh bread'));
    expect(detectTokenTells(page, theme('system'), ['desktop'])).toEqual([]);
  });

  it('uses the nearest surface above a node that sets none, and a literal surface beside a token text', () => {
    const page = tree(node('Hero', { backgroundColor: '#ffffff' }, [node('Inner', {}, [node('Copy', { color: ref(PAPER) }, [], 'Fresh bread')])]));
    expect(detectTokenTells(page, theme('light'), ['desktop']).map((f) => f.path)).toEqual(['Hero > Inner > Copy']);
  });

  it('is silent when neither colour came from a token (the existing screen owns literals)', () => {
    const page = tree(node('Hero', { backgroundColor: '#ffffff', color: '#ffffff' }, [], 'Hi'));
    expect(detectTokenTells(page, theme(), ['desktop'])).toEqual([]);
  });

  it('is silent over a photo or a gradient, whose surface is not one colour', () => {
    const page = tree(node('Hero', { backgroundColor: ref(PAPER), backgroundImage: 'linear-gradient(rgba(0,0,0,.5), rgba(0,0,0,.5))' }, [node('Copy', { color: ref(PAPER) }, [], 'Hi')]));
    expect(detectTokenTells(page, theme('light'), ['desktop'])).toEqual([]);
  });

  it('asks for 3:1 from large text and 4.5:1 from small', () => {
    const grey = { ...theme('light'), tokens: [...theme('light').tokens, { id: 'ffffffff', name: 'Grey', kind: 'color' as const, light: '#8a8a8a' }] };
    const small = tree(node('Hero', { backgroundColor: '#ffffff' }, [node('Copy', { color: ref('ffffffff'), fontSize: '16px' }, [], 'x')]));
    const large = tree(node('Hero', { backgroundColor: '#ffffff' }, [node('Copy', { color: ref('ffffffff'), fontSize: '32px' }, [], 'x')]));
    expect(detectTokenTells(small, grey, ['desktop'])).toHaveLength(1);
    expect(detectTokenTells(large, grey, ['desktop'])).toEqual([]);
  });

  it('reads every breakpoint: a mobile-only override that breaks the pair is found', () => {
    const page = tree(node('Hero', { backgroundColor: ref(PAPER) }, [node('Copy', { color: { desktop: ref(INK), mobile: ref(PAPER) } }, [], 'x')]));
    const found = detectTokenTells(page, theme('light'), ['desktop', 'mobile']);
    expect(found).toHaveLength(1);
    expect(found[0].detail).toContain('mobile breakpoint');
    expect(detectTokenTells(page, theme('light'), ['desktop'])).toEqual([]);
  });

  it('a mobile-only colour is not borrowed for desktop: the ancestor colour applies there', () => {
    const page = tree(node('Hero', { backgroundColor: ref(PAPER), color: ref(INK) }, [node('Copy', { color: { mobile: ref(PAPER) } }, [], 'x')]));
    expect(detectTokenTells(page, theme('light'), ['desktop'])).toEqual([]);
  });

  it('reads the background shorthand', () => {
    const page = tree(node('Hero', { background: ref(PAPER) }, [node('Copy', { color: ref(PAPER) }, [], 'x')]));
    expect(detectTokenTells(page, theme('light'), ['desktop'])).toHaveLength(1);
    const photo = tree(node('Hero', { background: ref(PAPER) }, [node('Photo', { background: 'url(a.jpg) center', }, [node('Copy', { color: ref(PAPER) }, [], 'x')])]));
    expect(detectTokenTells(photo, theme('light'), ['desktop'])).toEqual([]);
  });

  it('starts from the document defaults: white text on the document surface is found', () => {
    const withDocument = { ...theme('light'), document: { backgroundColor: ref(PAPER) } };
    const page = tree(node('Copy', { color: ref(PAPER) }, [], 'x'));
    expect(detectTokenTells(page, withDocument, ['desktop'])).toHaveLength(1);
  });

  it('a dark rule that sets the text to the background is found in dark mode', () => {
    const copy = node('Copy', { color: ref(INK) }, [], 'x');
    copy.props.rules = [{ id: 'd', selector: '&', at: ['@media (prefers-color-scheme: dark)'], style: { color: ref(PAPER) } }];
    const page = tree(node('Hero', { backgroundColor: ref(PAPER) }, [copy]));
    const dark = { ...theme('system') };
    expect(detectTokenTells(page, dark, ['desktop']).length).toBeGreaterThan(0);
  });

  it('a site with no token reference costs nothing and finds nothing', () => {
    expect(detectTokenTells(tree(node('Hero', { color: '#fff', backgroundColor: '#fff' }, [], 'x')), theme(), ['desktop'])).toEqual([]);
  });
});

describe('resolved views for the existing tells', () => {
  const page = tree(node('Hero', { backgroundColor: ref(NIGHT) }, [node('Accent', { color: ref(VIOLET) }, [], 'Hi')]));

  it('makes a colour tell that is blind to a reference fire on its value', () => {
    expect(detectTells(page).map((f) => f.tell)).not.toContain('purple-on-black');
    const views = resolvedViews(page, theme('light'));
    expect(views).toHaveLength(1);
    expect(views[0].scheme).toBe('light');
    expect(detectTells(views[0].tree).map((f) => f.tell)).toContain('purple-on-black');
  });

  it('builds one view per scheme the site can show, and none when the site fixes one it does not use', () => {
    expect(resolvedViews(page, theme('system')).map((v) => v.scheme)).toEqual(['light', 'dark']);
    expect(resolvedViews(page, theme('dark')).map((v) => v.scheme)).toEqual(['dark']);
    expect(resolvedViews(tree(node('Hero', { color: '#fff' })), theme())).toEqual([]);
  });

  it('keeps ids, labels and paths, so a finding points at the real node', () => {
    const [view] = resolvedViews(page, theme('light'));
    expect(view.tree.nodes[0].id).toBe('hero');
    expect(view.tree.nodes[0].children[0].label).toBe('Accent');
  });

  it('never changes the tree that is applied, and the automatic fixes keep the references', () => {
    const before = JSON.stringify(page);
    resolvedViews(page, theme('light'));
    expect(JSON.stringify(page)).toBe(before);
    const dashed = tree(node('Hero', { color: ref(INK) }, [], 'Fresh bread — daily'));
    const fixed = autoFixTells(dashed);
    expect(JSON.stringify(fixed.tree.nodes[0].props.style)).toContain(ref(INK));
  });
});

describe('mergedTheme', () => {
  it('adds the generation\'s tokens to the site\'s, and leaves the site\'s theme alone', () => {
    const base = theme();
    const merged = mergedTheme(base, [{ id: 'ffffffff', name: 'Sand', kind: 'color', light: '#eee' }]);
    expect(merged.tokens).toHaveLength(base.tokens.length + 1);
    expect(base.tokens).toHaveLength(5);
    expect(mergedTheme(undefined, undefined).tokens).toEqual([]);
  });
});
