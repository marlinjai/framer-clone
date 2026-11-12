// src/server/books/__tests__/snapshots.test.ts
//
// Books plan P1.9: the section 34a fields a sender block and a recipient must
// carry before an invoice can be issued. Synthetic data only.

import { describe, expect, it } from 'vitest';

import {
  buildCustomerSnapshot,
  buildSenderSnapshot,
  recipientMissingFields,
  senderMissingFields,
  toJsonb,
  type RecipientContact,
  type SenderBlockV1,
} from '../snapshots';

function sender(overrides: Partial<SenderBlockV1> = {}): SenderBlockV1 {
  return {
    legalName: 'Example Studio',
    addressLine1: 'Musterstrasse 1',
    addressLine2: null,
    postalCode: '10115',
    city: 'Berlin',
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
    ...overrides,
  };
}

function contact(overrides: Partial<RecipientContact> = {}): RecipientContact {
  return {
    id: '0190a000-0000-7000-8000-000000000001',
    kind: 'organization',
    name: 'Sample Customer GmbH',
    companyOrRole: '',
    legalForm: 'GmbH',
    addressLine1: 'Beispielweg 2',
    addressLine2: null,
    postalCode: '20095',
    city: 'Hamburg',
    country: 'DE',
    vatId: null,
    customerNumber: 7,
    archived: false,
    ...overrides,
  };
}

describe('snapshots', () => {
  it('sender block requires name, address and one tax id', () => {
    const sb = { taxStatus: 'small_business' as const, reverseCharge: false };
    expect(senderMissingFields(sender(), sb)).toEqual([]);
    expect(senderMissingFields(sender({ legalName: null }), sb)).toEqual(['legalName']);
    expect(senderMissingFields(sender({ addressLine1: '  ' }), sb)).toEqual(['addressLine1']);
    expect(senderMissingFields(sender({ postalCode: null }), sb)).toEqual(['postalCode']);
    expect(senderMissingFields(sender({ city: null }), sb)).toEqual(['city']);
    expect(senderMissingFields(sender({ countryCode: null }), sb)).toEqual(['countryCode']);
    expect(senderMissingFields(sender({ taxNumber: null }), sb)).toEqual(['taxNumber|vatId|smallBusinessId']);
    // Under Section 19 any one of the three identifies the issuer (section 34a UStDV).
    expect(senderMissingFields(sender({ taxNumber: null, vatId: 'DE123456789' }), sb)).toEqual([]);
    expect(senderMissingFields(sender({ taxNumber: null, smallBusinessId: 'DE123456789-00001' }), sb)).toEqual([]);
    expect(buildSenderSnapshot(sender())).toMatchObject({ v: 1, legalName: 'Example Studio' });
  });

  it('under regular taxation the small-business id alone is not enough', () => {
    const regular = { taxStatus: 'regular' as const, reverseCharge: false };
    expect(senderMissingFields(sender({ taxNumber: null, smallBusinessId: 'DE123456789-00001' }), regular)).toEqual([
      'taxNumber|vatId',
    ]);
    expect(senderMissingFields(sender(), regular)).toEqual([]);
    expect(senderMissingFields(sender({ taxNumber: null, vatId: 'DE123456789' }), regular)).toEqual([]);
  });

  it('a reverse-charge invoice needs the issuer\'s VAT id (section 14a UStG)', () => {
    const rc = { taxStatus: 'regular' as const, reverseCharge: true };
    expect(senderMissingFields(sender(), rc)).toEqual(['vatId']);
    expect(senderMissingFields(sender({ vatId: 'DE123456789' }), rc)).toEqual([]);
  });

  it('toJsonb refuses null and undefined', () => {
    expect(() => toJsonb(null)).toThrow(/no value/);
    expect(() => toJsonb(undefined)).toThrow(/no value/);
    expect(() => toJsonb({ v: 1 })).not.toThrow();
  });

  it('customer snapshot requires the section 34a recipient fields', () => {
    expect(recipientMissingFields(contact())).toEqual([]);
    expect(recipientMissingFields(contact({ addressLine1: null, city: '' }))).toEqual(['addressLine1', 'city']);
    expect(recipientMissingFields(contact({ postalCode: null, country: null }))).toEqual(['postalCode', 'country']);
    const snap = buildCustomerSnapshot(contact(), { customerType: 'b2b', vatId: 'DE123456789', taxNumber: null });
    expect(snap).toMatchObject({
      v: 1,
      name: 'Sample Customer GmbH',
      addressLine1: 'Beispielweg 2',
      customerType: 'b2b',
      vatId: 'DE123456789',
      customerNumber: 7,
    });
    // The parse is the backstop for a caller that skipped the check.
    expect(() => buildCustomerSnapshot(contact({ city: null }), { customerType: 'b2c', vatId: null, taxNumber: null })).toThrow();
  });
});
