/* eslint-disable @typescript-eslint/no-explicit-any */
// ProductDetailRenderer behaviour. Dispatch wiring is owned by the separate
// register spec and not present yet, so these tests render the renderer
// directly with a faithful `renderNode` (HeadlessComponentRenderer) and a
// CommerceDataSource provider. The default in-memory fixture is the Classic Tee
// catalog (handle "classic-tee", first variant var_s_red @ 2500c, availability
// aggregated to 40 across two locations).
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, waitFor, act } from '@testing-library/react';
import ComponentModel, { type ComponentInstance } from '@/models/ComponentModel';
import HeadlessComponentRenderer from '@/lib/renderer/HeadlessComponentRenderer';
import { CommerceDataSourceContext } from '@/lib/commerce/context';
import { InMemoryCommerceDataSource } from '@/lib/commerce/inMemoryCommerceDataSource';
import {
  createScope,
  pushPageFrame,
  type BindingScope,
} from '@/lib/bindings/resolver/scope';
import type { RenderNode } from '@/lib/renderer/data/CollectionRenderer';
import type { DataStateMode } from '@/lib/renderer/data/resolveDataState';
import ProductDetailRenderer from '../ProductDetailRenderer';

const BP = 'bp';
const ALL_BP = [{ id: BP, minWidth: 0, label: 'BP' }];

// A product-detail node whose children resolve {{product.*}}, the default
// variant's {{variant.price.*}}, and the advisory {{availability.*}}.
function makeDetailNode() {
  return ComponentModel.create({
    id: 'detail-1',
    type: 'div',
    componentType: 'host',
    props: { 'data-component-kind': 'product-detail' },
    bindings: {},
    children: [
      {
        id: 'pd-title',
        type: 'h1',
        componentType: 'host',
        props: {},
        bindings: { children: { mode: 'read', expression: '{{product.title}}' } },
      },
      {
        id: 'pd-price',
        type: 'span',
        componentType: 'host',
        props: {},
        bindings: { children: { mode: 'read', expression: '{{variant.price.amountCents}}' } },
      },
      {
        id: 'pd-avail',
        type: 'span',
        componentType: 'host',
        props: {},
        bindings: { children: { mode: 'read', expression: '{{availability.availableQuantity}}' } },
      },
    ],
  });
}

// A faithful recursion callback: render each child through the real headless
// host renderer so {{product.*}} / {{variant.price.*}} / {{availability.*}}
// resolution is exercised end to end (a plain local const, like
// HeadlessComponentRenderer's own renderNode).
const renderNode: RenderNode = (node: ComponentInstance, childScope: BindingScope) => (
  <HeadlessComponentRenderer
    component={node}
    breakpointId={BP}
    allBreakpoints={ALL_BP}
    primaryId={BP}
    scope={childScope}
  />
);

function renderDetail(
  handle: string | undefined,
  ds: InMemoryCommerceDataSource,
  mode: DataStateMode = 'preview',
) {
  const scope = pushPageFrame(createScope(), handle ? { handle } : {});
  return render(
    <CommerceDataSourceContext.Provider value={ds}>
      <ProductDetailRenderer
        node={makeDetailNode()}
        scope={scope}
        renderNode={renderNode}
        hostType="div"
        hostProps={{ 'data-component-id': `${BP}-detail-1`, 'data-inner-component-id': 'detail-1' }}
        mode={mode}
      />
    </CommerceDataSourceContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
  delete (window as any).__componentRegistry;
});

describe('ProductDetailRenderer', () => {
  it('resolves the product named by {{page.params.handle}} and exposes product + default-variant price + availability', async () => {
    const ds = new InMemoryCommerceDataSource();
    const { container } = renderDetail('classic-tee', ds);

    await waitFor(() => {
      const title = container.querySelector('h1[data-inner-component-id="pd-title"]');
      expect(title?.textContent).toBe('Classic Tee');
    });
    const price = container.querySelector('span[data-inner-component-id="pd-price"]');
    const avail = container.querySelector('span[data-inner-component-id="pd-avail"]');
    // First variant var_s_red: price 2500c; availability aggregated (10 + 30).
    expect(price?.textContent).toBe('2500');
    expect(avail?.textContent).toBe('40');
  });

  it('hits the empty path (never a silent success) for a non-existent handle', async () => {
    const ds = new InMemoryCommerceDataSource();
    const { container } = renderDetail('does-not-exist', ds);

    await waitFor(() => {
      expect(container.textContent).toContain('Product not found');
    });
    expect(container.querySelector('h1[data-inner-component-id="pd-title"]')).toBeNull();
  });

  it('shows the empty/no-product path when no handle is present in scope', async () => {
    const ds = new InMemoryCommerceDataSource();
    const { container } = renderDetail(undefined, ds);

    await waitFor(() => {
      expect(container.textContent).toContain('no product selected');
    });
    expect(container.querySelector('h1[data-inner-component-id="pd-title"]')).toBeNull();
  });

  it('surfaces the error chip in editor mode and renders nothing in preview when a fetch rejects', async () => {
    const ds = new InMemoryCommerceDataSource();
    (ds as any).getProductByHandle = () => Promise.reject(new Error('kaput'));

    const editor = renderDetail('classic-tee', ds, 'editor');
    await waitFor(() => {
      expect(editor.container.textContent).toContain('Failed to load product: kaput');
    });
    cleanup();

    const preview = renderDetail('classic-tee', ds, 'preview');
    await waitFor(() => {
      expect(preview.container.textContent).toBe('');
    });
    expect(preview.container.querySelector('h1[data-inner-component-id="pd-title"]')).toBeNull();
  });

  it('re-renders when the data source signals a change (subscribe)', async () => {
    const ds = new InMemoryCommerceDataSource();
    const { container } = renderDetail('classic-tee', ds);

    await waitFor(() => {
      const title = container.querySelector('h1[data-inner-component-id="pd-title"]');
      expect(title?.textContent).toBe('Classic Tee');
    });

    act(() => {
      ds._mutate('prod_tee', (seed) => {
        seed.products[0].title = 'Updated Tee';
      });
    });

    await waitFor(() => {
      const title = container.querySelector('h1[data-inner-component-id="pd-title"]');
      expect(title?.textContent).toBe('Updated Tee');
    });
  });
});
