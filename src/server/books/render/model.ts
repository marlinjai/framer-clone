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
import type { SenderBlockV1 } from '../snapshots';
import { label } from '../template/labels';
import type { MetaItem, SenderColumn } from '../template/schema';
import { looksLikeIban } from './epcQr';
import { formatDate, formatMoney, formatQuantity, formatRate, postalCity, toPdfText } from './format';

/** A small-print block of a version 1 template (heading and text). */
export interface FooterBlockV1 {
  heading?: string | null;
  text: string;
}

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
  /** For a replacement that prints its reference line: the invoice it replaces. */
  replaces?: { documentNumber: string; issueDate: string } | null;
  /** The version 1 template's layout (accent colour, small print); the layout engine takes its template separately. */
  template: { accentColor: string | null; footerBlocks: FooterBlockV1[] } | null;
}

/** What an EPC QR payment code needs, frozen from the document (null when the document carries none). */
export interface PaymentQrData {
  beneficiaryName: string;
  iban: string;
  bic: string | null;
  amountCents: number;
  currency: string;
  reference: string;
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
  // The layout engine's view (render/engine): the same strings, keyed by what they are.
  /** The document type (the engine prints no payment code on a credit note). */
  docType: string;
  /** The title without the draft suffix and the number ("Rechnung 62"), for a following page's header. */
  shortTitle: string;
  /** The document data by item; null when the document has none (no customer number, no contract). */
  metaItems: Record<MetaItem, { label: string; value: string } | null>;
  /** The sender footer by column (empty lists when the column has nothing to print). */
  senderColumns: Record<SenderColumn, string[]>;
  /** The data of an EPC QR payment code, or null when no correct code can be printed (decision 17). */
  paymentQr: PaymentQrData | null;
  /** A draft invoice that will carry a payment code once issued: the engine draws a placeholder. */
  paymentQrPending: boolean;
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
  if (present(s.taxNumber)) out.push(`${label('sender.taxNumber')} ${s.taxNumber}`);
  if (present(s.vatId)) out.push(`${label('sender.vatId')} ${s.vatId}`);
  if (present(s.smallBusinessId)) out.push(`${label('sender.smallBusinessId')} ${s.smallBusinessId}`);
  return out.map(toPdfText);
}

/** The sender footer by column: identity, contact, tax and register, bank (each possibly empty). */
export function senderColumnsOf(s: SenderBlockV1): Record<SenderColumn, string[]> {
  const identity = [s.legalName, s.addressLine1, s.addressLine2, postalCity(s.postalCode, s.city)];
  const contact = [
    present(s.phone) ? `${label('sender.phone')} ${s.phone}` : null,
    present(s.email) ? `${label('sender.email')} ${s.email}` : null,
    present(s.website) ? s.website : null,
  ];
  const legal = [
    ...senderTaxLines(s),
    present(s.registerCourt) || present(s.registerNumber)
      ? `${s.registerCourt ?? ''} ${s.registerNumber ?? ''}`.trim()
      : null,
    present(s.managingDirector) ? `${label('sender.managingDirector')} ${s.managingDirector}` : null,
  ];
  const bank = [
    s.bankName,
    present(s.iban) ? `IBAN: ${s.iban}` : null,
    present(s.bic) ? `BIC: ${s.bic}` : null,
  ];
  const clean = (col: Array<string | null | undefined>) => col.filter(present).map(toPdfText);
  return { identity: clean(identity), contact: clean(contact), legal: clean(legal), bank: clean(bank) };
}

/** The footer columns: identity, contact, tax and register, bank. Empty columns are left out. */
export function footerColumns(s: SenderBlockV1): string[][] {
  const c = senderColumnsOf(s);
  return [c.identity, c.contact, c.legal, c.bank].filter((col) => col.length > 0);
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
      if (l.discountBp > 0) details.push(`${label('table.discountPrefix')} ${formatRate(l.discountBp)} ${label('table.discount')}`);
      return {
        pos: String(n),
        title: toPdfText(l.title),
        details,
        quantity: formatQuantity(l.quantity),
        unit: toPdfText(l.unitLabel),
        unitPrice: formatMoney(l.unitPrice, doc.currencyCode),
        rate: formatRate(l.taxRate),
        amount: formatMoney(sign * lineAmount(doc, l), doc.currencyCode),
        text: false,
      };
    });
}

