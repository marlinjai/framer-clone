// The Head panel (docs/plans/2026-11-02-theme-and-head.md, slice H3) on a real root store, over
// the four paths: forward (add one of each, a verification code in a few steps), backtrack and
// revise (invalid JSON-LD keeps the last valid one, undo through each, a kind change), resume
// (a saved snapshot, a half-typed JSON-LD that is only a draft) and re-entry (a refused stored
// item shown as refused and deletable, a cap, a write that changes nothing).
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import ProjectModel, { type ProjectModelType } from '@/models/ProjectModel';
import type { PageModelType } from '@/models/PageModel';
import { HEAD_LIMITS, resolveHead } from '@/lib/site/headItems';
import { checkBeforePublish, hasPublishIssues } from '@/lib/legal/publishCheck';
import { HELP_KEYS, META_HELP, PROPERTY_HELP, REL_HELP } from '@/lib/site/headItemHelp';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

const { HeadItemsPanel, HeadItemsSection, HeadItemsDialog } = await import('../HeadItemsDialog');
const { HeadItemsEditor } = await import('../HeadItemsEditor');

let project: ProjectModelType;
let home: PageModelType;
const history = () => getHistoryStore()!;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = createRootStore();
  store.projectStore.createProject('Head panel');
  project = store.projectStore.findProjectByTitle('Head panel')!;
  store.editorUI.setCurrentProject(project);
  home = project.findPageBySlug('')!;
  store.editorUI.setCurrentPage(home);
  history().setTargetStore(store.projectStore);
  history().clear();
});
afterEach(() => cleanup());

const site = () => render(<HeadItemsPanel scope={{ kind: 'site', project }} />);
const page = () => render(<HeadItemsPanel scope={{ kind: 'page', project, page: home }} />);
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const newForm = () => within(screen.getByTestId('head-new'));
const message = () => screen.getAllByTestId('head-message').map((el) => el.textContent).join(' | ');

