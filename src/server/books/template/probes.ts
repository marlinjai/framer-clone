// src/server/books/template/probes.ts
//
// The probe documents of the save gate (visual template composer plan,
// decision 8): a template is rendered against each of them and the
// completeness check (render/completeness.ts, unchanged) runs on the result;
// any missing field refuses the save with the probe and the field named. The
// composer's sample preview draws them too.
//
// Code fixtures with invented data only (fictional companies, a public test
// IBAN): no customer data is ever used to prove a template. A production
// module, not a test fixture, because the gate runs on every save.

import type { RenderInput, RenderRecipient } from '../render/model';
import type { CompletenessContext } from '../render/completeness';
import type { SalesDocumentLine, SalesDocumentWithSnapshots } from '../repository/read';
import type { CustomerSnapshotV1, SenderSnapshotV1 } from '../snapshots';

export const PROBE_NAMES = [
  'smallBusiness',
  'regular',
  'reverseCharge',
  'creditNote',
  'longInvoice',
  'longRecipient',
  'longDescription',
] as const;
export type ProbeName = (typeof PROBE_NAMES)[number];

export interface Probe {
  name: ProbeName;
  document: SalesDocumentWithSnapshots;
  lines: SalesDocumentLine[];
  context: CompletenessContext;
}

const TENANT = '0190a000-0000-7000-8000-00000000beef';
const ISSUED_AT = new Date('2026-10-19T09:30:00Z');

/** A fictional sender with every field the footer can print (a public test IBAN). */
const SENDER: SenderSnapshotV1 = {
  v: 1,
  legalName: 'Musterwerk Beispiel GmbH',
  addressLine1: 'Probestraße 12',
  addressLine2: 'Hinterhaus',
  postalCode: '10115',
  city: 'Berlin',
  countryCode: 'DE',
  taxNumber: '11/222/33333',
  vatId: 'DE999999999',
  smallBusinessId: null,
  email: 'rechnung@musterwerk.invalid',
  phone: '+49 30 0000000',
  website: 'musterwerk.invalid',
  bankName: 'Beispielbank',
  iban: 'DE02 1203 0000 0000 2020 51',
  bic: 'BYLADEM1001',
  registerCourt: 'Amtsgericht Beispielstadt',
  registerNumber: 'HRB 00000',
  managingDirector: 'Erika Beispiel',
};

const CUSTOMER: CustomerSnapshotV1 = {
  v: 1,
  contactId: '0190a000-0000-7000-8000-0000000000c9',
  kind: 'organization',
  name: 'Probekunde',
  companyOrRole: '',
  legalForm: 'GmbH',
  addressLine1: 'Kundenweg 7',
  addressLine2: null,
  postalCode: '20095',
  city: 'Hamburg',
  country: 'DE',
  customerNumber: 1042,
  customerType: 'b2b',
  vatId: null,
  taxNumber: null,
};

function line(position: number, overrides: Partial<SalesDocumentLine> = {}): SalesDocumentLine {
  return {
    id: `probe-line-${position}`,
    documentId: 'probe-doc',
    position,
    kind: 'service',
    title: 'Beratung',
    description: null,
    quantity: 1500,
    unitLabel: 'Std',
    unitPrice: 9000,
    discountBp: 0,
    subtotal: 13500,
    taxClass: 'standard',
    taxRateOverride: null,
    taxRate: 1900,
    taxAmount: 2565,
    taxTreatment: 'standard',
    variantRef: null,
    variantRefSource: 'none',
    createdAt: ISSUED_AT,
    updatedAt: ISSUED_AT,
    ...overrides,
  };
}

/** Sum the lines into the document's totals and tax summary (integer cents, the house rounding is irrelevant for probes). */
function withTotals(document: SalesDocumentWithSnapshots, lines: SalesDocumentLine[]): SalesDocumentWithSnapshots {
  const billable = lines.filter((l) => l.kind !== 'text');
  const groups = new Map<string, { taxRate: number; taxTreatment: NonNullable<SalesDocumentLine['taxTreatment']>; net: number; tax: number }>();
  for (const l of billable) {
    const key = `${l.taxRate}|${l.taxTreatment}`;
    const g = groups.get(key) ?? { taxRate: l.taxRate, taxTreatment: l.taxTreatment ?? 'standard', net: 0, tax: 0 };
    g.net += l.subtotal;
    g.tax += l.taxAmount;
    groups.set(key, g);
  }
  const subtotal = billable.reduce((s, l) => s + l.subtotal, 0);
  const taxAmount = billable.reduce((s, l) => s + l.taxAmount, 0);
  return { ...document, subtotal, taxAmount, total: subtotal + taxAmount, taxSummary: [...groups.values()] };
}

