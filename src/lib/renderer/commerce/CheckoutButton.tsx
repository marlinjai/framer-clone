// CheckoutButton: the storefront control that turns the client cart into an
// order. It posts the useCart() lines ({ variantId, quantity } INTENTIONS only,
// never a price or stock number) to POST /api/commerce/orders, where the server
// authors money + stock inside Track B's atomic transaction.
//
// CLIENT-ONLY. checkout STOPS at order-created: this control NEVER touches a
// payment provider, NEVER redirects to pay, and NEVER renders an invoice (E8,
// deferred). The happy path ends at an order-confirmation; there is no Stripe
// and no pay-redirect anywhere in this file.
//
// Two terminal outcomes, both surfaced (never swallowed):
//   - 201 order-created: the client cart is CLEARED and an order confirmation
//     (order id + the SERVER-computed total) is shown.
//   - 409 shortage: the cart is NOT cleared (the visitor keeps their selection),
//     the per-line shortages are surfaced (which variants fell short, by how
//     much), and the next action is shown. A server fault (any other status, or
//     a network error) surfaces as an error, never a false confirmation.
'use client';

import React from 'react';

import type { ComponentInstance } from '@/models/ComponentModel';
import type { BindingScope } from '@/lib/bindings/resolver/scope';
import { useCart } from '@/lib/commerce/cart';

/** A single per-line shortage, in the client's variant vocabulary. */
export interface CheckoutShortage {
  variantId: string;
  needed: number;
  available: number;
}

type CheckoutState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'confirmed'; orderId: string; totalCents: number; currency: string }
  | { status: 'shortage'; shortages: CheckoutShortage[] }
  | { status: 'error'; message: string };

export interface CheckoutButtonProps {
  node: ComponentInstance;
  /** Kept for dispatch-call parity; this control reads the cart from context. */
  scope: BindingScope;
  /** Host tag for the wrapper (e.g. `div`). */
  hostType?: string;
  /** Already-resolved wrapper props (identity attrs + style + marker). */
  hostProps?: Record<string, unknown>;
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

function CheckoutButton({ node, hostType = 'div', hostProps = {} }: CheckoutButtonProps) {
  const cart = useCart();
  const [state, setState] = React.useState<CheckoutState>({ status: 'idle' });

  const label = stringProp(node.props as Record<string, unknown> | undefined, 'label', 'Checkout');

  const onClick = async () => {
    // Nothing to order: a no-op rather than a pointless empty POST.
    if (cart.lines.length === 0) return;
    if (state.status === 'submitting') return;

    setState({ status: 'submitting' });

    // Post INTENTIONS only: variantId + quantity, never a price or stock number.
    const body = {
      lines: cart.lines.map((line) => ({
        variantId: line.variantId,
        quantity: line.quantity,
      })),
    };

    try {
      const res = await fetch('/api/commerce/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.status === 201) {
        const data = (await res.json()) as {
          orderId: string;
          totalCents: number;
          currency: string;
        };
        // Order created: clear the cart and show the confirmation. This is the
        // STOP, there is no payment step after it.
        cart.clear();
        setState({
          status: 'confirmed',
          orderId: data.orderId,
          totalCents: data.totalCents,
          currency: data.currency,
        });
        return;
      }

      if (res.status === 409) {
        const data = (await res.json()) as {
          ok: false;
          shortages: CheckoutShortage[];
        };
        // A shortage is NOT a success: keep the cart intact so the visitor can
        // adjust, and surface which lines fell short + the next action.
        setState({ status: 'shortage', shortages: data.shortages ?? [] });
        return;
      }

      // Any other status is a server fault: surface it, never a false confirm.
      const text = await res.text();
      setState({
        status: 'error',
        message: `order failed (${res.status})${text ? `: ${text}` : ''}`,
      });
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const submitting = state.status === 'submitting';
  const disabled = submitting || cart.lines.length === 0;

  const wrapperProps: Record<string, unknown> = { ...hostProps };
  delete wrapperProps.children;

  const outcome: React.ReactNode = renderOutcome(state);

  return React.createElement(
    hostType,
    wrapperProps,
    <button
      type="button"
      data-checkout
      disabled={disabled}
      aria-disabled={disabled}
      onClick={onClick}
      style={{
        padding: '8px 16px',
        border: '1px solid #111827',
        borderRadius: '6px',
        background: disabled ? '#9ca3af' : '#111827',
        color: '#ffffff',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: 'Inter, sans-serif',
        fontSize: '14px',
      }}
    >
      {submitting ? 'Placing order...' : label}
    </button>,
    outcome,
  );
}

/** Render the terminal outcome panel (confirmation / shortage / error / nothing). */
function renderOutcome(state: CheckoutState): React.ReactNode {
  if (state.status === 'confirmed') {
    return (
      <div
        data-checkout-confirmation
        style={{ marginTop: '8px', color: '#065f46', fontFamily: 'Inter, sans-serif', fontSize: '13px' }}
      >
        Order {state.orderId} confirmed. Total: {formatCents(state.totalCents, state.currency)}.
      </div>
    );
  }

  if (state.status === 'shortage') {
    return (
      <div
        data-checkout-shortage
        style={{ marginTop: '8px', color: '#b45309', fontFamily: 'Inter, sans-serif', fontSize: '13px' }}
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

  if (state.status === 'error') {
    return (
      <div
        data-checkout-error
        style={{ marginTop: '8px', color: '#b91c1c', fontFamily: 'Inter, sans-serif', fontSize: '13px' }}
      >
        Checkout failed: {state.message}
      </div>
    );
  }

  return null;
}

export default CheckoutButton;
