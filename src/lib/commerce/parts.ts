// src/lib/commerce/parts.ts
//
// The visible parts of the shop controls as real child nodes (designable shop
// controls, docs/plans/2026-11-02-designable-shop-controls.md). A shop control
// (checkout today; add to cart, the cart and the variant selector follow) is a
// container whose children are ordinary nodes, each carrying a role marker
// (`data-shop-part`) that the control's island reads. The designer styles,
// moves and retypes them like any element; the island decides what they do.
//
// This module is the single source of the parts: their roles, layer names, tags,
// default styles and rules, default text in the site language, which ones are
// required (never deleted, re-added when missing), which ones have fixed text
// (the honesty notices: shown as written, only styled), and the builder and the
// normaliser every path uses (the palette insert, the editor's load path, the
// published render and the demo seed), so none of them can drift.
//
// PURE: no React, no MobX. The live and the canvas behaviour live in the
// controls (src/lib/renderer/commerce/*) and src/lib/commerce/shopRuntime.tsx.

import { localeOf } from '@/lib/forms/validation';
import { formattedPlainText, isFormattedText } from '@/lib/renderer/textNode';
import type { StoredRule } from '@/lib/rules/rules';
import { HOVER_GATE } from '@/lib/rules/states';

/** The role marker on a part node, like `data-form-kind` on a form field. Never `data-component-kind`. */
export const SHOP_PART_ATTR = 'data-shop-part';

/** The marker the island puts on every wrapper between a part kept in sight and its control. */
export const SHOP_KEPT_WRAPPER_ATTR = 'data-shop-kept-wrapper';

export type ShopLocale = 'en' | 'de';

/** 'de' for a German site language ("de", "de-AT"), else 'en'. */
export function shopLocaleOf(language: string | null | undefined): ShopLocale {
  return localeOf(language);
}

type Localized = Readonly<Record<ShopLocale, string>>;

/** The shop controls whose visible parts are nodes. */
export type ShopControlKind = 'checkout-button' | 'add-to-cart' | 'cart-view' | 'variant-selector';

export const SHOP_CONTROL_KINDS: readonly ShopControlKind[] = ['checkout-button', 'add-to-cart', 'cart-view', 'variant-selector'];

export function isShopControlKind(kind: unknown): kind is ShopControlKind {
  return typeof kind === 'string' && (SHOP_CONTROL_KINDS as readonly string[]).includes(kind);
}

/** The control kind of a node's props, when it is one of the shop controls with parts. */
export function shopControlKindOf(props: unknown): ShopControlKind | undefined {
  const kind = isRecord(props) ? props['data-component-kind'] : undefined;
  return isShopControlKind(kind) ? kind : undefined;
}

export interface ShopPartSpec {
  role: string;
  /** The name in the Layers panel. */
  label: string;
  tag: string;
  /** Default text, editable, with `{token}` placeholders the island fills. */
  text?: Localized;
  /** Text the designer cannot change (it keeps a visitor from being misled); styled only. */
  fixedText?: Localized;
  /** The text is the island's at run time (a message from the server), so none is stored. */
  dynamicText?: true;
  /** Never deleted in the editor, and re-added when missing. */
  required?: true;
  /** Drawn once per item by the island (a shortage line). */
  repeat?: true;
  style?: Record<string, unknown>;
  rules?: StoredRule[];
  /** Plain attributes stored on the node, for its look (never behaviour). */
  attributes?: Record<string, unknown>;
  children?: readonly ShopPartSpec[];
  /**
   * Kept in sight: nothing stored can hide it or a wrapper around it, its tag is
   * its spec's, and the island forces it visible as it renders (the demo notice,
   * the simulated payment line, the total, the pay button's wording).
   */
  keepVisible?: true;
  /** Tokens the text must hold; text without one falls back to the default (the total, the order number). */
  requiredTokens?: readonly string[];
  /** Why the text is fixed, said in the properties panel. */
  fixedReason?: string;
  /** Holds its own parts only: anything else put inside it is dropped (a button whose wording is fixed). */
  onlyParts?: true;
}

/** One state a control can be previewed in on the canvas. */
export interface ShopPreviewState {
  id: string;
  label: string;
}

export interface ShopControlSpec {
  kind: ShopControlKind;
  /** The preview states, in the picker's order; the first is the default. */
  states: readonly ShopPreviewState[];
  parts: readonly ShopPartSpec[];
  /** A control given its parts for the first time puts them before its existing children. */
  partsFirst?: true;
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

/**
 * A button part's states as stored rules, so the panel lists them like any state:
 * Hover (the named state, behind its gate), Disabled and Loading (the island sets
 * `disabled`, and `aria-busy` while it works). Disabled carries today's grey look.
 */
const BUTTON_RULES = (): StoredRule[] => [
  { id: 'hover', selector: '&:hover', at: [HOVER_GATE], style: { opacity: 0.88 } },
  { id: 'disabled', selector: '&:disabled', style: { backgroundColor: '#9ca3af', borderColor: '#9ca3af', color: '#ffffff', cursor: 'not-allowed', opacity: 1 } },
  { id: 'loading', selector: '&[aria-busy="true"]', style: { cursor: 'progress' } },
];

const PRIMARY_BUTTON = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  padding: '8px 16px',
  border: '1px solid #111827',
  borderRadius: '6px',
  backgroundColor: '#111827',
  color: '#ffffff',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: '14px',
};

const MESSAGE = { fontFamily: 'inherit', fontSize: '13px', margin: 0 };

/** The buyer fields the receipt needs, in form order. Their behaviour (name, type, autocomplete) is the island's. */
export const CHECKOUT_BUYER_FIELDS = [
  { key: 'name', label: { en: 'Full name', de: 'Vollständiger Name' } },
  { key: 'email', label: { en: 'Email', de: 'E-Mail' } },
  { key: 'addressLine1', label: { en: 'Street and number', de: 'Straße und Hausnummer' } },
  { key: 'postalCode', label: { en: 'Postal code', de: 'Postleitzahl' } },
  { key: 'city', label: { en: 'City', de: 'Ort' } },
  { key: 'country', label: { en: 'Country (two letters, e.g. DE)', de: 'Land (zwei Buchstaben, z. B. DE)' } },
] as const;

export type CheckoutBuyerFieldKey = (typeof CHECKOUT_BUYER_FIELDS)[number]['key'];

const buyerFieldPart = (field: (typeof CHECKOUT_BUYER_FIELDS)[number]): ShopPartSpec => ({
  role: `checkout.field.${field.key}`,
  label: `Field: ${field.label.en}`,
  tag: 'label',
  required: true,
  style: { display: 'grid', gap: '2px', color: '#374151', fontFamily: 'inherit', fontSize: '13px' },
  children: [
    { role: `checkout.field-text.${field.key}`, label: 'Label', tag: 'span', required: true, text: field.label },
    {
      role: `checkout.input.${field.key}`,
      label: 'Input',
      tag: 'input',
      required: true,
      style: { padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: '6px', fontFamily: 'inherit', fontSize: '13px' },
      rules: [{ id: 'focused', selector: '&:focus-visible', style: { outline: '2px solid #111827', outlineOffset: '1px' } }],
    },
  ],
});

