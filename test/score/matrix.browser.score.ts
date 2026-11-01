// What only a browser can say about the widened matrix. The value rows are worth
// nothing if a sample is not valid CSS, and a row for SVG is worth nothing if the
// element lands in the HTML namespace, so Chromium checks both. A sample that is
// wrong is a harness bug and fails here; a tag in the wrong namespace is a result.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { cssPropertyName } from '@/lib/responsive/responsiveCss';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { renderPublished } from './lib/published';
import { allEntries, cssValueSample, cssValues, htmlEventHandlers, namespaceOf, placed } from './lib/universe';
import { writeOut } from './lib/io';
import { rowKey, type SurfaceResults } from './lib/types';

const NAMESPACE_URI = {
  svg: 'http://www.w3.org/2000/svg',
  mathml: 'http://www.w3.org/1998/Math/MathML',
} as const;

/** Handlers Chromium has for which the compatibility data lists no element event at all. */
const UNLISTED_HANDLER = /^onwebkit|^on(?:selectstart|beforecopy|beforecut|beforepaste)$/;

async function supports(page: Page, samples: Array<{ id: string; property: string; value: string }>): Promise<Record<string, boolean>> {
  return page.evaluate(
    (list) => Object.fromEntries(list.map((s) => [s.id, CSS.supports(s.property, s.value)])),
    samples.map(({ id, property, value }) => ({ id, property: cssPropertyName(property), value })),
  );
}

describe('coverage matrix: what Chromium decides', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    browser = await chromium.launch();
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('accepts every included CSS value sample, and rejects every sample left out for that reason', async () => {
    const rows = cssValues().filter((e) => cssValueSample(e.id));
    const verdicts = await supports(page, rows.map((e) => ({ id: e.id, ...cssValueSample(e.id) })));
    expect(rows.filter((e) => !e.excluded && !verdicts[e.id]).map((e) => e.id)).toEqual([]);
    expect(rows.filter((e) => e.excluded?.includes('The browser probe fails when that changes') && verdicts[e.id]).map((e) => e.id)).toEqual([]);
  });

  it('reflects exactly the event handler rows', async () => {
    const reflected = await page.evaluate(() => {
      const names = new Set<string>();
      const tags = ['div', 'video', 'input', 'dialog', 'form', 'details', 'track', 'slot', 'textarea', 'canvas'];
      for (const tag of tags) {
        const element = document.createElement(tag);
        for (const key in element) if (key.startsWith('on')) names.add(key);
      }
      return [...names];
    });
    const listed = htmlEventHandlers();
    expect(listed.filter((e) => !e.excluded && !reflected.includes(e.id)).map((e) => e.id)).toEqual([]);
    // Every handler is a row or an exclusion with its reason, never silently absent.
    expect(reflected.filter((id) => !listed.some((e) => e.id === id) && !UNLISTED_HANDLER.test(id))).toEqual([]);
  });

  it('puts SVG and MathML tags in their namespace', async () => {
    const rows = allEntries().filter((e) => !e.excluded && (e.kind === 'svg-element' || e.kind === 'mathml-element'));
    const body = rows
      .map((e, i) => `<div data-row="${i}">${renderPublished(placed(namespaceOf(e.kind), e.id) as unknown as ComponentNode).html}</div>`)
      .join('');
    await page.setContent(`<!doctype html><html><body>${body}</body></html>`);
    const found = await page.evaluate(
      (list) =>
        list.map(({ tag, uri }, i) =>
          [...document.querySelectorAll(`[data-row="${i}"] *`)].some((el) => el.localName === tag && el.namespaceURI === uri),
        ),
      rows.map((e) => ({ tag: e.id, uri: NAMESPACE_URI[namespaceOf(e.kind) as keyof typeof NAMESPACE_URI] })),
    );
    const results: SurfaceResults = {};
    rows.forEach((e, i) => {
      results[rowKey(e.kind, e.id)] = found[i]
        ? { status: 'pass' }
        : { status: 'fail', gap: 'unclassified', note: 'in the markup, but Chromium did not parse it into its namespace' };
    });
    writeOut('namespaces', results);
  });
});
