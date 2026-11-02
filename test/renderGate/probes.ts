// What the render gate fuzz puts on a page: every HTML, SVG and MathML element and
// attribute of the data the primitive score reads (test/score/lib/universe.ts),
// with every kind of value that could run, navigate, fetch or embed, in the
// spellings a browser or React reads alike. Nothing here knows what the gate does.
//
// One tier runs in continuous integration and one, RENDER_GATE_FULL=1, crosses all
// of it. The small tier keeps every element and every data row, with one value on
// each, and crosses every value and spelling only on the names that navigate or load.

import {
  htmlElementAttributes,
  htmlElements,
  htmlEventHandlers,
  htmlGlobalAttributes,
  mathmlAttributes,
  mathmlElements,
  svgAttributes,
  svgElements,
} from '../score/lib/universe';
import type { Entry } from '../score/lib/types';
import { DOM_MEMBER_NAMES, FORM_MEMBER_NAMES } from '@/lib/renderer/domMemberNames.generated';
import { RENDERED_ATTRIBUTES } from '@/lib/renderer/renderVocabulary';

export interface ProbeNode {
  id: string;
  type: string;
  props: Record<string, unknown>;
  children?: ProbeNode[];
  componentType?: string;
}

export interface Probe {
  id: string;
  /** Readable, for a finding. */
  what: string;
  node: ProbeNode;
  /** A click may leave the page: a plain link is meant to. */
  mayNavigate?: boolean;
  /**
   * Not a node's shape, as the save route may keep it. The model refuses this when
   * the editor loads a page, so only the published route has to survive it.
   */
  malformed?: boolean;
}

/** Runs in the page: the harness defines it before any markup loads. */
const run = (id: string) => `__hit('${id}')`;
export const FOREIGN = 'https://probe.invalid';
/** Where a refused CSS value points. Unlike FOREIGN, nothing may ever load from here. */
export const STYLE_HOST = 'https://style.invalid';

type Value = (id: string) => unknown;

/** Every value class that could act. `https` is an ordinary address, the rest must not survive. */
export const VALUES: Record<string, Value> = {
  js: (id) => `javascript:${run(id)}`,
  'js-case': (id) => `JaVaScRiPt:${run(id)}`,
  'js-tab': (id) => `java\tscript:${run(id)}`,
  'js-newline': (id) => `java\nscr\ript:${run(id)}`,
  'js-nul': (id) => `java\u0000script:${run(id)}`,
  'js-leading': (id) => ` \u0001\t javascript:${run(id)}`,
  'js-entity': (id) => `&#106;avascript:${run(id)}`,
  'js-array': (id) => [`javascript:${run(id)}`],
  vbscript: (id) => `vbscript:${run(id)}`,
  'data-html': (id) => `data:text/html,<script>parent.${run(id)}</script>`,
  'data-html-case': (id) => `DaTa:TeXt/HtMl;base64,${btoa(`<script>parent.${run(id)}</script>`)}`,
  'data-svg': (id) => `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" onload="parent.${run(id)}"/>`,
  blob: (id) => `blob:${FOREIGN}/${id}`,
  about: () => 'about:blank',
  https: (id) => `${FOREIGN}/${id}`,
  'protocol-relative': (id) => `//probe.invalid/${id}`,
  backslash: (id) => `\\\\probe.invalid/${id}`,
  code: (id) => run(id),
  html: (id) => `<img src=x onerror=${run(id)}>`,
};

const ROW_VALUES = ['js'];
const FEW_VALUES = ['js', 'https', 'code'];
const MAIN_ADDRESS_NAMES = new Set(['href', 'xlink:href', 'xlinkHref', 'src', 'srcset', 'action', 'formaction', 'formAction', 'poster']);

const ADDRESS_NAMES = [
  'href', 'xlink:href', 'xlinkHref', 'src', 'srcset', 'srcSet', 'action', 'formaction', 'formAction', 'data', 'poster',
  'cite', 'background', 'ping', 'attributionsrc', 'attributionSrc', 'manifest', 'codebase', 'xml:base', 'xmlBase', 'lowsrc',
  'dynsrc', 'longdesc', 'usemap', 'profile', 'srcdoc', 'srcDoc',
];

