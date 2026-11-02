// The theme sheet in real browsers (contract docs/plans/2026-11-02-theme-and-head.md,
// slice T1). A token value is stored text that reaches a raw stylesheet applying to the
// whole document, so the grammar is proven against the browser's own CSS parser, not
// against a description of it:
//
//   - every stored value the grammar refuses, the contract's probe and its review's
//     included, goes through normalizeTheme and themeCss, and through themeCss alone as a
//     frozen revision read without normalizing would. The sheet must parse to exactly the
//     rules themeCss means, a neighbouring token and the document block must survive, and
//     nothing may run, load or hide the page;
//   - every value the grammar accepts must be a colour the browser computes;
//   - the surface sheet must reach only what sits inside its frame attribute.
//
// The layout that places the published sheet is slice T2 (test/renderGate/themePublished.gate.ts);
// this gate proves the emitter, and that the one colour parser the banner's guard reads
// converts every accepted value to the sRGB numbers the browser computes.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type BrowserType, type Page } from 'playwright';
import { normalizeTheme, parseColorValue, themeCss, type SiteTheme } from '@/lib/site/theme';
import { parseColor, parseCssColor, type ColorComponent } from '@/lib/color/cssColor';
import { NAMED_COLOR_HEX } from '@/lib/color/namedColors';
import {
  ACCEPTED_COLORS,
  REFUSED_COLORS,
  REVIEW_PROBE_VALUES,
  REVIEW_REFUSED,
  colorSweep,
} from '@/lib/site/__tests__/themeValues';

const ORIGIN = 'https://theme.test';
const HOSTILE = 'aa000001';
const SENTINEL = 'bb000002';
const FONT = 'cc000003';

interface Observed {
  rules: string[];
  sentinel: string;
  hostile: string;
  bodyBackground: string;
  bodyDisplay: string;
  rootScheme: string;
  ran: boolean;
}

function theme(hostile: unknown): SiteTheme {
  return {
    mode: 'system',
    tokens: [
      { id: HOSTILE, name: 'Hostile', kind: 'color', light: hostile, dark: hostile },
      { id: SENTINEL, name: 'Sentinel', kind: 'color', light: '#123456', dark: '#654321' },
      { id: FONT, name: 'Display', kind: 'font', family: 'fraunces' },
    ],
    document: { backgroundColor: `var(--fc-t-${SENTINEL})`, fontFamily: `var(--fc-t-${FONT})` },
  } as unknown as SiteTheme;
}

