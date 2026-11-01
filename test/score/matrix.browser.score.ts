// What only a browser can say about the widened matrix. The value rows are worth
// nothing if a sample is not valid CSS, and a row for SVG is worth nothing if the
// element lands in the HTML namespace, so Chromium checks both, and a selector or
// at-rule row is worth nothing if Chromium throws the sample away. A sample that is
// wrong is a harness bug and fails here; a tag in the wrong namespace is a result.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { cssPropertyName } from '@/lib/responsive/responsiveCss';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { renderPublished } from './lib/published';
import {
  allEntries,
  atRuleSample,
  cssAtRules,
  cssMediaFeatures,
  cssSelectors,
  cssValueSample,
  cssValues,
  htmlEventHandlers,
  mediaFeatureSample,
  namespaceOf,
  placed,
  selectorSample,
} from './lib/universe';
import { parseSelector } from '@/lib/rules/rules';
import { isPageLevelRow } from './lib/encodings';
import samples from './data/samples.json';
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

const WEBKIT_ONLY: readonly string[] = samples.webkitOnlySelectors;
const NOT_IN_CHROMIUM: readonly string[] = samples.mediaFeaturesChromiumCannotEvaluate;
const LEFT_OUT_UNPARSED = 'The browser probe fails when that changes';

/** A selector sample as one rule of a sheet, on a class standing in for the node. */
function selectorSheet(id: string): string {
  const sample = selectorSample(id);
  const selector = (sample.startsWith('&') ? sample : `&${sample}`).replace(/&/g, '.n.n');
  const wrapper = (samples.selectorWrappers as Record<string, string>)[id];
  return wrapper ? `${wrapper}{${selector}{color:red}}` : `${selector}{color:red}`;
}

const declarations = (style: Record<string, unknown>): string =>
  Object.entries(style)
    .map(([key, value]) => `${cssPropertyName(key)}:${value}`)
    .join(';');

interface DefinitionBody {
  style?: Record<string, unknown>;
  blocks?: { selector: string; style: Record<string, unknown> }[];
}

/** An at-rule row as a sheet: its definition body, or a wrapper around a rule. */
function atRuleSheet(id: string): string {
  const body = (samples.definitionBodies as Record<string, DefinitionBody>)[id];
  if (!body) return `${atRuleSample(id)}{.n{color:red}}`;
  const inner = body.style
    ? declarations(body.style)
    : (body.blocks ?? []).map((block) => `${block.selector}{${declarations(block.style)}}`).join('');
  return `${atRuleSample(id)}{${inner}}`;
}

/** Which sheets Chromium keeps a rule of. It throws away what it cannot parse. */
async function kept(page: Page, sheets: Array<{ id: string; text: string }>): Promise<Record<string, boolean>> {
  return page.evaluate(
    (list) =>
      Object.fromEntries(
        list.map(({ id, text }) => {
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(text);
          return [id, sheet.cssRules.length > 0];
        }),
      ),
    sheets,
  );
}

/**
 * Which media queries Chromium can evaluate. It keeps an unknown feature in the
 * parsed sheet as it was written, so the sheet proves nothing here: only a query
 * neither true nor false when negated is one it does not know.
 */
async function evaluated(page: Page, queries: Array<{ id: string; query: string }>): Promise<Record<string, boolean>> {
  return page.evaluate(
    (list) => Object.fromEntries(list.map(({ id, query }) => [id, matchMedia(query).matches || matchMedia(`not ${query}`).matches])),
    queries,
  );
}

/** Pieces that have to be combined to step outside a node, if that can be done. */
const SELECTOR_PIECES = [
  '&', ' ', ' ', '>', '+', '~', '||', '|', ',', ':is(', ':not(', ':has(', ':where(', ')', '[', ']', '*', 'p', 'section', '.a', '.b', '.n',
  ':hover', ':first-child', ':scope', ':root', 'html', 'body', '::before', '[value]', '"', '=x',
];