/** Each host in the parents that give it meaning. */
const ADDRESS_HOSTS: { type: string; parents?: string[]; props?: Record<string, unknown> }[] = [
  { type: 'a' },
  { type: 'area', parents: ['map'], props: { shape: 'default' } },
  { type: 'form', props: { method: 'get' } },
  { type: 'button', parents: ['form'], props: { type: 'submit' } },
  { type: 'input', parents: ['form'], props: { type: 'submit' } },
  { type: 'input', parents: ['form'], props: { type: 'image' } },
  { type: 'img' },
  { type: 'video' },
  { type: 'source', parents: ['video'] },
  { type: 'track', parents: ['video'] },
  { type: 'iframe' },
  { type: 'embed' },
  { type: 'object' },
  { type: 'x-y' },
  { type: 'a', parents: ['svg'] },
  { type: 'image', parents: ['svg'] },
  { type: 'use', parents: ['svg'] },
  { type: 'feImage', parents: ['svg', 'filter'] },
  { type: 'a', parents: ['math'] },
  { type: 'mrow', parents: ['math'] },
  { type: 'mi', parents: ['math'] },
];

const TABLE_PARENTS: Record<string, string[]> = {
  tr: ['table', 'tbody'], td: ['table', 'tbody', 'tr'], th: ['table', 'tbody', 'tr'], tbody: ['table'], thead: ['table'],
  tfoot: ['table'], caption: ['table'], colgroup: ['table'], col: ['table', 'colgroup'], area: ['map'],
  option: ['select'], optgroup: ['select'], source: ['video'], track: ['video'], summary: ['details'],
};

let serial = 0;

function probe(what: string, type: string, parents: string[], make: (id: string) => Omit<ProbeNode, 'id' | 'type'>, mayNavigate = false): Probe {
  const id = `p${++serial}`;
  const built = make(id);
  let node: ProbeNode = { id, type, ...built };
  [...parents].reverse().forEach((parent, index) => {
    node = { id: `${id}w${index}`, type: parent, props: {}, children: [node] };
  });
  return { id, what, node, ...(mayNavigate ? { mayNavigate: true } : {}) };
}

const upper = (name: string) => name.toUpperCase();
const mixed = (name: string) => [...name].map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join('');

const isAddress = (value: string) => value === 'https' || value === 'protocol-relative' || value === 'backslash';

function attributeProbes(type: string, parents: string[], name: string, values: readonly string[], base: Record<string, unknown> = {}): Probe[] {
  return values.map((value) =>
    probe(`<${type} ${name}=${value}>`, type, parents, (id) => ({ props: { ...base, [name]: VALUES[value](id), ...(type === 'a' ? { children: 'x' } : {}) } }), isAddress(value)),
  );
}

const ROOT: Record<string, string[]> = { html: [], svg: ['svg'], mathml: ['math'] };

function elementProbes(): Probe[] {
  const of = (entries: Entry[], namespace: string) =>
    entries.map((e) => {
      const table = namespace === 'html' ? (TABLE_PARENTS[e.id] ?? []) : [];
      return probe(`<${e.id}> in ${namespace}`, e.id, [...ROOT[namespace], ...table].filter((p) => p !== e.id), (id) => ({ props: { children: run(id) } }));
    });
  return [...of(htmlElements(), 'html'), ...of(svgElements(), 'svg'), ...of(mathmlElements(), 'mathml')];
}

function rowProbes(values: readonly string[], spellings: readonly ((name: string) => string)[]): Probe[] {
  const rows: Probe[] = [];
  const row = (entry: Entry, namespace: string, globalHost: string) => {
    const dot = entry.id.lastIndexOf('.');
    const name = dot === -1 ? entry.id : entry.id.slice(dot + 1);
    if (name.includes('_') || name.includes('*')) return;
    const tag = dot === -1 || entry.id.startsWith('*') ? globalHost : entry.id.slice(0, dot);
    const table = namespace === 'html' ? (TABLE_PARENTS[tag] ?? []) : [];
    const parents = [...ROOT[namespace], ...table].filter((p) => p !== tag);
    for (const spell of spellings) rows.push(...attributeProbes(tag, parents, spell(name), values));
  };
  htmlElementAttributes().forEach((e) => row(e, 'html', 'div'));
  htmlGlobalAttributes().forEach((e) => row(e, 'html', 'div'));
  htmlGlobalAttributes().forEach((e) => row(e, 'html', 'x-y'));
  svgAttributes().forEach((e) => row(e, 'svg', 'rect'));
  mathmlAttributes().forEach((e) => row(e, 'mathml', 'mi'));
  return rows;
}

