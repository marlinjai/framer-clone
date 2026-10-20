// src/server/books/__tests__/importCli.test.ts
//
// The pure half of `pnpm books:import` (importCli.ts): reading the input file,
// mapping one invoice to what is written, the skip and error reasons, the
// originals on disk, and the report lines that must never carry input values.
// The database half (forward, idempotence, conflict, resume, counter, download,
// freeze, dry run) is books-import.itest.ts. Synthetic data only.

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  countryCode,
  cutWhole,
  discountBp,
  extractVatId,
  servicePeriodOf,
  errorCode,
  euros,
  inferKind,
  parseImportFile,
  paymentTermsDays,
  planInvoice,
  readOriginal,
  reportLine,
  scriptErrorLine,
  splitAddress,
  type PlannedInvoice,
} from '../importCli';
import { BooksError } from '../errors';
import { linesNotQuantityTimesPrice, recordWarnings } from '../importInvoices';

const NOW = new Date('2026-10-20T10:00:00Z');
const FILE = new Uint8Array(Buffer.from('%PDF-1.4 synthetic', 'latin1'));

/** A complete synthetic entry in the shape of the private input. */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    file: 'invoices/7.pdf',
    fileRole: 'original',
    otherFiles: [],
    issueDate: '2021-03-04',
    serviceDate: null,
    servicePeriod: null,
    recipient: {
      name: 'Example Client GmbH',
      addressLines: ['Example Client GmbH', 'Beispielweg 2', '20095 Hamburg'],
      country: null,
      countryInferred: 'DE',
      customerNumber: '1003',
    },
    recipientVatId: null,
    sender: {
      name: 'Sample Studio',
      addressLines: ['Musterstrasse 1', '10115 Berlin'],
      country: 'DE',
      taxNumberPresent: true,
      vatIdPresent: false,
    },
    lines: [
      { description: 'Design work', quantity: 1.5, unit: 'h', unitPrice: 80, discount: null, lineTotal: 120 },
      { description: 'Hosting', quantity: 1, unit: 'Stk', unitPrice: 30.5, discount: null, lineTotal: 30.5 },
    ],
    total: 150.5,
    currency: 'EUR',
    taxTreatment: 'small_business',
    taxAmounts: null,
    smallBusinessNote: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.',
    paymentTerms: 'zahlbar innerhalb von 14 Tagen',
    paidOn: '2021-03-10',
    paymentEvidence: null,
    declaredInReturn: true,
    notes: [],
    confidence: 'high',
    confidenceReason: 'clean print',
    ...overrides,
  };
}

function ready(p: PlannedInvoice) {
  if (p.issue !== null) throw new Error(`expected a ready invoice, got ${p.issue.kind}: ${p.issue.reason}`);
  return p.record;
}

describe('parseImportFile', () => {
  it('returns the entries sorted by number', () => {
    const out = parseImportFile(JSON.stringify({ meta: {}, invoices: [entry({ number: 9 }), entry({ number: 2 })] }));
    expect(out.map((e) => e.number)).toEqual([2, 9]);
  });

  it('refuses text that is not JSON, a wrong shape and duplicate numbers, naming no value', () => {
    expect(() => parseImportFile('{nope')).toThrow('books:import: the input is not valid JSON');
    expect(() => parseImportFile(JSON.stringify({ invoices: [] }))).toThrow(/expected shape \(invoices\)/);
    expect(() => parseImportFile(JSON.stringify({ invoices: [{ number: 'x' }] }))).toThrow(/expected shape/);
    expect(() => parseImportFile(JSON.stringify({ invoices: [entry({ number: 3 }), entry({ number: 3 })] }))).toThrow(
      'invoice numbers appear more than once: 3',
    );
  });
});