const CHECKOUT_PARTS: readonly ShopPartSpec[] = [
  {
    role: 'checkout.button',
    label: 'Checkout button',
    tag: 'button',
    required: true,
    onlyParts: true,
    style: PRIMARY_BUTTON,
    rules: BUTTON_RULES(),
    children: [
      { role: 'checkout.button-label', label: 'Label', tag: 'span', required: true, text: { en: 'Checkout', de: 'Zur Kasse' } },
      {
        role: 'checkout.button-loading',
        label: 'Loading label',
        tag: 'span',
        required: true,
        text: { en: 'Placing order...', de: 'Bestellung wird angelegt...' },
      },
    ],
  },
  {
    role: 'checkout.payment',
    label: 'Payment step',
    tag: 'div',
    required: true,
    style: { display: 'flex', flexDirection: 'column', gap: '8px', fontFamily: 'inherit', fontSize: '13px', color: '#111827' },
    children: [
      {
        role: 'checkout.demo-badge',
        label: 'Demo notice',
        tag: 'div',
        required: true,
        keepVisible: true,
        fixedReason: 'Fixed text: a demo payment must say that no money is charged, so no visitor takes it for a real payment.',
        fixedText: { en: 'Demo payment. No real charge will be made.', de: 'Demo-Zahlung. Es wird kein echtes Geld abgebucht.' },
        style: {
          padding: '6px 10px',
          borderRadius: '6px',
          backgroundColor: '#fffbeb',
          border: '1px solid #fde68a',
          color: '#92400e',
          fontFamily: 'inherit',
          fontSize: '12px',
          fontWeight: 600,
        },
      },
      {
        role: 'checkout.total',
        label: 'Total',
        tag: 'div',
        required: true,
        keepVisible: true,
        requiredTokens: ['total'],
        text: { en: 'Total to pay: {total}', de: 'Zu zahlen: {total}' },
        style: { fontWeight: 600 },
      },
      {
        role: 'checkout.buyer',
        label: 'Buyer details',
        tag: 'fieldset',
        required: true,
        style: { border: 'none', margin: 0, padding: 0, display: 'grid', gap: '6px', minWidth: 0 },
        children: [
          {
            role: 'checkout.buyer-legend',
            label: 'Heading',
            tag: 'legend',
            required: true,
            text: { en: 'Your receipt is made out to', de: 'Die Rechnung geht an' },
            style: { fontWeight: 600, padding: 0, marginBottom: '6px' },
          },
          ...CHECKOUT_BUYER_FIELDS.map(buyerFieldPart),
        ],
      },
      {
        role: 'checkout.decline',
        label: 'Simulate decline (demo)',
        tag: 'label',
        style: { display: 'flex', alignItems: 'center', gap: '6px', color: '#6b7280' },
        children: [
          { role: 'checkout.decline-input', label: 'Checkbox', tag: 'input' },
          { role: 'checkout.decline-text', label: 'Label', tag: 'span', text: { en: 'Simulate a declined payment', de: 'Abgelehnte Zahlung simulieren' } },
        ],
      },
      { role: 'checkout.refusal', label: 'Details refused', tag: 'div', required: true, dynamicText: true, style: { ...MESSAGE, color: '#b91c1c' } },
      {
        role: 'checkout.buyer-missing',
        label: 'Details missing',
        tag: 'div',
        required: true,
        text: {
          en: 'Fill in your name, email and address: the receipt is made out to them.',
          de: 'Bitte Name, E-Mail und Adresse ausfüllen: Die Rechnung wird darauf ausgestellt.',
        },
        style: { ...MESSAGE, color: '#b91c1c' },
      },
      {
        role: 'checkout.payment-error',
        label: 'Payment failed',
        tag: 'div',
        required: true,
        text: { en: 'Payment failed: {message}', de: 'Zahlung fehlgeschlagen: {message}' },
        style: { ...MESSAGE, color: '#b91c1c' },
      },
      {
        role: 'checkout.actions',
        label: 'Actions',
        tag: 'div',
        required: true,
        style: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
        children: [
          {
            role: 'checkout.pay',
            label: 'Pay button',
            tag: 'button',
            required: true,
            onlyParts: true,
            style: { ...PRIMARY_BUTTON, border: '1px solid #065f46', backgroundColor: '#065f46' },
            rules: BUTTON_RULES(),
            children: [
              {
                role: 'checkout.pay-label',
                label: 'Label',
                tag: 'span',
                required: true,
                keepVisible: true,
                // The button solution (section 312j (3) of the German Civil Code): the button that
                // places a paid order says so in fixed words; the amount may follow.
                fixedText: { en: 'Buy now ({total})', de: 'Zahlungspflichtig bestellen ({total})' },
                fixedReason:
                  'Fixed text: German law (the button solution, section 312j of the Civil Code) requires the button that places a paid order to say so plainly, as "Zahlungspflichtig bestellen". Style it freely.',
              },
              {
                role: 'checkout.pay-loading',
                label: 'Loading label',
                tag: 'span',
                required: true,
                text: { en: 'Processing payment...', de: 'Zahlung wird verarbeitet...' },
              },
            ],
          },
          {
            role: 'checkout.back',
            label: 'Back button',
            tag: 'button',
            required: true,
            text: { en: 'Back to cart', de: 'Zurück zum Warenkorb' },
            style: { ...PRIMARY_BUTTON, border: '1px solid #d1d5db', backgroundColor: '#ffffff', color: '#111827' },
            rules: BUTTON_RULES(),
          },
        ],
      },
    ],
  },
  {
    role: 'checkout.redirecting',
    label: 'Going to payment',
    tag: 'div',
    required: true,
    text: { en: 'Taking you to the secure payment page...', de: 'Weiter zur sicheren Zahlungsseite...' },
    style: { ...MESSAGE, color: '#111827' },
  },
  {
    role: 'checkout.returned-paid',
    label: 'Paid (back from payment)',
    tag: 'div',
    required: true,
    style: { display: 'flex', flexWrap: 'wrap', gap: '0 0.3em', ...MESSAGE, color: '#065f46' },
    children: [
      {
        role: 'checkout.returned-paid-text',
        label: 'Thank you',
        tag: 'span',
        required: true,
        requiredTokens: ['orderNumber'],
        text: { en: 'Thank you: the payment for order {orderNumber} went through.', de: 'Danke: Die Zahlung für Bestellung {orderNumber} ist eingegangen.' },
      },
      {
        role: 'checkout.returned-email',
        label: 'Confirmation email',
        tag: 'span',
        required: true,
        text: { en: 'A confirmation with your receipt is on its way to {email}.', de: 'Eine Bestätigung mit Ihrer Rechnung ist unterwegs an {email}.' },
      },
      {
        role: 'checkout.returned-keep',
        label: 'Keep the order number',
        tag: 'span',
        required: true,
        text: { en: 'Keep the order number for any question about your order.', de: 'Bitte bewahren Sie die Bestellnummer für Rückfragen auf.' },
      },
    ],
  },
  {
    role: 'checkout.returned-cancelled',
    label: 'Cancelled (back from payment)',
    tag: 'div',
    required: true,
    text: {
      en: 'The payment was cancelled. Your cart is kept: check out again whenever you are ready.',
      de: 'Die Zahlung wurde abgebrochen. Ihr Warenkorb bleibt erhalten: Sie können jederzeit erneut zur Kasse gehen.',
    },
    style: { ...MESSAGE, color: '#b45309' },
  },
  {
    role: 'checkout.confirmation',
    label: 'Order confirmed',
    tag: 'div',
    required: true,
    style: { display: 'flex', flexDirection: 'column', gap: '4px', ...MESSAGE, color: '#065f46' },
    children: [
      {
        role: 'checkout.confirmed',
        label: 'Confirmed',
        tag: 'div',
        required: true,
        requiredTokens: ['orderNumber'],
        text: { en: 'Order {orderNumber} confirmed. Total: {total}.', de: 'Bestellung {orderNumber} bestätigt. Gesamt: {total}.' },
      },
      {
        role: 'checkout.payment-ref',
        label: 'Payment reference (demo)',
        tag: 'div',
        required: true,
        keepVisible: true,
        fixedReason: 'Fixed text: the reference of a demo payment must say that the payment was simulated and nothing was charged.',
        fixedText: {
          en: 'Payment reference: {transactionId} (simulated payment, no real charge).',
          de: 'Zahlungsreferenz: {transactionId} (simulierte Zahlung, keine echte Abbuchung).',
        },
        style: { color: '#6b7280' },
      },
      {
        role: 'checkout.receipt-email',
        label: 'Receipt sent',
        tag: 'div',
        required: true,
        text: {
          en: 'A confirmation with receipt {receiptNumber} is on its way to {email}.',
          de: 'Eine Bestätigung mit Rechnung {receiptNumber} ist unterwegs an {email}.',
        },
        style: { color: '#6b7280' },
      },
      {
        role: 'checkout.receipt',
        label: 'Receipt issued',
        tag: 'div',
        required: true,
        text: { en: 'Receipt {receiptNumber} is issued.', de: 'Rechnung {receiptNumber} ist ausgestellt.' },
        style: { color: '#6b7280' },
      },
    ],
  },
  {
    role: 'checkout.shortage',
    label: 'Not enough stock',
    tag: 'div',
    required: true,
    style: { display: 'flex', flexDirection: 'column', gap: '4px', ...MESSAGE, color: '#b45309' },
    children: [
      {
        role: 'checkout.shortage-title',
        label: 'Heading',
        tag: 'div',
        required: true,
        text: { en: 'Some items are no longer fully available:', de: 'Einige Artikel sind nicht mehr in der gewünschten Menge verfügbar:' },
      },
      {
        role: 'checkout.shortage-list',
        label: 'Items',
        tag: 'ul',
        required: true,
        style: { margin: 0, paddingLeft: '18px' },
        children: [
          {
            role: 'checkout.shortage-line',
            label: 'Item (repeated)',
            tag: 'li',
            required: true,
            repeat: true,
            text: { en: '{item}: wanted {needed}, available {available}', de: '{item}: gewünscht {needed}, verfügbar {available}' },
          },
        ],
      },
      {
        role: 'checkout.shortage-next',
        label: 'What to do',
        tag: 'div',
        required: true,
        text: {
          en: 'Reduce the quantity of these items (or remove them), then try checkout again.',
          de: 'Verringern Sie die Menge dieser Artikel (oder entfernen Sie sie) und gehen Sie dann erneut zur Kasse.',
        },
      },
    ],
  },
  {
    role: 'checkout.error',
    label: 'Checkout failed',
    tag: 'div',
    required: true,
    text: { en: 'Checkout failed: {message}', de: 'Bestellung fehlgeschlagen: {message}' },
    style: { ...MESSAGE, color: '#b91c1c' },
  },
  {
    role: 'checkout.items-unavailable',
    label: 'Items no longer sold',
    tag: 'div',
    required: true,
    text: {
      en: 'Checkout failed: some items in your cart are no longer available. Remove them and try again.',
      de: 'Einige Artikel in Ihrem Warenkorb sind nicht mehr erhältlich. Entfernen Sie sie und versuchen Sie es erneut.',
    },
    style: { ...MESSAGE, color: '#b91c1c' },
  },
];

/**
 * The checkout's preview states. Each is a real state of the island
 * (CheckoutButton's CheckoutState), built with sample data for the canvas.
 */
export const CHECKOUT_PREVIEW_STATES = [
  { id: 'ready', label: 'Ready' },
  { id: 'empty', label: 'Empty cart (disabled)' },
  { id: 'placing', label: 'Placing the order (loading)' },
  { id: 'payment', label: 'Payment step' },
  { id: 'paying', label: 'Payment step: processing (loading)' },
  { id: 'buyer-missing', label: 'Payment step: details missing' },
  { id: 'refused', label: 'Payment step: details refused' },
  { id: 'payment-failed', label: 'Payment step: payment failed' },
  { id: 'redirecting', label: 'Going to the payment page' },
  { id: 'confirmed', label: 'Order confirmed (demo payment)' },
  { id: 'confirmed-no-email', label: 'Order confirmed: no confirmation email' },
  { id: 'returned-paid', label: 'Back from payment: paid' },
  { id: 'returned-paid-no-email', label: 'Back from payment: paid, no confirmation email' },
  { id: 'returned-cancelled', label: 'Back from payment: cancelled' },
  { id: 'shortage', label: 'Not enough stock' },
  { id: 'items-unavailable', label: 'Items no longer sold' },
  { id: 'error', label: 'Checkout failed' },
] as const satisfies readonly ShopPreviewState[];

export type CheckoutPreviewStateId = (typeof CHECKOUT_PREVIEW_STATES)[number]['id'];

// ---------------------------------------------------------------------------
// Add to cart
// ---------------------------------------------------------------------------

const ADD_TO_CART_PARTS: readonly ShopPartSpec[] = [
  {
    role: 'addToCart.button',
    label: 'Add to cart button',
    tag: 'button',
    required: true,
    style: PRIMARY_BUTTON,
    rules: BUTTON_RULES(),
    children: [
      { role: 'addToCart.button-label', label: 'Label', tag: 'span', required: true, text: { en: 'Add to cart', de: 'In den Warenkorb' } },
      { role: 'addToCart.button-soldout', label: 'Sold out label', tag: 'span', required: true, text: { en: 'Sold out', de: 'Ausverkauft' } },
    ],
  },
  {
    role: 'addToCart.error',
    label: 'Availability check failed',
    tag: 'span',
    required: true,
    text: {
      en: 'Availability could not be checked right now. Please try again later.',
      de: 'Die Verfügbarkeit kann gerade nicht geprüft werden. Bitte versuchen Sie es später erneut.',
    },
    style: { display: 'block', ...MESSAGE, color: '#b91c1c' },
  },
];

/** The add to cart's preview states: real states of the island, with sample data on the canvas. */
export const ADD_TO_CART_PREVIEW_STATES = [
  { id: 'ready', label: 'Ready' },
  { id: 'no-variant', label: 'No option chosen (disabled)' },
  { id: 'checking', label: 'Checking availability (loading)' },
  { id: 'sold-out', label: 'Sold out (disabled)' },
  { id: 'error', label: 'Availability check failed' },
] as const satisfies readonly ShopPreviewState[];

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

const SMALL_BUTTON = {
  padding: '2px 8px',
  border: '1px solid #d1d5db',
  borderRadius: '4px',
  backgroundColor: '#ffffff',
  color: '#111827',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: '12px',
};

const NOTE = { color: '#6b7280', fontSize: '12px', fontFamily: 'inherit' };
const LINE_WARNING = {
  color: '#b45309',
  backgroundColor: '#fffbeb',
  border: '1px solid #fde68a',
  borderRadius: '4px',
  padding: '2px 6px',
  fontSize: '12px',
  fontFamily: 'inherit',
};

const CART_PARTS: readonly ShopPartSpec[] = [
  {
    role: 'cart.empty',
    label: 'Empty cart message',
    tag: 'span',
    required: true,
    text: { en: 'Your cart is empty', de: 'Ihr Warenkorb ist leer' },
    style: NOTE,
  },
  {
    role: 'cart.lines',
    label: 'Lines',
    tag: 'div',
    required: true,
    style: { display: 'flex', flexDirection: 'column' },
    children: [
      {
        role: 'cart.line',
        label: 'Line (repeated per item)',
        tag: 'div',
        required: true,
        repeat: true,
        style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', padding: '6px 0', fontFamily: 'inherit', fontSize: '14px' },
        children: [
          { role: 'cart.line-title', label: 'Item name', tag: 'span', required: true, requiredTokens: ['title'], text: { en: '{title}', de: '{title}' } },
          {
            role: 'cart.line-price',
            label: 'Price',
            tag: 'span',
            required: true,
            requiredTokens: ['price'],
            text: { en: '{price}', de: '{price}' },
            style: NOTE,
          },
          {
            role: 'cart.line-qty',
            label: 'Quantity',
            tag: 'label',
            required: true,
            style: { display: 'inline-flex', alignItems: 'center', gap: '4px', ...NOTE },
            children: [
              { role: 'cart.line-qty-text', label: 'Label', tag: 'span', required: true, text: { en: 'Qty', de: 'Menge' } },
              {
                role: 'cart.line-qty-input',
                label: 'Input',
                tag: 'input',
                required: true,
                style: { width: '56px', padding: '2px 4px', border: '1px solid #d1d5db', borderRadius: '4px', fontFamily: 'inherit' },
              },
            ],
          },
          {
            role: 'cart.line-remove',
            label: 'Remove button',
            tag: 'button',
            required: true,
            text: { en: 'Remove', de: 'Entfernen' },
            style: SMALL_BUTTON,
            rules: [{ id: 'hover', selector: '&:hover', at: [HOVER_GATE], style: { backgroundColor: '#f3f4f6' } }],
          },
          {
            role: 'cart.line-warning',
            label: 'Low stock warning',
            tag: 'span',
            required: true,
            text: { en: 'Only {available} advertised as available (estimate).', de: 'Nur noch {available} als verfügbar angegeben (Schätzung).' },
            style: LINE_WARNING,
          },
          { role: 'cart.line-loading', label: 'Loading', tag: 'span', required: true, text: { en: 'Loading...', de: 'Wird geladen...' }, style: NOTE },
          {
            role: 'cart.line-unavailable',
            label: 'Item no longer sold',
            tag: 'span',
            required: true,
            text: { en: 'This item is no longer available.', de: 'Dieser Artikel ist nicht mehr erhältlich.' },
            style: LINE_WARNING,
          },
          {
            role: 'cart.line-error',
            label: 'Item failed to load',
            tag: 'span',
            required: true,
            text: { en: 'This item could not be loaded right now.', de: 'Dieser Artikel kann gerade nicht geladen werden.' },
            style: { ...LINE_WARNING, color: '#b91c1c' },
          },
        ],
      },
    ],
  },
  {
    role: 'cart.subtotal',
    label: 'Estimated subtotal',
    tag: 'div',
    required: true,
    requiredTokens: ['subtotal'],
    text: { en: 'Estimated subtotal: {subtotal}', de: 'Zwischensumme (geschätzt): {subtotal}' },
    style: { fontFamily: 'inherit', fontSize: '14px', fontWeight: 600 },
  },
  {
    role: 'cart.subtotal-note',
    label: 'Estimate notice',
    tag: 'div',
    required: true,
    keepVisible: true,
    fixedReason: 'Fixed text: the subtotal here is an estimate, and the shop must not let it pass for the final total.',
    fixedText: { en: 'Estimate only. The final total is calculated at checkout.', de: 'Nur eine Schätzung. Die Endsumme wird an der Kasse berechnet.' },
    style: NOTE,
  },
];

