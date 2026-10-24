// src/server/books/__tests__/renderFixtures.ts
//
// Synthetic issued documents for the pure render tests (no database). Invented
// names, addresses and amounts only.

import type { SalesDocumentLine, SalesDocumentWithSnapshots } from '../repository/read';
import type { CustomerSnapshotV1, SenderSnapshotV1 } from '../snapshots';
import type { RenderInput } from '../render/model';

export const SENDER: SenderSnapshotV1 = {
  v: 1,
  legalName: 'Example Studio',
  addressLine1: 'Musterstraße 1',
  addressLine2: null,
  postalCode: '10115',
  city: 'Berlin',
  countryCode: 'DE',
  taxNumber: '12/345/67890',
  vatId: 'DE123456789',
  smallBusinessId: null,
  email: 'billing@example.invalid',
  phone: null,
  website: null,
  bankName: 'Example Bank',
  iban: 'DE00 0000 0000 0000 0000 00',
  bic: 'EXAMPLEXXX',
  registerCourt: null,
  registerNumber: null,
  managingDirector: null,
};

export const CUSTOMER: CustomerSnapshotV1 = {
  v: 1,
  contactId: '0190a000-0000-7000-8000-0000000000c1',
  kind: 'organization',
  name: 'Sample Customer',
  companyOrRole: '',
  legalForm: 'GmbH',
  addressLine1: 'Beispielweg 2',
  addressLine2: null,
  postalCode: '20095',
  city: 'Hamburg',
  country: 'DE',
  customerNumber: 7,
  customerType: 'b2b',
  vatId: null,
  taxNumber: null,
};

let seq = 0;
export function line(overrides: Partial<SalesDocumentLine> = {}): SalesDocumentLine {
  seq += 1;
  return {
    id: `line-${seq}`,
    documentId: 'doc-1',
    position: seq,
    kind: 'service',
    title: 'Workshop',
    description: null,
    quantity: 1500,
    unitLabel: 'Std',
    unitPrice: 8000,
    discountBp: 0,
    subtotal: 12000,
    taxClass: 'standard',
    taxRateOverride: null,
    taxRate: 0,
    taxAmount: 0,
    taxTreatment: 'kleinunternehmer',
    variantRef: null,
    variantRefSource: 'none',
    createdAt: new Date('2026-10-19T08:00:00Z'),
    updatedAt: new Date('2026-10-19T08:00:00Z'),
    ...overrides,
  };
}

/** An issued small-business invoice with two billable lines and a text line. */
export function smallBusinessInvoice(): { document: SalesDocumentWithSnapshots; lines: SalesDocumentLine[] } {
  seq = 0;
  const lines = [
    line({ title: 'Workshop', quantity: 1500, unitPrice: 8000, subtotal: 12000 }),
    line({ kind: 'text', title: 'Note for the record', quantity: 0, unitPrice: 0, subtotal: 0, taxClass: null, taxTreatment: null, unitLabel: 'Stk' }),
    line({ kind: 'product', title: 'Handout', quantity: 2000, unitLabel: 'Stk', unitPrice: 1250, subtotal: 2500 }),
  ];
  const document: SalesDocumentWithSnapshots = {
    id: 'doc-1',
    tenantId: '0190a000-0000-7000-8000-00000000aaaa',
    docType: 'invoice',
    status: 'issued',
    source: 'editor',
    version: 4,
    subject: null,
    introFormat: null,
    outroFormat: null,
    customerId: 'cust-1',
    templateId: null,
    correctsDocumentId: null,
    replacesDocumentId: null,
    printReplacesReference: false,
    sourceOrderId: null,
    documentNumber: '62',
    numberValue: 62,
    issueDate: '2026-10-19',
    serviceDate: null,
    servicePeriodStart: null,
    servicePeriodEnd: null,
    dueDate: '2026-11-02',
    validUntil: null,
    paymentTermsDays: 14,
    paymentReference: 'Rechnung 62',
    contractReference: null,
    currencyCode: 'EUR',
    taxRegion: 'DE',
    customerType: 'b2b',
    vatId: null,
    reverseCharge: false,
    netOrGross: 'net',
    kleinunternehmer: true,
    taxNote: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).',
    taxProfileKey: 'small_business|b2b||DE',
    subtotal: 14500,
    taxAmount: 0,
    total: 14500,
    taxSummary: [{ taxRate: 0, taxTreatment: 'kleinunternehmer', net: 14500, tax: 0 }],
    introText: 'Vielen Dank für Ihren Auftrag.',
    outroText: null,
    renderedPdfFileId: null,
    issuedAt: new Date('2026-10-19T09:30:00Z'),
    createdAt: new Date('2026-10-19T08:00:00Z'),
    updatedAt: new Date('2026-10-19T09:30:00Z'),
    customerSnapshot: { ...CUSTOMER },
    senderSnapshot: { ...SENDER },
    templateSnapshot: null,
  };
  return { document, lines };
}

