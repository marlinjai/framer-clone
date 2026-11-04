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
//     a fault in the payment step keeps the order and retries ONLY the payment;
//   - a buyer the shop cannot invoice (a 422 from the pay route): no money moved, the order keeps waiting and
//     everything typed stays, so the visitor corrects the named field and pays, or goes back to the cart.
//   - a shop that cannot take payments yet (a 503 payments_unavailable, at PLACE or from the pay route: its
//     Books cannot issue the receipt): the shop's message, that nothing was charged, and no retry offered as
//     the fix. At PLACE nothing was ordered; at pay the order keeps waiting.
//
// What the visitor sees is designed in the editor (docs/plans/2026-11-02-designable-shop-controls.md):
// every button, label, input and message is a child node of the control with a
// role marker (src/lib/commerce/parts.ts). This file owns the behaviour; the
// parts only look and read. `checkoutPart` answers, for one state, what each part
// does, and serves both the live control and the canvas, which previews any state
// with sample data (CheckoutCanvas). A part missing from the tree (a page saved
// before parts, a part moved out of the control) is drawn from its default, so
// the buyer fields, the pay button and the demo notice are always there.
'use client';

import React from 'react';

import type { ComponentInstance } from '@/models/ComponentModel';
import type { BindingScope } from '@/lib/bindings/resolver/scope';
import { useCart, useCheckoutUnavailableReason, type CartLine } from '@/lib/commerce/cart';
import { getPaymentGateway, type CheckoutBuyer, type PaymentGateway, type RefusedBuyerField } from '@/lib/commerce/payment';
import { CHECKOUT_BUYER_FIELDS, CHECKOUT_PREVIEW_STATES, type CheckoutPreviewStateId, type ShopLocale } from '@/lib/commerce/parts';
import { ShopDesignContext, ShopLocaleContext, ShopRuntimeContext, type ShopPartRender, type ShopRuntime } from '@/lib/commerce/shopRuntime';
import { ShopControlContent } from './ShopControlContent';

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
  /** The shop emails the buyer an order confirmation with the receipt (it is connected to Lumitra Mail). */
  confirmationEmail: boolean;
  totalCents: number;
  currency: string;
  /** Who takes the payment: the demo provider (no real money) or Stripe (a hosted checkout page). */
  provider: 'demo' | 'stripe';
}

/**
 * Where the confirmation of an order paid on a hosted checkout goes, noted in this tab before leaving for it
 * (sessionStorage, the tab only) and read once on the return. Storage that throws (a private window, blocked
 * site data) only means the thank-you names no address.
 */
export const RETURN_NOTE_KEY = 'framer-clone:checkout-return';

function writeReturnNote(orderNumber: string, email: string): void {
  try {
    window.sessionStorage.setItem(RETURN_NOTE_KEY, JSON.stringify({ orderNumber, email }));
  } catch {
    // Not remembered: the thank-you then names no address.
  }
}

function readReturnNote(orderNumber: string): string | null {
  try {
    const raw = window.sessionStorage.getItem(RETURN_NOTE_KEY);
    window.sessionStorage.removeItem(RETURN_NOTE_KEY);
    const note = raw ? (JSON.parse(raw) as { orderNumber?: unknown; email?: unknown }) : null;
    return note && note.orderNumber === orderNumber && typeof note.email === 'string' ? note.email : null;
  } catch {
    return null;
  }
}

type CheckoutState =
  | { status: 'idle' }
  | { status: 'placing' }
  | { status: 'shortage'; shortages: CheckoutShortage[] }
  /** `items_unavailable`: the cart names an item no longer sold (its own part); `failed`: anything else. */
  | { status: 'order_error'; reason: 'items_unavailable' | 'failed'; message: string }
  | {
      status: 'payment';
      order: PlacedOrder;
      simulateDecline: boolean;
      paying: boolean;
      /** Pay was pressed before the receipt's fields were filled in. Not a failed payment. */
      buyerMissing: boolean;
      /** Last decline/fault message for the payment step, or null. */
      paymentError: string | null;
      /** Why the shop cannot invoice this buyer (the server's words), or null. Not a failed payment. */
      refusal: { message: string; fields: RefusedBuyerField[] } | null;
      /** The buyer the receipt is made out to, as typed so far. */
      buyer: CheckoutBuyer;
    }
  | { status: 'confirmed'; order: PlacedOrder; transactionId: string; receiptNumber: string | null; email: string }
  | { status: 'redirecting' }
  | { status: 'returned'; outcome: 'paid' | 'cancelled'; orderNumber: string; confirmationTo: string | null };

