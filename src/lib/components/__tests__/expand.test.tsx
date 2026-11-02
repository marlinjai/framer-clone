// Expansion, from a stored definition to the published markup. Real parser, real
// hydrator, real stylesheet pass, real React; only the CMS rows are fake.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CmsReadRepository } from '@/server/cms';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { hydrateBindings } from '@/lib/renderer/publish/hydrateBindings';
import { applyResponsiveStyles } from '@/lib/renderer/server/applyResponsiveStyles';
import { renderComponentNode } from '@/lib/renderer/server/renderComponentNode';
import { snapshotToComponentNode } from '@/lib/renderer/server/snapshotToComponentNode';
import { componentSnapshotToNode } from '@/lib/renderer/server/componentSnapshot';
import type { BreakpointRef } from '@/lib/responsive/cascade';
import { FIXTURES } from '../../../../test/score/corpus/fixtures';
import { BREAKPOINTS } from '../../../../test/score/lib/published';
import { parseComponents, type ComponentDefinitions } from '../definition';
import { createRenderBudget, expandPlacements } from '../expand';
import { COMPONENT_LIMITS, MISSING_TYPE } from '../placement';

type Node = Record<string, unknown>;

const read = (expression: string) => ({ mode: 'read', expression });

/** The frames a definition is drawn in. Each id differs from every page's, as in a real project. */
const frames = {
  a: { id: 'a', canvasNodeType: 'viewport', breakpointId: 'd-desktop', breakpointMinWidth: 1280 },
  b: { id: 'b', canvasNodeType: 'viewport', breakpointId: 'd-tablet', breakpointMinWidth: 768 },
  c: { id: 'c', canvasNodeType: 'viewport', breakpointId: 'd-mobile', breakpointMinWidth: 320 },
};

const definition = (id: string, tree: Node, extra: Node = {}) => ({
  id,
  name: id,
  page: { appComponentTree: tree, canvasNodes: frames },
  inputs: [],
  states: [],
  ...extra,
});

const definitionsOf = (...stored: ReturnType<typeof definition>[]): ComponentDefinitions =>
  parseComponents(Object.fromEntries(stored.map(d => [d.id, d]))).definitions;

const placement = (id: string, component: string, extra: Node = {}, bindings?: Node) => ({
  id,
  type: '#component',
  props: { component, ...extra },
  ...(bindings ? { bindings } : {}),
});

const page = (children: Node[]): ComponentNode => componentSnapshotToNode({ id: 'page', type: 'main', children } as never);

const CARD = definition(
  'card',
  {
    id: 'c-root',
    type: 'a',
    props: { style: { display: 'block' } },
    bindings: { href: read('{{input.href}}') },
    children: [
      { id: 'c-img', type: 'img', props: {}, bindings: { src: read('{{input.image.src}}'), alt: read('{{input.image.alt}}') } },
      { id: 'c-badge', type: 'span', props: { children: 'New' }, bindings: { visible: read('{{input.badge}}') } },
      { id: 'c-title', type: 'h3', props: { children: 'Stored', style: { color: { base: 'red', 'd-mobile': 'blue' } } }, bindings: { children: read('{{input.title}}') } },
    ],
  },
  {
    inputs: [
      { id: 'title', name: 'Title', type: 'text', default: 'Card title' },
      { id: 'image', name: 'Image', type: 'image', default: { src: '/placeholder.jpg', alt: '' } },
      { id: 'href', name: 'Link', type: 'link', default: '/' },
      { id: 'badge', name: 'Show badge', type: 'toggle', default: false },
    ],
  },
);

const noCms = { listRows: async () => ({ rows: [] }), getRow: async () => null } as unknown as CmsReadRepository;
const rowsOf = (values: Record<string, unknown>[]) =>
  ({ listRows: async () => ({ rows: values.map((v, i) => ({ id: `r${i}`, values: v })) }), getRow: async () => null }) as unknown as CmsReadRepository;

async function publish(
  root: ComponentNode,
  definitions: ComponentDefinitions,
  { breakpoints = BREAKPOINTS as readonly BreakpointRef[], cmsRepo = noCms, budget = createRenderBudget() } = {},
) {
  const expanded = expandPlacements(root, definitions, breakpoints, { budget });
  const hydrated = await hydrateBindings(expanded, {}, { cmsRepo }, null, budget);
  const { root: styled, css } = applyResponsiveStyles(hydrated, breakpoints);
  return {
    tree: hydrated,
    css,
    html: renderToStaticMarkup(React.createElement(React.Fragment, null, renderComponentNode(styled))),
    budget,
  };
}

