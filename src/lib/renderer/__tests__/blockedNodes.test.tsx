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

  it.each(['onclick', 'onClick', 'onload', 'onError', 'onanimationend', 'onToggle', 'ontimeupdate', 'onwaiting'])('never lets a stored %s string reach a page, now that events run', (name) => {
    expect(published({ type: 'div', props: { [name]: 'probe()', id: 'keep' } })).toBe('<div id="keep"></div>');
    expect(editor('div', { [name]: 'probe()', id: 'keep' })).toBe('<div id="keep"></div>');
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

  it.each(['ID', 'Id'])('refuses <img %s=createElement>, which would replace a method of document', (name) => {
    expect(published({ type: 'img', props: { [name]: 'createElement', name: 'kept', alt: 'x' } }).toLowerCase()).not.toContain('createelement');
    expect(published({ type: 'img', props: { id: 'ok', [name]: 'createElement', alt: 'x' } })).toContain('id="ok"');
  });

  it('keeps a member name as an ordinary id off an img', () => {
    expect(published({ type: 'label', props: { id: 'name' } })).toContain('id="name"');
    expect(published({ type: 'section', props: { id: 'links' } })).toContain('id="links"');
  });

  it.each([
    ['button', 'parentElement'], ['input', 'closest'], ['fieldset', 'elements'], ['select', 'submit'],
    ['textarea', 'matches'], ['output', 'parentNode'], ['INPUT', 'getAttribute'], ['img', 'closest'],
  ])('refuses <%s id=%s>, which replaces a member of its form', (type, id) => {
    expect(published({ type, props: { id, alt: 'x' } })).not.toContain('id=');
    expect(editor(type, { id, alt: 'x' })).not.toContain('id=');
  });

  it.each(['ACTION', 'Action', 'METHOD', 'CLASS', 'Class', 'CLASSNAME', 'STYLE', 'CHILDREN', 'KEY', 'REF', 'ID', 'NAME', 'HREF', 'TYPE', 'FORM', 'FORMACTION', 'FormMethod', 'FORMTARGET', 'FORMENCTYPE', 'DATA-FORM-KIND', 'DATA-COMPONENT-KIND'])(
    'refuses %s, another spelling of a name a renderer reads',
    (name) => {
      expect(published({ type: 'div', props: { [name]: 'x', id: 'keep' } })).toBe('<div id="keep"></div>');
      expect(editor('div', { [name]: 'x', id: 'keep' })).toBe('<div id="keep"></div>');
    },
  );

  it('keeps stored names as written, in the spellings React and SVG use', () => {
    const svg = published({ type: 'svg', props: { viewBox: '0 0 9 9', preserveAspectRatio: 'none' } });
    expect(svg).toContain('viewBox="0 0 9 9"');
    expect(svg).toContain('preserveAspectRatio="none"');
    expect(published({ type: 'path', props: { strokeWidth: 2, strokeLinecap: 'round' } })).toBe('<path stroke-width="2" stroke-linecap="round"></path>');
    expect(published({ type: 'form', props: { noValidate: true, encType: 'text/plain' } })).toContain('encType="text/plain"');
    expect(published({ type: 'button', props: { formAction: '/x', formMethod: 'post' } })).toContain('formAction="/x"');
    expect(published({ type: 'div', props: { className: 'a' } })).toBe('<div class="a"></div>');
    expect(published({ type: 'div', props: { class: 'a' } })).toContain('class="a"');
  });

  it('keeps a live form on its own address, whatever a stored name spells', () => {
    const html = published({ type: 'div', props: { 'data-form-kind': 'form', ACTION: 'https://elsewhere.example/', Method: 'get' } });
    expect(html.toLowerCase()).not.toContain('elsewhere');
    expect(html.match(/action=/gi)).toHaveLength(1);
    expect(html.match(/method=/gi)).toHaveLength(1);
  });

  it.each(['form', 'formAction', 'formaction', 'formMethod', 'formmethod', 'formTarget', 'formEncType', 'formenctype'])('drops %s on the editor surfaces only', (name) => {
    expect(editor('button', { [name]: 'x' })).toBe('<button></button>');
    expect(published({ type: 'button', props: { [name]: 'x' } }).toLowerCase()).toContain(name.toLowerCase());
  });

  it.each(['ID', 'Id', 'iD'])('refuses the member id in the spelling %s', (name) => {
    expect(published({ type: 'input', props: { [name]: 'parentElement' } }).toLowerCase()).not.toContain('id=');
    expect(editor('input', { [name]: 'parentElement' }).toLowerCase()).not.toContain('id=');
  });

  it('refuses a member id tied to a form from outside it', () => {
    const html = published({ type: 'button', props: { id: 'closest', form: 'f' } });
    expect(html).not.toContain('id=');
    expect(html).toContain('form="f"');
  });

  it.each(['image', 'IMAGE', 'Image'])('renders no stored <%s> outside svg, where the parser makes it an img', (type) => {
    expect(published({ type, props: { href: '/x.png' } })).toBe('');
    expect(editor(type, { href: '/x.png' })).toBe('');
    const wrap = (...tags: string[]) => tags.reduceRight<Record<string, unknown>>((child, tag, index) => ({ id: `w${index}`, type: tag, children: [child] }), { id: 'i', type, props: { href: '/x.png' } });
    for (const inner of ['foreignObject', 'desc', 'title', 'p', 'span']) expect(published(wrap('svg', inner)).toLowerCase()).not.toContain('<image');
    expect(published(wrap('math', 'mi'))).not.toContain('<image');
    expect(published(wrap('section'))).not.toContain('<image');
  });

  it('keeps an image in svg, also after an integration point opens svg again', () => {
    expect(published({ type: 'svg', children: [{ id: 'g', type: 'g', children: [{ id: 'i', type: 'image', props: { href: '/x.png' } }] }] })).toContain('<image');
    const again = { type: 'svg', children: [{ id: 'f', type: 'foreignObject', children: [{ id: 's', type: 'svg', children: [{ id: 'i', type: 'image', props: {} }] }] }] };
    expect(published(again)).toContain('<image');
  });

  it.each(['p', 'div', 'SPAN', 'img', 'table', 'font'])('renders no <%s> directly in svg, which the parser would leave it for', (type) => {
    const svg = { type: 'svg', children: [{ id: 'g', type: 'g', children: [{ id: 'h', type, props: { children: 'x' } }] }, { id: 'r', type: 'rect', props: {} }] };
    expect(published(svg)).toBe('<svg><g></g><rect></rect></svg>');
  });

  it('keeps HTML in foreignObject, and what is only a name in svg', () => {
    const inForeign = { type: 'svg', children: [{ id: 'f', type: 'foreignObject', children: [{ id: 'p', type: 'p', props: { children: 'x' } }] }] };
    expect(published(inForeign)).toContain('<p>x</p>');
    expect(published({ type: 'svg', children: [{ id: 'a', type: 'a', children: [{ id: 't', type: 'text', props: { children: 'x' } }] }] })).toContain('<text>x</text>');
  });

  it.each(['formAction', 'formaction', 'formMethod', 'formTarget', 'formEncType', 'formenctype'])('drops %s on a control of a live form, at any depth', (name) => {
    const control = { id: 'c', type: 'button', props: { [name]: '/elsewhere', children: 'x' } };
    const box = { id: 'b', type: 'div', children: [control] };
    const html = published({ id: 'f', type: 'div', props: { 'data-form-kind': 'form' }, children: [box] }).toLowerCase();
    expect(html).toContain('<button>x</button>');
  });

  it.each(['formAction', 'formMethod', 'formTarget', 'formEncType'])('drops %s on a control tied to a form from outside', (name) => {
    expect(published({ type: 'button', props: { form: 'f', [name]: '/elsewhere' } })).toBe('<button form="f"></button>');
  });

  it('keeps an owner\'s form logic on a plain form', () => {
    const html = published({ type: 'form', props: { action: 'https://example.com/x' }, children: [{ id: 'b', type: 'button', props: { formAction: 'https://example.com/y' } }] });
    expect(html).toContain('action="https://example.com/x"');
    expect(html).toContain('formAction="https://example.com/y"');
  });

  it.each(['id', 'ID'])('drops a member %s on an image even inside svg: a sibling can end the svg', (name) => {
    const image = { id: 'i', type: 'image', props: { [name]: 'parentElement' } };
    expect(published({ type: 'svg', children: [image] }).toLowerCase()).not.toContain('id=');
    expect(published({ type: 'svg', children: [{ id: 'i', type: 'image', props: { id: 'hero' } }] })).toContain('id="hero"');
  });

  it.each(['button', 'div'])('refuses a member id on a stored submit button, stored as <%s>', (type) => {
    const props = { 'data-form-kind': 'form-submit', id: 'closest', children: 'x' };
    const html = published({ type: 'div', props: { 'data-form-kind': 'form' }, children: [{ id: 's', type, props }] });
    expect(html).not.toContain('id="closest"');
    const canvas = createComponentElement({ type, props, isHostElement: true } as never, props, [], 'x');
    expect(renderToStaticMarkup(canvas as never)).toBe('<button type="button">x</button>');
  });

  it('gives a stored field called after a form member a name of its own', () => {
    const field = { id: 'f', type: 'div', props: { 'data-form-kind': 'form-field', fieldType: 'text', name: 'parentElement', label: 'x' } };
    const html = published({ type: 'div', props: { 'data-form-kind': 'form' }, children: [field] });
    expect(html).toContain('name="parentElement_field"');
    expect(html).not.toContain('name="parentElement"');
  });

  it('keeps what no form exposes: another tag, or a name that is no member of a form', () => {
    expect(published({ type: 'form', children: [{ id: 'l', type: 'label', props: { id: 'parentElement' } }] })).toContain('id="parentElement"');
    expect(published({ type: 'div', props: { id: 'closest' } })).toContain('id="closest"');
    for (const id of ['email', 'links', 'close', 'name']) expect(published({ type: 'input', props: { id } })).toContain(`id="${id}"`);
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
