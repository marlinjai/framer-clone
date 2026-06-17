// AddToCartButton: the disable is a UX hint (no selection / advisory-zero), the
// click adds the SELECTED variant to the client cart, and no server write ever
// happens.
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import type { ComponentInstance } from '@/models/ComponentModel';
import { createScope } from '@/lib/bindings/resolver/scope';
import { CommerceDataSourceContext } from '@/lib/commerce/context';
import type { CommerceDataSource } from '@/lib/commerce/provider';
import type { ProductVariantDTO } from '@/lib/commerce/types';
import { SelectedVariantContext, type SelectionState } from '@/lib/commerce/selection';
import { CartProvider, useCart } from '@/lib/commerce/cart';
import AddToCartButton from '../AddToCartButton';

const VARIANT: ProductVariantDTO = {
  id: 'var_s_red',
  productId: 'p',
  title: 'Small / Red',
  optionValues: [],
};

// A fake data source whose ONLY relevant method is getAvailability. An unknown
// variant throws (a missing record is never a silent zero-stock success).
function makeDS(availabilityByVariant: Record<string, number>): CommerceDataSource {
  return {
    listProducts: async () => ({ products: [], total: 0 }),
    getProduct: async () => null,
    getProductByHandle: async () => null,
    listVariants: async () => [],
    getVariant: async () => null,
    getPrices: async () => [],
    getAvailability: async (variantId: string) => {
      const qty = availabilityByVariant[variantId];
      if (qty === undefined) throw new Error(`no availability for "${variantId}"`);
      return { variantId, locationId: 'all', availableQuantity: qty, stale: false };
    },
    subscribe: () => () => {},
  };
}

function makeNode(props: Record<string, unknown> = {}): ComponentInstance {
  return { props } as unknown as ComponentInstance;
}

// A probe that surfaces the cart lines so a click's effect is observable.
const CartProbe = () => {
  const { lines } = useCart();
  return <span data-testid="lines">{JSON.stringify(lines)}</span>;
};

function renderButton(opts: {
  variant: ProductVariantDTO | null;
  ds: CommerceDataSource;
  node?: ComponentInstance;
  mode?: 'editor' | 'preview';
}) {
  const { variant, ds, node = makeNode(), mode = 'preview' } = opts;
  const selectionState: SelectionState = {
    selection: {},
    variant,
    setOptionValue: () => {},
  };
  return render(
    <CommerceDataSourceContext.Provider value={ds}>
      <CartProvider>
        <SelectedVariantContext.Provider value={selectionState}>
          <AddToCartButton node={node} scope={createScope()} mode={mode} />
        </SelectedVariantContext.Provider>
        <CartProbe />
      </CartProvider>
    </CommerceDataSourceContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('AddToCartButton disable (UX hint, NOT the authority)', () => {
  it('is disabled when no variant is selected', () => {
    const { container } = renderButton({ variant: null, ds: makeDS({}) });
    const button = container.querySelector('button[data-add-to-cart]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('enables once a variant is selected and advisory availability is positive', async () => {
    const { container } = renderButton({ variant: VARIANT, ds: makeDS({ var_s_red: 9 }) });
    await waitFor(() => {
      const button = container.querySelector('button[data-add-to-cart]') as HTMLButtonElement;
      expect(button.disabled).toBe(false);
    });
  });

  it('stays disabled when advisory availability reads zero', async () => {
    const { container } = renderButton({ variant: VARIANT, ds: makeDS({ var_s_red: 0 }) });
    // Allow the availability fetch to resolve, then assert still disabled.
    await waitFor(() => {
      expect(container.querySelector('button[data-add-to-cart]')).not.toBeNull();
    });
    await new Promise((r) => setTimeout(r, 0));
    const button = container.querySelector('button[data-add-to-cart]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('stays disabled and surfaces the error when the availability fetch throws (editor)', async () => {
    // No availability record for var_s_red -> getAvailability throws.
    const { container } = renderButton({ variant: VARIANT, ds: makeDS({}), mode: 'editor' });
    await waitFor(() => {
      const err = container.querySelector('[data-add-to-cart-error]');
      expect(err?.textContent).toContain('Availability check failed');
    });
    const button = container.querySelector('button[data-add-to-cart]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});

describe('AddToCartButton add (client cart, no server write)', () => {
  it('adds the selected variant with the node quantity on click', async () => {
    const { container, getByTestId } = renderButton({
      variant: VARIANT,
      ds: makeDS({ var_s_red: 9 }),
      node: makeNode({ quantity: 2 }),
    });
    await waitFor(() => {
      const button = container.querySelector('button[data-add-to-cart]') as HTMLButtonElement;
      expect(button.disabled).toBe(false);
    });
    act(() => {
      fireEvent.click(container.querySelector('button[data-add-to-cart]')!);
    });
    await waitFor(() => {
      expect(getByTestId('lines').textContent).toBe(
        JSON.stringify([{ variantId: 'var_s_red', quantity: 2 }]),
      );
    });
  });

  it('never performs a server write (fetch) on click', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({} as Response);
    const { container } = renderButton({ variant: VARIANT, ds: makeDS({ var_s_red: 9 }) });
    await waitFor(() => {
      const button = container.querySelector('button[data-add-to-cart]') as HTMLButtonElement;
      expect(button.disabled).toBe(false);
    });
    act(() => {
      fireEvent.click(container.querySelector('button[data-add-to-cart]')!);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('source contract', () => {
  it('documents the disable as a UX hint, never permission to sell', () => {
    const src = readFileSync(path.resolve(__dirname, '../AddToCartButton.tsx'), 'utf8');
    expect(src).toMatch(/UX HINT, NOT THE AUTHORITY/);
    expect(src).toMatch(/reserve-at-checkout/);
  });
});
