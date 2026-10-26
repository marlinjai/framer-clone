// CheckoutButton: the storefront control that turns the client cart into a paid
// order. The flow is: cart -> place order -> DEMO payment step -> confirmation.
//
//   1. PLACE: it posts the useCart() lines ({ variantId, quantity } INTENTIONS
//      only, never a price or stock number) to POST /api/commerce/orders, where
//      the server authors money + stock inside Track B's atomic transaction and
//      returns the AUTHORITATIVE total. A client-owned idempotency key makes a
//      double-submit / back-then-resubmit return the SAME order, never a
//      duplicate.
//   2. PAY (DEMO / FAKE): a clearly-labeled simulated payment step authorizes the
//      authoritative total through the `PaymentGateway` seam
//      (src/lib/commerce/payment). The ONLY gateway today is the
//      FakePaymentGateway: it moves NO real money. The UI renders an unmistakable
//      demo banner so a viewer is never misled into thinking a real charge
//      happened. This is the SEAM where a real provider (Stripe / Adyen / Stripe
//      Connect) plugs in: swap getPaymentGateway(), nothing else in this file
//      changes.
//   3. CONFIRM: on a successful (simulated) authorization the cart is CLEARED and
//      a confirmation shows the order id, the server-computed total, and the demo
//      transaction reference.
//
// Every terminal outcome is surfaced, never swallowed:
//   - 409 shortage at PLACE: the cart is NOT cleared, the per-line shortages are
//     surfaced, and the next action is shown. No payment is attempted (the
//     out-of-stock path is handled BEFORE any charge).
//   - 422 unknown_variant at PLACE (an item no longer sold here): the cart is NOT
//     cleared and the visitor is told to remove the unavailable items.
//   - an order-create fault (any other status / a network error): a loud error,
//     never a false confirmation.
//   - a declined payment: the server closed the order (its stock went back), so
//     the checkout forgets it and the visitor checks out again (a new order);
//     a fault in the payment step keeps the order and retries ONLY the payment.
'use client';

import React from 'react';

import type { ComponentInstance } from '@/models/ComponentModel';
import type { BindingScope } from '@/lib/bindings/resolver/scope';
import { useCart, type CartLine } from '@/lib/commerce/cart';
import { getPaymentGateway, type CheckoutBuyer, type PaymentGateway } from '@/lib/commerce/payment';

/** A single per-line shortage, in the client's variant vocabulary. */
export interface CheckoutShortage {
  variantId: string;
  needed: number;
  available: number;
}

/** A server-authored, placed order awaiting (demo) payment. */
interface PlacedOrder {
  orderId: string;
  /** The number the buyer sees (ORD-000001); the id stays internal. */
  orderNumber: string;
  totalCents: number;
  currency: string;
  /** Who takes the payment: the demo provider (no real money) or Stripe (a hosted checkout page). */
  provider: 'demo' | 'stripe';
}

type CheckoutState =
  | { status: 'idle' }
  | { status: 'placing' }
  | { status: 'shortage'; shortages: CheckoutShortage[] }
  | { status: 'order_error'; message: string }
  | {
      status: 'payment';
      order: PlacedOrder;
      simulateDecline: boolean;
      paying: boolean;
      /** Last decline/fault message for the payment step, or null. */
      paymentError: string | null;
      /** The buyer the receipt is made out to, as typed so far. */
      buyer: CheckoutBuyer;
    }
  | { status: 'confirmed'; order: PlacedOrder; transactionId: string; receiptNumber: string | null }
  | { status: 'redirecting' }
  | { status: 'returned'; outcome: 'paid' | 'cancelled'; orderNumber: string };

const EMPTY_BUYER: CheckoutBuyer = {
  name: '',
  email: '',
  addressLine1: '',
  postalCode: '',
  city: '',
  country: 'DE',
};

