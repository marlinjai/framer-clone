// Slice T2 of the theme contract (docs/plans/2026-11-02-theme-and-head.md): what the
// published page does with a site's theme, against the real modules. The browser half,
// with the real consent banner in Chromium and WebKit, is
// test/renderGate/themePublished.gate.ts.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import { applyResponsiveStyles } from '@/lib/renderer/server/applyResponsiveStyles';
import { renderPublishedPage } from '@/lib/renderer/server/renderPublishedPage';
import { renderComponentNode } from '@/lib/renderer/server/renderComponentNode';
import { safeInlineStyle } from '@/lib/renderer/blockedNodes';
import { parseCssText, parseRule } from '@/lib/rules/rules';
import { isPlatformVariable, isRootStyleKey } from '@/lib/rules/rootProperties';
import { styleValueProblem, validateGeneration } from '@/lib/ai/pageGen/validate';
import { deriveBreakpointKeys } from '@/lib/ai/pageGen/schema';
import { DEFAULT_LOOK, legibleLook, siteLookFromPages, type SiteLook } from '@/lib/site/notFoundDefault';
import { SiteSheets, themeViewport } from '@/lib/site/siteSheets';
import { themeColorMode, type SiteTheme, type ThemeMode } from '@/lib/site/theme';
import { DefaultNotFound } from '@/components/site/DefaultNotFound';

const BREAKPOINTS = [
  { id: 'desktop', minWidth: 1280 },
  { id: 'mobile', minWidth: 320 },
];

const DARK_RULE = { id: 'dark', selector: '&', at: ['@media (prefers-color-scheme: dark)'], style: { color: 'white', backgroundColor: 'black' } };
const LIGHT_RULE = { id: 'light', selector: '&', at: ['@media (prefers-color-scheme: light)'], style: { outline: '1px solid red' } };
const ROOT_DARK = { id: 'doc', selector: ':root', at: ['@media (prefers-color-scheme: dark)'], style: { colorScheme: 'dark' } };

function page(): ComponentNode {
  return {
    id: 'root',
    type: 'div',
    props: { rules: [ROOT_DARK] as never },
    children: [{ id: 'card', type: 'div', props: { style: { color: 'black' }, rules: [DARK_RULE, LIGHT_RULE] as never } }],
  };
}

const sheet = (mode?: ThemeMode) => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return applyResponsiveStyles(page(), BREAKPOINTS, { colorMode: themeColorMode(mode ? { mode, tokens: [], document: {} } : undefined) }).css;
  } finally {
    warn.mockRestore();
  }
};

