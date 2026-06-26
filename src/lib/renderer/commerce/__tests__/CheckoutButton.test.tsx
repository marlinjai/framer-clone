// CheckoutButton: cart -> place order -> DEMO payment step -> confirmation.
//   - PLACE 201: the AUTHORITATIVE total is shown in a clearly-labeled demo
//     payment step; the cart is NOT cleared yet (only after a successful pay).
//   - PAY (demo, simulated): on success the cart is CLEARED and the confirmation
//     shows the order id, the server total, and the demo transaction reference.
//   - PAY declined (the demo "simulate decline" toggle): the failure is surfaced,
//     the cart is kept, and a retry succeeds.
//   - PLACE 409 shortage: the cart is kept, the failing lines + next action are
//     surfaced, and NO payment is attempted.
//   - PLACE fault: a loud error, never a false confirmation.
//   - idempotency: the client sends an idempotency key; re-checkout of an
//     unchanged cart does not place a duplicate order.
//   - NO real payment provider exists in the source (documented); the only
//     network call is the order-create seam (the gateway is client-side).
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import type { ComponentInstance } from '@/models/ComponentModel';
import { createScope } from '@/lib/bindings/resolver/scope';
import { CartProvider, useCart, CART_STORAGE_KEY } from '@/lib/commerce/cart';
import { FakePaymentGateway } from '@/lib/commerce/payment';
import type { PaymentGateway, PaymentResult } from '@/lib/commerce/payment';
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

/** The instant (zero-latency) demo gateway so the payment step is deterministic. */
function instantGateway(): PaymentGateway {
  return new FakePaymentGateway({ latencyMs: 0 });
}

/** Seed the persisted cart, then render the button + probe inside a provider. */
function renderCheckout(
  node: ComponentInstance = makeNode(),
  gateway: PaymentGateway = instantGateway(),
) {
  window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(SEEDED_LINES));
  return render(
    <CartProvider>
      <CheckoutButton node={node} scope={createScope()} gateway={gateway} />
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

function clickCheckout(container: HTMLElement) {
  act(() => {
    fireEvent.click(container.querySelector('button[data-checkout]')!);
  });
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('CheckoutButton place order (201) -> demo payment step', () => {
  it('posts intentions + an idempotency key, shows the demo payment step, and does NOT clear the cart yet', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(201, { orderId: 'order_123', totalCents: 4760, currency: 'EUR' }),
    );
    const { container, getByTestId } = renderCheckout();
    await waitForHydratedCart(getByTestId);

    clickCheckout(container);

    // The demo payment step appears with the AUTHORITATIVE total and the demo
    // banner; the primary checkout button is replaced by the payment controls.
    await waitFor(() => {
      expect(container.querySelector('[data-checkout-payment]')).not.toBeNull();
    });
    expect(container.querySelector('[data-checkout-demo-badge]')?.textContent).toMatch(/no real charge/i);
    expect(container.querySelector('[data-checkout-payment-total]')?.textContent).toContain('47.60 EUR');
    // Not paid yet: no confirmation and the cart is intact.
    expect(container.querySelector('[data-checkout-confirmation]')).toBeNull();
    expect(getByTestId('lines').textContent).toBe(JSON.stringify(SEEDED_LINES));

    // The body posted intentions + an idempotency key, never a price/stock.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/commerce/orders');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.lines).toEqual(SEEDED_LINES);
    expect(typeof sent.idempotencyKey).toBe('string');
    expect(sent.idempotencyKey.length).toBeGreaterThanOrEqual(8);
  });
});

describe('CheckoutButton pay (demo, simulated success)', () => {
  it('clears the cart and shows the confirmation + demo transaction reference', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(201, { orderId: 'order_123', totalCents: 4760, currency: 'EUR' }),
    );
    const { container, getByTestId } = renderCheckout();
    await waitForHydratedCart(getByTestId);

    clickCheckout(container);
    await waitFor(() => expect(container.querySelector('[data-checkout-pay]')).not.toBeNull());

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-checkout-pay]')!);
    });

    await waitFor(() => {
      const confirmation = container.querySelector('[data-checkout-confirmation]');
      expect(confirmation?.textContent).toContain('order_123');
      expect(confirmation?.textContent).toContain('47.60 EUR');
    });
    // The demo transaction reference is surfaced and labeled simulated.
    const ref = container.querySelector('[data-checkout-payment-ref]');
    expect(ref?.textContent).toMatch(/demo_txn_/);
    expect(ref?.textContent).toMatch(/simulated/i);
    // The cart was cleared only AFTER the successful payment.
    expect(getByTestId('lines').textContent).toBe('[]');
  });
});

