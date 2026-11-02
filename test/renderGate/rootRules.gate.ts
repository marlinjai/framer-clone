// A rule on `:root` in real browsers, on the page a visitor really gets: the real
// consent banner, the sticky bar, and the compiled base sheet. The document holds the
// banner, which is not in the page tree, so what a stored rule can do to it is
// measured here, on a phone, where the banner is pinned above the bar.

import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium, webkit, type Browser, type BrowserType } from 'playwright';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import { renderPublishedPage } from '@/lib/renderer/server/renderPublishedPage';
import { parseColor } from '@/lib/color/cssColor';
import { NAMED_COLOR_HEX } from '@/lib/color/namedColors';
import { bannerPinned } from '@/lib/consent/ConsentBanner';
import type { PageBase } from '@/lib/site/pageBase';
import { cssPropertyName } from '@/lib/responsive/responsiveCss';
import { DEFAULT_LOOK, type SiteLook } from '@/lib/site/notFoundDefault';
import HeadlessPageRenderer from '@/lib/renderer/HeadlessPageRenderer';
import PageModel from '@/models/PageModel';
import { ComponentTypeEnum } from '@/models/ComponentModel';
import { BREAKPOINTS, publishedDocument } from '../score/lib/published';

const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];
const PHONE = { width: 390, height: 844 };
const cmsRepo = { listRows: async () => ({ rows: [], total: 0 }), getRow: async () => null } as unknown as CmsReadRepository;

const rule = (style: Record<string, unknown>, at?: string[]) => ({ id: 'doc', selector: ':root', ...(at ? { at } : {}), style });

interface PageOptions {
  look?: Partial<SiteLook>;
  bar?: Record<string, unknown>;
  breakpoints?: readonly { id: string; minWidth: number }[];
  pageBase?: PageBase;
}

async function page(rules: unknown[], { look, bar, breakpoints = BREAKPOINTS, pageBase }: PageOptions = {}): Promise<string> {
  const root: ComponentNode = {
    id: 'root',
    type: 'div',
    props: { rules: rules as never },
    children: [
      { id: 'copy', type: 'p', props: { id: 'copy', children: 'Plain text that inherits everything' } },
      { id: 'bar', type: 'div', props: { 'data-sticky-cta': 'bar', ctaLabel: 'Book now', ctaHref: '#copy', ...bar } as never },
    ],
  };
  const analytics = { enabled: true, ingestionKey: `ap_live_${randomBytes(12).toString('hex')}`, ingestionEndpoint: 'https://ingest.test/e', projectId: 'p' };
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { body } = await renderPublishedPage({ root, pageParams: {}, cmsRepo, breakpoints, analytics, pageBase, consent: { language: 'en', ...(look ? { look: { ...DEFAULT_LOOK, ...look } } : {}) } });
  warn.mockRestore();
  return publishedDocument({ html: renderToStaticMarkup(React.createElement(React.Fragment, null, body)), css: '' });
}

const LANDSCAPE = { width: 844, height: 390 };
/** Breakpoints under which the bar stays pinned on a phone on its side. */
const WIDE_PHONE = [{ id: 'desktop', minWidth: 1280 }, { id: 'tablet', minWidth: 1000 }, { id: 'mobile', minWidth: 320 }];

async function open(browser: Browser, html: string, viewport = PHONE) {
  const phone = viewport === PHONE || viewport === LANDSCAPE;
  const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone, colorScheme: 'light' });
  const tab = await context.newPage();
  await tab.route('https://root.test/', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await tab.goto('https://root.test/');
  await tab.waitForFunction(() => {
    const banner = document.getElementById('fc-consent');
    return banner !== null && !banner.hidden;
  });
  return tab;
}

interface BannerFacts {
  buttonsOnScreen: boolean;
  letterSpacing: string;
  bodySize: string;
  textWidth: number;
  bannerWidth: number;
}

const bannerFacts = () =>
  (() => {
    const banner = document.getElementById('fc-consent') as HTMLElement;
    const inside = (el: Element) => {
      const box = el.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      return x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight && banner.contains(document.elementFromPoint(x, y));
    };
    const text = banner.querySelector('p') as HTMLElement;
    return {
      buttonsOnScreen: [...banner.querySelectorAll('button')].length === 2 && [...banner.querySelectorAll('button')].every(inside),
      letterSpacing: getComputedStyle(text).letterSpacing,
      bodySize: getComputedStyle(text).fontSize,
      textWidth: text.getBoundingClientRect().width,
      bannerWidth: banner.getBoundingClientRect().width,
    };
  })();