function handlerProbes(full: boolean): Probe[] {
  return htmlEventHandlers().flatMap((e) =>
    (full ? ['div', 'x-y', 'img', 'details'] : ['x-y']).flatMap((type) =>
      (full ? [e.id, upper(e.id), mixed(e.id)] : [e.id, upper(e.id)]).flatMap((name) => attributeProbes(type, [], name, ['code'])),
    ),
  );
}

function addressProbes(full: boolean): Probe[] {
  return ADDRESS_HOSTS.flatMap(({ type, parents = [], props }) =>
    ADDRESS_NAMES.flatMap((name) => {
      const crossed = full || MAIN_ADDRESS_NAMES.has(name);
      const spellings = crossed ? [...new Set([name, upper(name), mixed(name)])] : [name];
      const values = crossed ? Object.keys(VALUES) : FEW_VALUES;
      return spellings.flatMap((spelling) => attributeProbes(type, parents, spelling, values, props));
    }),
  );
}

/** A `to`, `values` and a shape to click: an animation that could write an address or code. */
const animated = (attributeName: string, parent: string, parentProps: Record<string, unknown> = {}) =>
  probe(`<set attributeName=${attributeName}> in <${parent}>`, parent, ['svg'], (id) => ({
    props: { ...parentProps },
    children: [
      { id: `${id}s`, type: 'set', props: { attributeName, to: `javascript:${run(id)}`, begin: '0s' } },
      { id: `${id}a`, type: 'animate', props: { attributeName, values: `javascript:${run(id)}`, begin: '0s', dur: '1s' } },
      { id: `${id}r`, type: 'rect', props: { width: 9, height: 9 } },
    ],
  }));

function animationProbes(): Probe[] {
  return ['href', 'xlink:href', 'HREF', ' href', 'XLINK:HREF', 'target', 'onclick', 'onbegin', 'style', 'src', 'action', 'xml:base'].flatMap((name) => [
    animated(name, 'a', { href: '#x' }),
    animated(name, 'g'),
    animated(name, 'image', { href: `${FOREIGN}/img` }),
  ]);
}

const hostile = (what: string, type: string, parents: string[], props: (id: string) => Record<string, unknown>, children?: (id: string) => ProbeNode[]) =>
  probe(what, type, parents, (id) => ({ props: props(id), ...(children ? { children: children(id) } : {}) }));

/** The tag spellings a browser or createElementNS reads as something else. */
function tagProbes(): Probe[] {
  const tags = [
    '#TEXT', '#Text', '#tExT', '#COMPONENT', '#Component', '#x', '#',
    'SCRIPT', 'ScRiPt', 'script ', ' script', '\tscript', 'script/', 'script>', '<script>', 'scr\u0000ipt', 'ſcript',
    'svg:script', 'SVG:script', 'x:script', 'x-y:script', 'a-b:script', 'svg:style', 'x:iframe', 'html:script', 'xhtml:script',
    'svg:a', 'x:a', 'svg:animate', 'x:set', 'math:a', 'iframe ', 'IFRAME', 'x:foreignObject',
    'plaintext', 'xmp', 'listing', 'noembed', 'noframes', 'noscript', 'textarea', 'title', 'template', 'html', 'head', 'body',
    'permission', 'fencedframe', 'portal', 'webview', 'applet', 'bgsound', 'basefont', 'isindex', 'keygen', 'menuitem',
    'marquee', 'layer', 'ilayer', 'nolayer', 'nextid', 'blink', 'spacer', 'annotation-xml', 'font-face', 'color-profile', 'missing-glyph',
    'a b', 'a"b', '1a', '', '-', 'x-', '-x',
  ];
  return tags.flatMap((tag) =>
    [[], ['svg'], ['math'], ['svg', 'foreignObject']].map((parents) =>
      hostile(`tag ${JSON.stringify(tag)} in ${parents.join('>') || 'html'}`, tag, parents, (id) => ({
        children: run(id), href: `javascript:${run(id)}`, onload: run(id),
      })),
    ),
  );
}

