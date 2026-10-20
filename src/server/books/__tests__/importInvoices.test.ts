// src/server/books/__tests__/importInvoices.test.ts
//
// The contract of the historical import's domain core (importInvoices.ts): the
// record every caller hands in (the CLI now, the in-editor upload later), the
// check of the original's bytes, and the judgement of a number already in the
// books. Pure: no database. Synthetic data only.

import { describe, expect, it } from 'vitest';

import { BooksError, isBooksError, mapDbError } from '../errors';
import {
  checkOriginal,
  judgeExisting,
  linesNotQuantityTimesPrice,
  parseHistoricalInvoice,
  recordWarnings,
  recipientKey,
  type HistoricalInvoiceInput,
} from '../importInvoices';

const NOW = new Date('2026-10-20T10:00:00Z');

function sender(overrides: Record<string, unknown> = {}) {
  return {
    legalName: 'Sample Studio',
    addressLine1: 'Musterstrasse 1',
    addressLine2: null,
    postalCode: '10115',
    city: 'Berlin',
    countryCode: 'DE',
    taxNumber: null,
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
    ...overrides,
  };
}

function record(overrides: Record<string, unknown> = {}): HistoricalInvoiceInput {
  return {
    origin: 'upload_extracted',
    numberValue: 12,
    issueDate: '2021-03-04',
    serviceDate: null,
    servicePeriod: null,
    paymentTermsDays: 14,
    dueDate: '2021-03-18',
    recipient: {
      kind: 'organization',
      name: 'Example Client GmbH',
      addressLine1: 'Beispielweg 2',
      addressLine2: null,
      postalCode: '20095',
      city: 'Hamburg',
      country: 'DE',
      customerNumber: null,
      customerNumberText: null,
      vatId: null,
    },
    sender: sender(),
    lines: [
      { kind: 'text', title: 'Project phase one', description: null, quantity: 0, unitLabel: 'Stk', unitPrice: 0, discountBp: 0, subtotal: 0 },
      { kind: 'service', title: 'Design work', description: null, quantity: 1500, unitLabel: 'h', unitPrice: 8000, discountBp: 0, subtotal: 12000 },
    ],
    total: 12000,
    taxTreatment: 'small_business',
    taxNote: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.',
    ...overrides,
  } as HistoricalInvoiceInput;
}

function refusedPaths(input: unknown): string[] {
  try {
    parseHistoricalInvoice(input, NOW);
  } catch (err) {
    if (!isBooksError(err, 'INVALID_INPUT')) throw err;
    return ((err.details?.issues as Array<{ path: string }>) ?? []).map((i) => i.path);
  }
  throw new Error('expected INVALID_INPUT');
}

describe('parseHistoricalInvoice', () => {
  it('accepts a record of either origin, without printed address lines, and defaults the provenance', () => {
    const parsed = parseHistoricalInvoice(record(), NOW);
    expect(parsed.origin).toBe('upload_extracted');
    expect(parsed.provenance).toEqual({});
    expect(parsed.recipient.addressLines).toBeUndefined();
    expect(parseHistoricalInvoice(record({ origin: 'operator_file' }), NOW).origin).toBe('operator_file');
  });

  it('refuses what an issued small-business invoice cannot be, naming fields only', () => {
    expect(refusedPaths(record({ origin: 'guessed' }))).toEqual(['origin']);
    expect(refusedPaths(record({ total: 12001 }))).toEqual(['total']);
    expect(refusedPaths(record({ taxTreatment: 'regular' }))).toEqual(['taxTreatment']);
    expect(refusedPaths(record({ issueDate: '2027-01-01', dueDate: null }))).toEqual(['issueDate']);
    expect(refusedPaths(record({ issueDate: '2021-02-30', dueDate: null }))).toEqual(['issueDate']);
    expect(refusedPaths(record({ dueDate: '2021-03-01' }))).toEqual(['dueDate']);
    expect(refusedPaths(record({ servicePeriod: { start: '2021-03-01', end: '2021-02-01' } }))).toEqual(['servicePeriod']);
    expect(refusedPaths(record({ sender: sender({ legalName: ' ' }) }))).toEqual(['sender.legalName']);
    expect(refusedPaths(record({ sender: sender({ countryCode: 'Germany' }) }))).toEqual(['sender.countryCode']);
    expect(refusedPaths(record({ recipient: { ...record().recipient, country: 'Deutschland' } }))).toEqual(['recipient.country']);
    expect(refusedPaths(record({ recipient: { ...record().recipient, vatId: 'de 123' } }))).toEqual(['recipient.vatId']);
    expect(
      refusedPaths(record({ lines: [{ kind: 'text', title: 'x', description: null, quantity: 0, unitLabel: 'Stk', unitPrice: 0, discountBp: 0, subtotal: 0 }], total: 0 })),
    ).toEqual(['lines']);
    expect(
      refusedPaths(
        record({ lines: [{ kind: 'text', title: 'x', description: null, quantity: 0, unitLabel: 'Stk', unitPrice: 100, discountBp: 0, subtotal: 100 }], total: 100 }),
      ),
    ).toContain('lines.0');
  });

  it('keeps personal data out of the event: the provenance takes known flags and counts only', () => {
    expect(refusedPaths(record({ provenance: { clientName: 'Example Client GmbH' } }))).toEqual(['provenance']);
    expect(parseHistoricalInvoice(record({ provenance: { otherFilesSkipped: 2, paidOnPresent: true } }), NOW).provenance).toEqual({
      otherFilesSkipped: 2,
      paidOnPresent: true,
    });
  });

  it('holds a person name to the contacts limit of 120 characters', () => {
    expect(refusedPaths(record({ recipient: { ...record().recipient, kind: 'person', name: 'x'.repeat(121) } }))).toEqual(['recipient.name']);
    expect(parseHistoricalInvoice(record({ recipient: { ...record().recipient, name: 'x'.repeat(160) } }), NOW).recipient.name).toHaveLength(160);
  });

  it('an address the print does not carry stays empty and is warned, never refused or invented', () => {
    const parsed = parseHistoricalInvoice(record({ recipient: { ...record().recipient, postalCode: '', city: '' }, sender: sender({ addressLine1: null, city: null }) }), NOW);
    expect(recordWarnings(parsed)).toEqual([{ code: 'sender_address_missing' }, { code: 'recipient_address_incomplete' }]);
  });

  it('a printed discount line may carry a negative amount; the total may not', () => {
    const lines = [
      { kind: 'service', title: 'Design work', description: null, quantity: 1000, unitLabel: 'Stk', unitPrice: 10000, discountBp: 0, subtotal: 10000 },
      { kind: 'service', title: 'Rabatt', description: null, quantity: 1000, unitLabel: 'Stk', unitPrice: -1000, discountBp: 0, subtotal: -1000 },
    ];
    expect(parseHistoricalInvoice(record({ lines, total: 9000 }), NOW).total).toBe(9000);
    expect(refusedPaths(record({ lines: [lines[1]], total: -1000 }))).toContain('total');
  });

  it('takes any line arithmetic as printed (the warnings report it), but the lines must sum to the total', () => {
    const fee = record({
      lines: [{ kind: 'service', title: 'Fixed fee', description: null, quantity: 3000, unitLabel: 'Monat', unitPrice: 116667, discountBp: 0, subtotal: 350000 }],
      total: 350000,
    });
    expect(parseHistoricalInvoice(fee, NOW).lines[0].subtotal).toBe(350000);
    expect(linesNotQuantityTimesPrice(parseHistoricalInvoice(fee, NOW))).toBe(1);
    expect(linesNotQuantityTimesPrice(parseHistoricalInvoice(record(), NOW))).toBe(0);
    const discounted = record({
      lines: [{ kind: 'service', title: 'Workshop', description: null, quantity: 2000, unitLabel: 'Tag', unitPrice: 50000, discountBp: 1000, subtotal: 90000 }],
      total: 90000,
    });
    expect(linesNotQuantityTimesPrice(parseHistoricalInvoice(discounted, NOW))).toBe(0);
  });

  it('keeps the printed ISO 4217 currency (EUR by default) and refuses anything else', () => {
    expect(parseHistoricalInvoice(record(), NOW).currency).toBe('EUR');
    expect(parseHistoricalInvoice(record({ currency: 'CHF' }), NOW).currency).toBe('CHF');
    expect(refusedPaths(record({ currency: 'XYZ' }))).toEqual(['currency']);
    expect(refusedPaths(record({ currency: 'chf' }))).toEqual(['currency']);
  });

  it('refuses unknown top-level fields instead of dropping them', () => {
    expect(refusedPaths({ ...record(), extra: 1 })).toEqual(['']);
  });
});

