// The browser page base (src/lib/site/pageBase.ts) as a gate: it counts for no row, and
// a failure stops the run. The corpus shows it works for what the fixtures hold. This
// goes wider: every kind of control the reset touches, what the markup says through
// presentational hints, and the editor surfaces, which must show what a visitor gets.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { FIXTURES } from './corpus/fixtures';
import { publishedDocument, renderPublished } from './lib/published';
import { bundleEditor, mountOnCanvas } from './lib/canvasBundle';
import { diffComputed, takeSnapshot, type Snapshot } from './lib/compare';
import { SYSTEM_FONT_STACK } from '@/lib/fonts/registry';

/** What the reset reaches. Each element carries a marker, so the corpus comparison reads it. */
const SPECIMEN = [
  '<h1>h</h1><h4>h</h4><p align="right">p</p><small>s</small><sub>s</sub><sup>s</sup><abbr title="t">a</abbr><b>b</b><code>c</code><pre>p</pre><kbd>k</kbd><samp>s</samp>',
  '<a href="#x">a</a><hr size="5" noshade><ul><li>l</li></ul><ol><li>l</li></ol><menu><li>l</li></menu><blockquote>b</blockquote><dl><dt>t</dt><dd>d</dd></dl>',
  '<table border="3" width="200" cellpadding="7"><caption>c</caption><tr><th>t</th><td bgcolor="#ff0000" align="center">d</td></tr></table>',
  '<img width="33" height="44" alt="i" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><video width="40" height="30"></video><canvas width="40" height="30"></canvas><iframe width="40" height="30" title="f"></iframe>',
  '<svg width="50" height="40" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="red" stroke="blue" stroke-width="2"></circle></svg>',
  '<details open><summary>s</summary>d</details><progress value="1" max="2"></progress><meter value="1" max="2"></meter><dialog open>d</dialog><fieldset><legend>l</legend></fieldset>',
  '<button>b</button><button disabled>b</button><textarea>t</textarea><select><option>o</option></select><select multiple size="2"><optgroup label="g"><option>o</option></optgroup></select>',
  ...['text', 'number', 'search', 'date', 'time', 'datetime-local', 'range', 'checkbox', 'radio', 'file', 'color', 'submit', 'reset', 'button'].map((type) => `<input type="${type}" placeholder="p">`),
].join('');

const marked = (html: string): string => {
  let index = 0;
  return html.replace(/<(?!\/)([a-z0-9]+)/g, (tag) => `${tag} data-parity-id="s-${index++}"`);
};

