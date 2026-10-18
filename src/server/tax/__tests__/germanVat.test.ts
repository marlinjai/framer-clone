// src/server/tax/__tests__/germanVat.test.ts
//
// Books plan P1.9: the document-level tax profile and the shared reverse-charge
// guard. The per-line arithmetic (computeLineTax, resolveLineRate) keeps its
// coverage in the order orchestrator's createOrder.test.ts, which imports the
// same functions through createOrder's re-export.

import { describe, expect, it } from 'vitest';

import {
  assertReverseChargeAllowed,
  ReverseChargeNotAllowedError,
  resolveTaxProfile,
  REVERSE_CHARGE_NOTICE,
  type TaxProfileInput,
} from '../germanVat';

const NOTE = 'Synthetic exemption note for tests.';

function input(overrides: Partial<TaxProfileInput>): TaxProfileInput {
  return {
    companyTaxStatus: 'regular',
    exemptionNote: NOTE,
    customerType: 'b2c',
    vatId: null,
    countryCode: 'DE',
    ...overrides,
  };
}

describe('resolveTaxProfile', () => {
  it('resolveTaxProfile small business ignores the customer', () => {
    const cases: Partial<TaxProfileInput>[] = [
      { customerType: 'b2c', countryCode: 'DE' },
      { customerType: 'b2b', vatId: 'FR12345678901', countryCode: 'FR' },
      { customerType: 'b2b', vatId: null, countryCode: 'US' },
    ];
    for (const c of cases) {
      const p = resolveTaxProfile(input({ ...c, companyTaxStatus: 'small_business' }));
      expect(p.kleinunternehmer).toBe(true);
      expect(p.reverseCharge).toBe(false);
      expect(p.taxNote).toBe(NOTE);
      expect(p.supported).toBe(true);
    }
  });

  it('resolveTaxProfile regular EU business with VAT id is reverse charge', () => {
    const p = resolveTaxProfile(input({ customerType: 'b2b', vatId: 'FR12345678901', countryCode: 'FR' }));
    expect(p.reverseCharge).toBe(true);
    expect(p.kleinunternehmer).toBe(false);
    expect(p.taxNote).toBe(REVERSE_CHARGE_NOTICE);
    expect(p.supported).toBe(true);
  });

  it('resolveTaxProfile regular domestic and EU consumer use German rates', () => {
    for (const c of [
      { customerType: 'b2b' as const, vatId: 'DE123456789', countryCode: 'DE' },
      { customerType: 'b2c' as const, vatId: null, countryCode: 'FR' },
    ]) {
      const p = resolveTaxProfile(input(c));
      expect(p.reverseCharge).toBe(false);
      expect(p.kleinunternehmer).toBe(false);
      expect(p.taxNote).toBeNull();
      expect(p.supported).toBe(true);
    }
  });

  it('resolveTaxProfile regular third country is unsupported', () => {
    const p = resolveTaxProfile(input({ customerType: 'b2b', vatId: null, countryCode: 'US' }));
    expect(p.supported).toBe(false);
    expect(p.reverseCharge).toBe(false);
  });

  it('assertReverseChargeAllowed rejects b2c and empty VAT id', () => {
    expect(() => assertReverseChargeAllowed({ customerType: 'b2c', vatId: 'FR1' })).toThrow(
      ReverseChargeNotAllowedError,
    );
    expect(() => assertReverseChargeAllowed({ customerType: 'b2b', vatId: '' })).toThrow(
      ReverseChargeNotAllowedError,
    );
    expect(() => assertReverseChargeAllowed({ customerType: 'b2b', vatId: '   ' })).toThrow(
      ReverseChargeNotAllowedError,
    );
    expect(() => assertReverseChargeAllowed({ customerType: 'b2b', vatId: 'FR12345678901' })).not.toThrow();
  });

  it('tax profile key changes exactly when an input changes', () => {
    const base = input({ customerType: 'b2b', vatId: 'DE123456789', countryCode: 'DE' });
    const key = resolveTaxProfile(base).key;
    expect(resolveTaxProfile({ ...base }).key).toBe(key);
    // The exemption note is not an input of the key.
    expect(resolveTaxProfile({ ...base, exemptionNote: 'other' }).key).toBe(key);
    expect(resolveTaxProfile({ ...base, companyTaxStatus: 'small_business' }).key).not.toBe(key);
    expect(resolveTaxProfile({ ...base, customerType: 'b2c' }).key).not.toBe(key);
    expect(resolveTaxProfile({ ...base, vatId: 'DE999999999' }).key).not.toBe(key);
    expect(resolveTaxProfile({ ...base, countryCode: 'AT' }).key).not.toBe(key);
  });
});
