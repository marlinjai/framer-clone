// @vitest-environment node
//
// The deletePage operation against a real ProjectModel (no database), across the
// four paths of a stateful flow (knowledge-base/standards/stateful-flow-testing.md):
//   forward: a page goes, the 404 setting that named it is cleared, the answer
//     counts the links that still lead to it;
//   backtrack: a page created and deleted in one batch leaves nothing; a page
//     deleted and created again with the same slug comes back as a new page;
//   re-entry: a refused delete (home page, last page, unknown page, a component's
//     page, a later refused operation) leaves the project byte for byte as it was,
//     and the same project then takes a valid delete.
// (Resume, an open editor on the deleted page, is in src/stores/__tests__/adoptServerCopy.test.ts.)
// The refusals are the editor's own (ProjectModel.pageDeleteRefusal, used by the Pages panel).

import { describe, expect, it } from 'vitest';
import { getSnapshot, types } from 'mobx-state-tree';
import ProjectModel, { type ProjectModelType } from '@/models/ProjectModel';
import PageModel from '@/models/PageModel';
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';
import { applyOperations } from '../applyOps';
import { countLinksToPage } from '../pageLinks';

const tree = (rootId: string, children: unknown[] = []) => ({
  id: rootId,
  type: 'div',
  componentType: 'host',
  props: {},
  children: children.map((c) => ({ ...(c as object), parentId: rootId })),
});

const link = (id: string, href: string) => ({ id, type: 'a', componentType: 'host', props: { href, children: 'Link' }, children: [] });

function makeProject(): ProjectModelType {
  return ProjectModel.create({
    id: 'site-del',
    metadata: { title: 'Bakery', description: '', createdAt: 1, updatedAt: 1 },
    pages: {
      home: {
        id: 'home',
        slug: '',
        metadata: { title: 'Home', description: '' },
        appComponentTree: tree('root-home', [
          link('l1', '/about'),
          link('l2', '/About/#team'),
          link('l3', '/about?x=1'),
          link('l4', 'https://elsewhere.example/about'),
          link('l5', '//elsewhere.example/about'),
          link('l6', '/about-us'),
          {
            id: 'form',
            type: 'form',
            componentType: 'host',
            props: { 'data-form-kind': 'form', successBehavior: 'redirect', redirectPageId: 'about' },
            children: [],
          },
        ]),
        canvasNodes: defaultViewportSnapshots(),
      },
      about: {
        id: 'about',
        slug: 'about',
        metadata: { title: 'About', description: '' },
        appComponentTree: tree('root-about'),
        canvasNodes: defaultViewportSnapshots(),
      },
      contact: {
        id: 'contact',
        slug: 'contact',
        metadata: { title: 'Contact', description: '' },
        appComponentTree: tree('root-contact', [link('l7', '/about')]),
        canvasNodes: defaultViewportSnapshots(),
      },
    },
  });
}

const snap = (p: ProjectModelType) => JSON.stringify(getSnapshot(p));

async function refusedOn(project: ProjectModelType, ops: unknown[]) {
  const before = snap(project);
  const outcome = await applyOperations(project, ops);
  expect(outcome.ok).toBe(false);
  expect(snap(project)).toBe(before);
  return outcome.ok ? [] : outcome.rejected;
}