describe('checkOriginal', () => {
  it('digests a PDF and refuses anything else', () => {
    const ok = checkOriginal(new Uint8Array(Buffer.from('%PDF-1.4 synthetic', 'latin1')));
    expect(ok.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => checkOriginal(new Uint8Array())).toThrow(/INVALID_INPUT: pdf/);
    expect(() => checkOriginal(new Uint8Array(Buffer.from('not a pdf')))).toThrow(/INVALID_INPUT: pdf/);
  });
});

describe('judgeExisting', () => {
  it('absent imports; the same original is already imported; anything else is a conflict', () => {
    expect(judgeExisting({ state: 'absent' }, 12, 'a')).toBeNull();
    const stored = { state: 'imported' as const, documentId: 'd', sha256: 'a', total: 12000, issueDate: '2021-03-04', currency: 'EUR' };
    const same = { total: 12000, issueDate: '2021-03-04', currency: 'EUR' };
    expect(judgeExisting(stored, 12, 'a', same)).toEqual({ status: 'already_imported', documentId: 'd', differs: false });
    // Same original, data corrected since: reported as differing, never changed.
    expect(judgeExisting(stored, 12, 'a', { ...same, total: 12001 })).toEqual({ status: 'already_imported', documentId: 'd', differs: true });
    expect(judgeExisting(stored, 12, 'a', { ...same, issueDate: '2021-03-05' })).toMatchObject({ differs: true });
    expect(judgeExisting(stored, 12, 'a', { ...same, currency: 'CHF' })).toMatchObject({ differs: true });
    expect(() => judgeExisting({ ...stored, sha256: 'b' }, 12, 'a')).toThrow(/IMPORT_CONFLICT: invoice 12 was imported with a different file/);
    expect(() => judgeExisting({ state: 'other', documentId: 'd' }, 12, 'a')).toThrow(/IMPORT_CONFLICT: invoice 12 already exists as a document of this system/);
  });
});

describe('recipientKey', () => {
  it('one client per name, whatever the case, spacing or kind', () => {
    expect(recipientKey({ name: 'Example  Client gmbh' })).toBe(recipientKey({ name: 'example client GmbH' }));
  });
});

describe('the 009 trigger codes surface as Books errors', () => {
  it('BK007 is IMPORT_INCOMPLETE, BK005 TOTALS_MISMATCH', () => {
    const bk007 = mapDbError(Object.assign(new Error('x'), { code: 'BK007' }));
    expect(bk007).toBeInstanceOf(BooksError);
    expect((bk007 as BooksError).code).toBe('IMPORT_INCOMPLETE');
    expect((mapDbError(Object.assign(new Error('x'), { code: 'BK005' })) as BooksError).code).toBe('TOTALS_MISMATCH');
  });
});