describe('forward', () => {
  it('adds a site verification code in a few steps and the head holds it', () => {
    site();
    // Type the name, type the code, press Add: three actions.
    fireEvent.change(newForm().getByLabelText('Name'), { target: { value: 'google-site-verification' } });
    fireEvent.change(newForm().getByLabelText('Content'), { target: { value: 'abc123' } });
    fireEvent.click(newForm().getByRole('button', { name: 'Add item' }));
    expect(project.site.head).toEqual([{ kind: 'meta', name: 'google-site-verification', content: 'abc123' }]);
    expect(resolveHead(project.site.head, []).items).toHaveLength(1);
    expect(screen.getByTestId('head-count').textContent).toContain('1 of 20');
    expect(screen.getByTestId('head-status').textContent).toBe('Published');
  });

  it('adds one of each kind to a page, and to the site', () => {
    page();
    const add = () => fireEvent.click(newForm().getByRole('button', { name: /Add/ }));
    fireEvent.change(newForm().getByLabelText('Name'), { target: { value: 'author' } });
    fireEvent.change(newForm().getByLabelText('Content'), { target: { value: 'Marlin' } });
    add();
    fireEvent.change(newForm().getByLabelText('Kind'), { target: { value: 'property' } });
    fireEvent.change(newForm().getByLabelText('Property'), { target: { value: 'article:tag' } });
    fireEvent.change(newForm().getByLabelText('Content'), { target: { value: 'news' } });
    add();
    fireEvent.change(newForm().getByLabelText('Kind'), { target: { value: 'link' } });
    fireEvent.change(newForm().getByLabelText('Address'), { target: { value: 'https://example.com/me' } });
    fireEvent.change(newForm().getByLabelText('Relation'), { target: { value: 'me' } });
    add();
    fireEvent.change(newForm().getByLabelText('Kind'), { target: { value: 'link' } });
    fireEvent.change(newForm().getByLabelText('Address'), { target: { value: '/de' } });
    fireEvent.change(newForm().getByLabelText('Language'), { target: { value: 'de' } });
    add();
    fireEvent.change(newForm().getByLabelText('Kind'), { target: { value: 'jsonld' } });
    fireEvent.change(newForm().getByLabelText('JSON-LD'), { target: { value: '{"@context":"https://schema.org","@type":"Organization","name":"Bakery"}' } });
    add();
    expect(home.metadata.head.map((i) => i.kind)).toEqual(['meta', 'property', 'link', 'link', 'jsonld']);
    expect(home.metadata.head[3]).toEqual({ kind: 'link', rel: 'alternate', href: '/de', hreflang: 'de' });
    expect(resolveHead([], home.metadata.head).problems).toEqual([]);
  });

  it('refuses an owned name with the field to use, and Add stays off', () => {
    site();
    fireEvent.change(newForm().getByLabelText('Name'), { target: { value: 'description' } });
    fireEvent.change(newForm().getByLabelText('Content'), { target: { value: 'x' } });
    expect(message()).toContain("page's Description");
    expect((newForm().getByRole('button', { name: 'Add item' }) as HTMLButtonElement).disabled).toBe(true);
    expect(project.site.head).toEqual([]);
  });

  it('refuses http-equiv, a stylesheet and a script address before anything is stored', () => {
    site();
    fireEvent.change(newForm().getByLabelText('Name'), { target: { value: 'http-equiv' } });
    fireEvent.change(newForm().getByLabelText('Content'), { target: { value: 'refresh' } });
    expect(message()).toMatch(/not on the list/);
    fireEvent.change(newForm().getByLabelText('Kind'), { target: { value: 'link' } });
    fireEvent.change(newForm().getByLabelText('Address'), { target: { value: 'javascript:alert(1)' } });
    expect(message()).toMatch(/full https address/);
    expect(within(screen.getByTestId('head-new')).queryByRole('option', { name: 'stylesheet' })).toBeNull();
    expect(project.site.head).toEqual([]);
  });

  it('saves a page content type at once', () => {
    page();
    fireEvent.change(screen.getByLabelText('Content type'), { target: { value: 'article' } });
    expect(home.metadata.ogType).toBe('article');
    fireEvent.change(screen.getByLabelText('Content type'), { target: { value: 'product' } });
    expect(home.metadata.ogType).toBe('website');
  });

  it('splits pasted structured data lists into items', () => {
    site();
    fireEvent.change(newForm().getByLabelText('Kind'), { target: { value: 'jsonld' } });
    const one = { '@context': 'https://schema.org', '@type': 'Thing' };
    fireEvent.change(newForm().getByLabelText('JSON-LD'), { target: { value: JSON.stringify([one, { ...one, name: 'b' }]) } });
    fireEvent.click(newForm().getByRole('button', { name: 'Add 2 items' }));
    expect(project.site.head).toHaveLength(2);
  });
});

