// src/server/books/template/labels.ts
//
// Every fixed text a Books document prints, by label id and locale (visual
// template composer plan, decision 13). The render model (render/model.ts)
// prints them and the completeness check (render/completeness.ts) expects them
// from this one dictionary, so a label can never differ between paper and
// check. The labels of legally checked fields are NOT editable in a template:
// the check matches label plus value, and a custom label could make a value
// ambiguous (a due date read as the issue date).
//
// One locale today (de-DE); a second language is this dictionary plus date and
// number formats (phase 6, built when a client needs it).

export type Locale = 'de-DE';

const DE = {
  // Titles.
  'title.invoice': 'Rechnung',
  'title.creditNote': 'Gutschrift (Stornorechnung)',
  'title.offer': 'Angebot',
  'title.other': 'Dokument',
  'title.draftSuffix': ' (Entwurf)',
  'title.draftNumber': 'Entwurf',
  // Document data.
  'meta.invoiceNumber': 'Rechnungsnummer',
  'meta.creditNoteNumber': 'Gutschriftsnummer',
  'meta.invoiceDate': 'Rechnungsdatum',
  'meta.creditNoteDate': 'Datum',
  'meta.serviceDate': 'Leistungsdatum',
  'meta.servicePeriod': 'Leistungszeitraum',
  'meta.servicePeriodJoin': ' bis ',
  'meta.serviceDateIsIssueDate': 'entspricht dem Rechnungsdatum',
  'meta.customerNumber': 'Kundennummer',
  'meta.contract': 'Vertrag',
  'meta.recipientVatId': 'USt-IdNr. Leistungsempfänger',
  'meta.dueDate': 'Fällig am',
  'meta.numberPending': 'wird bei Ausstellung vergeben',
  'meta.datePending': 'wird bei Ausstellung gesetzt',
  // A credit note's reference to the invoice it cancels: "Storno der Rechnung 62 vom 19.10.2026".
  'reference.cancels': 'Storno der Rechnung',
  'reference.replaces': 'Ersetzt Rechnung',
  'reference.of': 'vom',
  // Line table.
  'table.pos': 'Pos.',
  'table.title': 'Bezeichnung',
  'table.quantity': 'Menge',
  'table.unit': 'Einheit',
  'table.unitPrice': 'Einzelpreis',
  'table.rate': 'USt',
  'table.amount': 'Betrag',
  'table.amountGross': 'Betrag (brutto)',
  'table.discount': 'Rabatt',
  'table.discountPrefix': 'abzüglich',
  // Totals.
  'totals.total': 'Gesamtbetrag',
  'totals.netAt': 'Nettobetrag zu',
  'totals.reverseChargeSuffix': ' (Reverse Charge)',
  'totals.vatAt': 'Umsatzsteuer',
  'totals.sumNet': 'Summe netto',
  'totals.sumVat': 'Summe Umsatzsteuer',
  // Payment.
  'payment.dueBy': 'Bitte überweisen Sie den Gesamtbetrag bis zum',
  'payment.paidOn': 'Bezahlt am',
  'payment.paidSuffix': 'Es ist kein Betrag offen.',
  'payment.termsPrefix': 'Zahlbar innerhalb von',
  'payment.termsSuffix': 'Tagen nach Rechnungsdatum.',
  'payment.reference': 'Verwendungszweck:',
  'payment.qrPlaceholder': 'QR-Code erscheint bei Ausstellung',
  // Sender.
  'sender.taxNumber': 'Steuernummer:',
  'sender.vatId': 'USt-IdNr.:',
  'sender.smallBusinessId': 'Kleinunternehmer-ID:',
  'sender.phone': 'Telefon:',
  'sender.email': 'E-Mail:',
  'sender.managingDirector': 'Geschäftsführung:',
  // Pages and stamps.
  'page.of': 'Seite {n} von {m}',
  'stamp.draft': 'ENTWURF - KEINE RECHNUNG',
  'stamp.preview': 'VORSCHAU, KEIN BELEG',
} as const;

export type LabelId = keyof typeof DE;

const DICTIONARIES: Record<Locale, Record<LabelId, string>> = { 'de-DE': DE };

/** The label for an id in a locale (de-DE when none is given). */
export function label(id: LabelId, locale: Locale = 'de-DE'): string {
  return DICTIONARIES[locale][id];
}

/** "Seite 2 von 3". */
export function pageOf(n: number, m: number, locale: Locale = 'de-DE'): string {
  return label('page.of', locale).replace('{n}', String(n)).replace('{m}', String(m));
}
