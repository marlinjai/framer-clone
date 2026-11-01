// What the validator accepts beyond what the prompt teaches: the web's tags,
// attributes and CSS properties, with the safety rules unchanged. No handlers, no
// raw HTML, no unsafe URLs, and nothing a renderer or the editor reads off a node.

// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { deriveBreakpointKeys } from '../schema';
import { validateGeneration, type GeneratedNodeSnapshot } from '../validate';
import { isAcceptedAttribute } from '../schema';
import { dataAttributesInSource } from '../../../../../test/score/lib/vocabulary';

const breakpoints = deriveBreakpointKeys([{ label: 'Desktop', minWidth: 1200 }, { label: 'Mobile', minWidth: 390 }]);

function one(node: Record<string, unknown>): { node: GeneratedNodeSnapshot; warnings: string[] } {
  const outcome = validateGeneration({ nodes: [node] }, { breakpoints, newId: () => 'x' });
  if (!outcome.ok) throw new Error(outcome.errors.join('; '));
  return { node: outcome.result.nodes[0], warnings: outcome.result.warnings };
}

const styleOf = (style: Record<string, unknown>) => one({ type: 'div', props: { style } }).node.props.style ?? {};
const propsOf = (type: string, props: Record<string, unknown>) => one({ type, props }).node.props;

describe('tags', () => {
  it('keeps the web\'s tags, children included', () => {
    const list = one({ type: 'ul', children: [{ type: 'li', props: { children: 'One' } }] }).node;
    expect(list.type).toBe('ul');
    expect(list.children[0].type).toBe('li');
    for (const tag of ['table', 'details', 'blockquote', 'dialog', 'video', 'template']) {
      expect(one({ type: tag }).node.type).toBe(tag);
    }
  });

  it('still drops blocked tags and raw form controls with their subtree', () => {
    const outcome = validateGeneration(
      { nodes: [{ type: 'section', children: ['iframe', 'object', 'embed', 'input', 'textarea', 'select'].map((type) => ({ type, children: [{ type: 'p' }] })) }] },
      { breakpoints },
    );
    expect(outcome.ok && outcome.result.nodes[0].children).toEqual([]);
  });

  it('still turns a deprecated tag into a div, and reads a preset id as the preset', () => {
    expect(one({ type: 'marquee' }).node.type).toBe('div');
    expect(one({ type: 'card' }).node.props).toMatchObject({ style: expect.anything() });
  });
});

