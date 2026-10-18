// Unit test for commerceSlugFor: the registry slug must be unique per tenant
// group even when display slugs collide (tenant_groups.slug is UNIQUE).

import { describe, expect, it } from 'vitest';

import { commerceSlugFor } from '../provision';

const A = '018f9c10-0000-7000-8000-0000000000a1';
const B = '018f9c10-0000-7000-8000-0000000000b1';
const HEX_A = A.replace(/-/g, '');

describe('commerceSlugFor', () => {
  it('appends the full tenant-group id, so equal display slugs never collide', () => {
    expect(commerceSlugFor(A, 'acme')).toBe(`acme-${HEX_A}`);
    expect(commerceSlugFor(A, 'acme')).not.toBe(commerceSlugFor(B, 'acme'));
  });

  it('normalises the display part', () => {
    expect(commerceSlugFor(A, '  Acme GmbH & Co. ')).toBe(`acme-gmbh-co-${HEX_A}`);
  });

  it('uses the id alone without a usable display slug', () => {
    expect(commerceSlugFor(A)).toBe(HEX_A);
    expect(commerceSlugFor(A, '')).toBe(HEX_A);
    expect(commerceSlugFor(A, '***')).toBe(HEX_A);
    expect(commerceSlugFor(A, A)).toBe(HEX_A);
  });

  it('rejects a tenant-group id that is not a UUID', () => {
    expect(() => commerceSlugFor('tg_lumitra', 'acme')).toThrow();
  });
});