const EMPTY_BUYER: CheckoutBuyer = {
  name: '',
  email: '',
  addressLine1: '',
  postalCode: '',
  city: '',
  country: 'DE',
};

/** How each buyer field behaves (never the designer's to change): its input type and autocomplete token. */
const BUYER_INPUTS: Record<(typeof CHECKOUT_BUYER_FIELDS)[number]['key'], { type: string; autoComplete: string }> = {
  name: { type: 'text', autoComplete: 'name' },
  email: { type: 'email', autoComplete: 'email' },
  addressLine1: { type: 'text', autoComplete: 'address-line1' },
  postalCode: { type: 'text', autoComplete: 'postal-code' },
  city: { type: 'text', autoComplete: 'address-level2' },
  country: { type: 'text', autoComplete: 'country' },
};

/** Every field the receipt needs is filled in. */
function buyerComplete(buyer: CheckoutBuyer): boolean {
  return CHECKOUT_BUYER_FIELDS.every(({ key }) => String(buyer[key] ?? '').trim().length > 0);
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
  /**
   * The control's child nodes, already drawn by the surface's renderer (the
   * canvas and the editor's Preview). Absent on a published page, where the
   * control draws its own children from `node`.
   */
  children?: React.ReactNode;
  /** `canvas`: the design surface, a preview state with sample data and no behaviour. */
  surface?: 'live' | 'canvas';
}

