// src/server/sites/__tests__/erase.test.ts
//
// The search-and-rewrite walker of src/server/sites/erase.ts, without a
// database: what is found, what is blocked and why, that a rewrite changes the
// chosen strings and nothing else, and that a stale preview yields other ids.
// The payloads of the review of pull request #283 are pinned here one by one.
// The repository's transaction around it is proven in erasePersonalData.itest.ts.

import { describe, expect, it } from 'vitest';
import {
  assertShapeKept,
  eraseMatcher,
  EraseQueryError,
  EraseShapeError,
  ERASE_LIMITS,
  findMatches,
  matchesToken,
  normalizeEraseValue,
  redactedId,
  redactedPath,
  redactionMatcher,
  REDACTED_SEGMENT,
  replacementProblem,
  rewriteDocument,
  type EraseLocation,
  type EraseQuery,
} from '../erase';
import { REVISION_SCHEMA_VERSION } from '../revision';
import { ID_REFERENCE_NAMES } from '@/lib/renderer/idRefs';

const REV: EraseLocation = { kind: 'revision', number: 3 };

function node(id: string, props: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { id, type: 'p', componentType: 'host', props, children: [], ...extra };
}

/** A revision document holding the value in many kinds of places. */
function documentWith(value: string) {
  return {
    schemaVersion: REVISION_SCHEMA_VERSION,
    name: 'Bakery',
    analyticsProjectId: null,
    ingestionEndpoint: null,
    apiKeyRef: null,
    lumitraEnabled: false,
    redirects: [{ from: '/team/old', pageId: 'p-team', createdAt: '2026-01-01T00:00:00.000Z' }],
    siteSettings: {
      siteName: 'Bakery',
      business: { legalName: 'Bakery GmbH', managingDirectors: [value, 'Erika Muster'], email: 'info@bakery.example' },
      theme: { tokens: [], document: {} },
      head: [{ kind: 'meta', name: 'author', content: value }],
    },
    pages: [
      {
        pageId: 'p-home',
        slug: '',
        snapshot: {
          id: 'p-home',
          slug: '',
          metadata: { title: 'Home', description: `Run by ${value}` },
          appComponentTree: {
            id: 'root',
            type: 'div',
            componentType: 'host',
            props: { className: 'hero' },
            bindings: { children: { mode: 'read', expression: `Hello from ${value}` } },
            children: [
              node('t1', { children: `Contact ${value} today` }),
              node('a1', { href: `mailto:${value}@bakery.example`, title: value, children: 'Write' }),
              node('f1', { name: 'fullName', placeholder: value, defaultValue: value, 'data-form-kind': 'field' }),
            ],
          },
          canvasNodes: {},
        },
      },
    ],
    components: {},
  };
}

const match = (value: string, over: Partial<EraseQuery> = {}) => eraseMatcher({ value, caseSensitive: false, ...over });

/** The ids of every erasable match: what an owner ticking everything shown would send. */
function ticked(document: unknown, value: string, over: Partial<EraseQuery> = {}): Set<string> {
  return new Set(findMatches(document, REV, match(value, over)).filter((m) => m.blocked === null).map((m) => m.id));
}

function blockedOf(document: unknown, value: string, over: Partial<EraseQuery> = {}) {
  return findMatches(document, REV, match(value, over)).map((m) => [m.path, m.blocked]);
}

describe('normalizeEraseValue', () => {
  it('trims, folds spaces and soft hyphens, and enforces the bounds', () => {
    expect(normalizeEraseValue('  Max   Muster­mann  ')).toBe('Max Mustermann');
    expect(() => normalizeEraseValue('ab')).toThrow(EraseQueryError);
    expect(() => normalizeEraseValue('   ')).toThrow(EraseQueryError);
    expect(() => normalizeEraseValue('x'.repeat(ERASE_LIMITS.maxChars + 1))).toThrow(EraseQueryError);
    // Counted in characters, not UTF-16 units.
    expect(normalizeEraseValue('😀😀😀')).toBe('😀😀😀');
  });
});

