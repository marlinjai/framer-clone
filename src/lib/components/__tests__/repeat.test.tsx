// A node repeated once per item of a `list` or `gallery` input, from a stored
// definition to the published markup: real parser, hydrator, stylesheet pass and
// React. Also the raw readers' literal mode, Detach, and the pure helpers.

import React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CmsReadRepository } from '@/server/cms';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { hydrateBindings } from '@/lib/renderer/publish/hydrateBindings';
import { applyResponsiveStyles } from '@/lib/renderer/server/applyResponsiveStyles';
import { renderComponentNode } from '@/lib/renderer/server/renderComponentNode';
import { componentSnapshotToNode } from '@/lib/renderer/server/componentSnapshot';
import { BREAKPOINTS } from '../../../../test/score/lib/published';
import { parseComponents, type ComponentDefinitions } from '../definition';
import { createRenderBudget, expandPlacements } from '../expand';
import { detachedTree } from '../detach';
import { itemChoicesFor, itemPathType, repeatedCopies, withItemBindingsChecked } from '../repeat';
import type { InputDefinition } from '../inputs';

type Node = Record<string, unknown>;
const read = (expression: string) => ({ mode: 'read', expression });
const frames = {
  a: { id: 'a', canvasNodeType: 'viewport', breakpointId: 'd-desktop', breakpointMinWidth: 1280 },
  c: { id: 'c', canvasNodeType: 'viewport', breakpointId: 'd-mobile', breakpointMinWidth: 320 },
};
const definition = (id: string, tree: Node, inputs: unknown[] = []) => ({ id, name: id, page: { appComponentTree: tree, canvasNodes: frames }, inputs, states: [] });
const definitionsOf = (...stored: ReturnType<typeof definition>[]): ComponentDefinitions =>
  parseComponents(Object.fromEntries(stored.map(d => [d.id, d]))).definitions;
const placement = (id: string, component: string, extra: Node = {}, bindings?: Node) => ({ id, type: '#component', props: { component, ...extra }, ...(bindings ? { bindings } : {}) });
const page = (children: Node[]): ComponentNode => componentSnapshotToNode({ id: 'page', type: 'main', children } as never);
const noCms = { listRows: async () => ({ rows: [] }), getRow: async () => null } as unknown as CmsReadRepository;
const rowsOf = (values: Record<string, unknown>[]) =>
  ({ listRows: async () => ({ rows: values.map((v, i) => ({ id: `r${i}`, values: v })) }), getRow: async () => null }) as unknown as CmsReadRepository;

async function publish(root: ComponentNode, definitions: ComponentDefinitions, cmsRepo = noCms, budget = createRenderBudget()) {
  const expanded = expandPlacements(root, definitions, BREAKPOINTS, { budget });
  const hydrated = await hydrateBindings(expanded, {}, { cmsRepo }, null, budget);
  const { root: styled, css } = applyResponsiveStyles(hydrated, BREAKPOINTS);
  return { tree: hydrated, css, html: renderToStaticMarkup(React.createElement(React.Fragment, null, renderComponentNode(styled))) };
}

const LINKS: InputDefinition = {
  id: 'links', name: 'Links', type: 'list',
  fields: [{ id: 'label', name: 'Label', type: 'text' }, { id: 'to', name: 'To', type: 'link' }],
  default: [{ label: 'Home', to: '/' }],
};
const NAV = definition('nav', {
  id: 'n', type: 'ul', children: [
    { id: 'li', type: 'li', props: { 'data-repeat': 'links', style: { padding: { base: '4px', 'd-mobile': '2px' } } }, children: [
      { id: 'go', type: 'a', props: { children: 'Stored' }, bindings: { children: read('{{item.label}}'), href: read('{{item.to}}') } },
    ] },
  ],
}, [LINKS]);

const ids = (node: ComponentNode): string[] => [node.id ?? '', ...(node.children ?? []).flatMap(ids)];

afterEach(() => vi.restoreAllMocks());

