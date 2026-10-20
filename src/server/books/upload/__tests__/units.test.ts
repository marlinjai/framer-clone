// src/server/books/upload/__tests__/units.test.ts
//
// The small pure parts of the upload import: the per-company slots and the
// daily ceiling from env, the company sender filling what a PDF does not show,
// the review form's conversion, the problem texts, the file name shown.
// Synthetic data only.

import { describe, expect, it } from 'vitest';

import { fromForm, readDecimal } from '@/app/projects/books/ImportRowEditor';
import type { PrintedInvoice } from '@/lib/books/api';
import { pathLabel, problemText } from '@/lib/books/importProblems';

import { createCompanySlots, dailyExtractLimit } from '../limits';
import { cleanFileName } from '../service';
import { valueAt, withCompanySender } from '../validate';

const company = {
  legalName: 'Sample Studio',
  addressLine1: 'Neue Allee 9',
  addressLine2: null,
  postalCode: '80331',
  city: 'München',
  countryCode: 'DE',
  taxNumber: '12/345/67890',
  vatId: null,
  smallBusinessId: null,
  email: null,
  phone: null,
  website: null,
  bankName: null,
  iban: null,
  bic: null,
  registerCourt: null,
  registerNumber: null,
  managingDirector: null,
};

describe('createCompanySlots', () => {
  it('lets four run per company, the fifth waits, release frees one, companies do not share', () => {
    const slots = createCompanySlots(4);
    const held = [1, 2, 3, 4].map(() => slots.acquire('a'));
    expect(held.every((h) => h.ok)).toBe(true);
    expect(slots.acquire('a')).toMatchObject({ ok: false });
    expect(slots.acquire('b').ok).toBe(true);
    const first = held[0];
    if (first.ok) {
      first.release();
      first.release();
    }
    expect(slots.inFlight('a')).toBe(3);
    expect(slots.acquire('a').ok).toBe(true);
  });
});

describe('dailyExtractLimit', () => {
  it('defaults to 500, takes a positive integer, refuses anything else', () => {
    expect(dailyExtractLimit({})).toBe(500);
    expect(dailyExtractLimit({ BOOKS_IMPORT_DAILY_LIMIT: '20' })).toBe(20);
    expect(() => dailyExtractLimit({ BOOKS_IMPORT_DAILY_LIMIT: '0' })).toThrow();
    expect(() => dailyExtractLimit({ BOOKS_IMPORT_DAILY_LIMIT: 'lots' })).toThrow();
  });
});

describe('withCompanySender', () => {
  it('fills only what the PDF does not show, and counts it', () => {
    const printed = { sender: { name: 'Sample Studio (old name)', addressLines: [], country: null, taxNumber: null, vatId: null } };
    const out = withCompanySender(printed, company);
    expect(out.printed.sender).toEqual({
      name: 'Sample Studio (old name)',
      addressLines: ['Neue Allee 9', '80331 München'],
      country: 'DE',
      taxNumber: '12/345/67890',
      vatId: null,
    });
    expect(out.filled).toBe(3);
  });

  it('builds the whole sender from the company when the PDF shows none, and leaves it when there is no company', () => {
    expect(withCompanySender({ sender: null }, company).printed.sender).toMatchObject({ name: 'Sample Studio', country: 'DE' });
    expect(withCompanySender({ sender: null }, null)).toEqual({ printed: { sender: null }, filled: 0 });
  });

  it('valueAt reads a dotted path', () => {
    expect(valueAt({ lines: [{ lineTotal: 5 }] }, 'lines.0.lineTotal')).toBe(5);
    expect(valueAt({ a: null }, 'a.b')).toBeUndefined();
  });
});

describe('the review form', () => {
  it('reads decimals either way and says which field is not a number', () => {
    expect(readDecimal('1.234,50')).toBe(1234.5);
    expect(readDecimal('1234.5')).toBe(1234.5);
    expect(readDecimal('-80')).toBe(-80);
    expect(readDecimal('')).toBeNull();
    expect(Number.isNaN(readDecimal('abc'))).toBe(true);
  });

  it('turns the form into a printed invoice; a field that is not a number is named', () => {
    const base = { taxAmounts: [], recipient: { customerNumber: '1003' } } as unknown as PrintedInvoice;
    const form = {
      number: ' 17 ', issueDate: '2022-05-03', serviceDate: '', servicePeriod: '', currency: 'chf', taxTreatment: 'small_business', total: '720',
      taxNote: '', paymentTerms: '', pricesIncludeVat: false, recipientName: 'Example Client GmbH', recipientLines: 'Beispielweg 2\n\n20095 Hamburg',
      recipientCountry: 'DE', recipientVatId: '', senderName: 'Sample Studio', senderLines: '', senderCountry: '', senderTaxNumber: '', senderVatId: '',
      lines: [{ description: 'Design work', quantity: '10', unit: 'h', unitPrice: '80', discount: '', lineTotal: '800', taxRate: '', taxAmount: '' },
        { description: 'Rabatt', quantity: '', unit: '', unitPrice: '', discount: '', lineTotal: '-80', taxRate: '', taxAmount: '' }],
    };
    const out = fromForm(form, base);
    if (!out.ok) throw new Error(out.field);
    expect(out.printed).toMatchObject({
      number: '17',
      currency: 'CHF',
      total: 720,
      recipient: { addressLines: ['Beispielweg 2', '20095 Hamburg'], customerNumber: '1003' },
      lines: [{ quantity: 10, lineTotal: 800 }, { quantity: null, unitPrice: null, lineTotal: -80 }],
    });
    expect(fromForm({ ...form, total: 'twelve' }, base)).toEqual({ ok: false, field: 'Total' });
  });
});

describe('problem texts', () => {
  it('names every code, adds counts, labels paths, and shows an unknown code as itself', () => {
    expect(problemText({ code: 'number_taken', path: 'number', blocking: true, count: null })).toMatch(/already in the Books/);
    expect(problemText({ code: 'counter_raised', path: null, blocking: false, count: 63 })).toBe('Your next invoice number will become 63. It cannot be lowered later.');
    expect(problemText({ code: 'line_price_derived', path: null, blocking: false, count: 3 })).toMatch(/\(3 lines\)$/);
    expect(problemText({ code: 'import_failed:totals_mismatch', path: null, blocking: false, count: null })).toMatch(/totals_mismatch/);
    expect(problemText({ code: 'something_new', path: null, blocking: true, count: null })).toBe('something_new');
    expect(pathLabel('lines.2.lineTotal')).toBe('Line 3, lineTotal');
    expect(pathLabel('recipient.name')).toBe('Recipient name');
    expect(pathLabel(null)).toBeNull();
  });
});

describe('cleanFileName', () => {
  it('keeps the last path segment without control characters, bounded', () => {
    expect(cleanFileName('C:\\scans\\2021\\rechnung 12.pdf')).toBe('rechnung 12.pdf');
    expect(cleanFileName('a\u0000b.pdf')).toBe('ab.pdf');
    expect(cleanFileName('')).toBe('invoice.pdf');
    expect(cleanFileName('x'.repeat(400))).toHaveLength(255);
  });
});
