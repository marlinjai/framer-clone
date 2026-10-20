// src/server/books/upload/__tests__/units.test.ts
//
// The small pure parts of the upload import: the per-company slots and the
// daily ceiling from env, the company sender filling what a PDF does not show,
// the review form's conversion, the problem texts, the file name shown.
// Synthetic data only.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fromForm, readDecimal } from '@/app/projects/books/ImportRowEditor';
import type { PrintedInvoice } from '@/lib/books/api';
import { pathLabel, problemText } from '@/lib/books/importProblems';

import { describeError } from '@/server/books/http/route';

import { createCompanySlots, dailyExtractLimit, dailyExtractLimitShown } from '../limits';
import { cleanFileName, failureOutcome } from '../service';
import { withoutNul } from '../staging';
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

  it('for showing, an invalid setting is null rather than breaking the page', () => {
    expect(dailyExtractLimitShown({ BOOKS_IMPORT_DAILY_LIMIT: 'lots' })).toBeNull();
    expect(dailyExtractLimitShown({})).toBe(500);
  });
});

describe('failureOutcome', () => {
  it('blames the PDF only when the API refused the document itself; account and request errors stay retryable', () => {
    const apiError = (status: number, message: string) => Object.assign(new Error(`${status} ${message}`), { status, error: { error: { message } } });
    expect(failureOutcome(apiError(413, 'request too large'))).toBe('unreadable');
    expect(failureOutcome(apiError(400, 'The PDF specified was not valid.'))).toBe('unreadable');
    expect(failureOutcome(apiError(400, 'Your credit balance is too low to access the Anthropic API.'))).toBe('error');
    expect(failureOutcome(apiError(400, 'output_config.effort: invalid value'))).toBe('error');
    expect(failureOutcome(apiError(529, 'Overloaded'))).toBe('error');
    expect(failureOutcome(new Error('socket hang up'))).toBe('error');
  });
});

describe('what the import keeps and logs', () => {
  it('withoutNul drops U+0000 from every string, keys included, and leaves the rest', () => {
    expect(withoutNul({ a: 'x\u0000y', 'k\u0000': [1, 'z\u0000', null, { b: true }] })).toEqual({ a: 'xy', k: [1, 'z', null, { b: true }] });
  });

  it('an unexpected error is logged by kind, SQLSTATE, names and frames, never its message', () => {
    const err = Object.assign(new Error('Failing row contains (Example Client GmbH, 1234.50)'), {
      name: 'PostgresError',
      code: '23514',
      constraint_name: 'some_check',
      table_name: 'historical_import_item',
      detail: 'Failing row contains (Example Client GmbH)',
    });
    const text = describeError(err);
    expect(text).toContain('PostgresError (code=23514, constraint_name=some_check, table_name=historical_import_item)');
    expect(text).not.toContain('Example Client');
    expect(text).not.toContain('1234.50');
    expect(describeError('a string')).toBe('string');
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
      // Recorded as not printed: filled from the settings.
      taxNumberPresent: false,
      vatIdPresent: false,
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
      taxAmounts: [],
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
    expect(fromForm({ ...form, total: 'twelve' }, base)).toEqual({ ok: false, field: 'Total is not a number.' });
  });

  it('keeps an inferred recipient country inferred unless changed, and sends the edited VAT summary', () => {
    const base = {
      taxAmounts: [{ rate: 19, net: 100, tax: 19 }],
      recipient: { name: 'Example Client GmbH', addressLines: [], country: null, countryInferred: 'DE', customerNumber: null },
    } as unknown as PrintedInvoice;
    const form = {
      number: '5', issueDate: '2022-05-03', serviceDate: '', servicePeriod: '', currency: 'EUR', taxTreatment: 'regular', total: '119',
      taxNote: '', paymentTerms: '', pricesIncludeVat: false, recipientName: 'Example Client GmbH', recipientLines: '',
      recipientCountry: 'DE', recipientVatId: '', senderName: '', senderLines: '', senderCountry: '', senderTaxNumber: '', senderVatId: '',
      lines: [{ description: 'Design', quantity: '', unit: '', unitPrice: '', discount: '', lineTotal: '100', taxRate: '', taxAmount: '' }],
      taxAmounts: [{ rate: '19', net: '100', tax: '19,00' }, { rate: '', net: '', tax: '' }],
    };
    const kept = fromForm(form, base);
    if (!kept.ok) throw new Error(kept.field);
    expect(kept.printed.recipient).toMatchObject({ country: null, countryInferred: 'DE' });
    expect(kept.printed.taxAmounts).toEqual([{ rate: 19, net: 100, tax: 19 }]);
    const changed = fromForm({ ...form, recipientCountry: 'AT' }, base);
    if (!changed.ok) throw new Error(changed.field);
    expect(changed.printed.recipient).toMatchObject({ country: 'AT', countryInferred: null });
    expect(fromForm({ ...form, taxAmounts: [{ rate: '19', net: 'x', tax: '19' }] }, base)).toEqual({ ok: false, field: 'VAT summary 1, net is not a number.' });
    expect(fromForm({ ...form, taxAmounts: [{ rate: '', net: '100', tax: '19' }] }, base)).toEqual({ ok: false, field: 'VAT summary 1, rate is missing.' });
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

describe('every problem the server writes has a text', () => {
  it('codes named in the mapping, the core, the validation and the service all have a sentence', () => {
    const files = ['src/server/books/importPrinted.ts', 'src/server/books/importInvoices.ts', 'src/server/books/upload/validate.ts', 'src/server/books/upload/service.ts'];
    const codes = new Set<string>();
    for (const f of files) {
      const text = readFileSync(join(process.cwd(), f), 'utf8');
      for (const m of text.matchAll(/(?:issue\(\s*'(?:error|skipped)',\s*|reason: |problem\(|code: )'([a-z][a-z0-9_]+)'/g)) codes.add(m[1]);
    }
    // zod's own issue kind, not a problem code.
    codes.delete('custom');
    expect(codes.size).toBeGreaterThan(30);
    const missing = [...codes].filter((code) => problemText({ code, path: null, blocking: true, count: null }) === code);
    expect(missing).toEqual([]);
    for (const outcome of ['refused', 'invalid_output', 'max_tokens', 'unreadable', 'error']) {
      expect(problemText({ code: `extraction_failed:${outcome}`, path: null, blocking: true, count: null })).not.toBe(`extraction_failed:${outcome}`);
      expect(problemText({ code: `reread_failed:${outcome}`, path: null, blocking: false, count: null })).toMatch(/earlier reading is kept/);
    }
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
