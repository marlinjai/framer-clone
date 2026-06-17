// Commerce parity between the build-time hydrator and the live preview render.
//
// The whole point of the commerce bake in hydrateBindings is that the
// static-publish output is the SAME tree the storefront preview renders, just
// resolved eagerly in Node instead of lazily via React effects. This suite
// proves that: it renders a commerce-bound tree via the live preview path (fed
// by an in-memory CommerceDataSource) and asserts the resulting DOM textContent
// equals nodeTextContent of the SAME tree hydrated by hydrateBindings (fed by
// the SAME in-memory source, which satisfies the CommerceServerRepository read
// surface).
//
// ProductList parity is asserted against HeadlessPageRenderer (the published
// page render path). ProductDetail parity is asserted against
// HeadlessComponentRenderer with an explicit page-frame scope, because
// HeadlessPageRenderer does not thread dynamic-route params into the binding
// scope (the same reason the CMS parity suite asserts Collection but not
// RecordView through the page renderer); HeadlessComponentRenderer is the
// renderer HeadlessPageRenderer delegates to, so the render logic is identical.
//
// Runs under jsdom (the default project) because the live path renders React
// and relies on effects + a real DOM; the hydrator side stays React-free.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import PageModel from '@/models/PageModel';
import ComponentModel from '@/models/ComponentModel';
import HeadlessPageRenderer from '@/lib/renderer/HeadlessPageRenderer';
import HeadlessComponentRenderer from '@/lib/renderer/HeadlessComponentRenderer';
import { CommerceDataSourceContext } from '@/lib/commerce/context';
import { InMemoryCommerceDataSource } from '@/lib/commerce/inMemoryCommerceDataSource';
import { createScope, pushPageFrame } from '@/lib/bindings/resolver/scope';
import {
  hydrateBindings,
  nodeTextContent,
  type CommerceServerRepository,
  type ComponentNode,
} from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';

const BP = 'bp-desktop';

// A CmsReadRepository stub: commerce-only trees never reach it.
function makeCmsRepo(): CmsReadRepository {
  const fail = () => {
    throw new Error('CMS repo must not be called on a commerce-only tree');
  };
  return {
    listCollections: fail,
    getCollection: fail,
    listRows: fail,
    getRow: fail,
  } as unknown as CmsReadRepository;
}

// A two-product catalog seed (no variants needed for the list parity).
function twoProductSeed() {
  return {
    products: [
      { id: 'prod_a', handle: 'alpha', title: 'Alpha', description: null, taxClass: null },
      { id: 'prod_b', handle: 'beta', title: 'Beta', description: null, taxClass: null },
    ],
    options: [],
    optionValues: [],
    variants: [],
    variantOptions: [],
    prices: [],
    inventoryItems: [],
    inventoryLevels: [],
  };
}

// A root div containing a ProductList bound to the catalog whose per-product
// template is a single field-bound span ({{product.title}}). Shared verbatim by
// both the live render and the hydrator so the comparison is apples-to-apples.
function makeBoundListTree(extraProps: Record<string, unknown> = {}) {
  return {
    id: 'root',
    type: 'div',
    componentType: 'host',
    canvasNodeType: 'component',
    props: {},
    children: [
      {
        id: 'list',
        type: 'div',
        componentType: 'host',
        canvasNodeType: 'component',
        props: { 'data-component-kind': 'product-list', ...extraProps },
        bindings: { products: { mode: 'read', expression: 'products' } },
        children: [
          {
            id: 'tpl-card',
            type: 'span',
            componentType: 'host',
            canvasNodeType: 'component',
            props: {},
            bindings: { children: { mode: 'read', expression: '{{product.title}}' } },
          },
        ],
      },
    ],
  };
}

