// The readers of raw snapshots. Each one is tested with the fact inside a definition
// and with the fact in a value passed to a placement, since "expand first" alone
// would not reach a value: inputs stay bindings until hydration.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishedPageRow } from '@/server/sites/publicResolver';
import { checkBeforePublish, hasPublishIssues, type PublishCheckPage } from '@/lib/legal/publishCheck';
import { factsFromTrees } from '@/lib/legal/templates';
import { literalPageTree } from '@/lib/renderer/server/snapshotToComponentNode';
import { dynamicPagePlan } from '@/lib/site/siteFiles';
import { DEFAULT_LOOK, siteLookFromPages } from '@/lib/site/notFoundDefault';
import { normalizeSiteSettings } from '@/lib/site/siteSettings';
import { treePlaceholders } from '@/components/site/LegalTemplateNotice';
import { parseComponents, type ComponentDefinitions } from '../definition';
import { resetExpandedPages } from '../expandedPages';
import { COMPONENT_LIMITS } from '../placement';

type Node = Record<string, unknown>;

const UNSPLASH = 'https://images.unsplash.com/photo-1';
const read = (expression: string) => ({ mode: 'read', expression });

const definitions = (stored: Record<string, Node>): ComponentDefinitions =>
  parseComponents(
    Object.fromEntries(
      Object.entries(stored).map(([id, extra]) => [
        id,
        {
          id,
          name: id,
          inputs: [],
          states: [],
          ...extra,
          page: { appComponentTree: extra.tree, canvasNodes: {} },
        },
      ]),
    ),
  ).definitions;

const placement = (id: string, component: string, extra: Node = {}): Node => ({
  id,
  type: '#component',
  componentType: 'host',
  props: { component },
  ...extra,
});

const pageOf = (...children: Node[]): Node => ({ id: 'root', type: 'div', props: {}, children });
const row = (pageId: string, slug: string, tree: Node): PublishedPageRow =>
  ({ pageId, slug, snapshot: { slug, appComponentTree: tree, canvasNodes: {} } }) as unknown as PublishedPageRow;
const facts = (tree: Node, stored: ComponentDefinitions) =>
  factsFromTrees([literalPageTree({ appComponentTree: tree as never }, stored).root as never], false);

const HERO = definitions({
  hero: {
    inputs: [{ id: 'image', name: 'Image', type: 'image', default: { src: '/placeholder.jpg', alt: '' } }],
    tree: { id: 'hero-root', type: 'section', props: {}, children: [
      { id: 'hero-img', type: 'img', props: {}, bindings: { src: read('{{input.image.src}}') } },
    ] },
  },
  stock: { tree: { id: 'stock-root', type: 'img', props: { src: UNSPLASH } } },
  contact: { tree: { id: 'form-root', type: 'form', props: { 'data-form-kind': 'form' } } },
});