describe('svg and math', () => {
  const inSvg = (node: Record<string, unknown>) => one({ type: 'svg', children: [node] }).node.children;

  it('reads a child in the language of its root, in that language\'s case', () => {
    const svg = one({
      type: 'svg',
      props: { viewBox: '0 0 10 10' },
      children: [{ type: 'lineargradient', props: { id: 'g' } }, { type: 'text', props: { children: 'Hi' } }, { type: 'title', props: { children: 'Logo' } }],
    }).node;
    expect(svg.props.viewBox).toBe('0 0 10 10');
    expect(svg.children.map((c) => c.type)).toEqual(['linearGradient', 'text', 'title']);
    expect(one({ type: 'math', children: [{ type: 'mfrac' }] }).node.children[0].type).toBe('mfrac');
  });

  it('reads a tag outside its root as HTML: a rect is no element there, and a text stays the preset', () => {
    expect(one({ type: 'rect' }).node.type).toBe('div');
    expect(one({ type: 'title' }).node.type).toBe('div');
    expect(one({ type: 'text' }).node.type).toBe('p');
  });

  it('turns an unknown tag into the plain box of its language, and goes back to HTML in a foreignObject', () => {
    expect(inSvg({ type: 'marquee' })[0].type).toBe('g');
    expect(one({ type: 'math', children: [{ type: 'marquee' }] }).node.children[0].type).toBe('mrow');
    expect(inSvg({ type: 'foreignObject', children: [{ type: 'p' }] })[0].children[0].type).toBe('p');
  });

  it('never lets a blocked tag in through svg', () => {
    expect(inSvg({ type: 'script' })).toEqual([]);
    expect(inSvg({ type: 'style' })).toEqual([]);
    expect(inSvg({ type: 'foreignObject', children: [{ type: 'iframe' }] })[0].children).toEqual([]);
  });

  const svgProps = (type: string, props: Record<string, unknown>) => inSvg({ type, props })[0].props;

  it('keeps presentation attributes in both spellings', () => {
    expect(svgProps('path', { d: 'M0 0', fill: 'url(#g)', stroke: 'red', strokeWidth: 2, 'stroke-linecap': 'round' })).toEqual({
      d: 'M0 0',
      fill: 'url(#g)',
      stroke: 'red',
      strokeWidth: 2,
      'stroke-linecap': 'round',
    });
  });

  it('keeps a real icon\'s path, wrapped over lines, and refuses one past the limit', () => {
    const d = Array.from({ length: 200 }, (_, i) => `M${i} ${i}\nC1.5 2.5 3.5 4.5 5.5 6.5`).join(' ');
    expect(svgProps('path', { d }).d).toBe(d.replace(/\n/g, ' '));
    expect(svgProps('path', { d: 'M0 0 '.repeat(2000) })).toEqual({});
    expect(svgProps('polygon', { title: 'x'.repeat(301) })).toEqual({});
  });

  it('keeps a reference inside the page in a style value', () => {
    expect(styleOf({ clipPath: 'url(#shape)', mask: 'url("#fade")' })).toEqual({ clipPath: 'url(#shape)', mask: 'url("#fade")' });
  });

  it('refuses unsafe links in every spelling, and a url() leaving the page', () => {
    expect(svgProps('a', { href: 'javascript:alert(1)' })).toEqual({});
    expect(svgProps('use', { href: 'javascript:alert(1)', xlinkHref: 'javascript:alert(1)', 'xlink:href': 'data:image/svg+xml,x' })).toEqual({});
    expect(svgProps('image', { href: 'https://images.unsplash.com/photo-1' })).toEqual({});
    expect(svgProps('rect', { fill: 'url(https://evil.example/a.svg#g)', stroke: 'url("/a.svg#g")' })).toEqual({});
    expect(svgProps('use', { href: '#icon' })).toEqual({ href: '#icon' });
  });

  it('refuses an animation aimed at a link or a handler, and every handler', () => {
    expect(svgProps('animate', { attributeName: 'href', to: 'x' })).toEqual({ to: 'x' });
    expect(svgProps('set', { attributeName: 'XLINK:HREF' })).toEqual({});
    expect(svgProps('set', { attributeName: 'onclick' })).toEqual({});
    expect(svgProps('animate', { attributeName: 'r' })).toEqual({ attributeName: 'r' });
    expect(svgProps('rect', { onload: 'x', onBegin: 'x' })).toEqual({});
  });
});

describe('style keys', () => {
  it('keeps standard properties beyond the taught ones, kebab-case or not', () => {
    expect(styleOf({ clipPath: 'circle(50%)', 'scroll-snap-type': 'x mandatory', '-webkit-line-clamp': 3 })).toEqual({
      clipPath: 'circle(50%)',
      scrollSnapType: 'x mandatory',
      WebkitLineClamp: 3,
    });
  });

  it('keeps a custom property under its own name, and refuses a name that could break out', () => {
    expect(styleOf({ '--brand-color': '#123456' })).toEqual({ '--brand-color': '#123456' });
    expect(styleOf({ '--x;color:red': 'blue', '--': 'blue', madeUpProperty: 'blue' })).toEqual({});
  });

  it('applies the value rules to every new key', () => {
    expect(
      styleOf({
        clipPath: 'url(javascript:alert(1))',
        maskImage: 'url(data:image/png;base64,xx)',
        listStyleImage: 'image-set("javascript:alert(1)" 1x)',
        borderImageSource: 'image-set("https://images.unsplash.com/photo-1" 1x)',
        maskBorderSource: 'src("https://evil.example/a.png")',
        '--a': 'url(',
        '--b': 'red;color:blue',
      }),
    ).toEqual({});
  });
});

describe('image-set()', () => {
  it('keeps a safe source and refuses the rest, in the review too', () => {
    expect(styleOf({ backgroundImage: 'image-set("/a.png" 1x, "/b.png" 2x)' })).toEqual({ backgroundImage: 'image-set("/a.png" 1x, "/b.png" 2x)' });
    expect(styleOf({ backgroundImage: 'image-set("/a.png" 1x, "data:image/png;base64,xx" 2x)' })).toEqual({});
  });
});

describe('a ; in a style value', () => {
  it('is kept where it is data', () => {
    const url = 'url("https://example.com/a;b.jpg")';
    expect(styleOf({ backgroundImage: url, quotes: '";" ";"' })).toEqual({ backgroundImage: url, quotes: '";" ";"' });
  });

  it('is refused where it ends the declaration, or a comment could hide that', () => {
    expect(
      styleOf({
        color: 'red;position:fixed',
        background: 'red;',
        quotes: '"open',
        margin: '/* " */ 0; color: red; /* " */',
      }),
    ).toEqual({});
  });

  it('still refuses a data: image, even with its ; contained', () => {
    expect(styleOf({ backgroundImage: 'url("data:image/png;base64,xx")' })).toEqual({});
  });
});

