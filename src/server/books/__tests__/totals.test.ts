// src/server/books/__tests__/totals.test.ts
//
// Books plan P1.9: the pure money math of a sales document (integer cents,
// thousandths quantities, basis-point discounts and rates).

import { describe, expect, it } from 'vitest';

import {
  MAX_AMOUNT_CENTS,
  applyDiscount,
  convertUnitPrice,
  deriveLine,
  lineExceedsLimit,
  lineNetBeforeDiscount,
  summarize,
  totalsExceedLimit,
  type LineInputs,
  type LineTaxContext,
} from '../totals';

const NET: LineTaxContext = { netOrGross: 'net', kleinunternehmer: false, reverseCharge: false };

function line(overrides: Partial<LineInputs>): LineInputs {
  return { kind: 'service', quantity: 1000, unitPrice: 10000, discountBp: 0, taxClass: null, taxRateOverride: null, ...overrides };
}

describe('convertUnitPrice (a product list price in the draft basis)', () => {
  const regular = { taxClass: 'standard' as const, taxRateOverride: null, kleinunternehmer: false, reverseCharge: false };

  it('adds or takes off the line rate exactly as one unit is taxed', () => {
    expect(convertUnitPrice(10000, 'net', 'gross', regular)).toBe(11900);
    expect(convertUnitPrice(11900, 'gross', 'net', regular)).toBe(10000);
    expect(convertUnitPrice(1000, 'net', 'gross', { ...regular, taxClass: 'reduced' })).toBe(1070);
    expect(convertUnitPrice(999, 'gross', 'net', regular)).toBe(999 - Math.round((999 * 1900) / 11900));
    expect(convertUnitPrice(1000, 'net', 'gross', { ...regular, taxClass: null, taxRateOverride: 500 })).toBe(1050);
    // The derived gross line equals what the net price would have printed.
    const gross = convertUnitPrice(8333, 'net', 'gross', regular);
    const asGross = deriveLine(line({ unitPrice: gross, taxClass: 'standard' }), { ...NET, netOrGross: 'gross' });
    expect(asGross.subtotal + asGross.taxAmount).toBe(gross);
  });

  it('leaves the price alone in the same basis, at 0 %, for a small business and under reverse charge', () => {
    expect(convertUnitPrice(10000, 'net', 'net', regular)).toBe(10000);
    expect(convertUnitPrice(10000, 'net', 'gross', { ...regular, taxClass: 'zero' })).toBe(10000);
    expect(convertUnitPrice(10000, 'net', 'gross', { ...regular, kleinunternehmer: true })).toBe(10000);
    expect(convertUnitPrice(10000, 'gross', 'net', { ...regular, reverseCharge: true })).toBe(10000);
  });
});