/** What React does with a name beyond writing it: properties, reserved names, shapes JSON can hold. */
function reactProbes(): Probe[] {
  const list: Probe[] = [];
  const properties = ['innerHTML', 'outerHTML', 'innerText', 'outerText', 'textContent', 'srcdoc', 'INNERHTML', 'nonce', 'is', 'shadowRoot', 'attachShadow', 'setHTMLUnsafe'];
  for (const type of ['x-y', 'my-element', 'div', 'a']) {
    for (const name of properties) list.push(hostile(`<${type} ${name}=html>`, type, [], (id) => ({ [name]: VALUES.html(id) })));
  }
  for (const name of ['dangerouslySetInnerHTML', 'DANGEROUSLYSETINNERHTML', 'dangerouslysetinnerhtml']) {
    for (const type of ['div', 'x-y']) list.push(hostile(`<${type} ${name}>`, type, [], (id) => ({ [name]: { __html: VALUES.html(id) } })));
  }
  list.push(
    hostile('a __proto__ key holding a handler', 'div', [], (id) => JSON.parse(`{"__proto__":{"onclick":"__hit('${id}')","dangerouslySetInnerHTML":{"__html":"x"}}}`)),
    hostile('a constructor key', 'div', [], () => JSON.parse('{"constructor":{"prototype":{"x":1}}}')),
    hostile('a string ref', 'div', [], () => ({ ref: 'x' })),
    hostile('an object ref', 'div', [], () => ({ ref: { current: 1 } })),
    hostile('an object key', 'div', [], () => ({ key: { a: 1 } })),
    hostile('an object as text', 'div', [], () => ({ children: { a: 1 } })),
    hostile('an element-shaped object as text', 'div', [], () => ({ children: { $$typeof: 'x', type: 'script', props: {} } })),
    hostile('an array as text', 'div', [], () => ({ children: [{ a: 1 }] })),
    hostile('an attribute object with a broken toString', 'div', [], () => ({ title: { toString: 'x' } })),
    hostile('an address object with a broken toString', 'a', [], () => ({ href: { toString: 'x' } })),
    hostile('a nested array address', 'a', [], (id) => ({ href: [[`javascript:${run(id)}`]] })),
    hostile('a boolean href', 'a', [], () => ({ href: true })),
    hostile('a null attribute', 'div', [], () => ({ title: null })),
    hostile('suppressHydrationWarning as text', 'div', [], () => ({ suppressHydrationWarning: 'x' })),
    hostile('a form with a script action, submitted', 'form', [], (id) => ({ action: `javascript:${run(id)}` }), (id) => [{ id: `${id}b`, type: 'button', props: { type: 'submit', children: 'x' } }]),
    hostile('a button pointing at no form', 'button', [], (id) => ({ form: 'nope', formAction: `javascript:${run(id)}` })),
    hostile('a declarative shadow root', 'template', ['x-y'], () => ({ shadowrootmode: 'open', shadowRootMode: 'open' }), (id) => [{ id: `${id}i`, type: 'img', props: { src: 'x', onerror: run(id) } }]),
    hostile('an xml:base link', 'a', ['svg'], (id) => ({ 'xml:base': 'javascript:', href: run(id) })),
    hostile('an event attribute on svg', 'svg', [], (id) => ({ onload: run(id), onLoad: run(id) })),
    hostile('a marquee handler', 'marquee', [], (id) => ({ onstart: run(id), loop: 1 })),
    hostile('details toggle', 'details', [], (id) => ({ open: true, ontoggle: run(id) })),
    hostile('autofocus and onfocus', 'input', [], (id) => ({ autoFocus: true, onfocus: run(id) })),
    hostile('a popover target', 'button', [], (id) => ({ popovertarget: 'x', onbeforetoggle: run(id) })),
    hostile('maction', 'maction', ['math'], (id) => ({ actiontype: `statusline#javascript:${run(id)}`, xref: `javascript:${run(id)}` })),
    hostile('a mathml link', 'mtext', ['math'], (id) => ({ href: `javascript:${run(id)}` })),
    hostile('use with a data document', 'use', ['svg'], (id) => ({
      href: `data:image/svg+xml,<svg id="x" xmlns="http://www.w3.org/2000/svg"><image href="x" onerror="parent.${run(id)}"/></svg>#x`,
    })),
    hostile('use with a foreign document', 'use', ['svg'], (id) => ({ href: `${FOREIGN}/${id}.svg#x` })),
    hostile('a link with ping', 'a', [], (id) => ({ href: '#x', ping: `${FOREIGN}/${id}` })),
    hostile('an image with attribution', 'img', [], (id) => ({ src: `${FOREIGN}/${id}.png`, attributionsrc: `${FOREIGN}/${id}a` })),
    hostile('an image loading script', 'img', [], (id) => ({ src: `javascript:${run(id)}`, srcset: `javascript:${run(id)} 1x` })),
    hostile('an http-equiv on a div', 'div', [], () => ({ 'http-equiv': 'refresh', content: `0;url=${FOREIGN}/x` })),
  );
  return list;
}