function modelTotals(doc: SalesDocumentWithSnapshots): RenderModel['totals'] {
  const sign = amountSign(doc.docType);
  const money = (c: number) => formatMoney(sign * c, doc.currencyCode);
  if (doc.kleinunternehmer) return [{ label: label('totals.total'), value: money(doc.total), strong: true }];
  const out: RenderModel['totals'] = [];
  for (const g of doc.taxSummary) {
    const rc = g.taxTreatment === 'reverse_charge' ? label('totals.reverseChargeSuffix') : '';
    out.push({ label: `${label('totals.netAt')} ${formatRate(g.taxRate)}${rc}`, value: money(g.net), strong: false });
    out.push({ label: `${label('totals.vatAt')} ${formatRate(g.taxRate)}`, value: money(g.tax), strong: false });
  }
  out.push({ label: label('totals.sumNet'), value: money(doc.subtotal), strong: false });
  out.push({ label: label('totals.sumVat'), value: money(doc.taxAmount), strong: false });
  out.push({ label: label('totals.total'), value: money(doc.total), strong: true });
  return out;
}

/** The title of a document type. */
export function titleOf(docType: string): string {
  return docType === 'invoice'
    ? label('title.invoice')
    : docType === 'credit_note'
      ? label('title.creditNote')
      : docType === 'offer'
        ? label('title.offer')
        : label('title.other');
}

/** The service date line (section 14 (4) no. 6 UStG); a missing date means the issue date. */
export function serviceDateValue(doc: SalesDocumentWithSnapshots): { label: string; value: string } {
  if (doc.servicePeriodStart && doc.servicePeriodEnd) {
    return {
      label: label('meta.servicePeriod'),
      value: `${formatDate(doc.servicePeriodStart)}${label('meta.servicePeriodJoin')}${formatDate(doc.servicePeriodEnd)}`,
    };
  }
  if (doc.serviceDate) return { label: label('meta.serviceDate'), value: formatDate(doc.serviceDate) };
  return { label: label('meta.serviceDate'), value: label('meta.serviceDateIsIssueDate') };
}

/**
 * Whether a document can carry a correct payment code once it has a number:
 * an invoice in EUR, a sender with a name and an IBAN, a total the code can
 * hold. The draft placeholder uses the same test, so it never promises a code
 * the issued invoice would not print.
 */
function qrEligible(doc: SalesDocumentWithSnapshots, sender: SenderBlockV1 | null): sender is SenderBlockV1 & { iban: string } {
  if (doc.docType !== 'invoice' || doc.currencyCode !== 'EUR' || !sender) return false;
  if (!present(sender.iban) || !looksLikeIban(sender.iban) || !present(sender.legalName)) return false;
  return doc.total >= 1 && doc.total <= QR_MAX_CENTS;
}

/** The most an EPC QR code may carry as the amount (EPC069-12: EUR 999999999.99). */
const QR_MAX_CENTS = 99_999_999_999;

/**
 * The data of an EPC QR payment code (decision 17), or null when no correct
 * code can be printed: only an issued invoice (never a credit note, never a
 * draft: a draft has no number for the reference) in EUR, with the sender's
 * IBAN, and a total from 0.01 to 999,999,999.99 EUR.
 */
export function paymentQrData(doc: SalesDocumentWithSnapshots, sender: SenderBlockV1 | null, draft: boolean): PaymentQrData | null {
  if (draft || !doc.documentNumber || !qrEligible(doc, sender)) return null;
  return {
    beneficiaryName: toPdfText(sender.legalName ?? ''),
    iban: sender.iban,
    bic: present(sender.bic) ? sender.bic : null,
    amountCents: doc.total,
    currency: 'EUR',
    reference: present(doc.paymentReference) ? toPdfText(doc.paymentReference) : `${label('title.invoice')} ${doc.documentNumber}`,
  };
}