describe.each(ENGINES)('a rule on the document in %s', (_name, type) => {
  const withBrowser = async (work: (browser: Browser) => Promise<void>) => {
    const browser = await type.launch();
    try {
      await work(browser);
    } finally {
      await browser.close();
    }
  };

  it.each([
    ['nothing, as the control', {}],
    ['the sticky bar height, huge', { '--fc-sticky-cta-h': '9999px !important' }],
    ['the sticky bar height, negative', { '--fc-sticky-cta-h': '-9999px !important' }],
    ['the sticky bar height, as the word', { '--fc-sticky-cta-h': '!important' }],
    ['tight letters', { letterSpacing: '-1em' }],
    ['wide letters', { letterSpacing: '300px' }],
    ['tiny phone text', { textSizeAdjust: '1%', WebkitTextSizeAdjust: '1%' }],
    ['huge phone text', { textSizeAdjust: '800%', WebkitTextSizeAdjust: '800%' }],
    ['font size', { fontSize: '200px' }],
    ['a font weight and features', { fontWeight: 100, fontFeatureSettings: '"smcp"', textRendering: 'geometricPrecision', tabSize: 80 }],
  ])('leaves both banner buttons on screen and the text readable under %s', async (_what, style) => {
    await withBrowser(async (browser) => {
      const tab = await open(browser, await page([rule(style)]));
      const facts: BannerFacts = await tab.evaluate(bannerFacts);
      expect(facts.buttonsOnScreen).toBe(true);
      expect(facts.letterSpacing).toBe('normal');
      expect(facts.bodySize).toBe('15px');
      expect(facts.textWidth).toBeGreaterThan(facts.bannerWidth / 2);
      await tab.context().close();
    });
  });

  it.each([
    ['named white', { color: 'white', background: 'white', accent: 'white', accentText: 'white' }, []],
    ['hsl white', { color: 'hsl(0 0% 100%)', background: 'hsl(0 0% 100%)' }, []],
    ['oklch white', { color: 'oklch(1 0 0)', background: 'oklch(1 0 0)' }, []],
    ['a see-through hsla', { background: 'hsla(0,0%,0%,0)' }, []],
    ['color-mix', { color: 'color-mix(in srgb, white, white)', background: 'white' }, []],
    ['currentColor as the ground', { background: 'currentColor' }, []],
    ['inherit as the ink', { color: 'inherit', background: 'white' }, [rule({ color: '#ffffff' })]],
    ['var() on both', { color: 'var(--ink)', background: 'var(--ink)' }, [rule({ '--ink': '#ffffff' })]],
    ['a gradient as the ground', { color: '#000000', background: 'linear-gradient(#000,#000)' }, []],
    ['an invalid colour, which would inherit', { color: 'rgb(1, 2 3)', background: 'white' }, [rule({ color: '#ffffff' })]],
  ] as [string, Partial<SiteLook>, unknown[]][])('falls back to the neutral pair on %s', async (_what, look, rules) => {
    await withBrowser(async (browser) => {
      const tab = await open(browser, await page(rules, { look }), { width: 1280, height: 800 });
      const seen = await tab.evaluate(() => {
        const banner = getComputedStyle(document.getElementById('fc-consent') as HTMLElement);
        return { color: banner.color, background: banner.backgroundColor };
      });
      expect(seen).toEqual({ color: 'rgb(17, 24, 39)', background: 'rgb(255, 255, 255)' });
      await tab.context().close();
    });
  });

  describe.each(['reset', 'browser'] as const)('on the %s base, what the parser and the browser read differently', (pageBase) => {
    const banner = () => {
      const root = document.getElementById('fc-consent') as HTMLElement;
      const button = root.querySelector('button') as HTMLElement;
      const text = root.querySelector('p') as HTMLElement;
      return {
        color: getComputedStyle(text).color,
        background: getComputedStyle(root).backgroundColor,
        label: getComputedStyle(button).color,
        button: getComputedStyle(button).backgroundColor,
        font: getComputedStyle(text).fontFamily,
      };
    };
    const NEUTRAL = { color: 'rgb(17, 24, 39)', background: 'rgb(255, 255, 255)', label: 'rgb(255, 255, 255)', button: 'rgb(17, 24, 39)' };

    it.each([
      ['ink with trailing dots', { color: 'rgb(0. 0. 0.)', background: '#ffffff' }, [rule({ color: '#ffffff' })]],
      ['ink in hsl with a trailing dot', { color: 'hsl(0 0% 0.%)', background: '#ffffff' }, [rule({ color: '#ffffff' })]],
      ['a ground with trailing dots', { color: '#000000', background: 'rgb(255. 255. 255.)' }, [rule({ backgroundColor: '#000000' })]],
      ['button text with trailing dots', { accentText: 'rgb(255. 255. 255.)' }, []],
    ] as [string, Partial<SiteLook>, unknown[]][])('shows the neutral pair under %s', async (_what, look, rules) => {
      await withBrowser(async (browser) => {
        const tab = await open(browser, await page(rules, { look, pageBase }), { width: 1280, height: 800 });
        const seen = await tab.evaluate(banner);
        expect({ color: seen.color, background: seen.background, label: seen.label, button: seen.button }).toEqual(NEUTRAL);
        await tab.context().close();
      });
    });

    it.each(['system-ui,,sans-serif', 'system-ui,'])('never lets %j drop the declaration and hand the banner a stored font', async (fontFamily) => {
      await withBrowser(async (browser) => {
        const face = { id: 'f', define: '@font-face', style: { fontFamily: 'u-blank', src: 'url(data:font/ttf;base64,AAAA)' } };
        const tab = await open(browser, await page([face, rule({ fontFamily: 'u-blank' })], { look: { fontFamily }, pageBase }), { width: 1280, height: 800 });
        const seen = await tab.evaluate(banner);
        expect(seen.font).not.toContain('u-blank');
        expect(seen.font).toContain('system-ui');
        await tab.context().close();
      });
    });

    it('writes a readable brand as the browser reads it', async () => {
      await withBrowser(async (browser) => {
        const tab = await open(browser, await page([rule({ color: '#ffffff' })], { look: { color: 'rgb(0.5 0 0)', background: '#ffffff', fontFamily: 'Georgia, serif' }, pageBase }), { width: 1280, height: 800 });
        const seen = await tab.evaluate(banner);
        expect(seen.color).toBe('rgb(1, 0, 0)');
        expect(seen.font).toBe('Georgia, serif');
        await tab.context().close();
      });
    });
  });

  it('keeps a brand it can read', async () => {
    await withBrowser(async (browser) => {
      const tab = await open(browser, await page([], { look: { color: 'navy', background: 'white' } }), { width: 1280, height: 800 });
      expect(await tab.evaluate(() => getComputedStyle(document.getElementById('fc-consent') as HTMLElement).color)).toBe('rgb(0, 0, 128)');
      await tab.context().close();
    });
  });

  it('never uses a stored font on the banner, whose glyphs could be empty', async () => {
    await withBrowser(async (browser) => {
      const face = { id: 'f', define: '@font-face', style: { fontFamily: 'u-blank', src: 'url(data:font/ttf;base64,AAAA)' } };
      const tab = await open(browser, await page([face], { look: { fontFamily: 'u-blank' } }), { width: 1280, height: 800 });
      const font = await tab.evaluate(() => getComputedStyle(document.getElementById('fc-consent') as HTMLElement).fontFamily);
      expect(font).not.toContain('u-blank');
      expect(font).toContain('system-ui');
      await tab.context().close();
    });
  });

  describe.each([
    ['upright', PHONE, BREAKPOINTS],
    ['on its side', LANDSCAPE, WIDE_PHONE],
  ] as const)('with a sticky bar on a phone %s', (_side, viewport, breakpoints) => {
    it.each([
      ['a normal bar', [], {}],
      ['a tall bar', [], { style: { minHeight: '5000px' } }],
      ['a tall bar, by a rule', [], { rules: [{ id: 's', selector: '&', style: { minHeight: '9999px !important', maxHeight: 'none !important' } }] }],
      ['tall padding, by a rule', [], { rules: [{ id: 's', selector: '&', style: { paddingTop: '4000px' } }] }],
      ['a bar sized from a huge rem', [rule({ fontSize: '2000px' })], { style: { minHeight: '1rem' } }],
      ['tall text', [], { ctaLabel: 'Book '.repeat(15) }],
    ] as [string, unknown[], Record<string, unknown>][])('keeps both banner buttons on screen under %s', async (_what, rules, bar) => {
      await withBrowser(async (browser) => {
        const tab = await open(browser, await page(rules, { bar, breakpoints }), viewport);
        const facts: BannerFacts = await tab.evaluate(bannerFacts);
        expect(facts.buttonsOnScreen).toBe(true);
        const lift = await tab.evaluate(() => parseFloat(getComputedStyle(document.getElementById('fc-consent') as HTMLElement).bottom));
        expect(lift).toBeLessThanOrEqual(viewport.height * 0.3 + 12.5);
        await tab.context().close();
      });
    });

    it('caps the bar and keeps the padding honest', async () => {
      await withBrowser(async (browser) => {
        const tab = await open(browser, await page([], { bar: { style: { minHeight: '5000px' } }, breakpoints }), viewport);
        const facts = await tab.evaluate(() => ({
          bar: (document.querySelector('[data-fc-sticky-cta]') as HTMLElement).offsetHeight,
          padding: parseFloat(getComputedStyle(document.body).paddingBottom),
        }));
        expect(facts.bar).toBeLessThanOrEqual(Math.ceil(viewport.height * 0.3));
        expect(Math.abs(facts.padding - facts.bar)).toBeLessThanOrEqual(1);
        await tab.context().close();
      });
    });

    it('leaves a normal bar and the banner where they were', async () => {
      await withBrowser(async (browser) => {
        const tab = await open(browser, await page([], { breakpoints }), viewport);
        const bar = await tab.evaluate(() => (document.querySelector('[data-fc-sticky-cta]') as HTMLElement).offsetHeight);
        expect(bar).toBe(60);
        await tab.context().close();
      });
    });
  });

  it.each([
    ['upright', PHONE],
    ['on its side', LANDSCAPE],
  ] as const)('caps a tall bar in the preview too, on a phone %s', async (_side, viewport) => {
    const model = PageModel.create({
      id: 'preview',
      slug: 'preview',
      metadata: { title: 'T' },
      appComponentTree: {
        id: 'root',
        type: 'div',
        componentType: ComponentTypeEnum.HOST,
        props: {},
        children: [{ id: 'bar', type: 'div', componentType: ComponentTypeEnum.HOST, props: { 'data-sticky-cta': 'bar', ctaLabel: 'Book', ctaHref: '#a', style: { minHeight: '5000px' } } }],
      },
      canvasNodes: { phone: { id: 'phone', type: 'div', componentType: ComponentTypeEnum.HOST, canvasNodeType: 'viewport', breakpointId: 'phone', breakpointMinWidth: 320, viewportWidth: 390, viewportHeight: 844, props: {} } },
    });
    const markup = renderToStaticMarkup(React.createElement(HeadlessPageRenderer, { page: model, breakpointId: 'phone' }));
    await withBrowser(async (browser) => {
      const tab = await browser.newPage({ viewport });
      await tab.setContent(`<!doctype html><html><body style="margin:0"><div data-preview-frame style="height:100vh;overflow:auto">${markup}</div></body></html>`);
      const height = await tab.locator('[data-fc-sticky-cta-preview]').evaluate((el) => (el as HTMLElement).offsetHeight);
      expect(height).toBeLessThanOrEqual(Math.ceil(viewport.height * 0.3));
      expect(height).toBeGreaterThan(0);
    });
  });

  it.each([
    ['phone', PHONE, 'reset'],
    ['desktop', { width: 1280, height: 800 }, 'reset'],
    ['phone', PHONE, 'browser'],
    ['desktop', { width: 1280, height: 800 }, 'browser'],
  ] as const)('draws a normal page\'s banner pixel for pixel as without the pins, on a %s, on the %s base', async (_name, viewport, pageBase) => {
    const html = await page([], { pageBase });
    const declarations = Object.entries(bannerPinned(pageBase)).map(([key, value]) => `${cssPropertyName(key)}:${value}`);
    const unpinned = declarations.reduce((text, declaration) => text.replace(`${declaration};`, '').replace(`;${declaration}"`, '"'), html);
    expect(unpinned).not.toBe(html);
    expect(unpinned).not.toContain('letter-spacing:normal');
    await withBrowser(async (browser) => {
      const shots: Buffer[] = [];
      for (const document of [html, unpinned]) {
        const tab = await open(browser, document, viewport);
        shots.push(await tab.locator('#fc-consent').screenshot());
        await tab.context().close();
      }
      expect(shots[0].equals(shots[1])).toBe(true);
    });
  });

  it('reads colours as the browser does', async () => {
    const names = Object.keys(NAMED_COLOR_HEX);
    const samples = [
      ...names,
      'hsl(0 0% 100%)', 'hsl(210 50% 20%)', 'hsl(120deg 75% 25% / 0.5)', 'hsl(0.5turn 100% 50%)', 'hsl(-30, 40%, 60%)', 'hsla(200, 10%, 90%, 0.2)',
      'oklch(1 0 0)', 'oklch(0 0 0)', 'oklch(0.5 0.1 200)', 'oklch(70% 0.1 30)', 'oklch(0.25 0.05 260)', 'oklch(0.9 0.05 90 / 50%)',
      'rgb(1 2 3)', 'rgb(1, 2, 3)', 'rgba(1, 2, 3, 0.5)', 'rgb(10% 20% 30%)', 'rgb(300 0 0)', '#abc', '#abcd', '#a1b2c3d4',
    ];
    await withBrowser(async (browser) => {
      const tab = await browser.newPage();
      const painted = await tab.evaluate((list) => {
        const context = (document.createElement('canvas') as HTMLCanvasElement).getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
        return list.map((color) => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = '#123456';
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          return Array.from(context.getImageData(0, 0, 1, 1).data);
        });
      }, samples);
      samples.forEach((color, index) => {
        const read = parseColor(color);
        const [r, g, b, a] = painted[index];
        expect(read, color).toBeDefined();
        expect(Math.abs((read?.a ?? 0) * 255 - a), color).toBeLessThanOrEqual(1);
        if (a === 255) for (const [mine, theirs] of [[read?.r ?? 0, r], [read?.g ?? 0, g], [read?.b ?? 0, b]]) expect(Math.abs(mine - theirs), color).toBeLessThanOrEqual(2);
      });

      const refused = ['rgb(1, 2 3)', 'rgb(1x 2 3)', 'rgb(1 2)', 'rgb(1 2 3 4)', 'rgb(1, 2, 3, 4, 5)', 'rgb(50%, 1, 1)', 'hsl(0 0 100 / / 1)', '#12345', 'notacolour', 'oklch(1, 0, 0)', 'hsl(0, 0, 100)'];
      for (const color of refused) expect(parseColor(color), color).toBeUndefined();
      const supported = await tab.evaluate((list) => list.filter((color) => CSS.supports('color', color)), [...samples, 'rgb(1, 2 3)', 'rgb(1x 2 3)', 'rgb(1 2)', 'rgb(1 2 3 4)', 'rgb(1, 2, 3, 4, 5)', 'rgb(50%, 1, 1)', '#12345', 'notacolour', 'oklch(1, 0, 0)']);
      expect(supported).toEqual(samples);
    });
  });

  it('reaches body and the text under it on the real base sheet', async () => {
    await withBrowser(async (browser) => {
      const style = { color: 'rgb(1, 2, 3)', backgroundColor: 'rgb(4, 5, 6)', fontFamily: 'Georgia', fontSize: '20px' };
      const tab = await open(browser, await page([rule(style)]), { width: 1280, height: 800 });
      const seen = await tab.evaluate(() => {
        const body = getComputedStyle(document.body);
        const copy = getComputedStyle(document.getElementById('copy') as HTMLElement);
        return { bodyColor: body.color, bodyBackground: body.backgroundColor, bodyFont: body.fontFamily, copyColor: copy.color, copyFont: copy.fontFamily, rem: getComputedStyle(document.documentElement).fontSize };
      });
      expect(seen).toEqual({ bodyColor: 'rgb(1, 2, 3)', bodyBackground: 'rgba(0, 0, 0, 0)', bodyFont: 'Georgia', copyColor: 'rgb(1, 2, 3)', copyFont: 'Georgia', rem: '20px' });
      await tab.context().close();
    });
  });

  it('leaves body to the base sheet while a condition does not hold', async () => {
    await withBrowser(async (browser) => {
      const read = (html: string) => open(browser, html, { width: 1280, height: 800 }).then(async (tab) => {
        const color = await tab.evaluate(() => getComputedStyle(document.body).color);
        await tab.context().close();
        return color;
      });
      const plain = await read(await page([]));
      const wrapped = await read(await page([rule({ color: 'rgb(1, 2, 3)' }, ['@media (max-width: 10px)'])]));
      expect(wrapped).toBe(plain);
    });
  });
});