describe('CheckoutButton pay declined (demo decline toggle)', () => {
  it('surfaces the decline, keeps the cart, and a retry succeeds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(201, { orderId: 'order_123', totalCents: 4760, currency: 'EUR' }),
    );
    const { container, getByTestId } = renderCheckout();
    await waitForHydratedCart(getByTestId);

    clickCheckout(container);
    await waitFor(() => expect(container.querySelector('[data-checkout-decline-toggle]')).not.toBeNull());

    // Turn on the demo decline, then pay -> the failure is surfaced.
    act(() => {
      fireEvent.click(container.querySelector('input[data-checkout-decline-toggle]')!);
    });
    await act(async () => {
      fireEvent.click(container.querySelector('button[data-checkout-pay]')!);
    });

    await waitFor(() => {
      expect(container.querySelector('[data-checkout-payment-declined]')?.textContent).toMatch(/declined/i);
    });
    // Declined is NOT a success: no confirmation, cart intact.
    expect(container.querySelector('[data-checkout-confirmation]')).toBeNull();
    expect(getByTestId('lines').textContent).toBe(JSON.stringify(SEEDED_LINES));

    // Untoggle the decline and retry -> success (no second order POST).
    act(() => {
      fireEvent.click(container.querySelector('input[data-checkout-decline-toggle]')!);
    });
    await act(async () => {
      fireEvent.click(container.querySelector('button[data-checkout-pay]')!);
    });
    await waitFor(() => {
      expect(container.querySelector('[data-checkout-confirmation]')?.textContent).toContain('order_123');
    });
    // The order was placed ONCE; the retry only re-attempted payment.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('CheckoutButton place shortage (409)', () => {
  it('keeps the cart, surfaces the failing lines + next action, and attempts NO payment', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(409, {
        ok: false,
        shortages: [{ variantId: 'var_b', needed: 1, available: 0 }],
      }),
    );
    const { container, getByTestId } = renderCheckout();
    await waitForHydratedCart(getByTestId);

    clickCheckout(container);

    await waitFor(() => {
      expect(container.querySelector('[data-checkout-shortage]')).not.toBeNull();
    });
    const failingLine = container.querySelector('[data-checkout-shortage-line]');
    expect(failingLine?.getAttribute('data-variant-id')).toBe('var_b');
    expect(failingLine?.textContent).toContain('available 0');
    expect(container.querySelector('[data-checkout-next-action]')?.textContent).toMatch(/reduce the quantity/i);

    // No payment step, no confirmation, cart intact.
    expect(container.querySelector('[data-checkout-payment]')).toBeNull();
    expect(container.querySelector('[data-checkout-confirmation]')).toBeNull();
    expect(getByTestId('lines').textContent).toBe(JSON.stringify(SEEDED_LINES));
  });
});

describe('CheckoutButton place fault', () => {
  it('surfaces an error (never a false confirmation) on a non-201/409 status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(500, { error: { code: 'commerce_order_failed', message: 'boom' } }),
    );
    const { container, getByTestId } = renderCheckout();
    await waitForHydratedCart(getByTestId);

    clickCheckout(container);

    await waitFor(() => {
      expect(container.querySelector('[data-checkout-error]')?.textContent).toContain('order failed (500)');
    });
    expect(container.querySelector('[data-checkout-payment]')).toBeNull();
    expect(container.querySelector('[data-checkout-confirmation]')).toBeNull();
    expect(getByTestId('lines').textContent).toBe(JSON.stringify(SEEDED_LINES));
  });
});

describe('CheckoutButton idempotency (back to cart -> re-checkout)', () => {
  it('resumes the placed order without posting a duplicate', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(201, { orderId: 'order_123', totalCents: 4760, currency: 'EUR' }),
    );
    const { container, getByTestId } = renderCheckout();
    await waitForHydratedCart(getByTestId);

    clickCheckout(container);
    await waitFor(() => expect(container.querySelector('[data-checkout-cancel]')).not.toBeNull());

    // Go back to the cart, then re-checkout the unchanged cart.
    act(() => {
      fireEvent.click(container.querySelector('button[data-checkout-cancel]')!);
    });
    await waitFor(() => expect(container.querySelector('button[data-checkout]')).not.toBeNull());
    clickCheckout(container);
    await waitFor(() => expect(container.querySelector('[data-checkout-payment]')).not.toBeNull());

    // Only ONE order POST happened across both checkout clicks.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('CheckoutButton empty cart', () => {
  it('disables the button and posts nothing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    // No seeded cart: render directly with an empty provider.
    const { container } = render(
      <CartProvider>
        <CheckoutButton node={makeNode()} scope={createScope()} gateway={instantGateway()} />
      </CartProvider>,
    );
    const button = container.querySelector('button[data-checkout]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    act(() => fireEvent.click(button));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('CheckoutButton gateway fault', () => {
  it('surfaces a thrown gateway error in the payment step, never a false confirmation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(201, { orderId: 'order_9', totalCents: 1000, currency: 'EUR' }),
    );
    const throwingGateway: PaymentGateway = {
      id: 'demo',
      isDemo: true,
      authorize: async (): Promise<PaymentResult> => {
        throw new Error('gateway exploded');
      },
    };
    const { container, getByTestId } = renderCheckout(makeNode(), throwingGateway);
    await waitForHydratedCart(getByTestId);

    clickCheckout(container);
    await waitFor(() => expect(container.querySelector('[data-checkout-pay]')).not.toBeNull());
    await act(async () => {
      fireEvent.click(container.querySelector('button[data-checkout-pay]')!);
    });

    await waitFor(() => {
      expect(container.querySelector('[data-checkout-payment-declined]')?.textContent).toContain('gateway exploded');
    });
    expect(container.querySelector('[data-checkout-confirmation]')).toBeNull();
    expect(getByTestId('lines').textContent).toBe(JSON.stringify(SEEDED_LINES));
  });
});

describe('source contract', () => {
  it('uses the payment gateway seam and integrates NO real provider', () => {
    const src = readFileSync(path.resolve(__dirname, '../CheckoutButton.tsx'), 'utf8');
    // The fake-pay step goes THROUGH the documented gateway seam.
    expect(src).toMatch(/from\s+['"]@\/lib\/commerce\/payment['"]/);
    expect(src).toMatch(/getPaymentGateway/);
    // No real provider integration: no payment-lib import, no provider intent/redirect.
    expect(src).not.toMatch(/from\s+['"][^'"]*stripe[^'"]*['"]/i);
    expect(src).not.toMatch(/@stripe\b/i);
    expect(src).not.toMatch(/redirectToCheckout|payment_intent|stripe\.checkout|createPaymentIntent/i);
    // The ONLY network call is the order-create seam (the gateway is client-side).
    const fetchTargets = [...src.matchAll(/fetch\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(fetchTargets).toEqual(['/api/commerce/orders']);
  });
});
