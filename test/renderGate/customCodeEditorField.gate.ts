// The Custom code section's field component in real browsers (slice C4 of
// docs/plans/2026-11-02-sandboxed-custom-code.md, D112), bundled from
// customCodeEditorField.entry.tsx with React: CodeMirror takes the plain field's place, keeps
// the value, and its accessible name follows the block's title as the title changes (a new
// block starts as "Code of this block"). Chromium and WebKit. Every case ends on an expectation.

import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { chromium, webkit, type Browser, type BrowserType } from 'playwright';
import { selectEngines, selection, skipWithoutEngines } from './selection';

let bundle = '';

beforeAll(async () => {
  const result = await build({
    entryPoints: [path.resolve(__dirname, 'customCodeEditorField.entry.tsx')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    alias: { '@': path.resolve(__dirname, '../../src') },
  });
  bundle = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
});

const PAGE = () => `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="root"></div>
<script>${bundle}</script>
</body></html>`;

const ENGINES = selectEngines([
  ['chromium', chromium],
  ['webkit', webkit],
] as [string, BrowserType][], selection);

skipWithoutEngines(ENGINES);
describe.each(ENGINES)('the field component in %s', (_name, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('swaps in CodeMirror with the value, and its name follows the title', async () => {
    const page = await browser.newPage();
    await page.setContent(PAGE());
    await page.waitForSelector('[data-custom-code-editor="rich"] .cm-content');
    const content = page.locator('.cm-content');
    expect(await page.locator('textarea').count()).toBe(0);
    expect(await content.textContent()).toBe('<p>one</p>');
    expect(await content.getAttribute('aria-label')).toBe('Code of this block');
    expect(await content.getAttribute('aria-describedby')).toBe('field-hint');
    await page.evaluate(() => (window as unknown as { __rename(t: string): void }).__rename('Clock'));
    await expect.poll(() => content.getAttribute('aria-label'), { timeout: 2000 }).toBe('Code of Clock');
    await content.click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
    await page.keyboard.type(' tick');
    expect(await page.evaluate(() => (window as unknown as { __value(): string }).__value())).toBe('<p>one</p> tick');
    expect(await page.locator('#field-hint').textContent()).toContain('Indent with');
    await page.close();
  });
});
// ci-replay touch