beforeEach(() => {
  resetExpandedPages();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('factsFromTrees, on literal trees', () => {
  it('finds an Unsplash image passed to a placement', () => {
    const tree = pageOf(placement('p', 'hero', { props: { component: 'hero', inputs: { image: { src: UNSPLASH, alt: 'A' } } } }));
    expect(facts(tree, HERO).unsplash).toBe(true);
  });

  it('finds an Unsplash image and a form inside a definition', () => {
    expect(facts(pageOf(placement('p', 'stock')), HERO).unsplash).toBe(true);
    expect(facts(pageOf(placement('p', 'contact')), HERO).forms).toBe(true);
  });

  it('reports nothing for the default, or for a value only data can give', () => {
    expect(facts(pageOf(placement('p', 'hero')), HERO).unsplash).toBe(false);
    const bound = placement('p', 'hero', { bindings: { 'input.image': read('{{row.cover}}') } });
    expect(facts(pageOf(bound), HERO).unsplash).toBe(false);
  });
});

describe('dynamicPagePlan', () => {
  const blog = definitions({
    article: {
      tree: { id: 'view', type: 'div', props: { 'data-component-kind': 'record-view' }, bindings: { record: read('col_posts') } },
    },
    picked: {
      inputs: [{ id: 'source', name: 'Source', type: 'text', default: 'col_default' }],
      tree: { id: 'view', type: 'div', props: { 'data-component-kind': 'record-view' }, bindings: { record: read('{{input.source}}') } },
    },
    product: {
      tree: { id: 'detail', type: 'div', props: { 'data-component-kind': 'product-detail' }, bindings: { product: read('{{page.params.handle}}') } },
    },
  });

  it('plans from a record view inside a definition', () => {
    const page = row('p', 'blog/:id', pageOf(placement('a', 'article')));
    expect(dynamicPagePlan({ components: blog }, page)).toEqual({ kind: 'cms-rows', param: 'id', collectionId: 'col_posts' });
  });

  it('plans from a collection id passed to a placement, and from the default', () => {
    const passed = placement('a', 'picked', { props: { component: 'picked', inputs: { source: 'col_given' } } });
    expect(dynamicPagePlan({ components: blog }, row('p', 'blog/:id', pageOf(passed)))).toMatchObject({ collectionId: 'col_given' });
    expect(dynamicPagePlan({ components: blog }, row('p', 'blog/:id', pageOf(placement('a', 'picked'))))).toMatchObject({ collectionId: 'col_default' });
  });

  it('plans from a product detail inside a definition', () => {
    const page = row('p', 'shop/:handle', pageOf(placement('a', 'product')));
    expect(dynamicPagePlan({ components: blog }, page)).toEqual({ kind: 'commerce-products', param: 'handle' });
  });

  it('leaves a page out when the collection comes from data', () => {
    const bound = placement('a', 'picked', { bindings: { 'input.source': read('{{row.source}}') } });
    expect(dynamicPagePlan({ components: blog }, row('p', 'blog/:id', pageOf(bound)))).toBeNull();
  });
});

describe('siteLookFromPages', () => {
  const buttons = definitions({
    solid: { tree: { id: 'b', type: 'button', props: { style: { backgroundColor: '#123456', color: '#fedcba' } } } },
    tinted: {
      inputs: [{ id: 'tint', name: 'Tint', type: 'color', default: '#000001' }],
      tree: { id: 'b', type: 'a', props: { style: {} }, bindings: { 'style.backgroundColor': read('{{input.tint}}') } },
    },
  });

  it('reads the first filled button inside a definition', () => {
    const look = siteLookFromPages({ components: buttons, pages: [row('p', '', pageOf(placement('a', 'solid')))] });
    expect(look).toMatchObject({ accent: '#123456', accentText: '#fedcba' });
  });

  it('reads a colour passed to a placement', () => {
    const passed = placement('a', 'tinted', { props: { component: 'tinted', inputs: { tint: '#654321' } } });
    expect(siteLookFromPages({ components: buttons, pages: [row('p', '', pageOf(passed))] }).accent).toBe('#654321');
  });

  it('keeps the default when a placement renders nothing', () => {
    const look = siteLookFromPages({ components: {}, pages: [row('p', '', pageOf(placement('a', 'solid')))] });
    expect(look).toEqual(DEFAULT_LOOK);
  });
});

describe('treePlaceholders, on literal trees', () => {
  const legal = definitions({
    notice: {
      inputs: [{ id: 'who', name: 'Who', type: 'text', default: 'Bakery' }],
      tree: { id: 'n', type: 'div', props: {}, children: [
        { id: 'fixed', type: 'p', props: { children: '[Rechtsform]' } },
        { id: 'bound', type: 'p', props: { children: 'x' }, bindings: { children: read('{{input.who}}') } },
      ] },
    },
  });

  it('counts one inside a definition', () => {
    const { root } = literalPageTree({ appComponentTree: pageOf(placement('p', 'notice')) as never }, legal);
    expect(treePlaceholders(root as never)).toEqual(['[Rechtsform]']);
  });

  it('counts one passed to a placement', () => {
    const passed = placement('p', 'notice', { props: { component: 'notice', inputs: { who: '[Firma]' } } });
    const { root } = literalPageTree({ appComponentTree: pageOf(passed) as never }, legal);
    expect(treePlaceholders(root as never).sort()).toEqual(['[Firma]', '[Rechtsform]']);
  });
});

describe('checkBeforePublish', () => {
  const business = normalizeSiteSettings({}).business;
  const page = (id: string, tree: Node, legalTemplate?: string): PublishCheckPage => ({
    id,
    slug: legalTemplate ?? id,
    metadata: { title: `Page ${id}`, ...(legalTemplate ? { legalTemplate } : {}) },
    snapshot: { appComponentTree: tree as never, canvasNodes: {} },
  });
  const check = (pages: PublishCheckPage[], stored: ComponentDefinitions, refused: { id: string; reason: string }[] = []) =>
    checkBeforePublish(business, pages, { definitions: stored, refused });

  const legal = definitions({
    notice: {
      inputs: [{ id: 'who', name: 'Who', type: 'text' }],
      tree: { id: 'n', type: 'p', props: { children: 'x' }, bindings: { children: read('{{input.who}}') } },
    },
    fixed: { tree: { id: 'n', type: 'p', props: { children: '[Rechtsform]' } } },
  });

  it('is quiet for a site with nothing to say', () => {
    const result = check([page('home', pageOf(placement('p', 'fixed')))], legal);
    expect(result.components).toEqual([]);
    expect(hasPublishIssues(result)).toBe(false);
  });

  it('counts a placeholder inside a definition and one passed to a placement', () => {
    const passed = placement('b', 'notice', { props: { component: 'notice', inputs: { who: '[Firma]' } } });
    const result = check([page('imp', pageOf(placement('a', 'fixed'), passed), 'impressum')], legal);
    expect(result.placeholders).toMatchObject([{ kind: 'impressum', pageId: 'imp', count: 2 }]);
  });

  it('lists a placement with no definition, against the page holding it', () => {
    const result = check([page('home', pageOf(placement('p', 'gone')))], {});
    expect(result.components).toEqual([{ pageId: 'home', title: 'Page home', message: expect.stringMatching(/no longer exists/) }]);
    expect(hasPublishIssues(result)).toBe(true);
  });

  it('lists a definition that could not be read, and its placement', () => {
    const result = check([page('home', pageOf(placement('p', 'broken')))], {}, [{ id: 'broken', reason: 'a definition has a name' }]);
    expect(result.components).toHaveLength(2);
    expect(result.components[0]).toEqual({ title: 'broken', message: expect.stringMatching(/cannot be read.*a definition has a name/) });
    expect(result.components[0].pageId).toBeUndefined();
  });

  it('lists a cycle', () => {
    const cyclic = definitions({
      a: { tree: { id: 'a', type: 'div', props: {}, children: [placement('to-b', 'b')] } },
      b: { tree: { id: 'b', type: 'div', props: {}, children: [placement('to-a', 'a')] } },
    });
    expect(check([page('home', pageOf(placement('p', 'a')))], cyclic).components[0].message).toMatch(/contains itself/);
  });

  it('lists a nesting too deep', () => {
    const levels = COMPONENT_LIMITS.nestingDepth + 1;
    const deep = definitions(
      Object.fromEntries(
        Array.from({ length: levels }, (_, level) => [
          `d${level}`,
          {
            tree: {
              id: `n${level}`,
              type: 'div',
              props: {},
              children: level + 1 < levels ? [placement(`p${level}`, `d${level + 1}`)] : [],
            },
          },
        ]),
      ),
    );
    expect(check([page('home', pageOf(placement('p', 'd0')))], deep).components[0].message).toMatch(/nested too deeply/);
  });

  it('lists a budget overrun', () => {
    const wide = definitions({
      block: {
        tree: { id: 'b', type: 'div', props: {}, children: Array.from({ length: 1000 }, (_, i) => ({ id: `c${i}`, type: 'p', props: {} })) },
      },
    });
    const tree = pageOf(...Array.from({ length: 6 }, (_, i) => placement(`p${i}`, 'block')));
    expect(check([page('home', tree)], wide).components[0].message).toMatch(/too much component content/);
  });

  it('names each kind once per page, however many placements fail', () => {
    const result = check([page('home', pageOf(placement('a', 'gone'), placement('b', 'gone'), placement('c', 'other')))], {});
    expect(result.components).toHaveLength(1);
  });
});