describe('planInvoice: forward mapping', () => {
  it('maps a complete entry to cents, thousandths, the split address and the printed note', () => {
    const inv = ready(planInvoice(7, entry(), FILE, NOW));
    expect(inv.numberValue).toBe(7);
    expect(inv.total).toBe(15050);
    expect(inv.lines).toEqual([
      expect.objectContaining({ kind: 'service', title: 'Design work', quantity: 1500, unitPrice: 8000, subtotal: 12000, discountBp: 0, unitLabel: 'h' }),
      expect.objectContaining({ kind: 'service', title: 'Hosting', quantity: 1000, unitPrice: 3050, subtotal: 3050 }),
    ]);
    expect(inv.recipient).toEqual({
      kind: 'organization',
      name: 'Example Client GmbH',
      addressLines: ['Example Client GmbH', 'Beispielweg 2', '20095 Hamburg'],
      addressLine1: 'Beispielweg 2',
      addressLine2: null,
      postalCode: '20095',
      city: 'Hamburg',
      country: 'DE',
      customerNumber: 1003,
      customerNumberText: null,
      vatId: null,
    });
    expect(inv.origin).toBe('operator_file');
    expect(inv.taxTreatment).toBe('small_business');
    expect(inv.sender).toMatchObject({
      legalName: 'Sample Studio',
      addressLine1: 'Musterstrasse 1',
      postalCode: '10115',
      city: 'Berlin',
      countryCode: 'DE',
      taxNumber: null,
      vatId: null,
      addressLines: ['Musterstrasse 1', '10115 Berlin'],
    });
    expect(inv.paymentTermsDays).toBe(14);
    expect(inv.dueDate).toBe('2021-03-18');
    expect(inv.provenance).toEqual({
      otherFilesSkipped: 0,
      senderTaxNumberPrinted: true,
      senderVatIdPrinted: false,
      serviceDateUnparsed: false,
      paidOnPresent: true,
      paymentTermsUnparsed: false,
      recipientVatIdUnparsed: false,
      recipientCountryInferred: true,
      recipientCountryAssumed: false,
      senderCountryInferred: false,
      linesPriceDerived: 0,
      linesDiscountUnparsed: 0,
      confidence: 'high',
    });
  });

  it('records what it could not take as printed: unreadable terms, an invalid VAT id, an inferred country', () => {
    const inv = ready(
      planInvoice(
        7,
        entry({
          paymentTerms: 'nach Vereinbarung',
          recipientVatId: 'not-a-vat-id',
          recipient: { name: 'Example Client GmbH', addressLines: ['Beispielweg 2', '20095 Hamburg'], country: 'DE', countryInferred: null, customerNumber: null },
        }),
        FILE,
        NOW,
      ),
    );
    expect(inv.paymentTermsDays).toBe(0);
    expect(inv.dueDate).toBeNull();
    expect(inv.recipient.vatId).toBeNull();
    expect(inv.provenance).toMatchObject({ paymentTermsUnparsed: true, recipientVatIdUnparsed: true, recipientCountryInferred: false });
  });

  it('keeps a non-numeric customer number as printed text, and a valid VAT id normalized', () => {
    const inv = ready(
      planInvoice(
        7,
        entry({
          recipient: { name: 'Example Client GmbH', addressLines: ['Beispielweg 2', '20095 Hamburg'], country: 'de', countryInferred: null, customerNumber: 'K-12' },
          recipientVatId: 'de 123 456 789',
        }),
        FILE,
        NOW,
      ),
    );
    expect(inv.recipient.customerNumber).toBeNull();
    expect(inv.recipient.customerNumberText).toBe('K-12');
    expect(inv.recipient.vatId).toBe('DE123456789');
    expect(inv.recipient.country).toBe('DE');
  });

  it('stores a line as printed when its total is not quantity times price, and the core counts it as a warning', () => {
    // The real case: a fixed fee of 3 x 1166.67 printed as 3500.00.
    const fee = ready(planInvoice(7, entry({ lines: [{ description: 'Fixed fee', quantity: 3, unit: 'Monat', unitPrice: 1166.67, discount: null, lineTotal: 3500 }], total: 3500 }), FILE, NOW));
    expect(fee.lines[0]).toMatchObject({ quantity: 3000, unitPrice: 116667, subtotal: 350000, discountBp: 0 });
    expect(linesNotQuantityTimesPrice(fee)).toBe(1);
    // A printed discount the extraction did not carry, and a total above the arithmetic: stored as printed too.
    const below = ready(planInvoice(7, entry({ lines: [{ description: 'Workshop', quantity: 2, unit: 'Tag', unitPrice: 500, discount: { percent: 10 }, lineTotal: 900 }], total: 900 }), FILE, NOW));
    expect(below.lines[0]).toMatchObject({ subtotal: 90000, discountBp: 1000 });
    const above = ready(planInvoice(7, entry({ lines: [{ description: 'x', quantity: 1, unit: 'h', unitPrice: 100, lineTotal: 150.5 }] }), FILE, NOW));
    expect(above.lines[0].subtotal).toBe(15050);
    expect(linesNotQuantityTimesPrice(ready(planInvoice(7, entry(), FILE, NOW)))).toBe(0);
  });

  it('turns a line without quantity and amount into a text line, and takes a service date and period when they are dates', () => {
    const inv = ready(
      planInvoice(
        7,
        entry({
          lines: [
            { description: 'Project phase one', quantity: 0, unit: '', unitPrice: 0, discount: null, lineTotal: 0 },
            { description: 'Design work', quantity: 1, unit: 'h', unitPrice: 150.5, discount: null, lineTotal: 150.5 },
          ],
          serviceDate: '2021-02-28',
          servicePeriod: { from: '2021-02-01', to: '2021-02-28' },
        }),
        FILE,
        NOW,
      ),
    );
    expect(inv.lines[0]).toMatchObject({ kind: 'text', quantity: 0, subtotal: 0 });
    expect(inv.serviceDate).toBe('2021-02-28');
    expect(inv.servicePeriod).toEqual({ start: '2021-02-01', end: '2021-02-28' });
  });

  it('records a service date it could not read instead of dropping it silently', () => {
    const inv = ready(planInvoice(7, entry({ serviceDate: 'Februar 2021' }), FILE, NOW));
    expect(inv.serviceDate).toBeNull();
    expect(inv.provenance.serviceDateUnparsed).toBe(true);
  });

  it('cuts a long line text into a title and keeps the full text as the description', () => {
    const text = 'Lorem ipsum '.repeat(40).trim();
    const inv = ready(planInvoice(7, entry({ lines: [{ description: text, quantity: 1, unit: 'Stk', unitPrice: 150.5, discount: null, lineTotal: 150.5 }] }), FILE, NOW));
    expect(inv.lines[0].title.length).toBe(300);
    expect(inv.lines[0].description).toBe(text);
  });

  it('counts the other files that are not stored', () => {
    const p = planInvoice(7, entry({ otherFiles: ['a.pdf', 'b.pdf'] }), FILE, NOW);
    expect(p.otherFiles).toBe(2);
    expect(ready(p).provenance.otherFilesSkipped).toBe(2);
  });
});

