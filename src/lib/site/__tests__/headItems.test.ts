// Head items (contract docs/plans/2026-11-02-theme-and-head.md, slice H1): every row of every
// list both ways, every refusal as a stored item, the merge, the caps, the safe copy and the
// `__proto__` defence. The browser's own reading of the emitted tags is slice H2's.

import { describe, expect, it } from 'vitest';
import {
  FEED_TYPES,
  HEAD_LIMITS,
  LINK_RELS,
  META_NAMES,
  PROPERTY_NAMES,
  changeHeadKind,
  copyStoredItem,
  copyStoredItems,
  headItemKey,
  isHeadHref,
  parseHeadItem,
  parseJsonLdData,
  parseJsonLdInput,
  parseOgType,
  resolveHead,
  storeHeadItems,
  type HeadItem,
} from '../headItems';

const ok = (raw: unknown): HeadItem => {
  const result = parseHeadItem(raw);
  if (!result.ok) throw new Error(JSON.stringify(result.refusal));
  return result.item;
};
const refusal = (raw: unknown) => {
  const result = parseHeadItem(raw);
  if (result.ok) throw new Error(`accepted ${JSON.stringify(raw).slice(0, 200)}`);
  return result.refusal;
};
const meta = (name: string, content = 'value') => ({ kind: 'meta', name, content });
const prop = (property: string, content = 'value') => ({ kind: 'property', property, content });
const link = (rel: string, href = 'https://example.com/x', extra: Record<string, unknown> = {}) => ({ kind: 'link', rel, href, ...extra });
const ld = (extra: Record<string, unknown> = {}) => ({
  kind: 'jsonld',
  data: { '@context': 'https://schema.org', '@type': 'Organization', name: 'Bakery', ...extra },
});

/** An item fed to every H1 path, whose JSON holds a `__proto__` key. */
const forged = JSON.parse('{"kind":"link","rel":"me","href":"/a","__proto__":{"kind":"link","polluted":true}}');

describe('meta names', () => {
  it.each([...META_NAMES])('accepts %s', (name) => {
    expect(ok(meta(name))).toEqual({ kind: 'meta', name, content: 'value' });
  });

  it.each([
    ['description', 'Description'],
    ['keywords', 'Keywords'],
    ['robots', 'search engines'],
    ['og:title', 'Social title'],
    ['og:description', 'Social description'],
    ['og:image', 'Social image'],
    ['og:url', 'Canonical'],
    ['og:site_name', 'Site name'],
    ['og:locale', 'Language'],
    ['og:type', 'Content type'],
    ['twitter:card', 'Twitter card'],
    ['twitter:title', 'Social title'],
    ['twitter:description', 'Social description'],
    ['twitter:image', 'Social image'],
  ])('refuses the owned name %s and names the field to use', (name, pointer) => {
    const r = refusal(meta(name));
    expect(r.code).toBe('owned');
    expect(r.message).toContain(pointer);
  });

  it.each(['viewport', 'color-scheme', 'theme-color', 'referrer', 'charset', 'itemprop', 'Author', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'x-unknown'])(
    'refuses %s',
    (name) => {
      expect(refusal(meta(name)).code).toMatch(/not-allowed|owned/);
    },
  );

  it('refuses http-equiv in every shape it can be stored in', () => {
    expect(refusal({ kind: 'meta', 'http-equiv': 'refresh', content: '0;url=https://evil.test' }).code).toBe('shape');
    expect(refusal({ kind: 'meta', name: 'author', 'http-equiv': 'refresh', content: 'x' }).message).toContain('http-equiv');
    expect(refusal({ kind: 'http-equiv', content: 'x' }).code).toBe('kind');
    expect(refusal(meta('http-equiv')).code).toBe('not-allowed');
  });

  it('refuses a tag holding both name and property, and any other attribute', () => {
    expect(refusal({ kind: 'meta', name: 'author', property: 'article:tag', content: 'x' }).code).toBe('shape');
    expect(refusal({ kind: 'meta', name: 'author', content: 'x', onload: 'alert(1)' }).code).toBe('shape');
  });

  it('refuses empty, long, non-text and multi-line content', () => {
    expect(refusal(meta('author', '')).code).toBe('value');
    expect(refusal(meta('author', '   ')).code).toBe('value');
    expect(refusal(meta('author', 'x'.repeat(HEAD_LIMITS.content + 1))).code).toBe('value');
    expect(ok(meta('author', 'x'.repeat(HEAD_LIMITS.content)))).toBeTruthy();
    expect(refusal({ kind: 'meta', name: 'author', content: 5 }).code).toBe('value');
    expect(refusal(meta('author', 'a\nb')).code).toBe('value');
    expect(refusal({ kind: 'meta', name: 'author' }).code).toBe('value');
  });
});