/** The cart's preview states: real states of the island, with sample lines on the canvas. */
export const CART_PREVIEW_STATES = [
  { id: 'ready', label: 'Items in the cart' },
  { id: 'empty', label: 'Empty cart' },
  { id: 'loading', label: 'Loading the items' },
  { id: 'low-stock', label: 'Low stock warning' },
  { id: 'unavailable', label: 'An item no longer sold' },
  { id: 'error', label: 'An item failed to load' },
] as const satisfies readonly ShopPreviewState[];

/** The default style of a cart control: a column with its lines, subtotal and notice. */
export const CART_CONTROL_STYLE: Readonly<Record<string, unknown>> = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  padding: '16px',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
  backgroundColor: '#ffffff',
};

/** The default style of an add to cart control. */
export const ADD_TO_CART_CONTROL_STYLE: Readonly<Record<string, unknown>> = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '4px',
  padding: '4px',
};

// ---------------------------------------------------------------------------
// Variant selector
// ---------------------------------------------------------------------------

const VARIANT_VALUE_STYLE = {
  padding: '4px 10px',
  border: '1px solid #d1d5db',
  borderRadius: '4px',
  backgroundColor: '#ffffff',
  color: '#111827',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: '14px',
};

/**
 * A choice's Selected state: the choice is a radio (`aria-checked`). A page saved
 * when it was a toggle button carries the old selector, which the normaliser
 * rewrites (VARIANT_LEGACY_SELECTED_SELECTOR).
 */
export const VARIANT_SELECTED_SELECTOR = '&[aria-checked="true"]';
const VARIANT_LEGACY_SELECTED_SELECTOR = '&[aria-pressed="true"]';

const VARIANT_PARTS: readonly ShopPartSpec[] = [
  {
    role: 'variant.no-product',
    label: 'No product here',
    tag: 'span',
    required: true,
    text: { en: 'Variant selector: no product in scope', de: 'Variantenauswahl: hier ist kein Produkt' },
    style: NOTE,
  },
  { role: 'variant.loading', label: 'Loading the options', tag: 'span', required: true, text: { en: 'Loading options...', de: 'Optionen werden geladen...' }, style: NOTE },
  {
    role: 'variant.unavailable',
    label: 'Product not available',
    tag: 'span',
    required: true,
    text: { en: 'This product is not available right now.', de: 'Dieses Produkt ist gerade nicht erhältlich.' },
    style: { ...NOTE, color: '#b91c1c' },
  },
  {
    role: 'variant.options',
    label: 'Options',
    tag: 'div',
    required: true,
    style: { display: 'flex', flexDirection: 'column', gap: '8px' },
    children: [
      {
        role: 'variant.option',
        label: 'Option (repeated per option)',
        tag: 'div',
        required: true,
        repeat: true,
        style: { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' },
        children: [
          { role: 'variant.option-label', label: 'Option name', tag: 'span', required: true, requiredTokens: ['option'], text: { en: '{option}', de: '{option}' }, style: NOTE },
          {
            role: 'variant.value',
            label: 'Choice (repeated per value)',
            tag: 'button',
            required: true,
            repeat: true,
            requiredTokens: ['value'],
            text: { en: '{value}', de: '{value}' },
            style: VARIANT_VALUE_STYLE,
            rules: [
              { id: 'hover', selector: '&:hover', at: [HOVER_GATE], style: { borderColor: '#111827' } },
              { id: 'selected', selector: VARIANT_SELECTED_SELECTOR, style: { backgroundColor: '#111827', borderColor: '#111827', color: '#ffffff' } },
              { id: 'disabled', selector: '&:disabled', style: { opacity: 0.4, cursor: 'not-allowed' } },
            ],
          },
        ],
      },
    ],
  },
  { role: 'variant.checking', label: 'Checking availability', tag: 'span', required: true, text: { en: 'Checking availability...', de: 'Verfügbarkeit wird geprüft...' }, style: NOTE },
  { role: 'variant.in-stock', label: 'In stock', tag: 'span', required: true, text: { en: 'In stock', de: 'Auf Lager' }, style: NOTE },
  {
    role: 'variant.low-stock',
    label: 'Only a few left',
    tag: 'span',
    required: true,
    requiredTokens: ['count'],
    text: { en: 'Only {count} left', de: 'Nur noch {count} verfügbar' },
    style: { ...NOTE, color: '#b45309' },
  },
  { role: 'variant.out-of-stock', label: 'Out of stock', tag: 'span', required: true, text: { en: 'Out of stock', de: 'Nicht vorrätig' }, style: { ...NOTE, color: '#b91c1c' } },
  { role: 'variant.available', label: 'Available (no stock limit)', tag: 'span', required: true, text: { en: 'Available', de: 'Verfügbar' }, style: NOTE },
  {
    role: 'variant.availability-error',
    label: 'Availability check failed',
    tag: 'span',
    required: true,
    text: {
      en: 'Availability could not be checked right now. Please try again later.',
      de: 'Die Verfügbarkeit kann gerade nicht geprüft werden. Bitte versuchen Sie es später erneut.',
    },
    style: { ...NOTE, color: '#b91c1c' },
  },
];

/** The variant selector's preview states: real states of the island, with a sample product on the canvas. */
export const VARIANT_PREVIEW_STATES = [
  { id: 'in-stock', label: 'A choice made, in stock' },
  { id: 'nothing-chosen', label: 'Nothing chosen yet' },
  { id: 'loading-options', label: 'Loading the options' },
  { id: 'checking', label: 'Checking availability (loading)' },
  { id: 'low-stock', label: 'Only a few left' },
  { id: 'out-of-stock', label: 'Out of stock' },
  { id: 'choice-unavailable', label: 'A choice no variant has (disabled)' },
  { id: 'available', label: 'Available (no stock limit)' },
  { id: 'error', label: 'Availability check failed' },
  { id: 'not-available', label: 'Product not available (no variants)' },
  { id: 'no-product', label: 'No product on this page' },
] as const satisfies readonly ShopPreviewState[];

/** The default style of a variant selector. */
export const VARIANT_CONTROL_STYLE: Readonly<Record<string, unknown>> = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  padding: '12px',
};

export const SHOP_CONTROLS: Readonly<Record<ShopControlKind, ShopControlSpec>> = {
  'checkout-button': { kind: 'checkout-button', states: CHECKOUT_PREVIEW_STATES, parts: CHECKOUT_PARTS },
  'add-to-cart': { kind: 'add-to-cart', states: ADD_TO_CART_PREVIEW_STATES, parts: ADD_TO_CART_PARTS },
  'cart-view': { kind: 'cart-view', states: CART_PREVIEW_STATES, parts: CART_PARTS },
  // Its parts come before the designer's own children (an add to cart, a price bound to the variant).
  'variant-selector': { kind: 'variant-selector', states: VARIANT_PREVIEW_STATES, parts: VARIANT_PARTS, partsFirst: true },
};

/** The default style of a checkout control: a column, so its steps stack. */
export const CHECKOUT_CONTROL_STYLE: Readonly<Record<string, unknown>> = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '8px',
  padding: '4px',
};

/**
 * The platform's own rule for every part kept in sight, which each control draws
 * once: visible and opaque, with `!important`. No designer rule can carry
 * `!important` (the normaliser strips it), so none outweighs this, wherever it
 * sits on the page. The `::before` and `::after` of a kept part, of every wrapper
 * around one and of a button whose wording is fixed hold no content, and a kept
 * part's first letter and line look like the rest of it. Display is not pinned here, so the designer's flex or grid
 * stays: no stored style keeps a display that hides, and the island pins the
 * display only where it computes to none.
 */