describe('planInvoice: skipped (missing) before error (inconsistent)', () => {
  const skipped: Array<[string, Record<string, unknown>, Uint8Array | null]> = [
    ['file_missing', { file: null, fileRole: 'missing', recipient: null, sender: null, lines: [] }, null],
    ['recipient_missing', { recipient: null }, FILE],
    ['sender_missing', { sender: null }, FILE],
    ['lines_missing', { lines: [] }, FILE],
    ['lines_missing', { lines: null }, FILE],
  ];
  it.each(skipped)('skipped: %s', (reason, overrides, file) => {
    const p = planInvoice(60, entry({ number: 60, ...overrides }), file, NOW);
    expect(p.issue).toEqual({ kind: 'skipped', reason });
    expect(p.number).toBe(60);
  });

  const errors: Array<[string, Record<string, unknown>]> = [
    ['lines_do_not_sum_to_total', { total: 150.51 }],
    ['currency_unsupported', { currency: 'USD' }],
    ['tax_treatment_unsupported', { taxTreatment: 'regular' }],
    ['tax_amounts_present', { taxAmounts: [{ rate: 19, amount: 1 }] }],
    ['issue_date_invalid', { issueDate: '2021-02-30' }],
    ['issue_date_in_future', { issueDate: '2027-01-01' }],
    ['recipient_country_unknown', { recipient: { name: 'Example Client GmbH', addressLines: ['Beispielweg 2', '20095 Hamburg'], country: 'Atlantis', customerNumber: null } }],
    ['sender_country_unknown', { sender: { name: 'Sample Studio', addressLines: ['Musterstrasse 1', '10115 Berlin'], country: 'Atlantis' } }],
    ['small_business_note_missing', { smallBusinessNote: '' }],
    ['line_quantity_invalid', { lines: [{ description: 'x', quantity: 0.0005, unit: 'h', unitPrice: 1, lineTotal: 150.5 }] }],
    ['line_amount_invalid', { lines: [{ description: 'x', quantity: 1, unit: 'h', unitPrice: 1.005, lineTotal: 150.5 }] }],
    ['line_amount_invalid', { lines: [{ description: 'x', quantity: 1, unit: 'h', unitPrice: -5, lineTotal: 150.5 }] }],
    ['line_text_missing', { lines: [{ description: '  ', quantity: 1, unit: 'h', unitPrice: 150.5, lineTotal: 150.5 }] }],
    ['invalid_field:recipient.name', { recipient: { name: '', addressLines: [] } }],
  ];
  it.each(errors)('error: %s', (reason, overrides) => {
    const p = planInvoice(7, entry(overrides), FILE, NOW);
    expect(p.issue).toEqual({ kind: 'error', reason });
  });
});