describe('properties', () => {
  it.each(['article:tag', 'article:author', 'article:section', 'product:price:amount', 'profile:first_name', 'book:isbn', 'book:tag', ...PROPERTY_NAMES])(
    'accepts %s',
    (property) => {
      expect(ok(prop(property))).toEqual({ kind: 'property', property, content: 'value' });
    },
  );

  it.each(['og:title', 'og:type', 'og:image', 'og:url', 'twitter:card'])('refuses the owned property %s', (property) => {
    expect(refusal(prop(property)).code).toBe('owned');
  });

  it.each(['og:video:width', 'og:locale', 'article:', 'article', 'Article:tag', 'article:Tag', 'music:song', 'xyz:abc', 'constructor', '__proto__', 'article:tag:'])(
    'refuses %s',
    (property) => {
      expect(refusal(prop(property)).code).toMatch(/not-allowed|owned|shape/);
    },
  );
});

describe('links', () => {
  it.each(LINK_RELS.filter((r) => r !== 'alternate'))('accepts rel %s', (rel) => {
    expect(ok(link(rel))).toEqual({ kind: 'link', rel, href: 'https://example.com/x' });
  });

  it.each([
    'next',
    'prev',
    'search',
    'webmention',
    'pingback',
    'bookmark',
    'tag',
    'canonical',
    'manifest',
    'icon',
    'shortcut icon',
    'apple-touch-icon',
    'stylesheet',
    'STYLESHEET',
    'alternate stylesheet',
    ' stylesheet\t',
    'preload',
    'prefetch',
    'modulepreload',
    'compression-dictionary',
    'preconnect',
    'dns-prefetch',
    'mask-icon',
    'dictionary',
    'expect',
    'constructor',
    '__proto__',
    '',
  ])('refuses rel %j', (rel) => {
    expect(refusal(link(rel)).code).toBe('not-allowed');
  });

  it('refuses an unspellable rel that is not text', () => {
    expect(refusal({ kind: 'link', rel: ['stylesheet'], href: '/a' }).code).toBe('not-allowed');
    expect(refusal({ kind: 'link', href: '/a' }).code).toBe('not-allowed');
  });

  it('needs exactly one of a language or a feed type on an alternate', () => {
    expect(ok(link('alternate', '/de', { hreflang: 'de' }))).toMatchObject({ hreflang: 'de' });
    expect(ok(link('alternate', '/x', { hreflang: 'x-default' }))).toMatchObject({ hreflang: 'x-default' });
    expect(ok(link('alternate', '/en', { hreflang: 'en-GB' }))).toMatchObject({ hreflang: 'en-GB' });
    for (const type of FEED_TYPES) expect(ok(link('alternate', '/feed', { type }))).toMatchObject({ type });
    expect(refusal(link('alternate')).code).toBe('shape');
    expect(refusal(link('alternate', '/x', { hreflang: 'de', type: FEED_TYPES[0] })).code).toBe('shape');
    expect(refusal(link('alternate', '/x', { type: 'text/css' })).code).toBe('value');
    expect(refusal(link('alternate', '/x', { hreflang: 'not a tag' })).code).toBe('value');
    expect(refusal(link('alternate', '/x', { hreflang: 5 })).code).toBe('value');
  });

  it('gives a rel other than alternate no language or type', () => {
    expect(refusal(link('me', '/a', { hreflang: 'de' })).code).toBe('shape');
    expect(refusal(link('author', '/a', { type: FEED_TYPES[0] })).code).toBe('shape');
  });

  it('keeps a plain-text title and refuses an empty or long one', () => {
    expect(ok(link('me', '/a', { title: '<b>x</b>' }))).toMatchObject({ title: '<b>x</b>' });
    expect(refusal(link('me', '/a', { title: '' })).code).toBe('value');
    expect(refusal(link('me', '/a', { title: 'x'.repeat(HEAD_LIMITS.content + 1) })).code).toBe('value');
  });

  it('refuses any other attribute (as, crossorigin, media, sizes, integrity)', () => {
    for (const key of ['as', 'crossorigin', 'media', 'sizes', 'integrity', 'onload', 'imagesrcset']) {
      expect(refusal(link('me', '/a', { [key]: 'x' })).code).toBe('shape');
    }
  });
});

