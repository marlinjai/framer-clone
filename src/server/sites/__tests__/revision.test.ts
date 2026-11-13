// parseRevisionDocument: what a stored revision reads as, and what it refuses.

import { describe, expect, it } from 'vitest';
import { normalizeSiteSettings } from '@/lib/site/siteSettings';
import { addFxLayer, fxFromPreset } from '@/lib/fxScene/edit';
import {
  MalformedRevisionError,
  parseRevisionDocument,
  REVISION_SCHEMA_VERSION,
  revisionPublishCheck,
} from '../revision';

const PAGE = { pageId: 'home', slug: '', snapshot: { id: 'home' } };
const schemaVersion = REVISION_SCHEMA_VERSION;

describe('parseRevisionDocument', () => {
  it('reads every frozen field', () => {
    const doc = parseRevisionDocument({
      schemaVersion,
      name: 'Bakery',
      description: 'Fresh bread',
      analyticsProjectId: 'p',
      ingestionEndpoint: 'https://in',
      apiKeyRef: 'REF',
      lumitraEnabled: true,
      redirects: [{ from: 'old', pageId: 'home', createdAt: '2026-11-01T00:00:00.000Z' }],
      siteSettings: { language: 'de' },
      pages: [PAGE],
      components: { nav: { title: 'Nav' } },
    });
    expect(doc).toEqual({
      schemaVersion,
      name: 'Bakery',
      description: 'Fresh bread',
      analyticsProjectId: 'p',
      ingestionEndpoint: 'https://in',
      apiKeyRef: 'REF',
      lumitraEnabled: true,
      redirects: [{ from: 'old', pageId: 'home', createdAt: '2026-11-01T00:00:00.000Z' }],
      siteSettings: normalizeSiteSettings({ language: 'de' }),
      pages: [PAGE],
      components: { nav: { title: 'Nav' } },
    });
  });

  it('defaults what a field added later would miss in an older document', () => {
    const doc = parseRevisionDocument({ schemaVersion, pages: [] });
    expect(doc.components).toEqual({});
    expect(doc.redirects).toEqual([]);
    // The description joined without a version bump (site branches plan): an older document reads as empty.
    expect(doc.description).toBe('');
    expect(doc.siteSettings).toEqual(normalizeSiteSettings({}));
    expect(doc.lumitraEnabled).toBe(false);
    expect(doc.apiKeyRef).toBeNull();
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['no schema version', { pages: [] }],
    ['a schema version this code cannot read', { schemaVersion: schemaVersion + 1, pages: [] }],
    ['no pages', { schemaVersion, name: 'x' }],
    ['pages of the wrong type', { schemaVersion, pages: {} }],
    ['a page without a slug', { schemaVersion, pages: [{ pageId: 'home', snapshot: {} }] }],
    ['a page without an id', { schemaVersion, pages: [{ slug: '', snapshot: {} }] }],
    ['a page without a snapshot', { schemaVersion, pages: [{ pageId: 'home', slug: '' }] }],
    ['a page whose snapshot is not an object', { schemaVersion, pages: [{ pageId: 'home', slug: '', snapshot: 'x' }] }],
    ['a page whose snapshot is null', { schemaVersion, pages: [{ pageId: 'home', slug: '', snapshot: null }] }],
  ])('throws on %s, rather than serving an empty site or the drafts', (_label, raw) => {
    expect(() => parseRevisionDocument(raw)).toThrow(MalformedRevisionError);
  });
});

describe('revisionPublishCheck', () => {
  it('checks the frozen business data and pages', () => {
    const doc = parseRevisionDocument({
      schemaVersion,
      siteSettings: { business: { legalName: 'Bakery GmbH' } },
      pages: [{
        pageId: 'privacy',
        slug: 'datenschutz',
        snapshot: {
          metadata: { title: 'Datenschutz', legalTemplate: 'privacy' },
          appComponentTree: { props: { children: 'Kontakt: [E-Mail]' } },
        },
      }],
    });
    expect(revisionPublishCheck(doc)).toEqual({
      missingImpressum: true,
      maps: null,
      placeholders: [{ kind: 'privacy', pageId: 'privacy', title: 'Datenschutz', count: 1 }],
      components: [],
      tokens: [],
      fxText: [],
    });
  });

  it('reports FX scene text that has no HTML text in its box, as the editor does, on its own list', () => {
    const made = fxFromPreset('gold-noise-gradient');
    if (!made.ok) throw new Error(made.message);
    const withText = addFxLayer(made.stored, 'text');
    if (!withText.ok) throw new Error(withText.message);
    const box = (children: unknown[]) => ({ id: 'box', type: 'div', props: { 'data-fx': 'scene', fx: withText.stored }, children });
    const doc = (children: unknown[]) =>
      parseRevisionDocument({
        schemaVersion,
        pages: [{ pageId: 'home', slug: '', snapshot: { metadata: { title: 'Home' }, appComponentTree: { id: 'root', type: 'div', props: {}, children: [box(children)] } } }],
      });
    const check = revisionPublishCheck(doc([]));
    expect(check.fxText).toEqual([{ pageId: 'home', title: 'Home', message: expect.stringMatching(/text drawn inside the scene but no text in its box/) }]);
    expect(check.components).toEqual([]);
    // the box holds a headline: nothing to report
    expect(revisionPublishCheck(doc([{ id: 'h', type: 'h1', props: { children: 'Hello' } }])).fxText).toEqual([]);
  });

  it('reports a frozen definition that cannot be read, as the editor reports it', () => {
    const doc = parseRevisionDocument({ schemaVersion, pages: [PAGE], components: { nav: { title: 'Nav' } } });
    expect(revisionPublishCheck(doc).components).toEqual([
      { title: 'nav', message: expect.stringMatching(/^this component cannot be read, so it shows nothing/) },
    ]);
  });

  it('finds nothing on a site with no business data', () => {
    expect(revisionPublishCheck(parseRevisionDocument({ schemaVersion, pages: [PAGE] }))).toEqual({
      missingImpressum: false,
      maps: null,
      placeholders: [],
      components: [],
      tokens: [],
      fxText: [],
    });
  });

  it('names a site colour the frozen theme does not hold, on the page that uses it', () => {
    const page = {
      pageId: 'home',
      slug: '',
      snapshot: {
        id: 'home',
        metadata: { title: 'Home' },
        appComponentTree: { id: 'r', type: 'div', componentType: 'host', props: {}, children: [{ id: 'p', type: 'p', componentType: 'host', props: { style: { color: 'var(--fc-t-ghost001)' } }, children: [] }] },
      },
    };
    const doc = parseRevisionDocument({ schemaVersion, pages: [page], siteSettings: { theme: { tokens: [], document: {} } } });
    const tokens = revisionPublishCheck(doc).tokens ?? [];
    expect(JSON.stringify(page.snapshot)).toContain('ghost001');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ pageId: page.pageId, message: expect.stringMatching(/no longer exists/) });
  });
});