const STYLE_VALUES: ((id: string) => unknown)[] = [
  (id) => `red;background:url(${STYLE_HOST}/${id})`,
  (id) => `red;background-image:url("${STYLE_HOST}/${id}")`,
  (id) => `url(${STYLE_HOST}/${id});color:red`,
  (id) => `red</style><script>${run(id)}</script>`,
  (id) => `red;}</style><img src=x onerror=${run(id)}>`,
  (id) => `expression(${run(id)})`,
  (id) => `url(javascript:${run(id)})`,
  (id) => `@import url(${STYLE_HOST}/${id})`,
  (id) => `/*"*/;background:url(${STYLE_HOST}/${id});/*"*/`,
  (id) => `"\\"";background:url(${STYLE_HOST}/${id});"`,
  (id) => ({ base: `red;background:url(${STYLE_HOST}/${id})` }),
  (id) => ({ desktop: `red}</style><script>${run(id)}</script>`, tablet: 'blue' }),
  () => ({ toString: 'x' }),
  () => ['red'],
];

/** Inline style reaching the DOM: a value, a key and shapes a style cannot be. */
function styleProbes(): Probe[] {
  const list = STYLE_VALUES.flatMap((value) =>
    ['color', 'background', '--x', 'fontFamily'].map((key) => hostile(`style ${key}`, 'div', [], (id) => ({ style: { [key]: value(id) } }))),
  );
  list.push(
    hostile('a style string', 'div', [], (id) => ({ style: `color:red;background:url(${STYLE_HOST}/${id})` })),
    hostile('a style array', 'div', [], () => ({ style: [{ color: 'red' }] })),
    hostile('a style number', 'div', [], () => ({ style: 1 })),
    hostile('a style key with a declaration', 'div', [], (id) => ({ style: { 'color:red;background:url(x)': `url(${STYLE_HOST}/${id})` } })),
    hostile('a style key with a breakout', 'div', [], (id) => ({ style: { '</style><script>': run(id) } })),
    hostile('a STYLE prop', 'div', [], (id) => ({ STYLE: `background:url(${STYLE_HOST}/${id})` })),
    hostile('a rule closing its style element', 'div', [], (id) => ({ rules: [{ id: 'r', selector: `&:hover</style><script>${run(id)}</script>`, style: { color: 'red' } }] })),
    hostile('a rule value closing its style element', 'div', [], (id) => ({ rules: [{ id: 'r', selector: '&:hover', style: { color: `red</style><script>${run(id)}</script>` } }] })),
    hostile('a rule importing a sheet', 'div', [], (id) => ({ rules: [{ id: 'r', define: `@import url(${STYLE_HOST}/${id})` }] })),
    hostile('a rule loading an address', 'div', [], (id) => ({ rules: [{ id: 'r', selector: '&', style: { background: `url(${STYLE_HOST}/${id})` } }] })),
    hostile('a style string on a custom element', 'x-y', [], (id) => ({ style: `background:url(${STYLE_HOST}/${id})` })),
  );
  return list;
}

/** What the renderers' own attributes are called: a runtime acts on these. */
function rendererAttributeProbes(): Probe[] {
  const names = ['data-fc-consent-accept', 'data-fc-consent-decline', 'data-fc-site-base', 'data-fc-sticky-cta-link'];
  const spelled = names.flatMap((name) => [name, upper(name), mixed(name)]);
  return spelled.flatMap((name) => ['div', 'a', 'x-y'].map((type) => hostile(`renderer attribute ${name} on <${type}>`, type, [], () => ({ [name]: '' }))));
}

/** What a page's own code reaches by name: a global through `id`, a method of `document` through `name`. */
function nameProbes(full: boolean): Probe[] {
  const globals = ['__next_f', '__next_s', '__fcImportTracker', '__lumitraConsent', 'webpackChunk_N_E', 'webpackChunk_x', 'fc-a', 'ground-wrapper-x'];
  const members = full ? DOM_MEMBER_NAMES : ['createElement', 'querySelector', 'addEventListener', 'getElementById', 'cookie', 'forms', 'body', 'submit', 'action', 'elements'];
  return [
    ...globals.flatMap((id) => ['div', 'img', 'form'].map((type) => hostile(`id ${id} on <${type}>`, type, [], () => ({ id, name: 'kept' })))),
    ...members.flatMap((name) => [
      hostile(`name ${name} on <img>`, 'img', [], () => ({ name, src: '/x.png', alt: '' })),
      hostile(`name ${name} on <form>`, 'form', [], () => ({ name })),
      hostile(`id ${name} and a name on <img>`, 'img', [], () => ({ id: name, name: 'kept', src: '/x.png', alt: '' })),
    ]),
  ];
}