describe('isHeadHref', () => {
  it.each(['https://example.com', 'https://example.com/a?b=1#c', '/', '/a/b', '/a?x=1', 'https://sub.example.com:8443/x'])('accepts %s', (v) => {
    expect(isHeadHref(v)).toBe(true);
  });

  it.each([
    'http://example.com',
    'mailto:a@b.test',
    'tel:+4912345',
    'sms:+4912345',
    'data:text/html,hi',
    'javascript:alert(1)',
    '//evil.test/x',
    '/\\evil.test',
    '/\t/evil.test',
    '/\n/evil.test',
    ' /a',
    '/a ',
    'a/b',
    '',
    'https://',
    'https://user:pw@example.com/',
    'https://exa mple.com',
    'https:\\\\evil.test',
    'ftp://example.com',
    'https:example.com',
    'https:/example.com',
    'https:///example.com',
    'https://ex\u200bample.com',
    'https://exämple.com',
  ])('refuses %j', (v) => {
    expect(isHeadHref(v)).toBe(false);
  });

  it('refuses a non-string and an over-long address', () => {
    expect(isHeadHref(undefined)).toBe(false);
    expect(isHeadHref(5)).toBe(false);
    expect(isHeadHref(`/${'a'.repeat(HEAD_LIMITS.href)}`)).toBe(false);
    expect(isHeadHref(`/${'a'.repeat(HEAD_LIMITS.href - 1)}`)).toBe(true);
  });
});

