// A site's theme on the page a visitor really gets (contract
// docs/plans/2026-11-02-theme-and-head.md, slice T2), in Chromium and WebKit: the
// layout's sheets, the compiled base sheet, the real consent banner through
// renderPublishedPage, under both page bases, every mode (none chosen, light, dark,
// system) and both system settings. What is measured is what the browser computes.
//
//   - tokens reach html, body, a page's text and the banner, with the values the mode
//     says; a forced mode decides a node's dark rule; the invalid `not ... and` query
//     stays dead; a font token loads from the site's own origin; nothing else is asked for;
//   - the banner reads at 4.5 to 1 or better in every case, the contract's table included;
//   - a page's `:root` rule beats the theme on color-scheme, color, background and font;
//   - the default 404 reads a reference;
//   - a stored `--fc-` key, inline, in a rule or in a keyframe block, never repaints a token.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, webkit, type Browser, type BrowserType, type Page } from 'playwright';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import { renderPublishedPage } from '@/lib/renderer/server/renderPublishedPage';
import { DefaultNotFound } from '@/components/site/DefaultNotFound';
import { composite, contrastRatio } from '@/lib/ai/review/layoutAudit';
import { parseColor } from '@/lib/color/cssColor';
import { DEFAULT_LOOK, type SiteLook } from '@/lib/site/notFoundDefault';
import { PAGE_BASES, type PageBase } from '@/lib/site/pageBase';
import type { SiteTheme, ThemeMode } from '@/lib/site/theme';
import { normalizeSiteSettings } from '@/lib/site/siteSettings';
import { FIXTURES } from '../score/corpus/fixtures';
import { BREAKPOINTS, publishedDocument, renderPublished } from '../score/lib/published';

const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];
const ORIGIN = 'https://theme-page.test';
const FONTS = path.resolve(__dirname, '../../public/fonts');
/** One public key for the whole run, so two renders of one page compare byte for byte. */
const INGESTION_KEY = `ap_live_${randomBytes(12).toString('hex')}`;
const cmsRepo = { listRows: async () => ({ rows: [], total: 0 }), getRow: async () => null } as unknown as CmsReadRepository;

const ID = { ink: 'in000001', ground: 'gr000002', accent: 'ac000003', accentInk: 'ai000004', font: 'fo000005' };
const ref = (id: string) => `var(--fc-t-${id})`;
/** Values as a browser computes them, to compare with. */
const VALUES = {
  ink: { light: 'rgb(31, 41, 55)', dark: 'rgb(249, 250, 251)' },
  ground: { light: 'rgb(255, 255, 255)', dark: 'rgb(17, 24, 39)' },
  accent: { light: 'rgb(29, 78, 216)', dark: 'rgb(147, 197, 253)' },
  accentInk: { light: 'rgb(255, 255, 255)', dark: 'rgb(11, 16, 32)' },
};
const DARK_RULE_COLOR = 'rgb(1, 2, 3)';
const ODD_RULE_COLOR = 'rgb(4, 5, 6)';

function siteTheme(mode: ThemeMode | undefined, document: SiteTheme['document'] = {
  backgroundColor: ref(ID.ground),
  color: ref(ID.ink),
  fontFamily: ref(ID.font),
}): SiteTheme {
  return {
    ...(mode ? { mode } : {}),
    tokens: [
      { id: ID.ink, name: 'Ink', kind: 'color', light: '#1f2937', dark: '#f9fafb' },
      { id: ID.ground, name: 'Ground', kind: 'color', light: '#ffffff', dark: '#111827' },
      { id: ID.accent, name: 'Accent', kind: 'color', light: '#1d4ed8', dark: '#93c5fd' },
      { id: ID.accentInk, name: 'Accent ink', kind: 'color', light: '#ffffff', dark: '#0b1020' },
      { id: ID.font, name: 'Display', kind: 'font', family: 'fraunces' },
    ],
    document,
  };
}

/** The look the site's pages give the banner: the document block, then its first filled button. */
const LOOK: SiteLook = { fontFamily: ref(ID.font), color: ref(ID.ink), background: ref(ID.ground), accent: ref(ID.accent), accentText: ref(ID.accentInk) };

function tree(rootRules: unknown[] = [], extra: ComponentNode[] = []): ComponentNode {
  return {
    id: 'root',
    type: 'div',
    props: { rules: rootRules as never },
    children: [
      { id: 'copy', type: 'p', props: { id: 'copy', children: 'Plain text that inherits everything' } },
      {
        id: 'card',
        type: 'div',
        props: {
          id: 'card',
          children: 'Card',
          style: { color: ref(ID.ink) },
          // The theme-dark-rule fixture: a node with a dark media rule.
          rules: [{ id: 'dark', selector: '&', at: ['@media (prefers-color-scheme: dark)'], style: { color: DARK_RULE_COLOR } }] as never,
        },
      },
      {
        id: 'odd',
        type: 'div',
        props: {
          id: 'odd',
          children: 'Odd',
          // Invalid media query syntax: `not all` in every browser, and it must stay so.
          rules: [{ id: 'odd', selector: '&', at: ['@media not (prefers-color-scheme: dark) and (min-width: 1px)'], style: { color: ODD_RULE_COLOR } }] as never,
        },
      },
      { id: 'title', type: 'h1', props: { id: 'title', children: 'Display title', style: { fontFamily: ref(ID.font) } } },
      ...extra,
    ],
  };
}