describe('the browser page base', () => {
  let browser: Browser;
  let bundle: string;

  beforeAll(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    browser = await chromium.launch();
    bundle = await bundleEditor();
  });
  afterAll(async () => {
    await browser?.close();
  });

  const snapshotOf = async (html: string): Promise<Snapshot> => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.setContent(html);
    await page.waitForFunction(() => document.querySelector('[data-parity-id]') !== null);
    const snapshot = await takeSnapshot(page);
    await page.close();
    return snapshot;
  };

  it('gives every element what a plain document gives it, and keeps what the markup says', async () => {
    const html = marked(SPECIMEN);
    // The body's margin and the site layout's font are the two things a published page keeps.
    const plain = await snapshotOf(`<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body style="margin:0;font-family:${SYSTEM_FONT_STACK.replace(/"/g, "'")}">${html}</body></html>`);
    const published = await snapshotOf(publishedDocument({ html, css: '' }, 'browser'));
    const diff = diffComputed(plain.computed, published.computed);
    expect(diff.byProperty, diff.firstDetail).toEqual({});
    expect(Object.keys(plain.computed).length).toBeGreaterThan(50);
  });

  it('changes nothing on a site that did not choose it', async () => {
    const page = await browser.newPage();
    await page.setContent(publishedDocument({ html: '<h1 data-parity-id="h">h</h1>', css: '' }));
    expect(await page.locator('[data-fc-page-base]').count()).toBe(0);
    expect(await page.locator('h1').evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px');
    await page.close();
  });

  describe('on the editor surfaces', () => {
    const setBase = async (page: Page, base: 'reset' | 'browser') => {
      await page.evaluate((value) => (window as unknown as { __editor: { setPageBase: (base: string) => void } }).__editor.setPageBase(value), base);
      await page.waitForTimeout(50);
    };
    /** Every computed value of the matched elements under a frame. */
    const readFrame = (page: Page, root: string) =>
      page.evaluate((scope) => {
        const out: Record<string, Record<string, string>> = {};
        document.querySelectorAll(`${scope} [data-parity-id]`).forEach((element) => {
          const style = getComputedStyle(element);
          const read: Record<string, string> = {};
          for (let i = 0; i < style.length; i++) read[style[i]] = style.getPropertyValue(style[i]);
          out[element.getAttribute('data-parity-id') as string] = read;
        });
        return out;
      }, root);
    /**
     * What the frame or the editor decides there, and not the page: the frame's width
     * and what comes of it, and the properties the canvas writes inline so a node can
     * be selected. Custom properties are the reset's bookkeeping.
     */
    const belongsToTheSurface = (name: string) =>
      name.startsWith('--') ||
      /^(width|height|inline-size|block-size|perspective-origin|transform-origin|grid-template-(rows|columns))$/.test(name) ||
      /^(cursor|pointer-events|user-select|-webkit-user-select|-webkit-touch-callout|-webkit-user-modify|outline(-.*)?|caret-color)$/.test(name);

    const differences = (want: Record<string, Record<string, string>>, got: Record<string, Record<string, string>>): string[] => {
      const found: string[] = [];
      for (const [id, styles] of Object.entries(want)) {
        if (!got[id]) {
          found.push(`${id}: not on the surface`);
          continue;
        }
        for (const [name, value] of Object.entries(styles)) {
          if (!belongsToTheSurface(name) && got[id][name] !== value) found.push(`${id}: ${name} ${value} became ${got[id][name]}`);
        }
      }
      return found;
    };

    // The canvas holds an animation at rest on purpose (surfaces.ts), so keyframes is left out.
    it.each(FIXTURES.filter((f) => !f.published && f.id !== 'keyframes').map((f) => f.id))('%s: the canvas shows what the visitor gets', async (id) => {
      const tree = FIXTURES.find((f) => f.id === id)!.tree();
      const canvas = await mountOnCanvas(browser, bundle, tree);
      await setBase(canvas, 'browser');
      // One frame is kept, and the visitor's window gets its width, so what answers to a width answers alike.
      const width = await canvas.locator('[data-viewport-content-id]').evaluate((frame) => (frame as HTMLElement).offsetWidth);
      const published = await browser.newPage({ viewport: { width, height: 800 } });
      await published.setContent(publishedDocument(renderPublished(tree), 'browser'));
      const want = await readFrame(published, 'body');
      await published.close();

      expect(differences(want, await readFrame(canvas, '[data-viewport-content-id]'))).toEqual([]);
      await canvas.close();
    });

    it('leaves the editor around the frame as it was', async () => {
      const tree = FIXTURES.find((f) => f.id === 'mixed-text')!.tree();
      const canvas = await mountOnCanvas(browser, bundle, tree);
      const chrome = () =>
        canvas.evaluate(() =>
          [...document.querySelectorAll('button, h1, h2, ul, p')]
            .filter((element) => !element.closest('[data-viewport-content-id], [data-floating-root-id], [data-preview-frame]'))
            .slice(0, 40)
            .map((element) => {
              const style = getComputedStyle(element);
              return [style.boxSizing, style.borderTopStyle, style.marginTop, style.fontSize, style.listStyleType].join(' ');
            }),
        );
      const before = await chrome();
      expect(before.length).toBeGreaterThan(5);
      await setBase(canvas, 'browser');
      expect(await chrome()).toEqual(before);
      await canvas.close();
    });

    it('the preview shows it too', async () => {
      const tree = FIXTURES.find((f) => f.id === 'mixed-text')!.tree();
      const published = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await published.setContent(publishedDocument(renderPublished(tree), 'browser'));
      const want = await readFrame(published, 'body');
      await published.close();

      const canvas = await mountOnCanvas(browser, bundle, tree);
      await setBase(canvas, 'browser');
      await canvas.evaluate(() => (window as unknown as { __editor: { setPreviewOpen: (open: boolean) => void } }).__editor.setPreviewOpen(true));
      await canvas.locator('[data-preview-frame] [data-parity-id="title"]').first().waitFor({ state: 'attached' });
      expect(differences(want, await readFrame(canvas, '[data-preview-frame]'))).toEqual([]);
      await canvas.close();
    });
  });
});