describe('JSON-LD', () => {
  it('passes an object with a schema.org context and a type, and an @graph', () => {
    expect(ok(ld()).kind).toBe('jsonld');
    expect(ok({ kind: 'jsonld', data: { '@context': 'https://schema.org/', '@graph': [{ '@type': 'Thing' }] } }).kind).toBe('jsonld');
    expect(ok({ kind: 'jsonld', data: { '@context': 'http://schema.org', '@type': ['A', 'B'] } }).kind).toBe('jsonld');
  });

  it('refuses a missing or foreign context, no type, a non-object and non-JSON values', () => {
    expect(refusal({ kind: 'jsonld', data: { '@type': 'X' } }).code).toBe('jsonld');
    expect(refusal({ kind: 'jsonld', data: { '@context': 'https://evil.test', '@type': 'X' } }).code).toBe('jsonld');
    expect(refusal({ kind: 'jsonld', data: { '@context': { '@vocab': 'x' }, '@type': 'X' } }).code).toBe('jsonld');
    expect(refusal({ kind: 'jsonld', data: { '@context': 'https://schema.org' } }).code).toBe('jsonld');
    expect(refusal({ kind: 'jsonld', data: { '@context': 'https://schema.org', '@graph': [] } }).code).toBe('jsonld');
    expect(refusal({ kind: 'jsonld', data: 'text' }).code).toBe('jsonld');
    expect(refusal({ kind: 'jsonld', data: [] }).code).toBe('jsonld');
    expect(refusal({ kind: 'jsonld' }).code).toBe('jsonld');
    expect(refusal(ld({ n: Number.NaN })).code).toBe('jsonld');
    expect(refusal(ld({ n: Number.POSITIVE_INFINITY })).code).toBe('jsonld');
    expect(refusal(ld({ f: () => 1 })).code).toBe('jsonld');
    expect(refusal(ld({ u: undefined })).code).toBe('jsonld');
    expect(refusal(ld({ d: new Date() })).code).toBe('jsonld');
  });

  it('refuses a cycle and anything deeper than 12 levels, before serialising', () => {
    const cyclic: Record<string, unknown> = { '@context': 'https://schema.org', '@type': 'X' };
    cyclic.self = cyclic;
    expect(refusal({ kind: 'jsonld', data: cyclic }).code).toBe('jsonld');
    let deep: unknown = 'leaf';
    for (let i = 0; i < 40; i += 1) deep = { a: deep };
    expect(refusal(ld({ deep })).code).toBe('jsonld');
    let edge: unknown = 'leaf';
    for (let i = 0; i < HEAD_LIMITS.jsonLdDepth - 2; i += 1) edge = { a: edge };
    expect(ok(ld({ edge })).kind).toBe('jsonld');
  });

  it('refuses a very wide object and one over 16 kilobytes', () => {
    const wide = Object.fromEntries(Array.from({ length: HEAD_LIMITS.jsonLdNodes + 10 }, (_, i) => [`k${i}`, 1]));
    expect(refusal(ld({ wide })).code).toBe('jsonld');
    expect(refusal(ld({ big: 'x'.repeat(HEAD_LIMITS.jsonLdBytes) })).code).toBe('jsonld');
    expect(ok(ld({ big: 'x'.repeat(HEAD_LIMITS.jsonLdBytes - 200) })).kind).toBe('jsonld');
  });

  it('counts the cap in bytes, not characters', () => {
    expect(refusal(ld({ big: 'ä'.repeat(HEAD_LIMITS.jsonLdBytes / 2) })).code).toBe('jsonld');
  });

  it('keeps hostile text as data: nothing is written into an element here', () => {
    const item = ok(ld({ name: '</script><script>alert(1)</script>' }));
    expect(item).toMatchObject({ kind: 'jsonld' });
  });

  it('splits a top-level array into items and refuses one bad element by position', () => {
    const good = { '@context': 'https://schema.org', '@type': 'Thing' };
    const r = parseJsonLdInput(JSON.stringify([good, good]));
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.items).toHaveLength(2);
    const bad = parseJsonLdInput(JSON.stringify([good, { '@type': 'Thing' }]));
    expect(bad).toMatchObject({ ok: false });
    expect(!bad.ok && bad.message).toContain('Item 2');
  });

  it('shows a parse error for typed text and refuses an empty list', () => {
    const r = parseJsonLdInput('{ "@context": ');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/Not valid JSON/);
    expect(parseJsonLdInput('[]').ok).toBe(false);
    expect(parseJsonLdInput('"text"').ok).toBe(false);
  });

  it('reads parseJsonLdData as the same rule the item uses', () => {
    expect(parseJsonLdData({ '@context': 'https://schema.org', '@type': 'X' }).ok).toBe(true);
    expect(parseJsonLdData(null).ok).toBe(false);
  });
});