export function shopGuardCss(): string {
  const kept: string[] = [];
  const blanked: string[] = [];
  const visit = (specs: readonly ShopPartSpec[], holders: readonly string[]) => {
    for (const spec of specs) {
      const selector = `[${SHOP_PART_ATTR}="${spec.role}"]`;
      if (spec.keepVisible) {
        kept.push(selector);
        blanked.push(selector, ...holders);
      }
      if (spec.onlyParts) blanked.push(selector);
      if (spec.children) visit(spec.children, [...holders, selector]);
    }
  };
  for (const kind of SHOP_CONTROL_KINDS) visit(SHOP_CONTROLS[kind].parts, []);
  // Every wrapper the island found between a kept part and its control (src/lib/commerce/shopRuntime.tsx).
  blanked.push(`[${SHOP_KEPT_WRAPPER_ATTR}]`);
  const unique = [...new Set(blanked)];
  return [
    ...kept.map((selector) => `${selector}{visibility:visible!important;opacity:1!important}`),
    // No words added beside a kept part or inside a button whose wording is fixed, from any rule on the page.
    `${unique.flatMap((selector) => [`${selector}::before`, `${selector}::after`]).join(',')}{content:none!important}`,
    `${kept.flatMap((selector) => [`${selector}::first-letter`, `${selector}::first-line`]).join(',')}{color:inherit!important;-webkit-text-fill-color:currentcolor!important;font-size:inherit!important;letter-spacing:inherit!important;word-spacing:inherit!important}`,
  ].join('');
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

interface IndexedPart {
  spec: ShopPartSpec;
  kind: ShopControlKind;
  /** The role of the part it belongs in, or undefined for a direct child of the control. */
  parentRole?: string;
}

const PART_INDEX: ReadonlyMap<string, IndexedPart> = (() => {
  const index = new Map<string, IndexedPart>();
  const visit = (kind: ShopControlKind, specs: readonly ShopPartSpec[], parentRole?: string) => {
    for (const spec of specs) {
      index.set(spec.role, { spec, kind, parentRole });
      if (spec.children) visit(kind, spec.children, spec.role);
    }
  };
  for (const kind of SHOP_CONTROL_KINDS) visit(kind, SHOP_CONTROLS[kind].parts);
  return index;
})();

/** The role of a part node, read from its props; undefined for anything else (an unknown role too). */
export function shopPartRoleOf(props: unknown): string | undefined {
  const role = isRecord(props) ? props[SHOP_PART_ATTR] : undefined;
  return typeof role === 'string' && PART_INDEX.has(role) ? role : undefined;
}

export function shopPartSpec(role: string): ShopPartSpec | undefined {
  return PART_INDEX.get(role)?.spec;
}

/** The control a part role belongs to. */
export function shopPartControl(role: string): ShopControlKind | undefined {
  return PART_INDEX.get(role)?.kind;
}

/** The deterministic id of a part of a control: the same control always gets the same part ids. */
export function shopPartId(controlId: string, role: string): string {
  return `${controlId}-${role.replace(/[^A-Za-z0-9-]/g, '-')}`;
}

/**
 * The text a part shows before its tokens are filled: fixed text as written, the
 * stored text when it has any, else the default (so a required label emptied by
 * mistake still names its field). Dynamic parts have none.
 */
export function shopPartText(role: string, rawStored: unknown, locale: ShopLocale): unknown {
  // A numeric binding ({{product.stock}}) reads as its digits, not as missing text.
  const stored = typeof rawStored === 'number' && Number.isFinite(rawStored) ? String(rawStored) : rawStored;
  const spec = shopPartSpec(role);
  if (!spec || spec.dynamicText) return undefined;
  if (spec.fixedText) return spec.fixedText[locale];
  const plain = typeof stored === 'string' ? stored : isFormattedText(stored) ? formattedPlainText(stored) : '';
  // A text that drops a required token (the total, the order number) is not shown: the default is.
  // In formatted text a token must sit whole in one run, since tokens are filled run by run.
  const pieces = typeof stored === 'string' ? [stored] : isFormattedText(stored) ? (stored as { runs: { text: string }[] }).runs.map((run) => run.text) : [];
  const keepsTokens = (spec.requiredTokens ?? []).every((token) => pieces.some((piece) => piece.includes(`{${token}}`)));
  if (plain.trim().length > 0 && keepsTokens) return stored;
  return spec.text?.[locale];
}

/** Whether a part's text is the platform's: fixed text or a run time message. The canvas does not edit it. */
export function shopPartTextLocked(role: string): boolean {
  const spec = shopPartSpec(role);
  return !!spec && (!!spec.fixedText || !!spec.dynamicText);
}

const TOKEN = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

/** Fill `{token}` placeholders; a token with no value stays as typed. */
export function fillShopTokens(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(TOKEN, (match, name: string) => (Object.hasOwn(values, name) ? values[name] : match));
}

/** As fillShopTokens, over a string or each run of formatted text. Anything else comes back as it was. */
export function fillShopTokensIn(value: unknown, values: Readonly<Record<string, string>>): unknown {
  if (typeof value === 'string') return fillShopTokens(value, values);
  if (isFormattedText(value)) {
    const runs = (value as { runs: { text: string }[] }).runs;
    return { ...(value as object), runs: runs.map((run) => ({ ...run, text: fillShopTokens(run.text, values) })) };
  }
  return value;
}

// ---------------------------------------------------------------------------
// Building and normalising
// ---------------------------------------------------------------------------

/** A node as the builder and the normaliser see it: the stored snapshot and the published node share these fields. */
export interface ShopTreeNode {
  id?: string;
  type?: unknown;
  props?: Record<string, unknown>;
  children?: ShopTreeNode[];
  bindings?: Record<string, unknown>;
  /** Stored snapshots only. */
  label?: string;
  componentType?: string;
  parentId?: string;
}

/**
 * How a new part becomes a node of the tree in hand: a stored snapshot needs its
 * component type and parent id, a published node needs neither.
 */
export type ShopNodeShape = 'snapshot' | 'node';

/** The props of a part as the builder stores them: marker, look and default text. */
function partProps(spec: ShopPartSpec, locale: ShopLocale, textOverride?: string): Record<string, unknown> {
  const props: Record<string, unknown> = { [SHOP_PART_ATTR]: spec.role, ...(spec.attributes ?? {}) };
  if (spec.style) props.style = { ...spec.style };
  if (spec.rules) props.rules = spec.rules.map((rule) => structuredClone(rule));
  const text = textOverride ?? spec.text?.[locale];
  if (text !== undefined && !spec.fixedText && !spec.dynamicText) props.children = text;
  return props;
}

/** An id not yet taken on the page: the deterministic one, or it with the first free suffix. */
function freeId(base: string, taken: Set<string> | undefined): string {
  if (!taken) return base;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

function newPartNode(
  spec: ShopPartSpec,
  controlId: string,
  parentId: string,
  locale: ShopLocale,
  shape: ShopNodeShape,
  textOverride?: string,
  taken?: Set<string>,
): ShopTreeNode {
  const node: ShopTreeNode = {
    id: freeId(shopPartId(controlId, spec.role), taken),
    type: spec.tag,
    props: partProps(spec, locale, textOverride),
    children: [],
  };
  if (shape === 'snapshot') {
    node.componentType = 'host';
    node.label = spec.label;
    node.parentId = parentId;
  }
  return node;
}

/**
 * The props and bindings of the controls before parts, and the part each moves to:
 * the checkout's and the add to cart's label, the cart's empty message. A prop
 * becomes the part's text, a binding the part's text binding. A `dropped` prop
 * leaves the control and goes nowhere.
 */
const LEGACY: Readonly<
  Record<ShopControlKind, { props: Record<string, { role: string; text: (value: string) => string }>; bindings: Record<string, string>; dropped?: readonly string[] }>
> = {
  'checkout-button': {
    props: { label: { role: 'checkout.button-label', text: (value) => value } },
    bindings: { label: 'checkout.button-label' },
    // The old pay label: the pay wording is fixed, so it has no part to move to.
    dropped: ['payLabel'],
  },
  'add-to-cart': {
    props: { label: { role: 'addToCart.button-label', text: (value) => value } },
    bindings: { label: 'addToCart.button-label' },
  },
  'cart-view': {
    props: { emptyContent: { role: 'cart.empty', text: (value) => value } },
    bindings: { emptyContent: 'cart.empty' },
  },
  'variant-selector': { props: {}, bindings: {} },
};

/** Legacy props of a control that become part text. */
function legacyTexts(kind: ShopControlKind, props: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, { role, text }] of Object.entries(LEGACY[kind].props)) {
    const value = props?.[key];
    if (typeof value === 'string' && value.trim()) out[role] = text(value);
  }
  return out;
}

/** Legacy bindings of a control that become a part's text binding. */
function legacyBindings(kind: ShopControlKind, bindings: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, role] of Object.entries(LEGACY[kind].bindings)) {
    if (bindings && bindings[key] !== undefined) out[role] = bindings[key];
  }
  return out;
}

/** A whole default part tree for a control, as nodes with deterministic ids (a palette insert, the demo seed). */
export function buildShopParts(
  kind: ShopControlKind,
  controlId: string,
  locale: ShopLocale,
  shape: ShopNodeShape = 'snapshot',
  texts: Readonly<Record<string, string>> = {},
  bindings: Readonly<Record<string, unknown>> = {},
  taken?: Set<string>,
): ShopTreeNode[] {
  const build = (specs: readonly ShopPartSpec[], parentId: string): ShopTreeNode[] =>
    specs.map((spec) => {
      const node = newPartNode(spec, controlId, parentId, locale, shape, texts[spec.role], taken);
      if (bindings[spec.role] !== undefined) node.bindings = { children: bindings[spec.role] };
      node.children = spec.children ? build(spec.children, node.id as string) : [];
      return node;
    });
  return build(SHOP_CONTROLS[kind].parts, controlId);
}

/** Every part node of a control's subtree by role, stopping at a nested control (its parts are its own). */
function partsByRole(control: ShopTreeNode): Map<string, ShopTreeNode> {
  const found = new Map<string, ShopTreeNode>();
  const walk = (node: ShopTreeNode) => {
    for (const child of node.children ?? []) {
      if (shopControlKindOf(child.props)) continue;
      const role = shopPartRoleOf(child.props);
      if (role && !found.has(role)) found.set(role, child);
      walk(child);
    }
  };
  walk(control);
  return found;
}

// ---------------------------------------------------------------------------
// What a part may be and show
// ---------------------------------------------------------------------------

/** Tags a part keeps exactly as its spec says: behaviour, form structure and lists. */
const FIXED_TAGS: ReadonlySet<string> = new Set(['button', 'input', 'label', 'fieldset', 'legend', 'ul', 'ol', 'li']);

/**
 * Tags a text or layout part may be retyped to. Nothing void, nothing that hides
 * its content (template, noscript, dialog), and nothing that navigates or sends
 * (a, form, iframe).
 */
const TEXT_TAGS: ReadonlySet<string> = new Set([
  'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'b', 'i', 'small', 'section', 'article', 'header', 'footer', 'aside',
]);

/**
 * The tag a part renders as: its spec's for a behaviour, form or list part and for
 * a part kept in sight, else the stored tag when it is on the text allowlist.
 */
export function shopPartTag(role: string, stored: unknown): string {
  const spec = shopPartSpec(role);
  if (!spec) return 'div';
  if (FIXED_TAGS.has(spec.tag) || spec.keepVisible) return spec.tag;
  const tag = typeof stored === 'string' ? stored.toLowerCase() : '';
  return TEXT_TAGS.has(tag) ? tag : spec.tag;
}

/** Attributes no node inside a shop control keeps: they could send what a visitor typed elsewhere. */
const SENDING_PROPS: readonly string[] = ['form', 'action', 'formAction', 'formaction', 'method', 'formMethod', 'formmethod', 'target', 'formTarget', 'formtarget', 'enctype', 'formEncType', 'formenctype'];

/** Attributes that take a part kept in sight out of sight. */
const HIDING_PROPS: readonly string[] = ['hidden', 'aria-hidden', 'popover', 'inert'];

const VISIBLE_DISPLAY = /^(block|inline|inline-block|flex|inline-flex|grid|inline-grid|flow-root|list-item|table|contents)$/;
const PLAIN_NUMBER = /^-?\d*\.?\d+$/;
const ZERO_LENGTH = /^0(\.0+)?(px|r?em|%)?$/;
const NOT_NONE = (value: string) => value !== 'none';
/** A length that pulls a box out of the way: any negative value. */
const NEGATIVE = (value: string) => /(^|[\s(,])-\s*\d*\.?\d/.test(value);

/** A font size under 10 pixels (or 0.65 em), or one the check cannot read. */
function tooSmallFont(value: string): boolean {
  const px = /^(\d*\.?\d+)px$/.exec(value);
  if (px) return Number(px[1]) < 10;
  const relative = /^(\d*\.?\d+)(r?em)$/.exec(value);
  return relative ? Number(relative[1]) < 0.65 : true;
}

function inRange(value: number, low: number, high: number): boolean {
  return Number.isFinite(value) && value >= low && value <= high;
}
/** An offset of at most 8 pixels (or 0.5 em) either way. */
function smallOffset(value: string): boolean {
  const px = /^(-?\d*\.?\d+)px$/.exec(value);
  if (px) return Math.abs(Number(px[1])) <= 8;
  const relative = /^(-?\d*\.?\d+)(r?em)$/.exec(value);
  if (relative) return Math.abs(Number(relative[1])) <= 0.5;
  return /^0(\.0+)?$/.test(value);
}
/** An angle of at most 5 degrees either way. */
function smallAngle(value: string): boolean {
  if (value === 'none') return true;
  const deg = /^(-?\d*\.?\d+)deg$/.exec(value);
  return deg ? Math.abs(Number(deg[1])) <= 5 : /^0(\.0+)?$/.test(value);
}
/** A transform made only of small translations, scales near one and small rotations. */
function smallTransform(value: string): boolean {
  if (value === 'none') return true;
  const steps = [...value.matchAll(/([a-z0-9]+)\(([^)]*)\)/gi)];
  if (steps.length === 0 || steps.map((step) => step[0]).join('').replace(/\s+/g, '') !== value.replace(/\s+/g, '')) return false;
  // Repeated steps add up (three 8 pixel translations move a part 24 pixels, three 1.1 scales grow it by a third): one step per kind of transform.
  const kinds = steps.map(([, name]) => (/^translate/i.test(name) ? 'translate' : /^scale/i.test(name) ? 'scale' : name.toLowerCase()));
  if (new Set(kinds).size !== kinds.length) return false;
  return steps.every(([, name, args]) => {
    const values = args.split(',').map((entry) => entry.trim());
    switch (name.toLowerCase()) {
      case 'translate':
      case 'translatex':
      case 'translatey':
      case 'translatez':
      case 'translate3d':
        return values.every(smallOffset);
      case 'scale':
      case 'scalex':
      case 'scaley':
        return values.every((entry) => inRange(Number(entry), 0.9, 1.1));
      case 'rotate':
        return values.every(smallAngle);
      default:
        return false;
    }
  });
}
/** A filter made only of brightness, contrast and saturation between 0.7 and 1.3, and drop shadows (which hide nothing). */
function gentleFilter(value: string): boolean {
  if (value === 'none') return true;
  const steps = [...value.matchAll(/([a-z-]+)\(((?:[^()]|\([^()]*\))*)\)/gi)];
  if (steps.length === 0 || steps.map((step) => step[0]).join('').replace(/\s+/g, '') !== value.replace(/\s+/g, '')) return false;
  // Repeated steps multiply (brightness(0.7) three times is 0.343), and no product check covers contrast or saturate: one numeric step at most.
  if (steps.filter(([, name]) => /^(brightness|contrast|saturate)$/i.test(name)).length > 1) return false;
  return steps.every(([, name, arg]) => {
    if (/^drop-shadow$/i.test(name)) return true;
    if (!/^(brightness|contrast|saturate)$/i.test(name)) return false;
    const number = arg.trim().endsWith('%') ? Number(arg.trim().slice(0, -1)) / 100 : Number(arg.trim());
    return inRange(number, 0.7, 1.3);
  });
}

