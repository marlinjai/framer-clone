// The sender lookup on its own (sender.ts): which source wins, the field mapping, what makes a contact unusable,
// and which failure each case is. Synthetic data only. The real contacts database is books-sender.itest.ts.

import { describe, expect, it } from 'vitest';
import type { Contact, FieldDefinition } from '@marlinjai/contacts-core';

import { checkSender, resolveSender, SENDER_CUSTOM_FIELDS, type SenderDirectory, type SenderRecord } from '../sender';
import { syntheticSender } from './booksFixtures';

const TENANT = '0190a000-0000-7000-8000-00000000c0aa';
const CONTACT = '0190a000-0000-7000-8000-00000000c0bb';
/** The published test IBAN of the German banking associations, not an account of anyone. */
const IBAN = 'DE02120300000000202051';

function definitions(patch: Record<string, Partial<FieldDefinition>> = {}): FieldDefinition[] {
  return Object.values(SENDER_CUSTOM_FIELDS).map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    options: null,
    archived: false,
    createdAt: new Date(0),
    ...patch[f.key],
  }));
}

function record(contact: Partial<Contact> = {}, defs = definitions()): SenderRecord {
  return {
    definitions: defs,
    contact: {
      id: CONTACT,
      kind: 'organization',
      name: 'Contact Studio',
      addressLine1: 'Kontaktweg 3',
      addressLine2: null,
      postalCode: '50667',
      city: 'Köln',
      country: 'de',
      vatId: null,
      email: null,
      phone: null,
      archived: false,
      version: 4,
      customFields: { steuernummer: '99/999/99999', iban: IBAN, bic: 'BYLADEM1001', bankname: 'Beispielbank' },
      ...contact,
    } as Contact,
  };
}

const directory = (answer: SenderRecord | null | Error): SenderDirectory & { calls: number } => ({
  calls: 0,
  async getSender() {
    this.calls += 1;
    if (answer instanceof Error) throw answer;
    return answer;
  },
});

const stored = syntheticSender({ phone: '000', website: 'https://stored.example.invalid' });

describe('resolveSender', () => {
  it('without a pointer returns the stored block and never reads contacts', async () => {
    const dir = directory(new Error('must not be read'));
    const result = await resolveSender({ tenantId: TENANT, senders: dir }, { senderContactId: null, storedSenderBlock: stored });
    expect(result).toEqual({ block: stored, contact: null });
    expect(dir.calls).toBe(0);
  });

  it('with a pointer takes every field from the contact: an empty one is empty, never the stored value', async () => {
    const result = await resolveSender(
      { tenantId: TENANT, senders: directory(record()) },
      { senderContactId: CONTACT, storedSenderBlock: stored },
    );
    expect(result.contact).toEqual({ id: CONTACT, version: 4 });
    expect(result.block).toEqual({
      legalName: 'Contact Studio',
      addressLine1: 'Kontaktweg 3',
      addressLine2: null,
      postalCode: '50667',
      city: 'Köln',
      countryCode: 'DE',
      taxNumber: '99/999/99999',
      vatId: null,
      smallBusinessId: null,
      email: null,
      phone: null,
      website: null,
      bankName: 'Beispielbank',
      iban: IBAN,
      bic: 'BYLADEM1001',
      registerCourt: null,
      registerNumber: null,
      managingDirector: null,
    });
  });

  it.each([
    ['an outage', new Error('synthetic outage'), 'SENDER_UNAVAILABLE'],
    ['a contact the company does not have', null, 'SENDER_NOT_FOUND'],
    ['an archived contact', record({ archived: true }), 'SENDER_NOT_FOUND'],
    ['a person', record({ kind: 'person' }), 'SENDER_INVALID'],
  ])('refuses %s, without falling back', async (_case, answer, code) => {
    await expect(
      resolveSender({ tenantId: TENANT, senders: directory(answer) }, { senderContactId: CONTACT, storedSenderBlock: stored }),
    ).rejects.toMatchObject({ code });
  });
});

describe('the legal form', () => {
  it.each([
    ['a name without it', 'Contact Studio', 'GmbH', 'Contact Studio GmbH'],
    ['a name that already says it', 'Contact Studio GmbH', 'GmbH', 'Contact Studio GmbH'],
    ['no legal form recorded', 'Contact Studio', null, 'Contact Studio'],
  ])('is printed with the sender name: %s', (_case, name, legalForm, printed) => {
    expect(checkSender(record({ name, legalForm })).legalName).toBe(printed);
  });
});

describe('checkSender', () => {
  const problems = (r: SenderRecord): unknown => {
    try {
      checkSender(r);
    } catch (err) {
      return (err as { details?: { fields?: unknown } }).details?.fields;
    }
    return 'accepted';
  };

  it('refuses a mistyped IBAN, a malformed BIC and a country that is not a code, naming fields and no values', () => {
    const bad = record({ country: 'Deutschland', customFields: { iban: 'DE02120300000000202052', bic: 'NOPE' } });
    expect(problems(bad)).toEqual(['countryCode', 'iban', 'bic']);
    expect(() => checkSender(bad)).toThrow(/^SENDER_INVALID: check these fields of the sender contact: countryCode, iban, bic$/);
  });

  it('accepts a spaced IBAN and one from outside the payment code area, and no bank details at all', () => {
    expect(problems(record({ customFields: { iban: 'DE02 1203 0000 0000 2020 51' } }))).toBe('accepted');
    expect(problems(record({ customFields: { iban: 'BR1500000000000010932840814P2' } }))).toBe('accepted');
    expect(problems(record({ customFields: {} }))).toBe('accepted');
  });

  it('refuses an archived or differently typed definition of a sender field, by key', () => {
    const defs = definitions({ iban: { archived: true }, website: { type: 'text' } });
    expect(problems(record({}, defs))).toEqual(['field_archived:iban', 'field_type:website']);
    expect(() => checkSender(record({}, defs))).toThrow(/receipts app/);
  });

  it('ignores definitions that are not sender fields, and missing ones', () => {
    const other: FieldDefinition = { key: 'diet', label: 'Diet', type: 'number', options: null, archived: true, createdAt: new Date(0) };
    expect(problems(record({}, [other]))).toBe('accepted');
  });
});
