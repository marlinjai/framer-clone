// "Set as home page" on the model (ProjectModel.setHomePage): the chosen page
// takes the empty slug, the former home page moves to a free slug derived from
// its name, in-site links to the chosen page's old path point at the root, and
// the whole change is ONE undo step. Covers the four stateful paths: forward,
// changing your mind (set another page), resume from a saved snapshot, and
// re-entry after the former home page was deleted.

import { describe, it, expect } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import ProjectModel, { type ProjectModelType } from '../ProjectModel';
import { createIntrinsicComponent, type ComponentInstance } from '../ComponentModel';
import HistoryStore from '@/stores/HistoryStore';
import { findProjectSlugProblem } from '@/lib/pages/slug';

function project(): ProjectModelType {
  const p = ProjectModel.create({ id: 'proj', metadata: { title: 'Bakery' }, pages: {} });
  const home = p.createPage('Home');
  home.setSlug('');
  return p;
}

const homeOf = (p: ProjectModelType) => p.pagesArray.find((pg) => pg.slug === '')!;
const slugs = (p: ProjectModelType) => Object.fromEntries(p.pagesArray.map((pg) => [pg.metadata.title, pg.slug]));

function addLink(page: ReturnType<ProjectModelType['createPage']>, href: string): ComponentInstance {
  const link = createIntrinsicComponent(`link-${href}-${Math.random()}`, 'a', { href, children: 'Go' });
  (page.appComponentTree as unknown as ComponentInstance).addChild(link);
  const root = page.appComponentTree as unknown as ComponentInstance;
  return root.children[root.children.length - 1];
}

describe('setHomePage: forward', () => {
  it('gives the chosen page the root and moves the former home page to a free slug from its name', () => {
    const p = project();
    const home = homeOf(p);
    const about = p.createPage('About');
    const result = p.setHomePage(about.id);
    expect(result).toEqual({ ok: true, previousSlug: 'about', moved: [{ pageId: home.id, title: 'Home', slug: 'home-page' }] });
    expect(about.slug).toBe('');
    expect(home.slug).toBe('home-page');
    expect(p.isSlugLocked(about.id)).toBe(true);
    expect(p.isSlugLocked(home.id)).toBe(false);
    expect(p.homePage?.id).toBe(about.id);
  });

  it('picks a unique slug, and never the chosen page old path', () => {
    const p = project();
    homeOf(p).updateMetadata({ title: 'About' });
    p.createPage('Home page'); // takes home-page
    const about = p.createPage('About us');
    about.setSlug('about');
    p.setHomePage(about.id);
    // "about" stays reserved for the redirect to the root, so the former home
    // page (also named About) gets about-2.
    expect(slugs(p)).toEqual({ About: 'about-2', 'Home page': 'home-page', 'About us': '' });
  });

  it('previews exactly what it will do', () => {
    const p = project();
    const about = p.createPage('About');
    const preview = p.previewHomeChange(about.id);
    const result = p.setHomePage(about.id);
    expect(result.ok && result.moved).toEqual(preview);
  });

  it('points in-site links to the old path at the root, keeping a hash or query, and leaves other links alone', () => {
    const p = project();
    const home = homeOf(p);
    const about = p.createPage('About');
    const exact = addLink(home, '/about');
    const hash = addLink(home, '/about#team');
    const query = addLink(about, '/about?x=1');
    const other = addLink(home, '/about-us');
    const external = addLink(home, 'https://example.com/about');
    p.setHomePage(about.id);
    expect(exact.props.href).toBe('/');
    expect(hash.props.href).toBe('/#team');
    expect(query.props.href).toBe('/?x=1');
    expect(other.props.href).toBe('/about-us');
    expect(external.props.href).toBe('https://example.com/about');
  });

  it('stops the chosen page being the 404 page', () => {
    const p = project();
    const oops = p.createPage('Oops');
    p.updatePageSettings(oops.id, { title: 'Oops', slug: oops.slug, description: '', notFoundPage: true });
    expect(p.site.notFoundPageId).toBe(oops.id);
    p.setHomePage(oops.id);
    expect(p.site.notFoundPageId).toBe('');
  });

  it('refuses the page that already is the home page, and a missing page, changing nothing', () => {
    const p = project();
    const home = homeOf(p);
    const history = HistoryStore.create({});
    history.setTargetStore(p);
    expect(p.setHomePage(home.id)).toEqual({ ok: false, message: 'This page is already the home page.' });
    expect(p.setHomePage('nope')).toEqual({ ok: false, message: 'This page no longer exists.' });
    expect(home.slug).toBe('');
    expect(history.history.length).toBe(0);
  });

  it('refuses a page with a dynamic slug: at the root it has no item to show', () => {
    const p = project();
    const product = p.createPage('Product');
    product.setSlug('products/:handle');
    expect(p.canBecomeHomePage(product.id)).toBe(false);
    expect(p.setHomePage(product.id)).toMatchObject({ ok: false });
    expect(product.slug).toBe('products/:handle');
    expect(homeOf(p).slug).toBe('');
    expect(p.canBecomeHomePage(homeOf(p).id)).toBe(false);
    expect(p.canBecomeHomePage(p.createPage('About').id)).toBe(true);
  });

  it('in an older project with two empty-slug pages, moves both away so one home page remains', () => {
    const p = project();
    const extra = p.createPage('Start');
    extra.setSlug('');
    const about = p.createPage('About');
    p.setHomePage(about.id);
    expect(slugs(p)).toEqual({ Home: 'home-page', Start: 'start', About: '' });
  });

  it('is one undo step: undo restores both slugs, the links and the 404 pointer; redo applies it again', () => {
    const p = project();
    const home = homeOf(p);
    const about = p.createPage('About');
    const link = addLink(home, '/about');
    p.updatePageSettings(about.id, { title: 'About', slug: 'about', description: '', notFoundPage: true });
    const history = HistoryStore.create({});
    history.setTargetStore(p);

    p.setHomePage(about.id);
    expect(history.history.length).toBe(1);
    history.undo();
    expect(home.slug).toBe('');
    expect(about.slug).toBe('about');
    expect(link.props.href).toBe('/about');
    expect(p.site.notFoundPageId).toBe(about.id);
    expect(p.isSlugLocked(home.id)).toBe(true);
    history.redo();
    expect(about.slug).toBe('');
    expect(home.slug).toBe('home-page');
    expect(link.props.href).toBe('/');
  });
});