const collection = (template: Node) => ({
  id: 'list',
  type: 'div',
  props: { 'data-component-kind': 'collection' },
  bindings: { collection: read('col-1') },
  children: [template],
});

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('a page without placements', () => {
  it.each(FIXTURES.map(f => [f.id, f] as const))('%s comes back by reference', (_, fixture) => {
    const tree = fixture.tree();
    expect(expandPlacements(tree, {}, BREAKPOINTS)).toBe(tree);
  });

  it('keeps every row of a plain template larger than the whole budget', async () => {
    const template = { id: 't', type: 'div', children: Array.from({ length: COMPONENT_LIMITS.expandedNodesPerPage + 1 }, (_, i) => ({ id: `n${i}`, type: 'span' })) };
    const rows = Array.from({ length: 20 }, (_, i) => ({ i }));
    const budget = createRenderBudget();
    const hydrated = await hydrateBindings(page([collection(template)]), {}, { cmsRepo: rowsOf(rows) }, null, budget);
    expect(hydrated.children?.[0].children).toHaveLength(20);
    expect(budget.nodes).toBe(0);
    expect(budget.exhausted).toBe(false);
  }, 30_000);

  it('adds nothing to a node: no classKey, no budget', () => {
    const adapted = snapshotToComponentNode({ appComponentTree: { id: 'r', type: 'div', props: { title: 'x' } } } as never, {});
    expect(adapted.root).toEqual({ type: 'div', id: 'r', props: { title: 'x' } });
    expect(adapted.budget.nodes).toBe(0);
  });
});

