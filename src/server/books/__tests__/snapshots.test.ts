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
    expect(senderMissingFields(sender())).toEqual([]);
    expect(senderMissingFields(sender({ legalName: null }))).toEqual(['legalName']);
    expect(senderMissingFields(sender({ addressLine1: '  ' }))).toEqual(['addressLine1']);
    expect(senderMissingFields(sender({ postalCode: null }))).toEqual(['postalCode']);
    expect(senderMissingFields(sender({ city: null }))).toEqual(['city']);
    expect(senderMissingFields(sender({ countryCode: null }))).toEqual(['countryCode']);
    expect(senderMissingFields(sender({ taxNumber: null }))).toEqual(['taxNumber|vatId|smallBusinessId']);
    // Any one of the three tax ids is enough.
    expect(senderMissingFields(sender({ taxNumber: null, vatId: 'DE123456789' }))).toEqual([]);
    expect(senderMissingFields(sender({ taxNumber: null, smallBusinessId: 'SB-1' }))).toEqual([]);
    expect(buildSenderSnapshot(sender())).toMatchObject({ v: 1, legalName: 'Example Studio' });
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
