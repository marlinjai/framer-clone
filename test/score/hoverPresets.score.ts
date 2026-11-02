// Moving the hover presets to shared classes must change nothing a visitor can see,
// because a page renders per request and the move reaches every live site at deploy.
// The "before" here is not rebuilt: test/score/data/hover-presets-before.html is what
// the tree in lib/hoverPresetPage.ts rendered to at commit fdc8289, with the old
// attribute and the old stylesheet. So this keeps its meaning once that code is gone.
// It counts for no row, on purpose: a failure stops the score, it does not lower it.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';
import { publishedDocument, renderThroughPublishedPage } from './lib/published';
import { HOVER_PROBES, renderHoverPage } from './lib/hoverPresetPage';

const BEFORE = fs.readFileSync(path.join(__dirname, 'data/hover-presets-before.html'), 'utf8');

/** Exactly what the move adds to the sheet, for the kinds on this page. */
const PRESET_TEXT = [
  '@media (hover:hover) and (pointer:fine) and (prefers-reduced-motion:no-preference){',
  '.fc_fx-lift{transition:translate 160ms ease,opacity 160ms ease}',
  '.fc_fx-lift:hover{translate:0 -2px}',
  '}',
  '@media (hover:hover) and (pointer:fine){',
  '.fc_fx-dim:hover{opacity:0.8}',
  '}',
  '@media (hover:hover) and (pointer:fine) and (prefers-reduced-motion:no-preference){',
  '.fc_fx-dim{transition:translate 160ms ease,opacity 160ms ease}',
  '}',
  '@media (hover:hover) and (pointer:fine){',
  '.fc_fx-underline:hover{text-decoration-line:underline;text-underline-offset:0.2em}',
  '}',
].join('\n');

const PROPERTIES = [
  'opacity',
  'translate',
  'text-decoration-line',
  'text-underline-offset',
  'background-image',
  'transition-property',
  'transition-duration',
  'transition-timing-function',
  'transition-delay',
  'width',
  'height',
] as const;

type Reading = Record<string, string>;

const documentOf = (html: string): string => publishedDocument({ html, css: '' });

/** Every probed property of one node. */
const read = (page: Page, id: string): Promise<Reading> =>
  page.locator(`[data-t="${id}"]`).evaluate((el, properties) => {
    const style = getComputedStyle(el);
    return Object.fromEntries(properties.map((name) => [name, style.getPropertyValue(name)]));
  }, [...PROPERTIES]);

/** Point at a node and wait for what that starts to end, so a value is never read halfway. */
const hovered = async (page: Page, id: string): Promise<Reading> => {
  const target = page.locator(`[data-t="${id}"]`);
  await target.hover();
  await target.evaluate((el) => Promise.allSettled(el.getAnimations().map((animation) => animation.finished)));
  return read(page, id);
};