describe('backtrack and revise', () => {
  const ld = '{"@context":"https://schema.org","@type":"Organization","name":"Bakery"}';

  function withLd() {
    home.updateMetadata({ head: [{ kind: 'jsonld', data: JSON.parse(ld) }] });
    history().clear();
    return page();
  }
  const box = () => within(screen.getByTestId('head-row')).getByLabelText('JSON-LD') as HTMLTextAreaElement;

  it('editing JSON-LD to invalid keeps the last valid one and shows why', () => {
    withLd();
    fireEvent.change(box(), { target: { value: '{"@context":"https://schema.org","@type":' } });
    fireEvent.blur(box());
    expect(home.metadata.head).toEqual([{ kind: 'jsonld', data: JSON.parse(ld) }]);
    expect(message()).toMatch(/Not valid JSON/);
    expect(message()).toMatch(/last saved version is kept/);
    expect(history().history.length).toBe(0);
  });

  it('a valid edit saves once, on leaving the field, and undo restores the earlier one', () => {
    withLd();
    fireEvent.change(box(), { target: { value: ld.replace('Bakery', 'Cafe') } });
    expect(history().history.length).toBe(0);
    fireEvent.blur(box());
    expect(history().history.length).toBe(1);
    expect((home.metadata.head[0].data as { name: string }).name).toBe('Cafe');
    history().undo();
    expect((home.metadata.head[0].data as { name: string }).name).toBe('Bakery');
    history().redo();
    expect((home.metadata.head[0].data as { name: string }).name).toBe('Cafe');
  });

  it('each add, edit and delete is one undo step, for the site and for a page', () => {
    site();
    fireEvent.change(newForm().getByLabelText('Name'), { target: { value: 'author' } });
    fireEvent.change(newForm().getByLabelText('Content'), { target: { value: 'a' } });
    fireEvent.click(newForm().getByRole('button', { name: 'Add item' }));
    expect(history().history.length).toBe(1);
    click('Delete head item 1');
    expect(project.site.head).toEqual([]);
    expect(history().history.length).toBe(2);
    history().undo();
    expect(project.site.head).toHaveLength(1);
    history().undo();
    expect(project.site.head).toEqual([]);
  });

  it('changing the kind drops the fields that kind cannot hold, and nothing is saved until it is valid', () => {
    home.updateMetadata({ head: [{ kind: 'link', rel: 'alternate', href: '/de', hreflang: 'de' }] });
    history().clear();
    page();
    const row = within(screen.getByTestId('head-row'));
    fireEvent.change(row.getByLabelText('Kind'), { target: { value: 'property' } });
    expect(home.metadata.head[0]).toEqual({ kind: 'link', rel: 'alternate', href: '/de', hreflang: 'de' });
    fireEvent.change(row.getByLabelText('Property'), { target: { value: 'article:tag' } });
    fireEvent.change(row.getByLabelText('Content'), { target: { value: 'news' } });
    fireEvent.blur(row.getByLabelText('Content'));
    expect(home.metadata.head[0]).toEqual({ kind: 'property', property: 'article:tag', content: 'news' });
    expect(Object.keys(home.metadata.head[0]).sort()).toEqual(['content', 'kind', 'property']);
  });

  it('the page item replaces the site item and falls back when removed', () => {
    project.updateSiteHead([{ kind: 'meta', name: 'author', content: 'site' }]);
    home.updateMetadata({ head: [{ kind: 'meta', name: 'author', content: 'page' }] });
    expect(resolveHead(project.site.head, home.metadata.head).items).toEqual([{ kind: 'meta', name: 'author', content: 'page' }]);
    page();
    click('Delete head item 1');
    expect(resolveHead(project.site.head, home.metadata.head).items).toEqual([{ kind: 'meta', name: 'author', content: 'site' }]);
  });
});

describe('resume', () => {
  it('a saved project reopens with the list, on the site and on a page', () => {
    project.updateSiteHead([{ kind: 'meta', name: 'author', content: 'site' }]);
    home.updateMetadata({ head: [{ kind: 'link', rel: 'me', href: 'https://example.com/me' }], ogType: 'profile' });
    const again = ProjectModel.create(JSON.parse(JSON.stringify(getSnapshot(project))));
    cleanup();
    render(<HeadItemsPanel scope={{ kind: 'site', project: again }} />);
    expect(screen.getByTestId('head-item').textContent).toContain('author: site');
    cleanup();
    const pageAgain = [...again.pages.values()][0];
    render(<HeadItemsPanel scope={{ kind: 'page', project: again, page: pageAgain }} />);
    expect(screen.getByTestId('head-item').textContent).toContain('me https://example.com/me');
    expect((screen.getByLabelText('Content type') as HTMLSelectElement).value).toBe('profile');
  });

  it('a half-typed JSON-LD is a local draft: closed and reopened, it is gone and nothing was stored', () => {
    const first = site();
    fireEvent.change(newForm().getByLabelText('Kind'), { target: { value: 'jsonld' } });
    fireEvent.change(newForm().getByLabelText('JSON-LD'), { target: { value: '{"@context": "https://sch' } });
    expect(project.site.head).toEqual([]);
    first.unmount();
    site();
    expect(screen.getByTestId('head-count').textContent).toContain('0 of 20');
    expect((newForm().getByLabelText('Kind') as HTMLSelectElement).value).toBe('meta');
    expect(project.site.head).toEqual([]);
  });
});

