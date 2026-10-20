// src/server/books/render/completeness.ts
//
// The legal completeness check AS CODE (Books plan section 5, phase 3): given
// an issued document and the text actually drawn into its PDF, name every
// required field that is missing. It is run on every PDF before it is stored
// (store.ts refuses an incomplete one with RENDER_INCOMPLETE) and by the tests
// against the real renderer, so a layout change that drops a field fails CI.
//
// The expected values are derived HERE, from the document's frozen data (its
// snapshots, stored lines and totals), independently of the render model, so a
// renderer that forgets a field cannot also forget to expect it.
//
// Under Section 19 (small business, kleinunternehmer), section 34a UStDV:
//   sender: full name, address, and a tax number, VAT id or small-business id
//   recipient: full name and address
//   the issue date
//   quantity and kind of every service or delivery (each billable line)
//   the amount in one sum, and the note that the Section 19 exemption applies
// Under regular taxation, section 14 (4) UStG, additionally:
//   the sequential document number, the service date or period, the net
//   amount per tax rate with the rate and the tax amount, the recipient's VAT
//   id and the reverse-charge note when the tax liability shifts (section 14a)
// The document number is required under both (it identifies the document, and
// this renderer always prints it).
//
// Matching is on the normalized text (format.ts toPdfText) with ALL whitespace
// removed on both sides, so a value wrapped over several lines (or a long word
// broken as a last resort) still counts as present; and on label plus value
// where a bare value could match elsewhere ("Rechnungsdatum 19.10.2026", not
// just "19.10.2026", which the due date or the service date may also be).
//
// A credit note must name the invoice it cancels (number and date) in its
// reference line; reverse charge must print the recipient's VAT id itself.

import type { SalesDocumentLine, SalesDocumentWithSnapshots } from '../repository/read';
import { formatDate, formatMoney, formatQuantity, formatRate, postalCity, toPdfText } from './format';
import { amountSign, serviceDateValue } from './model';

export interface Expectation {
  /** A stable field name (reported when missing). */
  field: string;
  /** The text that must appear. */
  text: string;
}

function present(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** What a check needs besides the document: the invoice a credit note cancels. */
export interface CompletenessContext {
  corrects?: { documentNumber: string; issueDate: string } | null;
}

/** What the rendered text of an issued document must contain. */
export function expectedFields(
  doc: SalesDocumentWithSnapshots,
  lines: SalesDocumentLine[],
  context: CompletenessContext = {},
): Expectation[] {
  const s = doc.senderSnapshot;
  const c = doc.customerSnapshot;
  if (!s || !c || !doc.documentNumber || !doc.issueDate) {
    throw new Error('expectedFields: only an issued document with its snapshots can be checked');
  }
  const out: Expectation[] = [];
  const add = (field: string, text: string | null | undefined) => {
    out.push({ field, text: present(text) ? toPdfText(text) : '' });
  };

  // Issuer.
  add('sender.legalName', s.legalName);
  add('sender.addressLine1', s.addressLine1);
  add('sender.postalCity', postalCity(s.postalCode, s.city));
  const taxIds: Array<[string, string, string | null]> = [
    ['sender.taxNumber', 'Steuernummer:', s.taxNumber],
    ['sender.vatId', 'USt-IdNr.:', s.vatId],
    ['sender.smallBusinessId', 'Kleinunternehmer-ID:', s.smallBusinessId],
  ];
  const accepted = doc.reverseCharge
    ? taxIds.filter(([f]) => f === 'sender.vatId')
    : doc.kleinunternehmer
      ? taxIds
      : taxIds.filter(([f]) => f !== 'sender.smallBusinessId');
  const given = accepted.filter(([, , v]) => present(v));
  // At least one accepted id is required; every one that is set must be printed.
  if (given.length === 0) add('sender.taxId', null);
  for (const [field, label, value] of given) add(field, `${label} ${value}`);

  // Recipient.
  add('recipient.name', c.name);
  add('recipient.addressLine1', c.addressLine1);
  add('recipient.postalCity', postalCity(c.postalCode, c.city));

  // Document data.
  const isCredit = doc.docType === 'credit_note';
  add('documentNumber', `${isCredit ? 'Gutschriftsnummer' : 'Rechnungsnummer'} ${doc.documentNumber}`);
  add('issueDate', `${isCredit ? 'Datum' : 'Rechnungsdatum'} ${formatDate(doc.issueDate)}`);
  if (isCredit) {
    const c2 = context.corrects;
    add(
      'correctsReference',
      c2 ? `Storno der Rechnung ${c2.documentNumber} vom ${formatDate(c2.issueDate)}` : null,
    );
  }

  // Quantity and kind of every billable line.
  for (const l of lines) {
    if (l.kind === 'text') continue;
    add(`line${l.position}.title`, l.title);
    add(`line${l.position}.quantity`, `${formatQuantity(l.quantity)} ${toPdfText(l.unitLabel)}`);
  }

  // The amount.
  const sign = amountSign(doc.docType);
  add('total', `Gesamtbetrag ${formatMoney(sign * doc.total, doc.currencyCode)}`);

  if (doc.kleinunternehmer) {
    add('exemptionNote', doc.taxNote);
    return out;
  }

  // Regular taxation, section 14 (4) UStG.
  const service = serviceDateValue(doc);
  add('serviceDate', `${service.label} ${service.value}`);
  for (const g of doc.taxSummary) {
    const rc = g.taxTreatment === 'reverse_charge' ? ' (Reverse Charge)' : '';
    add(`taxGroup${g.taxRate}.net`, `Nettobetrag zu ${formatRate(g.taxRate)}${rc} ${formatMoney(sign * g.net, doc.currencyCode)}`);
    add(`taxGroup${g.taxRate}.tax`, `Umsatzsteuer ${formatRate(g.taxRate)} ${formatMoney(sign * g.tax, doc.currencyCode)}`);
  }
  if (doc.reverseCharge) {
    add('recipient.vatId', present(c.vatId) ? `USt-IdNr. Leistungsempfänger ${c.vatId}` : null);
    add('reverseChargeNote', doc.taxNote);
  }
  return out;
}

const squeeze = (s: string) => s.replace(/\s+/g, '');

/** The names of the required fields missing from `renderedText` (empty when complete). */
export function missingFields(
  doc: SalesDocumentWithSnapshots,
  lines: SalesDocumentLine[],
  renderedText: string,
  context: CompletenessContext = {},
): string[] {
  const haystack = squeeze(renderedText);
  return expectedFields(doc, lines, context)
    .filter((e) => e.text === '' || !haystack.includes(squeeze(e.text)))
    .map((e) => e.field);
}
