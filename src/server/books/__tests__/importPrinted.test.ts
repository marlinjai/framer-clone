// src/server/books/__tests__/importPrinted.test.ts
//
// The shared mapping from a printed invoice to the historical-import record
// (importPrinted.ts), for what the upload import adds beyond the operator
// import (whose cases are in importCli.test.ts): numbers printed as text,
// regular taxation with printed rates and taxes (per line, or per rate in the
// printed summary), gross-priced lines, reverse charge, the sender's printed
// tax ids, and fields the model could not read. Plus the counter value of a
// printed number in the company's format. Synthetic data only.

import { describe, expect, it } from 'vitest';

import { importTaxFields, numberValueFor, recordNumberValue, recordWarnings } from '../importInvoices';
import { mapPrintedInvoice } from '../importPrinted';

const NOW = new Date('2026-10-20T10:00:00Z');

function printed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 'RE-2021-0012',
    issueDate: '2021-03-04',
    serviceDate: null,
    servicePeriod: null,
    recipient: { name: 'Example Client GmbH', addressLines: ['Beispielweg 2', '20095 Hamburg'], country: null, countryInferred: 'DE', customerNumber: null },
    recipientVatId: null,
    sender: { name: 'Sample Studio', addressLines: ['Musterstrasse 1', '10115 Berlin'], country: null, taxNumber: '12/345/67890', vatId: 'DE123456789' },
    lines: [
      { description: 'Design work', quantity: 10, unit: 'h', unitPrice: 100, discount: null, lineTotal: 1000, taxRate: 19, taxAmount: 190 },
      { description: 'Printing', quantity: 1, unit: 'Stk', unitPrice: 200, discount: null, lineTotal: 200, taxRate: 7, taxAmount: 14 },
    ],
    total: 1404,
    currency: 'EUR',
    taxTreatment: 'regular',
    taxAmounts: [],
    pricesIncludeVat: false,
    taxNote: null,
    paymentTerms: null,
    ...overrides,
  };
}

function ok(input: Record<string, unknown>) {
  const m = mapPrintedInvoice(input, { origin: 'upload_extracted', now: NOW });
  if (!m.ok) throw new Error(`${m.issue.kind}: ${m.issue.reason}`);
  return m.record;
}

function issue(input: Record<string, unknown>) {
  const m = mapPrintedInvoice(input, { origin: 'upload_extracted', now: NOW });
  if (m.ok) throw new Error('expected an issue');
  return m.issue;
}