/** Selector text the parser accepts, from a fixed seed so a run is repeatable. */
function acceptedSelectors(attempts: number): string[] {
  let state = 20261102;
  const next = (limit: number): number => {
    state = (Math.imul(state ^ (state >>> 15), 2654435761) + 0x6d2b79f5) | 0;
    return (state >>> 8) % limit;
  };
  const accepted = new Set<string>();
  for (let i = 0; i < attempts * 50 && accepted.size < attempts; i++) {
    let text = '&';
    for (let length = next(9); length > 0; length--) text += SELECTOR_PIECES[next(SELECTOR_PIECES.length)];
    if (parseSelector(text).ok) accepted.add(text);
  }
  return [...accepted].flatMap((text) => {
    const parsed = parseSelector(text);
    return parsed.ok ? parsed.value : [];
  });
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

  it('keeps every selector sample, and refuses each one left out or listed for that reason', async () => {
    const rows = cssSelectors().filter((e) => !isPageLevelRow(e.id) && (!e.excluded || e.excluded.includes(LEFT_OUT_UNPARSED)));
    const verdicts = await kept(page, rows.map((e) => ({ id: e.id, text: selectorSheet(e.id) })));
    const expectedParsed = rows.filter((e) => !e.excluded && !WEBKIT_ONLY.includes(e.id));
    expect(rows.length).toBeGreaterThan(90);
    expect(expectedParsed.filter((e) => !verdicts[e.id]).map((e) => e.id)).toEqual([]);
    expect(rows.filter((e) => (e.excluded || WEBKIT_ONLY.includes(e.id)) && verdicts[e.id]).map((e) => e.id)).toEqual([]);
  });

  it('never lets an accepted selector match outside its node', async () => {
    const verdict = await page.evaluate((list) => {
      document.body.innerHTML = `<h1><p></p></h1><section class="a"><input value="x"><p class="b"></p></section>
        <div class="before"><p></p></div><div class="n n"><section class="a"><p class="b"></p><p></p></section><p></p><ul><li></li><li></li></ul></div>
        <p class="after"></p><div class="after"><p class="b"></p></div>`;
      const node = document.querySelector('.n') as Element;
      const escaped: string[] = [];
      let valid = 0;
      for (const selector of list) {
        let reached: Element[];
        try {
          reached = [...document.querySelectorAll(selector.replace('&', '.n.n'))];
        } catch {
          continue; // Checked by shape, so it may not be a selector: a browser drops that rule.
        }
        valid++;
        if (reached.some((el) => !node.contains(el))) escaped.push(selector);
      }
      return { escaped, valid };
    }, acceptedSelectors(4000));
    expect(verdict.valid).toBeGreaterThan(500);
    expect(verdict.escaped).toEqual([]);
  });

  it('excludes the twelve selector rows the contract names, each by an id the data has', () => {
    const named = cssSelectors().filter((e) => /shadow tree|Neither Chromium nor WebKit/.test(e.excluded ?? ''));
    expect(named).toHaveLength(12);
  });

  it('keeps every at-rule sample', async () => {
    const rows = cssAtRules().filter((e) => !e.excluded && !isPageLevelRow(e.id));
    const verdicts = await kept(page, rows.map((e) => ({ id: e.id, text: atRuleSheet(e.id) })));
    expect(rows).toHaveLength(12);
    expect(rows.filter((e) => !verdicts[e.id]).map((e) => e.id)).toEqual([]);
  });

  it('evaluates every media feature sample, and none of those listed for that reason', async () => {
    const rows = cssMediaFeatures().filter((e) => !e.excluded);
    const verdicts = await evaluated(page, rows.map((e) => ({ id: e.id, query: mediaFeatureSample(e.id) })));
    expect(rows.filter((e) => !NOT_IN_CHROMIUM.includes(e.id) && !verdicts[e.id]).map((e) => e.id)).toEqual([]);
    expect(NOT_IN_CHROMIUM.filter((id) => verdicts[id])).toEqual([]);
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
