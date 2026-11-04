// CheckoutButton: cart -> place order -> DEMO payment step -> confirmation.
//   - PLACE 201: the AUTHORITATIVE total is shown in a clearly-labeled demo
//     payment step; the cart is NOT cleared yet (only after a successful pay).
//   - PAY (demo, simulated): on success the cart is CLEARED and the confirmation
//     shows the order number, the server total, and the demo transaction reference.
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
import { CartProvider, CheckoutUnavailableContext, useCart, CART_STORAGE_KEY } from '@/lib/commerce/cart';
import { FakePaymentGateway } from '@/lib/commerce/payment';
import type { PaymentGateway, PaymentResult } from '@/lib/commerce/payment';
import CheckoutButton, { RETURN_NOTE_KEY } from '../CheckoutButton';

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

/** Fill in the buyer the receipt is made out to (the payment step requires it). */
function fillBuyer(container: HTMLElement) {
  const values: Record<string, string> = {
    name: 'Alex Example',
    email: 'alex@example.com',
    addressLine1: 'Beispielweg 2',
    postalCode: '20095',
    city: 'Hamburg',
  };
  act(() => {
    for (const [key, value] of Object.entries(values)) {
      fireEvent.change(container.querySelector(`input[data-checkout-buyer-field="${key}"]`)!, { target: { value } });
    }
  });
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
      fakeResponse(201, { orderId: 'order_123', orderNumber: 'ORD-123', totalCents: 4760, currency: 'EUR' }),
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
      fakeResponse(201, { orderId: 'order_123', orderNumber: 'ORD-123', totalCents: 4760, currency: 'EUR' }),
    );
    const { container, getByTestId } = renderCheckout();
    await waitForHydratedCart(getByTestId);

    clickCheckout(container);
    await waitFor(() => expect(container.querySelector('[data-checkout-pay]')).not.toBeNull());
    fillBuyer(container);

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-checkout-pay]')!);
    });

    await waitFor(() => {
      const confirmation = container.querySelector('[data-checkout-confirmation]');
      expect(confirmation?.textContent).toContain('ORD-123');
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

describe('CheckoutButton confirmation and the receipt email', () => {
  const receiptGateway = (): PaymentGateway => ({
    id: 'demo',
    async authorize() {
      return { ok: true, provider: 'demo', transactionId: 'demo_txn_1', receiptNumber: 'RE-9' } as PaymentResult;
    },
  } as unknown as PaymentGateway);

  async function payWith(confirmationEmail: boolean) {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(201, { orderId: 'order_9', orderNumber: 'ORD-9', totalCents: 4760, currency: 'EUR', confirmationEmail }),
    );
    const { container, getByTestId } = renderCheckout(makeNode(), receiptGateway());
    await waitForHydratedCart(getByTestId);
    clickCheckout(container);
    await waitFor(() => expect(container.querySelector('[data-checkout-pay]')).not.toBeNull());
    fillBuyer(container);
    await act(async () => {
      fireEvent.click(container.querySelector('button[data-checkout-pay]')!);
    });
    await waitFor(() => expect(container.querySelector('[data-checkout-receipt]')).not.toBeNull());
    return container.querySelector('[data-checkout-receipt]')!.textContent;
  }

  it('says where the confirmation goes when the shop emails its buyers', async () => {
    expect(await payWith(true)).toBe('A confirmation with receipt RE-9 is on its way to alex@example.com.');
  });

  it('promises no email when the shop does not send one', async () => {
    expect(await payWith(false)).toBe('Receipt RE-9 is issued.');
  });

  it('before leaving for a hosted checkout, notes the address only for a shop that emails its buyers', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign, pathname: '/cart', search: '' });
    const hosted = { id: 'stripe', authorize: async () => ({ ok: true, redirectUrl: 'https://checkout.stripe.test/pay' }) } as unknown as PaymentGateway;
    for (const confirmationEmail of [true, false]) {
      window.sessionStorage.clear();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        fakeResponse(201, { orderId: 'order_10', orderNumber: 'ORD-10', totalCents: 4760, currency: 'EUR', provider: 'stripe', confirmationEmail }),
      );
      const { container, getByTestId, unmount } = renderCheckout(makeNode(), hosted);
      await waitForHydratedCart(getByTestId);
      clickCheckout(container);
      await waitFor(() => expect(container.querySelector('[data-checkout-pay]')).not.toBeNull());
      fillBuyer(container);
      await act(async () => {
        fireEvent.click(container.querySelector('button[data-checkout-pay]')!);
      });
      await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.test/pay'));
      const note = window.sessionStorage.getItem(RETURN_NOTE_KEY);
      expect(note === null ? null : JSON.parse(note)).toEqual(confirmationEmail ? { orderNumber: 'ORD-10', email: 'alex@example.com' } : null);
      unmount();
      assign.mockClear();
    }
    vi.unstubAllGlobals();
  });
});