describe('regular taxation', () => {
  it('keeps the printed rates and taxes per line, and sums net plus VAT to the total', () => {
    const r = ok(printed());
    expect(r.documentNumber).toBe('RE-2021-0012');
    expect(r.taxTreatment).toBe('regular');
    expect(r.lines.map((l) => [l.subtotal, l.taxRate, l.taxAmount])).toEqual([
      [100000, 1900, 19000],
      [20000, 700, 1400],
    ]);
    expect(r.sender).toMatchObject({ taxNumber: '12/345/67890', vatId: 'DE123456789' });
    const tax = importTaxFields(r);
    expect(tax).toMatchObject({ kleinunternehmer: false, reverseCharge: false, subtotal: 120000, taxAmount: 20400 });
    expect(tax.taxSummary).toEqual([
      { taxRate: 1900, taxTreatment: 'standard', net: 100000, tax: 19000 },
      { taxRate: 700, taxTreatment: 'reduced', net: 20000, tax: 1400 },
    ]);
    expect(recordWarnings(r)).toEqual([]);
  });

  it('derives the line VAT from the only printed rate and adjusts it to the printed summary', () => {
    const r = ok(
      printed({
        lines: [
          { description: 'A', quantity: 1, unit: null, unitPrice: 33.33, discount: null, lineTotal: 33.33, taxRate: null, taxAmount: null },
          { description: 'B', quantity: 1, unit: null, unitPrice: 33.33, discount: null, lineTotal: 33.33, taxRate: null, taxAmount: null },
          { description: 'C', quantity: 1, unit: null, unitPrice: 33.34, discount: null, lineTotal: 33.34, taxRate: null, taxAmount: null },
        ],
        taxAmounts: [{ rate: 19, net: 100, tax: 19 }],
        total: 119,
      }),
    );
    expect(r.lines.map((l) => l.taxRate)).toEqual([1900, 1900, 1900]);
    expect(r.lines.reduce((a, l) => a + l.taxAmount, 0)).toBe(1900);
    expect(recordWarnings(r)).toContainEqual({ code: 'line_tax_derived', count: 3 });
  });

  it('names what it cannot take: no rate with two printed rates, a foreign rate, gross prices, totals that do not add up', () => {
    const noRate = { description: 'A', quantity: 1, unit: null, unitPrice: 100, discount: null, lineTotal: 100, taxRate: null, taxAmount: null };
    expect(issue(printed({ lines: [noRate], taxAmounts: [{ rate: 19, net: null, tax: 10 }, { rate: 7, net: null, tax: 2 }], total: 112 })).reason).toBe('line_tax_rate_missing');
    expect(issue(printed({ lines: [{ ...noRate, taxRate: 20, taxAmount: 20 }], total: 120 })).reason).toBe('line_tax_rate_unsupported');
    expect(issue(printed({ pricesIncludeVat: true }))).toEqual({ kind: 'error', reason: 'gross_priced_lines' });
    expect(issue(printed({ total: 1400 })).reason).toBe('lines_do_not_sum_to_total');
  });

  it('a printed VAT that is not the rate times the net is kept and warned', () => {
    const r = ok(printed({ lines: [{ description: 'A', quantity: 1, unit: null, unitPrice: 100, discount: null, lineTotal: 100, taxRate: 19, taxAmount: 20 }], total: 120 }));
    expect(recordWarnings(r)).toContainEqual({ code: 'line_tax_not_rate_times_net', count: 1 });
  });

  it('a discount line with VAT is a line of its own with a negative tax', () => {
    const r = ok(
      printed({
        lines: [
          { description: 'Design work', quantity: 1, unit: null, unitPrice: 1000, discount: null, lineTotal: 1000, taxRate: 19, taxAmount: 190 },
          { description: 'Rabatt 10 %', quantity: null, unit: null, unitPrice: null, discount: '10 %', lineTotal: -100, taxRate: 19, taxAmount: -19 },
        ],
        total: 1071,
      }),
    );
    expect(r.lines[1]).toMatchObject({ subtotal: -10000, taxAmount: -1900, taxRate: 1900 });
  });
});

describe('the other treatments', () => {
  it('reverse charge needs the recipient VAT id and a business; tax stays 0', () => {
    const lines = [{ description: 'Consulting', quantity: 1, unit: null, unitPrice: 1000, discount: null, lineTotal: 1000, taxRate: null, taxAmount: null }];
    const rc = { taxTreatment: 'reverse_charge', lines, total: 1000, taxNote: 'Steuerschuldnerschaft des Leistungsempfängers' };
    // Only for a business in another EU country: a German or a non-EU recipient is not that case.
    expect(issue(printed(rc)).reason).toBe('reverse_charge_outside_eu');
    const swiss = { name: 'Beispiel AG', addressLines: ['Musterweg 1', '8000 Zürich'], country: 'CH', countryInferred: null, customerNumber: null };
    expect(issue(printed({ ...rc, currency: 'CHF', recipient: swiss })).reason).toBe('reverse_charge_outside_eu');
    const french = { name: 'Exemple SARL', addressLines: ['1 Rue Exemple', '75001 Paris'], country: 'FR', countryInferred: null, customerNumber: null };
    expect(issue(printed({ ...rc, recipient: french })).reason).toBe('invalid_record:recipient.vatId');
    const r = ok(printed({ ...rc, recipientVatId: 'USt-IdNr.: FR12345678901', recipient: { name: 'Exemple SARL', addressLines: ['1 Rue Exemple', '75001 Paris'], country: 'FR', countryInferred: null, customerNumber: null } }));
    expect(importTaxFields(r)).toMatchObject({ reverseCharge: true, kleinunternehmer: false, taxAmount: 0 });
    expect(importTaxFields(r).taxSummary).toEqual([{ taxRate: 0, taxTreatment: 'reverse_charge', net: 100000, tax: 0 }]);
  });

  it('VAT on a section 19 invoice is a contradiction, and a missing notice is warned, not blocking', () => {
    const lines = [{ description: 'A', quantity: 1, unit: null, unitPrice: 100, discount: null, lineTotal: 100, taxRate: 19, taxAmount: 19 }];
    expect(issue(printed({ taxTreatment: 'small_business', lines, total: 119 })).reason).toBe('tax_on_untaxed_invoice');
    const r = ok(printed({ taxTreatment: 'small_business', lines: [{ ...lines[0], taxRate: null, taxAmount: null }], total: 100, taxNote: null }));
    expect(recordWarnings(r)).toContainEqual({ code: 'tax_note_missing' });
    expect(issue(printed({ taxTreatment: 'other' })).reason).toBe('tax_treatment_unsupported');
  });
});