/** An issued regular-taxation invoice at 19 and 7 percent with a service period. */
export function regularInvoice(): { document: SalesDocumentWithSnapshots; lines: SalesDocumentLine[] } {
  const base = smallBusinessInvoice();
  const lines = [
    { ...base.lines[0], taxRate: 1900, taxAmount: 2280, taxTreatment: 'standard' as const },
    base.lines[1],
    { ...base.lines[2], taxClass: 'reduced' as const, taxRate: 700, taxAmount: 175, taxTreatment: 'reduced' as const },
  ];
  return {
    lines,
    document: {
      ...base.document,
      kleinunternehmer: false,
      taxNote: null,
      servicePeriodStart: '2026-10-01',
      servicePeriodEnd: '2026-10-15',
      taxProfileKey: 'regular|b2b||DE',
      subtotal: 14500,
      taxAmount: 2455,
      total: 16955,
      taxSummary: [
        { taxRate: 1900, taxTreatment: 'standard', net: 12000, tax: 2280 },
        { taxRate: 700, taxTreatment: 'reduced', net: 2500, tax: 175 },
      ],
    },
  };
}

/** An issued reverse-charge invoice to an EU business (regular taxation). */
export function reverseChargeInvoice(): { document: SalesDocumentWithSnapshots; lines: SalesDocumentLine[] } {
  const base = smallBusinessInvoice();
  const lines = base.lines.map((l) =>
    l.kind === 'text' ? l : { ...l, taxRate: 0, taxAmount: 0, taxTreatment: 'reverse_charge' as const },
  );
  return {
    lines,
    document: {
      ...base.document,
      kleinunternehmer: false,
      reverseCharge: true,
      vatId: 'FR12345678901',
      serviceDate: '2026-10-10',
      taxNote: 'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge)',
      taxSummary: [{ taxRate: 0, taxTreatment: 'reverse_charge', net: 14500, tax: 0 }],
      customerSnapshot: {
        ...CUSTOMER,
        name: 'Société Exemple',
        legalForm: 'SARL',
        addressLine1: '1 Rue Exemple',
        postalCode: '75001',
        city: 'Paris',
        country: 'FR',
        vatId: 'FR12345678901',
      },
    },
  };
}

/** The render input of an issued fixture (frozen data only, no template). */
export function issuedInput(f: { document: SalesDocumentWithSnapshots; lines: SalesDocumentLine[] }): RenderInput {
  const c = f.document.customerSnapshot!;
  return {
    draft: false,
    document: f.document,
    lines: f.lines,
    sender: f.document.senderSnapshot,
    recipient: {
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
    },
    corrects: null,
    template:
      f.document.templateSnapshot?.v === 1
        ? { accentColor: f.document.templateSnapshot.accentColor, footerBlocks: f.document.templateSnapshot.footerBlocks }
        : null,
  };
}
