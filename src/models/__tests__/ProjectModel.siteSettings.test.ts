// Site settings on the model: one frozen, always-normalized object, saved as
// one action (one undo step), validated before anything changes, and the 404
// page pointer that keeps exactly one 404 page per site.

import { describe, it, expect } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import ProjectModel, { type ProjectModelType } from '../ProjectModel';
import HistoryStore from '@/stores/HistoryStore';
import { normalizeSiteSettings } from '@/lib/site/siteSettings';

function project(snapshotExtra: Record<string, unknown> = {}): ProjectModelType {
  const p = ProjectModel.create({
    id: 'proj',
    metadata: { title: 'Bakery' },
    pages: {},
    ...snapshotExtra,
  });
  const home = p.createPage('Home');
  home.setSlug('');
  return p;
}

const valid = () => ({
  ...normalizeSiteSettings({}),
  siteName: 'Bäckerei Müller',
  language: 'de',
  business: {
    ...normalizeSiteSettings({}).business,
    street: 'Hauptstr. 1',
    postalCode: '80331',
    city: 'München',
    country: 'DE',
    email: 'hallo@mueller.de',
  },
});

describe('loading', () => {
  it('an older snapshot without site settings loads with every default, language en', () => {
    const p = project();
    expect(p.site).toEqual(normalizeSiteSettings({}));
    expect(p.site.language).toBe('en');
  });

  it('a partial or malformed stored object is normalized on the way in', () => {
    const p = project({ siteSettings: { language: 'de', faviconUrl: 3, business: 'x' } });
    expect(p.site.language).toBe('de');
    expect(p.site.faviconUrl).toBe('');
    expect(p.site.business.openingHours).toEqual([]);
  });

  it('round-trips through a snapshot unchanged', () => {
    const p = project();
    p.updateSiteSettings(valid());
    const again = ProjectModel.create(getSnapshot(p));
    expect(again.site).toEqual(p.site);
  });
});

describe('updateSiteSettings', () => {
  it('stores a valid object as one undo step', () => {
    const p = project();
    const history = HistoryStore.create({});
    history.setTargetStore(p);
    expect(p.updateSiteSettings(valid())).toEqual({ ok: true });
    expect(p.site.siteName).toBe('Bäckerei Müller');
    expect(history.history.length).toBe(1);
    history.undo();
    expect(p.site.siteName).toBe('');
    history.redo();
    expect(p.site.business.city).toBe('München');
  });

  it('refuses an invalid object and changes nothing', () => {
    const p = project();
    const result = p.updateSiteSettings({ ...valid(), language: 'Deutsch', faviconUrl: 'http://x.test/i.png' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.language).toBeDefined();
      expect(result.errors.faviconUrl).toBeDefined();
    }
    expect(p.site.siteName).toBe('');
  });

  it('records no history when nothing changed', () => {
    const p = project();
    const history = HistoryStore.create({});
    history.setTargetStore(p);
    p.updateSiteSettings(normalizeSiteSettings({}));
    expect(history.history.length).toBe(0);
  });

  it('refuses a 404 pointer at the home page or at a missing page', () => {
    const p = project();
    const home = p.pagesArray.find((pg) => pg.slug === '')!;
    const r1 = p.updateSiteSettings({ ...valid(), notFoundPageId: home.id });
    const r2 = p.updateSiteSettings({ ...valid(), notFoundPageId: 'gone' });
    expect(r1).toMatchObject({ ok: false, errors: { notFoundPageId: expect.stringMatching(/home page/) } });
    expect(r2).toMatchObject({ ok: false, errors: { notFoundPageId: expect.stringMatching(/no longer exists/) } });
    expect(p.site.notFoundPageId).toBe('');
  });
});

describe('the 404 page through Page settings', () => {
  it('marks exactly one page: choosing another moves the pointer', () => {
    const p = project();
    const a = p.createPage('Oops');
    const b = p.createPage('Lost');
    expect(p.updatePageSettings(a.id, { title: 'Oops', slug: 'oops', description: '', notFoundPage: true })).toEqual({ ok: true });
    expect(p.site.notFoundPageId).toBe(a.id);
    p.updatePageSettings(b.id, { title: 'Lost', slug: 'lost', description: '', notFoundPage: true });
    expect(p.site.notFoundPageId).toBe(b.id);
    p.updatePageSettings(b.id, { title: 'Lost', slug: 'lost', description: '', notFoundPage: false });
    expect(p.site.notFoundPageId).toBe('');
  });

  it('never makes the home page the 404 page', () => {
    const p = project();
    const home = p.pagesArray.find((pg) => pg.slug === '')!;
    const result = p.updatePageSettings(home.id, { title: 'Home', slug: '', description: '', notFoundPage: true });
    expect(result).toMatchObject({ ok: false, errors: { notFoundPage: expect.any(String) } });
    expect(p.site.notFoundPageId).toBe('');
  });

  it('deleting the 404 page falls back to the default 404', () => {
    const p = project();
    const a = p.createPage('Oops');
    p.updatePageSettings(a.id, { title: 'Oops', slug: 'oops', description: '', notFoundPage: true });
    p.removePage(a.id);
    expect(p.site.notFoundPageId).toBe('');
  });

  it('a 404 page that becomes the home page stops being the 404 page', () => {
    const p = ProjectModel.create({ id: 'p2', metadata: { title: 'x' }, pages: {} });
    const a = p.createPage('Oops');
    p.updatePageSettings(a.id, { title: 'Oops', slug: a.slug, description: '', notFoundPage: true });
    expect(p.setHomePage(a.id)).toMatchObject({ ok: true });
    expect(p.site.notFoundPageId).toBe('');
  });

  it('saves the Open Graph image and noindex with the rest, as one undo step', () => {
    const p = project();
    const page = p.createPage('About');
    const history = HistoryStore.create({});
    history.setTargetStore(p);
    expect(
      p.updatePageSettings(page.id, {
        title: 'About',
        slug: 'about',
        description: '',
        ogImage: 'https://cdn.example.com/og.jpg',
        noIndex: true,
        notFoundPage: false,
      }),
    ).toEqual({ ok: true });
    expect(page.metadata.ogImage).toBe('https://cdn.example.com/og.jpg');
    expect(page.metadata.noIndex).toBe(true);
    expect(history.history.length).toBe(1);
    history.undo();
    expect(page.metadata.noIndex).toBe(false);
    expect(page.metadata.ogImage).toBe('');
  });

  it('refuses an Open Graph image that is not an https address', () => {
    const p = project();
    const page = p.createPage('About');
    const result = p.updatePageSettings(page.id, { title: 'About', slug: 'about', description: '', ogImage: 'ftp://x/y.png' });
    expect(result).toMatchObject({ ok: false, errors: { ogImage: expect.any(String) } });
    expect(page.metadata.ogImage).toBe('');
  });

  it('leaves the new fields alone when a caller omits them', () => {
    const p = project();
    const page = p.createPage('About');
    page.updateMetadata({ ogImage: 'https://cdn.example.com/a.jpg', noIndex: true });
    p.updatePageSettings(page.id, { title: 'About us', slug: 'about', description: '' });
    expect(page.metadata.ogImage).toBe('https://cdn.example.com/a.jpg');
    expect(page.metadata.noIndex).toBe(true);
  });
});