describe('fields the model could not read', () => {
  it('missing number, date, total or currency are named, never guessed', () => {
    expect(issue(printed({ number: null }))).toEqual({ kind: 'skipped', reason: 'number_missing' });
    expect(issue(printed({ issueDate: null })).reason).toBe('issue_date_invalid');
    expect(issue(printed({ total: null })).reason).toBe('total_invalid');
    expect(issue(printed({ currency: null })).reason).toBe('currency_invalid');
  });
});

describe('numberValueFor', () => {
  it('reads the counter value of a number in the company format, and nothing else', () => {
    expect(numberValueFor('62', '{n}')).toBe(62);
    expect(numberValueFor('0062', '{n}')).toBe(62);
    expect(numberValueFor('RE-0012', 'RE-{n:4}')).toBe(12);
    expect(numberValueFor('RE-12', 'RE-{n:4}')).toBeNull();
    expect(numberValueFor('RE-2021-0012', '{n}')).toBeNull();
    expect(numberValueFor('2021/7', '2021/{n}')).toBe(7);
    expect(numberValueFor('0', '{n}')).toBeNull();
  });
});

describe('recordNumberValue', () => {
  it("the operator's integer numbers keep their value under any format; an upload goes by the format only", () => {
    expect(recordNumberValue({ documentNumber: '17', origin: 'operator_file' }, 'RE-{n:4}')).toBe(17);
    expect(recordNumberValue({ documentNumber: '17', origin: 'upload_extracted' }, 'RE-{n:4}')).toBeNull();
    expect(recordNumberValue({ documentNumber: 'RE-0017', origin: 'upload_extracted' }, 'RE-{n:4}')).toBe(17);
    expect(recordNumberValue({ documentNumber: 'X-17', origin: 'operator_file' }, '{n}')).toBeNull();
  });
});

describe('printed but not readable', () => {
  it('payment terms, a recipient VAT id and a service period that cannot be read are warned; terms not printed are not', () => {
    const r = ok(printed({ paymentTerms: 'nach Absprache', recipientVatId: 'USt-IdNr. folgt', servicePeriod: 'laut Vertrag' }));
    expect(recordWarnings(r)).toEqual(
      expect.arrayContaining([{ code: 'payment_terms_unparsed' }, { code: 'recipient_vat_id_unparsed' }, { code: 'service_date_unparsed' }]),
    );
    const none = ok(printed());
    expect(none.provenance.paymentTermsUnparsed).toBe(false);
    expect(recordWarnings(none).map((w) => w.code)).not.toContain('payment_terms_unparsed');
  });

  it('records the sender tax number and VAT id as printed only when the reading says so', () => {
    const r = ok(printed({ sender: { name: 'Sample Studio', addressLines: [], country: null, taxNumber: '12/345/67890', vatId: null, taxNumberPresent: false, vatIdPresent: false } }));
    expect(r.provenance).toMatchObject({ senderTaxNumberPrinted: false, senderVatIdPrinted: false });
    expect(r.sender.taxNumber).toBe('12/345/67890');
  });
});
