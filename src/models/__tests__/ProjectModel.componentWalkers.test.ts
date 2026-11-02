// What the project's own cross-page actions do with reusable components: legal
// facts, legal links in a footer, and links retargeted by "Set as home page".
import { describe, expect, it } from 'vitest';
import { applyPatch, getSnapshot, recordPatches } from 'mobx-state-tree';
import ProjectModel, { type ProjectModelType } from '../ProjectModel';
import type { ComponentInstance } from '../ComponentModel';
import { COOKIE_SETTINGS_HASH } from '@/lib/legal/legalPages';

const UNSPLASH = 'https://images.unsplash.com/photo-1';

const definition = (id: string, tree: Record<string, unknown>, inputs: unknown[] = []) => ({
  id,
  name: id,
  page: {
    id: `${id}-page`,
    slug: '',
    metadata: { title: id },
    appComponentTree: { componentType: 'host', props: {}, ...tree },
    canvasNodes: {},
  },
  inputs,
  states: [],
});

const host = (id: string, type: string, props: Record<string, unknown> = {}, children: unknown[] = []) => ({
  id,
  type,
  componentType: 'host',
  props,
  children,
});

const placement = (id: string, component: string, inputs?: Record<string, unknown>) =>
  host(id, '#component', { component, ...(inputs ? { inputs } : {}) });

const FOOTER = definition('site-footer', host('f-root', 'footer', {}, [host('f-link', 'a', { href: '/kontakt', children: 'Kontakt' })]));

function project(components: Record<string, unknown>): ProjectModelType {
  return ProjectModel.create({ id: 'proj', metadata: { title: 'Bakery' }, pages: {}, components: components as never });
}

const addPage = (p: ProjectModelType, title: string, slug: string, ...children: unknown[]) => {
  const page = p.createPage(title);
  page.setSlug(slug);
  const root = page.appComponentTree as unknown as ComponentInstance;
  const stored = getSnapshot(root) as Record<string, unknown>;
  page.setAppComponentTree({ ...stored, children } as never);
  return page;
};

const hrefsOf = (node: unknown): string[] => {
  const n = node as { props?: { href?: string }; children?: unknown[] };
  return [...(n.props?.href ? [n.props.href] : []), ...(n.children ?? []).flatMap(hrefsOf)];
};
const definitionHrefs = (p: ProjectModelType, id: string) => hrefsOf(getSnapshot(p.components.get(id)!.page.appComponentTree));

describe('createLegalPage, with components', () => {
  it('mentions a form that only a definition holds', () => {
    const p = project({ contact: definition('contact', host('c', 'form', { 'data-form-kind': 'form' })) });
    addPage(p, 'Home', '', placement('p1', 'contact'));
    const { page } = p.createLegalPage('privacy');
    expect(JSON.stringify(getSnapshot(page.appComponentTree))).toMatch(/form/i);
    const without = project({});
    addPage(without, 'Home', '');
    const plain = without.createLegalPage('privacy').page;
    expect(JSON.stringify(getSnapshot(page.appComponentTree)).length)
      .toBeGreaterThan(JSON.stringify(getSnapshot(plain.appComponentTree)).length);
  });

  it('mentions an Unsplash image passed to a placement', () => {
    const hero = definition(
      'hero',
      { ...host('h', 'section', {}, [{ ...host('h-img', 'img'), bindings: { src: { mode: 'read', expression: '{{input.image.src}}' } } }]) },
      [{ id: 'image', name: 'Image', type: 'image', default: { src: '/placeholder.jpg', alt: '' } }],
    );
    const p = project({ hero });
    addPage(p, 'Home', '', placement('p1', 'hero', { image: { src: UNSPLASH, alt: 'A' } }));
    expect(JSON.stringify(getSnapshot(p.createLegalPage('privacy').page.appComponentTree))).toMatch(/Unsplash/);
  });
});