describe('totals', () => {
  it('line subtotal from thousandths quantity and discount', () => {
    // 1.5 units at 80.00 EUR = 120.00 EUR.
    expect(lineNetBeforeDiscount(1500, 8000)).toBe(12000);
    expect(deriveLine(line({ quantity: 1500, unitPrice: 8000 }), NET).subtotal).toBe(12000);
    // 10 percent discount = 108.00 EUR.
    expect(deriveLine(line({ quantity: 1500, unitPrice: 8000, discountBp: 1000 }), NET).subtotal).toBe(10800);
    // Rounding half up on odd halves: 0.5 cent -> 1, 1.5 cents -> 2, 7.5 cents -> 8.
    expect(lineNetBeforeDiscount(1, 500)).toBe(1);
    expect(lineNetBeforeDiscount(3, 500)).toBe(2);
    expect(applyDiscount(15, 5000)).toBe(8);
  });

  it('mixed-rate tax summary groups per rate', () => {
    const lines = [
      line({ unitPrice: 10000, taxClass: 'standard' }),
      line({ unitPrice: 5000, taxClass: 'standard' }),
      line({ unitPrice: 2000, taxClass: 'reduced' }),
    ].map((l) => ({ ...deriveLine(l, NET), kind: l.kind }));
    const totals = summarize(lines);
    expect(totals.taxSummary).toEqual([
      { taxRate: 1900, taxTreatment: 'standard', net: 15000, tax: 2850 },
      { taxRate: 700, taxTreatment: 'reduced', net: 2000, tax: 140 },
    ]);
    expect(totals.subtotal).toBe(lines.reduce((s, l) => s + l.subtotal, 0));
    expect(totals.taxAmount).toBe(lines.reduce((s, l) => s + l.taxAmount, 0));
    expect(totals.total).toBe(17000 + 2990);
  });

  it('gross basis extracts tax and keeps the identity', () => {
    for (const netOrGross of ['net', 'gross'] as const) {
      const lines = [line({ unitPrice: 11900, taxClass: 'standard' }), line({ unitPrice: 1070, taxClass: 'reduced' })].map(
        (l) => ({ ...deriveLine(l, { ...NET, netOrGross }), kind: l.kind }),
      );
      const totals = summarize(lines);
      expect(totals.total).toBe(totals.subtotal + totals.taxAmount);
      if (netOrGross === 'gross') {
        // 119.00 gross at 19 percent = 100.00 net + 19.00 tax; 10.70 gross at 7 percent = 10.00 + 0.70.
        expect(lines[0]).toMatchObject({ subtotal: 10000, taxAmount: 1900 });
        expect(lines[1]).toMatchObject({ subtotal: 1000, taxAmount: 70 });
        expect(totals.total).toBe(12970);
      }
    }
  });

  it('text lines are excluded from totals and summary', () => {
    const text = line({ kind: 'text', quantity: 0, unitPrice: 0 });
    expect(deriveLine(text, NET)).toEqual({ subtotal: 0, taxRate: 0, taxAmount: 0, taxTreatment: null });
    const lines = [line({ unitPrice: 10000 }), text].map((l) => ({ ...deriveLine(l, NET), kind: l.kind }));
    const totals = summarize(lines);
    expect(totals.subtotal).toBe(10000);
    expect(totals.taxSummary).toHaveLength(1);
  });

  it('small business and reverse charge suppress the tax on every billable line', () => {
    expect(deriveLine(line({ taxClass: 'reduced' }), { ...NET, kleinunternehmer: true })).toMatchObject({
      taxRate: 0,
      taxAmount: 0,
      taxTreatment: 'kleinunternehmer',
    });
    expect(deriveLine(line({ taxClass: 'standard' }), { ...NET, reverseCharge: true })).toMatchObject({
      taxRate: 0,
      taxAmount: 0,
      taxTreatment: 'reverse_charge',
    });
  });

  it('amounts stay within a PostgreSQL INTEGER (2^31 - 1 cents)', () => {
    expect(MAX_AMOUNT_CENTS).toBe(2 ** 31 - 1);
    // Exactly the limit, no tax: fits.
    const atLimit = deriveLine(line({ unitPrice: MAX_AMOUNT_CENTS }), { ...NET, kleinunternehmer: true });
    expect(atLimit.subtotal).toBe(MAX_AMOUNT_CENTS);
    expect(lineExceedsLimit(atLimit)).toBe(false);
    // One cent more: refused.
    expect(lineExceedsLimit(deriveLine(line({ quantity: 1001, unitPrice: MAX_AMOUNT_CENTS }), { ...NET, kleinunternehmer: true }))).toBe(true);
    // The net fits but net plus 19 percent does not.
    expect(lineExceedsLimit(deriveLine(line({ unitPrice: MAX_AMOUNT_CENTS, taxClass: 'standard' }), NET))).toBe(true);
    expect(totalsExceedLimit({ subtotal: MAX_AMOUNT_CENTS, taxAmount: 0, total: MAX_AMOUNT_CENTS })).toBe(false);
    expect(totalsExceedLimit({ subtotal: MAX_AMOUNT_CENTS, taxAmount: 1, total: MAX_AMOUNT_CENTS + 1 })).toBe(true);
  });
});