describe('findMatches', () => {
  it('finds the value everywhere a document holds it, and only there', () => {
    const matches = findMatches(documentWith('Max Mustermann'), REV, match('Max Mustermann'));
    expect(matches.map((m) => [m.area, m.path, m.blocked])).toEqual([
      ['settings', '/siteSettings/business/managingDirectors/0', null],
      ['head', '/siteSettings/head/0/content', null],
      ['page-metadata', '/pages/0/snapshot/metadata/description', null],
      ['binding', '/pages/0/snapshot/appComponentTree/bindings/children/expression', null],
      ['text', '/pages/0/snapshot/appComponentTree/children/0/props/children', null],
      ['attribute', '/pages/0/snapshot/appComponentTree/children/1/props/href', null],
      ['attribute', '/pages/0/snapshot/appComponentTree/children/1/props/title', null],
      ['attribute', '/pages/0/snapshot/appComponentTree/children/2/props/placeholder', null],
      ['attribute', '/pages/0/snapshot/appComponentTree/children/2/props/defaultValue', null],
    ]);
    expect(matches[2]).toMatchObject({ pageId: 'p-home', pageSlug: '' });
    expect(matches[0]).toMatchObject({ pageId: null, pageSlug: null });
  });

  it('is case-insensitive unless asked, and matches both Unicode forms of an umlaut', () => {
    const doc = { name: 'JÜRGEN müller', description: 'Jürgen Müller' };
    expect(findMatches(doc, REV, match('jürgen müller'))).toHaveLength(2);
    expect(findMatches(doc, REV, match('jürgen müller', { caseSensitive: true }))).toHaveLength(0);
    expect(findMatches(doc, REV, match('Jürgen Müller', { caseSensitive: true }))).toHaveLength(1);
  });

  it('gives an excerpt with context, never split inside an emoji, and ids that change with the string', () => {
    const doc = { description: `${'😀'.repeat(60)} Max Mustermann ${'b'.repeat(60)}` };
    const [m] = findMatches(doc, REV, match('Max Mustermann'));
    expect(m.excerpt.startsWith('...')).toBe(true);
    expect(m.excerpt.endsWith('...')).toBe(true);
    expect(m.excerpt).toContain('Max Mustermann');
    expect(m.excerpt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    const [same] = findMatches({ ...doc }, REV, match('Max Mustermann'));
    expect(same.id).toBe(m.id);
    const [changed] = findMatches({ description: `${doc.description}!` }, REV, match('Max Mustermann'));
    expect(changed.id).not.toBe(m.id);
    const [elsewhere] = findMatches(doc, { kind: 'working' }, match('Max Mustermann'));
    expect(elsewhere.id).not.toBe(m.id);
  });
});

describe('matching: whole words by default (review finding 4)', () => {
  it.each([
    ['Lena', 'Magdalena und Helena'],
    ['Rose', 'Rosemary Sans'],
    ['Anna', 'Annahme'],
    ['Kurt', 'Kurtaxe'],
    ['Bert', 'Albert und Robert'],
  ])('%s is not found inside %s', (value, text) => {
    expect(findMatches({ text }, REV, match(value))).toHaveLength(0);
    expect(findMatches({ text }, REV, match(value, { insideWords: true })).length).toBeGreaterThan(0);
  });

  it.each([
    ['Beck', 'Lu\u0308beck', 'a decomposed umlaut before it'],
    ['Anna', 'Anna\u0308', 'a decomposed umlaut after it'],
    ['Esse', 'Messe Essen', 'a longer word on either side'],
    ['234', '1234567', 'digits around it'],
  ])('%s is not found in %s (%s): a combining mark belongs to its letter', (value, text) => {
    expect(findMatches({ text }, REV, match(value))).toHaveLength(0);
  });

  it('still finds a whole decomposed word', () => {
    expect(findMatches({ text: 'in Lu\u0308beck' }, REV, match('Lübeck'))).toHaveLength(1);
    expect(findMatches({ text: 'Mu\u0308ller.' }, REV, match('Müller'))).toHaveLength(1);
  });

  it('still finds the word next to punctuation, digits aside', () => {
    expect(findMatches({ text: '(Lena), Lena. "Lena"' }, REV, match('Lena'))).toHaveLength(3);
    expect(findMatches({ text: 'Lena2' }, REV, match('Lena'))).toHaveLength(0);
  });
});

describe('matching: the same text stored differently (review finding 5)', () => {
  it.each([
    ['a non-breaking space', 'Max Mustermann'],
    ['a narrow non-breaking space', 'Max Mustermann'],
    ['two spaces', 'Max  Mustermann'],
    ['a line break', 'Max\nMustermann'],
    ['a soft hyphen', 'Max Muster­mann'],
    ['an nbsp entity', 'Max&nbsp;Mustermann'],
    ['a shy entity', 'Max Muster&shy;mann'],
    ['upper case', 'MAX MUSTERMANN'],
  ])('finds the value written with %s', (_label, text) => {
    expect(findMatches({ text }, REV, match('Max Mustermann'))).toHaveLength(1);
  });

  it.each([
    ['M&uuml;ller', 'Müller'],
    ['M&#252;ller', 'Müller'],
    ['M&#xFC;ller', 'Müller'],
    ['M&Uuml;LLER', 'Müller'],
    ['Müller', 'Müller'],
    ['STRASSE', 'Straße'],
    ['Straße', 'Strasse'],
    ['STRAẞE', 'straße'],
    ['Stra&szlig;e', 'Strasse'],
    ['Smith &amp; Sons', 'Smith & Sons'],
  ])('finds %s for %s', (text, value) => {
    expect(findMatches({ text }, REV, match(value))).toHaveLength(1);
  });

  it('keeps ß and ss apart when case must be exact, and states its limit on markup', () => {
    expect(findMatches({ text: 'Strasse' }, REV, match('Straße', { caseSensitive: true }))).toHaveLength(0);
    // A documented limit: a name split by markup is not found.
    expect(findMatches({ text: '<strong>Max</strong> Mustermann' }, REV, match('Max Mustermann'))).toHaveLength(0);
  });
});

describe('protected: ids and what points at them (review finding 1)', () => {
  it('blocks every reference to an id, with the id', () => {
    const doc = {
      pages: [{
        pageId: 'p', slug: 'home', snapshot: { appComponentTree: node('n', {
          id: 'max-mustermann-bio',
          href: '#max-mustermann-bio',
          anchor: '#max-mustermann-bio',
          usemap: '#max-mustermann-bio',
          popovertarget: 'max-mustermann-bio',
          popoverTarget: 'max-mustermann-bio',
          commandfor: 'max-mustermann-bio',
          commandFor: 'max-mustermann-bio',
          'aria-labelledby': 'intro max-mustermann-bio',
        }) },
      }],
    };
    const found = findMatches(doc, REV, match('max-mustermann'));
    expect(found.length).toBe(9);
    expect(found.every((m) => m.blocked === 'structural')).toBe(true);
    expect(rewriteDocument(doc, REV, match('max-mustermann'), '', new Set(found.map((m) => m.id))).erased).toEqual([]);
  });

  it.each([...ID_REFERENCE_NAMES])('blocks the id reference attribute %s', (name) => {
    const doc = { pages: [{ pageId: 'p', slug: 'home', snapshot: { props: { [name]: 'max-mustermann-panel' } } }] };
    expect(blockedOf(doc, 'max-mustermann')).toEqual([[`/pages/0/snapshot/props/${name}`, 'structural']]);
  });

  it.each(['set', 'step', 'toggle', 'effect', 'filter', 'focus', 'media', 'rove', 'scroll', 'setProp', 'op', 'move', 'axis', 'wrap', 'role', 'prop', 'block', 'state', 'get', 'attr'])(
    'blocks the behaviour reference or enumeration field %s',
    (field) => {
      const doc = { behaviour: { [field]: 'max-mustermann-open' } };
      expect(blockedOf(doc, 'max-mustermann')).toEqual([[`/behaviour/${field}`, 'structural']]);
    },
  );

  it('blocks the structural vocabulary, keys, form keys and binding references', () => {
    const doc = {
      redirects: [{ from: '/team/max-power', pageId: 'p' }],
      pages: [{
        pageId: 'p-max-power',
        slug: 'max-power',
        snapshot: {
          id: 'n-max-power',
          props: { className: 'max-power-card', name: 'max-power', 'data-owner': 'max-power', 'aria-controls': 'max-power-panel' },
          bindings: { children: { mode: 'read', expression: 'Hi {{row.max-power}} and max-power' } },
          canvasNodes: { 'max-power-node': { id: 'x' } },
        },
      }],
    };
    expect(blockedOf(doc, 'max-power')).toEqual([
      ['/redirects/0/from', 'address'],
      ['/pages/0/pageId', 'structural'],
      ['/pages/0/slug', 'address'],
      ['/pages/0/snapshot/id', 'structural'],
      ['/pages/0/snapshot/props/className', 'structural'],
      ['/pages/0/snapshot/props/name', 'structural'],
      ['/pages/0/snapshot/props/data-owner', 'structural'],
      ['/pages/0/snapshot/props/aria-controls', 'structural'],
      ['/pages/0/snapshot/bindings/children/expression', 'binding-reference'],
      ['/pages/0/snapshot/bindings/children/expression', null],
      ['/pages/0/snapshot/canvasNodes/max-power-node', 'key'],
    ]);
  });

  it('never offers the structural vocabulary for erasing', () => {
    const found = findMatches(documentWith('host'), REV, match('host'));
    const vocabulary = found.filter((m) => m.path.endsWith('/componentType'));
    expect(vocabulary.length).toBeGreaterThan(0);
    expect(vocabulary.every((m) => m.blocked === 'structural')).toBe(true);
  });
});

describe('protected: addresses, links into them, image and file addresses (review finding 2)', () => {
  const doc = {
    pages: [
      {
        pageId: 'team',
        slug: 'max-mustermann',
        snapshot: {
          appComponentTree: node('root', { children: 'Max Mustermann, baker' }, {
            children: [
              node('l1', { href: '/max-mustermann', children: 'About Max Mustermann' }),
              node('l2', { href: 'https://example.com/max-mustermann', children: 'Elsewhere' }),
              node('i1', { src: '/uploads/max-mustermann.jpg', srcset: 'max-mustermann-2x.jpg 2x', alt: 'Max Mustermann' }),
              node('v1', { poster: 'https://cdn.example/max-mustermann.png' }),
              node('s1', { style: { backgroundImage: 'url(/img/max-mustermann.jpg)', fontFamily: 'Max Mustermann Sans' } }),
              node('b1', { behaviour: { on: [{ do: [{ navigate: '/max-mustermann' }] }] } }),
            ],
          }),
        },
      },
    ],
  };

  it('reports them, never cuts them, and keeps the visible text erasable', () => {
    const found = findMatches(doc, REV, match('max mustermann'));
    const byPath = Object.fromEntries(findMatches(doc, REV, match('max-mustermann')).map((m) => [m.path, m.blocked]));
    expect(byPath).toMatchObject({
      '/pages/0/slug': 'address',
      '/pages/0/snapshot/appComponentTree/children/0/props/href': 'address',
      '/pages/0/snapshot/appComponentTree/children/1/props/href': 'url',
      '/pages/0/snapshot/appComponentTree/children/2/props/src': 'url',
      '/pages/0/snapshot/appComponentTree/children/2/props/srcset': 'url',
      '/pages/0/snapshot/appComponentTree/children/3/props/poster': 'url',
      '/pages/0/snapshot/appComponentTree/children/4/props/style/backgroundImage': 'url',
      '/pages/0/snapshot/appComponentTree/children/5/props/behaviour/on/0/do/0/navigate': 'address',
    });
    // The words a visitor reads stay erasable: the text, the link text, the alt text, a font label.
    expect(found.filter((m) => m.blocked === null).map((m) => m.path)).toEqual([
      '/pages/0/snapshot/appComponentTree/props/children',
      '/pages/0/snapshot/appComponentTree/children/0/props/children',
      '/pages/0/snapshot/appComponentTree/children/2/props/alt',
      '/pages/0/snapshot/appComponentTree/children/4/props/style/fontFamily',
    ]);
  });

  it.each([
    ['href', 'max-mustermann'],
    ['href', './max-mustermann'],
    ['href', '../team/max-mustermann'],
    ['href', 'team/max-mustermann?tab=bio#top'],
    ['navigate', 'max-mustermann'],
    ['navigate', './max-mustermann'],
  ])('protects a relative %s %s as an address (recheck finding 3)', (key, value) => {
    const doc = { behaviour: { on: [{ do: [{ [key]: value }] }] }, props: { [key]: value } };
    const found = findMatches(doc, REV, match('max-mustermann'));
    expect(found.length).toBe(2);
    expect(found.every((m) => m.blocked === 'address')).toBe(true);
  });

  it('a mail or phone link is the personal data itself, so it stays erasable', () => {
    const mail = { props: { href: 'mailto:max@bakery.example', title: 'tel:+4930123' } };
    expect(blockedOf(mail, 'max@bakery.example')).toEqual([['/props/href', null]]);
  });
});

describe('the audit path (review finding 3, recheck finding 2)', () => {
  const holds = (value: string, over: Partial<EraseQuery> = {}) => redactionMatcher({ value, caseSensitive: false, ...over });

  it('replaces a key holding the value with a marker', () => {
    const h = holds('Max Mustermann');
    expect(redactedPath('/siteSettings/people/Max Mustermann/label', h)).toBe(`/siteSettings/people/${REDACTED_SEGMENT}/label`);
    expect(redactedPath('/siteSettings/people/max~1mustermann~0x/label', holds('max/mustermann'))).toBe(
      `/siteSettings/people/${REDACTED_SEGMENT}/label`,
    );
    expect(redactedPath('/pages/0/snapshot/props/children', h)).toBe('/pages/0/snapshot/props/children');
    expect(redactedId('page-max-mustermann', holds('max-mustermann'))).toBe(REDACTED_SEGMENT);
    expect(redactedId('home', h)).toBe('home');
    expect(redactedId(null, h)).toBeNull();
  });

  it.each([
    ['Max Mustermanns Team', 'a genitive, inside a word'],
    ['max-mustermann', 'hyphens for spaces'],
    ['max_mustermann', 'underscores for spaces'],
    ['max.mustermann', 'dots for spaces'],
    ['Max-Mustermann-Team', 'separators all along'],
  ])('masks %s (%s), wider than a whole-word search', (segment) => {
    const h = holds('Max Mustermann');
    expect(redactedPath(`/siteSettings/people/${segment}/label`, h)).toBe(`/siteSettings/people/${REDACTED_SEGMENT}/label`);
  });

  it('masks a segment for a value typed with separators too', () => {
    expect(redactedPath('/people/Max Mustermann/label', holds('max-mustermann'))).toBe(`/people/${REDACTED_SEGMENT}/label`);
  });
});

describe('rewriteDocument', () => {
  it('replaces exactly the ticked matches and leaves everything else the same value', () => {
    const before = documentWith('Max Mustermann');
    const frozen = JSON.stringify(before);
    const { document, erased } = rewriteDocument(before, REV, match('Max Mustermann'), '[entfernt]', ticked(before, 'Max Mustermann'));
    expect(JSON.stringify(before)).toBe(frozen); // the input is untouched
    expect(erased).toHaveLength(9);
    expect(findMatches(document, REV, match('Max Mustermann'))).toHaveLength(0);
    expect(JSON.stringify(document)).toBe(frozen.replaceAll('Max Mustermann', '[entfernt]'));

    const after = document as ReturnType<typeof documentWith>;
    expect(after.redirects).toBe(before.redirects);
    expect(after.siteSettings.theme).toBe(before.siteSettings.theme);
    expect(after.components).toBe(before.components);
    expect(after.pages[0].snapshot.appComponentTree.props).toBe(before.pages[0].snapshot.appComponentTree.props);
    assertShapeKept(before, document, { revision: true });
  });

  it('rewrites nothing that was not ticked', () => {
    const before = { description: 'Max Mustermann and Max Mustermann' };
    const all = findMatches(before, REV, match('max mustermann'));
    const nothing = rewriteDocument(before, REV, match('max mustermann'), '[entfernt]', new Set());
    expect(nothing.document).toBe(before);
    const one = rewriteDocument(before, REV, match('max mustermann'), '[entfernt]', new Set([all[0].id]));
    expect(one.erased.map((m) => m.id)).toEqual([all[0].id]);
    expect((one.document as typeof before).description).toBe('[entfernt] and Max Mustermann');
  });

  it.each([
    ['Geschäftsführer: Max Mustermann, Erika Musterfrau', 'Geschäftsführer: Erika Musterfrau'],
    ['Erika Musterfrau, Max Mustermann', 'Erika Musterfrau'],
    ['Erika Musterfrau, Max Mustermann.', 'Erika Musterfrau.'],
    ['Run by Max Mustermann today', 'Run by today'],
    ['Max Mustermann runs it', 'runs it'],
    ['Max Mustermann', ''],
  ])('tidies the punctuation an empty replacement leaves: %s', (text, expected) => {
    const doc = { text };
    const { document } = rewriteDocument(doc, REV, match('Max Mustermann'), '', ticked(doc, 'Max Mustermann'));
    expect((document as typeof doc).text).toBe(expected);
  });

  it('keeps a key named __proto__ as an own key (review finding 8)', () => {
    const before = JSON.parse('{"a":"Max Mustermann","__proto__":{"x":1}}') as Record<string, unknown>;
    const { document } = rewriteDocument(before, REV, match('Max Mustermann'), '', ticked(before, 'Max Mustermann'));
    const after = document as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(after, '__proto__')).toBe(true);
    expect(JSON.stringify(after)).toBe('{"a":"","__proto__":{"x":1}}');
    expect(Object.getPrototypeOf(after)).toBe(Object.prototype);
  });
});