/** A padding that pushes the text far away: over 200 pixels or 12 em, or a value the check cannot read. */
const TOO_FAR = (value: string) =>
  value.split(/\s+/).some((entry) => {
    if (/^0(\.0+)?$/.test(entry)) return false;
    const px = /^(\d*\.?\d+)px$/.exec(entry);
    if (px) return Number(px[1]) > 200;
    const relative = /^(\d*\.?\d+)(r?em)$/.exec(entry);
    return relative ? Number(relative[1]) > 12 : true;
  });

/** Splits a CSS argument list at its top-level commas. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '(') depth++;
    else if (body[i] === ')') depth--;
    else if (body[i] === ',' && depth === 0) {
      parts.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(body.slice(start).trim());
  return parts;
}

/** Whether a colour is plainly see-through: `transparent`, or an alpha under 0.5. */
function seeThrough(value: string): boolean {
  if (value === 'transparent') return true;
  const hex = /^#([0-9a-f]{4}|[0-9a-f]{8})$/.exec(value);
  if (hex) {
    const alpha = hex[1].length === 4 ? parseInt(hex[1][3] + hex[1][3], 16) : parseInt(hex[1].slice(6), 16);
    return alpha / 255 < 0.5;
  }
  // color-mix(in srgb, a, b): see-through when any colour it mixes is (a mix of a faint colour stays faint enough to read as faint).
  const mix = /^color-mix\((.*)\)$/.exec(value);
  if (mix) return splitTopLevel(mix[1]).slice(1).some((part) => seeThrough(part.replace(/\s+\d*\.?\d+%\s*$/, '').replace(/^\d*\.?\d+%\s+/, '').trim()));
  const fn = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\((.*)\)$/.exec(value);
  if (!fn) return false;
  const body = fn[2];
  const slash = body.split('/');
  const alpha = slash.length > 1 ? slash[1].trim() : /^(rgba|hsla)$/.test(fn[1]) ? body.split(',')[3]?.trim() : undefined;
  if (alpha === undefined) return false;
  const number = alpha.endsWith('%') ? Number(alpha.slice(0, -1)) / 100 : Number(alpha);
  return !Number.isFinite(number) || number < 0.5;
}

/**
 * Style values that hide, on a part kept in sight or a wrapper around one, and in
 * the control's rules that reach inside it. A value the check cannot read (a
 * `var()`, a percent, a calc) counts as hiding: only what is plainly visible stays.
 */