describe('addLegalLinksToFooters, with components', () => {
  it('adds the links to the definition once, for every page placing it', () => {
    const p = project({ 'site-footer': FOOTER });
    const home = addPage(p, 'Home', '', placement('p1', 'site-footer'));
    addPage(p, 'About', 'about', placement('p2', 'site-footer'));
    const result = p.addLegalLinksToFooters();
    expect(result).toEqual({ pagesUpdated: 2, pagesWithoutFooter: 0 });
    expect(definitionHrefs(p, 'site-footer')).toEqual(['/kontakt', COOKIE_SETTINGS_HASH]);
    expect(hrefsOf(getSnapshot(home.appComponentTree))).toEqual([]);
  });

  it('a second run changes nothing', () => {
    const p = project({ 'site-footer': FOOTER });
    addPage(p, 'Home', '', placement('p1', 'site-footer'));
    p.addLegalLinksToFooters();
    const before = definitionHrefs(p, 'site-footer');
    expect(p.addLegalLinksToFooters()).toEqual({ pagesUpdated: 0, pagesWithoutFooter: 0 });
    expect(definitionHrefs(p, 'site-footer')).toEqual(before);
  });

  it('finds a footer through a nested placement', () => {
    const shell = definition('shell', host('s', 'div', {}, [placement('inner', 'site-footer')]));
    const p = project({ shell, 'site-footer': FOOTER });
    addPage(p, 'Home', '', placement('p1', 'shell'));
    expect(p.addLegalLinksToFooters().pagesUpdated).toBe(1);
    expect(definitionHrefs(p, 'site-footer')).toContain(COOKIE_SETTINGS_HASH);
  });

  it('keeps to the last footer of a page when a placement comes before a page footer', () => {
    const p = project({ 'site-footer': FOOTER });
    const home = addPage(p, 'Home', '', placement('p1', 'site-footer'), host('own', 'footer'));
    p.addLegalLinksToFooters();
    expect(hrefsOf(getSnapshot(home.appComponentTree))).toEqual([COOKIE_SETTINGS_HASH]);
    expect(definitionHrefs(p, 'site-footer')).toEqual(['/kontakt']);
  });

  it('gives the links to a footer no page places yet, without counting a page', () => {
    const p = project({ 'site-footer': FOOTER });
    addPage(p, 'Home', '');
    expect(p.addLegalLinksToFooters()).toEqual({ pagesUpdated: 0, pagesWithoutFooter: 1 });
    expect(definitionHrefs(p, 'site-footer')).toContain(COOKIE_SETTINGS_HASH);
  });

  it('does not loop on a cycle in stored data', () => {
    const a = definition('a', host('a-root', 'div', {}, [placement('to-b', 'b')]));
    const b = definition('b', host('b-root', 'div', {}, [placement('to-a', 'a')]));
    const p = project({ a, b });
    addPage(p, 'Home', '', placement('p1', 'a'));
    expect(p.addLegalLinksToFooters()).toEqual({ pagesUpdated: 0, pagesWithoutFooter: 1 });
  });

  it('leaves a placement of nothing as a page without a footer', () => {
    const p = project({});
    addPage(p, 'Home', '', placement('p1', 'gone'));
    expect(p.addLegalLinksToFooters().pagesWithoutFooter).toBe(1);
  });
});

describe('setHomePage, with components', () => {
  const nav = definition(
    'nav',
    host('n', 'nav', {}, [
      host('n-about', 'a', { href: '/about', children: 'About' }),
      host('n-team', 'a', { href: '/about#team', children: 'Team' }),
      host('n-other', 'a', { href: '/about-us', children: 'Other' }),
    ]),
    [
      { id: 'cta', name: 'Call to action', type: 'link', default: '/about?x=1' },
      { id: 'label', name: 'Label', type: 'text', default: '/about' },
    ],
  );

  const setup = () => {
    const p = project({ nav, shell: definition('shell', host('s', 'div', {}, [placement('inner', 'nav', { cta: '/about' })])) });
    addPage(p, 'Home', '', placement('p1', 'nav', { cta: '/about#x', label: '/about' }));
    const about = addPage(p, 'About', 'about');
    return { p, about };
  };

  it('retargets links inside a definition', () => {
    const { p, about } = setup();
    p.setHomePage(about.id);
    expect(definitionHrefs(p, 'nav')).toEqual(['/', '/#team', '/about-us']);
  });

  it('retargets a link input default, and leaves another type alone', () => {
    const { p, about } = setup();
    p.setHomePage(about.id);
    expect(p.components.get('nav')!.inputs.map(input => input.default)).toEqual(['/?x=1', '/about']);
  });

  it('retargets a link value on a placement, on a page and inside a definition', () => {
    const { p, about } = setup();
    const home = p.homePage!;
    p.setHomePage(about.id);
    const pageTree = getSnapshot(p.getPage(home.id)!.appComponentTree) as { children: { props: { inputs: unknown } }[] };
    expect(pageTree.children[0].props.inputs).toEqual({ cta: '/#x', label: '/about' });
    const shell = getSnapshot(p.components.get('shell')!.page.appComponentTree) as { children: { props: { inputs: unknown } }[] };
    expect(shell.children[0].props.inputs).toEqual({ cta: '/' });
  });

  it('undoes as one, by the patches of the one action', () => {
    const { p, about } = setup();
    const before = JSON.stringify(getSnapshot(p.components));
    const recorder = recordPatches(p);
    p.setHomePage(about.id);
    recorder.stop();
    expect(JSON.stringify(getSnapshot(p.components))).not.toBe(before);
    applyPatch(p, [...recorder.inversePatches].reverse());
    expect(JSON.stringify(getSnapshot(p.components))).toBe(before);
  });
});