describe('the small parsers', () => {
  it('splitAddress takes the last postal line, the street right before it, and keeps c/o lines as the second line', () => {
    expect(splitAddress('Example Client GmbH', ['Example Client GmbH', 'c/o Office', 'z. Hd. Accounting', 'Beispielweg 2', 'D-20095 Hamburg', 'Deutschland'])).toEqual({
      addressLines: ['Example Client GmbH', 'c/o Office', 'z. Hd. Accounting', 'Beispielweg 2', 'D-20095 Hamburg', 'Deutschland'],
      addressLine1: 'Beispielweg 2',
      addressLine2: 'c/o Office, z. Hd. Accounting',
      postalCode: '20095',
      city: 'Hamburg',
      complete: true,
    });
    expect(splitAddress('X', ['Hauptstrasse 5', '1010 Wien'])).toMatchObject({ postalCode: '1010', city: 'Wien', complete: true });
    // What the print does not carry stays empty, never invented.
    expect(splitAddress('X', ['20095 Hamburg'])).toMatchObject({ addressLine1: '', postalCode: '20095', complete: false });
    expect(splitAddress('X', ['Somewhere'])).toMatchObject({ addressLine1: 'Somewhere', postalCode: '', city: '', complete: false });
    expect(splitAddress('X', [])).toEqual({ addressLines: [], addressLine1: '', addressLine2: null, postalCode: '', city: '', complete: false });
  });

  it('countryCode accepts codes and the common names, nothing else', () => {
    expect(countryCode('de')).toBe('DE');
    expect(countryCode('Deutschland')).toBe('DE');
    expect(countryCode('Österreich')).toBe('AT');
    expect(countryCode('Atlantis')).toBeNull();
    expect(countryCode(null)).toBeNull();
  });

  it('inferKind: an organization by its legal form, otherwise a person, unless the input says', () => {
    expect(inferKind('Example Client GmbH')).toBe('organization');
    expect(inferKind('Beispiel UG (haftungsbeschränkt)')).toBe('organization');
    expect(inferKind('Verein Muster e.V.')).toBe('organization');
    expect(inferKind('Erika Mustermann')).toBe('person');
    expect(inferKind('Erika Mustermann', 'organization')).toBe('organization');
  });

  it('paymentTermsDays reads stated days and "sofort", and nothing it cannot read', () => {
    expect(paymentTermsDays('zahlbar innerhalb von 14 Tagen')).toBe(14);
    expect(paymentTermsDays('Zahlbar sofort ohne Abzug')).toBe(0);
    expect(paymentTermsDays('nach Vereinbarung')).toBeNull();
    // Two day counts cannot be told apart: not read, so the fallback is flagged.
    expect(paymentTermsDays('2 % Skonto innerhalb 7 Tagen, netto 30 Tage')).toBeNull();
    expect(paymentTermsDays(null)).toBeNull();
  });
});