const HIDING_VALUES: Readonly<Record<string, (value: string) => boolean>> = {
  display: (value) => !VISIBLE_DISPLAY.test(value),
  visibility: (value) => value !== 'visible',
  opacity: (value) => !PLAIN_NUMBER.test(value) || Number(value) < 0.5,
  contentVisibility: (value) => value !== 'visible' && value !== 'auto',
  clipPath: NOT_NONE,
  clip: (value) => value !== 'auto',
  // A small hover lift, press or tilt stays; anything that shrinks, moves or turns it away goes.
  transform: (value) => !smallTransform(value),
  scale: (value) => !value.split(/\s+/).every((entry) => inRange(Number(entry), 0.9, 1.1)),
  translate: (value) => !value.split(/\s+/).every(smallOffset),
  rotate: (value) => !smallAngle(value),
  zoom: (value) => value !== '1' && value !== 'normal' && value !== '100%',
  // A hover that darkens or lightens a little stays.
  filter: (value) => !gentleFilter(value),
  backdropFilter: NOT_NONE,
  mask: NOT_NONE,
  maskImage: NOT_NONE,
  maskSize: () => true,
  WebkitMask: NOT_NONE,
  WebkitMaskImage: NOT_NONE,
  // Paint containment crops like an overflow that hides; size containment collapses the box.
  contain: (value) => value !== 'none' && !/^(layout|style|inline-size)(\s+(layout|style|inline-size))*$/.test(value),
  backgroundClip: (value) => value.includes('text'),
  WebkitBackgroundClip: (value) => value.includes('text'),
  WebkitTextFillColor: seeThrough,
  color: seeThrough,
  textIndent: NEGATIVE,
  fontSize: (value) => {
    // Responsive type: a clamp() whose smallest size is readable stays.
    const clamped = /^clamp\(([^,]+),/.exec(value);
    if (clamped) return tooSmallFont(clamped[1].trim());
    return tooSmallFont(value);
  },
  // A wrapper that crops (a 1px box with its overflow hidden) hides as surely as display: none.
  overflow: (value) => value !== 'visible',
  overflowX: (value) => value !== 'visible',
  overflowY: (value) => value !== 'visible',
  height: (value) => ZERO_LENGTH.test(value),
  maxHeight: (value) => ZERO_LENGTH.test(value),
  width: (value) => ZERO_LENGTH.test(value),
  maxWidth: (value) => ZERO_LENGTH.test(value),
  // Glyphs collapsed into one spot, an outline painted over the text, padding that pushes it away.
  letterSpacing: NEGATIVE,
  wordSpacing: NEGATIVE,
  outlineOffset: NEGATIVE,
  padding: TOO_FAR,
  paddingTop: TOO_FAR,
  paddingRight: TOO_FAR,
  paddingBottom: TOO_FAR,
  paddingLeft: TOO_FAR,
  paddingInline: TOO_FAR,
  paddingBlock: TOO_FAR,
  // Positioned off screen.
  position: (value) => value === 'absolute' || value === 'fixed',
  top: NEGATIVE,
  right: NEGATIVE,
  bottom: NEGATIVE,
  left: NEGATIVE,
  inset: NEGATIVE,
  margin: NEGATIVE,
  marginTop: NEGATIVE,
  marginRight: NEGATIVE,
  marginBottom: NEGATIVE,
  marginLeft: NEGATIVE,
  marginInline: NEGATIVE,
  marginBlock: NEGATIVE,
};

/**
 * The only style keys a part kept in sight, or a wrapper between it and its
 * control, keeps (in its style and in every rule it holds): type, colour, box,
 * border and flex or grid layout. Anything else (a mask, containment, a scale, a
 * position, an indent, an outline, which paints over what is around it) goes whether or not the check above could read it, so a
 * new way to hide is closed by default. The keys that can still hide here are
 * checked by value as well.
 */
const KEPT_STYLE_KEYS: ReadonlySet<string> = new Set([
  'color', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'letterSpacing', 'lineHeight',
  'textAlign', 'textTransform', 'textDecoration', 'textDecorationLine', 'textDecorationColor', 'textDecorationStyle',
  'textDecorationThickness', 'textUnderlineOffset', 'textShadow', 'whiteSpace', 'wordBreak', 'overflowWrap', 'wordSpacing',
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'paddingInline', 'paddingBlock',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'marginInline', 'marginBlock',
  'border', 'borderWidth', 'borderStyle', 'borderColor', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderTopColor', 'borderRightColor',
  'borderBottomColor', 'borderLeftColor', 'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
  'borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius',
  'background', 'backgroundColor', 'backgroundImage', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat',
  'boxShadow', 'boxSizing', 'cursor', 'transition', 'verticalAlign',
  'display', 'visibility', 'opacity', 'transform', 'translate', 'scale', 'rotate', 'filter',
  'flex', 'flexDirection', 'flexWrap', 'flexFlow', 'flexGrow', 'flexShrink', 'flexBasis', 'order',
  'alignItems', 'alignSelf', 'alignContent', 'justifyContent', 'justifyItems', 'justifySelf',
  'placeItems', 'placeContent', 'placeSelf', 'gap', 'rowGap', 'columnGap',
  'gridTemplateColumns', 'gridTemplateRows', 'gridTemplateAreas', 'gridAutoFlow', 'gridAutoColumns', 'gridAutoRows',
  'gridColumn', 'gridRow', 'gridArea',
  'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
]);

/** Whether a stored style value hides (scalar, or any breakpoint of a responsive map). */
function hides(key: string, value: unknown): boolean {
  const test = HIDING_VALUES[key];
  if (!test) return false;
  if (isRecord(value)) return Object.values(value).some((entry) => hides(key, entry));
  return (typeof value === 'string' || typeof value === 'number') && test(String(value).trim().toLowerCase());
}

/** A style without what hides, for the control's rules that reach inside it. */
function withoutHidingStyle(style: unknown): Record<string, unknown> | undefined {
  if (!isRecord(style)) return undefined;
  return Object.fromEntries(Object.entries(style).filter(([key, value]) => !hides(key, value)));
}

/** A style of a part kept in sight or a wrapper around one: listed keys only, none that hides. */
function keptStyle(style: unknown): Record<string, unknown> | undefined {
  if (!isRecord(style)) return undefined;
  return Object.fromEntries(
    Object.entries(style).filter(
      // A focus ring (an outline up to 4 pixels, offset at most 4) stays: a dark button needs a designed one.
      ([key, value]) => (KEPT_STYLE_KEYS.has(key) && !hides(key, value)) || (FOCUS_RING_KEYS.has(key) && !wideOutline(value)),
    ),
  );
}

/** Style keys a node beside a part kept in sight never keeps: none can lift it over the part, or let a click through it. */
const OVERLAY_KEYS: ReadonlySet<string> = new Set([
  'position', 'zIndex', 'pointerEvents', 'top', 'right', 'bottom', 'left', 'inset', 'insetInline', 'insetBlock', 'boxShadow',
]);
/** Keys a node beside a part kept in sight keeps within the same bounds as the part's own wrappers. */
const BOUNDED_BESIDE_KEYS: ReadonlySet<string> = new Set(['transform', 'translate', 'scale', 'rotate']);
const NEGATIVE_MARGIN_KEYS: ReadonlySet<string> = new Set(['margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'marginInline', 'marginBlock']);

/**
 * An outline paints after the content around it, so a wide one, or one pushed out
 * by an offset, covers a neighbour's text. A focus ring (up to 4 pixels, offset at
 * most 4) stays.
 */
const OUTLINE_KEYS: ReadonlySet<string> = new Set(['outline', 'outlineWidth', 'outlineOffset']);
const FOCUS_RING_KEYS: ReadonlySet<string> = new Set(['outline', 'outlineWidth', 'outlineOffset', 'outlineColor', 'outlineStyle']);
function wideOutline(value: unknown): boolean {
  if (isRecord(value)) return Object.values(value).some(wideOutline);
  if (typeof value === 'number') return Math.abs(value) > 4;
  if (typeof value !== 'string') return false;
  return value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .some((token) => {
      if (/^-/.test(token)) return true;
      const px = /^(\d*\.?\d+)px$/.exec(token);
      if (px) return Number(px[1]) > 4;
      const relative = /^(\d*\.?\d+)(r?em)$/.exec(token);
      if (relative) return Number(relative[1]) > 0.25;
      // Keywords (a style, a colour, thin, medium, thick) and a bare zero are fine; any other length is not read.
      return /^\d|calc\(|var\(/.test(token) && !/^0(\.0+)?$/.test(token);
    });
}

function withoutOverlayStyle(style: unknown): unknown {
  if (!isRecord(style)) return style;
  return Object.fromEntries(
    Object.entries(style).filter(
      ([key, value]) =>
        !OVERLAY_KEYS.has(key) &&
        !(NEGATIVE_MARGIN_KEYS.has(key) && hides(key, value)) &&
        !(BOUNDED_BESIDE_KEYS.has(key) && hides(key, value)) &&
        !(OUTLINE_KEYS.has(key) && wideOutline(value)),
    ),
  );
}

/**
 * A node beside a part kept in sight (in the same wrapper, or in any wrapper around
 * it) without what would lay it over the part: positioning, stacking, a transform,
 * a grid placement into the part's cell, a negative margin, a click passing through.
 */
function besideKept(node: ShopTreeNode): ShopTreeNode {
  const props = node.props;
  if (!props) return node;
  const style = withoutOverlayStyle(props.style);
  const rules = filteredRules(props.rules, withoutOverlayStyle);
  const next = { ...node, props: { ...props, ...(props.style !== undefined ? { style } : {}), ...(props.rules !== undefined ? { rules } : {}) } };
  return sameJson(next, node) ? node : next;
}

/**
 * A node kept in sight: only listed style keys, none that hides, in its style and
 * in any of its rules (whatever their selector, so a rule reaching into its
 * children cannot hide them either), and no hiding attribute.
 */
function inSight(node: ShopTreeNode): ShopTreeNode {
  const props = { ...(node.props ?? {}) };
  for (const key of HIDING_PROPS) delete props[key];
  const style = keptStyle(props.style);
  if (style) props.style = style;
  if (Array.isArray(props.rules)) props.rules = filteredRules(props.rules, keptStyle);
  return { ...node, props };
}

/** Attributes that give a node another accessible name or tooltip than its text. */
const RENAMING_PROPS: readonly string[] = ['aria-label', 'aria-labelledby', 'aria-description', 'title'];

function withoutProps(node: ShopTreeNode, keys: readonly string[]): ShopTreeNode {
  if (!node.props || !keys.some((key) => key in node.props!)) return node;
  const props = { ...node.props };
  for (const key of keys) delete props[key];
  return { ...node, props };
}

/**
 * Rules with each style filtered; a rule the filter empties goes, so the panel is
 * not left with an empty state (a hover with nothing in it).
 */
function filteredRules(rules: unknown, filter: (style: unknown) => unknown, applies: (rule: Record<string, unknown>) => boolean = () => true): unknown {
  if (!Array.isArray(rules)) return rules;
  return (rules as unknown[]).flatMap((rule) => {
    if (!isRecord(rule) || !isRecord(rule.style) || !applies(rule)) return [rule];
    const style = filter(rule.style);
    const emptied = isRecord(style) && Object.keys(style).length === 0 && Object.keys(rule.style).length > 0;
    return emptied ? [] : [{ ...rule, style }];
  });
}

/** Style keys no node inside a shop control, nor the control itself, keeps. */
const NEVER_IN_CONTROL = /^(content|animation[A-Za-z]*|WebkitAnimation[A-Za-z]*)$/;

/** A style value with `!important` removed: nothing a designer stores outweighs the platform's own guard rule. */
function withoutImportant(style: unknown, top = true): unknown {
  if (!isRecord(style)) return style;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(style)) {
    // Generated content and animations never run inside a shop control: words beside
    // a fixed wording, or a hiding step that starts after the island checked.
    if (top && NEVER_IN_CONTROL.test(key)) {
      changed = true;
      continue;
    }
    const next = typeof value === 'string' && /!\s*important/i.test(value)
      ? value.replace(/\s*!\s*important\s*/gi, '').trim()
      : isRecord(value)
        ? withoutImportant(value, false)
        : value;
    if (next !== value) changed = true;
    out[key] = next;
  }
  return changed ? out : style;
}

/** A node's style and rules with no `!important`, no generated content and no animation anywhere. */
function notImportant(node: ShopTreeNode): ShopTreeNode {
  const props = node.props;
  if (!props) return node;
  const style = withoutImportant(props.style);
  const rules = Array.isArray(props.rules)
    ? (props.rules as unknown[]).map((rule) => (isRecord(rule) && isRecord(rule.style) ? { ...rule, style: withoutImportant(rule.style) } : rule))
    : props.rules;
  const rulesChanged = Array.isArray(props.rules) && (rules as unknown[]).some((rule, index) => rule !== (props.rules as unknown[])[index] && !sameJson(rule, (props.rules as unknown[])[index]));
  if (style === props.style && !rulesChanged) return node;
  return { ...node, props: { ...props, style, ...(rulesChanged ? { rules } : {}) } };
}

/** Whether a rule's selector reaches past its node (a descendant, child or sibling step). */
function reachesInside(rule: Record<string, unknown>): boolean {
  return typeof rule.selector === 'string' && /[\s>~+]/.test(rule.selector.replace(/^&/, '').replace(/\([^)]*\)/g, ''));
}

/**
 * The control's own rules that reach inside it lose their hiding declarations when
 * it holds a part kept in sight: a hover rule on the control that reaches the demo notice and hides it.
 */
function controlInSight(control: ShopTreeNode): ShopTreeNode {
  const props = control.props;
  if (!props || !Array.isArray(props.rules) || !holdsKeptPart(control)) return control;
  const rules = filteredRules(props.rules, withoutHidingStyle, reachesInside);
  return sameJson(rules, props.rules) ? control : { ...control, props: { ...props, rules } };
}

/** A node inside a shop control that cannot send anything: never a form, never a form override. */
function notSending(node: ShopTreeNode): ShopTreeNode {
  const props = node.props ?? {};
  const isForm = typeof node.type === 'string' && node.type.toLowerCase() === 'form';
  // A button without a type submits a form the page wraps around the control.
  const untypedButton = typeof node.type === 'string' && node.type.toLowerCase() === 'button' && props.type !== 'button';
  if (!isForm && !untypedButton && !SENDING_PROPS.some((key) => key in props)) return node;
  const next = { ...props };
  for (const key of SENDING_PROPS) delete next[key];
  if (untypedButton) next.type = 'button';
  return { ...node, ...(isForm ? { type: 'div' } : {}), props: next };
}

/** Whether any part of a subtree is kept in sight (outside nested controls). */
function holdsKeptPart(node: ShopTreeNode): boolean {
  return (node.children ?? []).some((child) => {
    if (shopControlKindOf(child.props)) return false;
    const role = shopPartRoleOf(child.props);
    return (role !== undefined && !!shopPartSpec(role)?.keepVisible) || holdsKeptPart(child);
  });
}

/**
 * Every part of a control's subtree as it must reach a page: its tag on the
 * allowlist, fixed text stored nowhere, a run time message's text stored nowhere,
 * a part kept in sight (and every wrapper between it and the control) with
 * nothing that hides it, a role used twice kept only by its first part, no
 * stored attribute its island owns on a button or an input (SHOP_RUNTIME_OWNED_PROPS),
 * and no node able to send anything. The same object when nothing changes.
 */
function enforceParts(input: ShopTreeNode): ShopTreeNode {
  const control = notImportant(controlInSight(notSending(input)));
  const visit = (node: ShopTreeNode, inRepeat: boolean): ShopTreeNode => {
    let changed = false;
    const nodeRole = shopPartRoleOf(node.props);
    // A button whose words are fixed holds its own parts only: a stray text beside
    // them would undo the wording (the button solution).
    const onlyParts = !!(nodeRole && shopPartSpec(nodeRole)?.onlyParts);
    const kept = onlyParts && node.children ? liftParts(node.children, node.id, ownRoles(nodeRole!)) : node.children;
    // Inside a node that holds a part kept in sight, nothing else may be laid over it.
    // Scoped to the parts that hold one (the payment step, its actions row, the
    // confirmation): the control's other steps are never on screen with it, so they
    // keep their positioning and grid placement.
    const besideKeptPart = node !== control && holdsKeptPart(node);
    if (kept !== node.children) changed = true;
    const children = kept?.map((child) => {
      if (shopControlKindOf(child.props)) return child;
      let next = notImportant(notSending(nameless(child)));
      const role = shopPartRoleOf(next.props);
      const spec = role ? shopPartSpec(role) : undefined;
      // Inside a repeated part every copy carries the same nodes: an id of the
      // designer's would repeat on the page, so it goes.
      const repeated = inRepeat || !!spec?.repeat;
      if (repeated && next.props && 'id' in next.props) {
        const props = { ...next.props };
        delete props.id;
        next = { ...next, props };
      }
      next = visit(next, repeated);
      if (spec && role) {
        const tag = shopPartTag(role, next.type);
        if (tag !== next.type) next = { ...next, type: tag };
        next = withoutRuntimeProps(next);
        if (spec.fixedText || spec.dynamicText || spec.onlyParts) next = withoutStoredText(next);
        // Nothing renames a fixed wording for assistive technology either, nor a part
        // drawn once per item or one whose text holds the item's tokens: one stored
        // name would give every copy (every choice, every option) the same name.
        if (spec.keepVisible || spec.fixedText || spec.onlyParts || spec.repeat || spec.requiredTokens) next = withoutProps(next, RENAMING_PROPS);
        if (role === 'variant.value') next = withCurrentSelectedRule(next);
        // A part kept in sight, or one whose text is the platform's, is its text only:
        // a node put inside it would add words to it or lay a cover over it.
        if ((spec.keepVisible || spec.fixedText) && next.children && next.children.length > 0) next = { ...next, children: [] };
      }
      if (spec?.keepVisible || holdsKeptPart(next)) next = inSight(next);
      else if (besideKeptPart) next = besideKept(next);
      if (next !== child && !sameJson(next, child)) changed = true;
      else next = child;
      return next;
    });
    return changed ? { ...node, children } : node;
  };
  return visit(control, false);
}

/**
 * A choice whose Selected rule still addresses the toggle button it once was
 * (`aria-pressed`), rewritten to the radio it is now (`aria-checked`). The same
 * object when no rule needs it, so a second pass changes nothing.
 */
function withCurrentSelectedRule(node: ShopTreeNode): ShopTreeNode {
  const rules = node.props?.rules;
  if (!Array.isArray(rules)) return node;
  const legacy = (rule: unknown) => isRecord(rule) && typeof rule.selector === 'string' && rule.selector.includes(VARIANT_LEGACY_SELECTED_SELECTOR);
  if (!rules.some(legacy)) return node;
  const next = rules.map((rule) =>
    legacy(rule) ? { ...(rule as Record<string, unknown>), selector: (rule as { selector: string }).selector.split(VARIANT_LEGACY_SELECTED_SELECTOR).join(VARIANT_SELECTED_SELECTOR) } : rule,
  );
  return { ...node, props: { ...node.props, rules: next } };
}

/**
 * The children of a button whose wording is fixed, its own parts only (the roles its
 * spec lists, never a part of somewhere else): a part stays, a part inside a
 * wrapper without a role is lifted out of it (so a required label is never
 * lost with its wrapper), and everything else (the wrapper, its text, a nested
 * control) goes. The same array when every child is a part already, so a second
 * pass changes nothing.
 */
function liftParts(children: ShopTreeNode[], parentId: string | undefined, own: ReadonlySet<string>): ShopTreeNode[] {
  const isOwn = (node: ShopTreeNode) => {
    const role = shopPartRoleOf(node.props);
    return role !== undefined && own.has(role);
  };
  if (children.every(isOwn)) return children;
  const lifted: ShopTreeNode[] = [];
  const collect = (node: ShopTreeNode, top: boolean) => {
    if (isOwn(node)) {
      lifted.push(!top && 'parentId' in node && parentId !== undefined ? { ...node, parentId } : node);
      return;
    }
    if (shopControlKindOf(node.props)) return;
    for (const child of node.children ?? []) collect(child, false);
  };
  for (const child of children) collect(child, true);
  return lifted;
}

/** The roles a part's spec lists as its own children. */
function ownRoles(role: string): ReadonlySet<string> {
  return new Set((shopPartSpec(role)?.children ?? []).map((child) => child.role));
}

/** A node without its part role: a plain node from here on. */
function withoutRole(node: ShopTreeNode): ShopTreeNode {
  const props = { ...(node.props ?? {}) };
  delete props[SHOP_PART_ATTR];
  return { ...node, props };
}

/**
 * Each part where its spec puts it, once: a part counts only under its spec parent
 * (the part it belongs in, through any wrappers without a role, or the control
 * itself for a top part), only in a control of its own kind, and only its first
 * copy. Anything else (a second copy, a demo notice moved under the confirmation, a
 * label moved into the pay button) loses its role and is a plain node, so the
 * required part comes back in its own place. Runs before anything is re-added, so
 * one pass settles the tree. The same object when nothing changes.
 */
function placedParts(control: ShopTreeNode, kind: ShopControlKind): ShopTreeNode {
  const seen = new Set<string>();
  const visit = (node: ShopTreeNode, nearest: string | undefined): ShopTreeNode => {
    let changed = false;
    const children = node.children?.map((child) => {
      if (shopControlKindOf(child.props)) return child;
      let next = child;
      let here = nearest;
      const role = shopPartRoleOf(child.props);
      if (role) {
        const indexed = PART_INDEX.get(role);
        if (indexed && indexed.kind === kind && indexed.parentRole === nearest && !seen.has(role)) {
          seen.add(role);
          here = role;
        } else {
          next = withoutRole(child);
        }
      }
      next = visit(next, here);
      if (next !== child) changed = true;
      return next;
    });
    return changed ? { ...node, children } : node;
  };
  return visit(control, undefined);
}

/** What the editor says when a move would take a part out of its place in its control. */
export const MISPLACED_SHOP_PART_MESSAGE =
  'This part of the shop control has its own place in it: it can move among its siblings, not into another part.';

/** What the editor says when a control, a button, a link or a field would go inside a part a visitor presses. */
export const INTERACTIVE_SHOP_PART_MESSAGE =
  'This part of the shop control is pressed or typed into by a visitor (a choice, a button, a field): a button, a link, a field or a shop control cannot go inside it, since a visitor could not press both. Put it beside the part instead.';

/** Part tags a visitor presses or types into: nothing they can press goes inside one. */
const INTERACTIVE_PART_TAGS: ReadonlySet<string> = new Set(['button', 'a', 'label', 'input', 'select', 'textarea']);
/** Element tags a visitor can press or type into. */
const INTERACTIVE_TAGS: ReadonlySet<string> = new Set(['button', 'a', 'input', 'select', 'textarea', 'label', 'details', 'summary', 'iframe']);

/** What the editor says when something would go inside a part that holds its own words only. */
export const CLOSED_SHOP_PART_MESSAGE =
  'This part of the shop control holds its own words only (the pay button, the total and the notices a buyer must see): nothing else can go inside it. Put it beside the part instead.';

/**
 * Why the editor refuses to put `node` under `ancestors` (nearest first, the new
 * parent first) inside a shop control, or undefined when it may: a part going
 * anywhere but the place its spec gives it, or anything going inside a part that
 * holds its own words only (a button whose wording is fixed takes its own parts
 * only; a part kept in sight or with fixed text takes nothing). The normaliser
 * would undo either on the next load, so the editor says so now.
 */
export function shopPartRefusal(node: { type?: unknown; props?: unknown; children?: readonly unknown[] }, ancestors: readonly { props?: unknown }[]): string | undefined {
  let nearest: string | undefined;
  let kind: ShopControlKind | undefined;
  // Inside a part a visitor presses (a choice, a button) or types into, at any depth.
  let inInteractive = false;
  for (const ancestor of ancestors) {
    kind = shopControlKindOf(ancestor.props);
    if (kind) break;
    const ancestorRole = shopPartRoleOf(ancestor.props);
    if (nearest === undefined) nearest = ancestorRole;
    const ancestorSpec = ancestorRole ? shopPartSpec(ancestorRole) : undefined;
    if (ancestorSpec && INTERACTIVE_PART_TAGS.has(ancestorSpec.tag)) inInteractive = true;
  }
  if (!kind) return undefined;
  const closed = nearest ? shopPartSpec(nearest) : undefined;
  const role = shopPartRoleOf(node.props);
  // A closed part takes no control either: the normaliser would remove it.
  if (closed && (closed.keepVisible || closed.fixedText)) return CLOSED_SHOP_PART_MESSAGE;
  if (closed?.onlyParts && !(role && ownRoles(nearest!).has(role))) return CLOSED_SHOP_PART_MESSAGE;
  // Nothing a visitor presses goes inside what they press: the inner one could not
  // be pressed on its own, and a control there would nest one island in another.
  // A part of the interactive part's own (its label, its input) is checked below.
  if (inInteractive && pressable(node)) return INTERACTIVE_SHOP_PART_MESSAGE;
  if (shopControlKindOf(node.props)) return undefined;
  const misplaced = (candidate: { props?: unknown; children?: readonly unknown[] }): boolean => {
    if (shopControlKindOf(candidate.props)) return false;
    const own = shopPartRoleOf(candidate.props);
    if (own) {
      const indexed = PART_INDEX.get(own);
      return !indexed || indexed.kind !== kind || indexed.parentRole !== nearest;
    }
    return (candidate.children ?? []).some((child) => isRecord(child) && misplaced(child as { props?: unknown; children?: readonly unknown[] }));
  };
  return misplaced(node) ? MISPLACED_SHOP_PART_MESSAGE : undefined;
}

/** Whether a node, or a plain node inside it, is something a visitor presses: a shop control or an interactive element. Parts are placed by their spec. */
function pressable(node: { type?: unknown; props?: unknown; children?: readonly unknown[] }): boolean {
  if (shopControlKindOf(node.props)) return true;
  if (shopPartRoleOf(node.props)) return false;
  if (typeof node.type === 'string' && INTERACTIVE_TAGS.has(node.type.toLowerCase())) return true;
  if (isRecord(node.props) && (typeof node.props.href === 'string')) return true;
  return (node.children ?? []).some((child) => isRecord(child) && pressable(child as { type?: unknown; props?: unknown; children?: readonly unknown[] }));
}

/** Whether the editor refuses to put `node` under `ancestors` inside a shop control (shopPartRefusal). */
export function misplacesShopPart(node: { props?: unknown; children?: readonly unknown[] }, ancestors: readonly { props?: unknown }[]): boolean {
  return shopPartRefusal(node, ancestors) !== undefined;
}

/**
 * How the published page limits a node's styles, for the properties panel's note
 * (`ancestors` nearest first): 'kept' for a part kept in sight or a wrapper around
 * one (an allowlist of styles, section 5 of the plan), 'beside' for a node next to
 * one inside the part that holds it (no positioning, stacking or large transforms),
 * undefined for anything else.
 */
export function shopStyleLimit(node: { props?: unknown; children?: readonly unknown[] }, ancestors: readonly { props?: unknown; children?: readonly unknown[] }[]): 'kept' | 'beside' | undefined {
  const at = ancestors.findIndex((ancestor) => shopControlKindOf(ancestor.props));
  if (at < 0 || shopControlKindOf(node.props)) return undefined;
  const role = shopPartRoleOf(node.props);
  if ((role && shopPartSpec(role)?.keepVisible) || holdsKeptPart(node as ShopTreeNode)) return 'kept';
  const parent = ancestors[0];
  if (at > 0 && parent && holdsKeptPart(parent as ShopTreeNode)) return 'beside';
  return undefined;
}

/**
 * The attributes the island owns on a part's interactive element, by tag, in every
 * spelling a stored node may carry: whether it can be pressed or typed into, and
 * whether the keyboard reaches it. A stored copy would make a remove button that
 * cannot be pressed or a quantity input that cannot be typed into, so none is
 * stored (enforceParts) and the island draws none of the designer's
 * (ShopPartElement), setting its own where it means something.
 */
export const SHOP_RUNTIME_OWNED_PROPS: Readonly<Record<string, readonly string[]>> = {
  button: ['disabled', 'aria-disabled', 'inert', 'tabIndex', 'tabindex'],
  input: ['disabled', 'aria-disabled', 'inert', 'tabIndex', 'tabindex', 'readOnly', 'readonly', 'max'],
};

/** A part without the stored attributes its island owns (SHOP_RUNTIME_OWNED_PROPS). */
function withoutRuntimeProps(node: ShopTreeNode): ShopTreeNode {
  const owned = typeof node.type === 'string' ? SHOP_RUNTIME_OWNED_PROPS[node.type.toLowerCase()] : undefined;
  return owned ? withoutProps(node, owned) : node;
}

/** Form field tags: their value lives in the island's state, so they carry no stored `name`. */
const FIELD_TAGS: ReadonlySet<string> = new Set(['input', 'select', 'textarea']);

/** A form field inside a shop control without a stored `name`: a form the page wraps around it has nothing to post. */
function nameless(node: ShopTreeNode): ShopTreeNode {
  const tag = typeof node.type === 'string' ? node.type.toLowerCase() : '';
  if (!FIELD_TAGS.has(tag) || !node.props || !('name' in node.props)) return node;
  const props = { ...node.props };
  delete props.name;
  return { ...node, props };
}

/** A part whose text is the platform's stores none. */
function withoutStoredText(node: ShopTreeNode): ShopTreeNode {
  if (!node.props || !('children' in node.props)) return node;
  const props = { ...node.props };
  delete props.children;
  return { ...node, props };
}

/**
 * A control with every part it needs. A control with no parts at all (the old
 * shape, a page written before parts, or a node the generator wrote) gets the
 * whole default tree, its old label props carried into the text. A designed
 * control keeps its design: only a missing required part comes back, under the
 * part it belongs in (or the control), in its default place. Fixed and dynamic
 * text parts are enforced. Pure and repeatable: the same input gives the same
 * output, and a complete control comes back as the same object.
 */
export function normalizeShopControl<N extends object>(
  input: N,
  locale: ShopLocale,
  shape: ShopNodeShape,
  asKind?: ShopControlKind,
  /** Every id on the page: a new part never takes one (a part moved out kept its id). Collected here when absent. */
  taken: Set<string> = idsIn(input as ShopTreeNode),
): N {
  const control = input as ShopTreeNode;
  // The island knows what it is even when the node it was handed lacks the marker.
  const kind = asKind ?? shopControlKindOf(control.props);
  if (!kind) return input;
  const controlId = typeof control.id === 'string' && control.id ? control.id : `shop-${kind}`;
  const placed = placedParts(control, kind);
  const existing = partsByRole(placed);
  let changed = placed !== control;
  let root: ShopTreeNode = placed;

  if (existing.size === 0) {
    const parts = buildShopParts(kind, controlId, locale, shape, legacyTexts(kind, placed.props), legacyBindings(kind, placed.bindings), taken);
    const own = placed.children ?? [];
    root = { ...placed, children: SHOP_CONTROLS[kind].partsFirst ? [...parts, ...own] : [...own, ...parts] };
    changed = true;
  } else {
    // Missing required parts, top down, so a part comes back before the parts inside it.
    const missing: { spec: ShopPartSpec; parentRole?: string }[] = [];
    const visit = (specs: readonly ShopPartSpec[], parentRole?: string) => {
      for (const spec of specs) {
        if (spec.required && !existing.has(spec.role)) missing.push({ spec, parentRole });
        if (spec.children) visit(spec.children, spec.role);
      }
    };
    visit(SHOP_CONTROLS[kind].parts);
    if (missing.length > 0) {
      root = cloneTree(placed);
      const byRole = partsByRole(root);
      // A part rebuilt now takes a leftover legacy text prop as its text, as a control
      // built whole does (and as a leftover legacy binding moves to it, below).
      const texts = legacyTexts(kind, placed.props);
      for (const { spec, parentRole } of missing) {
        const parent = parentRole ? byRole.get(parentRole) : root;
        // A required part's parent is required too, so it exists by now.
        if (!parent) continue;
        const node = newPartNode(spec, controlId, String(parent.id ?? controlId), locale, shape, texts[spec.role], taken);
        const siblings = parent.children ?? [];
        const at = insertIndex(siblings, spec, parentRole, kind);
        parent.children = [...siblings.slice(0, at), node, ...siblings.slice(at)];
        byRole.set(spec.role, node);
      }
      changed = true;
    }
  }

  // Legacy label props and bindings leave the control once their text lives in the parts.
  // On a control that already has parts, a leftover legacy prop (label, emptyContent) is
  // moved into its part when that part was rebuilt just now (above), and dropped when the
  // part was already there: it holds the designer's text. A leftover legacy binding is
  // moved (below) unless its part is bound already. Either way the prop is gone after one
  // pass, so a second pass changes nothing.
  const legacy = [...Object.keys(LEGACY[kind].props), ...(LEGACY[kind].dropped ?? [])].filter((key) => root.props && key in root.props);
  if (legacy.length > 0) {
    const props = { ...(root.props ?? {}) };
    for (const key of legacy) delete props[key];
    root = { ...root, props };
    changed = true;
  }
  const legacyBound = Object.keys(LEGACY[kind].bindings).filter((key) => root.bindings && key in root.bindings);
  if (legacyBound.length > 0) {
    // A control built just now carried its bindings into the new parts. One that
    // already had parts (an outside write, a page saved between versions) moves each
    // to its part when the part has no text binding of its own; when it has one, the
    // part's own binding wins and the legacy one is dropped.
    if (existing.size > 0) {
      root = cloneTree(root);
      const byRole = partsByRole(root);
      for (const key of legacyBound) {
        const part = byRole.get(LEGACY[kind].bindings[key]);
        if (part && part.bindings?.children === undefined) part.bindings = { ...(part.bindings ?? {}), children: root.bindings![key] };
      }
    }
    const bindings = { ...(root.bindings ?? {}) };
    for (const key of legacyBound) delete bindings[key];
    root = { ...root, bindings };
    changed = true;
  }

  const enforced = enforceParts(root);
  if (enforced !== root) {
    root = enforced;
    changed = true;
  }
  return changed ? (root as N) : input;
}

/** Where a re-added part goes among its siblings: after the last sibling that comes before it in the spec. */
function insertIndex(siblings: readonly ShopTreeNode[], spec: ShopPartSpec, parentRole: string | undefined, kind: ShopControlKind): number {
  const order = (parentRole ? shopPartSpec(parentRole)?.children : SHOP_CONTROLS[kind].parts) ?? [];
  const before = new Set(order.slice(0, order.findIndex((entry) => entry.role === spec.role)).map((entry) => entry.role));
  let index = 0;
  siblings.forEach((sibling, at) => {
    const role = shopPartRoleOf(sibling.props);
    if (role && before.has(role)) index = at + 1;
  });
  return index;
}

/**
 * Every shop control in a tree normalised (normalizeShopControl). Unchanged trees
 * come back as the same object, so a caller can tell nothing was rewritten.
 */
export function withShopParts<N extends object>(root: N, locale: ShopLocale, shape: ShopNodeShape, taken: Set<string> = idsIn(root as ShopTreeNode)): N {
  const walk = (node: ShopTreeNode): ShopTreeNode => {
    const children = Array.isArray(node.children) ? node.children : null;
    const nextChildren = children ? children.map(walk) : null;
    const changedChildren = !!children && nextChildren!.some((child, i) => child !== children[i]);
    const withChildren = changedChildren ? { ...node, children: nextChildren! } : node;
    return shopControlKindOf(withChildren.props) ? normalizeShopControl(withChildren, locale, shape, undefined, taken) : withChildren;
  };
  return walk(root as ShopTreeNode) as N;
}

/** A stored page snapshot with every shop control normalised: its tree and its floating canvas nodes. */
export function pageWithShopParts<P extends { appComponentTree?: unknown; canvasNodes?: unknown }>(page: P, language: string | null | undefined): P {
  const locale = shopLocaleOf(language);
  // Ids are unique across the whole page: its tree and its floating nodes.
  const taken = new Set<string>();
  if (isRecord(page.appComponentTree)) idsIn(page.appComponentTree as ShopTreeNode, taken);
  if (isRecord(page.canvasNodes)) for (const node of Object.values(page.canvasNodes)) if (isRecord(node)) idsIn(node as ShopTreeNode, taken);
  let next = page;
  if (isRecord(page.appComponentTree)) {
    const tree = withShopParts(page.appComponentTree as ShopTreeNode, locale, 'snapshot', taken);
    if (tree !== page.appComponentTree) next = { ...next, appComponentTree: tree };
  }
  if (isRecord(page.canvasNodes)) {
    const nodes = page.canvasNodes as Record<string, ShopTreeNode>;
    let changed = false;
    const out: Record<string, ShopTreeNode> = {};
    for (const [id, node] of Object.entries(nodes)) {
      out[id] = isRecord(node) ? withShopParts(node, locale, 'snapshot', taken) : node;
      if (out[id] !== node) changed = true;
    }
    if (changed) next = { ...next, canvasNodes: out };
  }
  return next;
}

/**
 * `pageWithShopParts` for every reusable component's page (a definition is
 * `{ page, ... }`), so a legacy control inside a component gets its parts as nodes
 * the editor can select. Anything that is not a definition with a page passes through.
 */
export function componentsWithShopParts<C>(components: C, language: string | null | undefined): C {
  if (!isRecord(components)) return components;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [id, definition] of Object.entries(components)) {
    if (isRecord(definition) && isRecord(definition.page)) {
      const page = pageWithShopParts(definition.page as { appComponentTree?: unknown; canvasNodes?: unknown }, language);
      out[id] = page === definition.page ? definition : { ...definition, page };
      if (out[id] !== definition) changed = true;
    } else {
      out[id] = definition;
    }
  }
  return changed ? (out as C) : components;
}

/** The parts of a control as the renderers hand them over: a stored node or a live editor node, read the same way. */
interface ReadableNode {
  props?: unknown;
  children?: readonly unknown[] | Iterable<unknown>;
}

function childrenOf(node: ReadableNode): ReadableNode[] {
  const children = node.children;
  if (!children) return [];
  return Array.from(children as Iterable<unknown>).filter(isRecord) as ReadableNode[];
}

/**
 * The required parts a control's tree lacks, as default nodes to draw in their
 * place: a part moved out of the control, or a tree the load path never saw.
 * Only the outermost missing part of each branch comes back, holding whatever of
 * its own parts is missing too. For the canvas and the Preview, which draw the
 * stored tree as it is; a published page normalises instead (withShopParts).
 */
export function missingShopParts(control: ReadableNode & { id?: unknown }, locale: ShopLocale, asKind?: ShopControlKind): ShopTreeNode[] {
  const kind = asKind ?? shopControlKindOf(control.props);
  if (!kind) return [];
  const present = presentShopPartRoles(control);
  const controlId = typeof control.id === 'string' && control.id ? control.id : `shop-${kind}`;
  const build = (spec: ShopPartSpec, parentId: string): ShopTreeNode => {
    const node = newPartNode(spec, controlId, parentId, locale, 'node');
    node.children = (spec.children ?? [])
      .filter((child) => child.required && !present.has(child.role))
      .map((child) => build(child, node.id as string));
    return node;
  };
  const out: ShopTreeNode[] = [];
  const visit = (specs: readonly ShopPartSpec[], parentPresent: boolean) => {
    for (const spec of specs) {
      const here = present.has(spec.role);
      if (!here && spec.required && parentPresent) out.push(build(spec, controlId));
      if (spec.children && here) visit(spec.children, true);
    }
  };
  visit(SHOP_CONTROLS[kind].parts, true);
  return out;
}

/** The roles of the parts inside a control, not counting a control nested in it. */
function presentShopPartRoles(control: ReadableNode): Set<string> {
  const present = new Set<string>();
  const walk = (node: ReadableNode) => {
    for (const child of childrenOf(node)) {
      if (shopControlKindOf(child.props)) continue;
      const role = shopPartRoleOf(child.props);
      if (role) present.add(role);
      walk(child);
    }
  };
  walk(control);
  return present;
}

/**
 * Everything missingShopParts reads from a control, as one string: its id, its kind
 * and the roles of the parts it holds. Equal keys give equal results, so a surface
 * that draws the control on every render (the canvas, the Preview, where the node
 * is a live instance changed in place) can keep the result until the key changes.
 */
export function missingShopPartsKey(control: ReadableNode & { id?: unknown }, asKind?: ShopControlKind): string {
  const kind = asKind ?? shopControlKindOf(control.props);
  if (!kind) return '';
  const controlId = typeof control.id === 'string' && control.id ? control.id : `shop-${kind}`;
  return JSON.stringify([controlId, kind, [...presentShopPartRoles(control)].sort()]);
}

/** What the editor says when a delete would take a required part out of its control. */
export const REQUIRED_SHOP_PART_MESSAGE =
  'This part of the shop control is required, so it cannot be deleted: restyle it, or delete the whole control.';

/**
 * Whether deleting `node` from the editor would take a required part out of the
 * control it sits in: the part itself, or a wrapper holding one. Deleting the
 * control itself is always allowed. `ancestors` is nearest first.
 */
export function holdsRequiredShopPart(node: { props?: unknown; children?: readonly unknown[] }, ancestors: readonly { props?: unknown }[]): boolean {
  const control = ancestors.find((ancestor) => shopControlKindOf(ancestor.props));
  if (!control) return false;
  const required = (candidate: { props?: unknown; children?: readonly unknown[] }): boolean => {
    if (shopControlKindOf(candidate.props)) return false;
    const role = shopPartRoleOf(candidate.props);
    if (role && shopPartSpec(role)?.required) return true;
    return (candidate.children ?? []).some((child) => isRecord(child) && required(child as { props?: unknown; children?: readonly unknown[] }));
  };
  return required(node);
}

/** Every id in a tree, added to `into`. */
function idsIn(node: ShopTreeNode, into: Set<string> = new Set()): Set<string> {
  if (typeof node.id === 'string') into.add(node.id);
  for (const child of node.children ?? []) if (isRecord(child)) idsIn(child, into);
  return into;
}

/**
 * The id of the nearest shop control among `ancestors` (nearest first), or
 * undefined: which control a part belongs to.
 */
export function nearestShopControlId(ancestors: readonly { id?: unknown; props?: unknown }[]): string | undefined {
  const control = ancestors.find((ancestor) => shopControlKindOf(ancestor.props));
  return control && typeof control.id === 'string' ? control.id : undefined;
}

/** Whether a subtree holds a part that belongs to a control outside it (not under a control inside it). */
export function holdsOutsidePart(node: { props?: unknown; children?: readonly unknown[] | Iterable<unknown> }): boolean {
  if (shopControlKindOf(node.props)) return false;
  if (shopPartRoleOf(node.props)) return true;
  return childrenOf(node as ReadableNode).some((child) => holdsOutsidePart(child as { props?: unknown }));
}

/**
 * A copy of a subtree in which every part that belongs to a control outside it is a
 * plain node with a fresh id: what a duplicated part, or a part moved to another
 * control or out of any, becomes. Parts under a control inside the subtree keep
 * their role (a duplicated control is a control). `freshId` names the new ids.
 */
export function withoutOutsideRoles<N extends { id?: string; props?: Record<string, unknown>; children?: N[]; parentId?: string }>(
  node: N,
  freshId: (oldId: string) => string,
  parentId?: string,
): N {
  if (shopControlKindOf(node.props)) return parentId === undefined ? node : { ...node, parentId };
  const role = shopPartRoleOf(node.props);
  const id = role && typeof node.id === 'string' ? freshId(node.id) : node.id;
  const props = role ? Object.fromEntries(Object.entries(node.props ?? {}).filter(([key]) => key !== SHOP_PART_ATTR)) : node.props;
  return {
    ...node,
    id,
    props,
    ...(parentId !== undefined ? { parentId } : {}),
    ...(node.children ? { children: node.children.map((child) => withoutOutsideRoles(child, freshId, id)) } : {}),
  } as N;
}

function cloneTree(node: ShopTreeNode): ShopTreeNode {
  return { ...node, ...(node.children ? { children: node.children.map(cloneTree) } : {}) };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
