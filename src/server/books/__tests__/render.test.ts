// src/server/books/__tests__/render.test.ts
//
// Books phase 3, the pure half of the render pipeline (no database):
//   - German formatting of the integer units;
//   - the legal completeness check AS CODE against the REAL renderer's output:
//     every section 34a UStDV field (Section 19) and every section 14 (4) UStG
//     field (regular taxation, reverse charge) is found in the drawn PDF text,
//     and removing one from the output is reported by name (so a layout change
//     that drops a field fails here);
//   - determinism: the same frozen data renders to the same bytes.
// All data is synthetic.

import { describe, expect, it } from 'vitest';

import { expectedFields, missingFields } from '../render/completeness';
import { extractPdfText } from '../render/extractText';
import { formatDate, formatMoney, formatQuantity, formatRate, toPdfText } from '../render/format';
import { buildRenderModel } from '../render/model';
import { renderPdf } from '../render/pdf';
import {
  issuedInput,
  regularInvoice,
  reverseChargeInvoice,
  smallBusinessInvoice,
} from './renderFixtures';

describe('format', () => {
  it('formats money, quantities, rates and dates the German way', () => {
    expect(formatMoney(123456)).toBe('1.234,56 €');
    expect(formatMoney(5)).toBe('0,05 €');
    expect(formatMoney(-14500)).toBe('-145,00 €');
    expect(formatQuantity(1500)).toBe('1,5');
    expect(formatQuantity(2000)).toBe('2');
    expect(formatQuantity(1250)).toBe('1,25');
    expect(formatRate(1900)).toBe('19 %');
    expect(formatRate(550)).toBe('5,5 %');
    expect(formatDate('2026-12-31')).toBe('31.12.2026');
  });

  it('keeps German text and transliterates what the PDF fonts cannot draw', () => {
    expect(toPdfText('Grüße „Straße“ €')).toBe('Grüße „Straße“ €');
    expect(toPdfText('Łódź Dvořák')).toBe('Lódz Dvorák');
    expect(toPdfText('a\nb\t c')).toBe('a b c');
    expect(toPdfText('\u{1F600} ok')).toBe('? ok');
  });
});

async function renderedText(f: ReturnType<typeof smallBusinessInvoice>): Promise<string> {
  return extractPdfText(await renderPdf(buildRenderModel(issuedInput(f))));
}

describe('completeness check against the rendered PDF', () => {
  it('section 34a UStDV: a small-business invoice carries every required field', async () => {
    const f = smallBusinessInvoice();
    const text = await renderedText(f);
    expect(missingFields(f.document, f.lines, text)).toEqual([]);
    // The fields the check looks for, spelled out (proof the check is not empty).
    const fields = expectedFields(f.document, f.lines).map((e) => e.field);
    expect(fields).toEqual(
      expect.arrayContaining([
        'sender.legalName',
        'sender.addressLine1',
        'sender.postalCity',
        'sender.taxNumber',
        'recipient.name',
        'recipient.addressLine1',
        'recipient.postalCity',
        'issueDate',
        'line1.title',
        'line1.quantity',
        'line3.title',
        'line3.quantity',
        'total',
        'exemptionNote',
      ]),
    );
    expect(text).toContain('Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).');
    expect(text).not.toContain('Umsatzsteuer 0 %');
  });

  it('section 14 (4) UStG: a regular invoice carries number, service period and per-rate tax', async () => {
    const f = regularInvoice();
    const text = await renderedText(f);
    expect(missingFields(f.document, f.lines, text)).toEqual([]);
    expect(text).toContain('Leistungszeitraum 01.10.2026 bis 15.10.2026');
    expect(text).toContain('Nettobetrag zu 19 % 120,00 €');
    expect(text).toContain('Umsatzsteuer 7 % 1,75 €');
    expect(text).toContain('Gesamtbetrag 169,55 €');
  });

  it('reverse charge: the recipient VAT id and the reverse-charge note are printed', async () => {
    const f = reverseChargeInvoice();
    const text = await renderedText(f);
    expect(missingFields(f.document, f.lines, text)).toEqual([]);
    expect(text).toContain('USt-IdNr. Leistungsempfänger FR12345678901');
    expect(text).toContain('FRANKREICH');
  });

  it('reports each missing field by name when the output lacks it', async () => {
    const f = smallBusinessInvoice();
    const text = await renderedText(f);
    const drop = (needle: string) => text.split(needle).join('');
    expect(missingFields(f.document, f.lines, drop('Steuernummer: 12/345/67890'))).toEqual(['sender.taxNumber']);
    expect(missingFields(f.document, f.lines, drop('Rechnungsdatum 19.10.2026'))).toEqual(['issueDate']);
    expect(missingFields(f.document, f.lines, drop('Beispielweg 2'))).toEqual(['recipient.addressLine1']);
    expect(missingFields(f.document, f.lines, drop('(Kleinunternehmerregelung)'))).toEqual(['exemptionNote']);
    expect(missingFields(f.document, f.lines, drop('1,5 Std'))).toEqual(['line1.quantity']);
  });

  it('an issuer without any tax id is incomplete even before rendering', () => {
    const f = smallBusinessInvoice();
    f.document.senderSnapshot = { ...f.document.senderSnapshot!, taxNumber: null, vatId: null };
    expect(missingFields(f.document, f.lines, 'anything')).toContain('sender.taxId');
  });

  it('a credit note prints its amounts as an offset and names the cancelled invoice', async () => {
    const f = smallBusinessInvoice();
    f.document = { ...f.document, docType: 'credit_note', documentNumber: 'GS-1', correctsDocumentId: 'doc-0', dueDate: null, paymentReference: null };
    const input = { ...issuedInput(f), corrects: { documentNumber: '62', issueDate: '2026-10-19' } };
    const text = extractPdfText(await renderPdf(buildRenderModel(input)));
    expect(missingFields(f.document, f.lines, text)).toEqual([]);
    expect(text).toContain('Storno der Rechnung 62 vom 19.10.2026');
    expect(text).toContain('Gesamtbetrag -145,00 €');
  });
});

describe('determinism', () => {
  it('the same frozen data renders to the same bytes', async () => {
    const a = await renderPdf(buildRenderModel(issuedInput(smallBusinessInvoice())));
    const b = await renderPdf(buildRenderModel(issuedInput(smallBusinessInvoice())));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('a long document breaks onto further pages and repeats the footer', async () => {
    const f = smallBusinessInvoice();
    const many = Array.from({ length: 60 }, (_, i) => ({ ...f.lines[0], id: `l${i}`, position: i + 1, title: `Service ${i + 1}` }));
    const doc = { ...f.document, subtotal: 12000 * 60, total: 12000 * 60, taxSummary: [{ taxRate: 0, taxTreatment: 'kleinunternehmer' as const, net: 12000 * 60, tax: 0 }] };
    const text = extractPdfText(await renderPdf(buildRenderModel(issuedInput({ document: doc, lines: many }))));
    expect(text).toContain('Seite 1 von 3');
    expect(missingFields(doc, many, text)).toEqual([]);
  });
});