describe('a forced mode answers prefers-color-scheme in the page sheet', () => {
  it('drops dark node and document rules under light, and makes light ones unconditional', () => {
    const css = sheet('light');
    expect(css).not.toContain('prefers-color-scheme');
    expect(css).not.toContain('color-scheme:dark');
    expect(css).not.toContain('background-color:black');
    expect(css).toContain('outline:1px solid red');
  });

  it('makes dark rules unconditional under dark, and drops light ones', () => {
    const css = sheet('dark');
    expect(css).not.toContain('prefers-color-scheme');
    expect(css).toContain('color-scheme:dark');
    expect(css).toContain('background-color:black');
    expect(css).not.toContain('outline:1px solid red');
  });

  it('keeps every rule as stored under system and with no choice, byte for byte', () => {
    const before = applyResponsiveStyles(page(), BREAKPOINTS).css;
    expect(before).toContain('@media (prefers-color-scheme: dark)');
    expect(sheet('system')).toBe(before);
    expect(sheet(undefined)).toBe(before);
  });

  it('leaves the invalid not-and query as stored, so it stays as dead as it is', () => {
    const invalid = { id: 'odd', selector: '&', at: ['@media not (prefers-color-scheme: dark) and (min-width: 600px)'], style: { color: 'red' } };
    const root: ComponentNode = { id: 'root', type: 'div', props: { rules: [invalid] as never } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const forced = applyResponsiveStyles(root, BREAKPOINTS, { colorMode: 'light' }).css;
    expect(warn.mock.calls.flat().map(String).join(' ')).toContain('left out');
    warn.mockRestore();
    expect(forced).toBe(applyResponsiveStyles(root, BREAKPOINTS).css);
  });
});

describe('the platform variables are reserved in every reader, by one function', () => {
  const key = '--fc-t-ab12cd34';

  it('is one case-sensitive test on the raw key', () => {
    expect(isPlatformVariable(key)).toBe(true);
    expect(isPlatformVariable('--fc-sticky-cta-h')).toBe(true);
    expect(isPlatformVariable('--FC-t-ab12cd34')).toBe(false);
    expect(isPlatformVariable('--primary')).toBe(false);
    expect(isRootStyleKey(key)).toBe(false);
  });

  it('is refused in a rule, in a keyframe block, in a definition body and on :root', () => {
    expect(parseRule({ id: 'r', selector: '&:hover', style: { [key]: 'red' } }).ok).toBe(false);
    expect(parseRule({ id: 'k', define: '@keyframes u-a', blocks: [{ selector: 'to', style: { [key]: 'red' } }] }).ok).toBe(false);
    expect(parseRule({ id: 'f', define: '@font-palette-values --u-p', style: { [key]: 'red' } }).ok).toBe(false);
    expect(parseRule({ id: 'doc', selector: ':root', style: { [key]: 'red' } }).ok).toBe(false);
    expect(parseCssText(`@keyframes u-a { to { ${key}: red } }`).refused.length).toBe(1);
  });

  it('may still be read by a value, which is how an import aliases a token', () => {
    expect(parseRule({ id: 'r', selector: '&:hover', style: { '--primary': `var(${key})`, color: `var(${key})` } }).ok).toBe(true);
    expect(styleValueProblem('--primary', `var(${key})`)).toBeUndefined();
  });

  it('is refused by the AI validator, a number and an empty value included', () => {
    expect(styleValueProblem(key, 'red')).toMatch(/platform/);
    const breakpoints = deriveBreakpointKeys([{ label: 'Desktop', minWidth: 1280 }]);
    let n = 0;
    const out = validateGeneration(
      { nodes: [{ type: 'div', props: { style: { [key]: 'red', '--fc-x': 4, '--fc-y': ' ', color: 'red' } } }] },
      { breakpoints, newId: () => `id${(n += 1)}` },
    );
    if (!out.ok) throw new Error(out.errors.join('; '));
    expect(out.result.nodes[0].props.style).toEqual({ color: 'red' });
  });

  it('reaches neither the inline style nor the sheet on the published renderer', () => {
    const root: ComponentNode = {
      id: 'root',
      type: 'div',
      props: { style: { [key]: 'red', color: { base: `var(${key})`, mobile: 'blue' } } },
      children: [{ id: 'p', type: 'p', props: { style: { [key]: 'green' }, children: 'x' } }],
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { root: out, css } = applyResponsiveStyles(root, BREAKPOINTS);
    expect(JSON.stringify(warn.mock.calls)).toContain("platform's own custom properties");
    warn.mockRestore();
    const html = renderToStaticMarkup(<>{renderComponentNode(out)}</>);
    expect(`${html}${css}`).not.toMatch(/--fc-t-ab12cd34\s*:/);
    // The reference itself still travels, as a value.
    expect(css).toContain(`var(${key})`);
  });

  it('is dropped by the inline gate both renderers share', () => {
    expect(safeInlineStyle({ [key]: 'red', color: 'blue' })).toEqual({ color: 'blue' });
  });

  it('is never in a key the platform passes write, so only stored data meets the gate', () => {
    // The effects pass writes `--fx-*`; the sticky bar writes its height from a script on html.
    const root: ComponentNode = {
      id: 'root',
      type: 'div',
      props: {},
      children: [{ id: 'bar', type: 'div', props: { 'data-sticky-cta': 'bar', ctaLabel: 'Go', ctaHref: '#x' } as never }],
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    applyResponsiveStyles(root, BREAKPOINTS);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("platform's own");
    warn.mockRestore();
  });
});

// shadcn's own neutral theme, light and dark.
const SHADCN = {
  background: { light: 'oklch(1 0 0)', dark: 'oklch(0.145 0 0)' },
  foreground: { light: 'oklch(0.145 0 0)', dark: 'oklch(0.985 0 0)' },
  primary: { light: 'oklch(0.205 0 0)', dark: 'oklch(0.922 0 0)' },
  primaryForeground: { light: 'oklch(0.985 0 0)', dark: 'oklch(0.205 0 0)' },
};
const ids = { background: 'bg000001', foreground: 'fg000002', primary: 'pr000003', primaryForeground: 'pf000004', font: 'fo000005' };
const ref = (id: string) => `var(--fc-t-${id})`;

function shadcnTheme(mode: ThemeMode | undefined, document: SiteTheme['document'] = {}): SiteTheme {
  return {
    ...(mode ? { mode } : {}),
    tokens: [
      ...(Object.keys(SHADCN) as (keyof typeof SHADCN)[]).map((name) => ({ id: ids[name], name, kind: 'color' as const, ...SHADCN[name] })),
      { id: ids.font, name: 'Display', kind: 'font' as const, family: 'fraunces' },
    ],
    document,
  };
}

const NEUTRAL_TEXT = { color: DEFAULT_LOOK.color, background: DEFAULT_LOOK.background };
const NEUTRAL_BUTTON = { accent: DEFAULT_LOOK.accent, accentText: DEFAULT_LOOK.accentText };

describe("the banner's look, judged through the theme in every scheme the site shows", () => {
  const look = (over: Partial<SiteLook>): SiteLook => ({ ...DEFAULT_LOOK, ...over });

  it('row 1: an ink token on the default white ground goes neutral in system, and the button keeps its tokens', () => {
    const read = legibleLook(
      look({ color: ref(ids.foreground), accent: ref(ids.primary), accentText: ref(ids.primaryForeground) }),
      shadcnTheme('system'),
    );
    expect({ color: read.color, background: read.background }).toEqual(NEUTRAL_TEXT);
    expect({ accent: read.accent, accentText: read.accentText }).toEqual({ accent: ref(ids.primary), accentText: ref(ids.primaryForeground) });
  });

  it('the same ink token reads under light and under no choice, so it stays a reference there', () => {
    for (const mode of ['light', undefined] as const) {
      const read = legibleLook(look({ color: ref(ids.foreground) }), shadcnTheme(mode));
      expect(read.color).toBe(ref(ids.foreground));
      expect(read.background).toBe('rgb(255 255 255 / 1)');
    }
  });

  it('row 2: the document block set to background and foreground keeps both references, so they flip', () => {
    const site = {
      pages: [],
      siteSettings: { theme: shadcnTheme('system', { backgroundColor: ref(ids.background), color: ref(ids.foreground), fontFamily: ref(ids.font) }) },
    } as unknown as Parameters<typeof siteLookFromPages>[0];
    const siteLook = siteLookFromPages(site);
    expect(siteLook).toMatchObject({ color: ref(ids.foreground), background: ref(ids.background), fontFamily: ref(ids.font) });
    const read = legibleLook(siteLook, site.siteSettings!.theme);
    expect({ color: read.color, background: read.background }).toEqual({ color: ref(ids.foreground), background: ref(ids.background) });
    // The font token reads as the registry stack it stands for.
    expect(read.fontFamily).toMatch(/^'Fraunces', /);
  });

  it('row 3: a literal white on the dark primary fails in dark, so the button goes neutral as literals', () => {
    const read = legibleLook(
      look({ color: ref(ids.foreground), background: ref(ids.background), accent: ref(ids.primary), accentText: '#ffffff' }),
      shadcnTheme('system'),
    );
    expect({ accent: read.accent, accentText: read.accentText }).toEqual(NEUTRAL_BUTTON);
    expect({ color: read.color, background: read.background }).toEqual({ color: ref(ids.foreground), background: ref(ids.background) });
  });

  it('forced dark judges the dark values only', () => {
    const read = legibleLook(look({ color: ref(ids.foreground), background: ref(ids.background) }), shadcnTheme('dark'));
    expect(read.color).toBe(ref(ids.foreground));
  });

  it('a missing, broken or deleted-and-read token is judged as the sheet has it', () => {
    const theme = shadcnTheme('system');
    // Missing: no value to judge.
    expect(legibleLook(look({ color: ref('zz000009') }), theme).color).toBe(DEFAULT_LOOK.color);
    // Broken: never emitted, so never judged readable.
    const broken = { ...theme, tokens: [...theme.tokens, { id: 'br000006', name: 'B', kind: 'color' as const, light: 'url(x)', broken: true as const }] };
    expect(legibleLook(look({ color: ref('br000006') }), broken).color).toBe(DEFAULT_LOOK.color);
    // A tombstone stays in the sheet, so it still reads.
    const deleted = { ...theme, tokens: theme.tokens.map((t) => (t.id === ids.foreground ? { ...t, deleted: true as const } : t)) };
    expect(legibleLook(look({ color: ref(ids.foreground) }), { ...deleted, mode: 'light' }).color).toBe(ref(ids.foreground));
  });

  // T2 code review, finding 2: the sheet stops at 200 live tokens, so the 201st is no
  // variable on the page, and the guard must not keep a reference to it.
  it('keeps a reference only when the sheet emits that token, so over the cap the pair goes neutral', () => {
    const tokens = Array.from({ length: 201 }, (_, i) => ({
      id: `t${String(i).padStart(7, '0')}`, name: `c${i}`, kind: 'color' as const, light: i === 200 ? '#ffffff' : '#000000',
    }));
    const over: SiteTheme = { tokens, document: { backgroundColor: 'var(--fc-t-t0000200)' } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const read = legibleLook(look({ color: '#111111', background: 'var(--fc-t-t0000200)' }), over);
    warn.mockRestore();
    expect({ color: read.color, background: read.background }).toEqual(NEUTRAL_TEXT);
    // The 200th is emitted, so a reference to it is kept.
    const within = legibleLook(look({ color: '#ffffff', background: 'var(--fc-t-t0000199)' }), over);
    expect(within.background).toBe('var(--fc-t-t0000199)');
  });

  it('never hands stored text through: a literal side is written from its numbers', () => {
    const read = legibleLook(look({ color: '#000', background: 'white' }), shadcnTheme('system'));
    expect(read).toMatchObject({ color: 'rgb(0 0 0 / 1)', background: 'rgb(255 255 255 / 1)' });
    // A reference that is not exactly the form, such as one with a fallback, is not a reference.
    expect(legibleLook(look({ color: `var(--fc-t-${ids.foreground}, #000)` }), shadcnTheme('light')).color).toBe(DEFAULT_LOOK.color);
  });

  it('the default 404 runs the same guard', () => {
    const html = renderToStaticMarkup(
      <DefaultNotFound siteName="S" language="en" look={look({ color: '#ffffff', background: '#ffffff' })} />,
    );
    expect(html).toContain(`color:${DEFAULT_LOOK.color}`);
    const themed = renderToStaticMarkup(
      <DefaultNotFound siteName="S" language="en" look={look({ color: ref(ids.foreground), background: ref(ids.background) })} theme={shadcnTheme('system')} />,
    );
    expect(themed).toContain(`color:${ref(ids.foreground)}`);
    expect(themed).toContain(`background:${ref(ids.background)}`);
  });
});

describe('the layout: viewport and sheets', () => {
  it('writes nothing for a site with no choice, so its head is as before', () => {
    expect(themeViewport(undefined)).toEqual({});
    expect(themeViewport(shadcnTheme(undefined, { backgroundColor: ref(ids.background) }))).toEqual({});
    expect(renderToStaticMarkup(<SiteSheets />)).not.toContain('data-fc-theme-sheet');
    expect(renderToStaticMarkup(<SiteSheets theme={{ tokens: [], document: {} }} />)).not.toContain('data-fc-theme-sheet');
  });

  it('gives a chosen mode its color-scheme, and theme-color only with a document background', () => {
    expect(themeViewport(shadcnTheme('dark'))).toEqual({ colorScheme: 'dark' });
    expect(themeViewport(shadcnTheme('light', { backgroundColor: ref(ids.background) }))).toEqual({ colorScheme: 'light', themeColor: 'oklch(1 0 0)' });
    expect(themeViewport(shadcnTheme('dark', { backgroundColor: ref(ids.background) }))).toEqual({ colorScheme: 'dark', themeColor: 'oklch(0.145 0 0)' });
    expect(themeViewport(shadcnTheme('system', { backgroundColor: ref(ids.background) }))).toEqual({
      colorScheme: 'light dark',
      themeColor: [
        { media: '(prefers-color-scheme: light)', color: 'oklch(1 0 0)' },
        { media: '(prefers-color-scheme: dark)', color: 'oklch(0.145 0 0)' },
      ],
    });
  });

  it('leaves out a theme-color it cannot read, and one for a missing token', () => {
    const broken = shadcnTheme('light', { backgroundColor: ref('zz000009') });
    expect(themeViewport(broken)).toEqual({ colorScheme: 'light' });
  });

  it('writes the theme sheet right after the base, and with a mode chosen even with no tokens', () => {
    const html = renderToStaticMarkup(<SiteSheets theme={{ mode: 'dark', tokens: [], document: {} }} />);
    expect(html).toMatch(/^<style data-fc-site-base="">[^<]*<\/style><style data-fc-theme-sheet="">:root\{color-scheme:dark\}<\/style>$/);
  });

  it('changes with the mode on the next read, from the theme alone', () => {
    const at = (mode: ThemeMode) => renderToStaticMarkup(<SiteSheets theme={shadcnTheme(mode)} />);
    expect(at('system')).toContain('@media (prefers-color-scheme:dark)');
    expect(at('light')).not.toContain('@media');
    expect(at('dark')).toContain(`--fc-t-${ids.foreground}:oklch(0.985 0 0)`);
  });
});

describe('the page renderer threads the theme', () => {
  const cmsRepo = { listRows: async () => ({ rows: [], total: 0 }), getRow: async () => null } as unknown as CmsReadRepository;

  it('preloads a heading family reached through a font token or the document font', async () => {
    const render = async (root: ComponentNode, theme?: SiteTheme) => {
      const { body } = await renderPublishedPage({ root, pageParams: {}, cmsRepo, breakpoints: BREAKPOINTS, theme });
      return renderToStaticMarkup(<>{body}</>);
    };
    const heading: ComponentNode = { id: 'root', type: 'div', props: {}, children: [{ id: 'h', type: 'h1', props: { style: { fontFamily: ref(ids.font) }, children: 'T' } }] };
    expect(await render(heading)).not.toContain('rel="preload"');
    const withToken = await render(heading, shadcnTheme('system'));
    expect(withToken).toMatch(/rel="preload" href="\/fonts\/fraunces/);
    // The theme sheet declares a token's faces, so the page's own font sheet does not repeat them.
    expect(withToken).not.toContain('data-fc-fonts');
    const plain: ComponentNode = { id: 'root', type: 'div', props: {}, children: [{ id: 'h', type: 'h1', props: { children: 'T' } }] };
    expect(await render(plain, shadcnTheme('system', { fontFamily: ref(ids.font) }))).toMatch(/rel="preload" href="\/fonts\/fraunces/);
  });

  it('passes a forced mode to the sheet', async () => {
    const { body } = await renderPublishedPage({ root: page(), pageParams: {}, cmsRepo, breakpoints: BREAKPOINTS, theme: shadcnTheme('light') });
    const html = renderToStaticMarkup(<>{body}</>);
    expect(html).not.toContain('prefers-color-scheme');
    expect(html).toContain('outline:1px solid red');
  });
});