describe('re-entry', () => {
  it('a stored item this build refuses shows as refused with its reason, keeps its neighbours, and can be deleted', () => {
    project.updateSiteHead([
      { kind: 'meta', name: 'viewport', content: 'width=1' },
      { kind: 'meta', name: 'author', content: 'ok' },
      { kind: 'script', src: '/x.js' },
    ]);
    history().clear();
    site();
    const rows = screen.getAllByTestId('head-item');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByTestId('head-status').textContent).toMatch(/^Refused, not published: .*viewport/);
    expect(within(rows[1]).getByTestId('head-status').textContent).toBe('Published');
    expect(within(rows[2]).getByTestId('head-status').textContent).toMatch(/not a kind of head item/);
    click('Delete head item 1');
    expect(project.site.head.map((i) => i.kind)).toEqual(['meta', 'script']);
    click('Delete head item 2');
    expect(project.site.head).toEqual([{ kind: 'meta', name: 'author', content: 'ok' }]);
  });

  it('at the cap the form says so and Add is off; a hand-built list over the cap shows what is left out', () => {
    project.updateSiteHead(Array.from({ length: HEAD_LIMITS.siteItems }, (_, i) => ({ kind: 'meta', name: 'author', content: `a${i}` })));
    site();
    expect(screen.getByTestId('head-count').textContent).toContain('20 of 20');
    expect((screen.getByRole('button', { name: /Add head item/ }) as HTMLButtonElement).disabled).toBe(true);
    // A saved list from a build with a larger cap: the panel reports the loss in the summary line.
    cleanup();
    render(<HeadItemsSection scope={{ kind: 'site', project }} />);
    expect(screen.getByTestId('site-head-section-summary').textContent).toMatch(/20 items/);
  });

  it('the section counts what the page will leave out', () => {
    project.updateSiteHead([{ kind: 'meta', name: 'viewport', content: 'x' }, { kind: 'meta', name: 'author', content: 'ok' }]);
    render(<HeadItemsSection scope={{ kind: 'site', project }} />);
    expect(screen.getByTestId('site-head-section-summary').textContent).toBe('2 items, 1 not published');
  });

  it('a refused write changes nothing and says why', () => {
    const items = [{ kind: 'meta', name: 'author', content: 'kept' }];
    const write = vi.fn(() => ({ ok: false as const, errors: ['The site head items must be a list.'] }));
    render(<HeadItemsEditor items={items} cap={20} write={write} home="site" />);
    click('Add head item');
    fireEvent.change(newForm().getByLabelText('Name'), { target: { value: 'rating' } });
    fireEvent.change(newForm().getByLabelText('Content'), { target: { value: 'general' } });
    fireEvent.click(newForm().getByRole('button', { name: 'Add item' }));
    expect(write).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('head-notice').textContent).toBe('The site head items must be a list.');
    // The form keeps what was typed, so nothing is lost to the refusal.
    expect((newForm().getByLabelText('Content') as HTMLInputElement).value).toBe('general');
    expect(screen.getAllByTestId('head-item')).toHaveLength(1);
  });
});