describe('matchesToken', () => {
  it('does not depend on the order, and changes with any match', () => {
    const a = findMatches(documentWith('Max Mustermann'), REV, match('Max Mustermann'));
    expect(matchesToken([...a].reverse())).toBe(matchesToken(a));
    expect(matchesToken(a.slice(1))).not.toBe(matchesToken(a));
  });
});

describe('replacementProblem', () => {
  const q = { value: 'Max Mustermann', caseSensitive: false };
  it('accepts an empty replacement or a placeholder', () => {
    expect(replacementProblem('', q)).toBeNull();
    expect(replacementProblem('[entfernt]', q)).toBeNull();
  });
  it('refuses one the search would find again, also inside a word', () => {
    expect(replacementProblem('MAX MUSTERMANN (former)', q)?.code).toBe('replacement_contains_value');
    expect(replacementProblem('exMax Mustermanns', q)?.code).toBe('replacement_contains_value');
  });
  it('refuses a binding template, which would become live data in text', () => {
    expect(replacementProblem('{{row.name}}', q)?.code).toBe('replacement_has_binding');
    expect(replacementProblem('end }}', q)?.code).toBe('replacement_has_binding');
  });
});

describe('assertShapeKept', () => {
  it('refuses a revision that no longer parses or changed its pages', () => {
    const before = documentWith('Max Mustermann');
    expect(() => assertShapeKept(before, { ...before, schemaVersion: 99 }, { revision: true })).toThrow(EraseShapeError);
    expect(() => assertShapeKept(before, { ...before, schemaVersion: 99 }, { revision: false })).not.toThrow();
    expect(() => assertShapeKept(before, { ...before, pages: [] }, { revision: false })).toThrow(EraseShapeError);
    expect(() =>
      assertShapeKept(before, { ...before, pages: [{ ...before.pages[0], slug: 'other' }] }, { revision: false }),
    ).toThrow(EraseShapeError);
  });

  it('refuses behaviour that ran before and would not after', () => {
    const tree = (toggle: string) => ({
      id: 'item', type: 'div',
      props: { behaviour: { state: [{ id: 's1', name: 'open', type: 'boolean', initial: false }] } },
      children: [{ id: 'btn', type: 'button', props: { children: 'Open', behaviour: { on: [{ id: 't1', on: 'click', do: [{ toggle }] }] } } }],
    });
    const doc = (toggle: string) => ({ pages: [{ pageId: 'p', slug: '', snapshot: { appComponentTree: tree(toggle) } }] });
    expect(() => assertShapeKept(doc('s1'), doc('s1'), { revision: false })).not.toThrow();
    expect(() => assertShapeKept(doc('s1'), doc('gone'), { revision: false })).toThrow(/behaviour on page 0/);
  });
});
