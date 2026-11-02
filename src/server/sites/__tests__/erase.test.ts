// src/server/sites/__tests__/erase.test.ts
//
// The search-and-rewrite walker of src/server/sites/erase.ts, without a
// database: what is found, what is blocked and why, that a rewrite changes the
// chosen strings and nothing else, and that a stale preview yields other ids.
// The repository's transaction around it is proven in erasePersonalData.itest.ts.

import { describe, expect, it } from 'vitest';
import {
  assertRevisionShapeKept,
  eraseMatcher,
  EraseQueryError,
  EraseShapeError,
  ERASE_LIMITS,
  findMatches,
  matchesToken,
  normalizeEraseValue,
  replacementContainsValue,
  rewriteDocument,
  type EraseLocation,
} from '../erase';
import { REVISION_SCHEMA_VERSION } from '../revision';

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

const match = (value: string, caseSensitive = false) => eraseMatcher({ value, caseSensitive });

describe('normalizeEraseValue', () => {
  it('trims and enforces the bounds', () => {
    expect(normalizeEraseValue('  Max  ')).toBe('Max');
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
    const areas = matches.map((m) => [m.area, m.path, m.blocked]);
    expect(areas).toEqual([
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
    expect(matches.every((m) => m.location === REV)).toBe(true);
    expect(matches[2]).toMatchObject({ pageId: 'p-home', pageSlug: '' });
    expect(matches[0]).toMatchObject({ pageId: null, pageSlug: null });
  });

  it('is case-insensitive unless asked, and matches both Unicode forms of an umlaut', () => {
    const doc = { name: 'JÜRGEN müller', description: 'Jürgen Müller' };
    expect(findMatches(doc, REV, match('jürgen müller'))).toHaveLength(2);
    expect(findMatches(doc, REV, match('jürgen müller', true))).toHaveLength(0);
    expect(findMatches(doc, REV, match('Jürgen Müller', true))).toHaveLength(1);
  });

  it('reports structural places as blocked, with the reason', () => {
    const doc = {
      redirects: [{ from: '/team/max-power', pageId: 'p' }],
      pages: [
        {
          pageId: 'p-max-power',
          slug: 'max-power',
          snapshot: {
            id: 'n-max-power',
            props: { className: 'max-power-card', name: 'max-power', 'data-owner': 'max-power', 'aria-controls': 'max-power-panel' },
            bindings: { children: { mode: 'read', expression: 'Hi {{row.max-power}} and max-power' } },
            canvasNodes: { 'max-power-node': { id: 'x' } },
          },
        },
      ],
    };
    const found = findMatches(doc, REV, match('max-power')).map((m) => [m.path, m.blocked]);
    expect(found).toEqual([
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

  it('never matches inside a structural vocabulary word by accident of a short value', () => {
    // `host` is the componentType of every node: it must never be offered for erasing.
    const found = findMatches(documentWith('host'), REV, match('host'));
    expect(found.filter((m) => m.blocked === null).map((m) => m.path)).not.toContain(
      '/pages/0/snapshot/appComponentTree/componentType',
    );
    expect(found.find((m) => m.path.endsWith('/componentType'))?.blocked).toBe('structural');
  });

  it('gives an excerpt with context, and ids that change with the string', () => {
    const doc = { description: `${'a'.repeat(60)} Max Mustermann ${'b'.repeat(60)}` };
    const [m] = findMatches(doc, REV, match('Max Mustermann'));
    expect(m.excerpt.startsWith('...')).toBe(true);
    expect(m.excerpt.endsWith('...')).toBe(true);
    expect(m.excerpt).toContain('Max Mustermann');
    const [same] = findMatches({ ...doc }, REV, match('Max Mustermann'));
    expect(same.id).toBe(m.id);
    const [changed] = findMatches({ description: `${doc.description}!` }, REV, match('Max Mustermann'));
    expect(changed.id).not.toBe(m.id);
    const [elsewhere] = findMatches(doc, { kind: 'working' }, match('Max Mustermann'));
    expect(elsewhere.id).not.toBe(m.id);
  });
});

describe('rewriteDocument', () => {
  it('replaces every erasable match and leaves everything else the same value', () => {
    const before = documentWith('Max Mustermann');
    const frozen = JSON.stringify(before);
    const { document, erased } = rewriteDocument(before, REV, match('Max Mustermann'), '', new Set());
    expect(JSON.stringify(before)).toBe(frozen); // the input is untouched
    expect(erased).toHaveLength(9);
    expect(findMatches(document, REV, match('Max Mustermann'))).toHaveLength(0);

    const after = document as ReturnType<typeof documentWith>;
    expect(after.siteSettings.business.managingDirectors).toEqual(['', 'Erika Muster']);
    // Untouched branches are the very same objects.
    expect(after.redirects).toBe(before.redirects);
    expect(after.siteSettings.theme).toBe(before.siteSettings.theme);
    expect(after.components).toBe(before.components);
    const tree = after.pages[0].snapshot.appComponentTree;
    expect(tree.props).toBe(before.pages[0].snapshot.appComponentTree.props);
    expect(tree.children[1].props).toEqual({ href: 'mailto:@bakery.example', title: '', children: 'Write' });
    expect(tree.children[2].props).toEqual({ name: 'fullName', placeholder: '', defaultValue: '', 'data-form-kind': 'field' });
    assertRevisionShapeKept(before, document);
  });

  it('keeps the matches left out, and blocked ones, and uses the replacement', () => {
    const before = {
      description: 'Max Mustermann and Max Mustermann',
      redirects: [{ from: '/Max Mustermann' }],
    };
    const all = findMatches(before, REV, match('max mustermann'));
    expect(all.map((m) => m.blocked)).toEqual([null, null, 'address']);
    const { document, erased } = rewriteDocument(before, REV, match('max mustermann'), '[entfernt]', new Set([all[1].id]));
    expect(erased.map((m) => m.id)).toEqual([all[0].id]);
    expect((document as typeof before).description).toBe('[entfernt] and Max Mustermann');
    expect((document as typeof before).redirects).toBe(before.redirects);
  });

  it('never rewrites a blocked match', () => {
    const before = { pages: [{ pageId: 'p', slug: 'max-power', snapshot: { props: { className: 'max-power' } } }] };
    const { document, erased } = rewriteDocument(before, REV, match('max-power'), '', new Set());
    expect(erased).toEqual([]);
    expect(document).toBe(before);
  });
});

describe('matchesToken', () => {
  it('does not depend on the order, and changes with any match', () => {
    const a = findMatches(documentWith('Max Mustermann'), REV, match('Max Mustermann'));
    expect(matchesToken([...a].reverse())).toBe(matchesToken(a));
    expect(matchesToken(a.slice(1))).not.toBe(matchesToken(a));
  });
});

describe('replacementContainsValue', () => {
  it('refuses a replacement the search would find again', () => {
    const q = { value: 'Max Mustermann', caseSensitive: false };
    expect(replacementContainsValue('', q)).toBe(false);
    expect(replacementContainsValue('[entfernt]', q)).toBe(false);
    expect(replacementContainsValue('MAX MUSTERMANN (former)', q)).toBe(true);
  });
});

describe('assertRevisionShapeKept', () => {
  it('refuses a document that no longer parses or lost a page', () => {
    const before = documentWith('Max Mustermann');
    expect(() => assertRevisionShapeKept(before, { ...before, schemaVersion: 99 })).toThrow(EraseShapeError);
    expect(() => assertRevisionShapeKept(before, { ...before, pages: [] })).toThrow(EraseShapeError);
    expect(() =>
      assertRevisionShapeKept(before, { ...before, pages: [{ ...before.pages[0], slug: 'other' }] }),
    ).toThrow(EraseShapeError);
  });
});