describe('CheckoutButton pay declined (demo decline toggle)', () => {
  it('surfaces the decline, keeps the cart, and a new checkout places a new order that pays', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fakeResponse(201, { orderId: 'order_123', orderNumber: 'ORD-123', totalCents: 4760, currency: 'EUR' }))
      .mockResolvedValueOnce(fakeResponse(201, { orderId: 'order_124', orderNumber: 'ORD-124', totalCents: 4760, currency: 'EUR' }));
    const { container, getByTestId } = renderCheckout();
    await waitForHydratedCart(getByTestId);

    clickCheckout(container);
    await waitFor(() => expect(container.querySelector('[data-checkout-decline-toggle]')).not.toBeNull());
    fillBuyer(container);

    // Turn on the demo decline, then pay -> the failure is surfaced.
    act(() => {
      fireEvent.click(container.querySelector('input[data-checkout-decline-toggle]')!);
    });
    await act(async () => {
      fireEvent.click(container.querySelector('button[data-checkout-pay]')!);
    });

    // The declined order is closed on the server: the checkout says so and offers a new one.
    await waitFor(() => {
      expect(container.querySelector('[data-checkout-error]')?.textContent).toMatch(/declined.*check out again/i);
    });
    expect(container.querySelector('[data-checkout-confirmation]')).toBeNull();
    expect(getByTestId('lines').textContent).toBe(JSON.stringify(SEEDED_LINES));

    // Check out again: a NEW order (a new idempotency key), the buyer kept, and this time it pays.
    clickCheckout(container);
    await waitFor(() => expect(container.querySelector('[data-checkout-pay]')).not.toBeNull());
    expect((container.querySelector('input[data-checkout-buyer-field="name"]') as HTMLInputElement).value).toBe('Alex Example');
    await act(async () => {
      fireEvent.click(container.querySelector('button[data-checkout-pay]')!);
    });
    await waitFor(() => {
      expect(container.querySelector('[data-checkout-confirmation]')?.textContent).toContain('ORD-124');
    });
    const posts = vi.mocked(globalThis.fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)).idempotencyKey);
    expect(posts).toHaveLength(2);
    expect(posts[0]).not.toBe(posts[1]);
  });

  it('asks for the buyer before paying and calls no gateway without it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(201, { orderId: 'order_123', orderNumber: 'ORD-123', totalCents: 4760, currency: 'EUR' }),
    );
    const authorize = vi.fn();
    const { container, getByTestId } = renderCheckout(makeNode(), { id: 'demo', isDemo: true, authorize });
    await waitForHydratedCart(getByTestId);
    clickCheckout(container);
    await waitFor(() => expect(container.querySelector('[data-checkout-pay]')).not.toBeNull());
    await act(async () => {
      fireEvent.click(container.querySelector('button[data-checkout-pay]')!);
    });
    // Its own message, as an alert: missing details are not a failed payment.
    const missing = container.querySelector('[data-checkout-buyer-missing]');
    expect(missing?.textContent).toMatch(/name, email and address/);
    expect(missing?.getAttribute('role')).toBe('alert');
    expect(container.querySelector('[data-checkout-payment-declined]')).toBeNull();
    expect(authorize).not.toHaveBeenCalled();
  });
});

