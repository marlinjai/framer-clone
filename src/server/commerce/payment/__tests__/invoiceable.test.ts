// src/server/commerce/payment/__tests__/invoiceable.test.ts
//
// The rule on its own, the same for every company. The pay route and the
// real invoice around it are proven in src/app/api/commerce/orders/[orderId]/pay/__tests__/refuseForeign.itest.ts.

import { describe, expect, it } from 'vitest';

import { buyerSchema } from '../buyer';
import { buyerRefusal } from '../invoiceable';

describe('buyerRefusal', () => {
  it.each([[undefined], [null], ['DE123456789'], ['de 123 456 789']])('takes a German address with VAT id %s', (vatId) => {
    expect(buyerRefusal({ country: 'DE', vatId })).toBeNull();
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
    expect(buyerRefusal({ country: 'DE', vatId: parsed })).toBeNull();
  });

  it.each(['AT', 'FR', 'CH', 'GB', 'XI', 'US'])('refuses an address in %s', (country) => {
    expect(buyerRefusal({ country, vatId: null })).toMatchObject({ field: 'country' });
  });

  it('names the address first when both are foreign: the VAT id alone would not help', () => {
    expect(buyerRefusal({ country: 'AT', vatId: 'ATU12345678' })).toMatchObject({ field: 'country' });
  });

  it.each(['ATU12345678', 'FR12345678901', 'DE12345678', 'DE1234567890', 'DE12345678A', 'DE-123456789', '12/345/67890'])(
    'refuses the VAT id %s on a German address',
    (vatId) => {
      expect(buyerRefusal({ country: 'DE', vatId })).toMatchObject({ field: 'vatId' });
    },
  );

  it('every refusal says what to do and that no money moved', () => {
    for (const refusal of [buyerRefusal({ country: 'AT', vatId: null }), buyerRefusal({ country: 'DE', vatId: 'ATU12345678' })]) {
      expect(refusal?.message).toMatch(/continue/);
      expect(refusal?.message).toContain('Nothing has been charged.');
    }
  });
});
