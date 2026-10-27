// src/server/commerce/mail/templates.ts
//
// The shop's two mails as Lumitra Mail stores them (docs/plans/2026-10-27-shop-receipt-email.md), installed into
// the shop's workspace when the owner connects it, found again by name, and declared with their inputs so the
// mail dashboard names where each value comes from. German is the main language (the shops are German
// businesses), English a ready translation; a letter is written from the published site's language.
//
// Both are transactional: they answer what the reader did (they ordered, they paid), so they carry no
// unsubscribe link (Lumitra Mail refuses one that places `{{unsubscribe_url}}`) and an unsubscribe does not stop
// them. Every value is filled by the shop; Lumitra Mail formats nothing, so amounts and dates arrive as text.

import { createHash } from 'node:crypto';
import type { TemplateCreate, TemplateDocument, TemplateInputMap } from '@marlinjai/mail-contract';

export const SHOP_MAIL_KINDS = ['order_confirmation', 'late_refund'] as const;
export type ShopMailKind = (typeof SHOP_MAIL_KINDS)[number];

export const MAIN_LOCALE = 'de';
export const TEMPLATE_LOCALES = ['de', 'en'] as const;
export type ShopMailLocale = (typeof TEMPLATE_LOCALES)[number];

/** The name the inputs are declared under, shown in the mail dashboard next to each value. */
export const DECLARING_APP = 'Lumitra Sites';

type Copy = { title: string; subject: string; preheader: string; blocks: { id: string; html: string }[] };

const INK = '#1f1f1f';
const QUIET = '#6b6b6b';

function document(copy: Copy): TemplateDocument {
  return {
    version: '1.0',
    metadata: { title: copy.title },
    sections: [
      {
        id: 'sec-letter',
        type: 'section',
        columns: [
          {
            id: 'col-letter',
            blocks: copy.blocks.map((block) => ({
              id: block.id,
              type: 'text',
              content: block.html,
              align: 'left',
              color: block.id === 'footer' ? QUIET : INK,
              fontSize: block.id === 'footer' ? '13px' : '16px',
              lineHeight: '1.5',
            })),
          },
        ],
      },
    ],
  } as TemplateDocument;
}

const p = (html: string) => `<p>${html}</p>`;

const GREETING = {
  by: 'first_name',
  de: { filled: 'Hallo {{first_name}},', otherwise: 'Hallo,' },
  en: { filled: 'Hello {{first_name}},', otherwise: 'Hello,' },
};

const FOOTER = {
  de: 'Sie bekommen diese Mail, weil Sie bei {{shop_name}} bestellt haben.',
  en: 'You are getting this mail because you ordered from {{shop_name}}.',
};

interface MailSpec {
  kind: ShopMailKind;
  name: string;
  description: string;
  copy: Record<ShopMailLocale, Copy>;
}

const SPECS: Record<ShopMailKind, MailSpec> = {
  order_confirmation: {
    kind: 'order_confirmation',
    name: 'Lumitra Sites: order confirmation with receipt',
    description:
      'Sent to the buyer when a shop order is paid and its receipt issued. Installed by Lumitra Sites; edits here are replaced when the shop connects again.',
    copy: {
      de: {
        title: 'Ihre Bestellung',
        subject: 'Ihre Bestellung {{order_number}} bei {{shop_name}}',
        preheader: 'Bezahlt: {{total_text}}. Ihre Rechnung liegt bereit.',
        blocks: [
          { id: 'greeting', html: p('{{greeting}}') },
          { id: 'thanks', html: p('vielen Dank für Ihre Bestellung bei {{shop_name}}. Ihre Zahlung ist eingegangen.') },
          { id: 'order', html: p('<strong>Bestellung {{order_number}}</strong><br>{{order_date_text}}<br>Gesamt: {{total_text}}') },
          { id: 'receipt', html: p('<a href="{{receipt_url}}">Rechnung {{receipt_number}} als PDF</a>') },
          { id: 'footer', html: p(FOOTER.de) },
        ],
      },
      en: {
        title: 'Your order',
        subject: 'Your order {{order_number}} from {{shop_name}}',
        preheader: 'Paid: {{total_text}}. Your receipt is ready.',
        blocks: [
          { id: 'greeting', html: p('{{greeting}}') },
          { id: 'thanks', html: p('thank you for your order from {{shop_name}}. Your payment has been received.') },
          { id: 'order', html: p('<strong>Order {{order_number}}</strong><br>{{order_date_text}}<br>Total: {{total_text}}') },
          { id: 'receipt', html: p('<a href="{{receipt_url}}">Receipt {{receipt_number}} as PDF</a>') },
          { id: 'footer', html: p(FOOTER.en) },
        ],
      },
    },
  },
  late_refund: {
    kind: 'late_refund',
    name: 'Lumitra Sites: late payment refunded',
    description:
      'Sent to the buyer when a payment arrived after the order had closed and its items were gone, so it was refunded in full. Installed by Lumitra Sites; edits here are replaced when the shop connects again.',
    copy: {
      de: {
        title: 'Ihre Zahlung wurde erstattet',
        subject: 'Ihre Zahlung für {{order_number}} bei {{shop_name}} wurde erstattet',
        preheader: '{{total_text}} gehen an Sie zurück.',
        blocks: [
          { id: 'greeting', html: p('{{greeting}}') },
          {
            id: 'what',
            html: p(
              'Ihre Zahlung für die Bestellung {{order_number}} kam an, nachdem die Bestellung abgelaufen war, und die Artikel waren inzwischen vergeben. Wir haben Ihnen deshalb den vollen Betrag von {{total_text}} erstattet.',
            ),
          },
          { id: 'when', html: p('Je nach Zahlungsart sehen Sie die Gutschrift in einigen Tagen auf Ihrem Konto.') },
          { id: 'footer', html: p(FOOTER.de) },
        ],
      },
      en: {
        title: 'Your payment was refunded',
        subject: 'Your payment for {{order_number}} from {{shop_name}} was refunded',
        preheader: '{{total_text}} is on its way back to you.',
        blocks: [
          { id: 'greeting', html: p('{{greeting}}') },
          {
            id: 'what',
            html: p(
              'Your payment for order {{order_number}} arrived after the order had expired, and its items had gone in the meantime. We have therefore refunded the full {{total_text}}.',
            ),
          },
          { id: 'when', html: p('Depending on how you paid, the refund shows on your account within a few days.') },
          { id: 'footer', html: p(FOOTER.en) },
        ],
      },
    },
  },
};