function baseDocument(overrides: Partial<SalesDocumentWithSnapshots> = {}): SalesDocumentWithSnapshots {
  return {
    id: 'probe-doc',
    tenantId: TENANT,
    docType: 'invoice',
    status: 'issued',
    source: 'editor',
    version: 3,
    customerId: 'probe-customer',
    templateId: null,
    correctsDocumentId: null,
    replacesDocumentId: null,
    printReplacesReference: false,
    sourceOrderId: null,
    documentNumber: '2026-0042',
    numberValue: 42,
    issueDate: '2026-10-19',
    serviceDate: '2026-10-15',
    servicePeriodStart: null,
    servicePeriodEnd: null,
    dueDate: '2026-11-02',
    validUntil: null,
    paymentTermsDays: 14,
    paymentReference: 'Rechnung 2026-0042',
    contractReference: 'Rahmenvertrag 7',
    currencyCode: 'EUR',
    taxRegion: 'DE',
    customerType: 'b2b',
    vatId: null,
    reverseCharge: false,
    netOrGross: 'net',
    kleinunternehmer: false,
    taxNote: null,
    taxProfileKey: 'regular|b2b||DE',
    subtotal: 0,
    taxAmount: 0,
    total: 0,
    taxSummary: [],
    introText: 'Vielen Dank für Ihren Auftrag. Wir berechnen Ihnen die folgenden Leistungen.',
    outroText: 'Mit freundlichen Grüßen',
    renderedPdfFileId: null,
    issuedAt: ISSUED_AT,
    createdAt: ISSUED_AT,
    updatedAt: ISSUED_AT,
    customerSnapshot: { ...CUSTOMER },
    senderSnapshot: { ...SENDER },
    templateSnapshot: null,
    ...overrides,
  };
}

function regular(): Probe {
  const lines = [
    line(1, { title: 'Konzeption', description: 'Workshop und Abstimmung vor Ort', discountBp: 1000, subtotal: 12150, taxAmount: 2309 }),
    line(2, { kind: 'text', title: 'Phase zwei', quantity: 0, unitPrice: 0, subtotal: 0, taxClass: null, taxRate: 0, taxAmount: 0, taxTreatment: null }),
    line(3, { kind: 'product', title: 'Fachbuch', quantity: 2000, unitLabel: 'Stk', unitPrice: 2490, subtotal: 4980, taxClass: 'reduced', taxRate: 700, taxAmount: 349, taxTreatment: 'reduced' }),
  ];
  return {
    name: 'regular',
    lines,
    document: withTotals(baseDocument({ serviceDate: null, servicePeriodStart: '2026-10-01', servicePeriodEnd: '2026-10-15' }), lines),
    context: {},
  };
}

function smallBusiness(): Probe {
  const lines = [line(1, { taxRate: 0, taxAmount: 0, taxTreatment: 'kleinunternehmer' }), line(2, { title: 'Reisekosten', quantity: 1000, unitLabel: 'pauschal', unitPrice: 4500, subtotal: 4500, taxRate: 0, taxAmount: 0, taxTreatment: 'kleinunternehmer' })];
  return {
    name: 'smallBusiness',
    lines,
    document: withTotals(
      baseDocument({
        kleinunternehmer: true,
        taxProfileKey: 'small_business|b2b||DE',
        taxNote: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).',
        senderSnapshot: { ...SENDER, vatId: null, smallBusinessId: 'DE999999999-00001' },
      }),
      lines,
    ),
    context: {},
  };
}