describe('deletePage: forward', () => {
  it('deletes the page and counts the links on the site that still lead to it', async () => {
    const project = makeProject();
    const outcome = await applyOperations(project, [{ op: 'deletePage', pageId: 'about' }]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(project.pages.has('about')).toBe(false);
    expect(project.pages.size).toBe(2);
    // /about, /About/#team, /about?x=1, the form and the link on Contact; never another site or /about-us.
    expect(outcome.summary).toHaveLength(1);
    expect(outcome.summary[0]).toContain('deleted page "About" (/about, about)');
    expect(outcome.summary[0]).toContain('5 link(s) on the site still lead to it');
  });

  it('says so when no link leads to the page', async () => {
    const project = makeProject();
    const outcome = await applyOperations(project, [{ op: 'deletePage', pageId: 'contact' }]);
    expect(outcome.ok && outcome.summary[0]).toContain('no link on the site leads to it');
  });

  it('clears the 404 page setting that named the page, as the editor does', async () => {
    const project = makeProject();
    project.updatePageSettings('about', { title: 'About', slug: 'about', description: '', notFoundPage: true });
    expect(project.site.notFoundPageId).toBe('about');
    const outcome = await applyOperations(project, [{ op: 'deletePage', pageId: 'about' }]);
    expect(outcome.ok).toBe(true);
    expect(project.site.notFoundPageId).toBe('');
    expect(outcome.ok && outcome.summary[0]).toContain('it was the page for unknown addresses');
  });

  it('deletes an extra empty-slug page of an older project, as the editor allows', async () => {
    const project = makeProject();
    project.pages.get('about')!.setSlug('');
    expect(project.pageDeleteRefusal('about')).toBeNull();
    const outcome = await applyOperations(project, [{ op: 'deletePage', pageId: 'about' }]);
    expect(outcome.ok).toBe(true);
    expect(project.pageDeleteRefusal('home')).toBe('home_page');
  });

  it('leaves component definitions and the theme untouched', async () => {
    const project = makeProject();
    const before = getSnapshot(project);
    await applyOperations(project, [{ op: 'deletePage', pageId: 'contact' }]);
    const after = getSnapshot(project);
    expect(after.components).toEqual(before.components);
    expect(after.pages.home).toEqual(before.pages.home);
  });
});

describe('deletePage: backtrack', () => {
  it('a page created, filled and deleted in one batch leaves the project as it was apart from the timestamp', async () => {
    const project = makeProject();
    const pagesBefore = JSON.stringify(getSnapshot(project).pages);
    const outcome = await applyOperations(project, [
      { op: 'createPage', title: 'Scratch', slug: 'scratch', ref: 'scratch' },
      { op: 'insertNodes', pageId: 'ref:scratch', nodes: [{ ref: 'hero', type: 'section', children: [{ type: 'h1', props: { children: 'Hi' } }] }] },
      { op: 'deletePage', pageId: 'ref:scratch' },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(JSON.stringify(getSnapshot(project).pages)).toBe(pagesBefore);
    expect(outcome.summary[2]).toContain('deleted page "Scratch" (/scratch');
    // A later operation naming the deleted page is refused, and the whole batch with it.
    const again = await refusedOn(project, [
      { op: 'createPage', title: 'Scratch', ref: 's' },
      { op: 'deletePage', pageId: 'ref:s' },
      { op: 'insertNodes', pageId: 'ref:s', nodes: [{ type: 'p', props: { children: 'x' } }] },
    ]);
    expect(again[0]).toMatchObject({ index: 2, op: 'insertNodes' });
    expect(again[0].reason).toContain('unknown page id');
  });

  it('a page deleted and created again with the same slug comes back as a new page at that address', async () => {
    const project = makeProject();
    const outcome = await applyOperations(project, [
      { op: 'deletePage', pageId: 'about' },
      { op: 'createPage', title: 'About', slug: 'about', ref: 'again' },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const fresh = project.pages.get(outcome.created.again)!;
    expect(fresh.slug).toBe('about');
    expect(fresh.id).not.toBe('about');
    expect(project.pages.has('about')).toBe(false);
  });
});

describe('deletePage: refusals write nothing (re-entry)', () => {
  it('refuses the home page with the way forward', async () => {
    const rejected = await refusedOn(makeProject(), [{ op: 'deletePage', pageId: 'home' }]);
    expect(rejected[0]).toMatchObject({ index: 0, op: 'deletePage' });
    expect(rejected[0].reason).toContain('the home page cannot be deleted');
  });

  it('refuses the last page', async () => {
    const project = ProjectModel.create({
      id: 'site-one',
      metadata: { title: 'One', description: '', createdAt: 1, updatedAt: 1 },
      pages: { only: { id: 'only', slug: 'only', metadata: { title: 'Only', description: '' }, appComponentTree: tree('r'), canvasNodes: defaultViewportSnapshots() } },
    });
    const rejected = await refusedOn(project, [{ op: 'deletePage', pageId: 'only' }]);
    expect(rejected[0].reason).toContain('the last page of a site cannot be deleted');
  });

  it('refuses the last page left after earlier deletes of the same batch', async () => {
    const project = makeProject();
    const rejected = await refusedOn(project, [
      { op: 'deletePage', pageId: 'about' },
      { op: 'deletePage', pageId: 'contact' },
      { op: 'deletePage', pageId: 'home' },
    ]);
    expect(rejected[0]).toMatchObject({ index: 2 });
    expect(rejected[0].reason).toMatch(/last page|home page/);
    expect(project.pages.size).toBe(3);
  });

  it('refuses an unknown page, an unknown ref and a component definition page', async () => {
    const project = makeProject();
    expect((await refusedOn(project, [{ op: 'deletePage', pageId: 'nope' }]))[0].reason).toContain('unknown page id "nope"');
    expect((await refusedOn(project, [{ op: 'deletePage', pageId: 'ref:nope' }]))[0].reason).toContain('names no ref');
    const made = project.createComponentFromSelection('home', ['l6'], 'Link');
    if (!made.ok) throw new Error(made.message);
    const definition = project.components.get(made.definitionId)!;
    const rejected = await refusedOn(project, [{ op: 'deletePage', pageId: definition.page.id }]);
    expect(rejected[0].reason).toContain('unknown page id');
  });

  it('a delete followed by a refused operation is taken back whole', async () => {
    const project = makeProject();
    const rejected = await refusedOn(project, [
      { op: 'deletePage', pageId: 'about' },
      { op: 'updateText', nodeId: 'missing', text: 'x' },
    ]);
    expect(rejected[0]).toMatchObject({ index: 1, op: 'updateText' });
    expect(project.pages.has('about')).toBe(true);
  });

  it('after a refusal the same project takes a valid delete', async () => {
    const project = makeProject();
    await refusedOn(project, [{ op: 'deletePage', pageId: 'home' }]);
    const outcome = await applyOperations(project, [{ op: 'deletePage', pageId: 'about' }]);
    expect(outcome.ok).toBe(true);
    expect(project.pages.has('about')).toBe(false);
  });

  it('refuses a malformed operation by its shape', async () => {
    const rejected = await refusedOn(makeProject(), [{ op: 'deletePage' }, { op: 'deletePage', pageId: 'about', extra: 1 }]);
    expect(rejected.map((r) => r.index)).toEqual([0, 1]);
  });
});

describe('deletePage: what the answer and the outcome say', () => {
  it('leaves a page, and the nodes on it, that the batch deleted out of created, and reports the deleted page', async () => {
    const project = makeProject();
    const outcome = await applyOperations(project, [
      { op: 'createPage', title: 'Scratch', ref: 'scratch' },
      { op: 'insertNodes', pageId: 'ref:scratch', nodes: [{ ref: 'hero', type: 'section' }] },
      { op: 'insertNodes', pageId: 'home', nodes: [{ ref: 'kept', type: 'section' }] },
      { op: 'deletePage', pageId: 'ref:scratch' },
      { op: 'deletePage', pageId: 'contact' },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(Object.keys(outcome.created)).toEqual(['kept']);
    expect(outcome.deletedPages.map(({ index, slug, title }) => ({ index, slug, title }))).toEqual([
      { index: 3, slug: 'scratch', title: 'Scratch' },
      { index: 4, slug: 'contact', title: 'Contact' },
    ]);
    expect(outcome.deletedPages[1].pageId).toBe('contact');
  });

  it('says when the deleted page was the product page, and which product page takes over', async () => {
    const project = makeProject();
    project.updatePageSettings('about', { title: 'Product', slug: 'products/:handle', description: '' });
    project.updatePageSettings('contact', { title: 'Shop item', slug: 'shop/:handle', description: '' });
    const first = await applyOperations(project, [{ op: 'deletePage', pageId: 'about' }]);
    expect(first.ok && first.summary[0]).toContain('it was the product page; product links now open /shop/<handle>');
    expect(first.ok && first.summary[0]).toContain('1 link(s) on the site still lead to it');
    const second = await applyOperations(project, [{ op: 'createPage', title: 'Extra' }, { op: 'deletePage', pageId: 'contact' }]);
    expect(second.ok && second.summary[1]).toContain('no longer open a product');
    expect(second.ok && second.summary[1]).toContain('no other link (a page link or a form) leads to it');
    expect(second.ok && second.summary[1]).not.toContain('no link on the site leads to it');
  });

  it('a page whose slug only looks like a product path is not the product page', async () => {
    const project = makeProject();
    project.updatePageSettings('about', { title: 'Products', slug: 'products/list', description: '' });
    const outcome = await applyOperations(project, [{ op: 'deletePage', pageId: 'about' }]);
    expect(outcome.ok && outcome.summary[0]).not.toContain('product page');
  });
});

describe('deletePage: two home pages', () => {
  it('deletes one of two empty-slug pages and refuses the second in the same batch', async () => {
    const project = makeProject();
    project.pages.get('about')!.setSlug('');
    const rejected = await refusedOn(project, [
      { op: 'deletePage', pageId: 'about' },
      { op: 'deletePage', pageId: 'home' },
    ]);
    expect(rejected[0]).toMatchObject({ index: 1 });
    expect(rejected[0].reason).toContain('the home page cannot be deleted');
    const outcome = await applyOperations(project, [
      { op: 'insertNodes', pageId: 'contact', nodes: [{ type: 'a', props: { href: '/', children: 'Home' } }, { type: 'a', props: { href: '/#top', children: 'Top' } }] },
      { op: 'deletePage', pageId: 'about' },
    ]);
    // Links to / still reach the remaining home page: only the form that sends visitors to this page counts.
    expect(outcome.ok && outcome.summary[1]).toContain('1 link(s) on the site still lead to it');
  });
});

describe('a refused batch on a project inside an editor store', () => {
  it('keeps the references the store holds to its pages (the order is not restored there)', async () => {
    const Holder = types.model('Holder', { project: ProjectModel, current: types.maybe(types.safeReference(PageModel)) });
    const holder = Holder.create({ project: getSnapshot(makeProject()), current: 'about' });
    const rejected = await applyOperations(holder.project, [
      { op: 'deletePage', pageId: 'about' },
      { op: 'updateText', nodeId: 'missing', text: 'x' },
    ]);
    expect(rejected.ok).toBe(false);
    expect(holder.project.pages.has('about')).toBe(true);
    // The take-back recreated the page; a page that was not moved keeps its reference.
    const Holder2 = types.model('Holder2', { project: ProjectModel, current: types.maybe(types.safeReference(PageModel)) });
    const h2 = Holder2.create({ project: getSnapshot(makeProject()), current: 'contact' });
    await applyOperations(h2.project, [{ op: 'deletePage', pageId: 'about' }, { op: 'updateText', nodeId: 'missing', text: 'x' }]);
    expect(h2.current?.id).toBe('contact');
    expect(Array.from(h2.project.pages.keys())).toEqual(['home', 'contact', 'about']);
  });
});

describe('ProjectModel.restorePageOrder', () => {
  it('puts the pages back in the given order, keeping the same page nodes', () => {
    const project = makeProject();
    const about = project.pages.get('about')!;
    project.restorePageOrder(['contact', 'about', 'home']);
    expect(Array.from(project.pages.keys())).toEqual(['contact', 'about', 'home']);
    expect(project.pages.get('about')).toBe(about);
    project.restorePageOrder(['home', 'nope', 'about', 'contact']);
    expect(Array.from(project.pages.keys())).toEqual(['home', 'about', 'contact']);
    const before = snap(project);
    project.restorePageOrder(['home', 'about', 'contact']);
    expect(snap(project)).toBe(before);
  });
});

describe('countLinksToPage', () => {
  it('counts a form whose page id carries whitespace, as the form settings read it', () => {
    const trees = [tree('r', [{ id: 'f', type: 'form', componentType: 'host', props: { successBehavior: 'redirect', redirectPageId: ' p ' }, children: [] }])];
    expect(countLinksToPage(trees, { pageId: 'p', slug: 'thanks' })).toBe(1);
  });

  it('counts nothing but forms for a dynamic page', () => {
    const trees = [
      tree('r', [
        link('a', '/products/:handle'),
        { id: 'f', type: 'form', componentType: 'host', props: { successBehavior: 'redirect', redirectPageId: 'p' }, children: [] },
        { id: 'g', type: 'form', componentType: 'host', props: { successBehavior: 'message', redirectPageId: 'p' }, children: [] },
      ]),
    ];
    expect(countLinksToPage(trees, { pageId: 'p', slug: 'products/:handle' })).toBe(1);
  });

  it('matches a percent-encoded address and ignores a malformed one', () => {
    const trees = [tree('r', [link('a', '/%C3%BCber'), link('b', '/über'), link('c', '/%E0%A4%A')])];
    expect(countLinksToPage(trees, { pageId: 'p', slug: 'über' })).toBe(2);
  });
});
