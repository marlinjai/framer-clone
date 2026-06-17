// CheckoutButton: posts the client cart and STOPS at order-created.
//   - 201 order-created: the cart is CLEARED and the confirmation (order id +
//     the server-computed total) is shown.
//   - 409 shortage: the cart is NOT cleared, the failing lines are surfaced, and
//     the next action is shown.
//   - no payment / Stripe exists anywhere in the source (documented).
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import type { ComponentInstance } from '@/models/ComponentModel';
import { createScope } from '@/lib/bindings/resolver/scope';
import { CartProvider, useCart, CART_STORAGE_KEY } from '@/lib/commerce/cart';
import CheckoutButton from '../CheckoutButton';

function makeNode(props: Record<string, unknown> = {}): ComponentInstance {
  return { props } as unknown as ComponentInstance;
}

// A probe that surfaces the cart lines so "cleared vs kept" is observable.
const CartProbe = () => {
  const { lines } = useCart();
  return <span data-testid="lines">{JSON.stringify(lines)}</span>;
};

const SEEDED_LINES = [
  { variantId: 'var_a', quantity: 2 },
  { variantId: 'var_b', quantity: 1 },
];

/** Seed the persisted cart, then render the button + probe inside a provider. */
function renderCheckout(node: ComponentInstance = makeNode()) {
  window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(SEEDED_LINES));
  return render(
    <CartProvider>
      <CheckoutButton node={node} scope={createScope()} />
      <CartProbe />
    </CartProvider>,
  );
}

/** A minimal fake Response carrying a status + json/text bodies. */
function fakeResponse(status: number, body: unknown): Response {
  return {
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

async function waitForHydratedCart(getByTestId: (id: string) => HTMLElement) {
  await waitFor(() => {
    expect(getByTestId('lines').textContent).toBe(JSON.stringify(SEEDED_LINES));
  });
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('CheckoutButton success (201 order-created)', () => {
  it('posts intentions only, clears the cart, and shows the confirmation', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(201, { orderId: 'order_123', totalCents: 4760, currency: 'EUR' }),
    );
    const { container, getByTestId } = renderCheckout();
    await waitForHydratedCart(getByTestId);

    act(() => {
      fireEvent.click(container.querySelector('button[data-checkout]')!);
    });

    // Confirmation shows the server-computed total + order id.
    await waitFor(() => {
      const confirmation = container.querySelector('[data-checkout-confirmation]');
      expect(confirmation?.textContent).toContain('order_123');
      expect(confirmation?.textContent).toContain('47.60 EUR');
    });

    // The cart was CLEARED on success.
    expect(getByTestId('lines').textContent).toBe('[]');

    // The body posted intentions ONLY: variantId + quantity, no price/stock.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/commerce/orders');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      lines: SEEDED_LINES,
    });
  });
});

describe('CheckoutButton shortage (409)', () => {
  it('keeps the cart, surfaces the failing lines, and shows the next action', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(409, {
        ok: false,
        shortages: [{ variantId: 'var_b', needed: 1, available: 0 }],
      }),
    );
    const { container, getByTestId } = renderCheckout();
    await waitForHydratedCart(getByTestId);

    act(() => {
      fireEvent.click(container.querySelector('button[data-checkout]')!);
    });

    // The shortage panel surfaces the failing line + the next action.
    await waitFor(() => {
      const shortage = container.querySelector('[data-checkout-shortage]');
      expect(shortage).not.toBeNull();
    });
    const failingLine = container.querySelector('[data-checkout-shortage-line]');
    expect(failingLine?.getAttribute('data-variant-id')).toBe('var_b');
    expect(failingLine?.textContent).toContain('available 0');
    expect(container.querySelector('[data-checkout-next-action]')?.textContent).toMatch(
      /reduce the quantity/i,
    );

    // No confirmation, and the cart is NOT cleared: the visitor keeps selection.
    expect(container.querySelector('[data-checkout-confirmation]')).toBeNull();
    expect(getByTestId('lines').textContent).toBe(JSON.stringify(SEEDED_LINES));
  });
});

describe('CheckoutButton server fault', () => {
  it('surfaces an error (never a false confirmation) on a non-201/409 status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(500, { error: { code: 'commerce_order_failed', message: 'boom' } }),
    );
    const { container, getByTestId } = renderCheckout();
    await waitForHydratedCart(getByTestId);

    act(() => {
      fireEvent.click(container.querySelector('button[data-checkout]')!);
    });

    await waitFor(() => {
      expect(container.querySelector('[data-checkout-error]')?.textContent).toContain('order failed (500)');
    });
    // No false success, and the cart is intact.
    expect(container.querySelector('[data-checkout-confirmation]')).toBeNull();
    expect(getByTestId('lines').textContent).toBe(JSON.stringify(SEEDED_LINES));
  });
});

describe('source contract', () => {
  it('STOPS at order-created: no payment integration code in the source', () => {
    const src = readFileSync(path.resolve(__dirname, '../CheckoutButton.tsx'), 'utf8');
    expect(src).toMatch(/STOPS at order-created/);
    // The absence of payment code is itself a DoD item. We assert no payment
    // INTEGRATION (an import of a payment lib, or a pay-redirect API call), not
    // the mere mention of the deferred concept in the header documentation.
    expect(src).not.toMatch(/from\s+['"][^'"]*stripe[^'"]*['"]/i);
    expect(src).not.toMatch(/@stripe\b/i);
    expect(src).not.toMatch(/redirectToCheckout|payment_intent|stripe\.checkout|createPaymentIntent/i);
    // The only network call is the order-create seam; no pay endpoint is hit.
    const fetchTargets = [...src.matchAll(/fetch\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(fetchTargets).toEqual(['/api/commerce/orders']);
  });
});