const page = (css: string) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>
<body><div style="color:rgb(9, 9, 9)"><p id="sentinel" style="color:var(--fc-t-${SENTINEL})">s</p><p id="hostile" style="color:var(--fc-t-${HOSTILE})">h</p></div></body></html>`;

async function load(tab: Page, html: string, requests: string[]): Promise<Observed> {
  await tab.route('**/*', (route) => {
    const url = route.request().url();
    if (url === `${ORIGIN}/`) return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    requests.push(url);
    return route.fulfill({ status: 204, body: '' });
  });
  await tab.goto(`${ORIGIN}/`);
  return tab.evaluate(() => {
    const computed = (id: string) => getComputedStyle(document.getElementById(id)!).color;
    return {
      rules: [...document.styleSheets].flatMap((sheet) =>
        [...sheet.cssRules].map((rule) => (rule instanceof CSSStyleRule ? rule.selectorText : rule instanceof CSSMediaRule ? `@media ${rule.conditionText}` : rule instanceof CSSFontFaceRule ? '@font-face' : rule.cssText)),
      ),
      sentinel: computed('sentinel'),
      hostile: computed('hostile'),
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      bodyDisplay: getComputedStyle(document.body).display,
      rootScheme: getComputedStyle(document.documentElement).colorScheme,
      ran: (window as unknown as { __ran?: unknown }).__ran !== undefined || document.querySelector('img,script') !== null,
    };
  });
}

/** What the sheet of `theme(x)` must parse to, whatever x is: faces, :root, the dark block, body. */
function expectedRules(faces: number): string[] {
  return [...Array<string>(faces).fill('@font-face'), ':root', '@media (prefers-color-scheme: dark)', 'body'];
}

const browsers: Array<[string, BrowserType]> = [['chromium', chromium], ['webkit', webkit]];

describe.each(browsers)('the theme sheet in %s', (_name, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  async function observe(css: string, scheme: 'light' | 'dark') {
    const context = await browser.newContext({ colorScheme: scheme });
    try {
      const requests: string[] = [];
      const seen = await load(await context.newPage(), page(css), requests);
      return { ...seen, requests };
    } finally {
      await context.close();
    }
  }

  const faces = (themeCss(normalizeTheme(theme('#000'))).match(/@font-face/g) ?? []).length;

  it.each(REFUSED_COLORS)('a stored %s stays contained, normalized or read raw', async (_label, value) => {
    for (const css of [themeCss(normalizeTheme(theme(value))), themeCss(theme(value))]) {
      for (const scheme of ['light', 'dark'] as const) {
        const seen = await observe(css, scheme);
        expect(seen.rules).toEqual(expectedRules(faces));
        expect(seen.sentinel).toBe(scheme === 'light' ? 'rgb(18, 52, 86)' : 'rgb(101, 67, 33)');
        expect(seen.bodyBackground).toBe(seen.sentinel);
        // The refused value was left out, so its uses inherit.
        expect(seen.hostile).toBe('rgb(9, 9, 9)');
        expect(seen.bodyDisplay).toBe('block');
        expect(seen.rootScheme).toBe('light dark');
        expect(seen.ran).toBe(false);
        // Only the fonts the registry names, from the same origin.
        expect(seen.requests.filter((url) => !url.startsWith(`${ORIGIN}/fonts/`))).toEqual([]);
      }
    }
  });

  it.each(ACCEPTED_COLORS)('an accepted %s is a colour the browser computes', async (value) => {
    const seen = await observe(themeCss(normalizeTheme(theme(value))), 'light');
    expect(seen.rules).toEqual(expectedRules(faces));
    expect(seen.sentinel).toBe('rgb(18, 52, 86)');
    // A value the browser could not read would make the use inherit rgb(9, 9, 9).
    expect(seen.hostile).not.toBe('rgb(9, 9, 9)');
  });

  it('every value the grammar accepts, from the review probe, the lists and a generated sweep, is a colour here', async () => {
    const candidates = [...new Set([...REVIEW_PROBE_VALUES, ...colorSweep(), ...ACCEPTED_COLORS, ...REVIEW_REFUSED])];
    const accepted = [...new Set(candidates.map((v) => parseColorValue(v)).filter((v): v is string => v !== null))];
    const tab = await browser.newPage();
    try {
      const verdicts = await tab.evaluate((values: string[]) => values.map((v) => [v, CSS.supports('color', v)] as const), accepted);
      expect(verdicts.filter(([, ok]) => !ok).map(([v]) => v)).toEqual([]);
      // The sweep is wide enough to mean something: thousands of values, hundreds accepted.
      expect(candidates.length).toBeGreaterThan(10_000);
      expect(accepted.length).toBeGreaterThan(500);
    } finally {
      await tab.close();
    }
  });

  // Slice T2: the banner's guard judges a token through parseColor, so its numbers must be
  // what the browser paints. A 2D canvas in sRGB paints each value and reads the pixel
  // back, 8 bits a channel; a see-through pixel keeps little of its colour, so below half
  // opacity only the alpha is compared.
  it('parseColor gives the sRGB numbers the browser paints, for every value the grammar accepts', async () => {
    const candidates = [...new Set([...REVIEW_PROBE_VALUES, ...colorSweep(), ...ACCEPTED_COLORS, ...REVIEW_REFUSED])];
    const accepted = [...new Set(candidates.map((v) => parseColorValue(v)).filter((v): v is string => v !== null))];
    const tab = await browser.newPage();
    try {
      const painted = await tab.evaluate((values: string[]) => {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })!;
        return values.map((value) => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = '#00000000';
          context.fillStyle = value;
          context.fillRect(0, 0, 1, 1);
          return [value, [...context.getImageData(0, 0, 1, 1).data]] as const;
        });
      }, accepted);
      const misses: string[] = [];
      for (const [value, [r, g, b, a255]] of painted) {
        const ours = parseColor(value);
        if (!ours) {
          // The two forms parseColor declines to judge, on purpose (cssColorToRgba): the
          // engines paint them apart, so a guard must not trust either reading.
          const read = parseCssColor(value);
          const fraction = (c: ColorComponent) => (c.kind === 'none' ? 0 : c.kind === 'percent' ? c.value / 100 : c.value);
          const declined =
            read?.form === 'function' &&
            ((read.space === 'display-p3' && read.components.some((c) => fraction(c) < 0 || fraction(c) > 1)) ||
              (read.fn === 'hwb' && read.components.slice(1).some((c) => fraction(c) < 0)));
          if (!declined) misses.push(`${value}: parseColor read nothing`);
          continue;
        }
        const a = a255 / 255;
        const rgbClose = Math.abs(r - ours.r) <= 2 && Math.abs(g - ours.g) <= 2 && Math.abs(b - ours.b) <= 2;
        const close = Math.abs(a - ours.a) <= 1 / 255 + 0.001 && (a < 0.5 || rgbClose);
        if (!close) misses.push(`${value}: painted ${[r, g, b, a.toFixed(3)].join(' ')}, parseColor ${[ours.r, ours.g, ours.b].map((n) => n.toFixed(1)).join(' ')} ${ours.a.toFixed(3)}`);
      }
      expect(misses).toEqual([]);
      expect(accepted.length).toBeGreaterThan(500);
    } finally {
      await tab.close();
    }
  });

  it('every named colour reads as the value the table holds', async () => {
    const tab = await browser.newPage();
    try {
      const computed = await tab.evaluate((names: string[]) => names.map((name) => {
        const el = document.createElement('i');
        document.body.append(el);
        el.style.color = name;
        const value = getComputedStyle(el).color;
        el.remove();
        return [name, value] as const;
      }), Object.keys(NAMED_COLOR_HEX));
      for (const [name, value] of computed) {
        const { r, g, b } = parseColor(NAMED_COLOR_HEX[name as keyof typeof NAMED_COLOR_HEX])!;
        expect(`${name} ${value}`).toBe(`${name} rgb(${r}, ${g}, ${b})`);
      }
    } finally {
      await tab.close();
    }
  });

  // The canary: the same sheet with the grammar bypassed. If the detectors stayed silent
  // here, the passes above would prove nothing.
  it.each([
    ['closing brace', 'red}body{display:none'],
    ['style end', 'red</style><img src=x onerror=window.__ran=1>'],
    ['unclosed bracket', 'rgb(0 0 0;'],
  ])('the detectors see a %s when the grammar is bypassed', async (_label, value) => {
    const raw = themeCss(normalizeTheme(theme('#000000'))).replace('#000000', value);
    expect(raw).toContain(value);
    const seen = await observe(raw, 'light');
    const contained =
      JSON.stringify(seen.rules) === JSON.stringify(expectedRules(faces)) &&
      seen.sentinel === 'rgb(18, 52, 86)' &&
      seen.bodyBackground === seen.sentinel &&
      seen.bodyDisplay === 'block' &&
      !seen.ran;
    expect(contained).toBe(false);
  });

  it('forged ids, kinds and document entries never reach the sheet', async () => {
    const forged = {
      mode: 'system',
      tokens: [
        { id: 'x}body{display:none}:root{--y', name: 'a', kind: 'color', light: '#111' },
        { id: HOSTILE, name: 'b', kind: 'font', family: "x;}body{background:url('https://evil.test/f')}" },
        { id: 'dd000004', name: 'c', kind: '}body{display:none}', light: '#000' },
        { id: SENTINEL, name: 's', kind: 'color', light: '#123456', dark: '#654321' },
      ],
      document: { backgroundColor: `var(--fc-t-${SENTINEL})`, color: 'red;}html{display:none', fontFamily: `var(--fc-t-${HOSTILE})}</style><img src=x onerror=window.__ran=1>` },
    } as unknown as SiteTheme;
    for (const css of [themeCss(forged), themeCss(normalizeTheme(forged))]) {
      const seen = await observe(css, 'dark');
      expect(seen.rules).toEqual([':root', '@media (prefers-color-scheme: dark)', 'body']);
      expect(seen.sentinel).toBe('rgb(101, 67, 33)');
      expect(seen.bodyBackground).toBe('rgb(101, 67, 33)');
      expect(seen.bodyDisplay).toBe('block');
      expect(seen.ran).toBe(false);
      expect(seen.requests).toEqual([]);
    }
  });

  it('the surface sheet reaches only what sits inside its frame', async () => {
    const css = themeCss(normalizeTheme(theme('#000')), { scope: 'surface' });
    const context = await browser.newContext({ colorScheme: 'light' });
    try {
      const tab = await context.newPage();
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
<p id="outside" style="color:var(--fc-t-${SENTINEL}, rgb(1, 1, 1))">o</p>
<div data-fc-theme="frame"><p id="light" style="color:var(--fc-t-${SENTINEL})">l</p></div>
<div data-fc-theme="frame" data-fc-theme-mode="dark" id="darkframe"><p id="dark" style="color:var(--fc-t-${SENTINEL})">d</p></div>
<div data-fc-theme="floating" id="floating"><p>f</p></div></body></html>`;
      const requests: string[] = [];
      await tab.route('**/*', (route) => {
        if (route.request().url() === `${ORIGIN}/`) return route.fulfill({ status: 200, contentType: 'text/html', body: html });
        requests.push(route.request().url());
        return route.fulfill({ status: 204, body: '' });
      });
      await tab.goto(`${ORIGIN}/`);
      const seen = await tab.evaluate(() => {
        const style = (id: string) => getComputedStyle(document.getElementById(id)!);
        return {
          outside: style('outside').color,
          root: getComputedStyle(document.documentElement).getPropertyValue('--fc-t-bb000002'),
          rootScheme: getComputedStyle(document.documentElement).colorScheme,
          light: style('light').color,
          dark: style('dark').color,
          darkScheme: style('darkframe').colorScheme,
          floatingBackground: style('floating').backgroundColor,
          bodyBackground: getComputedStyle(document.body).backgroundColor,
        };
      });
      expect(seen).toEqual({
        outside: 'rgb(1, 1, 1)',
        root: '',
        rootScheme: 'normal',
        light: 'rgb(18, 52, 86)',
        dark: 'rgb(101, 67, 33)',
        darkScheme: 'dark',
        // Only a frame stands for a page, so a floating element takes no page background.
        floatingBackground: 'rgba(0, 0, 0, 0)',
        bodyBackground: 'rgba(0, 0, 0, 0)',
      });
      expect(requests).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
