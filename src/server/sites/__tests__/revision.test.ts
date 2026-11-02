// parseRevisionDocument: what a stored revision reads as, and what it refuses.

import { describe, expect, it } from 'vitest';
import { normalizeSiteSettings } from '@/lib/site/siteSettings';
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
    });
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
    });
  });
});
