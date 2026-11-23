// The custom code editor field in real browsers (slice C4 of
// docs/plans/2026-11-02-sandboxed-custom-code.md, D112): the real CodeMirror field of the
// Custom code section, bundled from customCodeEditor.entry.ts. A person on a keyboard
// reaches it with Tab, types, indents with Mod-] and leaves it with Tab and Shift+Tab, so
// nobody is trapped in it; a screen reader gets its name and its description; read-only
// takes no typing. Chromium and WebKit, as the render gate job installs both.
//
// Every case ends on an expectation about the page (the focused element, the text, the
// changes reported), never on a timeout.

import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { chromium, webkit, type Browser, type BrowserType, type Page } from 'playwright';

let bundle = '';

beforeAll(async () => {
  const result = await build({
    entryPoints: [path.resolve(__dirname, 'customCodeEditor.entry.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    alias: { '@': path.resolve(__dirname, '../../src') },
  });
  bundle = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
});

const PAGE = () => `<!doctype html><html><head><meta charset="utf-8"></head><body>
<button id="before">Before</button>
<div id="editor"></div>
<p id="hint">Tab moves on to the next field.</p>
<button id="after">After</button>
<script>${bundle}</script>
</body></html>`;

const focused = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  return el?.id || (el?.classList.contains('cm-content') ? 'editor' : el?.tagName ?? 'none');
});

describe.each([
  ['chromium', chromium],
  ['webkit', webkit],
] as [string, BrowserType][])('the code field in %s', (_name, type) => {
  let browser: Browser;
  let page: Page;
  // WebKit moves the focus to buttons with Tab only when told to (Alt+Tab otherwise, as Safari).
  const tab = (name: string) => (name === 'webkit' ? 'Alt+Tab' : 'Tab');
  const shiftTab = (name: string) => (name === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab');
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

  beforeAll(async () => {
    browser = await type.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function open() {
    page = await browser.newPage();
    await page.setContent(PAGE());
    await page.waitForSelector('.cm-content');
  }

  it('names the editable content and points at the hint', async () => {
    await open();
    const content = page.locator('.cm-content');
    expect(await content.getAttribute('aria-label')).toBe('Code of Clock');
    expect(await content.getAttribute('aria-describedby')).toBe('hint');
    expect(await content.getAttribute('aria-multiline')).toBe('true');
    expect(await content.getAttribute('role')).toBe('textbox');
    await page.close();
  });

  it('is reached with Tab, takes typing, keeps a typed Tab out, and is left with Tab and Shift+Tab', async () => {
    await open();
    await page.focus('#before');
    await page.keyboard.press(tab(_name));
    expect(await focused(page)).toBe('editor');
    await page.keyboard.press(`${mod}+End`);
    await page.keyboard.type(' tick');
    expect(await page.evaluate(() => (window as unknown as { __changes: string[] }).__changes.at(-1))).toBe('<p>one</p> tick');
    // Tab leaves the field and inserts nothing.
    await page.keyboard.press(tab(_name));
    expect(await focused(page)).toBe('after');
    expect(await page.evaluate(() => (window as unknown as { __changes: string[] }).__changes.at(-1))).toBe('<p>one</p> tick');
    await page.keyboard.press(shiftTab(_name));
    expect(await focused(page)).toBe('editor');
    await page.keyboard.press(shiftTab(_name));
    expect(await focused(page)).toBe('before');
    await page.close();
  });

  it('indents with Mod-] and undoes with Mod-z', async () => {
    await open();
    await page.click('.cm-content');
    await page.keyboard.press(`${mod}+]`);
    const indented = await page.evaluate(() => (window as unknown as { __changes: string[] }).__changes.at(-1));
    expect(indented).toMatch(/^\s+<p>one<\/p>$/);
    await page.keyboard.press(`${mod}+z`);
    expect(await page.evaluate(() => (window as unknown as { __changes: string[] }).__changes.at(-1))).toBe('<p>one</p>');
    await page.close();
  });

  it('takes no typing while read-only, and does again after', async () => {
    await open();
    await page.evaluate(() => (window as unknown as { __handle: { setReadOnly(v: boolean): void } }).__handle.setReadOnly(true));
    expect(await page.locator('.cm-content').getAttribute('contenteditable')).toBe('false');
    await page.click('.cm-content');
    await page.keyboard.type('zzz');
    expect(await page.evaluate(() => (window as unknown as { __changes: string[] }).__changes)).toEqual([]);
    await page.evaluate(() => (window as unknown as { __handle: { setReadOnly(v: boolean): void } }).__handle.setReadOnly(false));
    await page.click('.cm-content');
    await page.keyboard.type('y');
    expect(await page.evaluate(() => (window as unknown as { __changes: string[] }).__changes.length)).toBe(1);
    await page.close();
  });
});
