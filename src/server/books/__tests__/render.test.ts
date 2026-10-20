// src/server/books/__tests__/render.test.ts
//
// Books phase 3, the pure half of the render pipeline (no database):
//   - German formatting of the integer units; text printed exactly as written;
//   - the embedded Unicode fonts: Polish, Cyrillic and an emoji the font has
//     render and read back as written; a character the fonts lack (CJK) is
//     refused for a document of record, with the field named;
//   - the legal completeness check AS CODE against the REAL renderer's output:
//     every section 34a UStDV field (Section 19) and every section 14 (4) UStG
//     field (regular taxation, reverse charge with the recipient's VAT id, the
//     credit note's reference to the cancelled invoice) is found in the drawn
//     text, and removing one is reported by name;
//   - layout: a 300-character unbroken title still passes the check; a
//     4000-character description flows over pages and never reaches the footer;
//   - determinism: the same frozen data renders to the same bytes.
// All data is synthetic.

import { describe, expect, it } from 'vitest';

import { isBooksError } from '../errors';
import { expectedFields, missingFields } from '../render/completeness';
import { assertDrawable, undrawableFields } from '../render/drawable';
import { extractDrawnText, extractPdfText } from '../render/extractText';
import { formatDate, formatMoney, formatQuantity, formatRate, toPdfText } from '../render/format';
import { buildRenderModel, type RenderInput } from '../render/model';
import { CONTENT_BOTTOM, renderPdf } from '../render/pdf';
import {
  issuedInput,
  regularInvoice,
  reverseChargeInvoice,
  smallBusinessInvoice,
} from './renderFixtures';

type Fixture = ReturnType<typeof smallBusinessInvoice>;

async function render(input: RenderInput): Promise<Uint8Array> {
  return renderPdf(buildRenderModel(input));
}

async function renderedText(f: Fixture): Promise<string> {
  return extractPdfText(await render(issuedInput(f)));
}

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

  it('normalizes whitespace only and never transliterates', () => {
    expect(toPdfText('Grüße „Straße“ €')).toBe('Grüße „Straße“ €');
    expect(toPdfText('Łódź Dvořák Дмитрий')).toBe('Łódź Dvořák Дмитрий');
    expect(toPdfText('a\nb\t c')).toBe('a b c');
  });
});

describe('embedded Unicode fonts', () => {
  it('prints Polish, Cyrillic and an emoji exactly as written', async () => {
    const f = smallBusinessInvoice();
    f.document.customerSnapshot = { ...f.document.customerSnapshot!, name: 'Łukasz Żółć 😀', addressLine1: 'ул. Пушкина 10' };
    f.lines[0] = { ...f.lines[0], title: 'Dvořák-Workshop für Ελληνικά' };
    expect(undrawableFields(issuedInput(f))).toEqual([]);
    const text = await renderedText(f);
    expect(text).toContain('Łukasz Żółć 😀');
    expect(text).toContain('ул. Пушкина 10');
    expect(text).toContain('Dvořák-Workshop für Ελληνικά');
    expect(missingFields(f.document, f.lines, text)).toEqual([]);
  });

  it('refuses a document of record with characters the fonts lack, naming the fields', () => {
    const f = smallBusinessInvoice();
    f.document.customerSnapshot = { ...f.document.customerSnapshot!, name: '中文公司' };
    f.lines[2] = { ...f.lines[2], description: '說明' };
    expect(undrawableFields(issuedInput(f))).toEqual(['recipient.name', 'line3.description']);
    try {
      assertDrawable(issuedInput(f));
      throw new Error('expected a refusal');
    } catch (err) {
      expect(isBooksError(err, 'UNDRAWABLE_TEXT')).toBe(true);
      expect((err as { details: { fields: string[] } }).details.fields).toEqual(['recipient.name', 'line3.description']);
    }
  });
});