describe('setHomePage: changing your mind', () => {
  it('setting a third page as home moves the second one back to a slug from its name', () => {
    const p = project();
    const home = homeOf(p);
    const about = p.createPage('About');
    const contact = p.createPage('Contact');
    p.setHomePage(about.id);
    p.setHomePage(contact.id);
    expect(contact.slug).toBe('');
    // About gets its own name back as a slug: it is free again.
    expect(about.slug).toBe('about');
    expect(home.slug).toBe('home-page');
    expect(homeOf(p).id).toBe(contact.id);
    expect(p.pagesArray.filter((pg) => pg.slug === '')).toHaveLength(1);
  });

  it('setting the original home page back gives it the root again', () => {
    const p = project();
    const home = homeOf(p);
    const about = p.createPage('About');
    p.setHomePage(about.id);
    p.setHomePage(home.id);
    expect(home.slug).toBe('');
    expect(about.slug).toBe('about');
  });
});

describe('setHomePage: resume after save and reload', () => {
  it('a saved snapshot reloads with the new home page locked and passes the server save check', () => {
    const p = project();
    const home = homeOf(p);
    const about = p.createPage('About');
    const storedBefore = new Map(p.pagesArray.map((pg) => [pg.id, pg.slug]));
    p.setHomePage(about.id);

    const reloaded = ProjectModel.create(getSnapshot(p));
    expect(reloaded.getPage(about.id)?.slug).toBe('');
    expect(reloaded.getPage(home.id)?.slug).toBe('home-page');
    expect(reloaded.isSlugLocked(about.id)).toBe(true);
    expect(reloaded.isSlugLocked(home.id)).toBe(false);

    // The server accepts the change against what it stored before ...
    const incoming = reloaded.pagesArray.map((pg) => ({ pageId: pg.id, slug: pg.slug, title: pg.metadata.title }));
    expect(findProjectSlugProblem(incoming, storedBefore)).toBeNull();
    // ... and saving the reloaded project again changes nothing.
    const storedAfter = new Map(incoming.map((pg) => [pg.pageId, pg.slug]));
    expect(findProjectSlugProblem(incoming, storedAfter)).toBeNull();
  });
});

describe('setHomePage: re-entry after deleting the former home page', () => {
  it('the former home page deletes like any page, and the home page can change again afterwards', () => {
    const p = project();
    const home = homeOf(p);
    const about = p.createPage('About');
    const contact = p.createPage('Contact');
    const storedBefore = new Map(p.pagesArray.map((pg) => [pg.id, pg.slug]));
    p.setHomePage(about.id);
    p.removePage(home.id);
    expect(p.getPage(home.id)).toBeUndefined();
    const incoming = p.pagesArray.map((pg) => ({ pageId: pg.id, slug: pg.slug, title: pg.metadata.title }));
    expect(findProjectSlugProblem(incoming, storedBefore)).toBeNull();

    p.setHomePage(contact.id);
    expect(contact.slug).toBe('');
    expect(about.slug).toBe('about');
    expect(p.isSlugLocked(contact.id)).toBe(true);
  });
});