describe('CheckoutButton a buyer the shop cannot invoice', () => {
  const REFUSAL = 'This shop can only invoice addresses in Germany. Nothing has been charged.';
  const field = (container: HTMLElement, key: string) =>
    container.querySelector(`input[data-checkout-buyer-field="${key}"]`) as HTMLInputElement;

  it('says why without calling it a failed payment, keeps the input and the order, and pays once corrected', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(fakeResponse(201, { orderId: 'order_123', orderNumber: 'ORD-123', totalCents: 4760, currency: 'EUR' }));
    const authorize = vi
      .fn<PaymentGateway['authorize']>()
      .mockResolvedValueOnce({ ok: false, code: 'refused', message: REFUSAL, fields: ['country'] })
      .mockResolvedValueOnce({ ok: true, provider: 'demo', transactionId: 'order_123', receiptNumber: '1000' });
    const { container, getByTestId } = renderCheckout(makeNode(), { id: 'demo', isDemo: true, authorize });
    await waitForHydratedCart(getByTestId);
    clickCheckout(container);
    await waitFor(() => expect(container.querySelector('[data-checkout-pay]')).not.toBeNull());
    fillBuyer(container);
    act(() => {
      fireEvent.change(field(container, 'country'), { target: { value: 'AT' } });
    });
    await act(async () => {
      fireEvent.click(container.querySelector('button[data-checkout-pay]')!);
    });

    const refusal = container.querySelector('[data-checkout-refused]');
    expect(refusal?.textContent).toBe(REFUSAL);
    expect(refusal?.getAttribute('role')).toBe('alert');
    expect(container.querySelector('[data-checkout-payment-declined]')).toBeNull();
    // Everything typed stays, the field to correct is marked, and the way forward stays open.
    expect(field(container, 'name').value).toBe('Alex Example');
    expect(field(container, 'country').value).toBe('AT');
    expect(field(container, 'country').getAttribute('aria-invalid')).toBe('true');
    expect(field(container, 'country').getAttribute('aria-describedby')).toBe(refusal?.id);
    expect(field(container, 'city').getAttribute('aria-invalid')).toBeNull();
    expect((container.querySelector('button[data-checkout-pay]') as HTMLButtonElement).disabled).toBe(false);
    expect(container.querySelector('button[data-checkout-cancel]')).not.toBeNull();
    expect(getByTestId('lines').textContent).toBe(JSON.stringify(SEEDED_LINES));

    // Correcting the field answers the refusal; the same order pays, nothing is placed again.
    act(() => {
      fireEvent.change(field(container, 'country'), { target: { value: 'DE' } });
    });
    expect(container.querySelector('[data-checkout-refused]')).toBeNull();
    expect(field(container, 'country').getAttribute('aria-invalid')).toBeNull();
    await act(async () => {
      fireEvent.click(container.querySelector('button[data-checkout-pay]')!);
    });
    await waitFor(() => expect(container.querySelector('[data-checkout-confirmation]')).not.toBeNull());
    expect(authorize.mock.calls.map(([request]) => request.orderId)).toEqual(['order_123', 'order_123']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('marks two refused fields together and clears the refusal once both are changed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(201, { orderId: 'order_123', orderNumber: 'ORD-123', totalCents: 4760, currency: 'EUR' }),
    );
    const authorize = vi
      .fn<PaymentGateway['authorize']>()
      .mockResolvedValue({ ok: false, code: 'refused', message: REFUSAL, fields: ['email', 'country'] });
    const { container, getByTestId } = renderCheckout(makeNode(), { id: 'demo', isDemo: true, authorize });
    await waitForHydratedCart(getByTestId);
    clickCheckout(container);
    await waitFor(() => expect(container.querySelector('[data-checkout-pay]')).not.toBeNull());
    fillBuyer(container);
    await act(async () => {
      fireEvent.click(container.querySelector('button[data-checkout-pay]')!);
    });
    expect(field(container, 'email').getAttribute('aria-invalid')).toBe('true');
    expect(field(container, 'country').getAttribute('aria-invalid')).toBe('true');

    act(() => {
      fireEvent.change(field(container, 'email'), { target: { value: 'alex@example.org' } });
    });
    expect(field(container, 'email').getAttribute('aria-invalid')).toBeNull();
    expect(field(container, 'country').getAttribute('aria-invalid')).toBe('true');
    expect(container.querySelector('[data-checkout-refused]')).not.toBeNull();

    act(() => {
      fireEvent.change(field(container, 'country'), { target: { value: 'Germany' } });
    });
    expect(container.querySelector('[data-checkout-refused]')).toBeNull();
  });

  it('names each refusal by its own id when a page carries two checkouts', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(201, { orderId: 'order_123', orderNumber: 'ORD-123', totalCents: 4760, currency: 'EUR' }),
    );
    const authorize = vi.fn<PaymentGateway['authorize']>().mockResolvedValue({ ok: false, code: 'refused', message: REFUSAL, fields: ['country'] });
    const gateway = { id: 'demo', isDemo: true, authorize };
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(SEEDED_LINES));
    const { container, getByTestId } = render(
      <CartProvider>
        <div data-checkout-host>
          <CheckoutButton node={makeNode()} scope={createScope()} gateway={gateway} />
        </div>
        <div data-checkout-host>
          <CheckoutButton node={makeNode()} scope={createScope()} gateway={gateway} />
        </div>
        <CartProbe />
      </CartProvider>,
    );
    await waitForHydratedCart(getByTestId);
    const hosts = Array.from(container.querySelectorAll<HTMLElement>('[data-checkout-host]'));
    for (const host of hosts) {
      clickCheckout(host);
      await waitFor(() => expect(host.querySelector('[data-checkout-pay]')).not.toBeNull());
      fillBuyer(host);
      await act(async () => {
        fireEvent.click(host.querySelector('button[data-checkout-pay]')!);
      });
    }
    const ids = hosts.map((host) => host.querySelector('[data-checkout-refused]')?.id);
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
    hosts.forEach((host, index) => expect(field(host, 'country').getAttribute('aria-describedby')).toBe(ids[index]));
  });

  it('goes back to the cart and returns to the same order with the input kept and the refusal gone', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(fakeResponse(201, { orderId: 'order_123', orderNumber: 'ORD-123', totalCents: 4760, currency: 'EUR' }));
    const authorize = vi.fn<PaymentGateway['authorize']>().mockResolvedValue({ ok: false, code: 'refused', message: REFUSAL, fields: ['country'] });
    const { container, getByTestId } = renderCheckout(makeNode(), { id: 'demo', isDemo: true, authorize });
    await waitForHydratedCart(getByTestId);
    clickCheckout(container);
    await waitFor(() => expect(container.querySelector('[data-checkout-pay]')).not.toBeNull());
    fillBuyer(container);
    await act(async () => {
      fireEvent.click(container.querySelector('button[data-checkout-pay]')!);
    });
    expect(container.querySelector('[data-checkout-refused]')).not.toBeNull();

    act(() => {
      fireEvent.click(container.querySelector('button[data-checkout-cancel]')!);
    });
    clickCheckout(container);
    await waitFor(() => expect(container.querySelector('[data-checkout-pay]')).not.toBeNull());
    expect(container.querySelector('[data-checkout-refused]')).toBeNull();
    expect(field(container, 'name').value).toBe('Alex Example');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('CheckoutButton back from a hosted checkout (Stripe)', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
    window.sessionStorage.clear();
  });

  it('paid: thanks the buyer with the order number, promises no email, and clears the cart', async () => {
    window.history.replaceState(null, '', '/cart?checkout=paid&order=ORD-000005');
    const { container, getByTestId } = renderCheckout();
    await waitFor(() => {
      expect(container.querySelector('[data-checkout-returned="paid"]')?.textContent).toContain('ORD-000005');
    });
    expect(container.textContent).not.toMatch(/email/i);
    await waitFor(() => expect(getByTestId('lines').textContent).toBe('[]'));
  });

  it('paid, from a shop that emails its buyers: names the address the confirmation goes to, once', async () => {
    window.sessionStorage.setItem(RETURN_NOTE_KEY, JSON.stringify({ orderNumber: 'ORD-000007', email: 'alex@example.com' }));
    window.history.replaceState(null, '', '/cart?checkout=paid&order=ORD-000007');
    const { container } = renderCheckout();
    await waitFor(() => {
      expect(container.querySelector('[data-checkout-returned="paid"]')?.textContent).toContain(
        'A confirmation with your receipt is on its way to alex@example.com.',
      );
    });
    expect(window.sessionStorage.getItem(RETURN_NOTE_KEY)).toBeNull();
  });

  it('paid, with a note of another order: promises no email', async () => {
    window.sessionStorage.setItem(RETURN_NOTE_KEY, JSON.stringify({ orderNumber: 'ORD-000001', email: 'alex@example.com' }));
    window.history.replaceState(null, '', '/cart?checkout=paid&order=ORD-000008');
    const { container } = renderCheckout();
    await waitFor(() => expect(container.querySelector('[data-checkout-returned="paid"]')).not.toBeNull());
    expect(container.textContent).not.toMatch(/alex@example\.com|email/i);
  });

  it('cancelled: keeps the cart', async () => {
    window.history.replaceState(null, '', '/cart?checkout=cancelled&order=ORD-000006');
    const { container, getByTestId } = renderCheckout();
    await waitFor(() => {
      expect(container.querySelector('[data-checkout-returned="cancelled"]')).not.toBeNull();
    });
    await waitForHydratedCart(getByTestId);
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

describe('CheckoutButton a shop that cannot take payments yet', () => {
  const UNAVAILABLE = 'This shop cannot take payments yet. Nothing has been charged. Please come back later or contact the shop.';

  it('at place: says so in the words of the shop, starts no payment step and keeps the cart', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(503, { error: { code: 'payments_unavailable', message: UNAVAILABLE } }),
    );
    const authorize = vi.fn<PaymentGateway['authorize']>();
    const { container, getByTestId } = renderCheckout(makeNode(), { id: 'demo', isDemo: true, authorize });
    await waitForHydratedCart(getByTestId);
    clickCheckout(container);

    await waitFor(() => expect(container.querySelector('[data-checkout-error]')?.textContent).toContain(UNAVAILABLE));
    expect(container.querySelector('[data-checkout-error]')?.textContent).not.toContain('order failed');
    expect(container.querySelector('[data-checkout-payment]')).toBeNull();
    expect(authorize).not.toHaveBeenCalled();
    expect(getByTestId('lines').textContent).toBe(JSON.stringify(SEEDED_LINES));
  });

  it('another 503 stays a fault, without echoing the body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(503, 'upstream down'));
    const { container, getByTestId } = renderCheckout();
    await waitForHydratedCart(getByTestId);
    clickCheckout(container);
    await waitFor(() => expect(container.querySelector('[data-checkout-error]')?.textContent).toContain('order failed (503)'));
    expect(container.querySelector('[data-checkout-error]')?.textContent).not.toContain('upstream down');
  });

  it('at pay: no failed payment is claimed, the order and the input are kept, and it pays once the shop can', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(fakeResponse(201, { orderId: 'order_9', orderNumber: 'ORD-9', totalCents: 4760, currency: 'EUR' }));
    const authorize = vi
      .fn<PaymentGateway['authorize']>()
      .mockResolvedValueOnce({ ok: false, code: 'unavailable', message: UNAVAILABLE })
      .mockResolvedValueOnce({ ok: true, provider: 'demo', transactionId: 'order_9', receiptNumber: '1000' });
    const { container, getByTestId } = renderCheckout(makeNode(), { id: 'demo', isDemo: true, authorize });
    await waitForHydratedCart(getByTestId);
    clickCheckout(container);
    await waitFor(() => expect(container.querySelector('[data-checkout-pay]')).not.toBeNull());
    fillBuyer(container);
    await act(async () => {
      fireEvent.click(container.querySelector('button[data-checkout-pay]')!);
    });

    const notice = container.querySelector('[data-checkout-refused]');
    expect(notice?.textContent).toBe(UNAVAILABLE);
    expect(notice?.getAttribute('role')).toBe('alert');
    expect(container.querySelector('[data-checkout-payment-declined]')).toBeNull();
    expect(container.querySelector('input[aria-invalid="true"]')).toBeNull();
    expect((container.querySelector('input[data-checkout-buyer-field="name"]') as HTMLInputElement).value).toBe('Alex Example');
    expect(getByTestId('lines').textContent).toBe(JSON.stringify(SEEDED_LINES));

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-checkout-pay]')!);
    });
    await waitFor(() => expect(container.querySelector('[data-checkout-confirmation]')).not.toBeNull());
    expect(authorize.mock.calls.map(([request]) => request.orderId)).toEqual(['order_9', 'order_9']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
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
      fakeResponse(201, { orderId: 'order_123', orderNumber: 'ORD-123', totalCents: 4760, currency: 'EUR' }),
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
      fakeResponse(201, { orderId: 'order_9', orderNumber: 'ORD-9', totalCents: 1000, currency: 'EUR' }),
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
    fillBuyer(container);
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

describe('CheckoutButton unknown variant (422)', () => {
  it('tells the visitor which action to take and keeps the cart, never a shortage view', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(422, {
        error: { code: 'unknown_variant', message: 'an item in the cart is not available', variantId: 'v' },
      }),
    );
    const { container, getByTestId } = renderCheckout();
    await waitForHydratedCart(getByTestId);

    clickCheckout(container);

    await waitFor(() => {
      expect(container.querySelector('[data-checkout-error]')?.textContent).toContain(
        'no longer available',
      );
    });
    expect(container.querySelector('[data-checkout-error]')?.textContent).not.toContain('{');
    expect(container.querySelector('[data-checkout-shortage]')).toBeNull();
    expect(container.querySelector('[data-checkout-payment]')).toBeNull();
    expect(getByTestId('lines').textContent).toBe(JSON.stringify(SEEDED_LINES));
  });
});


