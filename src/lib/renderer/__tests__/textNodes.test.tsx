/* eslint-disable @typescript-eslint/no-explicit-any */
// Text mixed with elements, on every surface that renders a page: the published
// walk (renderComponentNode), the editor and preview dispatch
// (createComponentElement, through HeadlessPageRenderer), and the publish chain
// in front of them. The DOM must be exact: no wrapper around the text, nothing
// lost, nothing reordered.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import PageModel from '@/models/PageModel';
import { getSnapshot } from 'mobx-state-tree';
import ComponentModel from '@/models/ComponentModel';
import { createScope } from '@/lib/bindings/resolver/scope';
import { isBlockedTag } from '@/lib/renderer/blockedNodes';
import { hydrateBindings, nodeTextContent, type ComponentNode, type HydrationRepos } from '@/lib/renderer/publish/hydrateBindings';
import { applyEffects } from '../server/applyEffects';
import { applyImageLoading } from '../server/imageLoading';
import { applyResponsiveStyles } from '../server/applyResponsiveStyles';
import { renderComponentNode } from '../server/renderComponentNode';
import { componentSnapshotToNode, snapshotToComponentNode } from '../server/snapshotToComponentNode';
import HeadlessPageRenderer from '../HeadlessPageRenderer';
import { renderableText } from '../textNode';

const BP = 'bp-desktop';

function makePage(appComponentTree: any) {
  return PageModel.create({
    id: 'page-test',
    slug: 'test',
    metadata: { title: 'Test', description: '', keywords: [], ogTitle: '', ogDescription: '', ogImage: '', canonicalUrl: '' },
    appComponentTree,
    canvasNodes: {
      'viewport-desktop': {
        id: 'viewport-desktop',
        type: 'div',
        componentType: 'host',
        canvasNodeType: 'viewport',
        label: 'Desktop',
        breakpointId: BP,
        breakpointMinWidth: 1280,
        viewportWidth: 1280,
        viewportHeight: 800,
        canvasX: 0,
        canvasY: 0,
        props: {},
      },
    },
  });
}

const text = (id: string, value: unknown, extra: object = {}) => ({
  id,
  type: '#text',
  componentType: 'host',
  props: { children: value },
  ...extra,
});
const el = (id: string, type: string, props: object, children: any[] = []) => ({
  id,
  type,
  componentType: 'host',
  props,
  children,
});

/** Render a tree through the published walk. */
function published(tree: any): HTMLElement {
  const node = componentSnapshotToNode(tree);
  return render(<div data-testid="host">{renderComponentNode(node, createScope())}</div>).container;
}

/** Render a tree through createComponentElement (the dispatch the editor shares). */
function preview(tree: any): HTMLElement {
  return render(<HeadlessPageRenderer page={makePage(tree)} breakpointId={BP} />).container;
}

const SURFACES = [
  ['published', published],
  ['editor and preview', preview],
] as const;

