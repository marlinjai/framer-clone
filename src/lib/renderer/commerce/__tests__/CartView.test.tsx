// CartView: renders lines, resolves variant + price DTOs for DISPLAY, shows a
// DISPLAY-ONLY estimated subtotal, supports quantity change + line removal, and
// shows an ADVISORY-availability warning (never auto-removing the line). No
// server write happens from any interaction.
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import type { ComponentInstance } from '@/models/ComponentModel';
import { createScope } from '@/lib/bindings/resolver/scope';
import { CommerceDataSourceContext } from '@/lib/commerce/context';
import { InMemoryCommerceDataSource } from '@/lib/commerce/inMemoryCommerceDataSource';
import type { CommerceDataSource } from '@/lib/commerce/provider';
import { CartProvider, CART_STORAGE_KEY, type CartLine } from '@/lib/commerce/cart';
import CartView from '../CartView';

function makeNode(props: Record<string, unknown> = {}): ComponentInstance {
  return { props } as unknown as ComponentInstance;
}

function seedCart(lines: CartLine[]) {
  window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(lines));
}

function renderCart(ds: CommerceDataSource) {
  return render(
    <CommerceDataSourceContext.Provider value={ds}>
      <CartProvider>
        <CartView node={makeNode()} scope={createScope()} hostType="div" hostProps={{}} mode="preview" />
      </CartProvider>
    </CommerceDataSourceContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('CartView display', () => {
  it('shows an empty-cart note when there are no lines', async () => {
    const { container } = renderCart(new InMemoryCommerceDataSource());
    await waitFor(() => {
      expect(container.querySelector('[data-cart-empty]')).not.toBeNull();
    });
  });

  it('renders lines and a DISPLAY-ONLY integer-cents estimated subtotal', async () => {
    seedCart([{ variantId: 'var_s_red', quantity: 2 }]);
    const { container } = renderCart(new InMemoryCommerceDataSource());

    await waitFor(() => {
      expect(container.querySelector('[data-cart-line="var_s_red"]')).not.toBeNull();
    });
    // 2500 cents * 2 = 5000 (integer cents, display only).
    await waitFor(() => {
      const subtotal = container.querySelector('[data-cart-subtotal]');
      expect(subtotal?.getAttribute('data-cart-subtotal-cents')).toBe('5000');
    });
    expect(container.querySelector('[data-cart-subtotal]')?.textContent).toContain(
      'Estimated subtotal',
    );
    expect(container.querySelector('[data-cart-subtotal-note]')?.textContent).toContain(
      'final total is calculated at checkout',
    );
  });

  it('updates the display subtotal when a line quantity changes', async () => {
    seedCart([{ variantId: 'var_s_red', quantity: 2 }]);
    const { container } = renderCart(new InMemoryCommerceDataSource());

    await waitFor(() => {
      expect(
        container.querySelector('[data-cart-subtotal]')?.getAttribute('data-cart-subtotal-cents'),
      ).toBe('5000');
    });

    const input = container.querySelector('input[data-cart-qty="var_s_red"]') as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: '3' } });
    });
    await waitFor(() => {
      expect(
        container.querySelector('[data-cart-subtotal]')?.getAttribute('data-cart-subtotal-cents'),
      ).toBe('7500');
    });
  });

  it('removes a line on the remove control', async () => {
    seedCart([{ variantId: 'var_s_red', quantity: 1 }]);
    const { container } = renderCart(new InMemoryCommerceDataSource());

    await waitFor(() => {
      expect(container.querySelector('[data-cart-line="var_s_red"]')).not.toBeNull();
    });
    act(() => {
      fireEvent.click(container.querySelector('button[data-cart-remove="var_s_red"]')!);
    });
    await waitFor(() => {
      expect(container.querySelector('[data-cart-empty]')).not.toBeNull();
    });
  });

  it('shows an advisory-availability warning without auto-removing the line', async () => {
    // var_s_blue advisory availability aggregates to 7; wanting 10 trips the
    // warning. The line stays (advisory is never authoritative).
    seedCart([{ variantId: 'var_s_blue', quantity: 10 }]);
    const { container } = renderCart(new InMemoryCommerceDataSource());

    await waitFor(() => {
      expect(
        container.querySelector('[data-cart-availability-warning="var_s_blue"]'),
      ).not.toBeNull();
    });
    // NOT auto-removed: the line is still present.
    expect(container.querySelector('[data-cart-line="var_s_blue"]')).not.toBeNull();
  });
});

describe('CartView authors no money client-side and writes nothing to the server', () => {
  it('never calls fetch for a quantity change or a removal', async () => {
    seedCart([{ variantId: 'var_s_red', quantity: 1 }]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({} as Response);
    const { container } = renderCart(new InMemoryCommerceDataSource());

    await waitFor(() => {
      expect(container.querySelector('input[data-cart-qty="var_s_red"]')).not.toBeNull();
    });
    act(() => {
      fireEvent.change(
        container.querySelector('input[data-cart-qty="var_s_red"]') as HTMLInputElement,
        { target: { value: '4' } },
      );
    });
    act(() => {
      fireEvent.click(container.querySelector('button[data-cart-remove="var_s_red"]')!);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('documents the subtotal as a display-only estimate, never authoritative', () => {
    const src = readFileSync(path.resolve(__dirname, '../CartView.tsx'), 'utf8');
    expect(src).toMatch(/DISPLAY ONLY/);
    expect(src).toMatch(/never trusted from the client/);
  });
});
