// The fourth review of the designable add to cart and cart (docs/plans/2026-11-02-designable-shop-controls.md,
// slice 2): a quantity draft never outlives its field, the focus after a removal
// checks it landed, the quantity field reads a number the way the order route
// can store it, and the messages a control shows later are announced.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import type { ComponentInstance } from '@/models/ComponentModel';
import { createScope } from '@/lib/bindings/resolver/scope';
import { CommerceDataSourceContext } from '@/lib/commerce/context';
import { InMemoryCommerceDataSource } from '@/lib/commerce/inMemoryCommerceDataSource';
import { CART_STORAGE_KEY, CartProvider, MAX_LINE_QUANTITY, useCart } from '@/lib/commerce/cart';
import { ShopLocaleContext } from '@/lib/commerce/shopRuntime';
import { normalizeShopControl, type ShopTreeNode } from '@/lib/commerce/parts';
import type { CommerceDataSource } from '@/lib/commerce/provider';
import CartView from '../CartView';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const cartControl = (): ShopTreeNode => ({ id: 'c', type: 'div', componentType: 'host', props: { 'data-component-kind': 'cart-view' } });

function renderCart(lines: { variantId: string; quantity: number }[], ds: CommerceDataSource = new InMemoryCommerceDataSource()) {
  window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(lines));
  const node = normalizeShopControl(cartControl(), 'en', 'node');
  const Probe = () => <span data-testid="lines">{JSON.stringify(useCart().lines)}</span>;
  return render(
    <CommerceDataSourceContext.Provider value={ds}>
      <ShopLocaleContext.Provider value="en">
        <CartProvider>
          <CartView node={node as unknown as ComponentInstance} scope={createScope()} hostProps={{ 'data-component-kind': 'cart-view' }} />
          <Probe />
        </CartProvider>
      </ShopLocaleContext.Provider>
    </CommerceDataSourceContext.Provider>,
  );
}