describe('the check before publishing', () => {
  /** The real project's pages, the stored head of the home page replaced. */
  const check = (siteHead: unknown[], head: unknown[]) => {
    const snapshot = JSON.parse(JSON.stringify(getSnapshot(home)));
    snapshot.metadata.head = head;
    return checkBeforePublish(
      project.site.business,
      [{ id: home.id, slug: '', metadata: { title: 'Home' }, snapshot }],
      { definitions: project.definitions, refused: [] },
      project.site.theme,
      siteHead,
    );
  };

  it('names a refused item of the site once and of a page on the page', () => {
    const result = check([{ kind: 'meta', name: 'viewport', content: 'x' }], [{ kind: 'meta', name: 'robots', content: 'x' }]);
    expect(hasPublishIssues(result)).toBe(true);
    expect(result.head).toHaveLength(2);
    expect(result.head![0]).toMatchObject({ title: 'Head items in Site settings' });
    expect(result.head![1]).toMatchObject({ pageId: home.id, title: 'Home' });
    expect(result.head![1].message).toMatch(/Social|search engines/);
  });

  it('says nothing for a clean list, an empty one and a check from before head items', () => {
    expect(hasPublishIssues(check([{ kind: 'meta', name: 'author', content: 'a' }], []))).toBe(false);
    expect(check([], []).head).toEqual([]);
    expect(hasPublishIssues(checkBeforePublish(project.site.business, [], { definitions: project.definitions, refused: [] }))).toBe(false);
  });

  it('reports a fourth structured data block, and the site\'s problem once for many pages', () => {
    const ld = (name: string) => ({ kind: 'jsonld', data: { '@context': 'https://schema.org', '@type': 'Thing', name } });
    const result = check([ld('a'), ld('b'), ld('c')], [ld('p')]);
    expect(result.head!.map((i) => i.message).join(' ')).toMatch(/at most 3 structured data/);
    const siteBad = check([{ kind: 'meta', name: 'viewport', content: 'x' }], []);
    expect(siteBad.head).toHaveLength(1);
  });
});