// A product-detail node resolving {{product.title}} (h1) and the default
// variant's {{variant.title}} (span). Both are STRINGS so the DOM textContent
// and nodeTextContent compare exactly.
function makeBoundDetailTree() {
  return {
    id: 'detail',
    type: 'div',
    componentType: 'host',
    canvasNodeType: 'component',
    props: { 'data-component-kind': 'product-detail' },
    bindings: { product: { mode: 'read', expression: 'product' } },
    children: [
      {
        id: 'pd-title',
        type: 'h1',
        componentType: 'host',
        canvasNodeType: 'component',
        props: {},
        bindings: { children: { mode: 'read', expression: '{{product.title}}' } },
      },
      {
        id: 'pd-variant',
        type: 'span',
        componentType: 'host',
        canvasNodeType: 'component',
        props: {},
        bindings: { children: { mode: 'read', expression: '{{variant.title}}' } },
      },
    ],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makePage(appTreeSnapshot: any) {
  return PageModel.create({
    id: 'page-test',
    slug: 'test',
    metadata: {
      title: 'Test page',
      description: '',
      keywords: [],
      ogTitle: '',
      ogDescription: '',
      ogImage: '',
      canonicalUrl: '',
    },
    appComponentTree: appTreeSnapshot,
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

afterEach(() => {
  cleanup();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).__componentRegistry;
});

describe('hydrateBindings commerce parity with the live preview render', () => {
  it('ProductList: hydrated text content matches HeadlessPageRenderer of a populated catalog', async () => {
    const provider = new InMemoryCommerceDataSource(twoProductSeed());
    const appTree = makeBoundListTree();

    // Live preview: 2 products x 1 template span = 2 spans.
    const page = makePage(appTree);
    const { container } = render(
      React.createElement(
        CommerceDataSourceContext.Provider,
        { value: provider },
        React.createElement(HeadlessPageRenderer, { page, breakpointId: BP }),
      ),
    );
    await waitFor(() => {
      expect(
        container.querySelectorAll('span[data-inner-component-id="tpl-card"]').length,
      ).toBe(2);
    });
    const previewText = container.textContent ?? '';

    // Build-time hydration of the SAME tree via the SAME source (which satisfies
    // the CommerceServerRepository read surface).
    const hydrated = await hydrateBindings(
      appTree as unknown as ComponentNode,
      {},
      {
        cmsRepo: makeCmsRepo(),
        commerceRepo: provider as unknown as CommerceServerRepository,
      },
    );

    expect(nodeTextContent(hydrated)).toBe(previewText);
    expect(previewText).toBe('AlphaBeta');
  });

  it('ProductList: hydrated text content matches the preview of an empty catalog (emptyContent)', async () => {
    const provider = new InMemoryCommerceDataSource({
      ...twoProductSeed(),
      products: [],
    });
    const appTree = makeBoundListTree({ emptyContent: 'No products yet' });

    const page = makePage(appTree);
    const { container } = render(
      React.createElement(
        CommerceDataSourceContext.Provider,
        { value: provider },
        React.createElement(HeadlessPageRenderer, { page, breakpointId: BP }),
      ),
    );
    // Empty render: the configured emptyContent sits in a single note span.
    await waitFor(() => {
      expect(container.querySelectorAll('span').length).toBe(1);
    });
    const previewText = container.textContent ?? '';

    const hydrated = await hydrateBindings(
      appTree as unknown as ComponentNode,
      {},
      {
        cmsRepo: makeCmsRepo(),
        commerceRepo: provider as unknown as CommerceServerRepository,
      },
    );

    expect(nodeTextContent(hydrated)).toBe(previewText);
    expect(previewText).toBe('No products yet');
  });

  it('ProductDetail: hydrated text content matches HeadlessComponentRenderer resolved from a handle', async () => {
    const provider = new InMemoryCommerceDataSource(); // default Classic Tee seed
    const detailTree = makeBoundDetailTree();

    // Live preview: render the detail node through the headless renderer with the
    // handle pushed into the page frame (HeadlessPageRenderer does not thread
    // route params; HeadlessComponentRenderer is the renderer it delegates to).
    const component = ComponentModel.create(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      detailTree as any,
    );
    const scope = pushPageFrame(createScope(), { handle: 'classic-tee' });
    const { container } = render(
      React.createElement(
        CommerceDataSourceContext.Provider,
        { value: provider },
        React.createElement(HeadlessComponentRenderer, {
          component,
          breakpointId: BP,
          allBreakpoints: [{ id: BP, minWidth: 0, label: 'Desktop' }],
          primaryId: BP,
          scope,
        }),
      ),
    );
    await waitFor(() => {
      expect(
        container.querySelector('h1[data-inner-component-id="pd-title"]')?.textContent,
      ).toBe('Classic Tee');
    });
    const previewText = container.textContent ?? '';

    // Build-time hydration of the SAME tree, handle fed via pageParams.
    const hydrated = await hydrateBindings(
      detailTree as unknown as ComponentNode,
      { handle: 'classic-tee' },
      {
        cmsRepo: makeCmsRepo(),
        commerceRepo: provider as unknown as CommerceServerRepository,
      },
    );

    expect(nodeTextContent(hydrated)).toBe(previewText);
    // Classic Tee + its default variant (var_s_red, "Small / Red").
    expect(previewText).toBe('Classic TeeSmall / Red');
  });
});