async function render(root: ComponentNode, theme: SiteTheme | undefined, base: PageBase, look: SiteLook = LOOK): Promise<string> {
  const analytics = { enabled: true, ingestionKey: INGESTION_KEY, ingestionEndpoint: 'https://ingest.test/e', projectId: 'p' };
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const { body } = await renderPublishedPage({ root, pageParams: {}, cmsRepo, breakpoints: BREAKPOINTS, analytics, pageBase: base, theme, consent: { language: 'en', look } });
    return publishedDocument({ html: renderToStaticMarkup(React.createElement(React.Fragment, null, body)), css: '', theme }, base);
  } finally {
    warn.mockRestore();
  }
}

async function open(browser: Browser, html: string, scheme: 'light' | 'dark') {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme });
  const tab = await context.newPage();
  const requests: string[] = [];
  await tab.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.href === `${ORIGIN}/`) return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    requests.push(url.href);
    if (url.origin === ORIGIN && url.pathname.startsWith('/fonts/')) {
      const file = path.join(FONTS, url.pathname.slice('/fonts/'.length));
      if (file.startsWith(FONTS) && existsSync(file)) return route.fulfill({ status: 200, contentType: 'font/woff2', body: readFileSync(file) });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await tab.goto(`${ORIGIN}/`);
  await tab.waitForFunction(() => {
    const banner = document.getElementById('fc-consent');
    return banner !== null && !banner.hidden;
  });
  return { tab, context, requests };
}

interface Seen {
  htmlScheme: string;
  htmlBackground: string;
  bodyBackground: string;
  bodyColor: string;
  bodyFont: string;
  copy: string;
  card: string;
  odd: string;
  banner: { color: string; background: string; font: string; buttonColor: string; buttonBackground: string };
  fontLoaded: boolean;
}

async function observe(tab: Page): Promise<Seen> {
  await tab.evaluate(async () => {
    await document.fonts.ready;
    // A face loads when text needs it; the title asks for its weight.
    await document.fonts.load('700 32px Fraunces');
  });
  return tab.evaluate(() => {
    const style = (el: Element) => getComputedStyle(el);
    const byId = (id: string) => document.getElementById(id)!;
    const banner = byId('fc-consent');
    const button = banner.querySelector('button')!;
    return {
      htmlScheme: style(document.documentElement).colorScheme,
      htmlBackground: style(document.documentElement).backgroundColor,
      bodyBackground: style(document.body).backgroundColor,
      bodyColor: style(document.body).color,
      bodyFont: style(document.body).fontFamily,
      copy: style(byId('copy')).color,
      card: style(byId('card')).color,
      odd: style(byId('odd')).color,
      banner: {
        color: style(banner).color,
        background: style(banner).backgroundColor,
        font: style(banner).fontFamily,
        buttonColor: style(button).color,
        buttonBackground: style(button).backgroundColor,
      },
      fontLoaded: [...document.fonts].some((face) => /fraunces/i.test(face.family) && face.status === 'loaded'),
    };
  });
}

/** Contrast of computed text over a computed ground, as the banner's guard measures it. */
function ratio(text: string, ground: string): number {
  const ink = parseColor(text);
  const on = parseColor(ground);
  if (!ink || !on) throw new Error(`cannot read ${text} on ${ground}`);
  return contrastRatio(composite(ink, on), on);
}

const MODES: (ThemeMode | undefined)[] = [undefined, 'light', 'dark', 'system'];
const label = (mode: ThemeMode | undefined) => mode ?? 'no choice';

/** The scheme whose token values show, and whether a dark media rule fires. */
function expected(mode: ThemeMode | undefined, scheme: 'light' | 'dark') {
  const shown = mode === 'dark' ? 'dark' : mode === 'system' ? scheme : 'light';
  const darkRule = mode === 'dark' ? true : mode === 'light' ? false : scheme === 'dark';
  const htmlScheme = mode === 'system' ? 'light dark' : mode ?? null;
  return { shown, darkRule, htmlScheme } as const;
}

beforeAll(() => {
  if (!existsSync(path.join(FONTS, 'fraunces'))) execFileSync('pnpm', ['fonts:sync'], { stdio: 'ignore' });
}, 120_000);