describe('readOriginal', () => {
  let dir: string;
  let outside: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'books-import-unit-'));
    outside = mkdtempSync(join(tmpdir(), 'books-import-outside-'));
    mkdirSync(join(dir, 'a'));
    writeFileSync(join(dir, 'a', 'ok.pdf'), Buffer.from('%PDF-1.4 synthetic'));
    writeFileSync(join(dir, 'a', 'empty.pdf'), Buffer.alloc(0));
    writeFileSync(join(dir, 'a', 'text.pdf'), Buffer.from('not a pdf'));
    writeFileSync(join(outside, 'secret.pdf'), Buffer.from('%PDF-1.4 outside'));
    symlinkSync(join(outside, 'secret.pdf'), join(dir, 'a', 'link.pdf'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('reads a PDF under the directory', () => {
    const r = readOriginal(dir, 'a/ok.pdf');
    if (typeof r === 'string') throw new Error(r);
    expect(Buffer.from(r).toString('latin1')).toBe('%PDF-1.4 synthetic');
  });

  it('refuses a path that leaves the directory, also through a link, and anything that is not a usable PDF', () => {
    expect(readOriginal(dir, '../x.pdf')).toBe('file_unreadable:ENOENT');
    expect(readOriginal(dir, `../${outside.split('/').pop()}/secret.pdf`)).toBe('file_outside_files_dir');
    expect(readOriginal(dir, 'a/link.pdf')).toBe('file_outside_files_dir');
    expect(readOriginal(dir, join(dir, 'a', 'ok.pdf'))).toBe('file_path_absolute');
    expect(readOriginal(dir, 'a/missing.pdf')).toBe('file_unreadable:ENOENT');
    expect(readOriginal(dir, 'a')).toBe('file_unreadable:not_a_file');
    expect(readOriginal(dir, 'a/empty.pdf')).toBe('file_empty');
    expect(readOriginal(dir, 'a/text.pdf')).toBe('file_not_pdf');
  });
});

describe('the report never carries input values', () => {
  it('warnings are named by kind and count only', () => {
    expect(
      reportLine({
        number: 9, issueDate: '2021-01-01', total: 350000, status: 'imported', reason: null, otherFilesSkipped: 0,
        warnings: [{ code: 'line_not_quantity_times_price', count: 1 }, { code: 'issue_date_out_of_number_order' }],
      }),
    ).toBe('invoice    9  2021-01-01     3500.00 EUR  imported [warning: line_not_quantity_times_price x1] [warning: issue_date_out_of_number_order]');
  });

  it('a report line holds number, date, total and status only', () => {
    const p = planInvoice(7, entry({ otherFiles: ['other.pdf'] }), FILE, NOW);
    const line = reportLine({ number: 7, issueDate: p.issueDate, total: p.total, status: 'imported', reason: null, otherFilesSkipped: p.otherFiles, warnings: [] });
    expect(line).toBe('invoice    7  2021-03-04      150.50 EUR  imported (1 other file(s) not stored)');
    for (const value of ['Example', 'Client', 'Beispielweg', 'Hamburg', 'Sample', 'Design', 'other.pdf', 'invoices/']) {
      expect(line).not.toContain(value);
    }
    expect(reportLine({ number: 60, issueDate: null, total: null, status: 'skipped', reason: 'file_missing', otherFilesSkipped: 0, warnings: [] })).toBe(
      'invoice   60  ????-??-??               ?  skipped: file_missing',
    );
  });

  it('errorCode names a code, a SQLSTATE or a class, never a message', () => {
    expect(errorCode(new BooksError('IMPORT_FAILED', 'IMPORT_FAILED: SQLSTATE 23514', { sqlState: '23514', constraint: 'x_check' }))).toBe('IMPORT_FAILED:SQLSTATE_23514:x_check');
    expect(errorCode(new BooksError('IMPORT_CONFLICT', 'IMPORT_CONFLICT: Example Client GmbH'))).toBe('IMPORT_CONFLICT');
    expect(errorCode(Object.assign(new Error('Key (name)=(Example Client GmbH)'), { code: '23505', constraint_name: 'x_key' }))).toBe('SQLSTATE_23505:x_key');
    expect(errorCode(new TypeError('Example Client GmbH'))).toBe('UNEXPECTED:TypeError');
  });

  it('euros formats cents without a locale', () => {
    expect(euros(0)).toBe('0.00 EUR');
    expect(euros(123456)).toBe('1234.56 EUR');
    expect(euros(null)).toBe('?');
  });
});

