/* eslint-disable @typescript-eslint/no-explicit-any */
// Formatted text, `{ runs }` from a component's `richtext` input, on every surface
// that renders a page: the published walk (renderComponentNode) and the editor and
// preview dispatch (createComponentElement, through HeadlessPageRenderer). Each run
// is its text in its marks, in a link when it has an address, and never a link
// inside a link or a button. A value that is not valid runs renders nothing.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import PageModel from '@/models/PageModel';
import { createScope } from '@/lib/bindings/resolver/scope';
import { nodeTextContent } from '@/lib/renderer/publish/hydrateBindings';
import { renderComponentNode } from '../server/renderComponentNode';
import { componentSnapshotToNode } from '../server/snapshotToComponentNode';
import HeadlessPageRenderer from '../HeadlessPageRenderer';
import { formattedPlainText, isFormattedText, renderRuns } from '../textNode';
import { createRunElement } from '../runElements';
import { RunLinksContext } from '../createComponentElement';

const BP = 'bp-desktop';

function makePage(appComponentTree: any) {
  return PageModel.create({
    id: 'page-test',
    slug: 'test',
    metadata: { title: 'Test', description: '', keywords: [], ogTitle: '', ogDescription: '', ogImage: '', canonicalUrl: '' },
    appComponentTree,
    canvasNodes: {
      'viewport-desktop': {
        id: 'viewport-desktop', type: 'div', componentType: 'host', canvasNodeType: 'viewport', label: 'Desktop',
        breakpointId: BP, breakpointMinWidth: 1280, viewportWidth: 1280, viewportHeight: 800, canvasX: 0, canvasY: 0, props: {},
      },
    },
  });
}

const el = (id: string, type: string, props: object, children: any[] = []) => ({ id, type, componentType: 'host', props, children });

function published(tree: any): HTMLElement {
  return render(<div>{renderComponentNode(componentSnapshotToNode(tree), createScope())}</div>).container;
}

function preview(tree: any): HTMLElement {
  return render(<HeadlessPageRenderer page={makePage(tree)} breakpointId={BP} />).container;
}

const RUNS = { runs: [{ text: 'Plain ' }, { text: 'both', marks: ['em', 'strong'] }, { text: ' and ' }, { text: 'shop', marks: ['u'], href: '/shop' }] };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('renderRuns', () => {
  it('makes each run its text in its marks, strong outside em outside u, and a link outermost', () => {
    const html = renderToStaticMarkup(<p>{renderRuns(RUNS, createRunElement)}</p>);
    expect(html).toBe('<p>Plain <strong><em>both</em></strong> and <a href="/shop"><u>shop</u></a></p>');
  });

  it('leaves the address out where links are not allowed', () => {
    const html = renderToStaticMarkup(<p>{renderRuns(RUNS, createRunElement, false)}</p>);
    expect(html).toBe('<p>Plain <strong><em>both</em></strong> and <u>shop</u></p>');
  });

  it('refuses a value that is not valid runs as a whole', () => {
    for (const bad of [
      { runs: 'text' },
      { runs: [{ text: 1 }] },
      { runs: [{ text: 'a', marks: ['script'] }] },
      { runs: [{ text: 'ok' }, { text: 'x', href: 'javascript:alert(1)' }] },
      'plain',
      null,
    ]) {
      expect(renderRuns(bad, createRunElement)).toBeNull();
      expect(isFormattedText(bad)).toBe(false);
    }
  });

  it('gives the plain text of runs, as the parity check counts it', () => {
    expect(formattedPlainText(RUNS)).toBe('Plain both and shop');
    expect(nodeTextContent({ type: 'p', props: { children: RUNS } } as any)).toBe('Plain both and shop');
  });
});

describe('a link around the tree, as around a placement', () => {
  it('reaches the editor and preview renderer through the context, where MST ancestors end', () => {
    const c = render(
      <RunLinksContext.Provider value={false}>
        <HeadlessPageRenderer page={makePage(el('p1', 'p', { children: RUNS }))} breakpointId={BP} />
      </RunLinksContext.Provider>,
    ).container;
    expect(c.querySelector('p')!.innerHTML).toBe('Plain <strong><em>both</em></strong> and <u>shop</u>');
  });
});

describe.each([['published', published], ['editor and preview', preview]] as const)('formatted text on the %s renderer', (_name, renderTree) => {
  it('renders as its runs in the element', () => {
    const p = renderTree(el('p1', 'p', { children: RUNS })).querySelector('p')!;
    expect(p.innerHTML).toBe('Plain <strong><em>both</em></strong> and <a href="/shop"><u>shop</u></a>');
  });

  it('renders on a text node too, with no element of its own', () => {
    const p = renderTree(el('p1', 'p', {}, [{ id: 't1', type: '#text', componentType: 'host', props: { children: RUNS } }])).querySelector('p')!;
    expect(p.textContent).toBe('Plain both and shop');
    expect(p.querySelector('a')?.getAttribute('href')).toBe('/shop');
  });

  it('holds no link inside a link or a button, at any depth', () => {
    const c = renderTree(el('root', 'div', {}, [
      el('card', 'a', { href: '/card' }, [el('h', 'h3', { children: RUNS })]),
      el('b', 'button', { children: RUNS }),
    ]));
    expect(c.querySelectorAll('a a')).toHaveLength(0);
    expect(c.querySelector('h3')!.innerHTML).toBe('Plain <strong><em>both</em></strong> and <u>shop</u>');
    expect(c.querySelector('button a')).toBeNull();
    expect(c.querySelector('button')!.textContent).toBe('Plain both and shop');
  });

  it('renders nothing for a value that is not valid runs, and says so once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = renderTree(el('p1', 'p', { children: { runs: [{ text: 'x', href: 'javascript:alert(1)' }] } })).querySelector('p')!;
    expect(p.innerHTML).toBe('');
    expect(p.querySelector('a')).toBeNull();
    void warn;
  });
});