function reverseCharge(): Probe {
  const lines = [line(1, { taxRate: 0, taxAmount: 0, taxTreatment: 'reverse_charge' }), line(2, { title: 'Lizenz', kind: 'product', quantity: 1000, unitLabel: 'Stk', unitPrice: 50000, subtotal: 50000, taxRate: 0, taxAmount: 0, taxTreatment: 'reverse_charge' })];
  return {
    name: 'reverseCharge',
    lines,
    document: withTotals(
      baseDocument({
        reverseCharge: true,
        vatId: 'FR00999999999',
        taxRegion: 'EU',
        taxProfileKey: 'regular|b2b|reverse_charge|EU',
        taxNote: 'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge)',
        customerSnapshot: {
          ...CUSTOMER,
          name: 'Société Exemple',
          legalForm: 'SARL',
          addressLine1: '1 Rue de l’Exemple',
          postalCode: '75001',
          city: 'Paris',
          country: 'FR',
          vatId: 'FR00999999999',
        },
      }),
      lines,
    ),
    context: {},
  };
}

function creditNote(): Probe {
  const lines = [line(1)];
  return {
    name: 'creditNote',
    lines,
    document: withTotals(
      baseDocument({
        docType: 'credit_note',
        documentNumber: 'G-2026-0005',
        numberValue: 5,
        correctsDocumentId: 'probe-invoice',
        dueDate: null,
        paymentReference: null,
      }),
      lines,
    ),
    context: { corrects: { documentNumber: '2026-0041', issueDate: '2026-10-12' } },
  };
}

function longInvoice(): Probe {
  const lines = Array.from({ length: 40 }, (_, i) =>
    line(i + 1, {
      title: `Leistungsposition ${i + 1}`,
      description: i % 5 === 0 ? 'Mit einer kurzen Beschreibung der erbrachten Leistung.' : null,
      quantity: 1000 + i * 250,
      subtotal: Math.round(((1000 + i * 250) * 9000) / 1000),
      taxAmount: Math.round((((1000 + i * 250) * 9000) / 1000) * 0.19),
    }),
  );
  return { name: 'longInvoice', lines, document: withTotals(baseDocument(), lines), context: {} };
}

function longRecipient(): Probe {
  const lines = [line(1)];
  return {
    name: 'longRecipient',
    lines,
    document: withTotals(
      baseDocument({
        customerSnapshot: {
          ...CUSTOMER,
          name: 'Internationale Gesellschaft für angewandte Beispielforschung und Musterentwicklung',
          companyOrRole: 'Abteilung Einkauf und Rechnungsprüfung, zu Händen der Geschäftsleitung',
          legalForm: 'AG',
          addressLine1: 'Avenue des Exemples Imaginaires 1234, Bâtiment C, Étage 7',
          addressLine2: 'Case postale 98765',
          postalCode: '1204',
          city: 'Genève',
          country: 'CH',
        },
      }),
      lines,
    ),
    context: {},
  };
}

function longDescription(): Probe {
  const sentence = 'Ausführliche Beschreibung der Leistung mit allen vereinbarten Einzelheiten und Ergebnissen. ';
  const description = sentence.repeat(Math.ceil(4000 / sentence.length)).slice(0, 4000).trim();
  const lines = [line(1, { description }), line(2, { title: 'Nachbereitung' })];
  return { name: 'longDescription', lines, document: withTotals(baseDocument(), lines), context: {} };
}

const BUILDERS: Record<ProbeName, () => Probe> = {
  smallBusiness,
  regular,
  reverseCharge,
  creditNote,
  longInvoice,
  longRecipient,
  longDescription,
};

/** A fresh probe by name. */
export function probe(name: ProbeName): Probe {
  return BUILDERS[name]();
}

/** Every probe, fresh. */
export function allProbes(): Probe[] {
  return PROBE_NAMES.map((n) => probe(n));
}

/** The render input of a probe (issued, frozen data). */
export function probeInput(p: Probe, draft = false): RenderInput {
  const c = p.document.customerSnapshot!;
  const recipient: RenderRecipient = {
    name: c.name,
    companyOrRole: c.companyOrRole,
    legalForm: c.legalForm,
    addressLine1: c.addressLine1,
    addressLine2: c.addressLine2,
    postalCode: c.postalCode,
    city: c.city,
    country: c.country,
    customerNumber: c.customerNumber,
    vatId: c.vatId,
  };
  return {
    draft,
    document: p.document,
    lines: p.lines,
    sender: p.document.senderSnapshot,
    recipient,
    corrects: p.context.corrects ?? null,
    template: null,
  };
}
