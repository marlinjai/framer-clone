// src/server/books/render/model.ts
//
// The render model: everything a document shows, as plain strings, built by a
// pure function. The PDF writer (pdf.ts) only lays these strings out, and the
// completeness check (completeness.ts) reads the drawn text back, so a field
// the law requires cannot silently disappear between data and paper.
//
// An ISSUED document is modelled only from what was frozen at issue: the
// customer and sender snapshots, the stored lines, the stored totals and tax
// summary. Nothing is recomputed and nothing live is read (the contacts
// database, the customer row, the company setting): mutating any of those after
// issue cannot change a re-render (Books plan section 5, phase 3). The template
// supplies layout only (accent colour, footer small print); the stored PDF of
// record captures the template as it stood when the document was first
// rendered, right after issue.
//
// A DRAFT preview is modelled from live data (the company setting's sender, the
// customer's current contact) and is marked as a draft on every page; it is
// never stored and never a document of record.

import type { SalesDocumentLine, SalesDocumentWithSnapshots } from '../repository/read';
import type { FooterBlock } from '../repository/templates';
import type { SenderBlockV1 } from '../snapshots';
import { formatDate, formatMoney, formatQuantity, formatRate, postalCity, toPdfText } from './format';

export interface RenderRecipient {
  name: string;
  companyOrRole: string;
  legalForm: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  customerNumber: number | null;
  vatId: string | null;
}

export interface RenderInput {
  draft: boolean;
  document: SalesDocumentWithSnapshots;
  lines: SalesDocumentLine[];
  sender: SenderBlockV1 | null;
  recipient: RenderRecipient | null;
  /** For a credit note: the invoice it cancels. */
  corrects: { documentNumber: string; issueDate: string } | null;
  template: { accentColor: string | null; footerBlocks: FooterBlock[] } | null;
}

export interface ModelLine {
  pos: string;
  title: string;
  details: string[];
  quantity: string;
  unit: string;
  unitPrice: string;
  rate: string;
  amount: string;
  text: boolean;
}

export interface RenderModel {
  draft: boolean;
  title: string;
  accentColor: string | null;
  senderLine: string;
  recipientBlock: string[];
  meta: Array<{ label: string; value: string }>;
  reference: string | null;
  intro: string | null;
  showRate: boolean;
  amountHeader: string;
  lines: ModelLine[];
  totals: Array<{ label: string; value: string; strong: boolean }>;
  notes: string[];
  payment: string[];
  outro: string | null;
  smallPrint: Array<{ heading: string | null; text: string }>;
  footer: string[][];
  pdfTitle: string;
  pdfDate: Date;
}

/** German names of the countries a recipient is most likely in; anything else prints its code. */
const COUNTRY_NAMES: Record<string, string> = {
  DE: 'Deutschland', AT: 'Österreich', CH: 'Schweiz', FR: 'Frankreich', NL: 'Niederlande',
  BE: 'Belgien', LU: 'Luxemburg', IT: 'Italien', ES: 'Spanien', PT: 'Portugal', PL: 'Polen',
  CZ: 'Tschechien', DK: 'Dänemark', SE: 'Schweden', FI: 'Finnland', IE: 'Irland', GB: 'Vereinigtes Königreich',
  US: 'Vereinigte Staaten',
};

/** The country line of a foreign address (DIN 5008: in capitals), or null for a domestic one. */
export function countryLine(country: string | null | undefined, senderCountry: string | null | undefined): string | null {
  const code = (country ?? '').trim().toUpperCase();
  const home = (senderCountry ?? 'DE').trim().toUpperCase() || 'DE';
  if (code === '' || code === home) return null;
  return (COUNTRY_NAMES[code] ?? code).toUpperCase();
}