describe('placements', () => {
  it('three placements with different inputs are three cards', async () => {
    const { html } = await publish(
      page([
        placement('p1', 'card', { inputs: { title: 'One', href: '/one', badge: true, image: { src: '/1.jpg', alt: 'First' } } }),
        placement('p2', 'card', { inputs: { title: 'Two' } }),
        placement('p3', 'card'),
      ]),
      definitionsOf(CARD),
    );
    expect(html).toContain('href="/one"');
    expect(html).toContain('src="/1.jpg"');
    expect(html).toContain('alt="First"');
    expect(html).toContain('>One</h3>');
    expect(html).toContain('>Two</h3>');
    expect(html).toContain('>Card title</h3>');
    expect(html.match(/>New</g)).toHaveLength(1);
    expect(html).not.toContain('instance');
    expect(html).not.toContain('Stored');
  });

  it('gives each node a unique id and a shared class', async () => {
    const { tree, css } = await publish(page([placement('p1', 'card'), placement('p2', 'card'), placement('p3', 'card')]), definitionsOf(CARD));
    const titles = (tree.children ?? []).map(card => card.children?.find(child => child.classKey === 'c-title'));
    expect(titles.map(title => title?.id)).toEqual(['p1__c-title', 'p2__c-title', 'p3__c-title']);
    expect(tree.children?.map(card => card.id)).toEqual(['p1', 'p2', 'p3']);
    expect(css.match(/\.fc-c-title\.fc-c-title\{color:red/g)).toHaveLength(1);
  });

  it('keeps a node with plain styles inline, once per placement, and one class per different value', async () => {
    const { html, css } = await publish(
      page([
        placement('p1', 'card', { style: { width: { base: '1px', mobile: '2px' } } }),
        placement('p2', 'card', { style: { width: { base: '3px', mobile: '4px' } } }),
      ]),
      definitionsOf(CARD),
    );
    expect(css).toContain('fc-c-root--2');
    expect(html).toContain('class="fc-c-root"');
  });

  it('survives a placement of a page node type that never renders', async () => {
    const { html } = await publish(page([placement('p1', 'nope')]), {});
    expect(html).toBe('<main></main>');
  });

  it('hides a binding that fails on the side of showing content', async () => {
    const stored = definition('d', { id: 'r', type: 'div', children: [
      { id: 'x', type: 'span', props: { children: 'kept' }, bindings: { visible: read('{{input.nothing}}') } },
    ] });
    expect((await publish(page([placement('p', 'd')]), definitionsOf(stored))).html).toContain('kept');
  });

  it('reads an input in several slots at once', async () => {
    const stored = definition('d', {
      id: 'r',
      type: 'h1',
      bindings: { children: read('{{input.t}}'), title: read('{{input.t}}'), 'aria-label': read('{{input.t}}') },
    }, { inputs: [{ id: 't', name: 'T', type: 'text' }] });
    const { html } = await publish(page([placement('p', 'd', { inputs: { t: 'Same' } })]), definitionsOf(stored));
    expect(html).toBe('<main><h1 title="Same" aria-label="Same">Same</h1></main>');
  });

  it('leaves a node its stored value for an input with no default', async () => {
    const stored = definition('d', { id: 'r', type: 'h1', props: { children: 'Stored' }, bindings: { children: read('{{input.t}}') } }, {
      inputs: [{ id: 't', name: 'T', type: 'text' }],
    });
    expect((await publish(page([placement('p', 'd')]), definitionsOf(stored))).html).toContain('Stored');
  });

  it('treats a value that does not parse as absent, once per page', async () => {
    const { html, budget } = await publish(
      page([placement('p1', 'card', { inputs: { href: 'javascript:alert(1)' } }), placement('p2', 'card', { inputs: { href: 'javascript:alert(2)' } })]),
      definitionsOf(CARD),
    );
    expect(html).not.toContain('javascript');
    expect(html).toContain('href="/"');
    expect(budget.warnings.size).toBe(1);
  });
});

describe('merging a placement', () => {
  const stored = definition('d', {
    id: 'r',
    type: 'div',
    props: { style: { width: { base: '100%', 'd-mobile': '50%' }, padding: '1px', paddingTop: '2px' }, effects: { hover: 'lift' } },
  });

  it('merges per property and per breakpoint', async () => {
    const { tree } = await publish(page([placement('p', 'd', { style: { width: { base: '300px' } } })]), definitionsOf(stored));
    expect(tree.children?.[0].props?.style).toMatchObject({ width: { base: '300px', mobile: '50%' } });
  });

  it('reads a plain placement value as the base of a map', async () => {
    const { tree } = await publish(page([placement('p', 'd', { style: { width: '300px' } })]), definitionsOf(stored));
    expect((tree.children?.[0].props?.style as Node).width).toEqual({ base: '300px', mobile: '50%' });
  });

  it('lands a placement key last, so a shorthand beats the definition longhand', async () => {
    const { tree } = await publish(page([placement('p', 'd', { style: { padding: '9px' } })]), definitionsOf(stored));
    expect(Object.keys(tree.children?.[0].props?.style as Node)).toEqual(['width', 'paddingTop', 'padding']);
  });

  it('merges effects per group', async () => {
    const adapted = expandPlacements(page([placement('p', 'd', { effects: { appear: { kind: 'fade' } } })]), definitionsOf(stored), BREAKPOINTS);
    expect(adapted.children?.[0].props?.effects).toEqual({ hover: 'lift', appear: { kind: 'fade' } });
  });
});

describe('breakpoints', () => {
  it('rewrites a definition map to the page ids', async () => {
    const { tree } = await publish(page([placement('p', 'card')]), definitionsOf(CARD));
    const title = tree.children?.[0].children?.find(child => child.classKey === 'c-title');
    expect(title?.props?.style).toEqual({ color: { base: 'red', mobile: 'blue' } });
  });

  it('rewrites a responsive default to the page ids', async () => {
    const tinted = definition('tinted', { id: 'r', type: 'div', bindings: { 'style.color': read('{{input.c}}') } }, {
      inputs: [{ id: 'c', name: 'C', type: 'color', default: { base: 'red', 'd-mobile': 'blue' } }],
    });
    const { tree } = await publish(page([placement('p', 'tinted')]), definitionsOf(tinted));
    expect(tree.children?.[0].props?.style).toEqual({ color: { base: 'red', mobile: 'blue' } });
  });

  it('keeps the base on a page with no frames', async () => {
    const { tree, css } = await publish(page([placement('p', 'card')]), definitionsOf(CARD), { breakpoints: [] });
    const title = tree.children?.[0].children?.find(child => child.classKey === 'c-title');
    expect(title?.props?.style).toEqual({ color: { base: 'red' } });
    expect(css).toContain('color:red');
  });

  it('maps a nested placement straight to the page', async () => {
    const outer = definition('outer', { id: 'o', type: 'div', children: [placement('in', 'card', { style: { width: { base: '1px', 'd-tablet': '2px' } } })] });
    const { tree } = await publish(page([placement('p', 'outer')]), definitionsOf(outer, CARD));
    const inner = tree.children?.[0].children?.[0];
    expect(inner?.id).toBe('p__in');
    expect((inner?.props?.style as Node).width).toEqual({ base: '1px', tablet: '2px' });
    expect(inner?.children?.find(child => child.classKey === 'c-title')?.props?.style).toEqual({ color: { base: 'red', mobile: 'blue' } });
  });
});

describe('nesting and refusal', () => {
  const chain = (depth: number) =>
    Array.from({ length: depth }, (_, i) =>
      definition(`d${i}`, { id: `n${i}`, type: 'div', children: i + 1 < depth ? [placement(`in${i}`, `d${i + 1}`)] : [] }));

  it('passes an outer input down, and pushes the inner frame on top', async () => {
    const inner = definition('inner', { id: 'i', type: 'h2', bindings: { children: read('{{input.heading}}') } }, {
      inputs: [{ id: 'heading', name: 'H', type: 'text' }],
    });
    const outer = definition('outer', { id: 'o', type: 'div', bindings: { title: read('{{input.title}}') }, children: [
      placement('in', 'inner', {}, { 'input.heading': read('{{input.title}}') }),
    ] }, { inputs: [{ id: 'title', name: 'T', type: 'text' }] });
    const { html } = await publish(page([placement('p', 'outer', { inputs: { title: 'Down' } })]), definitionsOf(outer, inner));
    expect(html).toBe('<main><div title="Down"><h2>Down</h2></div></main>');
  });

  it('refuses a cycle and still serves the page', async () => {
    const a = definition('a', { id: 'a-r', type: 'div', props: { title: 'a' }, children: [placement('x', 'b')] });
    const b = definition('b', { id: 'b-r', type: 'div', props: { title: 'b' }, children: [placement('y', 'a')] });
    const { html, budget } = await publish(page([placement('p', 'a')]), definitionsOf(a, b));
    expect(html).toBe('<main><div title="a"><div title="b"></div></div></main>');
    expect([...budget.warnings].join()).toMatch(/contains itself: a > b > a/);
  });

  it('allows the eighth level and refuses the ninth', async () => {
    const ok = await publish(page([placement('p', 'd0')]), definitionsOf(...chain(COMPONENT_LIMITS.nestingDepth)));
    expect(ok.budget.warnings.size).toBe(0);
    const over = await publish(page([placement('p', 'd0')]), definitionsOf(...chain(COMPONENT_LIMITS.nestingDepth + 1)));
    expect([...over.budget.warnings].join()).toMatch(/nest more than 8/);
  });

  it('hashes a long path, stably, under the form id cap', () => {
    const uuid = (i: number) => `2f6c1a9e-0000-4000-8000-00000000000${i}`;
    const run = () => {
      const stored = Array.from({ length: 6 }, (_, i) =>
        definition(uuid(i), { id: uuid(i + 1), type: 'div', children: i < 5 ? [placement(uuid(i + 2), uuid(i + 1))] : [{ id: 'leaf', type: 'form' }] }));
      let node: ComponentNode | undefined = expandPlacements(page([placement(uuid(9), uuid(0))]), definitionsOf(...stored), BREAKPOINTS);
      while (node?.children?.[0]) node = node.children[0];
      return node?.id;
    };
    expect(run()?.length).toBeLessThanOrEqual(120);
    expect(run()).toMatch(/^p-/);
    expect(run()).toBe(run());
  });

  it('keeps a Collection template when its placement is missing, with no note to visitors', async () => {
    const { html, tree } = await publish(page([collection(placement('p', 'gone'))]), {}, { cmsRepo: rowsOf([{ a: 1 }, { a: 2 }]) });
    expect(html).toBe('<main><div data-component-kind="collection"></div></main>');
    expect(tree.children?.[0].children?.map(row => row.type)).toEqual([MISSING_TYPE, MISSING_TYPE]);
  });

  it('never resolves a name off the prototype', () => {
    for (const name of ['__proto__', 'constructor', 'toString']) {
      expect(expandPlacements(page([placement('p', name)]), {}, BREAKPOINTS).children?.[0].type).toBe(MISSING_TYPE);
    }
  });

  it('renders a page root that is a placement', async () => {
    const root = componentSnapshotToNode(placement('p', 'card') as never);
    expect((await publish(root, definitionsOf(CARD))).html).toContain('Card title');
  });

  it('stays a node when the root is missing, so the page is not a 404', async () => {
    expect((await publish(componentSnapshotToNode(placement('p', 'gone') as never), {})).html).toBe('');
  });

  it('serves an empty page when a root hides itself', async () => {
    const hidden = { id: 'r', type: 'div', bindings: { visible: read('{{page.params.off}}') } } as unknown as ComponentNode;
    expect(await hydrateBindings(hidden, { off: false as never }, { cmsRepo: noCms })).toEqual({ type: MISSING_TYPE });
  });
});

describe('the budget', () => {
  const fat = (size: number) => definition('fat', { id: 'f', type: 'p', props: { children: 'x'.repeat(size) } });

  it('stops one huge node placed many times', async () => {
    const size = 200 * 1024;
    const placements = Array.from({ length: 50 }, (_, i) => placement(`p${i}`, 'fat'));
    const { html, budget } = await publish(page(placements), definitionsOf(fat(size)));
    expect(budget.exhausted).toBe(true);
    expect(budget.bytes).toBeLessThanOrEqual(COMPONENT_LIMITS.expandedBytesPerPage);
    expect(html.length).toBeLessThan(COMPONENT_LIMITS.expandedBytesPerPage + 1000);
    expect(html.match(/<p>/g)?.length).toBeLessThan(25);
    expect(html.match(/<p>/g)?.length).toBeGreaterThan(15);
  });

  it('stops nested placements from multiplying a small page', async () => {
    const wide = (id: string, next: string) => definition(id, { id: `${id}-r`, type: 'div', children: Array.from({ length: 10 }, (_, i) => placement(`${id}x${i}`, next)) });
    const stored = definitionsOf(wide('a', 'b'), wide('b', 'c'), wide('c', 'd'), wide('d', 'e'), wide('e', 'fat'), fat(100 * 1024));
    const budget = createRenderBudget();
    expandPlacements(page([placement('p', 'a')]), stored, BREAKPOINTS, { budget });
    expect(budget.exhausted).toBe(true);
    expect(budget.nodes).toBeLessThanOrEqual(COMPONENT_LIMITS.expandedNodesPerPage);
  });

  it('stops by nodes as well', () => {
    const budget = createRenderBudget();
    const many = definition('many', { id: 'm', type: 'div', children: Array.from({ length: 2_000 }, (_, i) => ({ id: `s${i}`, type: 'i' })) });
    expandPlacements(page([placement('p1', 'many'), placement('p2', 'many'), placement('p3', 'many')]), definitionsOf(many), BREAKPOINTS, { budget });
    expect(budget.nodes).toBe(4_002);
    expect(budget.exhausted).toBe(true);
  });

  it('counts rows: a large card in a 100 row Collection', async () => {
    const card = definition('big', { id: 'b', type: 'div', children: Array.from({ length: 1_000 }, (_, i) => ({ id: `s${i}`, type: 'i' })) });
    const rows = Array.from({ length: 100 }, (_, i) => ({ i }));
    const { tree, budget } = await publish(page([collection(placement('p', 'big'))]), definitionsOf(card), { cmsRepo: rowsOf(rows) });
    expect(budget.exhausted).toBe(true);
    expect(tree.children?.[0].children).toHaveLength(4);
    expect([...budget.warnings].join()).toMatch(/over its budget/);
  });

  it('counts rows of a Collection inside a definition', async () => {
    const inner = definition('wrap', { id: 'w', type: 'div', children: [
      collection({ id: 't', type: 'div', children: Array.from({ length: 2_000 }, (_, i) => ({ id: `s${i}`, type: 'i' })) }),
    ] });
    const rows = Array.from({ length: 100 }, (_, i) => ({ i }));
    const { tree, budget } = await publish(page([placement('p', 'wrap')]), definitionsOf(inner), { cmsRepo: rowsOf(rows) });
    expect(budget.exhausted).toBe(true);
    expect(tree.children?.[0].children?.[0].children?.length).toBeLessThan(5);
  });

  it('ignores a definition over the size limit that reached it unparsed', () => {
    const huge = fat(COMPONENT_LIMITS.definitionBytes + 1) as unknown as ComponentDefinitions[string];
    const expanded = expandPlacements(page([placement('p', 'fat')]), { fat: huge }, BREAKPOINTS);
    expect(expanded.children?.[0].type).toBe(MISSING_TYPE);
  });
});

describe('a form placed twice', () => {
  it('is two forms, each with its own id', async () => {
    const stored = definition('contact', { id: 'f', type: 'div', props: { 'data-form-kind': 'form' }, children: [] });
    const { tree } = await publish(page([placement('p1', 'contact'), placement('p2', 'contact')]), definitionsOf(stored));
    expect(tree.children?.map(form => form.id)).toEqual(['p1', 'p2']);
  });
});

describe('a commerce island', () => {
  const cart = definition('buy', { id: 'b', type: 'div', children: [
    {
      id: 'add',
      type: 'button',
      props: { 'data-component-kind': 'add-to-cart', children: 'Stored label' },
      bindings: { children: read('{{input.cta}}'), 'data-sku': read('{{variant.sku}}') },
      children: [
        { id: 'tag', type: 'span', props: { children: 'Sale' }, bindings: { visible: read('{{input.sale}}') } },
        placement('nested', 'label', {}, { 'input.text': read('{{input.cta}}') }),
      ],
    },
  ] }, { inputs: [{ id: 'cta', name: 'CTA', type: 'text' }, { id: 'sale', name: 'Sale', type: 'toggle', default: false }] });
  const label = definition('label', { id: 'l', type: 'em', bindings: { children: read('{{input.text}}') } }, { inputs: [{ id: 'text', name: 'Text', type: 'text' }] });

  it('bakes input bindings, visible and nested placements, and leaves commerce bindings', async () => {
    const { tree } = await publish(
      page([placement('p1', 'buy', { inputs: { cta: 'Buy now' } }), placement('p2', 'buy', { inputs: { cta: 'Reserve', sale: true } })]),
      definitionsOf(cart, label),
    );
    const [one, two] = (tree.children ?? []).map(card => card.children?.[0]);
    expect(one?.props?.children).toBe('Buy now');
    expect(two?.props?.children).toBe('Reserve');
    expect(one?.bindings).toEqual({ 'data-sku': read('{{variant.sku}}') });
    expect(one?.children?.map(child => child.classKey)).toEqual(['l']);
    expect(two?.children?.map(child => child.classKey)).toEqual(['tag', 'l']);
    expect(one?.children?.[0].props).toEqual({ children: 'Buy now' });
    expect(JSON.stringify(tree)).not.toContain('inputDefinitions');
  });

  it('leaves an island outside a placement exactly as it was', async () => {
    const island = { id: 'i', type: 'button', props: { 'data-component-kind': 'add-to-cart' }, children: [{ id: 'c', type: 'span' }] };
    const root = page([island]);
    const hydrated = await hydrateBindings(root, {}, { cmsRepo: noCms });
    expect(hydrated.children?.[0]).toBe(root.children?.[0]);
  });
});

describe('literal mode, for raw readers', () => {
  const literal = (root: ComponentNode, definitions: ComponentDefinitions) =>
    expandPlacements(root, definitions, BREAKPOINTS, { literalInputs: true });

  it('writes a literal value into its slot', () => {
    const expanded = literal(page([placement('p', 'card', { inputs: { image: { src: 'https://images.unsplash.com/x', alt: 'A' } } })]), definitionsOf(CARD));
    expect(expanded.children?.[0].children?.[0].props).toMatchObject({ src: 'https://images.unsplash.com/x', alt: 'A' });
    expect(JSON.stringify(expanded)).not.toContain('inputDefinitions');
  });

  it('writes a default when the placement has none', () => {
    const expanded = literal(page([placement('p', 'card')]), definitionsOf(CARD));
    expect(expanded.children?.[0].props?.href).toBe('/');
  });

  it('leaves a value from data unknown, not its default', () => {
    const expanded = literal(page([placement('p', 'card', {}, { 'input.title': read('{{row.title}}') })]), definitionsOf(CARD));
    const title = expanded.children?.[0].children?.find(child => child.classKey === 'c-title');
    expect(title?.props?.children).toBe('Stored');
    expect(title?.bindings).toEqual({ children: read('{{input.title}}') });
  });

  it('passes a literal through a nested placement', () => {
    const inner = definition('inner', { id: 'i', type: 'h2', bindings: { children: read('{{input.heading}}') } }, { inputs: [{ id: 'heading', name: 'H', type: 'text' }] });
    const outer = definition('outer', { id: 'o', type: 'div', children: [placement('in', 'inner', {}, { 'input.heading': read('{{input.title}}') })] }, {
      inputs: [{ id: 'title', name: 'T', type: 'text' }],
    });
    const expanded = literal(page([placement('p', 'outer', { inputs: { title: 'Deep' } })]), definitionsOf(outer, inner));
    expect(expanded.children?.[0].children?.[0].props).toMatchObject({ children: 'Deep' });
  });

  it('removes what a literal toggle hides', () => {
    const expanded = literal(page([placement('p', 'card')]), definitionsOf(CARD));
    expect(expanded.children?.[0].children?.map(child => child.classKey)).toEqual(['c-img', 'c-title']);
  });
});

describe('html ids', () => {
  const panel = definition('panel', { id: 'r', type: 'div', children: [
    { id: 'b', type: 'button', props: { 'aria-controls': 'panel other', children: 'Open' } },
    { id: 'c', type: 'div', props: { id: 'panel' } },
    { id: 'l', type: 'label', props: { htmlFor: 'panel', 'aria-labelledby': 'panel' } },
    { id: 'a', type: 'a', props: { href: '#panel' } },
  ] });

  it('keeps a first use and suffixes a repeat, with its references', () => {
    const expanded = expandPlacements(page([placement('p1', 'panel'), placement('p2', 'panel')]), definitionsOf(panel), BREAKPOINTS);
    const [first, second] = expanded.children ?? [];
    expect(first.children?.[1].props?.id).toBe('panel');
    expect(first.children?.[3].props?.href).toBe('#panel');
    const id = second.children?.[1].props?.id as string;
    expect(id).toMatch(/^panel-[a-z0-9]{6}$/);
    expect(second.children?.[0].props?.['aria-controls']).toBe(`${id} other`);
    expect(second.children?.[2].props).toMatchObject({ htmlFor: id, 'aria-labelledby': id });
    expect(second.children?.[3].props?.href).toBe(`#${id}`);
  });

  it('yields to a page node wherever it stands', () => {
    const expanded = expandPlacements(page([placement('p1', 'panel'), { id: 'mine', type: 'div', props: { id: 'panel' } }]), definitionsOf(panel), BREAKPOINTS);
    expect(expanded.children?.[0].children?.[1].props?.id).toMatch(/^panel-/);
    expect(expanded.children?.[1].props?.id).toBe('panel');
  });

  it('does not depend on position: removing a placement renumbers nothing', () => {
    const idOfLast = (ids: string[]) =>
      expandPlacements(page(ids.map(id => placement(id, 'panel'))), definitionsOf(panel), BREAKPOINTS).children?.at(-1)?.children?.[1].props?.id;
    expect(idOfLast(['p1', 'p2', 'p3'])).toBe(idOfLast(['p1', 'x', 'y', 'p3']));
  });

  it('leaves an id bound to an input to its author', () => {
    const bound = definition('b', { id: 'r', type: 'div', props: { id: 'x' }, bindings: { id: read('{{input.anchor}}') } }, { inputs: [{ id: 'anchor', name: 'A', type: 'text' }] });
    const expanded = expandPlacements(page([placement('p1', 'b'), placement('p2', 'b')]), definitionsOf(bound), BREAKPOINTS);
    expect(expanded.children?.map(node => node.props?.id)).toEqual(['x', 'x']);
  });
});

describe('what stored data may not do', () => {
  it('strips renderer attributes anywhere, placement or not', () => {
    const root = page([{ id: 'n', type: 'div', props: { 'data-fc-c': 'x', 'data-fcs-a': 'y', 'DATA-FC-ON': 'z', title: 'kept' }, bindings: { 'data-fc-on': read('{{row.a}}') } }]);
    const expanded = expandPlacements(root, {}, BREAKPOINTS);
    expect(expanded).not.toBe(root);
    expect(expanded.children?.[0].props).toEqual({ title: 'kept' });
    expect(expanded.children?.[0].bindings).toEqual({});
  });

  it('strips them inside a definition', async () => {
    const stored = definition('d', { id: 'r', type: 'div', props: { 'data-fc-on': 'x', title: 't' } });
    expect((await publish(page([placement('p', 'd')]), definitionsOf(stored))).html).toBe('<main><div title="t"></div></main>');
  });

  it('does not let a page node forge a placement instance', async () => {
    const forged = { id: 'n', type: 'div', props: { instance: { inputs: {}, bindings: {}, inputDefinitions: [] }, title: 't' } };
    expect((await publish(page([forged]), {})).html).toBe('<main><div title="t"></div></main>');
  });

  it('keeps a stored string called instance, an attribute as ever', async () => {
    expect((await publish(page([{ id: 'n', type: 'div', props: { instance: 'x' } }]), {})).html).toContain('instance="x"');
  });

  it('keeps a text input off an address in any spelling', async () => {
    const stored = definition('d', { id: 'r', type: 'a', props: { href: '/safe' }, bindings: { href: read('{{input.t}}'), HREF: read('{{input.t}}'), formAction: read('{{input.t}}') } }, {
      inputs: [{ id: 't', name: 'T', type: 'text' }],
    });
    const { html, budget } = await publish(page([placement('p', 'd', { inputs: { t: 'https://evil.example/' } })]), definitionsOf(stored));
    expect(html).toBe('<main><a href="/safe"></a></main>');
    expect(budget.warnings.size).toBe(3);
  });

  it('refuses a bound style that would break out, from data, on a plain node', async () => {
    const stored = definition('d', { id: 'r', type: 'div', props: { style: { color: 'green' } }, bindings: { 'style.color': read('{{input.c}}') } }, {
      inputs: [{ id: 'c', name: 'C', type: 'text' }],
    });
    const { html } = await publish(
      page([collection(placement('p', 'd', {}, { 'input.c': read('{{row.color}}') }))]),
      definitionsOf(stored),
      { cmsRepo: rowsOf([{ color: 'red;background:url(https://track.example/x)' }, { color: 'blue' }]) },
    );
    expect(html).not.toContain('track.example');
    expect(html).toContain('color:green');
    expect(html).toContain('color:blue');
  });

  it('applies the same check to a binding on a page', async () => {
    const node = { id: 'n', type: 'div', props: { style: { color: 'green' } }, bindings: { 'style.color': read('{{row.color}}') } };
    const { html } = await publish(page([collection(node)]), {}, { cmsRepo: rowsOf([{ color: 'red;x:url(https://track.example/x)' }]) });
    expect(html).not.toContain('track.example');
  });

  it('never shows a state rule before it is compiled', async () => {
    const stored = definition('d', { id: 'r', type: 'div', props: {
      rules: [{ id: 'state-hover', componentState: 'hover', selector: '&', style: { color: 'red' } }],
    } }, { states: [{ id: 'hover', name: 'Hover', kind: 'hover' }] });
    const { css } = await publish(page([placement('p', 'd')]), definitionsOf(stored));
    expect(css).not.toContain('color:red');
  });
});

describe('an image on a background', () => {
  const hero = definition('hero', { id: 'h', type: 'section', bindings: { 'style.backgroundImage': read('{{input.bg}}') } }, {
    inputs: [{ id: 'bg', name: 'Background', type: 'image' }],
  });

  it('goes inside url()', async () => {
    const { html } = await publish(page([placement('p', 'hero', { inputs: { bg: { src: '/hero.jpg', alt: '' } } })]), definitionsOf(hero));
    expect(html).toContain('background-image:url(&quot;/hero.jpg&quot;)');
  });
});

describe('inside a Collection', () => {
  it('a card takes its row, and a hundred share one block', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ title: `Row ${i}` }));
    const { html, css, tree } = await publish(
      page([collection(placement('p1', 'card', { inputs: { badge: true } }, { 'input.title': read('{{row.title}}') }))]),
      definitionsOf(CARD),
      { cmsRepo: rowsOf(rows) },
    );
    expect(tree.children?.[0].children).toHaveLength(100);
    expect(html).toContain('>Row 0</h3>');
    expect(html).toContain('>Row 99</h3>');
    expect(html.match(/>New</g)).toHaveLength(100);
    expect(css.match(/\.fc-c-title\.fc-c-title\{color:red/g)).toHaveLength(1);
  });

  it('removes a hidden template from every row, and renders the rows empty', async () => {
    const hidden = definition('h', { id: 'r', type: 'div', props: { children: 'x' }, bindings: { visible: read('{{input.on}}') } }, {
      inputs: [{ id: 'on', name: 'On', type: 'toggle', default: false }],
    });
    const { html } = await publish(page([collection(placement('p', 'h'))]), definitionsOf(hidden), { cmsRepo: rowsOf([{}, {}]) });
    expect(html).toBe('<main><div data-component-kind="collection"></div></main>');
  });
});

describe('both renderers', () => {
  it('draw nothing for a leftover placement, rather than throw', () => {
    for (const type of ['#component', '#missing']) {
      expect(renderToStaticMarkup(React.createElement(React.Fragment, null, renderComponentNode({ id: 'x', type })))).toBe('');
    }
  });
});
