// @vitest-environment node
// A stored value is a stranger's text that the render path reads on every uncached
// request, synchronously, for every tenant. So no pattern over one may retry from each
// of a run of characters. Each case here took seconds or never ended at this size, and
// is linear now. Each pair of cases after it holds the meaning the pattern had.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { parseExpression } from '@/lib/bindings/resolver/expression';
import { familiesFromFontShorthand } from '@/lib/fonts/registry';
import { urlOfLayer } from '@/lib/images/imageStyle';
import { safeInlineStyle } from '@/lib/renderer/blockedNodes';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { applyImageLoading } from '@/lib/renderer/server/imageLoading';
import { renderComponentNode } from '@/lib/renderer/server/renderComponentNode';
import { UNSAFE_VALUE, unsafeDeclaration } from '@/lib/responsive/responsiveCss';
import { asImportant, mediaVerdict } from '@/lib/rules/surfaces';

vi.setConfig({ testTimeout: 30_000 });

// Far above what these take now, on a loaded machine, and far below what they took.
const LIMIT_MS = 2_000;
const SPACES = ' '.repeat(100_000);
const DIGITS = '1'.repeat(100_000);

function within(run: () => unknown): void {
  const started = performance.now();
  run();
  expect(performance.now() - started).toBeLessThan(LIMIT_MS);
}

const imageOf = (width: string): ComponentNode =>
  ({ id: 'r', type: 'div', children: [{ id: 's', type: 'section', children: [{ id: 'i', type: 'img', props: { src: '/a.png', width } }] }] }) as ComponentNode;

describe('values with a long run, on the render path', () => {
  it.each<[string, () => unknown]>([
    ['UNSAFE_VALUE, spaces after a less than', () => UNSAFE_VALUE.test(`<${SPACES}x`)],
    ['UNSAFE_VALUE, slashes after a less than', () => UNSAFE_VALUE.test(`<${'/'.repeat(100_000)}x`)],
    ['the inline style check', () => safeInlineStyle({ content: `"<${SPACES}x"` })],
    ['the sheet check', () => unsafeDeclaration('content', `"<${SPACES}x"`)],
    ['a whole render', () => renderToStaticMarkup(renderComponentNode({ id: 'n', type: 'div', props: { style: { content: `"<${SPACES}x"` } } } as ComponentNode) as React.ReactElement)],
    ['an image width', () => applyImageLoading(imageOf(`1${SPACES}x`))],
    ['important, spaces in the middle', () => asImportant(`a${SPACES}b`)],
    ['a binding, spaces after the braces', () => parseExpression(`{{${SPACES}x`)],
    ['a binding, spaces before the end', () => parseExpression(`{{x${SPACES}`)],
    ['a binding, closed', () => parseExpression(`{{${SPACES}x${SPACES}}}`)],
    ['a background, spaces after the bracket', () => urlOfLayer(`url(${SPACES}x`)],
    ['a background, spaces before the end', () => urlOfLayer(`url(x${SPACES}`)],
    ['a font shorthand, a line break at the end', () => familiesFromFontShorthand(`1px${SPACES}\n`)],
    ['a font shorthand, many sizes', () => familiesFromFontShorthand(`${'1px '.repeat(25_000)}\n`)],
    ['a media ratio', () => mediaVerdict(`(aspect-ratio: ${DIGITS}x)`, { width: 100, height: 100 })],
    ['a media length', () => mediaVerdict(`(min-width: ${DIGITS}x)`, { width: 100, height: 100 })],
  ])('%s', (_name, run) => {
    within(run);
  });
});

describe('what each pattern still means', () => {
  it.each([
    ['<script', true], ['< script', true], ['</script', true], ['< / script', true], ['<  /  SCRIPT', true], ['</ /script', true],
    ['< a script', false], ['red', false], ['a<b', false],
  ])('UNSAFE_VALUE on %s', (value, unsafe) => {
    expect(UNSAFE_VALUE.test(value)).toBe(unsafe);
  });

  it.each([
    ['color:red', 'color:red!important'],
    ['color:red!important', 'color:red!important'],
    ['color:red ! important', 'color:red!important'],
    ['color:red  !IMPORTANT  ', 'color:red!important'],
    ['content:"!important"', 'content:"!important"!important'],
  ])('asImportant on %s', (declaration, written) => {
    expect(asImportant(declaration)).toBe(written);
  });

  it.each<[string, string[] | null]>([
    ['{{a.b}}', ['a', 'b']], ['  {{ a.b }}  ', ['a', 'b']], ['{{row.8f3a-1b}}', ['row', '8f3a-1b']],
    ['{{}}', null], ['{{ }}', null], ['{{a}', null], ['{a}}', null], ['{{{a}}', null], ['{{a}}}', null], ['{{a}} {{b}}', null], ['{{a b}}', null], ['plain', null],
  ])('parseExpression on %s', (input, path) => {
    expect(parseExpression(input)?.path ?? null).toEqual(path);
  });

  it.each<[string, string | undefined]>([
    ['url(a.png)', 'a.png'], ['URL(a.png)', 'a.png'], ['url( a.png )', 'a.png'], ['url("a b.png")', 'a b.png'], ["url('a.png')", 'a.png'], ['  url( " a.png " )  ', 'a.png'],
    ['url("a)', '"a'], ['url(")', '"'], ['url()', undefined], ['url("")', undefined], ['url(   )', undefined], ['url(a\nb)', undefined], ['linear-gradient(red, blue)', undefined], ['url(a.png) x', undefined],
  ])('urlOfLayer on %s', (layer, url) => {
    expect(urlOfLayer(layer)).toBe(url);
  });

  it.each([
    ["italic 600 48px/1.1 'Fraunces', serif", "'Fraunces', serif"],
    ['48px Inter', 'Inter'],
    ['48px / 1.1 Inter', 'Inter'],
    ['large Inter, sans-serif', 'Inter, sans-serif'],
    ['16px\n  Inter', 'Inter'],
    ['Inter', ''],
    ['48px', ''],
  ])('familiesFromFontShorthand on %s', (value, families) => {
    expect(familiesFromFontShorthand(value)).toBe(families);
  });

  it.each([['(aspect-ratio: 1)'], ['(aspect-ratio: 1/1)'], ['(aspect-ratio: 1 / 1)'], ['(aspect-ratio: 1.0 / 1.0)'], ['(aspect-ratio: .5/.5)']])('mediaVerdict on %s', (query) => {
    expect(mediaVerdict(query, { width: 100, height: 100 })).toBe(mediaVerdict('(min-width: 1px)', { width: 100, height: 100 }));
  });

  it('applyImageLoading reads a small width the same way', () => {
    for (const width of ['48', ' 48px ', '48 px']) expect(applyImageLoading(imageOf(width)).root.children?.[0].children?.[0].props).not.toHaveProperty('fetchPriority');
    expect(applyImageLoading(imageOf('800')).root.children?.[0].children?.[0].props).toHaveProperty('fetchPriority', 'high');
  });
});