describe('a repeated node on the published page', () => {
  it('is one copy per item, each with its own ids and one shared stylesheet block', async () => {
    const { html, tree, css } = await publish(page([placement('p1', 'nav', { inputs: { links: [{ label: 'One', to: '/one' }, { label: 'Two', to: '/two' }] } })]), definitionsOf(NAV));
    expect(html).toContain('<li class="');
    expect(html).toContain('<a href="/one">One</a>');
    expect(html).toContain('<a href="/two">Two</a>');
    expect(html).not.toContain('data-repeat');
    expect(ids(tree)).toEqual(expect.arrayContaining(['p1__li__0', 'p1__li__1', 'p1__go__0', 'p1__go__1']));
    expect(new Set(ids(tree)).size).toBe(ids(tree).length);
    expect(css.match(/padding:4px/g)).toHaveLength(1);
  });

  it('shows the default items, and nothing for an empty list', async () => {
    const defaults = await publish(page([placement('p1', 'nav')]), definitionsOf(NAV));
    expect(defaults.html).toContain('<a href="/">Home</a>');
    const empty = await publish(page([placement('p1', 'nav', { inputs: { links: [] } })]), definitionsOf(NAV));
    expect(empty.html).toBe('<main><ul></ul></main>');
  });

  it('takes items bound to data, per row of a collection', async () => {
    const collection = {
      id: 'list', type: 'div', props: { 'data-component-kind': 'collection' }, bindings: { collection: read('col') },
      children: [placement('p1', 'nav', {}, { 'input.links': read('{{row.links}}') })],
    };
    const cms = rowsOf([{ links: [{ label: 'A', to: '/a' }] }, { links: [{ label: 'B', to: '/b' }, { label: 'C', to: '/c' }] }]);
    const { html } = await publish(page([collection]), definitionsOf(NAV), cms);
    expect(html.match(/<li/g)).toHaveLength(3);
    expect(html).toContain('<a href="/c">C</a>');
  });

  it('leaves out an item address from a text field, and a value the list refuses whole', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unsafe = definition('u', {
      id: 'n', type: 'div', children: [
        { id: 'go', type: 'a', props: { 'data-repeat': 'links', href: '/kept' }, bindings: { href: read('{{item.label}}'), children: read('{{item.label}}') } },
      ],
    }, [LINKS]);
    const { html } = await publish(page([placement('p1', 'u', { inputs: { links: [{ label: 'javascript:alert(1)' }] } })]), definitionsOf(unsafe));
    expect(html).toBe('<main><div><a href="/kept">javascript:alert(1)</a></div></main>');
    const refused = await publish(page([placement('p1', 'nav', { inputs: { links: [{ to: 'javascript:alert(1)' }] } })]), definitionsOf(NAV));
    expect(refused.html).toContain('<a href="/">Home</a>');
  });

  it('repeats a nested placement, each copy taking its item through its inputs', async () => {
    const badge = definition('badge', { id: 'b', type: 'b', bindings: { children: read('{{input.text}}') } }, [{ id: 'text', name: 'Text', type: 'text' }]);
    const list = definition('tags', {
      id: 't', type: 'p', children: [placement('one', 'badge', { 'data-repeat': 'tags' }, { 'input.text': read('{{item.label}}') })],
    }, [{ id: 'tags', name: 'Tags', type: 'list', fields: [{ id: 'label', name: 'Label', type: 'text' }] }]);
    const { html } = await publish(page([placement('p1', 'tags', { inputs: { tags: [{ label: 'New' }, { label: 'Sale' }] } })]), definitionsOf(badge, list));
    expect(html).toBe('<main><p><b>New</b><b>Sale</b></p></main>');
  });

  it('draws on the budget for every copy past the first', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const budget = createRenderBudget({ nodes: 6, bytes: 4_000_000 });
    const items = Array.from({ length: 20 }, (_, i) => ({ label: `L${i}`, to: `/${i}` }));
    const { html } = await publish(page([placement('p1', 'nav', { inputs: { links: items } })]), definitionsOf(NAV), noCms, budget);
    const shown = html.match(/<li/g)?.length ?? 0;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(20);
    expect(budget.exhausted).toBe(true);
  });

  it('a gallery repeats its images', async () => {
    const gallery = definition('g', {
      id: 'g', type: 'div', children: [{ id: 'pic', type: 'img', props: { 'data-repeat': 'pics' }, bindings: { src: read('{{item.src}}'), alt: read('{{item.alt}}') } }],
    }, [{ id: 'pics', name: 'Pictures', type: 'gallery' }]);
    const { html } = await publish(page([placement('p1', 'g', { inputs: { pics: ['/a.jpg', { src: '/b.jpg', alt: 'B' }] } })]), definitionsOf(gallery));
    expect(html).toContain('src="/a.jpg" alt=""');
    expect(html).toContain('src="/b.jpg" alt="B"');
  });
});