/** The buyer fields the receipt needs, with their labels, in form order. */
const BUYER_FIELDS: Array<{ key: keyof CheckoutBuyer; label: string; type?: string; autoComplete: string }> = [
  { key: 'name', label: 'Full name', autoComplete: 'name' },
  { key: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
  { key: 'addressLine1', label: 'Street and number', autoComplete: 'address-line1' },
  { key: 'postalCode', label: 'Postal code', autoComplete: 'postal-code' },
  { key: 'city', label: 'City', autoComplete: 'address-level2' },
  { key: 'country', label: 'Country (two letters, e.g. DE)', autoComplete: 'country' },
];

/** Every field the receipt needs is filled in. */
function buyerComplete(buyer: CheckoutBuyer): boolean {
  return BUYER_FIELDS.every(({ key }) => String(buyer[key] ?? '').trim().length > 0);
}

export interface CheckoutButtonProps {
  node: ComponentInstance;
  /** Kept for dispatch-call parity; this control reads the cart from context. */
  scope: BindingScope;
  /** Host tag for the wrapper (e.g. `div`). */
  hostType?: string;
  /** Already-resolved wrapper props (identity attrs + style + marker). */
  hostProps?: Record<string, unknown>;
  /**
   * Injectable gateway for tests. Defaults to the configured provider seam
   * (getPaymentGateway()), which today is the demo FakePaymentGateway.
   */
  gateway?: PaymentGateway;
}

/** Read a string node prop, falling back when absent or empty. */
function stringProp(
  props: Record<string, unknown> | undefined,
  key: string,
  fallback: string,
): string {
  const raw = props?.[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : fallback;
}

/** Format integer cents for DISPLAY only (the server-computed total is authoritative). */
function formatCents(totalCents: number, currency: string): string {
  return `${(totalCents / 100).toFixed(2)} ${currency}`;
}

/** A stable signature for the current cart, so the idempotency key is reused for
 *  an unchanged cart (double-submit / back-then-resubmit => same order). */
function cartSignature(lines: CartLine[]): string {
  return lines
    .map((line) => `${line.variantId}:${line.quantity}`)
    .sort()
    .join('|');
}

/** A dependency-free, client-owned idempotency key for one checkout attempt. */
function newIdempotencyKey(): string {
  const rand =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return `order_${rand}`;
}

const DEMO_BANNER_STYLE: React.CSSProperties = {
  marginTop: '8px',
  padding: '6px 10px',
  borderRadius: '6px',
  background: '#fffbeb',
  border: '1px solid #fde68a',
  color: '#92400e',
  fontFamily: 'inherit',
  fontSize: '12px',
  fontWeight: 600,
};

const PANEL_STYLE: React.CSSProperties = {
  marginTop: '8px',
  fontFamily: 'inherit',
  fontSize: '13px',
  color: '#111827',
};

function CheckoutButton({ node, hostType = 'div', hostProps = {}, gateway }: CheckoutButtonProps) {
  const cart = useCart();
  const [state, setState] = React.useState<CheckoutState>({ status: 'idle' });

  // The payment gateway is resolved once (the seam). Tests inject a fake.
  const gatewayRef = React.useRef<PaymentGateway | null>(gateway ?? null);
  if (gateway) gatewayRef.current = gateway;
  if (!gatewayRef.current) gatewayRef.current = getPaymentGateway();
  const activeGateway = gatewayRef.current;

  // The idempotency key is regenerated ONLY when the cart contents change, so a
  // re-submit of the SAME cart reuses the key and the server returns the SAME
  // order (no duplicate order, no double reservation).
  const attemptKeyRef = React.useRef<string | null>(null);
  const attemptSignatureRef = React.useRef<string | null>(null);
  // The last successfully placed order for the current signature, so "Back to
  // cart" then re-checkout resumes payment without re-placing.
  const placedRef = React.useRef<{ signature: string; order: PlacedOrder } | null>(null);
  // The buyer as last typed, kept across "Back to cart" and a new checkout after a decline.
  const buyerRef = React.useRef<CheckoutBuyer>(EMPTY_BUYER);

  // Back from a hosted checkout (Stripe appends checkout=paid|cancelled and the order number to the return
  // address): paid clears the cart and thanks the buyer (the receipt is issued once Stripe's webhook arrived);
  // cancelled keeps the cart, and the order's stock goes back when its payment window closes.
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('checkout');
    const orderNumber = params.get('order');
    if ((outcome === 'paid' || outcome === 'cancelled') && orderNumber) {
      if (outcome === 'paid') cart.clear();
      setState({ status: 'returned', outcome, orderNumber });
    }
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const label = stringProp(node.props as Record<string, unknown> | undefined, 'label', 'Checkout');
  const payLabel = stringProp(node.props as Record<string, unknown> | undefined, 'payLabel', 'Pay');

  const idempotencyKeyFor = (signature: string): string => {
    if (attemptSignatureRef.current !== signature || !attemptKeyRef.current) {
      attemptKeyRef.current = newIdempotencyKey();
      attemptSignatureRef.current = signature;
    }
    return attemptKeyRef.current;
  };

  const goToPayment = (order: PlacedOrder) => {
    setState((prev) => ({
      status: 'payment',
      order,
      simulateDecline: false,
      paying: false,
      paymentError: null,
      // Keep what was typed when coming back to the same order.
      buyer: prev.status === 'payment' ? prev.buyer : buyerRef.current,
    }));
  };

  // STEP 1: place the order (server authors money + stock). Out-of-stock and
  // faults are handled HERE, before any payment is attempted.
  const placeOrder = async () => {
    if (cart.lines.length === 0) return;
    if (state.status === 'placing') return;

    const signature = cartSignature(cart.lines);

    // Resume an already-placed order for the unchanged cart instead of re-placing
    // (handles "Back to cart" -> re-checkout without a duplicate).
    const placed = placedRef.current;
    if (placed && placed.signature === signature) {
      goToPayment(placed.order);
      return;
    }

    const idempotencyKey = idempotencyKeyFor(signature);
    setState({ status: 'placing' });

    // Post INTENTIONS only (+ the client-owned idempotency key): variantId +
    // quantity, never a price or stock number.
    const body = {
      lines: cart.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
      idempotencyKey,
    };

    try {
      const res = await fetch('/api/commerce/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.status === 201) {
        const data = (await res.json()) as PlacedOrder;
        const order: PlacedOrder = {
          orderId: data.orderId,
          orderNumber: data.orderNumber,
          totalCents: data.totalCents,
          currency: data.currency,
          provider: data.provider === 'stripe' ? 'stripe' : 'demo',
        };
        placedRef.current = { signature, order };
        goToPayment(order);
        return;
      }

      if (res.status === 409) {
        const data = (await res.json()) as { ok: false; shortages: CheckoutShortage[] };
        // A shortage is NOT a success: keep the cart intact so the visitor can
        // adjust, and surface which lines fell short + the next action.
        setState({ status: 'shortage', shortages: data.shortages ?? [] });
        return;
      }

      if (res.status === 422) {
        // An item the storefront no longer sells (unknown_variant): NOT a stock
        // shortage and NOT a server fault. Keep the cart and tell the visitor
        // what to do next.
        setState({
          status: 'order_error',
          message:
            'some items in your cart are no longer available. Remove them and try again.',
        });
        return;
      }

      // Any other status is a server fault: surface it, never a false confirm.
      const text = await res.text();
      setState({
        status: 'order_error',
        message: `order failed (${res.status})${text ? `: ${text}` : ''}`,
      });
    } catch (err) {
      setState({
        status: 'order_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // STEP 2: authorize the (DEMO) payment for the AUTHORITATIVE server total.
  const pay = async () => {
    if (state.status !== 'payment' || state.paying) return;
    const { order, simulateDecline, buyer } = state;
    if (!buyerComplete(buyer)) {
      setState({ ...state, paymentError: 'fill in your name, email and address: the receipt is made out to them' });
      return;
    }
    setState({ ...state, paying: true, paymentError: null });

    try {
      const result = await activeGateway.authorize({
        orderId: order.orderId,
        amountCents: order.totalCents,
        currency: order.currency,
        simulateDecline: order.provider === 'demo' ? simulateDecline : false,
        buyer,
        returnPath: `${window.location.pathname}${window.location.search}`,
      });

      if (result.ok && result.redirectUrl) {
        // A hosted checkout (Stripe): the buyer pays there; the shop hears of it by webhook. The cart is
        // cleared when the buyer comes back paid (see the checkout=paid return below).
        setState({ status: 'redirecting' });
        window.location.assign(result.redirectUrl);
        return;
      }

      if (result.ok) {
        // Paid: clear the cart and the attempt so a fresh checkout starts clean.
        cart.clear();
        attemptKeyRef.current = null;
        attemptSignatureRef.current = null;
        placedRef.current = null;
        setState({
          status: 'confirmed',
          order,
          transactionId: result.transactionId,
          receiptNumber: result.receiptNumber ?? null,
        });
        return;
      }

      if (result.code === 'declined' || result.code === 'closed') {
        // The server closed this order (its stock went back): a retry needs a NEW order, so forget this one
        // and its idempotency key. The cart stays; the visitor checks out again.
        attemptKeyRef.current = null;
        attemptSignatureRef.current = null;
        placedRef.current = null;
        setState({
          status: 'order_error',
          message: `${result.message}. Your cart is kept: check out again to try once more.`,
        });
        return;
      }

      // Declined / invalid / gateway error: surface it, keep the order so the
      // visitor can retry payment. Never a false confirmation.
      setState((prev) =>
        prev.status === 'payment'
          ? { ...prev, paying: false, paymentError: result.message }
          : prev,
      );
    } catch (err) {
      setState((prev) =>
        prev.status === 'payment'
          ? {
              ...prev,
              paying: false,
              paymentError: err instanceof Error ? err.message : String(err),
            }
          : prev,
      );
    }
  };

  const wrapperProps: Record<string, unknown> = { ...hostProps };
  delete wrapperProps.children;

  const placing = state.status === 'placing';
  const inPayment = state.status === 'payment';
  const idleDisabled = placing || cart.lines.length === 0;

  // The primary checkout button is hidden once the payment step / confirmation is
  // shown (the flow has moved on); the shortage/error states keep it for retry.
  const showCheckoutButton =
    !inPayment && state.status !== 'confirmed' && state.status !== 'redirecting' && !(state.status === 'returned' && state.outcome === 'paid');

  return React.createElement(
    hostType,
    wrapperProps,
    showCheckoutButton ? (
      <button
        type="button"
        data-checkout
        disabled={idleDisabled}
        aria-disabled={idleDisabled}
        onClick={placeOrder}
        style={{
          padding: '8px 16px',
          border: '1px solid #111827',
          borderRadius: '6px',
          background: idleDisabled ? '#9ca3af' : '#111827',
          color: '#ffffff',
          cursor: idleDisabled ? 'not-allowed' : 'pointer',
          fontFamily: 'inherit',
          fontSize: '14px',
        }}
      >
        {placing ? 'Placing order...' : label}
      </button>
    ) : null,
    renderOutcome(state, {
      payLabel,
      isDemo: activeGateway.isDemo && !(state.status === 'payment' && state.order.provider === 'stripe'),
      onPay: pay,
      onToggleDecline: (next) =>
        setState((prev) => (prev.status === 'payment' ? { ...prev, simulateDecline: next } : prev)),
      onBuyerChange: (key, value) =>
        setState((prev) => {
          if (prev.status !== 'payment') return prev;
          const buyer = { ...prev.buyer, [key]: value };
          buyerRef.current = buyer;
          return { ...prev, buyer };
        }),
      onBackToCart: () => setState({ status: 'idle' }),
    }),
  );
}

interface OutcomeHandlers {
  payLabel: string;
  isDemo: boolean;
  onPay: () => void;
  onToggleDecline: (next: boolean) => void;
  onBuyerChange: (key: keyof CheckoutBuyer, value: string) => void;
  onBackToCart: () => void;
}

/** Render the step/outcome panel (payment / confirmation / shortage / error). */
function renderOutcome(state: CheckoutState, handlers: OutcomeHandlers): React.ReactNode {
  if (state.status === 'payment') {
    const { order, simulateDecline, paying, paymentError, buyer } = state;
    const total = formatCents(order.totalCents, order.currency);
    return (
      <div data-checkout-payment style={PANEL_STYLE}>
        {handlers.isDemo ? (
          <div data-checkout-demo-badge style={DEMO_BANNER_STYLE}>
            Demo payment. No real charge will be made.
          </div>
        ) : null}
        <div data-checkout-payment-total style={{ marginTop: '8px', fontWeight: 600 }}>
          Total to pay: {total}
        </div>
        <fieldset data-checkout-buyer style={{ border: 'none', margin: '8px 0 0', padding: 0, display: 'grid', gap: '6px' }}>
          <legend style={{ fontWeight: 600, padding: 0 }}>Your receipt is made out to</legend>
          {BUYER_FIELDS.map((field) => (
            <label key={field.key} style={{ display: 'grid', gap: '2px', color: '#374151' }}>
              {field.label}
              <input
                type={field.type ?? 'text'}
                name={field.key}
                required
                autoComplete={field.autoComplete}
                data-checkout-buyer-field={field.key}
                value={String(buyer[field.key] ?? '')}
                disabled={paying}
                onChange={(event) => handlers.onBuyerChange(field.key, event.target.value)}
                style={{
                  padding: '6px 8px',
                  border: '1px solid #d1d5db',
                  borderRadius: '6px',
                  fontFamily: 'inherit',
                  fontSize: '13px',
                }}
              />
            </label>
          ))}
        </fieldset>
        {handlers.isDemo ? (
          <label
            style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px', color: '#6b7280' }}
          >
            <input
              type="checkbox"
              data-checkout-decline-toggle
              checked={simulateDecline}
              disabled={paying}
              onChange={(event) => handlers.onToggleDecline(event.target.checked)}
            />
            Simulate a declined payment
          </label>
        ) : null}
        {paymentError ? (
          <div
            data-checkout-payment-declined
            style={{ marginTop: '8px', color: '#b91c1c' }}
          >
            Payment failed: {paymentError}
          </div>
        ) : null}
        <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
          <button
            type="button"
            data-checkout-pay
            disabled={paying}
            aria-disabled={paying}
            onClick={handlers.onPay}
            style={{
              padding: '8px 16px',
              border: '1px solid #065f46',
              borderRadius: '6px',
              background: paying ? '#9ca3af' : '#065f46',
              color: '#ffffff',
              cursor: paying ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              fontSize: '14px',
            }}
          >
            {paying ? 'Processing payment...' : `${handlers.payLabel} ${total}`}
          </button>
          <button
            type="button"
            data-checkout-cancel
            disabled={paying}
            onClick={handlers.onBackToCart}
            style={{
              padding: '8px 16px',
              border: '1px solid #d1d5db',
              borderRadius: '6px',
              background: '#ffffff',
              color: '#111827',
              cursor: paying ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              fontSize: '14px',
            }}
          >
            Back to cart
          </button>
        </div>
      </div>
    );
  }

  if (state.status === 'redirecting') {
    return (
      <div data-checkout-redirecting style={PANEL_STYLE}>
        Taking you to the secure payment page...
      </div>
    );
  }

  if (state.status === 'returned') {
    return (
      <div data-checkout-returned={state.outcome} style={{ ...PANEL_STYLE, color: state.outcome === 'paid' ? '#065f46' : '#b45309' }}>
        {state.outcome === 'paid'
          ? `Thank you: the payment for order ${state.orderNumber} went through. Keep the order number for any question about your order.`
          : 'The payment was cancelled. Your cart is kept: check out again whenever you are ready.'}
      </div>
    );
  }

  if (state.status === 'confirmed') {
    return (
      <div
        data-checkout-confirmation
        style={{ marginTop: '8px', color: '#065f46', fontFamily: 'inherit', fontSize: '13px' }}
      >
        <div>
          Order {state.order.orderNumber} confirmed. Total: {formatCents(state.order.totalCents, state.order.currency)}.
        </div>
        <div data-checkout-payment-ref style={{ marginTop: '4px', color: '#6b7280' }}>
          Payment reference: {state.transactionId} (simulated payment, no real charge).
        </div>
        {state.receiptNumber ? (
          <div data-checkout-receipt style={{ marginTop: '4px', color: '#6b7280' }}>
            Receipt {state.receiptNumber} is on its way to you.
          </div>
        ) : null}
      </div>
    );
  }

  if (state.status === 'shortage') {
    return (
      <div
        data-checkout-shortage
        style={{ marginTop: '8px', color: '#b45309', fontFamily: 'inherit', fontSize: '13px' }}
      >
        <div>Some items are no longer fully available:</div>
        <ul style={{ margin: '4px 0', paddingLeft: '18px' }}>
          {state.shortages.map((shortage) => (
            <li key={shortage.variantId} data-checkout-shortage-line data-variant-id={shortage.variantId}>
              {shortage.variantId}: wanted {shortage.needed}, available {shortage.available}
            </li>
          ))}
        </ul>
        <div data-checkout-next-action>
          Reduce the quantity of these items (or remove them), then try checkout again.
        </div>
      </div>
    );
  }

  if (state.status === 'order_error') {
    return (
      <div
        data-checkout-error
        style={{ marginTop: '8px', color: '#b91c1c', fontFamily: 'inherit', fontSize: '13px' }}
      >
        Checkout failed: {state.message}
      </div>
    );
  }

  return null;
}

export default CheckoutButton;