/**
 * What a form exposes by name. A control with a member's `id` replaces that member, in
 * a form or anywhere else through `form=`, so code walking up from the form never ends.
 * A stored field's name reaches its control the same way, past the attribute gate.
 */
const nest = (id: string, types: string[], child: ProbeNode): ProbeNode =>
  types.reduceRight((inner, type, index) => ({ id: `${id}${index}`, type, props: {}, children: [inner] }), child);

/** Where the parser leaves SVG or MathML, so `image` under it is an `img` again. */
const PARSER_ESCAPES: [string, (child: ProbeNode) => ProbeNode][] = [
  ['in foreignObject', (child) => nest(`${child.id}e`, ['svg', 'foreignObject'], child)],
  ['in desc', (child) => nest(`${child.id}e`, ['svg', 'desc'], child)],
  ['in an svg title', (child) => nest(`${child.id}e`, ['svg', 'title'], child)],
  ['in a breakout from svg', (child) => nest(`${child.id}e`, ['svg', 'g', 'p'], child)],
  ['in mi', (child) => nest(`${child.id}e`, ['math', 'mi'], child)],
  ['in svg', (child) => nest(`${child.id}e`, ['svg', 'g'], child)],
];

const FORM_CONTROLS = ['button', 'fieldset', 'img', 'input', 'output', 'select', 'textarea'];

function formMemberProbes(full: boolean): Probe[] {
  const members = full ? FORM_MEMBER_NAMES.filter((name) => name !== 'name') : ['parentElement', 'parentNode', 'closest', 'matches', 'elements', 'submit', 'getAttribute', 'tagName'];
  const box = (id: string): ProbeNode['props'] => ({ id: `${id}f` });
  const control = (id: string, type: string, props: ProbeNode['props'], children: ProbeNode[] = []): ProbeNode => ({
    id: `${id}c`, type, props: type === 'img' ? { ...props, src: '/x.png', alt: '' } : props, children,
  });
  const marked = (kind: string, props: ProbeNode['props']) => ({ 'data-form-kind': kind, ...props });
  return members.flatMap((name) => [
    ...FORM_CONTROLS.flatMap((type) => [
      hostile(`<form> holding <${type} id=${name}>`, 'form', [], box, (id) => [control(id, type, { id: name })]),
      hostile(`<${type} id=${name} form=> beside its <form>`, 'div', [], () => ({}), (id) => [
        { id: `${id}o`, type: 'form', props: box(id) },
        control(id, type, { id: name, form: `${id}f` }),
      ]),
    ]),
    hostile(`<form> holding <input ID=${name}>`, 'form', [], box, (id) => [control(id, 'input', { ID: name })]),
    ...['image', 'IMAGE'].flatMap((type) => [
      hostile(`<form> holding <${type} id=${name}>`, 'form', [], box, (id) => [control(id, type, { id: name })]),
      hostile(`<form> holding <${type} ID=${name}>`, 'form', [], box, (id) => [control(id, type, { ID: name })]),
    ]),
    ...PARSER_ESCAPES.map(([what, path]) =>
      hostile(`<form> holding <image id=${name}> ${what}`, 'form', [], box, (id) => [path(control(id, 'image', { id: name }))]),
    ),
    hostile(`<form> holding <image id=${name}> after a breakout from svg`, 'form', [], box, (id) => [
      { id: `${id}v`, type: 'svg', props: {}, children: [{ id: `${id}b`, type: 'p', props: {} }, control(id, 'image', { id: name })] },
    ]),
    hostile(`<form> holding <table> holding <input id=${name}>`, 'form', [], box, (id) => [{ id: `${id}t`, type: 'table', props: {}, children: [control(id, 'input', { id: name })] }]),
    hostile(`a stored form with a field called ${name}`, 'div', [], () => marked('form', {}), (id) => [
      { id: `${id}n`, type: 'div', props: marked('form-field', { fieldType: 'text', name, label: 'x' }) },
    ]),
    hostile(`a stored form with a submit button id=${name}`, 'div', [], () => marked('form', {}), (id) => [
      { id: `${id}s`, type: 'button', props: marked('form-submit', { id: name, children: 'x' }) },
    ]),
    hostile(`a stored form with a marked div id=${name} as its button`, 'div', [], () => marked('form', {}), (id) => [
      { id: `${id}s`, type: 'div', props: marked('form-submit', { id: name, children: 'x' }) },
    ]),
  ]);
}