/** A data source over the in-memory one, with some reads replaced and the change listeners in reach. */
function dataSource(overrides: Partial<CommerceDataSource>) {
  const ds = new InMemoryCommerceDataSource();
  const listeners = new Set<() => void>();
  const base = Object.fromEntries(
    Object.getOwnPropertyNames(Object.getPrototypeOf(ds))
      .filter((key) => key !== 'constructor')
      .map((key) => [key, ((ds as never)[key] as (...args: unknown[]) => unknown).bind(ds)]),
  );
  const source = {
    ...base,
    subscribe: (_key: unknown, listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ...overrides,
  } as unknown as CommerceDataSource;
  return { source, changed: () => listeners.forEach((listener) => listener()) };
}

async function quantityField(container: HTMLElement, id = 'var_s_red') {
  return waitFor(() => {
    const found = container.querySelector<HTMLInputElement>(`input[data-cart-qty="${id}"]`);
    expect(found).not.toBeNull();
    return found!;
  });
}

describe('a quantity draft never outlives its field', () => {
  it('a line that fails while its field is edited, then loads again, shows the stored quantity', async () => {
    const real = new InMemoryCommerceDataSource();
    let failing = false;
    const { source, changed } = dataSource({
      getVariant: (id: string) => (failing ? Promise.reject(new Error('offline')) : real.getVariant(id)),
    } as Partial<CommerceDataSource>);
    const errors = console.error;
    console.error = () => {};
    try {
      const { container } = renderCart([{ variantId: 'var_s_red', quantity: 2 }], source);
      const qty = await quantityField(container);
      // A blank draft: the stored quantity stays 2 while the field shows what is typed.
      act(() => {
        fireEvent.change(qty, { target: { value: '' } });
      });
      expect(qty.value).toBe('');

      // The line fails: its field goes without a blur.
      failing = true;
      act(() => changed());
      await waitFor(() => expect(container.querySelector('[data-cart-line-error]')).not.toBeNull());
      expect(container.querySelector('input[data-cart-qty]')).toBeNull();

      // The line loads again: the field shows the stored quantity, not the old blank.
      failing = false;
      act(() => changed());
      const again = await quantityField(container);
      expect(again.value).toBe('2');
    } finally {
      console.error = errors;
    }
  });

  it('a ready line read again in the background keeps the edit in progress', async () => {
    const { source, changed } = dataSource({});
    const { container } = renderCart([{ variantId: 'var_s_red', quantity: 2 }], source);
    const qty = await quantityField(container);
    act(() => {
      fireEvent.change(qty, { target: { value: '' } });
    });
    act(() => changed());
    // Let the re-read settle; the line stays ready and the field keeps the blank.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect((await quantityField(container)).value).toBe('');
  });
});

describe('the focus after a line is removed', () => {
  it('falls back to the lines when the next remove button takes no focus (hidden by the design)', async () => {
    const { container } = renderCart([
      { variantId: 'var_s_red', quantity: 1 },
      { variantId: 'var_s_blue', quantity: 1 },
    ]);
    const [first, next] = await waitFor(() => {
      const red = container.querySelector<HTMLButtonElement>('button[data-cart-remove="var_s_red"]');
      const blue = container.querySelector<HTMLButtonElement>('button[data-cart-remove="var_s_blue"]');
      expect(red).not.toBeNull();
      expect(blue).not.toBeNull();
      return [red!, blue!];
    });
    // A browser ignores focus() on an element that is not rendered (display: none):
    // the call returns and the active element stays where it was. jsdom does no
    // layout, so display: none alone would not stop the focus there; replacing this
    // one button's focus with a call that does nothing gives exactly that observable.
    next.style.display = 'none';
    Object.defineProperty(next, 'focus', { configurable: true, value: () => {} });
    act(() => first.focus());
    act(() => {
      fireEvent.click(first);
    });
    await waitFor(() => expect(container.querySelector('[data-cart-line="var_s_red"]')).toBeNull());
    expect(document.activeElement).toBe(container.querySelector('[data-cart-lines]'));
    expect(document.activeElement).not.toBe(document.body);
  });

  it('still goes to the next remove button when it takes the focus', async () => {
    const { container } = renderCart([
      { variantId: 'var_s_red', quantity: 1 },
      { variantId: 'var_s_blue', quantity: 1 },
    ]);
    const first = await waitFor(() => {
      const red = container.querySelector<HTMLButtonElement>('button[data-cart-remove="var_s_red"]');
      expect(container.querySelector('button[data-cart-remove="var_s_blue"]')).not.toBeNull();
      return red!;
    });
    act(() => first.focus());
    act(() => {
      fireEvent.click(first);
    });
    await waitFor(() => expect(container.querySelector('[data-cart-line="var_s_red"]')).toBeNull());
    expect(document.activeElement).toBe(container.querySelector('button[data-cart-remove="var_s_blue"]'));
  });
});

describe('the quantity field reads a number the way the order route can store it', () => {
  it('"1e3" is 1000, a decimal is its whole part, a huge number is capped, and a blank or an overflow changes nothing', async () => {
    const { container, getByTestId } = renderCart([{ variantId: 'var_s_red', quantity: 2 }]);
    const qty = await quantityField(container);
    const typed = async (value: string, quantity: number) => {
      act(() => {
        fireEvent.change(qty, { target: { value } });
      });
      await waitFor(() => expect(getByTestId('lines').textContent).toBe(JSON.stringify([{ variantId: 'var_s_red', quantity }])));
    };
    await typed('1e3', 1000);
    await typed('2.7', 2);
    await typed('0.4', 1);
    await typed('99999999999999', MAX_LINE_QUANTITY);
    await typed('3', 3);
    // A blank, a lone exponent overflowing to Infinity: the line keeps its quantity.
    await typed('', 3);
    await typed('1e999', 3);
    act(() => {
      fireEvent.blur(qty);
    });
    expect(qty.value).toBe('3');
  });
});