const repos: HydrationRepos = { cmsRepo: {} as HydrationRepos['cmsRepo'] };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe.each(SURFACES)('text nodes on the %s renderer', (_name, renderTree) => {
  it('keeps text and elements in order, with no wrapper', () => {
    const c = renderTree(
      el('p1', 'p', {}, [text('t1', 'Hello '), el('b1', 'strong', { children: 'bold' }), text('t2', ' world')]),
    );
    const p = c.querySelector('p')!;
    expect(p.textContent).toBe('Hello bold world');
    expect(Array.from(p.childNodes).map(n => n.nodeName)).toEqual(['#text', 'STRONG', '#text']);
    expect(p.childNodes[0].nodeValue).toBe('Hello ');
    expect(p.childNodes[2].nodeValue).toBe(' world');
  });

  it('renders a legacy string first, then the children', () => {
    const c = renderTree(el('p1', 'p', { children: 'Hello ' }, [el('b1', 'strong', { children: 'bold' })]));
    const p = c.querySelector('p')!;
    expect(p.textContent).toBe('Hello bold');
    expect(Array.from(p.childNodes).map(n => n.nodeName)).toEqual(['#text', 'STRONG']);
  });

  it('keeps whitespace-only text between two elements', () => {
    const c = renderTree(
      el('p1', 'p', {}, [el('a', 'em', { children: 'a' }), text('t', ' '), el('b', 'em', { children: 'b' })]),
    );
    expect(c.querySelector('p')!.textContent).toBe('a b');
  });

  it('renders numbers, zero included, and empty text as nothing', () => {
    const c = renderTree(el('p1', 'p', {}, [text('t1', 0), text('t2', ''), text('t3', 12)]));
    expect(c.querySelector('p')!.textContent).toBe('012');
  });

  it('renders something stored that is not text as nothing, without taking the page down', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = renderTree(el('p1', 'p', {}, [text('t1', { nested: true }), el('b1', 'strong', { children: 'kept' })]));
    expect(c.querySelector('p')!.textContent).toBe('kept');
  });

  it('ignores any tag or marker a stored text node carries', () => {
    const c = renderTree(
      el('p1', 'p', {}, [text('t1', 'plain', { props: { children: 'plain', 'data-component-kind': 'collection', 'data-form-kind': 'form' } })]),
    );
    expect(c.querySelector('p')!.innerHTML).toBe('plain');
  });

  it('never lets markup in text become an element', () => {
    const c = renderTree(el('p1', 'p', {}, [text('t1', '<img src=x onerror=alert(1)>')]));
    expect(c.querySelector('img')).toBeNull();
    expect(c.querySelector('p')!.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('still emits a plain text element as before', () => {
    const c = renderTree(el('p1', 'p', { children: 'Only text' }));
    expect(c.querySelector('p')!.textContent).toBe('Only text');
  });

  it('text sits directly in a container too', () => {
    const c = renderTree(el('d1', 'div', {}, [text('t1', 'Loose '), el('a1', 'a', { href: '/x', children: 'link' })]));
    const a = c.querySelector('a')!;
    expect(a.parentElement!.textContent).toBe('Loose link');
  });
});

describe('text nodes through the publish chain', () => {
  it('is not blocked by the renderer block list', () => {
    expect(isBlockedTag('#text')).toBe(false);
  });

  it('carries no identity attributes in the editor and preview dispatch', () => {
    const c = preview(el('p1', 'p', {}, [text('t1', 'Hello')]));
    expect(c.querySelector('[data-inner-component-id="t1"]')).toBeNull();
    expect(c.querySelector('[data-inner-component-id="p1"]')!.textContent).toBe('Hello');
  });

  it('survives the page snapshot adaptor field for field', () => {
    const adapted = snapshotToComponentNode({
      appComponentTree: el('p1', 'p', {}, [text('t1', 'Hello '), el('b1', 'strong', { children: 'bold' }), text('t2', '')]),
    } as any);
    expect(adapted.root!.children).toEqual([
      { type: '#text', id: 't1', props: { children: 'Hello ' } },
      { type: 'strong', id: 'b1', props: { children: 'bold' } },
      { type: '#text', id: 't2', props: { children: '' } },
    ]);
  });

  it('hydrates, keeps its children slot empty and resolves a binding on the text', async () => {
    const tree: ComponentNode = {
      type: 'p',
      id: 'p1',
      children: [
        { type: '#text', id: 't1', props: { children: 'Hello ' } },
        { type: '#text', id: 't2', bindings: { children: { mode: 'read', expression: '{{page.params.name}}' } } as any },
        { type: '#text', id: 't3', props: { children: 'x' }, children: [{ type: 'script', props: { children: 'no' } }] },
      ],
    };
    const hydrated = await hydrateBindings(tree, { name: 'Ada' }, repos);
    expect(hydrated.children!.map(c => c.props?.children)).toEqual(['Hello ', 'Ada', 'x']);
    expect(hydrated.children![2].children).toEqual([]);
    expect(nodeTextContent(hydrated)).toBe('Hello Adax');
  });

  it('flattens legacy text in front of its children, as the DOM does', () => {
    expect(nodeTextContent({ type: 'p', props: { children: 'A' }, children: [{ type: 'b', props: { children: 7 } }] })).toBe('A7');
  });

  it('passes the stylesheet, effects and image passes unchanged', () => {
    const tree: ComponentNode = {
      type: 'section',
      id: 's1',
      children: [{ type: 'p', id: 'p1', children: [{ type: '#text', id: 't1', props: { children: 'Hello ' } }] }],
    };
    const responsive = applyResponsiveStyles(tree, []).root;
    const effects = applyEffects(responsive, []).root;
    const loaded = applyImageLoading(effects).root;
    expect(renderToStaticMarkup(<>{renderComponentNode(loaded, createScope())}</>)).toBe('<section><p>Hello </p></section>');
  });

  it('repeats a text node used as a collection template, row by row', async () => {
    const cmsRepo = {
      listRows: async () => ({ rows: [{ id: 'r1', values: { title: 'One' } }, { id: 'r2', values: { title: 'Two' } }] }),
    } as unknown as HydrationRepos['cmsRepo'];
    const hydrated = await hydrateBindings(
      {
        type: 'div',
        id: 'c1',
        props: { 'data-component-kind': 'collection' },
        bindings: { collection: { mode: 'read', expression: 'col_x' } },
        children: [{ type: '#text', id: 't1', bindings: { children: { mode: 'read', expression: '{{row.title}}' } } }],
      },
      {},
      { cmsRepo },
    );
    expect(renderToStaticMarkup(<>{renderComponentNode(hydrated, createScope())}</>)).toContain('OneTwo');
  });

  it('keeps a legacy form text in the published form as well', () => {
    const c = published(el('f1', 'div', { 'data-form-kind': 'form', children: 'Write to us ' }, [text('t1', 'today')]));
    expect(c.querySelector('form')!.textContent).toContain('Write to us today');
  });

  it('round-trips a saved tree through the model', () => {
    const tree = el('p1', 'p', {}, [text('t1', 'Hello ', { parentId: 'p1' }), text('t2', ' world', { parentId: 'p1' })]);
    const saved = JSON.parse(JSON.stringify(getSnapshot(ComponentModel.create(tree))));
    const again = ComponentModel.create(saved);
    expect(again.children.map((c: any) => [c.type, c.props.children])).toEqual([
      ['#text', 'Hello '],
      ['#text', ' world'],
    ]);
  });
});

describe('renderableText', () => {
  it('keeps text exactly and treats nothing as nothing', () => {
    expect(renderableText('Hello ')).toBe('Hello ');
    expect(renderableText(0)).toBe(0);
    expect(renderableText(undefined)).toBeNull();
    expect(renderableText(null)).toBeNull();
  });

  it('reports stored data that cannot render, once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    const fresh = await import('../textNode');
    expect(fresh.renderableText({ nested: true })).toBeNull();
    expect(fresh.renderableText(true)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