describe('attributes', () => {
  it('keeps global attributes as text, numbers or booleans', () => {
    expect(
      propsOf('div', { id: 'pricing', role: 'note', hidden: true, tabIndex: 0, spellCheck: false, lang: 'de', title: 'x', 'aria-label': 'y', 'data-plan': 'pro' }),
    ).toEqual({ id: 'pricing', role: 'note', hidden: true, tabIndex: 0, spellCheck: false, lang: 'de', title: 'x', 'aria-label': 'y', 'data-plan': 'pro' });
  });

  it('keeps an element\'s own attributes, and only on that element', () => {
    expect(propsOf('td', { colSpan: 2 })).toEqual({ colSpan: 2 });
    expect(propsOf('details', { name: 'group', open: true })).toEqual({ name: 'group', open: true });
    expect(propsOf('button', { commandfor: 'modal', command: 'show-modal' })).toEqual({ commandfor: 'modal', command: 'show-modal' });
    expect(propsOf('div', { colSpan: 2, href: '/x', src: '/x' })).toEqual({});
  });

  it('writes a boolean under the name React reads, because it drops one under a lower-case name', () => {
    const props = propsOf('video', { autoplay: true, src: '/film.mp4' });
    expect(props).toEqual({ autoPlay: true, src: '/film.mp4' });
    expect(renderToStaticMarkup(React.createElement('video', props)).toLowerCase()).toContain('autoplay=""');
  });

  it('writes booleans of global attributes under React\'s name too', () => {
    expect(propsOf('div', { autofocus: true, spellcheck: false })).toEqual({ autoFocus: true, spellCheck: false });
  });

  it('refuses handlers, raw HTML, class names and nonces, in any spelling', () => {
    expect(
      propsOf('div', {
        onClick: 'x',
        onclick: 'x',
        ONCLICK: 'x',
        onMouseOver: 'x',
        dangerouslySetInnerHTML: { __html: 'x' },
        className: 'x',
        class: 'x',
        nonce: 'x',
        srcDoc: 'x',
      }),
    ).toEqual({});
  });

  it('refuses a value that is no plain value', () => {
    expect(propsOf('div', { title: { a: 1 }, id: ['a'], tabIndex: Number.NaN, lang: 'a\u0000b', dir: 'x'.repeat(301) })).toEqual({});
  });

  it('never routes a CSS key past the style checks', () => {
    expect(propsOf('video', { width: 'red;x', height: 200 })).toEqual({});
  });

  it('checks every URL attribute', () => {
    expect(propsOf('area', { href: 'javascript:alert(1)' })).toEqual({});
    expect(propsOf('area', { href: '/x', target: '_top' })).toEqual({ href: '/x' });
    expect(propsOf('video', { src: 'javascript:alert(1)', poster: 'data:image/png;base64,xx' })).toEqual({});
    expect(propsOf('source', { srcSet: '/a.jpg 1x, data:image/png;base64,xx 2x' })).toEqual({});
    expect(propsOf('source', { srcSet: '/a.jpg 1x, /b.jpg 2x' })).toEqual({ srcSet: '/a.jpg 1x, /b.jpg 2x' });
    expect(propsOf('blockquote', { cite: 'javascript:alert(1)' })).toEqual({});
    expect(propsOf('button', { formAction: 'https://evil.example', formaction: 'https://evil.example' })).toEqual({});
    expect(propsOf('a', { ping: 'https://evil.example', attributionsrc: 'https://evil.example' })).toEqual({});
  });

  it('never lets a stock photo in without its credit through another attribute', () => {
    const photo = 'https://images.unsplash.com/photo-1';
    expect(propsOf('source', { src: photo, srcSet: `${photo} 1x` })).toEqual({});
    expect(propsOf('video', { poster: photo })).toEqual({});
  });
});

describe('data attributes the code reads', () => {
  it('refuses every name the source uses, so a new one fails here until the list is regenerated', () => {
    const names = dataAttributesInSource();
    expect(names).toEqual(expect.arrayContaining(['data-form-kind', 'data-component-id', 'data-sticky-cta']));
    expect(names.filter((name) => isAcceptedAttribute('div', name))).toEqual([]);
  });

  it('a plain node cannot pose as a form, an island or another node', () => {
    expect(propsOf('div', { 'data-form-kind': 'form', 'data-component-kind': 'product-list', 'data-component-id': 'x', 'data-sticky-cta': 'true' })).toEqual({});
  });
});
