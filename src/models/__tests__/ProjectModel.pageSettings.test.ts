// Page settings on the model: the slug rules are enforced by the MST actions
// themselves (not only by the panel), new pages get suggested slugs, and a
// settings save is ONE action, so it is one undo step.

import { describe, it, expect } from 'vitest';
import ProjectModel, { type ProjectModelType } from '../ProjectModel';
import HistoryStore from '@/stores/HistoryStore';

function project(): ProjectModelType {
  const p = ProjectModel.create({
    id: 'proj',
    metadata: { title: 'Bakery' },
    pages: {},
  });
  // A home page (empty slug) the way new projects start.
  const home = p.createPage('Home');
  home.setSlug('');
  return p;
}

describe('createPage slugs', () => {
  it('transliterates umlauts and adds a number on collision', () => {
    const p = project();
    expect(p.createPage('Über uns').slug).toBe('ueber-uns');
    expect(p.createPage('Über uns').slug).toBe('ueber-uns-2');
  });

  it('never creates a reserved slug', () => {
    expect(project().createPage('API').slug).toBe('api-page');
  });
});

describe('setPageSlug', () => {
  it('sets a valid, unused slug', () => {
    const p = project();
    const page = p.createPage('About');
    expect(p.setPageSlug(page.id, 'about-us')).toEqual({ ok: true });
    expect(page.slug).toBe('about-us');
  });

  it('refuses an invalid slug without rewriting it', () => {
    const p = project();
    const page = p.createPage('About');
    expect(p.setPageSlug(page.id, 'About Us')).toMatchObject({ ok: false, code: 'invalid_characters' });
    expect(page.slug).toBe('about');
  });

  it('refuses a slug another page uses', () => {
    const p = project();
    p.createPage('Contact');
    const page = p.createPage('About');
    expect(p.setPageSlug(page.id, 'contact')).toMatchObject({ ok: false, code: 'taken' });
  });

  it('refuses to change the home page slug', () => {
    const p = project();
    const home = p.pagesArray.find((pg) => pg.isHome)!;
    expect(p.setPageSlug(home.id, 'start')).toMatchObject({ ok: false, code: 'home_locked' });
    expect(home.slug).toBe('');
  });
});

describe('updatePageSettings', () => {
  it('saves name, slug and description together', () => {
    const p = project();
    const page = p.createPage('About');
    const result = p.updatePageSettings(page.id, {
      title: ' About us ',
      slug: 'company/about',
      description: ' Who we are. ',
    });
    expect(result).toEqual({ ok: true });
    expect(page.metadata.title).toBe('About us');
    expect(page.slug).toBe('company/about');
    expect(page.metadata.description).toBe('Who we are.');
  });

  it('changes nothing when any field is invalid', () => {
    const p = project();
    const page = p.createPage('About');
    const result = p.updatePageSettings(page.id, { title: '', slug: 'api', description: 'x' });
    expect(result).toMatchObject({ ok: false, errors: { title: expect.any(String), slug: expect.any(String) } });
    expect(page.metadata.title).toBe('About');
    expect(page.slug).toBe('about');
    expect(page.metadata.description).toBe('');
  });

  it('keeps an unchanged legacy slug that predates the rules', () => {
    const p = project();
    const page = p.createPage('Legacy');
    page.setSlug('Old_Slug');
    expect(p.updatePageSettings(page.id, { title: 'Renamed', slug: 'Old_Slug', description: '' })).toEqual({ ok: true });
    expect(page.metadata.title).toBe('Renamed');
  });

  it('lets the home page be renamed but never moved', () => {
    const p = project();
    const home = p.pagesArray.find((pg) => pg.isHome)!;
    expect(p.updatePageSettings(home.id, { title: 'Start', slug: '', description: '' })).toEqual({ ok: true });
    expect(home.metadata.title).toBe('Start');
    expect(p.updatePageSettings(home.id, { title: 'Start', slug: 'start', description: '' })).toMatchObject({
      ok: false,
      errors: { slug: expect.any(String) },
    });
    expect(home.slug).toBe('');
  });

  it('is one undo step, and undo restores every field', () => {
    const p = project();
    const page = p.createPage('About');
    const history = HistoryStore.create({});
    history.setTargetStore(p);

    p.updatePageSettings(page.id, { title: 'About us', slug: 'about-us', description: 'Hello' });
    expect(history.history.length).toBe(1);

    history.undo();
    expect(page.metadata.title).toBe('About');
    expect(page.slug).toBe('about');
    expect(page.metadata.description).toBe('');

    history.redo();
    expect(page.slug).toBe('about-us');
  });

  it('records no history when nothing changed', () => {
    const p = project();
    const page = p.createPage('About');
    const history = HistoryStore.create({});
    history.setTargetStore(p);
    p.updatePageSettings(page.id, { title: 'About', slug: 'about', description: '' });
    expect(history.history.length).toBe(0);
  });
});

describe('home page edge cases of older projects', () => {
  it('setHomePage gives a project without a home page one', () => {
    const p = project();
    const home = p.pagesArray.find((pg) => pg.isHome)!;
    const about = p.createPage('About');
    p.removePage(home.id);
    expect(p.hasHomePage).toBe(false);
    expect(p.setHomePage(about.id)).toEqual({ ok: true, previousSlug: 'about', moved: [] });
    expect(about.slug).toBe('');
    expect(p.hasHomePage).toBe(true);
    expect(p.isSlugLocked(about.id)).toBe(true);
  });

  it('lets an extra empty-slug page move, but never the last one', () => {
    const p = project();
    const extra = p.createPage('Duplicate home');
    extra.setSlug('');
    expect(p.isSlugLocked(extra.id)).toBe(false);
    expect(p.setPageSlug(extra.id, 'old-home')).toEqual({ ok: true });
    const home = p.pagesArray.find((pg) => pg.isHome)!;
    expect(p.isSlugLocked(home.id)).toBe(true);
    expect(p.setPageSlug(home.id, 'x')).toMatchObject({ ok: false, code: 'home_locked' });
  });
});