describe('cutWhole', () => {
  it('never cuts a character made of two UTF-16 units in half', () => {
    expect(cutWhole('ab😀c', 3)).toBe('ab');
    expect(cutWhole('ab😀c', 4)).toBe('ab😀');
    const inv = ready(planInvoice(7, entry({ lines: [{ description: `${'x'.repeat(298)}😀 rest of the text`, quantity: 1, unit: 'Stk', unitPrice: 150.5, lineTotal: 150.5 }] }), FILE, NOW));
    expect(inv.lines[0].title).toBe(`${'x'.repeat(298)}…`);
  });
});

describe('scriptErrorLine: what the script prints when the whole run is refused', () => {
  it('our refusals and the counter refusals as written, anything else by code or class only', () => {
    expect(scriptErrorLine(new Error('books:import: --input is required'))).toBe('books:import: --input is required');
    expect(scriptErrorLine(new BooksError('IMPORT_COUNTER_TOO_LOW', 'IMPORT_COUNTER_TOO_LOW: the invoice counter is at 3'))).toBe(
      'books:import: IMPORT_COUNTER_TOO_LOW: the invoice counter is at 3',
    );
    expect(scriptErrorLine(new BooksError('RECIPIENT_UNAVAILABLE', 'Example Client GmbH'))).toBe('books:import: refused (RECIPIENT_UNAVAILABLE)');
    expect(scriptErrorLine(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }))).toBe(
      'books:import: refused (ECONNREFUSED)',
    );
    expect(scriptErrorLine(new TypeError('Example Client GmbH'))).toBe('books:import: failed (TypeError)');
  });
});