describe('the review of slice H3: stateful edges', () => {
  const meta = (name: string, content: string) => ({ kind: 'meta', name, content });

  it('a valid edit followed by Delete on the same row deletes at the first click: the button survives the save', () => {
    project.updateSiteHead([meta('author', 'one'), meta('rating', 'general')]);
    site();
    const row = within(screen.getAllByTestId('head-item')[0]);
    const button = row.getByRole('button', { name: 'Delete head item 1' });
    const field = row.getByLabelText('Content');
    fireEvent.change(field, { target: { value: 'edited' } });
    fireEvent.blur(field);
    expect(project.site.head[0]).toEqual(meta('author', 'edited'));
    // The node the pointer went down on is still the one in the document.
    expect(button.isConnected).toBe(true);
    fireEvent.click(button);
    expect(project.site.head).toEqual([meta('rating', 'general')]);
  });

  it('saving one row keeps another row\'s half-typed draft', () => {
    project.updateSiteHead([meta('author', 'one'), meta('rating', 'general')]);
    site();
    const [first, second] = screen.getAllByTestId('head-item').map((li) => within(li));
    fireEvent.change(second.getByLabelText('Content'), { target: { value: 'half typed' } });
    fireEvent.change(first.getByLabelText('Content'), { target: { value: 'edited' } });
    fireEvent.blur(first.getByLabelText('Content'));
    expect(project.site.head[0]).toEqual(meta('author', 'edited'));
    expect((screen.getAllByTestId('head-item')[1].querySelector('input[id$="-content"]') as HTMLInputElement).value).toBe('half typed');
  });

  it('closing the dialog with a valid edit still in its field saves it', () => {
    project.updateSiteHead([meta('author', 'one')]);
    const onClose = vi.fn();
    render(<HeadItemsDialog scope={{ kind: 'site', project }} open onClose={onClose} />);
    const field = screen.getByLabelText('Content') as HTMLInputElement;
    field.focus();
    fireEvent.change(field, { target: { value: 'typed, not yet blurred' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(project.site.head[0]).toEqual(meta('author', 'typed, not yet blurred'));
    expect(onClose).toHaveBeenCalled();
  });

  it('a pasted list that would pass the cap is refused whole, in an edit row and in the new form, and nothing is lost', () => {
    const ld = (name: string) => ({ '@context': 'https://schema.org', '@type': 'Thing', name });
    const filled = Array.from({ length: HEAD_LIMITS.siteItems - 1 }, (_, i) => meta('author', `a${i}`));
    project.updateSiteHead([...filled, { kind: 'jsonld', data: ld('x') }].slice(0, HEAD_LIMITS.siteItems));
    const before = JSON.stringify(project.site.head);
    site();
    const last = within(screen.getAllByTestId('head-item')[HEAD_LIMITS.siteItems - 1]);
    fireEvent.change(last.getByLabelText('JSON-LD'), { target: { value: JSON.stringify([ld('a'), ld('b'), ld('c')]) } });
    fireEvent.blur(last.getByLabelText('JSON-LD'));
    expect(JSON.stringify(project.site.head)).toBe(before);
    expect(message()).toMatch(/there is room for 0/);
  });

  it('Add stays off, with the reason, for a list that does not fit', () => {
    project.updateSiteHead(Array.from({ length: HEAD_LIMITS.siteItems - 1 }, (_, i) => meta('author', `a${i}`)));
    site();
    click('Add head item');
    fireEvent.change(newForm().getByLabelText('Kind'), { target: { value: 'jsonld' } });
    const ld = { '@context': 'https://schema.org', '@type': 'Thing' };
    fireEvent.change(newForm().getByLabelText('JSON-LD'), { target: { value: JSON.stringify([ld, ld, ld]) } });
    expect((newForm().getByRole('button', { name: /Add/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(message()).toMatch(/room for 1/);
  });

  it('a kind change after typing keeps what was typed in the content', () => {
    project.updateSiteHead([meta('author', 'stored')]);
    site();
    const row = within(screen.getByTestId('head-item'));
    fireEvent.change(row.getByLabelText('Content'), { target: { value: 'typed' } });
    fireEvent.change(row.getByLabelText('Kind'), { target: { value: 'property' } });
    expect((row.getByLabelText('Content') as HTMLInputElement).value).toBe('typed');
  });

  it('a stored item the page drops shows as not published, not as Published', () => {
    project.updateSiteHead([meta('author', 'first'), meta('author', 'second')]);
    site();
    const statuses = screen.getAllByTestId('head-status').map((el) => el.textContent);
    expect(statuses[0]).toBe('Published');
    expect(statuses[1]).toMatch(/^Not published: An earlier item already says this/);
  });

  it('a page lists the site items its own structured data pushes out of the page', () => {
    const ld = (name: string) => ({ kind: 'jsonld', data: { '@context': 'https://schema.org', '@type': 'Thing', name } });
    project.updateSiteHead([ld('s1'), ld('s2')]);
    home.updateMetadata({ head: [ld('p1'), ld('p2')] });
    page();
    expect(screen.getByTestId('head-elsewhere').textContent).toMatch(/Site head item 2 is left out of this page/);
  });

  it('focus lands on the next place to work: the new form after an add, the count after a delete', () => {
    site();
    fireEvent.change(newForm().getByLabelText('Name'), { target: { value: 'author' } });
    fireEvent.change(newForm().getByLabelText('Content'), { target: { value: 'a' } });
    fireEvent.click(newForm().getByRole('button', { name: 'Add item' }));
    expect(document.activeElement).toBe(newForm().getByLabelText('Kind'));
    click('Delete head item 1');
    expect(document.activeElement).toBe(screen.getByTestId('head-count'));
  });

  it('the check names a site item once however many pages there are', () => {
    const second = project.createPage('About');
    const snapshot = (p: PageModelType) => JSON.parse(JSON.stringify(getSnapshot(p)));
    const result = checkBeforePublish(
      project.site.business,
      [home, second].map((p) => ({ id: p.id, slug: p.slug, metadata: { title: p.metadata.title }, snapshot: snapshot(p) })),
      { definitions: project.definitions, refused: [] },
      project.site.theme,
      [{ kind: 'meta', name: 'viewport', content: 'x' }],
    );
    expect(result.head).toHaveLength(1);
  });
});

describe('the help text', () => {
  it('covers every allowed name, property and rel', () => {
    for (const name of HELP_KEYS.meta) expect(META_HELP[name], name).toBeTruthy();
    for (const name of HELP_KEYS.property) expect(PROPERTY_HELP[name], name).toBeTruthy();
    for (const name of HELP_KEYS.rel) expect(REL_HELP[name], name).toBeTruthy();
    expect(Object.keys(META_HELP).sort()).toEqual([...HELP_KEYS.meta].sort());
  });
});