describe('completeness check against the rendered PDF', () => {
  it('section 34a UStDV: a small-business invoice carries every required field', async () => {
    const f = smallBusinessInvoice();
    const text = await renderedText(f);
    expect(missingFields(f.document, f.lines, text)).toEqual([]);
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

  it('reverse charge: the recipient VAT id itself is required and printed', async () => {
    const f = reverseChargeInvoice();
    const text = await renderedText(f);
    expect(missingFields(f.document, f.lines, text)).toEqual([]);
    expect(text).toContain('USt-IdNr. Leistungsempfänger FR12345678901');
    expect(text).toContain('FRANKREICH');
    const noVat = reverseChargeInvoice();
    noVat.document.customerSnapshot = { ...noVat.document.customerSnapshot!, vatId: null };
    expect(missingFields(noVat.document, noVat.lines, await renderedText(noVat))).toEqual(['recipient.vatId']);
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

  it('a credit note must name the cancelled invoice by number and date', async () => {
    const f = smallBusinessInvoice();
    f.document = { ...f.document, docType: 'credit_note', documentNumber: 'GS-1', correctsDocumentId: 'doc-0', dueDate: null, paymentReference: null };
    const corrects = { documentNumber: '62', issueDate: '2026-10-19' };
    const text = await extractPdfText(await render({ ...issuedInput(f), corrects }));
    expect(missingFields(f.document, f.lines, text, { corrects })).toEqual([]);
    expect(text).toContain('Storno der Rechnung 62 vom 19.10.2026');
    expect(text).toContain('Gesamtbetrag -145,00 €');
    // Without the reference line (or without knowing the invoice) it is incomplete.
    const withoutRef = await extractPdfText(await render(issuedInput(f)));
    expect(missingFields(f.document, f.lines, withoutRef, { corrects })).toEqual(['correctsReference']);
    expect(missingFields(f.document, f.lines, text)).toEqual(['correctsReference']);
  });
});

describe('layout', () => {
  it('a 300-character unbroken title is broken only as a last resort and still passes the check', async () => {
    const f = smallBusinessInvoice();
    f.lines[0] = { ...f.lines[0], title: 'X'.repeat(300) };
    const drawn = await extractDrawnText(await render(issuedInput(f)));
    const pieces = drawn.filter((d) => /^X+$/.test(d.text));
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.map((p) => p.text).join('')).toBe('X'.repeat(300));
    expect(missingFields(f.document, f.lines, drawn.map((d) => d.text).join(' '))).toEqual([]);
  });

  it('words are never split when they fit on a line', async () => {
    const f = smallBusinessInvoice();
    f.lines[0] = { ...f.lines[0], title: Array.from({ length: 40 }, (_, i) => `Wort${i}`).join(' ') };
    const drawn = await extractDrawnText(await render(issuedInput(f)));
    for (const d of drawn.filter((x) => x.text.includes('Wort'))) {
      for (const word of d.text.split(' ')) expect(word).toMatch(/^Wort\d+$/);
    }
  });

  it('a 4000-character description flows over pages and never reaches the footer', async () => {
    const f = smallBusinessInvoice();
    const description = Array.from({ length: 700 }, (_, i) => `text${i % 10}`).join(' ').slice(0, 4000);
    f.lines[0] = { ...f.lines[0], description };
    const bytes = await render(issuedInput(f));
    const drawn = await extractDrawnText(bytes);
    const pages = Math.max(...drawn.map((d) => d.page));
    expect(pages).toBeGreaterThan(1);
    const model = buildRenderModel(issuedInput(f));
    const footerTexts = new Set([...model.footer.flat(), ...Array.from({ length: pages }, (_, i) => `Seite ${i + 1} von ${pages}`)]);
    for (const d of drawn) {
      // Footer text lives below the content line; everything else stays above it.
      if (d.y < CONTENT_BOTTOM) expect(footerTexts.has(d.text) || [...footerTexts].some((t) => t.includes(d.text))).toBe(true);
    }
    // Every word of the description is drawn, in order, across the pages.
    const descriptionPieces = drawn.filter((d) => /^text\d/.test(d.text)).map((d) => d.text);
    expect(descriptionPieces.join(' ').replace(/\s+/g, '')).toBe(description.replace(/\s+/g, ''));
    expect(new Set(drawn.filter((d) => /^text\d/.test(d.text)).map((d) => d.page)).size).toBeGreaterThan(1);
    expect(missingFields(f.document, f.lines, drawn.map((d) => d.text).join(' '))).toEqual([]);
  });

  it('the largest amount does not run into the VAT column', async () => {
    const f = regularInvoice();
    f.lines[0] = { ...f.lines[0], unitPrice: 2147483647, quantity: 1000, subtotal: 2147483647 };
    const drawn = await extractDrawnText(await render(issuedInput(f)));
    const rowY = drawn.find((d) => d.text === '21.474.836,47 \u20ac' && d.x > 450)!.y;
    const row = drawn.filter((d) => d.y === rowY && d.page === 1);
    const rateCell = row.find((d) => d.text === '19 %')!;
    const amountCell = row.filter((d) => d.text === '21.474.836,47 \u20ac').sort((a, b) => b.x - a.x)[0];
    const priceCell = row.filter((d) => d.text === '21.474.836,47 \u20ac').sort((a, b) => a.x - b.x)[0];
    // Approximate widths at 9.5 pt: "19 %" under 25 pt.
    expect(amountCell.x).toBeGreaterThan(rateCell.x + 25);
    expect(rateCell.x).toBeGreaterThan(priceCell.x);
  });

  it('a long document breaks onto further pages and repeats the footer', async () => {
    const f = smallBusinessInvoice();
    const many = Array.from({ length: 60 }, (_, i) => ({ ...f.lines[0], id: `l${i}`, position: i + 1, title: `Service ${i + 1}` }));
    const doc = { ...f.document, subtotal: 12000 * 60, total: 12000 * 60, taxSummary: [{ taxRate: 0, taxTreatment: 'kleinunternehmer' as const, net: 12000 * 60, tax: 0 }] };
    const text = await extractPdfText(await render(issuedInput({ document: doc, lines: many })));
    expect(text).toContain('Seite 1 von 3');
    expect(missingFields(doc, many, text)).toEqual([]);
  });
});

describe('determinism', () => {
  it('the same frozen data renders to the same bytes', async () => {
    const a = await render(issuedInput(smallBusinessInvoice()));
    const b = await render(issuedInput(smallBusinessInvoice()));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('a frozen template snapshot renders its layout', async () => {
    const f = smallBusinessInvoice();
    f.document.templateSnapshot = { v: 1, templateId: 't1', name: 'Standard', accentColor: '#2b4c7e', footerBlocks: [{ heading: 'Hinweis', text: 'Synthetic small print.' }] };
    const text = await renderedText(f);
    expect(text).toContain('Synthetic small print.');
  });
});
