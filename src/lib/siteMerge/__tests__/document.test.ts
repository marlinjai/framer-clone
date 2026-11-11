// The whole-document merge (src/lib/siteMerge/document.ts): site fields, settings, pages, components, and
// the address rule (rule 9), as the site branches plan, section 5, states them.

import { describe, expect, it } from 'vitest';
import { mergeDocuments, type MergeDocument, type MergePage } from '../document';
import type { MergeAnswers } from '../types';

function page(pageId: string, slug: string, text = 'Hello', over: Record<string, unknown> = {}): MergePage {
  return {
    pageId,
    slug,
    snapshot: {
      id: pageId,
      slug,
      metadata: { title: pageId, description: '' },
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      appComponentTree: { id: `root-${pageId}`, type: 'div', componentType: 'host', props: {}, children: [{ id: `t-${pageId}`, type: 'p', componentType: 'host', props: { children: text } }] },
      canvasNodes: {},
      ...over,
    },
  };
}

function doc(over: Partial<MergeDocument> = {}): MergeDocument {
  return {
    schemaVersion: 1,
    name: 'Bakery',
    description: '',
    analyticsProjectId: null,
    ingestionEndpoint: null,
    apiKeyRef: null,
    lumitraEnabled: false,
    redirects: [],
    siteSettings: {
      siteName: '',
      language: 'de',
      business: { legalName: 'Müller GmbH', city: 'Berlin', managingDirectors: [] },
      theme: { tokens: [{ id: 'aaaaaaaa', name: 'Brand', value: '#f00' }, { id: 'bbbbbbbb', name: 'Ink', value: '#000' }], document: { font: 'Inter' } },
      head: [],
    },
    pages: [page('home', ''), page('about', 'about')],
    components: {},
    ...over,
  };
}

// Stored JSON read loosely in assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
const settings = (d: MergeDocument): Loose => d.siteSettings;
const loose = (value: unknown): Loose => value;