/**
 * A name in another case. Markup does not care, so `ACTION` is `action`, and the first
 * of the two wins where a renderer writes its own value after a stored one.
 */
function spellingProbes(): Probe[] {
  const list: Probe[] = [];
  const marked = (kind: string, props: ProbeNode['props']) => ({ 'data-form-kind': kind, ...props });
  const submit = (id: string): ProbeNode => ({ id: `${id}s`, type: 'button', props: marked('form-submit', { children: 'x' }) });
  for (const name of ['ACTION', 'Action', 'aCTION']) {
    list.push(hostile(`a stored form with ${name} elsewhere`, 'div', [], (id) => marked('form', { [name]: `${FOREIGN}/${id}` }), (id) => [submit(id)]));
  }
  for (const name of ['METHOD', 'ENCTYPE', 'TARGET']) {
    list.push(hostile(`a stored form with ${name}`, 'div', [], () => marked('form', { [name]: name === 'TARGET' ? '_blank' : 'get' }), (id) => [submit(id)]));
  }
  for (const name of ['FORMACTION', 'FormAction', 'fORMaCTION']) {
    list.push(hostile(`a stored form with a button ${name} elsewhere`, 'div', [], () => marked('form', {}), (id) => [
      { id: `${id}s`, type: 'button', props: { [name]: `${FOREIGN}/${id}`, type: 'submit', children: 'x' } },
    ]));
  }
  for (const name of ['ID', 'Id', 'iD']) {
    list.push(hostile(`<img ${name}=createElement> with a name`, 'img', [], () => ({ [name]: 'createElement', name: 'kept', src: '/x.png', alt: '' })));
  }
  // Past the platform's submission, from inside a live form and from outside it. Lower
  // case is the plain spelling of what every other probe here spells.
  for (const name of ['formaction', 'formAction', 'FORMACTION']) {
    list.push(hostile(`a stored form with a deep button ${name} elsewhere`, 'div', [], (id) => marked('form', { id: `${id}f` }), (id) => [
      { id: `${id}w`, type: 'div', props: {}, children: [{ id: `${id}s`, type: 'button', props: { [name]: `${FOREIGN}/${id}`, type: 'submit', children: 'x' } }] },
    ]));
    list.push(hostile(`a stored form with an outside button ${name} elsewhere`, 'div', [], () => ({}), (id) => [
      { id: `${id}l`, type: 'div', props: marked('form', { id: `${id}f` }), children: [] },
      { id: `${id}s`, type: 'button', props: { [name]: `${FOREIGN}/${id}`, form: `${id}f`, type: 'submit', children: 'x' } },
    ]));
  }
  for (const type of ['p', 'div', 'span', 'img', 'table']) {
    list.push(hostile(`<${type}> directly in svg before an image`, 'svg', [], () => ({}), (id) => [
      { id: `${id}h`, type, props: {} },
      { id: `${id}i`, type: 'image', props: { id: `${id}x` } },
    ]));
  }

  // The whole vocabulary, by what could run or leave, in both spellings on what acts on an address.
  for (const name of [...RENDERED_ATTRIBUTES].filter((attribute) => upper(attribute) !== attribute)) {
    for (const spelled of [upper(name), mixed(name)]) {
      for (const type of ['a', 'form']) list.push(hostile(`spelled ${spelled} on <${type}>`, type, [], (id) => ({ [spelled]: VALUES.js(id) })));
    }
  }
  return list;
}

/** A paint or filter attribute reaching a file. A reference inside the page is how SVG works. */
function cssReferenceProbes(): Probe[] {
  // Not `filter`: the model reads that as a style on the canvas, where an image may load.
  const names = ['fill', 'stroke', 'mask', 'cursor', 'clip-path', 'clipPath', 'marker-start', 'marker-mid', 'marker-end', 'markerEnd'];
  const values = [
    (id: string) => `url(${STYLE_HOST}/${id}.svg#g)`,
    (id: string) => `URL("${STYLE_HOST}/${id}.svg#g")`,
    (id: string) => `url( '${STYLE_HOST}/${id}.svg#g' )`,
    (id: string) => `u\\72l(${STYLE_HOST}/${id}.svg#g)`,
    (id: string) => `image-set("${STYLE_HOST}/${id}.png" 1x)`,
  ];
  return names.flatMap((name) => values.map((value) => hostile(`css reference ${name}`, 'rect', ['svg'], (id) => ({ [name]: value(id), width: 9, height: 9 }))));
}