describe('CheckoutButton where checkout is unavailable (the editor preview)', () => {
  afterEach(cleanup);

  it('keeps the designed button, says why when pressed, and never posts an order', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify([{ variantId: 'var_a', quantity: 1 }]));
    const { container } = render(
      <CheckoutUnavailableContext.Provider value="Orders cannot be placed in the editor preview.">
        <CartProvider>
          <CheckoutButton node={makeNode()} scope={createScope()} />
        </CartProvider>
      </CheckoutUnavailableContext.Provider>,
    );
    const button = container.querySelector('[data-checkout]') as HTMLButtonElement;
    // The design is shown as it publishes, not greyed; nothing is said before a press.
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(container.querySelector('[data-checkout-unavailable]')).toBeNull();
    // The note's status region is on the page before the press, empty, so the reason is announced when it arrives.
    const region = container.querySelector<HTMLElement>('[data-checkout-unavailable-region]');
    expect(region?.getAttribute('role')).toBe('status');
    expect(region?.textContent).toBe('');
    act(() => fireEvent.click(button));
    const note = container.querySelector('[data-checkout-unavailable]');
    expect(note?.textContent).toContain('editor preview');
    // The same region holds it; the note carries no role of its own, so nothing is announced twice.
    expect(container.querySelector('[data-checkout-unavailable-region]')).toBe(region);
    expect(note?.parentElement).toBe(region);
    expect(note?.getAttribute('role')).toBeNull();
    expect(container.querySelector('[data-checkout-payment]')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    window.localStorage.clear();
  });
});

