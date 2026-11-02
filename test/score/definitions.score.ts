// What a definition does, which only a browser can say. The matrix proves the text
// reached the sheet and that Chromium parsed the sample. Here each definition has to
// change what the page does, through the real published path, and two promises are
// held against the real thing: a stored definition cannot replace a name the editor
// uses, read from the editor's own stylesheet, and no definition can make a request
// leave the site. Each of those has a control that shows the check can fail.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { compile } from 'tailwindcss';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { FONT_LIBRARY } from '@/lib/fonts/registry';
import { PROPERTY_SYNTAXES, parseRule } from '@/lib/rules/rules';
import { publishedDocument, renderPublished } from './lib/published';

const ROOT = path.resolve(__dirname, '../..');
const SITE = 'http://site.test';

const node = (id: string, props: Record<string, unknown>, children?: ComponentNode[]): ComponentNode =>
  ({ id, type: 'div', props: { 'data-t': id, ...props }, ...(children ? { children } : {}) }) as ComponentNode;

/** The editor's real stylesheet: globals.css through Tailwind, plus what the packages it mounts bring. */
async function editorStylesheet(): Promise<string> {
  const entry = path.join(ROOT, 'src/app/globals.css');
  const compiler = await compile(fs.readFileSync(entry, 'utf8'), {
    base: path.dirname(entry),
    loadStylesheet: async (id, base) => {
      const file = id === 'tailwindcss' ? 'node_modules/tailwindcss/index.css' : id === 'tw-animate-css' ? 'node_modules/tw-animate-css/dist/tw-animate.css' : id;
      const resolved = file.startsWith('node_modules') ? path.join(ROOT, file) : path.resolve(base, file);
      return { path: resolved, base: path.dirname(resolved), content: fs.readFileSync(resolved, 'utf8') };
    },
  });
  // Tailwind writes a keyframe or an @property rule only for a utility that uses it.
  const candidates = ['animate-spin', 'animate-pulse', 'animate-ping', 'animate-bounce', 'animate-in', 'animate-out', 'rotate-x-1', 'shadow-sm', 'translate-x-1'];
  const packages = path.join(ROOT, 'node_modules/@marlinjai');
  const packaged = fs
    .readdirSync(packages)
    .flatMap((name) => {
      const dist = path.join(packages, name, 'dist');
      return fs.existsSync(dist) ? fs.readdirSync(dist).filter((file) => file.endsWith('.css')).map((file) => path.join(dist, file)) : [];
    })
    .map((file) => fs.readFileSync(file, 'utf8'));
  const platform = fs.readFileSync(path.join(ROOT, 'src/lib/renderer/forms/FormIsland.tsx'), 'utf8');
  return [compiler.build(candidates), ...packaged, ...(platform.match(/@keyframes [\w-]+\{[^']*/g) ?? [])].join('\n');
}

const namesOf = (sheet: string, atRule: string): string[] =>
  [...new Set([...sheet.matchAll(new RegExp(`@${atRule}\\s+([\\w-]+)`, 'g'))].map((match) => match[1]))];

describe('definitions in real Chromium', () => {
  let browser: Browser;
  let page: Page;
  /** Every request the page made past its own document, whatever it asked for. */
  let requests: string[];
  const fonts: Record<string, string> = { '/regular.ttf': 'assets/fonts/DejaVuSans.ttf', '/bold.ttf': 'assets/fonts/DejaVuSans-Bold.ttf' };

  const showDocument = async (html: string): Promise<void> => {
    await page.route(`${SITE}/`, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
    await page.goto(`${SITE}/`);
    await page.evaluate(() => document.fonts.ready);
  };

  const show = async (tree: ComponentNode): Promise<string> => {
    const published = renderPublished(tree);
    await showDocument(publishedDocument(published));
    return published.css;
  };

  const box = (id: string) => page.locator(`[data-t="${id}"]`);

  beforeAll(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    browser = await chromium.launch();
  });
  beforeEach(async () => {
    await page?.close();
    page = await browser.newPage();
    requests = [];
    await page.route('**/*', (route) => {
      const { pathname, origin } = new URL(route.request().url());
      requests.push(route.request().url());
      const font = origin === SITE ? fonts[pathname] : undefined;
      if (font) return route.fulfill({ contentType: 'font/ttf', body: fs.readFileSync(path.join(ROOT, font)) });
      return route.abort();
    });
  });
  afterAll(async () => {
    await browser?.close();
  });

  describe('each definition does what it says', () => {
    it('@keyframes: a stored animation runs from a stored keyframe, at the point the clock says', async () => {
      await show(
        node('dot', {
          style: { width: '10px', height: '10px', animation: 'u-fade 1s linear infinite' },
          rules: [{ id: 'k', define: '@keyframes u-fade', blocks: [{ selector: 'from', style: { opacity: 1 } }, { selector: 'to', style: { opacity: 0 } }] }],
        }),
      );
      const opacity = await box('dot').evaluate((el) => {
        const [animation] = el.getAnimations();
        animation.pause();
        animation.currentTime = 250;
        return getComputedStyle(el).opacity;
      });
      expect(Number(opacity)).toBeCloseTo(0.75);
    });

    it('@font-face: Regular and Bold of one family both load and both render', async () => {
      const regular = { id: 'regular', define: '@font-face', style: { fontFamily: 'u-brand', src: 'url(/regular.ttf)', fontWeight: 400 } };
      const bold = { id: 'bold', define: '@font-face', style: { fontFamily: 'u-brand', src: 'url(/bold.ttf)', fontWeight: 700 } };
      const line = (id: string, fontWeight: number) => node(id, { style: { fontFamily: 'u-brand', fontWeight, fontSize: '40px', display: 'inline-block' }, children: 'Hamburgefonstiv' });
      await show(node('page', { rules: [regular] }, [node('other', { rules: [bold] }), line('light', 400), line('heavy', 700)]));

      expect(requests.filter((url) => url.endsWith('.ttf')).sort()).toEqual([`${SITE}/bold.ttf`, `${SITE}/regular.ttf`]);
      const faces = await page.evaluate(() => [...document.fonts].map((face) => `${face.family} ${face.weight} ${face.status}`).sort());
      expect(faces).toEqual(['u-brand 400 loaded', 'u-brand 700 loaded']);
      // Synthesised bold keeps the Regular's advances, so different widths mean the real Bold drew it.
      const light = await box('light').evaluate((el) => el.getBoundingClientRect().width);
      const heavy = await box('heavy').evaluate((el) => el.getBoundingClientRect().width);
      expect(heavy - light).toBeGreaterThan(10);
    });

    it('@property: the escaped syntax registers, so the type and inheritance hold', async () => {
      await show(
        node(
          'parent',
          {
            style: { '--u-gap': '2em', fontSize: '10px' },
            rules: [
              { id: 'p', define: '@property --u-gap', style: { syntax: '"<length>"', inherits: 'false', initialValue: '3px' } },
              { id: 'q', define: '@property --u-tint', style: { syntax: '"<color>"', inherits: 'false', initialValue: 'red' } },
            ],
          },
          [node('child', {})],
        ),
      );
      const read = (id: string, name: string) => box(id).evaluate((el, property) => getComputedStyle(el).getPropertyValue(property), name);
      expect(await read('parent', '--u-gap')).toBe('20px'); // A length, so it computes. An unregistered name stays `2em`.
      expect(await read('child', '--u-gap')).toBe('3px'); // inherits:false, so the initial value.
      expect(await read('child', '--u-tint')).toBe('rgb(255, 0, 0)'); // A colour, so it computes. Text would stay `red`.
    });

    it('@property: Chromium registers every syntax on the list', async () => {
      const samples: Record<string, string> = {
        '"*"': 'x',
        '"<angle>"': '1deg',
        '"<color>"': 'red',
        '"<custom-ident>"': 'x',
        '"<integer>"': '1',
        '"<length>"': '1px',
        '"<length-percentage>"': '1%',
        '"<number>"': '1.5',
        '"<percentage>"': '1%',
        '"<resolution>"': '1dppx',
        '"<time>"': '1s',
        '"<transform-function>"': 'scale(1)',
        '"<transform-list>"': 'scale(1) scale(2)',
      };
      expect(Object.keys(samples).sort()).toEqual([...PROPERTY_SYNTAXES].sort());
      const rules = Object.entries(samples).map(([syntax, initialValue], index) => ({ id: `s${index}`, define: `@property --u-s${index}`, style: { syntax, inherits: 'false', initialValue } }));
      await show(node('n', { rules }));
      const registered = await page.evaluate(() =>
        [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]).filter((rule) => rule instanceof CSSPropertyRule).map((rule) => (rule as CSSPropertyRule).syntax),
      );
      expect(registered.map((syntax) => `"${syntax}"`).sort()).toEqual(Object.keys(samples).sort());
    });

    it('@counter-style: a list counts in stored symbols', async () => {
      const list = (id: string, symbols: string) =>
        node('wrap', { rules: [{ id: id, define: `@counter-style ${id}`, style: { system: 'cyclic', symbols, suffix: '""' } }] }, [
          node(id, { style: { display: 'inline-block', counterReset: 'c', fontSize: '40px' }, rules: [{ id: 'b', selector: '&::before', style: { content: `counter(c, ${id})` } }] }),
        ]);
      await show(node('page', {}, [list('u-wide', '"WWWW"'), list('u-thin', '"i"')]));
      const width = (id: string) => box(id).evaluate((el) => el.getBoundingClientRect().width);
      expect(await width('u-wide')).toBeGreaterThan((await width('u-thin')) * 4);
    });

    it('@position-try: an element that overflows moves to the stored fallback', async () => {
      await show(
        node(
          'page',
          { style: { position: 'relative' }, rules: [{ id: 't', define: '@position-try --u-under', style: { top: 'anchor(bottom)', bottom: 'auto' } }] },
          [
            node('anchor', { style: { anchorName: '--a', position: 'absolute', top: '0', left: '0', width: '40px', height: '40px' } }),
            node('tip', { style: { positionAnchor: '--a', position: 'fixed', left: '0', bottom: 'anchor(top)', width: '40px', height: '40px', positionTryFallbacks: '--u-under' } }),
          ],
        ),
      );
      expect(await box('tip').evaluate((el) => el.getBoundingClientRect().top)).toBe(40);
    });

    it('@font-feature-values and @font-palette-values: Chromium keeps both and a style can name them', async () => {
      await show(
        node('n', {
          style: { fontFamily: 'u-brand', fontVariantAlternates: 'styleset(nice)', fontPalette: '--u-warm' },
          rules: [
            { id: 'f', define: '@font-feature-values u-brand', blocks: [{ selector: '@styleset', style: { nice: 1 } }] },
            { id: 'p', define: '@font-palette-values --u-warm', style: { fontFamily: 'u-brand', basePalette: 1 } },
          ],
        }),
      );
      const kept = await page.evaluate(() =>
        [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]).map((rule) => rule.constructor.name).sort(),
      );
      expect(kept).toEqual(['CSSFontFeatureValuesRule', 'CSSFontPaletteValuesRule']);
      expect(await box('n').evaluate((el) => getComputedStyle(el).fontPalette)).toBe('--u-warm');
    });
  });

  describe('a stored definition against the editor', () => {
    let editor: string;
    const keyframesOf = (id: string) => box(id).evaluate((el) => (el.getAnimations()[0]?.effect as KeyframeEffect | undefined)?.getKeyframes().map((frame) => JSON.stringify(frame)));

    beforeAll(async () => {
      editor = await editorStylesheet();
    });

    it('reads real names from the editor, so the next checks are not vacuous', () => {
      expect(namesOf(editor, 'keyframes')).toEqual(expect.arrayContaining(['spin', 'pulse', 'ping', 'bounce', 'enter', 'exit', 'fc-form-spin']));
      expect(namesOf(editor, 'property')).toEqual(expect.arrayContaining(['--tw-rotate-x']));
    });

    it('uses no reserved name itself: every u- name is free for a stored definition', () => {
      for (const atRule of ['keyframes', 'property', 'counter-style', 'position-try', 'font-palette-values', 'font-feature-values']) {
        expect(namesOf(editor, atRule).filter((name) => /^(?:--)?u-/.test(name))).toEqual([]);
      }
      expect(FONT_LIBRARY.filter((family) => /^u-/i.test(family.cssFamily))).toEqual([]);
    });

    it('refuses every name the editor defines, at every at-rule that could take it', () => {
      const body = {
        keyframes: { blocks: [{ selector: 'to', style: { opacity: 0 } }] },
        property: { style: { syntax: '"*"', inherits: 'false' } },
      };
      const accepted = [
        ...namesOf(editor, 'keyframes').map((name) => ({ id: 'r', define: `@keyframes ${name}`, ...body.keyframes })),
        ...namesOf(editor, 'property').map((name) => ({ id: 'r', define: `@property ${name}`, ...body.property })),
        ...FONT_LIBRARY.map((family) => ({ id: 'r', define: '@font-face', style: { fontFamily: `"${family.cssFamily}"`, src: 'url(/x.woff2)' } })),
      ].filter((rule) => parseRule(rule).ok);
      expect(accepted).toEqual([]);
    });

    it('leaves the running editor animation alone, with a control that shows a replacement would be seen', async () => {
      const probe = '<div data-t="spinner" class="animate-spin" style="width:10px;height:10px"></div>';
      const withEditor = (css: string) => `<!doctype html><html><head><meta charset="utf-8"><style>${editor}</style><style>${css}</style></head><body>${probe}</body></html>`;
      const stored = renderPublished(
        node('n', {
          rules: [
            { id: 'a', define: '@keyframes spin', blocks: [{ selector: 'to', style: { opacity: 0 } }] },
            { id: 'b', define: '@keyframes u-spin', blocks: [{ selector: 'to', style: { opacity: 0 } }] },
          ],
        }),
      );
      expect(stored.css).toContain('@keyframes u-spin');
      expect(stored.css).not.toContain('@keyframes spin');

      await showDocument(withEditor(''));
      const untouched = await keyframesOf('spinner');
      expect(untouched?.join()).toContain('rotate');

      await page.unroute(`${SITE}/`);
      await showDocument(withEditor(stored.css));
      expect(await keyframesOf('spinner')).toEqual(untouched);

      // The attack as plain CSS: the same name in a later sheet does replace it.
      await page.unroute(`${SITE}/`);
      await showDocument(withEditor('@keyframes spin{to{opacity:0}}'));
      expect(await keyframesOf('spinner')).not.toEqual(untouched);
    });

    it('cannot retype a platform variable or restyle a built-in list marker', async () => {
      const page_ = node('n', {
        style: { '--tw-rotate-x': 'x' },
        rules: [
          { id: 'a', define: '@property --tw-rotate-x', style: { syntax: '"<color>"', inherits: 'false', initialValue: 'red' } },
          { id: 'b', define: '@counter-style decimal', style: { system: 'cyclic', symbols: '"*"' } },
          { id: 'c', define: '@counter-style disc', style: { system: 'cyclic', symbols: '"*"' } },
        ],
      });
      expect(await show(page_)).toBe('');
    });
  });

  describe('an external address in a definition', () => {
    const faceSrc = (src: string) => ({ id: 'r', define: '@font-face', style: { fontFamily: 'u-evil', src } });
    const frame = (style: Record<string, unknown>) => ({ id: 'r', define: '@keyframes u-evil', blocks: [{ selector: 'to', style }] });

    const attempts: [string, unknown][] = [
      ['a font on another host', faceSrc('url(https://evil.test/a.woff2)')],
      ['a quoted font', faceSrc('url("https://evil.test/a.woff2")')],
      ['an upper-case URL(', faceSrc('URL(https://evil.test/a.woff2)')],
      ['a protocol-relative font', faceSrc('url(//evil.test/a.woff2)')],
      ['a tab in the slashes', faceSrc('url("/\t/evil.test/a.woff2")')],
      ['a font after a local one', faceSrc('local("Arial"), url(https://evil.test/a.woff2)')],
      ['a font in format()', faceSrc('url(https://evil.test/a.woff2) format("woff2")')],
      ['src() with a string', faceSrc('src("https://evil.test/a.woff2")')],
      ['a keyframe background', frame({ backgroundImage: 'url(https://evil.test/k.png)' })],
      ['a bare string in image-set()', frame({ backgroundImage: 'image-set("https://evil.test/k.png" 1x)' })],
      ['-webkit-image-set()', frame({ backgroundImage: '-webkit-image-set("https://evil.test/k.png" 1x)' })],
      ['a border image in cross-fade()', frame({ borderImageSource: 'cross-fade(url(https://evil.test/k.png), url(/a.png))' })],
      ['a var() inside image-set()', frame({ backgroundImage: 'image-set(var(--x) 1x)' })],
      ['a mask', frame({ maskImage: 'url(https://evil.test/k.png)' })],
      ['a counter symbol', { id: 'r', define: '@counter-style u-evil', style: { system: 'cyclic', symbols: 'url(https://evil.test/c.png)' } }],
      ['@property initial-value', { id: 'r', define: '@property --u-evil', style: { syntax: '"*"', inherits: 'false', initialValue: 'url(https://evil.test/p.png)' } }],
    ];

    it.each(attempts)('refuses %s, and nothing leaves the site', async (_, rule) => {
      expect(parseRule(rule)).toMatchObject({ ok: false });
      const css = await show(
        node('n', {
          style: { fontFamily: 'u-evil', animation: 'u-evil 1s linear infinite', listStyleType: 'u-evil', backgroundImage: 'var(--u-evil)' },
          children: 'text',
          rules: [rule],
        }),
      );
      expect(css).not.toContain('evil.test');
      expect(requests).toEqual([]);
    });

    it('sees such a request when one happens, and a site path is still allowed', async () => {
      // The same page, as plain CSS, so a missed refusal could not pass unnoticed.
      await showDocument(
        '<!doctype html><meta charset="utf-8"><style>@font-face{font-family:u-x;src:url(https://evil.test/a.woff2)}</style><div style="font-family:u-x">text</div>',
      );
      expect(requests).toContain('https://evil.test/a.woff2');

      await page.unroute(`${SITE}/`);
      requests.length = 0;
      await show(node('n', { style: { fontFamily: 'u-ok' }, children: 'text', rules: [{ id: 'r', define: '@font-face', style: { fontFamily: 'u-ok', src: 'url(/regular.ttf)' } }] }));
      expect(requests).toEqual([`${SITE}/regular.ttf`]);
    });
  });

  describe('the <style> element', () => {
    it.each<[string, unknown]>([
      ['a name', { id: 'r', define: '@keyframes u-x</style><script>window.ran=1</script>', blocks: [{ selector: 'to', style: { opacity: 0 } }] }],
      ['a block', { id: 'r', define: '@keyframes u-x', blocks: [{ selector: 'to{}</style><script>window.ran=1</script>', style: { opacity: 0 } }] }],
      ['a syntax', { id: 'r', define: '@property --u-x', style: { syntax: '"</style><script>window.ran=1</script>"', inherits: 'false' } }],
    ])('stays closed against %s', async (_, rule) => {
      const css = await show(node('n', { rules: [rule] }));
      expect(css).toBe('');
      expect(await page.evaluate(() => (window as unknown as { ran?: number }).ran)).toBeUndefined();
    });

    it('holds a value that tries it as text, escaped', async () => {
      const css = await show(node('n', { rules: [{ id: 'r', define: '@counter-style u-x', style: { system: 'cyclic', symbols: '"</style><b data-t=out>"' } }] }));
      expect(css).toContain('\\3c /style>');
      expect(css).not.toContain('<');
      expect(await box('out').count()).toBe(0);
      expect(await page.evaluate(() => [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]).length)).toBe(1);
    });
  });
});
