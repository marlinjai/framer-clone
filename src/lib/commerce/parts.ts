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
import { isFormattedText } from '@/lib/renderer/textNode';
import type { StoredRule } from '@/lib/rules/rules';
import { HOVER_GATE } from '@/lib/rules/states';

/** The role marker on a part node, like `data-form-kind` on a form field. Never `data-component-kind`. */
export const SHOP_PART_ATTR = 'data-shop-part';

export type ShopLocale = 'en' | 'de';

/** 'de' for a German site language ("de", "de-AT"), else 'en'. */
export function shopLocaleOf(language: string | null | undefined): ShopLocale {
  return localeOf(language);
}

type Localized = Readonly<Record<ShopLocale, string>>;

/** The shop controls whose visible parts are nodes. */
export type ShopControlKind = 'checkout-button';

export const SHOP_CONTROL_KINDS: readonly ShopControlKind[] = ['checkout-button'];

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
            style: { ...PRIMARY_BUTTON, border: '1px solid #065f46', backgroundColor: '#065f46' },
            rules: BUTTON_RULES(),
            children: [
              { role: 'checkout.pay-label', label: 'Label', tag: 'span', required: true, text: { en: 'Pay {total}', de: '{total} bezahlen' } },
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
        text: { en: 'Order {orderNumber} confirmed. Total: {total}.', de: 'Bestellung {orderNumber} bestätigt. Gesamt: {total}.' },
      },
      {
        role: 'checkout.payment-ref',
        label: 'Payment reference (demo)',
        tag: 'div',
        required: true,
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
  { id: 'returned-paid', label: 'Back from payment: paid' },
  { id: 'returned-cancelled', label: 'Back from payment: cancelled' },
  { id: 'shortage', label: 'Not enough stock' },
  { id: 'items-unavailable', label: 'Items no longer sold' },
  { id: 'error', label: 'Checkout failed' },
] as const satisfies readonly ShopPreviewState[];

export type CheckoutPreviewStateId = (typeof CHECKOUT_PREVIEW_STATES)[number]['id'];

export const SHOP_CONTROLS: Readonly<Record<ShopControlKind, ShopControlSpec>> = {
  'checkout-button': { kind: 'checkout-button', states: CHECKOUT_PREVIEW_STATES, parts: CHECKOUT_PARTS },
};