/** Format integer cents for DISPLAY only (the server-computed total is authoritative). */
function formatCents(totalCents: number, currency: string, locale: ShopLocale = 'en'): string {
  const amount = (totalCents / 100).toFixed(2);
  return `${locale === 'de' ? amount.replace('.', ',') : amount} ${currency}`;
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

/** The checkout's own words inside a `{message}`: the server's and the browser's arrive as they are. */
const MESSAGES = {
  en: {
    paymentsUnavailable: 'this shop cannot take payments yet. Nothing has been charged.',
    orderFailed: (status: number) => `order failed (${status})`,
    declined: (message: string) => `${message}. Your cart is kept: check out again to try once more.`,
  },
  de: {
    paymentsUnavailable: 'dieser Shop kann noch keine Zahlungen annehmen. Es wurde nichts abgebucht.',
    orderFailed: (status: number) => `Serverfehler (${status})`,
    declined: (message: string) => `${message}. Ihr Warenkorb bleibt erhalten: Gehen Sie erneut zur Kasse, um es noch einmal zu versuchen.`,
  },
} as const;

const UNAVAILABLE_NOTE_STYLE: React.CSSProperties = { margin: 0, fontFamily: 'inherit', fontSize: '12px', opacity: 0.75 };

export default function CheckoutButton(props: CheckoutButtonProps) {
  return props.surface === 'canvas' ? <CheckoutCanvas {...props} /> : <CheckoutLive {...props} />;
}

function CheckoutLive({ node, scope, hostType = 'div', hostProps = {}, gateway, children }: CheckoutButtonProps) {
  const cart = useCart();
  const locale = React.useContext(ShopLocaleContext);
  const unavailableReason = useCheckoutUnavailableReason();
  const [state, setState] = React.useState<CheckoutState>({ status: 'idle' });
  // Where checkout cannot work (the editor's Preview), a press says why instead of greying the design.
  const [noteShown, setNoteShown] = React.useState(false);
  // A page can carry several checkout buttons; each refusal is named by its own field.
  const refusalId = React.useId();
  const messages = MESSAGES[locale];

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
      const noted = readReturnNote(orderNumber);
      setState({ status: 'returned', outcome, orderNumber, confirmationTo: outcome === 'paid' ? noted : null });
    }
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      buyerMissing: false,
      paymentError: null,
      refusal: null,
      // Keep what was typed when coming back to the same order.
      buyer: prev.status === 'payment' ? prev.buyer : buyerRef.current,
    }));
  };

  // STEP 1: place the order (server authors money + stock). Out-of-stock and
  // faults are handled HERE, before any payment is attempted.
  const placeOrder = async () => {
    if (unavailableReason !== null) {
      // No order can be placed here: say so, post nothing.
      setNoteShown(true);
      return;
    }
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
          confirmationEmail: data.confirmationEmail === true,
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

      if (res.status === 503) {
        // The shop cannot take payments yet (payments_unavailable: its Books cannot issue the receipt). Nothing was
        // ordered or reserved; the shop's own message says so. Any other 503 is a fault like the rest below.
        const error = ((await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null)?.error;
        if (error?.code === 'payments_unavailable') {
          setState({ status: 'order_error', reason: 'failed', message: error.message ?? messages.paymentsUnavailable });
          return;
        }
        setState({ status: 'order_error', reason: 'failed', message: messages.orderFailed(res.status) });
        return;
      }

      if (res.status === 422) {
        // An item the storefront no longer sells (unknown_variant): NOT a stock
        // shortage and NOT a server fault. Keep the cart and tell the visitor
        // what to do next (its own part, in the shop's words).
        setState({ status: 'order_error', reason: 'items_unavailable', message: '' });
        return;
      }

      // Any other status is a server fault: surface it, never a false confirm.
      const text = await res.text();
      setState({
        status: 'order_error',
        reason: 'failed',
        message: `${messages.orderFailed(res.status)}${text ? `: ${text}` : ''}`,
      });
    } catch (err) {
      setState({
        status: 'order_error',
        reason: 'failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // STEP 2: authorize the (DEMO) payment for the AUTHORITATIVE server total.
  const pay = async () => {
    if (state.status !== 'payment' || state.paying) return;
    const { order, simulateDecline, buyer } = state;
    if (!buyerComplete(buyer)) {
      setState({ ...state, buyerMissing: true, paymentError: null });
      return;
    }
    setState({ ...state, paying: true, buyerMissing: false, paymentError: null, refusal: null });

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
        // The thank-you after the return names where the confirmation goes, when the shop sends one.
        if (order.confirmationEmail) writeReturnNote(order.orderNumber, buyer.email);
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
          email: buyer.email,
        });
        return;
      }

      if (result.code === 'declined' || result.code === 'closed') {
        // The server closed this order (its stock went back): a retry needs a NEW order, so forget this one
        // and its idempotency key. The cart stays; the visitor checks out again.
        attemptKeyRef.current = null;
        attemptSignatureRef.current = null;
        placedRef.current = null;
        setState({ status: 'order_error', reason: 'failed', message: messages.declined(result.message) });
        return;
      }

      // Refused (a buyer the shop cannot invoice) or unavailable (a shop that cannot take payments yet): no money
      // moved and the order keeps waiting. The shop's own message, without the "Payment failed" prefix.
      if (result.code === 'refused' || result.code === 'unavailable') {
        setState((prev) =>
          prev.status === 'payment'
            ? { ...prev, paying: false, refusal: { message: result.message, fields: result.fields ?? [] } }
            : prev,
        );
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

  const handlers: CheckoutHandlers = {
    onPlaceOrder: placeOrder,
    onPay: pay,
    onToggleDecline: (next) =>
      setState((prev) => (prev.status === 'payment' ? { ...prev, simulateDecline: next } : prev)),
    onBuyerChange: (key, value) =>
      setState((prev) => {
        if (prev.status !== 'payment') return prev;
        const buyer = { ...prev.buyer, [key]: value };
        buyerRef.current = buyer;
        // A refused field stands only until the visitor changes it; the refusal until none is left.
        const fields = prev.refusal?.fields.filter((field) => field !== key) ?? [];
        const answered = prev.refusal !== null && prev.refusal.fields.length > 0 && fields.length === 0;
        return { ...prev, buyer, refusal: prev.refusal && !answered ? { ...prev.refusal, fields } : null };
      }),
    onBackToCart: () => setState({ status: 'idle' }),
  };

  const runtime = checkoutRuntime({
    state,
    locale,
    cartEmpty: cart.lines.length === 0,
    isDemo: activeGateway.isDemo && !(state.status === 'payment' && state.order.provider === 'stripe'),
    refusalId,
    handlers,
  });

  const wrapperProps: Record<string, unknown> = { ...hostProps };
  delete wrapperProps.children;

  return React.createElement(
    hostType,
    wrapperProps,
    <ShopRuntimeContext.Provider value={runtime}>
      <ShopControlContent node={node} kind="checkout-button" locale={locale} drawn={children} scope={scope} />
    </ShopRuntimeContext.Provider>,
    unavailableReason && noteShown ? (
      <p data-checkout-unavailable role="status" style={UNAVAILABLE_NOTE_STYLE}>
        {unavailableReason}
      </p>
    ) : null,
  );
}

// ---------------------------------------------------------------------------
// What each part does
// ---------------------------------------------------------------------------

interface CheckoutHandlers {
  onPlaceOrder: () => void;
  onPay: () => void;
  onToggleDecline: (next: boolean) => void;
  onBuyerChange: (key: keyof CheckoutBuyer, value: string) => void;
  onBackToCart: () => void;
}

interface CheckoutView {
  state: CheckoutState;
  locale: ShopLocale;
  cartEmpty: boolean;
  isDemo: boolean;
  refusalId: string;
  /** Null on the canvas: nothing there does anything, and inputs are read only. */
  handlers: CheckoutHandlers | null;
}

/** Whether the refusal names this buyer field. */
function refused(refusal: { fields: RefusedBuyerField[] } | null, key: keyof CheckoutBuyer): boolean {
  return refusal?.fields.some((field) => field === key) ?? false;
}

const HIDDEN: ShopPartRender = { visible: false };
const SHOWN: ShopPartRender = { visible: true };

/** The checkout's runtime for its parts, from one state. The live control and the canvas both use it. */
function checkoutRuntime(view: CheckoutView): ShopRuntime {
  return {
    kind: 'checkout-button',
    locale: view.locale,
    surface: view.handlers ? 'live' : 'canvas',
    part: (role) => checkoutPart(role, view),
  };
}

function checkoutPart(role: string, view: CheckoutView): ShopPartRender {
  const { state, locale, handlers } = view;
  const live = handlers !== null;
  const shown = (visible: boolean, render: Omit<ShopPartRender, 'visible'> = {}): ShopPartRender =>
    visible ? { visible: true, ...render } : HIDDEN;

  const placing = state.status === 'placing';
  // The primary checkout button is hidden once the payment step / confirmation is
  // shown (the flow has moved on); the shortage/error states keep it for retry.
  const showCheckoutButton =
    state.status !== 'payment' &&
    state.status !== 'confirmed' &&
    state.status !== 'redirecting' &&
    !(state.status === 'returned' && state.outcome === 'paid');
  const idleDisabled = placing || view.cartEmpty;

  switch (role) {
    case 'checkout.button':
      return shown(showCheckoutButton, {
        props: {
          type: 'button',
          'data-checkout': '',
          disabled: idleDisabled,
          'aria-disabled': idleDisabled,
          'aria-busy': placing || undefined,
          ...(live ? { onClick: handlers.onPlaceOrder } : {}),
        },
      });
    case 'checkout.button-label':
      return shown(!placing);
    case 'checkout.button-loading':
      return shown(placing);
    case 'checkout.redirecting':
      return shown(state.status === 'redirecting', { props: { 'data-checkout-redirecting': '', role: 'status' } });
    case 'checkout.returned-cancelled':
      return shown(state.status === 'returned' && state.outcome === 'cancelled', {
        props: { 'data-checkout-returned': 'cancelled', role: 'status' },
      });
    case 'checkout.items-unavailable':
      return shown(state.status === 'order_error' && state.reason === 'items_unavailable', {
        props: { 'data-checkout-error': '', role: 'alert' },
      });
    case 'checkout.error':
      return shown(state.status === 'order_error' && state.reason === 'failed', {
        props: { 'data-checkout-error': '', role: 'alert' },
        tokens: { message: state.status === 'order_error' ? state.message : '' },
      });
  }

  if (role.startsWith('checkout.returned-')) {
    if (state.status !== 'returned' || state.outcome !== 'paid') return HIDDEN;
    if (role === 'checkout.returned-paid') return shown(true, { props: { 'data-checkout-returned': 'paid', role: 'status' } });
    if (role === 'checkout.returned-paid-text') return shown(true, { tokens: { orderNumber: state.orderNumber } });
    if (role === 'checkout.returned-email') return shown(state.confirmationTo !== null, { tokens: { email: state.confirmationTo ?? '' } });
    if (role === 'checkout.returned-keep') return shown(state.confirmationTo === null);
    return HIDDEN;
  }

  if (role === 'checkout.confirmation' || role === 'checkout.confirmed' || role === 'checkout.payment-ref' || role.startsWith('checkout.receipt')) {
    if (state.status !== 'confirmed') return HIDDEN;
    const tokens = {
      orderNumber: state.order.orderNumber,
      total: formatCents(state.order.totalCents, state.order.currency, locale),
      transactionId: state.transactionId,
      receiptNumber: state.receiptNumber ?? '',
      email: state.email,
    };
    if (role === 'checkout.confirmation') return shown(true, { props: { 'data-checkout-confirmation': '', role: 'status' } });
    if (role === 'checkout.confirmed') return shown(true, { tokens });
    if (role === 'checkout.payment-ref') return shown(true, { tokens, props: { 'data-checkout-payment-ref': '' } });
    if (role === 'checkout.receipt-email') {
      return shown(state.receiptNumber !== null && state.order.confirmationEmail, { tokens, props: { 'data-checkout-receipt': '' } });
    }
    if (role === 'checkout.receipt') {
      return shown(state.receiptNumber !== null && !state.order.confirmationEmail, { tokens, props: { 'data-checkout-receipt': '' } });
    }
    return HIDDEN;
  }

  if (role.startsWith('checkout.shortage')) {
    if (state.status !== 'shortage') return HIDDEN;
    if (role === 'checkout.shortage') return shown(true, { props: { 'data-checkout-shortage': '', role: 'alert' } });
    if (role === 'checkout.shortage-next') return shown(true, { props: { 'data-checkout-next-action': '' } });
    if (role === 'checkout.shortage-line') {
      return shown(true, {
        items: state.shortages.map((shortage) => ({
          key: shortage.variantId,
          tokens: { item: shortage.variantId, needed: String(shortage.needed), available: String(shortage.available) },
          props: { 'data-checkout-shortage-line': '', 'data-variant-id': shortage.variantId },
        })),
      });
    }
    return SHOWN;
  }

  // Everything else belongs to the payment step.
  if (state.status !== 'payment') return HIDDEN;
  const { order, simulateDecline, paying, paymentError, refusal, buyer } = state;
  const total = formatCents(order.totalCents, order.currency, locale);

  // Each field's label names its input whatever the designer does with the layout:
  // the label points at the input, the input at the label's text.
  const fieldId = (key: string) => `${view.refusalId}-field-${key}`;
  if (role.startsWith('checkout.field.')) {
    return shown(true, { props: { htmlFor: fieldId(role.slice('checkout.field.'.length)) } });
  }
  if (role.startsWith('checkout.field-text.')) {
    return shown(true, { props: { id: `${fieldId(role.slice('checkout.field-text.'.length))}-label` } });
  }
  if (role.startsWith('checkout.input.')) {
    const key = role.slice('checkout.input.'.length) as keyof typeof BUYER_INPUTS;
    const input = BUYER_INPUTS[key];
    if (!input) return HIDDEN;
    const invalid = refused(refusal, key);
    return shown(true, {
      props: {
        id: fieldId(key),
        'aria-labelledby': `${fieldId(key)}-label`,
        type: input.type,
        // No name: the order is sent from the island's state, never by a form, so a
        // form the page wraps around the checkout has no buyer details to post.
        required: true,
        autoComplete: input.autoComplete,
        'data-checkout-buyer-field': key,
        value: String(buyer[key] ?? ''),
        disabled: paying,
        'aria-invalid': invalid ? true : undefined,
        'aria-describedby': invalid ? view.refusalId : undefined,
        ...(live
          ? { onChange: (event: React.ChangeEvent<HTMLInputElement>) => handlers.onBuyerChange(key, event.target.value), readOnly: undefined }
          : { readOnly: true, tabIndex: -1 }),
      },
    });
  }

  switch (role) {
    case 'checkout.payment':
      return shown(true, { props: { 'data-checkout-payment': '' } });
    case 'checkout.demo-badge':
      return shown(view.isDemo, { props: { 'data-checkout-demo-badge': '' } });
    case 'checkout.total':
      return shown(true, { tokens: { total }, props: { 'data-checkout-payment-total': '' } });
    case 'checkout.buyer':
      return shown(true, { props: { 'data-checkout-buyer': '' } });
    case 'checkout.decline':
      return shown(view.isDemo, { props: { htmlFor: fieldId('decline') } });
    case 'checkout.decline-text':
      return shown(view.isDemo, { props: { id: `${fieldId('decline')}-label` } });
    case 'checkout.decline-input':
      return shown(view.isDemo, {
        props: {
          id: fieldId('decline'),
          'aria-labelledby': `${fieldId('decline')}-label`,
          type: 'checkbox',
          'data-checkout-decline-toggle': '',
          checked: simulateDecline,
          disabled: paying,
          ...(live
            ? { onChange: (event: React.ChangeEvent<HTMLInputElement>) => handlers.onToggleDecline(event.target.checked) }
            : { readOnly: true, tabIndex: -1, onChange: noop }),
        },
      });
    case 'checkout.refusal':
      return shown(refusal !== null, {
        text: refusal?.message ?? '',
        props: { id: view.refusalId, role: 'alert', 'data-checkout-refused': '' },
      });
    case 'checkout.buyer-missing':
      return shown(state.buyerMissing, { props: { role: 'alert', 'data-checkout-buyer-missing': '' } });
    case 'checkout.payment-error':
      return shown(paymentError !== null, {
        tokens: { message: paymentError ?? '' },
        props: { role: 'alert', 'data-checkout-payment-declined': '' },
      });
    case 'checkout.pay':
      return shown(true, {
        props: {
          type: 'button',
          'data-checkout-pay': '',
          disabled: paying,
          'aria-disabled': paying,
          'aria-busy': paying || undefined,
          ...(live ? { onClick: handlers.onPay } : {}),
        },
      });
    case 'checkout.pay-label':
      return shown(!paying, { tokens: { total } });
    case 'checkout.pay-loading':
      return shown(paying);
    case 'checkout.back':
      return shown(true, {
        props: { type: 'button', 'data-checkout-cancel': '', disabled: paying, ...(live ? { onClick: handlers.onBackToCart } : {}) },
      });
    default:
      // The step's layout parts (the legend, the fields and their labels, the actions row) always show with it.
      return SHOWN;
  }
}

function noop(): void {}

// ---------------------------------------------------------------------------
// The canvas
// ---------------------------------------------------------------------------

const SAMPLE_ORDER: PlacedOrder = {
  orderId: 'sample-order',
  orderNumber: 'ORD-000123',
  confirmationEmail: true,
  totalCents: 4990,
  currency: 'EUR',
  provider: 'demo',
};

const SAMPLE_TEXT = {
  en: { email: 'buyer@example.com', declined: 'the card was declined', refusal: 'This shop sells to addresses in Germany only. Enter a German address.', failed: 'order failed (500)' },
  de: { email: 'kundin@example.com', declined: 'die Karte wurde abgelehnt', refusal: 'Dieser Shop liefert nur an Adressen in Deutschland. Bitte eine deutsche Adresse eingeben.', failed: 'Serverfehler (500)' },
} as const;

/** The state the canvas shows for a preview state id, with sample data. */
export function sampleCheckoutState(id: CheckoutPreviewStateId | string, locale: ShopLocale): { state: CheckoutState; cartEmpty: boolean } {
  const text = SAMPLE_TEXT[locale];
  const payment = (extra: Partial<Extract<CheckoutState, { status: 'payment' }>> = {}): CheckoutState => ({
    status: 'payment',
    order: SAMPLE_ORDER,
    simulateDecline: false,
    paying: false,
    buyerMissing: false,
    paymentError: null,
    refusal: null,
    buyer: EMPTY_BUYER,
    ...extra,
  });
  switch (id) {
    case 'empty':
      return { state: { status: 'idle' }, cartEmpty: true };
    case 'placing':
      return { state: { status: 'placing' }, cartEmpty: false };
    case 'payment':
      return { state: payment(), cartEmpty: false };
    case 'paying':
      return { state: payment({ paying: true }), cartEmpty: false };
    case 'buyer-missing':
      return { state: payment({ buyerMissing: true }), cartEmpty: false };
    case 'refused':
      return { state: payment({ refusal: { message: text.refusal, fields: ['country'] } }), cartEmpty: false };
    case 'payment-failed':
      return { state: payment({ paymentError: text.declined }), cartEmpty: false };
    case 'redirecting':
      return { state: { status: 'redirecting' }, cartEmpty: false };
    case 'confirmed':
      return {
        state: { status: 'confirmed', order: SAMPLE_ORDER, transactionId: 'demo_txn_sample', receiptNumber: 'RE-2026-0042', email: text.email },
        cartEmpty: true,
      };
    case 'returned-paid':
      return { state: { status: 'returned', outcome: 'paid', orderNumber: SAMPLE_ORDER.orderNumber, confirmationTo: text.email }, cartEmpty: true };
    case 'returned-cancelled':
      return { state: { status: 'returned', outcome: 'cancelled', orderNumber: SAMPLE_ORDER.orderNumber, confirmationTo: null }, cartEmpty: false };
    case 'shortage':
      return {
        state: {
          status: 'shortage',
          shortages: [
            { variantId: locale === 'de' ? 'T-Shirt, Größe M' : 'T-shirt, size M', needed: 3, available: 1 },
            { variantId: locale === 'de' ? 'Emaille-Becher' : 'Enamel mug', needed: 2, available: 0 },
          ],
        },
        cartEmpty: false,
      };
    case 'items-unavailable':
      return { state: { status: 'order_error', reason: 'items_unavailable', message: '' }, cartEmpty: false };
    case 'error':
      return { state: { status: 'order_error', reason: 'failed', message: text.failed }, cartEmpty: false };
    default:
      return { state: { status: 'idle' }, cartEmpty: false };
  }
}

/**
 * The control on the canvas: its children drawn by the canvas renderer (so every
 * part selects, edits and styles like any node) in the preview state the editor
 * picked, with sample data. It never places an order and nothing in it is live;
 * the editor says so next to the state picker instead of greying the design.
 */
function CheckoutCanvas({ node, hostType = 'div', hostProps = {}, children }: CheckoutButtonProps) {
  const locale = React.useContext(ShopLocaleContext);
  const design = React.useContext(ShopDesignContext);
  const id = typeof node.id === 'string' ? node.id : '';
  const { state, cartEmpty } = sampleCheckoutState(design?.stateOf(id) ?? 'ready', locale);
  const runtime = checkoutRuntime({ state, locale, cartEmpty, isDemo: true, refusalId: `${id}-refusal`, handlers: null });
  const wrapperProps: Record<string, unknown> = { ...hostProps };
  delete wrapperProps.children;
  return React.createElement(
    hostType,
    wrapperProps,
    <ShopRuntimeContext.Provider value={runtime}>
      <ShopControlContent node={node} kind="checkout-button" locale={locale} drawn={children ?? null} />
    </ShopRuntimeContext.Provider>,
  );
}

/**
 * The first preview state in which a part shows, given its role and the roles of
 * the parts around it (outermost first): selecting a part the current state
 * hides switches the canvas to one that shows it, instead of a dead end.
 * Undefined when no state shows it.
 */
export function checkoutStateShowing(roles: readonly string[], locale: ShopLocale): CheckoutPreviewStateId | undefined {
  return CHECKOUT_PREVIEW_STATES.find(({ id }) => checkoutStateShows(id, roles, locale))?.id;
}

/** Whether a preview state shows a part and every part around it. */
export function checkoutStateShows(id: string, roles: readonly string[], locale: ShopLocale): boolean {
  const { state, cartEmpty } = sampleCheckoutState(id, locale);
  const view: CheckoutView = { state, locale, cartEmpty, isDemo: true, refusalId: 'refusal', handlers: null };
  return roles.every((role) => checkoutPart(role, view).visible);
}