const derived = (note: string) => ({ kind: 'derived' as const, note });

const COMMON = {
  first_name: {
    kind: 'text',
    label: "The buyer's first name for the greeting",
    source: derived('The first word of the name the buyer gave at checkout; left out when there is none.'),
    optional: true,
    example: 'Anna',
  },
  shop_name: { kind: 'text', label: "The shop's name", source: derived("The published site's name."), example: 'Schmuck Testshop' },
  order_number: { kind: 'text', label: 'The order number', source: derived('The order number the buyer saw at checkout.'), example: 'ORD-000004' },
  total_text: { kind: 'text', label: 'The amount paid', source: derived("The order total, written in the letter's language."), example: '74,00 €' },
} satisfies TemplateInputMap;

/** What each mail receives: declared on its template, and the only names the shop sends. */
export const MAIL_INPUTS: Record<ShopMailKind, TemplateInputMap> = {
  order_confirmation: {
    ...COMMON,
    order_date_text: {
      kind: 'text',
      label: 'When the order was placed',
      source: derived("The order's date, written in the letter's language (Europe/Berlin)."),
      example: '27. Oktober 2026',
    },
    receipt_number: { kind: 'text', label: 'The receipt number', source: derived("The receipt invoice's number in the company's Books."), example: 'RE-3' },
    receipt_url: {
      kind: 'url',
      label: 'The link to the receipt PDF',
      source: derived('The signed address of the receipt invoice on app.lumitra.co; it does not expire.'),
      example: 'https://app.lumitra.co/api/receipts/v1.example.signature',
    },
  },
  late_refund: { ...COMMON },
};

/** The body of `templates.create` for one mail: German main version, English ready translation, the greeting. */
export function templateCreate(kind: ShopMailKind): TemplateCreate & { name: string } {
  const spec = SPECS[kind];
  const de = spec.copy.de;
  const en = spec.copy.en;
  return {
    name: spec.name,
    description: spec.description,
    locale: MAIN_LOCALE,
    subject: de.subject,
    preheader: de.preheader,
    document: document(de),
    insertions: { greeting: { by: GREETING.by, choices: {}, filled: GREETING.de.filled, otherwise: GREETING.de.otherwise } },
    translations: {
      en: {
        subject: en.subject,
        preheader: en.preheader,
        document: document(en),
        status: 'ready',
        insertions: { greeting: { choices: {}, filled: GREETING.en.filled, otherwise: GREETING.en.otherwise } },
      },
    },
  } as TemplateCreate & { name: string };
}

/** The template's name in the workspace (how an install finds it again). */
export function templateName(kind: ShopMailKind): string {
  return SPECS[kind].name;
}

/** A digest of everything an install writes: a stored version that differs means the workspace needs an update. */
export function templatesVersion(): string {
  const everything = SHOP_MAIL_KINDS.map((kind) => ({ kind, template: templateCreate(kind), inputs: MAIL_INPUTS[kind] }));
  return createHash('sha256').update(JSON.stringify(everything)).digest('hex').slice(0, 16);
}
