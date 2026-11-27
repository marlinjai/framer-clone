// @vitest-environment jsdom
//
// What a placement may sit in, judged by everything its definition draws. The
// paragraph rule is checked against a real HTML parser, not against the list it
// is written as.

import { describe, expect, it } from 'vitest';
import { WEB_TAGS } from '@/lib/ai/pageGen/webVocabulary';
import { isVoidTag } from '@/lib/drag/voidTags';
import { contentModelRefusal, type ComponentDefinitions } from '../definition';

interface Node { type: string; props?: Record<string, unknown>; children?: Node[] }
const el = (type: string, ...children: Node[]): Node => ({ type, children });
const use = (component: string): Node => ({ type: '#component', props: { component } });
const of = (trees: Record<string, Node>) =>
  Object.fromEntries(Object.entries(trees).map(([id, tree]) => [id, { id, page: { appComponentTree: tree } }])) as unknown as ComponentDefinitions;
const inParagraph = (trees: Record<string, Node>) => contentModelRefusal(of(trees), 'd', ['p', 'div']);

/** True when the parser keeps `<tag>`, inside a span, inside the paragraph it was written in. */
function parserKeeps(tag: string): boolean {
  const end = isVoidTag(tag) ? '' : `</${tag}>`;
  const document = new DOMParser().parseFromString(`<!doctype html><body><p id="o"><span><${tag} id="x">${end}</span></p></body>`, 'text/html');
  const written = document.getElementById('x');
  return !written || document.getElementById('o')!.contains(written);
}

describe('a placement inside a paragraph', () => {
  it('is refused for exactly the nested elements at which a parser ends the paragraph', () => {
    const wrong = WEB_TAGS.filter(tag => (inParagraph({ d: el('span', el(tag)) }) === null) !== parserKeeps(tag));
    expect(wrong).toEqual([]);
  });

  it('is refused for such an element in a component the definition places', () => {
    expect(inParagraph({ d: el('span', el('em', use('inner'))), inner: el('span', el('div')) })).toMatch(/end the paragraph at this component's <div>/);
    expect(inParagraph({ d: el('span', use('inner')), inner: el('section') })).toMatch(/<section>/);
  });

  it('is refused for a root that is not phrasing content', () => {
    expect(inParagraph({ d: el('g') })).toMatch(/<g>/);
  });

  it('takes text, svg shapes, and what a button or foreignObject shields', () => {
    expect(inParagraph({ d: el('span', el('#text'), el('svg', el('g', el('path')), el('foreignObject', el('div')))) })).toBeNull();
    expect(inParagraph({ d: el('span', el('button', el('div'))) })).toBeNull();
    expect(inParagraph({ d: el('button', el('div')) })).toBeNull();
  });

  it('ends on definitions that contain each other', () => {
    expect(inParagraph({ d: el('span', use('other')), other: el('span', use('d')) })).toBeNull();
  });
});

describe('a placement inside a link', () => {
  it('is refused for a control in a component the definition places, also under a button', () => {
    const trees = { d: el('span', use('inner')), inner: el('span', el('button', el('input'))) };
    expect(contentModelRefusal(of(trees), 'd', ['a'])).toMatch(/holds a link or a control/);
  });
});
// ci-replay touch
