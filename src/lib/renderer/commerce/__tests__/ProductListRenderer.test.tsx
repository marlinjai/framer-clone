/* eslint-disable @typescript-eslint/no-explicit-any */
// ProductListRenderer behaviour. Dispatch wiring (createComponentElement's
// commerce branch) is owned by the SEPARATE register spec and not present yet,
// so these tests render ProductListRenderer directly with a faithful
// `renderNode` (HeadlessComponentRenderer) and a CommerceDataSource provider.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, waitFor, act } from '@testing-library/react';
import ComponentModel, { type ComponentInstance } from '@/models/ComponentModel';
import HeadlessComponentRenderer from '@/lib/renderer/HeadlessComponentRenderer';
import { CommerceDataSourceContext } from '@/lib/commerce/context';
import { InMemoryCommerceDataSource } from '@/lib/commerce/inMemoryCommerceDataSource';
import { createScope, type BindingScope } from '@/lib/bindings/resolver/scope';
import type { RenderNode } from '@/lib/renderer/data/CollectionRenderer';
import type { DataStateMode } from '@/lib/renderer/data/resolveDataState';
import ProductListRenderer from '../ProductListRenderer';

const BP = 'bp';
const ALL_BP = [{ id: BP, minWidth: 0, label: 'BP' }];

// Three-product catalog. Other catalog tables are empty: the list only needs
// products (each maps to a ProductDTO with no options/variants).
const MULTI_SEED = {
  products: [
    { id: 'prod_a', handle: 'alpha', title: 'Alpha', description: null, taxClass: null },
    { id: 'prod_b', handle: 'beta', title: 'Beta', description: null, taxClass: null },
    { id: 'prod_c', handle: 'gamma', title: 'Gamma', description: null, taxClass: null },
  ],
  options: [],
  optionValues: [],
  variants: [],
  variantOptions: [],
  prices: [],
  inventoryItems: [],
  inventoryLevels: [],
};

// A product-list node whose first child is the per-product card template:
// a span bound to {{product.title}}.
function makeListNode(opts: { bound?: boolean; withTemplate?: boolean } = {}) {
  const { bound = true, withTemplate = true } = opts;
  return ComponentModel.create({
    id: 'list-1',
    type: 'div',
    componentType: 'host',
    props: { 'data-component-kind': 'product-list' },
    bindings: bound ? { products: { mode: 'read', expression: 'products' } } : {},
    children: withTemplate
      ? [
          {
            id: 'tpl-card',
            type: 'span',
            componentType: 'host',
            props: {},
            bindings: { children: { mode: 'read', expression: '{{product.title}}' } },
          },
        ]
      : [],
  });
}

// A faithful recursion callback: render each per-product template through the
// real headless host renderer so {{product.*}} resolution is exercised end to
// end (a plain local const, like HeadlessComponentRenderer's own renderNode).
const renderNode: RenderNode = (node: ComponentInstance, childScope: BindingScope) => (
  <HeadlessComponentRenderer
    component={node}
    breakpointId={BP}
    allBreakpoints={ALL_BP}
    primaryId={BP}
    scope={childScope}
  />
);

function renderList(
  node: ComponentInstance,
  ds: InMemoryCommerceDataSource,
  mode: DataStateMode = 'preview',
) {
  return render(
    <CommerceDataSourceContext.Provider value={ds}>
      <ProductListRenderer
        node={node}
        scope={createScope()}
        renderNode={renderNode}
        hostType="div"
        hostProps={{ 'data-component-id': `${BP}-list-1`, 'data-inner-component-id': 'list-1' }}
        mode={mode}
      />
    </CommerceDataSourceContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
  delete (window as any).__componentRegistry;
});

describe('ProductListRenderer', () => {
  it('renders one card template per product with {{product.field}} resolved', async () => {
    const ds = new InMemoryCommerceDataSource(MULTI_SEED as any);
    const { container } = renderList(makeListNode(), ds);

    await waitFor(() => {
      const spans = container.querySelectorAll('span[data-inner-component-id="tpl-card"]');
      expect(spans.length).toBe(3);
    });

    const texts = Array.from(
      container.querySelectorAll('span[data-inner-component-id="tpl-card"]'),
    ).map((el) => el.textContent);
    expect(texts).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('hits the empty path (never a silent success) for a zero-product catalog', async () => {
    const ds = new InMemoryCommerceDataSource({ ...MULTI_SEED, products: [] } as any);
    const { container } = renderList(makeListNode(), ds);

    await waitFor(() => {
      expect(container.textContent).toContain('No products');
    });
    expect(
      container.querySelectorAll('span[data-inner-component-id="tpl-card"]').length,
    ).toBe(0);
  });

  it('surfaces the error chip in editor mode and renders nothing in preview when listProducts rejects', async () => {
    const ds = new InMemoryCommerceDataSource(MULTI_SEED as any);
    (ds as any).listProducts = () => Promise.reject(new Error('boom'));

    const editor = renderList(makeListNode(), ds, 'editor');
    await waitFor(() => {
      expect(editor.container.textContent).toContain('Failed to load products: boom');
    });
    cleanup();

    const preview = renderList(makeListNode(), ds, 'preview');
    await waitFor(() => {
      // The error path is exercised (loading note is gone) but renders nothing.
      expect(preview.container.textContent).toBe('');
    });
    expect(
      preview.container.querySelectorAll('span[data-inner-component-id="tpl-card"]').length,
    ).toBe(0);
  });

  it('re-renders when the data source signals a change (subscribe)', async () => {
    const ds = new InMemoryCommerceDataSource(MULTI_SEED as any);
    const { container } = renderList(makeListNode(), ds);

    await waitFor(() => {
      expect(
        container.querySelectorAll('span[data-inner-component-id="tpl-card"]').length,
      ).toBe(3);
    });

    act(() => {
      ds._mutate(null, (seed) => {
        (seed.products as any).push({
          id: 'prod_d',
          handle: 'delta',
          title: 'Delta',
          description: null,
          taxClass: null,
        });
      });
    });

    await waitFor(() => {
      expect(
        container.querySelectorAll('span[data-inner-component-id="tpl-card"]').length,
      ).toBe(4);
    });
  });

  it('surfaces a configuration note (never a silent success) when no products binding is present', async () => {
    const ds = new InMemoryCommerceDataSource(MULTI_SEED as any);
    const { container } = renderList(makeListNode({ bound: false }), ds);

    await waitFor(() => {
      expect(container.textContent).toContain('no products source bound');
    });
    expect(
      container.querySelectorAll('span[data-inner-component-id="tpl-card"]').length,
    ).toBe(0);
  });

  it('notes a missing template (never a silent success) when bound and populated but childless', async () => {
    const ds = new InMemoryCommerceDataSource(MULTI_SEED as any);
    const { container } = renderList(makeListNode({ withTemplate: false }), ds);

    await waitFor(() => {
      expect(container.textContent).toContain('add a child to use as the product template');
    });
  });
});