describe('a repeat for the raw readers and Detach', () => {
  it('literal mode writes each literal item in, as the page shows it', () => {
    const expanded = expandPlacements(page([placement('p1', 'nav', { inputs: { links: [{ label: 'One', to: 'https://images.unsplash.com/x' }] } })]), definitionsOf(NAV), BREAKPOINTS, { literalInputs: true });
    const json = JSON.stringify(expanded);
    expect(json).toContain('https://images.unsplash.com/x');
    expect(json).not.toContain('data-repeat');
  });

  it('Detach makes one plain copy per literal item, with its values written in', () => {
    let n = 0;
    const stored = definitionsOf(NAV).nav;
    const tree = detachedTree(placement('p1', 'nav', { inputs: { links: [{ label: 'One', to: '/one' }, { label: 'Two', to: '/two' }] } }) as never, {
      definition: stored, holderBreakpoints: BREAKPOINTS, takenIds: [], newId: () => `n${n++}`,
    } as never)!;
    const items = (tree.children ?? []) as { props: Record<string, unknown>; children: { props: Record<string, unknown>; bindings: Record<string, unknown> }[] }[];
    expect(items).toHaveLength(2);
    expect(items.map(item => item.children[0].props)).toEqual([
      expect.objectContaining({ children: 'One', href: '/one' }),
      expect.objectContaining({ children: 'Two', href: '/two' }),
    ]);
    expect(items.every(item => !('data-repeat' in item.props))).toBe(true);
    expect(items[0].children[0].bindings).toEqual({});
  });
});

describe('the pure helpers', () => {
  it('reads what an item path is', () => {
    expect(itemPathType(LINKS, ['to'])).toBe('link');
    expect(itemPathType(LINKS, ['label'])).toBe('text');
    expect(itemPathType(LINKS, ['nope'])).toBeUndefined();
    const gallery: InputDefinition = { id: 'g', name: 'G', type: 'gallery' };
    expect(itemPathType(gallery, [])).toBe('image');
    expect(itemPathType(gallery, ['src'])).toBe('image');
    expect(itemPathType(gallery, ['alt'])).toBe('text');
  });

  it('offers each slot the item paths it may take', () => {
    expect(itemChoicesFor(LINKS, 'children')).toEqual([
      { label: 'Label', expression: '{{item.label}}' },
      { label: 'To', expression: '{{item.to}}' },
    ]);
    expect(itemChoicesFor(LINKS, 'href')).toEqual([{ label: 'To', expression: '{{item.to}}' }]);
    const gallery: InputDefinition = { id: 'g', name: 'G', type: 'gallery' };
    expect(itemChoicesFor(gallery, 'src')).toEqual([{ label: 'Image', expression: '{{item.src}}' }]);
    expect(itemChoicesFor(gallery, 'alt')).toEqual([{ label: 'Image', expression: '{{item.alt}}' }]);
    expect(itemChoicesFor(gallery, 'href')).toEqual([{ label: 'Image', expression: '{{item.src}}' }]);
  });

  it('makes no copy for a value that is not a list, and at most the limit', () => {
    const node = { id: 'x', type: 'li', props: { 'data-repeat': 'l' } } as ComponentNode;
    expect(repeatedCopies(node, 'nope')).toEqual([]);
    expect(repeatedCopies(node, Array.from({ length: 150 }, () => ({})))).toHaveLength(100);
  });

  it('keeps an item binding to an address only from an address field', () => {
    const warn = vi.fn();
    const tree = { id: 'r', type: 'div', children: [{ id: 'a', type: 'a', props: { 'data-repeat': 'links' }, bindings: { href: read('{{item.label}}'), title: read('{{item.label}}') } }] } as unknown as ComponentNode;
    const checked = withItemBindingsChecked(tree, [LINKS], warn);
    expect(checked.children?.[0].bindings).toEqual({ title: read('{{item.label}}') });
    expect(warn).toHaveBeenCalledOnce();
    const fine = { id: 'r', type: 'div', children: [{ id: 'a', type: 'a', props: { 'data-repeat': 'links' }, bindings: { href: read('{{item.to}}') } }] } as unknown as ComponentNode;
    expect(withItemBindingsChecked(fine, [LINKS], warn)).toBe(fine);
  });
});
