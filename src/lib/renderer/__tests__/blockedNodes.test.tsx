// Stored nodes never put code on a page: the published renderer and the shared
// editor and preview dispatch drop the same tags and props.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createComponentElement } from '@/lib/renderer/createComponentElement';
import { renderComponentNode } from '@/lib/renderer/server/renderComponentNode';

const published = (node: Record<string, unknown>) => renderToStaticMarkup(renderComponentNode({ id: 'n', ...node } as never) as never);
const editor = (type: string, props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createComponentElement({ type, props: {}, isHostElement: true } as never, props, [], props.children as never) as never,
  );

describe('blocked nodes', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  it.each(['script', 'style', 'iframe', 'object', 'embed', 'frame', 'frameset', 'base', 'link', 'meta', 'SCRIPT', 'geolocation', 'camera', 'microphone', 'usermedia', 'install', 'model'])(
    'renders nothing for a stored <%s>',
    (type) => {
      expect(published({ type, props: { children: 'x' } })).toBe('');
      expect(editor(type, { children: 'x' })).toBe('');
    },
  );

  it('drops a blocked child and keeps its parent', () => {
    const html = published({ type: 'div', children: [{ id: 'a', type: 'script', props: { children: 'x' } }, { id: 'b', type: 'p', props: { children: 'kept' } }] });
    expect(html).toBe('<div><p>kept</p></div>');
  });

  it('drops raw html and stored handlers on both surfaces, and keeps the rest', () => {
    const props = { dangerouslySetInnerHTML: { __html: '<img onerror=x>' }, onClick: 'x', id: 'keep' };
    expect(published({ type: 'div', props })).toBe('<div id="keep"></div>');
    expect(editor('div', props)).toBe('<div id="keep"></div>');
  });

  it.each(['onclick', 'ONCLICK', 'onClick', 'OnMouseOver'])('drops a stored %s on a custom element', (name) => {
    expect(published({ type: 'x-y', props: { [name]: 'x', id: 'keep' } })).toBe('<x-y id="keep"></x-y>');
    expect(editor('x-y', { [name]: 'x', id: 'keep' })).toBe('<x-y id="keep"></x-y>');
  });

  it.each([
    ['attributeName', 'href'],
    ['attributeName', ' HREF '],
    ['attributename', 'xlink:href'],
    ['ATTRIBUTENAME', 'onclick'],
  ])('drops %s=%s on an SVG animation', (name, value) => {
    expect(published({ type: 'animate', props: { [name]: value, to: 'x' } })).toBe('<animate to="x"></animate>');
  });

  it.each([
    ['a', 'HREF', 'javascript:alert(1)'],
    ['a', 'href', ' jav\tascript:alert(1)'],
    ['a', 'HrEf', 'VBSCRIPT:x'],
    ['a', 'xlink:href', 'javascript:x'],
    ['button', 'FORMACTION', 'javascript:x'],
    ['form', 'ACTION', 'javascript:x'],
    ['x-y', 'href', 'data:text/html,x'],
  ])('drops a script destination on <%s %s>', (type, name, value) => {
    const html = published({ type, props: { [name]: value, id: 'keep' } });
    expect(html.toLowerCase()).not.toMatch(/script|data:/);
    expect(html).toContain('id="keep"');
  });

  it('keeps ordinary destinations', () => {
    expect(published({ type: 'a', props: { href: '/shop' } })).toContain('href="/shop"');
    expect(published({ type: 'img', props: { src: 'data:image/png;base64,AAAA', alt: '' } })).toContain('data:image/png');
  });

  it.each([
    ['a', 'HREF', ['javascript:x']],
    ['a', 'href', [['javascript:x']]],
    ['form', 'ACTION', ['javascript:x']],
    ['a', 'href', 'about:blank'],
    ['a', 'href', 'blob:https://x/y'],
    ['a', 'href', 'view-source:x'],
    ['img', 'srcset', 'javascript:x 1x, /a.png 2x'],
  ])('drops an address no page may have on <%s %s=%j>', (type, name, value) => {
    expect(published({ type, props: { [name]: value, id: 'keep' } })).not.toMatch(/javascript|about:|blob:|view-source/i);
    expect(editor(type, { [name]: value, id: 'keep' })).not.toMatch(/javascript|about:|blob:|view-source/i);
  });

  it.each(['innerHTML', 'outerHTML', 'textContent', 'srcdoc', 'is', 'nonce', 'ping', 'attributionsrc', 'shadowrootmode', 'xml:base', '__proto__'])(
    'drops the prop %s, which acts beyond being an attribute',
    (name) => {
      const props = JSON.parse(`{"${name}":"<img src=x onerror=x>","id":"keep"}`);
      expect(published({ type: 'x-y', props })).toBe('<x-y id="keep"></x-y>');
      expect(editor('x-y', props)).toBe('<x-y id="keep"></x-y>');
    },
  );

  it.each(['svg:script', 'x-y:script', 'x:a', 'permission', 'body', 'plaintext', 'script ', '<script>', 'a b', '-x'])('renders nothing for the tag %j', (type) => {
    expect(published({ type, props: { children: 'x' } })).toBe('');
    expect(editor(type, { children: 'x' })).toBe('');
  });

  it.each([['ref', 'x'], ['title', { toString: 'x' }], ['style', 'color:red'], ['style', ['x']], ['key', { a: 1 }]])('survives %s=%j, which would stop the render', (name, value) => {
    expect(published({ type: 'div', props: { [name]: value, id: 'keep' } })).toBe('<div id="keep"></div>');
    expect(editor('div', { [name]: value, id: 'keep' })).toBe('<div id="keep"></div>');
  });

  it.each(['red;background:url(https://x/y)', '/*"*/;background:url(https://x/y);/*"*/', 'url(javascript:x)', 'red</style><script>'])('drops the style value %s', (color) => {
    const props = { style: { color, margin: 0 } };
    expect(published({ type: 'div', props })).toBe('<div style="margin:0"></div>');
    expect(editor('div', props)).toBe('<div style="margin:0"></div>');
  });

  it('keeps an image in a style, as the published stylesheet does', () => {
    expect(published({ type: 'div', props: { style: { backgroundImage: 'url("https://x/y.png")' } } })).toContain('https://x/y.png');
  });

  it('keeps what an existing page holds', () => {
    const props = { href: 'tel:+49', target: '_blank', draggable: false, label: 'x', title: 'x', alt: 'x', 'data-credit-name': 'x', className: 'x' };
    const html = published({ type: 'a', props });
    for (const piece of ['href="tel:+49"', 'target="_blank"', 'draggable="false"', 'label="x"', 'data-credit-name="x"', 'class="x"']) expect(html).toContain(piece);
  });

  it('reports nothing for the settings a renderer reads from a node', () => {
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    const props = { formName: 'x', options: ['a'], ctaLabel: 'x', ctaHref: '/x', buttonBackground: 'red', query: {}, rules: [] };
    published({ type: 'div', props });
    editor('div', props);
    expect(warn).not.toHaveBeenCalled();
  });

  it('writes no query object on the canvas, like the published page', () => {
    const props = { 'data-component-kind': 'collection', label: 'x', query: { limit: 1 } };
    expect(editor('div', props)).not.toContain('query');
    expect(published({ type: 'div', props })).not.toContain('query');
  });

  it.each(['#TEXT', '#Text', '#COMPONENT', '#x', '#'])('renders nothing for %s, which no browser can create', (type) => {
    expect(published({ type, props: { children: 'x' } })).toBe('');
    expect(editor(type, { children: 'x' })).toBe('');
  });

  it.each(['data-fc-consent-accept', 'data-fc-consent-decline', 'DATA-FC-CONSENT-ACCEPT', 'data-fc-sticky-cta-link'])('refuses the renderer attribute %s', (name) => {
    expect(published({ type: 'div', props: { [name]: '', id: 'keep' } })).toBe('<div id="keep"></div>');
    expect(editor('div', { [name]: '', id: 'keep' })).toBe('<div id="keep"></div>');
  });

  it('keeps the markers saved pages carry', () => {
    const props = { 'data-component-kind': 'x', 'data-decorative': '', 'data-credit-name': 'x' };
    expect(published({ type: 'div', props })).toBe('<div data-component-kind="x" data-decorative="" data-credit-name="x"></div>');
  });

  it.each(['__next_f', '__x', 'webpackChunk_N_E', 'fc-a', 'ground-wrapper-x', 'createElement', 'querySelector'])('refuses the id %s', (id) => {
    expect(published({ type: 'img', props: { id, alt: 'x' } })).not.toContain(`id="${id}"`);
    expect(editor('img', { id, alt: 'x' })).not.toContain(`id="${id}"`);
  });

  it.each([['img', 'createElement'], ['form', 'querySelector'], ['img', 'addEventListener'], ['input', 'submit'], ['form', 'action'], ['img', 'cookie']])('refuses <%s name=%s>', (type, name) => {
    expect(published({ type, props: { name, alt: 'x' } })).not.toContain('name=');
    expect(editor(type, { name, alt: 'x' })).not.toContain('name=');
  });

  it('keeps a member name as an ordinary id off an img', () => {
    expect(published({ type: 'label', props: { id: 'name' } })).toContain('id="name"');
    expect(published({ type: 'section', props: { id: 'links' } })).toContain('id="links"');
  });

  it('keeps an ordinary id and name', () => {
    const html = published({ type: 'img', props: { id: 'hero', name: 'email', alt: 'x' } });
    expect(html).toContain('id="hero"');
    expect(html).toContain('name="email"');
  });

  it.each([
    ['fill', 'url(https://evil.example/fill.svg#g)'],
    ['clip-path', 'url("https://evil.example/clip.svg#c")'],
    ['marker-end', "URL( 'https://evil.example/marker.svg#m' )"],
    ['mask', 'url(/a.svg#m)'],
    ['filter', 'url(https://evil.example/f.svg#f)'],
    ['cursor', 'image-set("https://evil.example/c.png" 1x)'],
    ['stroke', 'u\\72l(https://evil.example/s.svg#s)'],
  ])('refuses %s=%s, which reaches a file', (name, value) => {
    expect(published({ type: 'rect', props: { [name]: value, x: 1 } })).toBe('<rect x="1"></rect>');
  });

  it.each([['fill', 'url(#g)'], ['fill', 'red'], ['clip-path', 'url(#c)'], ['marker-end', "url('#m')"]])('keeps %s=%s', (name, value) => {
    expect(published({ type: 'rect', props: { [name]: value } })).toContain(`${name}=`);
  });

  it('keeps a title inside an svg and refuses one that would rename the tab', () => {
    const svg = published({ type: 'svg', children: [{ id: 't', type: 'title', props: { children: 'Chart' } }] });
    expect(svg).toContain('<title>Chart</title>');
    const inForeign = published({ type: 'svg', children: [{ id: 'f', type: 'foreignObject', children: [{ id: 't', type: 'title', props: { children: 'x' } }] }] });
    expect(inForeign).not.toContain('title');
    expect(published({ type: 'title', props: { children: 'Forged' } })).toBe('');
    expect(editor('title', { children: 'Forged' })).toBe('');
  });

  it.each(['itemprop', 'itemScope', 'itemtype', 'itemid', 'itemref', 'list', 'property', 'typeof', 'vocab', 'resource', 'about'])('keeps %s, which does nothing by itself', (name) => {
    expect(published({ type: 'div', props: { [name]: 'x' } }).toLowerCase()).toContain(name.toLowerCase());
  });

  it('refuses prefix, which would stop React on a custom element', () => {
    expect(published({ type: 'x-y', props: { prefix: 'x' } })).toBe('<x-y></x-y>');
  });

  it('keeps animation of a harmless attribute', () => {
    expect(published({ type: 'animate', props: { attributeName: 'opacity' } })).toContain('opacity');
  });

  it.each(['popover', 'POPOVER', 'popoverTarget', 'popovertargetaction', 'command', 'commandFor', 'action', 'formAction', 'formtarget', 'ping'])(
    'drops %s on the editor surfaces',
    (name) => {
      const html = editor('div', { [name]: 'x', id: 'keep' });
      expect(html).toBe('<div id="keep"></div>');
    },
  );

  it('never lets a stored form submit from an editor surface', () => {
    const element = createComponentElement({ type: 'form', props: {}, isHostElement: true } as never, { action: 'https://evil.test/steal' }, []) as React.ReactElement<{ action?: string; onSubmit: (e: { preventDefault(): void }) => void }>;
    expect(element.props.action).toBeUndefined();
    let stopped = false;
    element.props.onSubmit({ preventDefault: () => { stopped = true; } });
    expect(stopped).toBe(true);
  });

  it('keeps the handlers the editor attaches, which are functions', () => {
    const onClick = () => {};
    const element = createComponentElement({ type: 'div', props: {}, isHostElement: true } as never, { onClick }, []) as React.ReactElement<{ onClick: unknown }>;
    expect(element.props.onClick).toBe(onClick);
  });
});