/** Every name the gate lets through, on the one element where React writes properties. */
function renderedNameProbes(): Probe[] {
  return [...RENDERED_ATTRIBUTES].filter((name) => !['children', 'key', 'ref', 'style'].includes(name)).map((name) =>
    hostile(`rendered name ${name} on <x-y>`, 'x-y', [], () => ({ [name]: 'x' })),
  );
}

/** Stored as a function component: the registry is empty, so these must come to nothing. */
function componentTypeProbes(): Probe[] {
  return ['script', 'constructor', '__proto__', '#TEXT', 'iframe'].map((type) => {
    const made = hostile(`a function component ${type}`, type, [], (id) => ({ children: run(id) }));
    made.node.componentType = 'function';
    return made;
  });
}

/** A tree the save route keeps and no renderer may trip on. */
function shapeProbes(): Probe[] {
  const shapes: [string, Record<string, unknown>][] = [
    ['children as text', { type: 'div', props: {}, children: 'x' }],
    ['children as a number', { type: 'div', props: {}, children: 1 }],
    ['children as an object', { type: 'div', props: {}, children: { type: 'p' } }],
    ['a null child', { type: 'div', props: {}, children: [null] }],
    ['a text child', { type: 'div', props: {}, children: ['x'] }],
    ['a number child', { type: 'div', props: {}, children: [1] }],
    ['an array child', { type: 'div', props: {}, children: [[{ type: 'p', props: {} }]] }],
    ['a null child deep down', { type: 'div', props: {}, children: [{ type: 'p', props: {}, children: [null] }] }],
    ['props as text', { type: 'div', props: 'x' }],
    ['props as an array', { type: 'div', props: ['x'] }],
    ['props as null', { type: 'div', props: null }],
    ['no props', { type: 'div' }],
    ['a numeric type', { type: 1, props: {} }],
    ['a null type', { type: null, props: {} }],
    ['an object type', { type: { a: 1 }, props: {} }],
    ['no type', { props: {} }],
    ['bindings as text', { type: 'div', props: {}, bindings: 'x' }],
    ['bindings as an array', { type: 'div', props: {}, bindings: ['x'] }],
    ['a null binding', { type: 'div', props: {}, bindings: { children: null } }],
    ['effects as text', { type: 'div', props: { effects: 'x' } }],
    ['rules as an object', { type: 'div', props: { rules: { a: 1 } } }],
    ['behaviour as an object', { type: 'div', props: { behaviour: { a: 1 } } }],
    ['an object id', { type: 'div', id: { a: 1 }, props: {} }],
    ['instance as an object', { type: 'div', props: { instance: { a: 1 } } }],
    ['instance with null definitions', { type: 'div', props: { instance: { inputs: {}, bindings: {}, inputDefinitions: [null] } } }],
    ['instance with odd definitions', { type: 'div', props: { instance: { inputs: {}, bindings: {}, inputDefinitions: [{}] } } }],
    ['a text node with children', { type: '#text', props: { children: 'x' }, children: 'y' }],
  ];
  return shapes.map(([what, node]) => {
    const made = probe(`shape: ${what}`, 'div', [], () => ({ props: {} }));
    made.node = { id: made.id, ...node } as unknown as ProbeNode;
    made.malformed = true;
    return made;
  });
}

export function buildProbes(full: boolean): Probe[] {
  serial = 0;
  return [
    ...elementProbes(),
    ...tagProbes(),
    ...reactProbes(),
    ...shapeProbes(),
    ...rendererAttributeProbes(),
    ...nameProbes(full),
    ...formMemberProbes(full),
    ...spellingProbes(),
    ...cssReferenceProbes(),
    ...renderedNameProbes(),
    ...componentTypeProbes(),
    ...styleProbes(),
    ...animationProbes(),
    ...handlerProbes(full),
    ...addressProbes(full),
    ...(full ? rowProbes(Object.keys(VALUES), [(n) => n, upper, mixed]) : rowProbes(ROW_VALUES, [(n) => n])),
  ];
}