describe.each(ENGINES)('the theme on the published page in %s', (_engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  describe.each(PAGE_BASES)('on the %s page base', (base) => {
    it.each(MODES.map((mode) => [label(mode), mode] as const))('mode %s, under both system settings', async (_label, mode) => {
      const theme = siteTheme(mode);
      const html = await render(tree(), theme, base);
      const plain = await render(tree(), undefined, base);
      for (const scheme of ['light', 'dark'] as const) {
        const want = expected(mode, scheme);
        const { tab, context, requests } = await open(browser, html, scheme);
        const seen = await observe(tab);
        await context.close();
        const at = `${label(mode)}, system ${scheme}`;

        // Tokens on html and body through the document block, and on what inherits.
        expect(seen.bodyBackground, at).toBe(VALUES.ground[want.shown]);
        expect(seen.bodyColor, at).toBe(VALUES.ink[want.shown]);
        expect(seen.copy, at).toBe(VALUES.ink[want.shown]);
        expect(seen.bodyFont, at).toMatch(/^Fraunces, /);
        if (want.htmlScheme) {
          expect(seen.htmlScheme, at).toBe(want.htmlScheme);
        } else {
          // No choice writes no color-scheme: html computes what it does with no theme.
          const before = await open(browser, plain, scheme);
          expect(seen.htmlScheme, at).toBe((await observe(before.tab)).htmlScheme);
          await before.context.close();
        }

        // A forced mode decides a node's dark rule; with no choice and system the visitor's setting does.
        expect(seen.card, at).toBe(want.darkRule ? DARK_RULE_COLOR : VALUES.ink[want.shown]);
        // The invalid query stays dead in every mode.
        expect(seen.odd, at).not.toBe(ODD_RULE_COLOR);

        // The banner keeps the site's look, flips with the page, and reads.
        expect(seen.banner.color, at).toBe(VALUES.ink[want.shown]);
        expect(seen.banner.background, at).toBe(VALUES.ground[want.shown]);
        expect(seen.banner.buttonBackground, at).toBe(VALUES.accent[want.shown]);
        expect(seen.banner.buttonColor, at).toBe(VALUES.accentInk[want.shown]);
        expect(ratio(seen.banner.color, seen.banner.background), at).toBeGreaterThanOrEqual(4.5);
        expect(ratio(seen.banner.buttonColor, seen.banner.buttonBackground), at).toBeGreaterThanOrEqual(4.5);
        expect(seen.banner.font, at).toMatch(/^Fraunces, /);

        // The font token loads, from the site's own origin, and nothing else is asked for.
        expect(seen.fontLoaded, at).toBe(true);
        expect(requests.filter((url) => !url.startsWith(`${ORIGIN}/fonts/fraunces/`)), at).toEqual([]);
      }
    });

    it("a page's :root rule beats the theme on color-scheme, color, background and font", async () => {
      const rootRule = {
        id: 'doc',
        selector: ':root',
        style: { colorScheme: 'light', color: 'rgb(10, 20, 30)', backgroundColor: 'rgb(200, 210, 220)', fontFamily: 'Georgia, serif' },
      };
      const html = await render(tree([rootRule]), siteTheme('dark'), base);
      for (const scheme of ['light', 'dark'] as const) {
        const { tab, context } = await open(browser, html, scheme);
        const seen = await observe(tab);
        await context.close();
        expect(seen.htmlScheme).toBe('light');
        expect(seen.bodyColor).toBe('rgb(10, 20, 30)');
        expect(seen.copy).toBe('rgb(10, 20, 30)');
        // The rule paints the document, and hands body back to it (#261's BODY_HANDS_BACK),
        // so the theme's body background is beaten too: nothing of it is painted.
        expect(seen.htmlBackground).toBe('rgb(200, 210, 220)');
        expect(seen.bodyBackground).toBe('rgba(0, 0, 0, 0)');
        expect(seen.bodyFont).toBe('Georgia, serif');
      }
    });
  });

  // The contract's table, on shadcn's own values: whatever the site sets, the banner reads.
  const SHADCN: SiteTheme['tokens'] = [
    { id: 'bg000001', name: 'background', kind: 'color', light: 'oklch(1 0 0)', dark: 'oklch(0.145 0 0)' },
    { id: 'fg000002', name: 'foreground', kind: 'color', light: 'oklch(0.145 0 0)', dark: 'oklch(0.985 0 0)' },
    { id: 'pr000003', name: 'primary', kind: 'color', light: 'oklch(0.205 0 0)', dark: 'oklch(0.922 0 0)' },
    { id: 'pf000004', name: 'primary-foreground', kind: 'color', light: 'oklch(0.985 0 0)', dark: 'oklch(0.205 0 0)' },
  ];
  const rows: [string, SiteTheme['document'], SiteLook][] = [
    ['an ink token on the default white ground', {}, { ...DEFAULT_LOOK, color: ref('fg000002'), accent: ref('pr000003'), accentText: ref('pf000004') }],
    ['the document block on background and foreground', { backgroundColor: ref('bg000001'), color: ref('fg000002') }, { ...DEFAULT_LOOK, color: ref('fg000002'), background: ref('bg000001'), accent: ref('pr000003'), accentText: ref('pf000004') }],
    ['a literal white on the dark primary', { backgroundColor: ref('bg000001'), color: ref('fg000002') }, { ...DEFAULT_LOOK, color: ref('fg000002'), background: ref('bg000001'), accent: ref('pr000003'), accentText: '#ffffff' }],
  ];
  it.each(rows)('the banner reads with %s, at both system settings and both page bases', async (_row, document, look) => {
    for (const base of PAGE_BASES) {
      const html = await render(tree(), { mode: 'system', tokens: SHADCN, document }, base, look);
      for (const scheme of ['light', 'dark'] as const) {
        const { tab, context } = await open(browser, html, scheme);
        const seen = await observe(tab);
        await context.close();
        expect(ratio(seen.banner.color, seen.banner.background), `${base} ${scheme}`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(seen.banner.buttonColor, seen.banner.buttonBackground), `${base} ${scheme}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('the default 404 reads a reference, and flips with the page', async () => {
    const theme = siteTheme('system');
    const body = renderToStaticMarkup(React.createElement(DefaultNotFound, { siteName: 'S', language: 'en', look: LOOK, theme }));
    const html = publishedDocument({ html: body, css: '', theme }, 'reset');
    for (const scheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({ colorScheme: scheme });
      const tab = await context.newPage();
      await tab.setContent(html);
      const seen = await tab.evaluate(() => {
        const main = document.querySelector('[data-testid="storefront-404"]')!;
        return { color: getComputedStyle(main).color, background: getComputedStyle(main).backgroundColor };
      });
      await context.close();
      expect(seen).toEqual({ color: VALUES.ink[scheme], background: VALUES.ground[scheme] });
    }
  });

  it('a stored --fc- key never repaints a token: inline, in a rule, in a keyframe block, on :root', async () => {
    const hostile: ComponentNode[] = [
      {
        id: 'forged',
        type: 'div',
        props: {
          id: 'forged',
          style: { [`--fc-t-${ID.ink}`]: 'red', animation: 'u-paint 1s both' } as never,
          rules: [
            { id: 'hover', selector: '&', style: { [`--fc-t-${ID.ink}`]: 'red' } },
            { id: 'paint', define: '@keyframes u-paint', blocks: [{ selector: 'from, to', style: { [`--fc-t-${ID.ink}`]: 'red' } }] },
          ] as never,
        },
        children: [{ id: 'inner', type: 'p', props: { id: 'inner', children: 'Inner', style: { color: ref(ID.ink) } } }],
      },
    ];
    const rootRule = { id: 'doc', selector: ':root', style: { [`--fc-t-${ID.ink}`]: 'red' } };
    const html = await render(tree([rootRule], hostile), siteTheme('light'), 'reset');
    expect(html).not.toMatch(new RegExp(`--fc-t-${ID.ink}\\s*:\\s*red`));
    const { tab, context } = await open(browser, html, 'light');
    const inner = await tab.evaluate(() => getComputedStyle(document.getElementById('inner')!).color);
    const copy = await tab.evaluate(() => getComputedStyle(document.getElementById('copy')!).color);
    await context.close();
    expect(inner).toBe(VALUES.ink.light);
    expect(copy).toBe(VALUES.ink.light);
  });

  it('a site with no theme renders exactly as before: no sheet, no class, no viewport', async () => {
    const withNone = await render(tree(), undefined, 'reset');
    const withEmpty = await render(tree(), { tokens: [], document: {} }, 'reset');
    expect(withEmpty).toBe(withNone);
    expect(withNone).not.toContain('data-fc-theme-sheet');
    expect(withNone).toContain('class="light"');
  });

  // The before half of this ran once against main for slice T2 and matched byte for byte;
  // what stays is that a stored blob with no theme key reads as no theme at all.
  it('settings with no theme key render the whole corpus as a site with no theme, theme-dark-rule included', () => {
    const noKey = normalizeSiteSettings({ pageBase: 'browser' }).theme;
    const plain = FIXTURES.filter((fixture) => !fixture.published);
    expect(plain.map((fixture) => fixture.id)).toContain('theme-dark-rule');
    for (const fixture of plain) {
      const output = renderPublished(fixture.tree());
      for (const base of PAGE_BASES) {
        expect(publishedDocument({ ...output, theme: noKey }, base), fixture.id).toBe(publishedDocument(output, base));
      }
    }
  });
});
