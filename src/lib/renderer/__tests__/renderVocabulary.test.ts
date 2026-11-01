// The render gate refuses by default, so a new name in the web's data stays off
// every page until someone has judged it, and this file says so.
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  htmlElementAttributes,
  htmlElements,
  htmlGlobalAttributes,
  mathmlAttributes,
  mathmlElements,
  svgAttributes,
  svgElements,
} from '../../../../test/score/lib/universe';
import { REVIEWED_ATTRIBUTES, REVIEWED_HTML_TAGS, REVIEWED_MATHML_TAGS, REVIEWED_SVG_TAGS } from '@/lib/ai/pageGen/reviewedVocabulary';
import { BLOCKED_TAGS, isRefusedTag } from '@/lib/renderer/blockedNodes';
import { REFUSED_RENDER_ATTRIBUTES, RENDERED_ATTRIBUTES, RENDERED_TAGS, isRenderedAttribute, isRenderedTag } from '@/lib/renderer/renderVocabulary';

const attributeNames = () =>
  [...new Set([...htmlElementAttributes(), ...htmlGlobalAttributes(), ...svgAttributes(), ...mathmlAttributes()].map((entry) => entry.id.slice(entry.id.lastIndexOf('.') + 1).toLowerCase()))]
    .filter((name) => !name.includes('_') && !name.includes('*'));

/** Deliberately out, each for a reason of its own: they swallow a page, or need a server the renderer does not run. */
const UNJUDGED_BY_DESIGN = ['body', 'head', 'html', 'marquee', 'mfenced', 'maction', 'noembed', 'noframes', 'param', 'plaintext', 'xmp'];

describe('renderVocabulary', () => {
  it('has a decision for every attribute in the data: a new one fails here until someone judges it', () => {
    const undecided = attributeNames().filter((name) => !name.startsWith('on') && !RENDERED_ATTRIBUTES.has(name) && !REFUSED_RENDER_ATTRIBUTES.has(name));
    expect(undecided).toEqual([]);
  });

  it('has a decision for every element in the data', () => {
    const tags = [...htmlElements(), ...svgElements(), ...mathmlElements()].map((entry) => entry.id.toLowerCase());
    expect(tags.filter((tag) => !RENDERED_TAGS.has(tag) && !BLOCKED_TAGS.has(tag) && !UNJUDGED_BY_DESIGN.includes(tag))).toEqual([]);
  });

  it('never renders and refuses the same name', () => {
    expect([...RENDERED_ATTRIBUTES].filter((name) => REFUSED_RENDER_ATTRIBUTES.has(name))).toEqual([]);
    expect([...BLOCKED_TAGS].filter((tag) => RENDERED_TAGS.has(tag))).toEqual([]);
  });

  it('renders everything the generator may write', () => {
    expect([...REVIEWED_ATTRIBUTES].filter((name) => !isRenderedAttribute(name))).toEqual([]);
    expect([...REVIEWED_HTML_TAGS, ...REVIEWED_SVG_TAGS, ...REVIEWED_MATHML_TAGS].filter((tag) => isRefusedTag(tag))).toEqual([]);
  });

  it('refuses by default: a name nobody has judged stays off the page', () => {
    for (const name of ['brandnew', 'innerhtml', 'outerhtml', 'textcontent', '__proto__', 'constructor']) expect(isRenderedAttribute(name)).toBe(false);
    for (const tag of ['brandnew', 'permission', 'svg:script', 'x-y:script', 'x:a', 'script ']) expect(isRenderedTag(tag)).toBe(false);
  });

  it('keeps what no script reads: data, aria, an author\'s own hyphenated name and custom elements', () => {
    for (const name of ['data-x', 'aria-label', 'my-attribute']) expect(isRenderedAttribute(name)).toBe(true);
    for (const name of ['http-equiv', 'cross-origin-top-navigation-by-user-activation']) expect(isRenderedAttribute(name)).toBe(false);
    expect(isRenderedTag('x-y')).toBe(true);
  });
});
