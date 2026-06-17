// Unit tests for the Track C storefront commerce blocks on the component
// registry, the extended `DataComponentKind` union, and the end-to-end
// dispatch from a BOUND `product-list` node to ProductListRenderer.
//
// Covers the spec checklist in
// `docs/specs/build-2026-06/storefront/trackc-register-storefront-components-as-bindable-blocks.md`:
//   - Six commerce entries land under category `'commerce'` with bindableSlots,
//     a `dataComponentKind`, and the `data-component-kind` dispatch marker.
//   - `getBindableSlotsFor` returns the declared slots for the source kinds.
//   - The `DataComponentKind` union is extended with the six commerce kinds.
//   - A bound ProductList drag-drop renders the live fixture catalog (the
//     createComponentElement commerce branch routes to ProductListRenderer).
//
// This is a `.ts` file (no JSX): elements are built with React.createElement so
// the registry assertions stay framework-light while the render assertion still
// exercises the real headless dispatch path.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import {
  COMPONENT_REGISTRY,
  getBindableSlotsFor,
  listComponentsByCategory,
  type DataComponentKind,
} from '@/lib/componentRegistry';
import ComponentModel from '@/models/ComponentModel';
import HeadlessComponentRenderer from '@/lib/renderer/HeadlessComponentRenderer';
import { CommerceDataSourceContext } from '@/lib/commerce/context';
import { InMemoryCommerceDataSource } from '@/lib/commerce/inMemoryCommerceDataSource';

const BP = 'bp';
const ALL_BP = [{ id: BP, minWidth: 0, label: 'BP' }];

// The six commerce entries keyed by registry id -> expected dataComponentKind.
const COMMERCE_ENTRIES: Array<{ id: string; kind: DataComponentKind }> = [
  { id: 'productList', kind: 'product-list' },
  { id: 'productDetail', kind: 'product-detail' },
  { id: 'variantSelector', kind: 'variant-selector' },
  { id: 'addToCart', kind: 'add-to-cart' },
  { id: 'cartView', kind: 'cart-view' },
  { id: 'checkoutButton', kind: 'checkout-button' },
];

// Three-product catalog (mirrors the ProductListRenderer suite's fixture). Only
// products are needed: each maps to a ProductDTO with no options/variants.
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

afterEach(() => {
  cleanup();
});

describe('component registry commerce entries', () => {
  it('registers exactly the six commerce entries under category "commerce"', () => {
    const ids = listComponentsByCategory('commerce')
      .map((entry) => entry.id)
      .sort();
    expect(ids).toEqual(
      ['addToCart', 'cartView', 'checkoutButton', 'productDetail', 'productList', 'variantSelector'].sort(),
    );
  });

  it('each commerce entry declares its dataComponentKind and data-component-kind marker', () => {
    for (const { id, kind } of COMMERCE_ENTRIES) {
      const entry = COMPONENT_REGISTRY[id];
      expect(entry, `entry ${id} should exist`).toBeDefined();
      expect(entry?.category).toBe('commerce');
      expect(entry?.dataComponentKind).toBe(kind);
      // The dispatch marker the renderer reads to pick the commerce branch. It
      // also survives a static-HTML render so hydration can find these nodes.
      expect(entry?.defaultProps['data-component-kind']).toBe(kind);
    }
  });

  it('exposes the product-list `products` source slot in read mode', () => {
    const slots = getBindableSlotsFor('productList');
    expect(slots.products).toEqual({
      label: 'Source catalog',
      allowedModes: ['read'],
      scopeHint: 'collection',
    });
  });

  it('exposes the product-detail `product` slot with scopeHint "product"', () => {
    const slots = getBindableSlotsFor('productDetail');
    expect(slots.product).toEqual({
      label: 'Product',
      allowedModes: ['read'],
      scopeHint: 'product',
    });
  });

  it('declares bindableSlots for the picker on every entry that has a bindable prop', () => {
    // The two source kinds plus the three label/empty-text controls declare
    // slots; the variant-selector reads its product from scope (no slot).
    expect(Object.keys(getBindableSlotsFor('productList'))).toContain('products');
    expect(Object.keys(getBindableSlotsFor('productDetail'))).toContain('product');
    expect(Object.keys(getBindableSlotsFor('addToCart'))).toContain('label');
    expect(Object.keys(getBindableSlotsFor('checkoutButton'))).toContain('label');
    expect(Object.keys(getBindableSlotsFor('cartView'))).toContain('emptyContent');
    // variant-selector has no data-source slot: getBindableSlotsFor stays graceful.
    expect(getBindableSlotsFor('variantSelector')).toEqual({});
  });

  it('extends the DataComponentKind union with the six commerce kinds (compile-time)', () => {
    // A compile-time assertion: each literal must be assignable to the union.
    // If a kind were dropped from the union this assignment would not type-check.
    const kinds: DataComponentKind[] = [
      'product-list',
      'product-detail',
      'variant-selector',
      'add-to-cart',
      'cart-view',
      'checkout-button',
    ];
    expect(kinds).toHaveLength(6);
  });
});

describe('bound ProductList drag-drop render (createComponentElement dispatch)', () => {
  // A product-list node built from the registry entry's defaultProps (as a
  // drag-drop insert would produce it), bound to the catalog, whose first child
  // is the per-product card template: a span bound to {{product.title}}.
  function makeDroppedListNode() {
    return ComponentModel.create({
      id: 'list-1',
      type: COMPONENT_REGISTRY.productList.htmlType,
      componentType: 'host',
      props: { 'data-component-kind': 'product-list' },
      bindings: { products: { mode: 'read', expression: 'products' } },
      children: [
        {
          id: 'tpl-card',
          type: 'span',
          componentType: 'host',
          props: {},
          bindings: { children: { mode: 'read', expression: '{{product.title}}' } },
        },
      ],
    });
  }

  it('renders one card per fixture product with {{product.title}} resolved', async () => {
    const ds = new InMemoryCommerceDataSource(MULTI_SEED as never);
    const node = makeDroppedListNode();

    const { container } = render(
      React.createElement(
        CommerceDataSourceContext.Provider,
        { value: ds },
        React.createElement(HeadlessComponentRenderer, {
          component: node,
          breakpointId: BP,
          allBreakpoints: ALL_BP,
          primaryId: BP,
        }),
      ),
    );

    await waitFor(() => {
      const spans = container.querySelectorAll('span[data-inner-component-id="tpl-card"]');
      expect(spans.length).toBe(3);
    });

    const texts = Array.from(
      container.querySelectorAll('span[data-inner-component-id="tpl-card"]'),
    ).map((el) => el.textContent);
    expect(texts).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('renders the dashed-box placeholder (never a silent success) for an UNBOUND product-list', async () => {
    const ds = new InMemoryCommerceDataSource(MULTI_SEED as never);
    const node = ComponentModel.create({
      id: 'list-2',
      type: COMPONENT_REGISTRY.productList.htmlType,
      componentType: 'host',
      props: { 'data-component-kind': 'product-list' },
      bindings: {},
      children: [],
    });

    const { container } = render(
      React.createElement(
        CommerceDataSourceContext.Provider,
        { value: ds },
        React.createElement(HeadlessComponentRenderer, {
          component: node,
          breakpointId: BP,
          allBreakpoints: ALL_BP,
          primaryId: BP,
        }),
      ),
    );

    await waitFor(() => {
      expect(container.textContent).toContain('Product list (no binding)');
    });
    expect(
      container.querySelectorAll('span[data-inner-component-id="tpl-card"]').length,
    ).toBe(0);
  });
});
