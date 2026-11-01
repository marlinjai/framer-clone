// src/server/commerce/payment/__tests__/invoiceable.test.ts
//
// The rule on its own: who can be invoiced under regular taxation and under section 19. The pay route and the
// real invoice around it are proven in src/app/api/commerce/orders/[orderId]/pay/__tests__/refuseForeign.itest.ts.

import { describe, expect, it } from 'vitest';

import { buyerSchema } from '../buyer';
import { buyerRefusal } from '../invoiceable';

const REGULAR = { kleinunternehmer: false };
const SMALL_BUSINESS = { kleinunternehmer: true };

describe('buyerRefusal', () => {
  it.each([
    ['DE', undefined],
    ['DE', null],
    ['DE', 'DE123456789'],
    ['DE', 'de 123 456 789'],
  ])('regular taxation takes %s with VAT id %s', (country, vatId) => {
    expect(buyerRefusal({ country, vatId }, REGULAR)).toBeNull();
  });

  it.each(['', '   '])('a blank VAT id is none at all, so it reaches neither the rule nor the Books (%j)', (vatId) => {
    const { vatId: parsed } = buyerSchema.parse({
      name: 'Alex Example',
      email: 'alex@example.com',
      addressLine1: 'Beispielweg 2',
      postalCode: '20095',
      city: 'Hamburg',
      country: 'DE',
      vatId,
    });
    expect(parsed).toBeNull();
    expect(buyerRefusal({ country: 'DE', vatId: parsed }, REGULAR)).toBeNull();
  });

  it.each(['AT', 'FR', 'CH', 'GB', 'XI', 'US'])('every company refuses an address in %s', (country) => {
    expect(buyerRefusal({ country, vatId: null }, REGULAR)).toMatchObject({ field: 'country' });
    expect(buyerRefusal({ country, vatId: null }, SMALL_BUSINESS)).toMatchObject({ field: 'country' });
  });

  it('names the address first when both are foreign: the VAT id alone would not help', () => {
    expect(buyerRefusal({ country: 'AT', vatId: 'ATU12345678' }, REGULAR)).toMatchObject({ field: 'country' });
  });

  it.each(['ATU12345678', 'FR12345678901', 'DE12345678', 'DE1234567890', 'DE12345678A', '12/345/67890'])(
    'regular taxation refuses the VAT id %s on a German address',
    (vatId) => {
      expect(buyerRefusal({ country: 'DE', vatId }, REGULAR)).toMatchObject({ field: 'vatId' });
    },
  );

  it.each([
    [null],
    ['DE123456789'],
    ['ATU12345678'],
    ['fr 12 345678901'],
  ])('section 19 takes a German address with VAT id %s', (vatId) => {
    expect(buyerRefusal({ country: 'DE', vatId }, SMALL_BUSINESS)).toBeNull();
  });

  it('section 19 refuses an id the Books would not store', () => {
    expect(buyerRefusal({ country: 'DE', vatId: '12/345/67890' }, SMALL_BUSINESS)).toMatchObject({ field: 'vatId' });
  });

  it('every refusal says what to do and that no money moved', () => {
    const refusals = [
      buyerRefusal({ country: 'AT', vatId: null }, REGULAR),
      buyerRefusal({ country: 'DE', vatId: 'ATU12345678' }, REGULAR),
      buyerRefusal({ country: 'DE', vatId: 'nonsense!' }, SMALL_BUSINESS),
    ];
    for (const refusal of refusals) {
      expect(refusal?.message).toMatch(/continue/);
      expect(refusal?.message).toContain('Nothing has been charged.');
    }
  });
});