describe('parseHeadItem', () => {
  it('refuses what is not a plain object, and an unknown kind, without throwing', () => {
    for (const raw of [null, undefined, 5, 'meta', [], [meta('author')], () => 1, new Map()]) expect(refusal(raw).code).toBe('shape');
    expect(refusal({ kind: 'script', src: '/x.js' }).code).toBe('kind');
    expect(refusal({ kind: 'style', content: 'a{}' }).code).toBe('kind');
    expect(refusal({ kind: 'base', href: '/' }).code).toBe('kind');
    expect(refusal({ kind: 5 }).code).toBe('kind');
    expect(refusal({}).code).toBe('kind');
  });

  it('refuses an object with a forged prototype, and never reads the prototype chain', () => {
    const proto = Object.create({ kind: 'meta', name: 'author', content: 'x' });
    expect(refusal(proto).code).toBe('shape');
    const inherited = Object.create(null);
    inherited.kind = 'meta';
    inherited.name = 'author';
    inherited.content = 'x';
    expect(ok(inherited)).toEqual({ kind: 'meta', name: 'author', content: 'x' });
  });

  it('returns a fresh item, not the stored object', () => {
    const stored = meta('author', 'Marlin');
    const parsed = ok(stored);
    expect(parsed).not.toBe(stored);
    expect(parsed).toEqual(stored);
  });

  it('refuses an item carrying an own __proto__ key and renders nothing of it', () => {
    expect(refusal(forged).code).toBe('shape');
    expect(refusal(forged).message).toContain('__proto__');
  });
});