/** The default style of a checkout control: a column, so its steps stack. */
export const CHECKOUT_CONTROL_STYLE: Readonly<Record<string, unknown>> = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '8px',
  padding: '4px',
};

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
export function shopPartText(role: string, stored: unknown, locale: ShopLocale): unknown {
  const spec = shopPartSpec(role);
  if (!spec || spec.dynamicText) return undefined;
  if (spec.fixedText) return spec.fixedText[locale];
  if (typeof stored === 'string' && stored.trim().length > 0) return stored;
  if (isFormattedText(stored)) return stored;
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

function newPartNode(
  spec: ShopPartSpec,
  controlId: string,
  parentId: string,
  locale: ShopLocale,
  shape: ShopNodeShape,
  textOverride?: string,
): ShopTreeNode {
  const node: ShopTreeNode = {
    id: shopPartId(controlId, spec.role),
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

/** Legacy props of a control that become part text: the label of the old one-prop checkout. */
function legacyTexts(kind: ShopControlKind, props: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (kind === 'checkout-button') {
    const label = props?.label;
    if (typeof label === 'string' && label.trim()) out['checkout.button-label'] = label;
    const pay = props?.payLabel;
    if (typeof pay === 'string' && pay.trim()) out['checkout.pay-label'] = `${pay} {total}`;
  }
  return out;
}

/** The control props the parts replace. */
const LEGACY_CONTROL_PROPS: Readonly<Record<ShopControlKind, readonly string[]>> = {
  'checkout-button': ['label', 'payLabel'],
};

/** A whole default part tree for a control, as nodes with deterministic ids (a palette insert, the demo seed). */
export function buildShopParts(
  kind: ShopControlKind,
  controlId: string,
  locale: ShopLocale,
  shape: ShopNodeShape = 'snapshot',
  texts: Readonly<Record<string, string>> = {},
): ShopTreeNode[] {
  const build = (specs: readonly ShopPartSpec[], parentId: string): ShopTreeNode[] =>
    specs.map((spec) => {
      const node = newPartNode(spec, controlId, parentId, locale, shape, texts[spec.role]);
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

const HIDING_VALUES: Readonly<Record<string, (value: string) => boolean>> = {
  display: (value) => value.trim().toLowerCase() === 'none',
  visibility: (value) => value.trim().toLowerCase() !== 'visible',
  opacity: (value) => Number.parseFloat(value) < 0.5,
  contentVisibility: (value) => value.trim().toLowerCase() === 'hidden',
};

/** Whether a stored style value hides (scalar, or any breakpoint of a responsive map). */
function hides(key: string, value: unknown): boolean {
  const test = HIDING_VALUES[key];
  if (!test) return false;
  if (isRecord(value)) return Object.values(value).some((entry) => hides(key, entry));
  return (typeof value === 'string' || typeof value === 'number') && test(String(value));
}

function withoutHidingStyle(style: unknown): Record<string, unknown> | undefined {
  if (!isRecord(style)) return undefined;
  return Object.fromEntries(Object.entries(style).filter(([key, value]) => !hides(key, value)));
}

/**
 * A fixed-text part as it must reach a page: no stored text (the island writes the
 * platform's), and nothing that hides it, in its style or any of its rules, nor a
 * `hidden` or `aria-hidden` attribute. It can be styled, never removed from sight.
 */
function enforcedFixedPart(node: ShopTreeNode): ShopTreeNode {
  const props = { ...(node.props ?? {}) };
  delete props.children;
  delete props.hidden;
  delete props['aria-hidden'];
  const style = withoutHidingStyle(props.style);
  if (style) props.style = style;
  if (Array.isArray(props.rules)) {
    props.rules = (props.rules as unknown[]).map((rule) =>
      isRecord(rule) && isRecord(rule.style) ? { ...rule, style: withoutHidingStyle(rule.style) } : rule,
    );
  }
  return { ...node, props };
}

/** A dynamic part stores no text: what it shows is the island's. */
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
export function normalizeShopControl<N extends object>(input: N, locale: ShopLocale, shape: ShopNodeShape, asKind?: ShopControlKind): N {
  const control = input as ShopTreeNode;
  // The island knows what it is even when the node it was handed lacks the marker.
  const kind = asKind ?? shopControlKindOf(control.props);
  if (!kind) return input;
  const controlId = typeof control.id === 'string' && control.id ? control.id : `shop-${kind}`;
  const existing = partsByRole(control);
  let changed = false;
  let root: ShopTreeNode = control;

  if (existing.size === 0) {
    root = { ...control, children: [...(control.children ?? []), ...buildShopParts(kind, controlId, locale, shape, legacyTexts(kind, control.props))] };
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
      root = cloneTree(control);
      const byRole = partsByRole(root);
      for (const { spec, parentRole } of missing) {
        const parent = parentRole ? byRole.get(parentRole) : root;
        // A required part's parent is required too, so it exists by now.
        if (!parent) continue;
        const node = newPartNode(spec, controlId, String(parent.id ?? controlId), locale, shape);
        const siblings = parent.children ?? [];
        const at = insertIndex(siblings, spec, parentRole, kind);
        parent.children = [...siblings.slice(0, at), node, ...siblings.slice(at)];
        byRole.set(spec.role, node);
      }
      changed = true;
    }
  }

  // Legacy label props leave the control once their text lives in the parts.
  const legacy = LEGACY_CONTROL_PROPS[kind].filter((key) => root.props && key in root.props);
  if (legacy.length > 0) {
    const props = { ...(root.props ?? {}) };
    for (const key of legacy) delete props[key];
    root = { ...root, props };
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

/** Fixed and dynamic text enforced on every part of a control's subtree; the same object when nothing changes. */
function enforceParts(node: ShopTreeNode): ShopTreeNode {
  let changed = false;
  const children = node.children?.map((child) => {
    if (shopControlKindOf(child.props)) return child;
    let next = enforceParts(child);
    const role = shopPartRoleOf(child.props);
    const spec = role ? shopPartSpec(role) : undefined;
    if (spec?.fixedText) next = enforcedFixedPart(next);
    else if (spec?.dynamicText) next = withoutStoredText(next);
    if (next !== child && !sameJson(next, child)) changed = true;
    else next = child;
    return next;
  });
  return changed ? { ...node, children } : node;
}

/**
 * Every shop control in a tree normalised (normalizeShopControl). Unchanged trees
 * come back as the same object, so a caller can tell nothing was rewritten.
 */
export function withShopParts<N extends object>(root: N, locale: ShopLocale, shape: ShopNodeShape): N {
  const walk = (node: ShopTreeNode): ShopTreeNode => {
    const children = Array.isArray(node.children) ? node.children : null;
    const nextChildren = children ? children.map(walk) : null;
    const changedChildren = !!children && nextChildren!.some((child, i) => child !== children[i]);
    const withChildren = changedChildren ? { ...node, children: nextChildren! } : node;
    return shopControlKindOf(withChildren.props) ? normalizeShopControl(withChildren, locale, shape) : withChildren;
  };
  return walk(root as ShopTreeNode) as N;
}

/** A stored page snapshot with every shop control normalised: its tree and its floating canvas nodes. */
export function pageWithShopParts<P extends { appComponentTree?: unknown; canvasNodes?: unknown }>(page: P, language: string | null | undefined): P {
  const locale = shopLocaleOf(language);
  let next = page;
  if (isRecord(page.appComponentTree)) {
    const tree = withShopParts(page.appComponentTree as ShopTreeNode, locale, 'snapshot');
    if (tree !== page.appComponentTree) next = { ...next, appComponentTree: tree };
  }
  if (isRecord(page.canvasNodes)) {
    const nodes = page.canvasNodes as Record<string, ShopTreeNode>;
    let changed = false;
    const out: Record<string, ShopTreeNode> = {};
    for (const [id, node] of Object.entries(nodes)) {
      out[id] = isRecord(node) ? withShopParts(node, locale, 'snapshot') : node;
      if (out[id] !== node) changed = true;
    }
    if (changed) next = { ...next, canvasNodes: out };
  }
  return next;
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

function cloneTree(node: ShopTreeNode): ShopTreeNode {
  return { ...node, ...(node.children ? { children: node.children.map(cloneTree) } : {}) };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