/** Build the render model (pure; see the file header for what an issued document may read). */
export function buildRenderModel(input: RenderInput): RenderModel {
  const { document: doc, sender, recipient, draft } = input;
  const title = titleOf(doc.docType);

  const senderLine = sender
    ? [sender.legalName, sender.addressLine1, postalCity(sender.postalCode, sender.city)]
        .filter(present)
        .map(toPdfText)
        .join(' · ')
    : '';

  const isCredit = doc.docType === 'credit_note';
  const metaItems: RenderModel['metaItems'] = {
    number: {
      label: label(isCredit ? 'meta.creditNoteNumber' : 'meta.invoiceNumber'),
      value: doc.documentNumber ?? label('meta.numberPending'),
    },
    issueDate: {
      label: label(isCredit ? 'meta.creditNoteDate' : 'meta.invoiceDate'),
      value: doc.issueDate ? formatDate(doc.issueDate) : label('meta.datePending'),
    },
    serviceDate: serviceDateValue(doc),
    customerNumber: recipient?.customerNumber != null ? { label: label('meta.customerNumber'), value: String(recipient.customerNumber) } : null,
    contract: present(doc.contractReference) ? { label: label('meta.contract'), value: toPdfText(doc.contractReference) } : null,
    recipientVatId:
      doc.reverseCharge && present(recipient?.vatId) ? { label: label('meta.recipientVatId'), value: toPdfText(recipient!.vatId!) } : null,
    dueDate: doc.docType === 'invoice' && doc.dueDate ? { label: label('meta.dueDate'), value: formatDate(doc.dueDate) } : null,
  };
  // The version 1 order (the frozen renderer prints exactly these, never the due date).
  const meta: RenderModel['meta'] = [
    metaItems.number!,
    metaItems.issueDate!,
    metaItems.serviceDate!,
    ...(metaItems.customerNumber ? [metaItems.customerNumber] : []),
    ...(metaItems.contract ? [metaItems.contract] : []),
    ...(metaItems.recipientVatId ? [metaItems.recipientVatId] : []),
  ];

  const reference = input.corrects
    ? `${label('reference.cancels')} ${toPdfText(input.corrects.documentNumber)} ${label('reference.of')} ${formatDate(input.corrects.issueDate)}`
    : input.replaces
      ? `${label('reference.replaces')} ${toPdfText(input.replaces.documentNumber)} ${label('reference.of')} ${formatDate(input.replaces.issueDate)}`
      : null;

  const notes: string[] = [];
  if (present(doc.taxNote)) notes.push(toPdfText(doc.taxNote));

  const payment: string[] = [];
  if (doc.docType === 'invoice') {
    if (doc.dueDate) {
      payment.push(`${label('payment.dueBy')} ${formatDate(doc.dueDate)}.`);
    } else {
      payment.push(`${label('payment.termsPrefix')} ${doc.paymentTermsDays} ${label('payment.termsSuffix')}`);
    }
    if (present(doc.paymentReference)) payment.push(`${label('payment.reference')} ${toPdfText(doc.paymentReference)}`);
    if (sender && present(sender.iban)) {
      payment.push(
        [present(sender.bankName) ? sender.bankName : null, `IBAN ${sender.iban}`, present(sender.bic) ? `BIC ${sender.bic}` : null]
          .filter(present)
          .map(toPdfText)
          .join(' · '),
      );
    }
  }

  const amountHeader = doc.netOrGross === 'gross' && !doc.kleinunternehmer ? label('table.amountGross') : label('table.amount');

  return {
    draft,
    title: draft ? `${title}${label('title.draftSuffix')}` : title,
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
    pdfTitle: toPdfText(`${title} ${doc.documentNumber ?? label('title.draftNumber')}`),
    // Fixed per document, so a re-render writes the same metadata bytes.
    pdfDate: doc.issuedAt ?? new Date(Date.UTC(2000, 0, 1)),
    docType: doc.docType,
    shortTitle: toPdfText(doc.documentNumber ? `${title} ${doc.documentNumber}` : `${title}${label('title.draftSuffix')}`),
    metaItems: Object.fromEntries(
      Object.entries(metaItems).map(([k, v]) => [k, v ? { label: v.label, value: toPdfText(v.value) } : null]),
    ) as RenderModel['metaItems'],
    senderColumns: sender
      ? senderColumnsOf(sender)
      : { identity: [], contact: [], legal: [], bank: [] },
    paymentQr: paymentQrData(doc, sender, draft),
    paymentQrPending: draft && qrEligible(doc, sender),
  };
}