describe('CheckoutButton a message shown later is announced', () => {
  const LATER = ['checkout.redirecting', 'checkout.returned-paid', 'checkout.returned-cancelled', 'checkout.confirmation'];

  it('draws the status region of each later message before it, empty and out of the layout', async () => {
    const { container, getByTestId } = renderCheckout();
    await waitForHydratedCart(getByTestId);
    for (const role of LATER) {
      const region = container.querySelector<HTMLElement>(`[data-shop-live="${role}"]`);
      expect(region, role).not.toBeNull();
      expect(region!.getAttribute('role')).toBe('status');
      expect(region!.textContent).toBe('');
      // An empty region adds no gap to the control's column, and stays in the accessibility tree.
      expect(region!.style.position).toBe('absolute');
      expect(region!.style.display).toBe('');
    }
  });

  it('the confirmation arrives in the region that was there during the payment step', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(201, { orderId: 'order_123', orderNumber: 'ORD-123', totalCents: 4760, currency: 'EUR' }),
    );
    const { container, getByTestId } = renderCheckout();
    await waitForHydratedCart(getByTestId);
    clickCheckout(container);
    await waitFor(() => expect(container.querySelector('[data-checkout-pay]')).not.toBeNull());
    const region = container.querySelector<HTMLElement>('[data-shop-live="checkout.confirmation"]');
    expect(region).not.toBeNull();
    expect(region!.textContent).toBe('');
    fillBuyer(container);

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-checkout-pay]')!);
    });

    await waitFor(() => expect(region!.textContent).toContain('ORD-123'));
    expect(container.querySelector('[data-shop-live="checkout.confirmation"]')).toBe(region);
    const confirmation = container.querySelector('[data-checkout-confirmation]')!;
    expect(confirmation.parentElement).toBe(region);
    expect(confirmation.getAttribute('role')).toBeNull();
    // Drawn in the flow again once it holds the message.
    expect(region!.style.position).toBe('');
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(LATER.length);
  });

  it('back from a hosted checkout: the message sits in its region, and the part carries no role', async () => {
    window.history.replaceState(null, '', '/cart?checkout=cancelled&order=ORD-000006');
    try {
      const { container } = renderCheckout();
      await waitFor(() => expect(container.querySelector('[data-checkout-returned="cancelled"]')).not.toBeNull());
      const part = container.querySelector('[data-checkout-returned="cancelled"]')!;
      expect(part.getAttribute('role')).toBeNull();
      expect(part.parentElement?.getAttribute('data-shop-live')).toBe('checkout.returned-cancelled');
      expect(part.parentElement?.getAttribute('role')).toBe('status');
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });
});