describe('the safe copy', () => {
  it('keeps a stored __proto__ key as a plain own property and forges no prototype, at every depth', () => {
    const nested = JSON.parse(
      '{"kind":"jsonld","data":{"@context":"https://schema.org","@type":"X","__proto__":{"polluted":true},"a":{"__proto__":{"polluted":true},"b":[{"__proto__":{"polluted":true}}]}}}',
    );
    const copy = copyStoredItem(nested) as unknown as { data: Record<string, unknown> };
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(copy.data)).toBe(Object.prototype);
    expect(Object.hasOwn(copy.data, '__proto__')).toBe(true);
    const a = copy.data.a as Record<string, unknown>;
    expect(Object.getPrototypeOf(a)).toBe(Object.prototype);
    expect(Object.getPrototypeOf((a.b as unknown[])[0])).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(copy.data.polluted).toBeUndefined();
  });

  it('the parsed JSON-LD copy forges no prototype either', () => {
    const data = JSON.parse('{"@context":"https://schema.org","@type":"X","__proto__":{"polluted":true},"a":{"__proto__":{"polluted":true}}}');
    const parsed = parseJsonLdData(data);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.getPrototypeOf(parsed.data)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(parsed.data.a)).toBe(Object.prototype);
    expect(parsed.data.polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('runs a forged item through every H1 path and no copy gets a forged prototype', () => {
    const written = storeHeadItems([forged, link('me', '/b')], 10);
    const copies = [
      copyStoredItem(forged),
      ...copyStoredItems([forged]),
      ...written.items,
      ...resolveHead([forged], [forged]).items,
      changeHeadKind(forged, 'meta'),
      changeHeadKind(forged, 'jsonld'),
      changeHeadKind(forged, 'link'),
      changeHeadKind(forged, 'property'),
    ];
    for (const copy of copies) {
      expect(copy).toBeTruthy();
      expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
      expect((copy as Record<string, unknown>).polluted).toBeUndefined();
    }
    expect(Object.hasOwn(copyStoredItem(forged)!, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('copies nothing that is not a plain object with a string kind, or not JSON', () => {
    expect(copyStoredItem(null)).toBeNull();
    expect(copyStoredItem({ kind: 5 })).toBeNull();
    expect(copyStoredItem([{ kind: 'meta' }])).toBeNull();
    expect(copyStoredItem({ kind: 'meta', f: () => 1 })).toBeNull();
    const cyclic: Record<string, unknown> = { kind: 'jsonld' };
    cyclic.self = cyclic;
    expect(copyStoredItem(cyclic)).toBeNull();
    expect(copyStoredItems('not a list')).toEqual([]);
  });

  it('keeps a refused item as stored, so the panel can show it as refused', () => {
    const copy = copyStoredItem({ kind: 'meta', name: 'viewport', content: 'x' });
    expect(copy).toEqual({ kind: 'meta', name: 'viewport', content: 'x' });
    expect(refusal(copy).code).toBe('not-allowed');
  });
});

describe('storing a list', () => {
  it('drops the later items over the cap and counts them', () => {
    const items = Array.from({ length: 25 }, (_, i) => meta('author', `a${i}`));
    const written = storeHeadItems(items, HEAD_LIMITS.siteItems);
    expect(written.items).toHaveLength(HEAD_LIMITS.siteItems);
    expect(written.items[0]).toMatchObject({ content: 'a0' });
    expect(written.overCap).toBe(5);
  });

  it('counts the unreadable ones and keeps the rest in order', () => {
    const written = storeHeadItems([meta('author', 'a'), 5, null, { kind: 'meta', name: 'rating', content: 'b' }], 10);
    expect(written.items.map((i) => i.content)).toEqual(['a', 'b']);
    expect(written.unreadable).toBe(2);
  });

  it('is empty for anything that is not a list', () => {
    expect(storeHeadItems(undefined, 5)).toEqual({ items: [], overCap: 0, unreadable: 0 });
    expect(storeHeadItems({ kind: 'meta' }, 5).items).toEqual([]);
  });
});

describe('changing a kind', () => {
  it('carries only the content between meta and property and drops every other field', () => {
    expect(changeHeadKind(meta('author', 'Marlin'), 'property')).toEqual({ kind: 'property', property: '', content: 'Marlin' });
    expect(changeHeadKind(prop('article:tag', 'news'), 'meta')).toEqual({ kind: 'meta', name: '', content: 'news' });
    expect(changeHeadKind(link('me', '/a', { title: 't' }), 'meta')).toEqual({ kind: 'meta', name: '', content: '' });
    expect(changeHeadKind(meta('author'), 'link')).toEqual({ kind: 'link', rel: 'alternate', href: '' });
    expect(changeHeadKind(meta('author'), 'jsonld')).toEqual({ kind: 'jsonld', data: {} });
    expect(changeHeadKind(null, 'meta')).toEqual({ kind: 'meta', name: '', content: '' });
  });

  it('leaves no field of the old kind behind', () => {
    const next = changeHeadKind(link('alternate', '/a', { hreflang: 'de', title: 't' }), 'property');
    expect(Object.keys(next).sort()).toEqual(['content', 'kind', 'property']);
  });
});

describe('the merge', () => {
  it('a page item replaces the site item with the same key', () => {
    const r = resolveHead([meta('author', 'site'), meta('rating', 'general')], [meta('author', 'page')]);
    expect(r.items).toEqual([
      { kind: 'meta', name: 'rating', content: 'general' },
      { kind: 'meta', name: 'author', content: 'page' },
    ]);
    expect(r.problems).toEqual([]);
  });

  it('falls back to the site item when the page item is removed', () => {
    const site = [meta('author', 'site')];
    expect(resolveHead(site, [meta('author', 'page')]).items).toEqual([{ kind: 'meta', name: 'author', content: 'page' }]);
    expect(resolveHead(site, []).items).toEqual([{ kind: 'meta', name: 'author', content: 'site' }]);
  });

  it('a refused page item does not displace a valid site item', () => {
    const r = resolveHead([meta('author', 'site')], [meta('author', '')]);
    expect(r.items).toEqual([{ kind: 'meta', name: 'author', content: 'site' }]);
    expect(r.problems).toMatchObject([{ home: 'page', index: 0, reason: 'refused' }]);
  });

  it('keys a link by rel, language and type, so two feeds with different types both stay', () => {
    const r = resolveHead(
      [],
      [link('alternate', '/rss', { type: 'application/rss+xml' }), link('alternate', '/atom', { type: 'application/atom+xml' }), link('alternate', '/de', { hreflang: 'de' })],
    );
    expect(r.items).toHaveLength(3);
    const same = resolveHead([], [link('alternate', '/a', { hreflang: 'de' }), link('alternate', '/b', { hreflang: 'de' })]);
    expect(same.items).toHaveLength(1);
    expect(same.problems).toMatchObject([{ index: 1, reason: 'duplicate' }]);
  });

  it('lets a repeatable key emit both and drops an exact duplicate', () => {
    const r = resolveHead([prop('article:tag', 'a')], [prop('article:tag', 'b'), prop('article:tag', 'b'), link('me', '/x'), link('me', '/y')]);
    expect(r.items.map((i) => (i.kind === 'property' ? i.content : i.kind === 'link' ? i.href : ''))).toEqual(['a', 'b', '/x', '/y']);
    expect(r.problems).toMatchObject([{ home: 'page', index: 1, reason: 'duplicate' }]);
  });

  it('drops a site copy of an exact duplicate the page also carries', () => {
    const r = resolveHead([prop('article:tag', 'a')], [prop('article:tag', 'a')]);
    expect(r.items).toHaveLength(1);
    expect(r.problems).toMatchObject([{ home: 'site', reason: 'duplicate' }]);
  });

  it('keeps the first of a repeated single key within one home', () => {
    const r = resolveHead([meta('author', 'first'), meta('author', 'second')], []);
    expect(r.items).toEqual([{ kind: 'meta', name: 'author', content: 'first' }]);
  });

  it('emits JSON-LD from both, with no key', () => {
    expect(headItemKey(ok(ld()))).toBeNull();
    expect(resolveHead([ld({ name: 'a' })], [ld({ name: 'b' })]).items).toHaveLength(2);
  });

  it('holds JSON-LD to three on a page, the page first', () => {
    const site = [ld({ name: 's1' }), ld({ name: 's2' })];
    const page = [ld({ name: 'p1' }), ld({ name: 'p2' })];
    const r = resolveHead(site, page);
    expect(r.items.map((i) => (i.kind === 'jsonld' ? i.data.name : ''))).toEqual(['s1', 'p1', 'p2']);
    expect(r.problems).toMatchObject([{ home: 'site', index: 1, reason: 'over-jsonld-cap' }]);
  });

  it('reports a refused item and keeps its neighbours', () => {
    const r = resolveHead([], [meta('author', 'a'), { kind: 'meta', name: 'viewport', content: 'x' }, meta('rating', 'general')]);
    expect(r.items).toHaveLength(2);
    expect(r.problems).toMatchObject([{ index: 1, reason: 'refused' }]);
  });

  it('caps a page at 30 and a site at 20 by stored position, and says so', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => link('me', `/m${i}`));
    const r = resolveHead(many(25), many(35));
    expect(r.problems.filter((p) => p.reason === 'over-cap')).toHaveLength(5 + 5);
    expect(r.items.filter((i) => i.kind === 'link')).toHaveLength(20 + 30 - 20);
  });

  it('is total: no input shape throws', () => {
    for (const bad of [null, undefined, 5, 'x', {}, [null, 5, 'x', [], {}]]) {
      expect(() => resolveHead(bad, bad)).not.toThrow();
    }
    expect(resolveHead(undefined, undefined)).toEqual({ items: [], problems: [] });
  });

  it('an old page with no head reads as empty', () => {
    expect(resolveHead([], undefined)).toEqual({ items: [], problems: [] });
  });
});

describe('ogType', () => {
  it('accepts the four types and reads anything else as website', () => {
    for (const t of ['website', 'article', 'book', 'profile']) expect(parseOgType(t)).toBe(t);
    for (const bad of ['product', 'music.song', 'ARTICLE', '', undefined, null, 5, {}, '__proto__', 'constructor']) {
      expect(parseOgType(bad)).toBe('website');
    }
  });
});
