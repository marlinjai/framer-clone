// renderComponentNode: SSR-safe walk of a hydrated ComponentNode tree.
//   - primitives -> expected HTML/text
//   - each of the four interactive kinds emits its island marker/component
//   - void tags emit without children; unknown/empty types degrade (no throw)
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import {
  createScope,
  pushProductFrame,
  type BindingScope,
} from '@/lib/bindings/resolver/scope';
import { CommerceDataSourceContext } from '@/lib/commerce/context';
import type { CommerceDataSource } from '@/lib/commerce/provider';
import { CartProvider } from '@/lib/commerce/cart';
import type {
  AvailabilityDTO,
  ProductDTO,
  ProductVariantDTO,
} from '@/lib/commerce/types';
import { renderComponentNode } from '../renderComponentNode';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

/** A commerce data source stub: one variant, advisory stock 10, no price. */
function stubDataSource(): CommerceDataSource {
  const variant: ProductVariantDTO = {
    id: 'v1',
    productId: 'p1',
    title: 'V1',
    optionValues: [],
  };
  const availability: AvailabilityDTO = {
    variantId: 'v1',
    locationId: 'all',
    availableQuantity: 10,
    stale: false,
  };
  return {
    listProducts: async () => ({ products: [], total: 0 }),
    getProduct: async () => null,
    getProductByHandle: async () => null,
    listVariants: async () => [variant],
    getVariant: async () => variant,
    getPrices: async () => [],
    getAvailability: async () => availability,
    subscribe: () => () => {},
  } as unknown as CommerceDataSource;
}

function renderWithProviders(node: ComponentNode, scope: BindingScope = createScope()) {
  return render(
    <CommerceDataSourceContext.Provider value={stubDataSource()}>
      <CartProvider>{renderComponentNode(node, scope)}</CartProvider>
    </CommerceDataSourceContext.Provider>,
  );
}

describe('renderComponentNode: primitives', () => {
  it('renders a hydrated primitive tree to the expected HTML/text', () => {
    const tree: ComponentNode = {
      type: 'div',
      id: 'root',
      props: { style: { padding: '8px' } },
      children: [
        { type: 'h1', id: 'h', props: { children: 'Title' } },
        { type: 'p', id: 'p', props: { children: 'Body copy' } },
      ],
    };
    const { container } = render(<>{renderComponentNode(tree)}</>);
    const root = container.querySelector('div');
    expect(root).not.toBeNull();
    expect(root!.querySelector('h1')!.textContent).toBe('Title');
    expect(root!.querySelector('p')!.textContent).toBe('Body copy');
    expect(container.textContent).toContain('Title');
    expect(container.textContent).toContain('Body copy');
  });

  it('flattens a responsive style map to its base value', () => {
    const node: ComponentNode = {
      type: 'div',
      id: 'r',
      props: { style: { width: { base: '100%', desktop: '50%' } } },
    };
    const { container } = render(<>{renderComponentNode(node)}</>);
    expect((container.querySelector('div') as HTMLElement).style.width).toBe('100%');
  });

  it('emits a void tag (img) with no children and never throws', () => {
    const node: ComponentNode = {
      type: 'img',
      id: 'i',
      props: { src: '/a.png', alt: 'A', children: 'should be dropped' },
    };
    const { container } = render(<>{renderComponentNode(node)}</>);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/a.png');
    expect(img!.childNodes.length).toBe(0);
  });

  it('resolves a registry-id type to its htmlType (image -> img)', () => {
    const node: ComponentNode = { type: 'image', id: 'i2', props: { src: '/b.png' } };
    const { container } = render(<>{renderComponentNode(node)}</>);
    expect(container.querySelector('img')).not.toBeNull();
  });
});

describe('renderComponentNode: graceful degradation', () => {
  it('renders nothing (no throw) for an empty/non-string type', () => {
    const node = { type: '', id: 'x', children: [] } as unknown as ComponentNode;
    expect(() => render(<>{renderComponentNode(node)}</>)).not.toThrow();
  });

  it('renders an unknown tag without throwing', () => {
    const node: ComponentNode = { type: 'mystery-widget', id: 'mw', props: {} };
    expect(() => render(<>{renderComponentNode(node)}</>)).not.toThrow();
  });
});

describe('renderComponentNode: interactive commerce islands', () => {
  it('emits the cart-view island (empty cart marker)', () => {
    const node: ComponentNode = {
      type: 'div',
      id: 'cv',
      props: { 'data-component-kind': 'cart-view' },
    };
    const { container } = renderWithProviders(node);
    expect(container.querySelector('[data-component-kind="cart-view"]')).not.toBeNull();
    expect(container.querySelector('[data-cart-empty]')).not.toBeNull();
  });

  it('emits the checkout-button island', () => {
    const node: ComponentNode = {
      type: 'div',
      id: 'co',
      props: { 'data-component-kind': 'checkout-button', label: 'Pay now' },
    };
    const { container } = renderWithProviders(node);
    expect(container.querySelector('[data-checkout]')).not.toBeNull();
    expect(container.textContent).toContain('Pay now');
  });

  it('emits the variant-selector island (marker present even with no product)', () => {
    const node: ComponentNode = {
      type: 'div',
      id: 'vs',
      props: { 'data-component-kind': 'variant-selector' },
    };
    const { container } = renderWithProviders(node);
    expect(
      container.querySelector('[data-component-kind="variant-selector"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('no product in scope');
  });

  it('emits a variant-selector with a nested add-to-cart island, resolving the selected variant', async () => {
    const product: ProductDTO = {
      id: 'p1',
      handle: 'h',
      title: 'T',
      description: null,
      options: [],
      variantIds: ['v1'],
    };
    const node: ComponentNode = {
      type: 'div',
      id: 'vs',
      props: { 'data-component-kind': 'variant-selector' },
      children: [
        {
          type: 'div',
          id: 'atc',
          props: { 'data-component-kind': 'add-to-cart', label: 'Add' },
        },
      ],
    };
    const scope = pushProductFrame(createScope(), product);
    const { container } = renderWithProviders(node, scope);

    // The add-to-cart island mounts inside the variant-selector's selection
    // context and enables once the (single, optionless) variant resolves.
    await waitFor(() => {
      const button = container.querySelector('[data-add-to-cart]') as HTMLButtonElement;
      expect(button).not.toBeNull();
      expect(button.disabled).toBe(false);
    });
  });
});