describe('hover presets as shared rules', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('leaves the published HTML identical, apart from the attribute becoming a class and the hover text moving', async () => {
    const after = (await renderHoverPage()).html;
    expect(after).toContain(PRESET_TEXT);
    expect(after).not.toContain('data-fx-h');
    expect(BEFORE.match(/data-fx-h="\w+"/g)).toHaveLength(Object.keys(HOVER_PROBES).length);

    for (const [id, kind] of Object.entries(HOVER_PROBES)) {
      expect(BEFORE).toMatch(new RegExp(`<div data-t="${id}"[^>]*data-fx-h="${kind}"`));
      expect(after).toMatch(new RegExp(`<div data-t="${id}"[^>]*class="[^"]*fc_fx-${kind}"`));
    }
    // Only what this move claims. BEFORE cannot be captured again, so a later change to
    // the consent or font tags around the content must not read as a failure here.
    const ownParts = (html: string): (string | undefined)[] => [
      /<style data-fc-responsive="">[\s\S]*?<\/style>/.exec(html)?.[0],
      /<main[\s\S]*<\/main>/.exec(html)?.[0],
    ];
    const beforeBare = ownParts(BEFORE.replace(/ data-fx-h="\w+"/g, ''));
    const afterBare = ownParts(after.replace(`\n${PRESET_TEXT}`, '').replace(/ class="fc_fx-\w+"/g, '').replace(/ fc_fx-\w+/g, ''));
    expect(beforeBare.every(Boolean)).toBe(true);
    expect(afterBare).toEqual(beforeBare);
  });

  describe.each<[string, BrowserContextOptions, boolean]>([
    ['a desktop with a mouse', { viewport: { width: 1400, height: 900 } }, true],
    ['a tablet width with a mouse', { viewport: { width: 900, height: 900 } }, true],
    ['reduced motion', { viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' }, true],
    ['a touch screen', { viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true }, false],
  ])('on %s', (_profile, options, hasPointer) => {
    let before: Page;
    let after: Page;

    beforeAll(async () => {
      const context = await browser.newContext(options);
      before = await context.newPage();
      after = await context.newPage();
      await before.setContent(documentOf(BEFORE));
      await after.setContent(documentOf((await renderHoverPage()).html));
    });

    it('is the profile it says it is', async () => {
      expect(await after.evaluate(() => matchMedia('(hover:hover) and (pointer:fine)').matches)).toBe(hasPointer);
    });

    it.each(Object.keys(HOVER_PROBES))('%s reads the same at rest', async (id) => {
      expect(await read(after, id)).toEqual(await read(before, id));
    });

    it.each(Object.keys(HOVER_PROBES))('%s reads the same under the pointer', async (id) => {
      expect(await hovered(after, id)).toEqual(await hovered(before, id));
    });
  });

  // The comparison alone would pass if neither page did anything, so these say what it does.
  describe('what those values are', () => {
    const on = async (options: BrowserContextOptions): Promise<Page> => {
      const page = await (await browser.newContext(options)).newPage();
      await page.setContent(documentOf((await renderHoverPage()).html));
      return page;
    };
    const desktop = { viewport: { width: 1400, height: 900 } };

    it('each kind acts under a mouse', async () => {
      const page = await on(desktop);
      expect((await read(page, 'dim')).opacity).toBe('1');
      expect((await read(page, 'dim'))['transition-duration']).toBe('0.16s, 0.16s');
      expect((await hovered(page, 'dim')).opacity).toBe('0.8');
      expect((await read(page, 'lift')).translate).toBe('none');
      expect((await hovered(page, 'lift')).translate).toBe('0px -2px');
      const underline = await hovered(page, 'underline');
      expect(underline['text-decoration-line']).toBe('underline');
      expect(underline['text-underline-offset']).toBe('3.2px');
    });

    it('a preset ties a responsive value in the sheet and wins, and loses to one held inline', async () => {
      const page = await on(desktop);
      expect((await hovered(page, 'inline-opacity')).opacity).toBe('0.5');
      expect((await read(page, 'class-opacity')).opacity).toBe('0.5');
      expect((await hovered(page, 'class-opacity')).opacity).toBe('0.8');
      expect((await read(page, 'class-translate')).translate).toBe('4px 4px');
      expect((await hovered(page, 'class-translate')).translate).toBe('0px -2px');
      expect((await hovered(page, 'class-transition'))['transition-property']).toBe('color');
    });

    it('the sentinel keeps its refused background, its own transition and its own translate', async () => {
      const page = await on(desktop);
      const sentinel = await hovered(page, 'sentinel');
      expect(sentinel['background-image']).toContain('data:image/svg+xml');
      expect(sentinel['transition-property']).toBe('color');
      expect(sentinel['transition-duration']).toBe('1s');
      expect(sentinel.translate).toBe('3px 4px');
    });

    it('under reduced motion lift stands still and has no transition, dim and underline still show', async () => {
      const page = await on({ ...desktop, reducedMotion: 'reduce' });
      const lift = await hovered(page, 'lift');
      expect(lift.translate).toBe('none');
      expect(lift['transition-duration']).toBe('0s');
      const dim = await hovered(page, 'dim');
      expect(dim.opacity).toBe('0.8');
      expect(dim['transition-duration']).toBe('0s');
      expect((await hovered(page, 'underline'))['text-decoration-line']).toBe('underline');
    });

    it('a touch screen shows none of it', async () => {
      const page = await on({ viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true });
      expect((await hovered(page, 'dim')).opacity).toBe('1');
      expect((await hovered(page, 'lift')).translate).toBe('none');
      expect((await hovered(page, 'underline'))['text-decoration-line']).toBe('none');
    });
  });

  it('a person\'s own Hover beats the preset, and adding it is what moves Normal', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tree = {
      id: 'root',
      type: 'main',
      props: { style: { padding: '8px' } },
      children: [
        {
          id: 'mine',
          type: 'div',
          props: {
            'data-t': 'mine',
            style: { width: '120px', height: '40px', opacity: 0.9 },
            effects: { hover: 'dim' },
            rules: [{ id: 'r', selector: '&:hover', style: { opacity: 0.3 } }],
          },
        },
      ],
    };
    const { html } = await renderThroughPublishedPage({ tree, definitions: {} });
    expect(html).toContain('.fc-mine.fc-mine{width:120px;height:40px;opacity:0.9}');
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    await page.setContent(documentOf(html));
    expect((await read(page, 'mine')).opacity).toBe('0.9');
    expect((await hovered(page, 'mine')).opacity).toBe('0.3');
  });
});