describe('mergeDocuments', () => {
  it('nothing changed on the branch: main as it is', () => {
    const main = doc({ name: 'Bakery Müller' });
    const { document, conflicts } = mergeDocuments(doc(), main, doc());
    expect(document).toEqual(main);
    expect(conflicts).toEqual([]);
  });

  it('site fields are one value each; redirects are main’s', () => {
    const main = doc({ name: 'Main', redirects: [{ from: 'old', pageId: 'about' }] });
    const branch = doc({ description: 'Fresh bread', redirects: [{ from: 'x', pageId: 'home' }] });
    const { document, conflicts } = mergeDocuments(doc(), main, branch);
    expect(document).toMatchObject({ name: 'Main', description: 'Fresh bread', redirects: [{ from: 'old', pageId: 'about' }] });
    expect(conflicts).toEqual([]);
    expect(mergeDocuments(doc(), doc({ name: 'A' }), doc({ name: 'B' })).conflicts.map((c) => [c.kind, c.unit.kind, c.path])).toEqual([['value', 'site', ['name']]]);
  });

  it('rule 11: settings merge per key and business per field; two different languages conflict', () => {
    const main = doc();
    settings(main).business = { ...settings(main).business, city: 'München' };
    const branch = doc();
    settings(branch).business = { ...settings(branch).business, legalName: 'Müller & Söhne GmbH' };
    settings(branch).siteName = 'Müller';
    const merged = mergeDocuments(doc(), main, branch);
    expect(settings(merged.document).business).toMatchObject({ legalName: 'Müller & Söhne GmbH', city: 'München' });
    expect(settings(merged.document).siteName).toBe('Müller');
    expect(merged.conflicts).toEqual([]);

    const en = doc();
    settings(en).language = 'en';
    const fr = doc();
    settings(fr).language = 'fr';
    expect(mergeDocuments(doc(), en, fr).conflicts.map((c) => [c.unit.kind, c.path])).toEqual([['settings', ['language']]]);
  });

  it('theme tokens merge by id: a token added on each side, an edit on each, both kept', () => {
    const main = doc();
    settings(main).theme.tokens = [{ id: 'aaaaaaaa', name: 'Brand', value: '#0f0' }, settings(main).theme.tokens[1], { id: 'cccccccc', name: 'M', value: '#111' }];
    const branch = doc();
    settings(branch).theme.tokens = [settings(branch).theme.tokens[0], { id: 'bbbbbbbb', name: 'Ink', value: '#222' }, { id: 'dddddddd', name: 'R', value: '#333' }];
    const { document, conflicts } = mergeDocuments(doc(), main, branch);
    expect(settings(document).theme.tokens.map((t: { id: string; value: string }) => `${t.id}:${t.value}`)).toEqual([
      'aaaaaaaa:#0f0',
      'bbbbbbbb:#222',
      // Rule 8: the branch's new token goes right after the one it followed there.
      'dddddddd:#333',
      'cccccccc:#111',
    ]);
    expect(conflicts).toEqual([]);
  });

  it('the head is one value: two different changes conflict', () => {
    const main = doc();
    settings(main).head = [{ kind: 'meta', name: 'a' }];
    const branch = doc();
    settings(branch).head = [{ kind: 'meta', name: 'b' }];
    expect(mergeDocuments(doc(), main, branch).conflicts.map((c) => c.path)).toEqual([['head']]);
  });

  it('pages: added on either side kept in place, metadata per field, text inside a page merged by node', () => {
    const main = doc({ pages: [page('home', '', 'Welcome'), page('about', 'about'), page('menu', 'menu')] });
    const about = page('about', 'about');
    (about.snapshot.metadata as Record<string, unknown>).description = 'Who we are';
    const branch = doc({ pages: [page('home', ''), page('team', 'team'), about] });
    const { document, conflicts } = mergeDocuments(doc(), main, branch);
    expect(document.pages.map((p) => p.pageId)).toEqual(['home', 'team', 'about', 'menu']);
    expect(loose(document.pages[0].snapshot.appComponentTree).children[0].props.children).toBe('Welcome');
    expect((document.pages[2].snapshot.metadata as Record<string, unknown>).description).toBe('Who we are');
    expect(conflicts).toEqual([]);
  });

  it('a page’s timestamps never conflict, and follow the content that stands', () => {
    const main = doc({ pages: [page('home', '', 'Hello', { updatedAt: '2026-11-03T00:00:00.000Z' }), page('about', 'about')] });
    const branch = doc({ pages: [page('home', ''), page('about', 'about', 'New', { updatedAt: '2026-11-05T00:00:00.000Z' })] });
    const { document, conflicts } = mergeDocuments(doc(), main, branch);
    expect(conflicts).toEqual([]);
    expect(document.pages[0].snapshot.updatedAt).toBe('2026-11-03T00:00:00.000Z');
    expect(document.pages[1].snapshot.updatedAt).toBe('2026-11-05T00:00:00.000Z');
  });

  it('rule 6 for pages: removed on main, edited on the branch, a conflict; untouched, removed', () => {
    const main = doc({ pages: [page('home', '')] });
    expect(mergeDocuments(doc(), main, doc()).document.pages.map((p) => p.pageId)).toEqual(['home']);
    const branch = doc({ pages: [page('home', ''), page('about', 'about', 'Edited')] });
    const merged = mergeDocuments(doc(), main, branch);
    expect(merged.conflicts.map((c) => [c.kind, c.unit.kind, c.unit.id, c.removedOn])).toEqual([['removed', 'page', 'about', 'main']]);
    const [conflict] = merged.conflicts;
    const answers: MergeAnswers = { [conflict.id]: { fingerprint: conflict.fingerprint, pick: 'branch' } };
    expect(mergeDocuments(doc(), main, branch, answers).document.pages.map((p) => p.pageId)).toEqual(['home', 'about']);
  });

  it('rule 9: two pages ending with one address conflict; the other page gets a free one', () => {
    const main = doc({ pages: [page('home', ''), page('about', 'about'), page('menu', 'karte')] });
    const branch = doc({ pages: [page('home', ''), page('about', 'about'), page('prices', 'karte')] });
    const merged = mergeDocuments(doc(), main, branch);
    expect(merged.conflicts.map((c) => [c.kind, c.unit.id])).toEqual([['slug', 'menu+prices']]);
    // Main's page keeps it while unanswered.
    const slugs = (d: MergeDocument) => Object.fromEntries(d.pages.map((p) => [p.pageId, p.slug]));
    expect(slugs(merged.document)).toMatchObject({ menu: 'karte', prices: 'karte-2' });
    const [conflict] = merged.conflicts;
    const answered = mergeDocuments(doc(), main, branch, { [conflict.id]: { fingerprint: conflict.fingerprint, pick: 'branch' } });
    expect(slugs(answered.document)).toMatchObject({ menu: 'karte-2', prices: 'karte' });
    expect(answered.document.pages.find((p) => p.pageId === 'prices')?.snapshot.slug).toBe('karte');
  });

  it('rule 9: the home page’s empty address never changes hands', () => {
    const main = doc();
    const branch = doc({ pages: [page('home', ''), page('about', '')] });
    const merged = mergeDocuments(doc(), main, branch);
    const [conflict] = merged.conflicts;
    expect(conflict).toMatchObject({ kind: 'slug', options: ['main'] });
    // A branch answer is not one this conflict takes.
    const refused = mergeDocuments(doc(), main, branch, { [conflict.id]: { fingerprint: conflict.fingerprint, pick: 'branch' } });
    expect(refused.conflicts).toHaveLength(1);
    // The other page goes back to its own address.
    expect(merged.document.pages.find((p) => p.pageId === 'about')?.slug).toBe('about');
  });

  it('components: fields per field, inputs by id, the page as a tree, removal against use as a conflict', () => {
    const definition = (over: Record<string, unknown> = {}, text = 'Card') => ({
      id: 'card',
      name: 'Card',
      inputs: [{ id: 'title', name: 'Title', type: 'text', default: 'Hi' }],
      states: [],
      page: page('card-page', '', text).snapshot,
      ...over,
    });
    const main = doc({ components: { card: definition({ name: 'Card M' }) } });
    const branch = doc({
      components: { card: definition({ inputs: [{ id: 'title', name: 'Title', type: 'text', default: 'Hello' }, { id: 'img', name: 'Image', type: 'image' }] }, 'Card R') },
    });
    const { document, conflicts } = mergeDocuments(doc({ components: { card: definition() } }), main, branch);
    const card = loose(document.components.card);
    expect(card.name).toBe('Card M');
    expect(card.inputs).toEqual([{ id: 'title', name: 'Title', type: 'text', default: 'Hello' }, { id: 'img', name: 'Image', type: 'image' }]);
    expect(card.page.appComponentTree.children[0].props.children).toBe('Card R');
    expect(conflicts).toEqual([]);

    const removed = mergeDocuments(doc({ components: { card: definition() } }), doc(), branch);
    expect(removed.conflicts.map((c) => [c.kind, c.unit.kind, c.removedOn])).toEqual([['removed', 'component', 'main']]);
  });

  it('conflicts come out in the same order with the same ids on every run', () => {
    const main = doc({ name: 'A', pages: [page('home', '', 'M'), page('about', 'about')] });
    const branch = doc({ name: 'B', pages: [page('home', '', 'R'), page('about', 'about')] });
    const first = mergeDocuments(doc(), main, branch).conflicts.map((c) => c.id);
    expect(first).toHaveLength(2);
    expect(mergeDocuments(doc(), main, branch).conflicts.map((c) => c.id)).toEqual(first);
  });
});