function present(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** The recipient address block, line by line. */
export function recipientLines(r: RenderRecipient, senderCountry: string | null | undefined): string[] {
  const name = present(r.legalForm) && !r.name.includes(r.legalForm) ? `${r.name} ${r.legalForm}` : r.name;
  return [
    name,
    r.companyOrRole,
    r.addressLine1,
    r.addressLine2,
    postalCity(r.postalCode, r.city),
    countryLine(r.country, senderCountry),
  ]
    .filter(present)
    .map(toPdfText);
}

/** The sender's tax identification lines (section 14 (4) no. 2 UStG, section 34a UStDV). */
export function senderTaxLines(s: SenderBlockV1): string[] {
  const out: string[] = [];
  if (present(s.taxNumber)) out.push(`Steuernummer: ${s.taxNumber}`);
  if (present(s.vatId)) out.push(`USt-IdNr.: ${s.vatId}`);
  if (present(s.smallBusinessId)) out.push(`Kleinunternehmer-ID: ${s.smallBusinessId}`);
  return out.map(toPdfText);
}

/** The footer columns: identity, contact, tax and register, bank. Empty columns are left out. */
export function footerColumns(s: SenderBlockV1): string[][] {
  const identity = [s.legalName, s.addressLine1, s.addressLine2, postalCity(s.postalCode, s.city)];
  const contact = [
    present(s.phone) ? `Telefon: ${s.phone}` : null,
    present(s.email) ? `E-Mail: ${s.email}` : null,
    present(s.website) ? s.website : null,
  ];
  const legal = [
    ...senderTaxLines(s),
    present(s.registerCourt) || present(s.registerNumber)
      ? `${s.registerCourt ?? ''} ${s.registerNumber ?? ''}`.trim()
      : null,
    present(s.managingDirector) ? `Geschäftsführung: ${s.managingDirector}` : null,
  ];
  const bank = [
    s.bankName,
    present(s.iban) ? `IBAN: ${s.iban}` : null,
    present(s.bic) ? `BIC: ${s.bic}` : null,
  ];
  return [identity, contact, legal, bank]
    .map((col) => col.filter(present).map(toPdfText))
    .filter((col) => col.length > 0);
}

/** The sign a document's amounts are printed with: a credit note offsets, so its amounts print negative. */
export function amountSign(docType: string): 1 | -1 {
  return docType === 'credit_note' ? -1 : 1;
}

/** The amount a line shows: net, or gross when the document is priced gross under regular taxation. */
export function lineAmount(doc: SalesDocumentWithSnapshots, line: SalesDocumentLine): number {
  return doc.netOrGross === 'gross' && !doc.kleinunternehmer ? line.subtotal + line.taxAmount : line.subtotal;
}

function modelLines(doc: SalesDocumentWithSnapshots, lines: SalesDocumentLine[]): ModelLine[] {
  const sign = amountSign(doc.docType);
  let n = 0;
  return [...lines]
    .sort((a, b) => a.position - b.position)
    .map((l) => {
      const details: string[] = [];
      if (present(l.description)) details.push(toPdfText(l.description));
      if (l.kind === 'text') {
        return { pos: '', title: toPdfText(l.title), details, quantity: '', unit: '', unitPrice: '', rate: '', amount: '', text: true };
      }
      n += 1;
      if (l.discountBp > 0) details.push(`abzüglich ${formatRate(l.discountBp)} Rabatt`);
      return {
        pos: String(n),
        title: toPdfText(l.title),
        details,
        quantity: formatQuantity(l.quantity),
        unit: toPdfText(l.unitLabel),
        unitPrice: formatMoney(l.unitPrice),
        rate: formatRate(l.taxRate),
        amount: formatMoney(sign * lineAmount(doc, l)),
        text: false,
      };
    });
}

function modelTotals(doc: SalesDocumentWithSnapshots): RenderModel['totals'] {
  const sign = amountSign(doc.docType);
  const money = (c: number) => formatMoney(sign * c);
  if (doc.kleinunternehmer) return [{ label: 'Gesamtbetrag', value: money(doc.total), strong: true }];
  const out: RenderModel['totals'] = [];
  for (const g of doc.taxSummary) {
    const rc = g.taxTreatment === 'reverse_charge' ? ' (Reverse Charge)' : '';
    out.push({ label: `Nettobetrag zu ${formatRate(g.taxRate)}${rc}`, value: money(g.net), strong: false });
    out.push({ label: `Umsatzsteuer ${formatRate(g.taxRate)}`, value: money(g.tax), strong: false });
  }
  out.push({ label: 'Summe netto', value: money(doc.subtotal), strong: false });
  out.push({ label: 'Summe Umsatzsteuer', value: money(doc.taxAmount), strong: false });
  out.push({ label: 'Gesamtbetrag', value: money(doc.total), strong: true });
  return out;
}

const TITLES: Record<string, string> = { invoice: 'Rechnung', credit_note: 'Gutschrift (Stornorechnung)', offer: 'Angebot' };

/** The service date line (section 14 (4) no. 6 UStG); a missing date means the issue date. */
export function serviceDateValue(doc: SalesDocumentWithSnapshots): { label: string; value: string } {
  if (doc.servicePeriodStart && doc.servicePeriodEnd) {
    return {
      label: 'Leistungszeitraum',
      value: `${formatDate(doc.servicePeriodStart)} bis ${formatDate(doc.servicePeriodEnd)}`,
    };
  }
  if (doc.serviceDate) return { label: 'Leistungsdatum', value: formatDate(doc.serviceDate) };
  return { label: 'Leistungsdatum', value: 'entspricht dem Rechnungsdatum' };
}

/** Build the render model (pure; see the file header for what an issued document may read). */
export function buildRenderModel(input: RenderInput): RenderModel {
  const { document: doc, sender, recipient, draft } = input;
  const title = TITLES[doc.docType] ?? 'Dokument';

  const senderLine = sender
    ? [sender.legalName, sender.addressLine1, postalCity(sender.postalCode, sender.city)]
        .filter(present)
        .map(toPdfText)
        .join(' · ')
    : '';

  const meta: RenderModel['meta'] = [];
  const numberLabel = doc.docType === 'credit_note' ? 'Gutschriftsnummer' : 'Rechnungsnummer';
  meta.push({ label: numberLabel, value: doc.documentNumber ?? 'wird bei Ausstellung vergeben' });
  meta.push({
    label: doc.docType === 'credit_note' ? 'Datum' : 'Rechnungsdatum',
    value: doc.issueDate ? formatDate(doc.issueDate) : 'wird bei Ausstellung gesetzt',
  });
  meta.push(serviceDateValue(doc));
  if (recipient?.customerNumber != null) meta.push({ label: 'Kundennummer', value: String(recipient.customerNumber) });
  if (present(doc.contractReference)) meta.push({ label: 'Vertrag', value: toPdfText(doc.contractReference) });
  if (doc.reverseCharge && present(recipient?.vatId)) {
    meta.push({ label: 'USt-IdNr. Leistungsempfänger', value: toPdfText(recipient!.vatId!) });
  }

  const reference = input.corrects
    ? `Storno der Rechnung ${toPdfText(input.corrects.documentNumber)} vom ${formatDate(input.corrects.issueDate)}`
    : null;

  const notes: string[] = [];
  if (present(doc.taxNote)) notes.push(toPdfText(doc.taxNote));

  const payment: string[] = [];
  if (doc.docType === 'invoice') {
    if (doc.dueDate) {
      payment.push(`Bitte überweisen Sie den Gesamtbetrag bis zum ${formatDate(doc.dueDate)}.`);
    } else {
      payment.push(`Zahlbar innerhalb von ${doc.paymentTermsDays} Tagen nach Rechnungsdatum.`);
    }
    if (present(doc.paymentReference)) payment.push(`Verwendungszweck: ${toPdfText(doc.paymentReference)}`);
    if (sender && present(sender.iban)) {
      payment.push(
        [present(sender.bankName) ? sender.bankName : null, `IBAN ${sender.iban}`, present(sender.bic) ? `BIC ${sender.bic}` : null]
          .filter(present)
          .map(toPdfText)
          .join(' · '),
      );
    }
  }

  const amountHeader = doc.netOrGross === 'gross' && !doc.kleinunternehmer ? 'Betrag (brutto)' : 'Betrag';

  return {
    draft,
    title: draft ? `${title} (Entwurf)` : title,
    accentColor: input.template?.accentColor ?? null,
    senderLine,
    recipientBlock: recipient ? recipientLines(recipient, sender?.countryCode) : [],
    meta: meta.map((m) => ({ label: m.label, value: toPdfText(m.value) })),
    reference,
    intro: present(doc.introText) ? toPdfText(doc.introText) : null,
    showRate: !doc.kleinunternehmer,
    amountHeader,
    lines: modelLines(doc, input.lines),
    totals: modelTotals(doc),
    notes,
    payment,
    outro: present(doc.outroText) ? toPdfText(doc.outroText) : null,
    smallPrint: (input.template?.footerBlocks ?? []).map((b) => ({
      heading: present(b.heading) ? toPdfText(b.heading) : null,
      text: toPdfText(b.text),
    })),
    footer: sender ? footerColumns(sender) : [],
    pdfTitle: toPdfText(`${title} ${doc.documentNumber ?? 'Entwurf'}`),
    // Fixed per document, so a re-render writes the same metadata bytes.
    pdfDate: doc.issuedAt ?? new Date(Date.UTC(2000, 0, 1)),
  };
}