describe('the shapes of the real historical data, imported as printed', () => {
  const line = (over: Record<string, unknown>) => ({ description: 'Design work', quantity: 2, unit: 'h', unitPrice: 500, discount: null, lineTotal: 1000, ...over });
  const one = (lines: Array<Record<string, unknown>>, total: number, over: Record<string, unknown> = {}) =>
    ready(planInvoice(7, entry({ lines, total, ...over }), FILE, NOW));

  it('a discount printed as a percentage string', () => {
    const inv = one([line({ discount: '10 %', lineTotal: 900 })], 900);
    expect(inv.lines[0]).toMatchObject({ quantity: 2000, unitPrice: 50000, discountBp: 1000, subtotal: 90000 });
    expect(inv.provenance.linesDiscountUnparsed).toBe(0);
    expect(recordWarnings(inv)).toEqual([]);
  });

  it('a discount printed as an amount string', () => {
    const inv = one([line({ discount: '50,00 €', lineTotal: 950 })], 950);
    expect(inv.lines[0]).toMatchObject({ discountBp: 500, subtotal: 95000 });
    expect(recordWarnings(inv)).toEqual([]);
    expect(discountBp('EUR 1.000,50', 1000, 200000)).toBe(5003);
  });

  it('a discount it cannot read: kept at 0, the printed total stands, warned', () => {
    const inv = one([line({ discount: 'Sonderrabatt', lineTotal: 900 })], 900);
    expect(inv.lines[0]).toMatchObject({ discountBp: 0, subtotal: 90000 });
    expect(inv.provenance.linesDiscountUnparsed).toBe(1);
    expect(recordWarnings(inv)).toEqual([
      { code: 'line_not_quantity_times_price', count: 1 },
      { code: 'discount_unparsed', count: 1 },
    ]);
  });

  it('a line without a unit price: the price comes from the printed total, warned', () => {
    const inv = one([line({ quantity: 3, unitPrice: null, lineTotal: 300 })], 300);
    expect(inv.lines[0]).toMatchObject({ kind: 'service', quantity: 3000, unitPrice: 10000, subtotal: 30000 });
    expect(recordWarnings(inv)).toEqual([{ code: 'line_price_derived', count: 1 }]);
  });

  it('a line without quantity and unit price: once, at the printed total, warned', () => {
    const inv = one([line({ quantity: null, unitPrice: null, unit: null, lineTotal: 250 })], 250);
    expect(inv.lines[0]).toMatchObject({ kind: 'service', quantity: 1000, unitPrice: 25000, subtotal: 25000, unitLabel: 'Stk' });
    expect(recordWarnings(inv)).toEqual([{ code: 'line_price_derived', count: 1 }]);
  });

  it('a line without quantity but with a unit price counts once at that price, warned', () => {
    const inv = one([line({ quantity: null, unitPrice: 250, lineTotal: 250 })], 250);
    expect(inv.lines[0]).toMatchObject({ quantity: 1000, unitPrice: 25000 });
    expect(inv.provenance.linesPriceDerived).toBe(1);
  });

  it('a printed discount line with a minus amount is a line of its own, as printed', () => {
    const inv = one([line({ lineTotal: 1000 }), line({ description: 'Rabatt 10 %', quantity: null, unitPrice: null, discount: '10 %', lineTotal: -100 })], 900);
    expect(inv.lines[1]).toMatchObject({ kind: 'service', quantity: 1000, unitPrice: -10000, subtotal: -10000, discountBp: 0 });
    expect(inv.total).toBe(90000);
    expect(recordWarnings(inv)).toEqual([]);
  });

  it('a line with neither quantity, price nor amount is a text line', () => {
    const inv = one([line({ quantity: null, unitPrice: null, lineTotal: 0, description: 'Phase one' }), line({})], 1000);
    expect(inv.lines[0]).toMatchObject({ kind: 'text', quantity: 0, subtotal: 0 });
  });

  it('a sender printed without address or country: German (section 19), the address left empty, warned', () => {
    const inv = one([line({})], 1000, { sender: { name: 'Sample Studio', addressLines: [], country: null } });
    expect(inv.sender).toMatchObject({ legalName: 'Sample Studio', addressLine1: null, postalCode: null, city: null, countryCode: 'DE' });
    expect(inv.provenance.senderCountryInferred).toBe(true);
    expect(recordWarnings(inv)).toEqual([{ code: 'sender_address_missing' }]);
  });

  it('a recipient without postal line, printed or inferred country: kept as far as printed, DE assumed, warned', () => {
    const inv = one([line({})], 1000, {
      recipient: { name: 'Example Client GmbH', addressLines: ['Beispielweg 2'], country: null, countryInferred: null, customerNumber: null },
    });
    expect(inv.recipient).toMatchObject({ addressLine1: 'Beispielweg 2', postalCode: '', city: '', country: 'DE' });
    expect(recordWarnings(inv)).toEqual([{ code: 'recipient_address_incomplete' }, { code: 'recipient_country_assumed' }]);
  });

  it('a VAT id inside a longer printed line is found; other identifiers are not taken for one', () => {
    expect(extractVatId('de 123 456 789')).toBe('DE123456789');
    expect(extractVatId('UID: CHE-123.456.789; USt-IdNr: DE123456789')).toBe('DE123456789');
    expect(extractVatId('CHE-123.456.789 MWST')).toBeNull();
    expect(extractVatId('DE123456789 / ATU12345678')).toBeNull();
  });

  it('a service period printed as text with two dates is read; anything else is flagged', () => {
    expect(servicePeriodOf('2023-01-01 bis 2023-01-31')).toEqual({ start: '2023-01-01', end: '2023-01-31' });
    expect(servicePeriodOf('01.02.2023 - 28.02.2023')).toEqual({ start: '2023-02-01', end: '2023-02-28' });
    expect(servicePeriodOf('März 2023')).toBeNull();
    expect(one([line({})], 1000, { servicePeriod: 'März 2023' }).provenance.serviceDateUnparsed).toBe(true);
  });
});