describe('CheckoutButton an order too large to store (422 order_too_large)', () => {
  it('says what to change in the buyer\'s words, keeps the cart, and shows no payment step or shortage', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(422, {
        error: {
          code: 'order_too_large',
          message: 'the order is larger than one order can hold; lower a quantity and check out again',
          variantId: 'var_a',
        },
      }),
    );
    const { container, getByTestId } = renderCheckout();
    await waitForHydratedCart(getByTestId);

    clickCheckout(container);

    await waitFor(() => {
      expect(container.querySelector('[data-checkout-error]')?.textContent).toBe(
        'Checkout failed: the order is larger than one order can hold. Lower a quantity in your cart and check out again.',
      );
    });
    // Not read as an item no longer sold, a shortage, or a server fault.
    expect(container.textContent).not.toContain('no longer available');
    expect(container.textContent).not.toContain('422');
    expect(container.querySelector('[data-checkout-shortage]')).toBeNull();
    expect(container.querySelector('[data-checkout-payment]')).toBeNull();
    expect(getByTestId('lines').textContent).toBe(JSON.stringify(SEEDED_LINES));
    // The button stays for another try once the cart is changed.
    expect(container.querySelector('button[data-checkout]')).not.toBeNull();
  });

  it('a total over what the payment provider takes (no line named) gets the same words, and the server\'s are not shown', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(422, {
        error: { code: 'order_too_large', message: 'server words the buyer never sees' },
      }),
    );
    const { container, getByTestId } = renderCheckout();
    await waitForHydratedCart(getByTestId);

    clickCheckout(container);

    await waitFor(() => {
      expect(container.querySelector('[data-checkout-error]')?.textContent).toBe(
        'Checkout failed: the order is larger than one order can hold. Lower a quantity in your cart and check out again.',
      );
    });
    expect(container.textContent).not.toContain('server words');
    expect(getByTestId('lines').textContent).toBe(JSON.stringify(SEEDED_LINES));
  });

  it('a cart mixing prices with and without VAT gets the checkout\'s own words, not the server\'s or "no longer available"', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResponse(422, {
        error: { code: 'mixed_price_basis', message: 'some items are priced with VAT and some without' },
      }),
    );
    const { container, getByTestId } = renderCheckout();
    await waitForHydratedCart(getByTestId);
    clickCheckout(container);
    await waitFor(() => {
      expect(container.querySelector('[data-checkout-error]')?.textContent).toBe(
        'Checkout failed: some items in your cart cannot be ordered together yet. Order them separately, or try again later. Nothing has been charged.',
      );
    });
    expect(container.textContent).not.toContain('priced with VAT');
    expect(container.textContent).not.toContain('no longer available');
  });
});
