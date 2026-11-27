// src/server/books/sender.ts
//
// Who a company issues its documents as (docs/plans/2026-11-26-books-sender-from-contacts.md). A company's Books
// settings either carry the sender themselves (`sender_block`, the way it always was) or point at one organization
// in the shared contacts database (`sender_contact_id`). ONE source per company, never per field: with a pointer,
// every sender field comes from that contact and an empty one is empty. There is no fallback to the stored block,
// for any reason: a document with an out of date bank account is worse than a refused one.
//
// The Books talk to a PORT, SenderDirectory, as for recipients (recipients.ts). The contact is read through
// `contactsFor(handle, scope.tenantId)`, so another company's contact id reads as not found.
//
// Errors carry field names and ids, never a value:
//   SENDER_UNAVAILABLE  the contacts database could not be read (retry)
//   SENDER_NOT_FOUND    erased, merged away, moved to another company or archived
//   SENDER_INVALID      the contact, or one of the custom fields the sender is read from, cannot be used
//
// No `server-only`: the operator script runs this under tsx.

import { contactsFor, type Contact, type ContactsDb, type FieldDefinition, type FieldType } from '@marlinjai/contacts-core';

import { BooksError, isBooksError } from './errors';
import { contactsDb } from './recipients';
import { isValidIban, looksLikeBic } from './render/epcQr';
import { senderBlockV1Schema, type SenderBlockV1 } from './snapshots';

type SenderField = keyof SenderBlockV1;

/** The sender fields that are a contact's own columns. */
const FIXED_FIELDS = {
  legalName: 'name',
  addressLine1: 'addressLine1',
  addressLine2: 'addressLine2',
  postalCode: 'postalCode',
  city: 'city',
  countryCode: 'country',
  vatId: 'vatId',
  email: 'email',
  phone: 'phone',
} as const satisfies Partial<Record<SenderField, keyof Contact>>;

/**
 * The sender fields held as custom fields of the company's contacts. The keys are a contract: renaming one here
 * empties that field on every document of every linked company.
 */
export const SENDER_CUSTOM_FIELDS = {
  taxNumber: { key: 'steuernummer', label: 'Steuernummer', type: 'text' },
  iban: { key: 'iban', label: 'IBAN', type: 'text' },
  bic: { key: 'bic', label: 'BIC', type: 'text' },
  bankName: { key: 'bankname', label: 'Bankname', type: 'text' },
  website: { key: 'website', label: 'Website', type: 'url' },
  registerCourt: { key: 'registergericht', label: 'Registergericht', type: 'text' },
  registerNumber: { key: 'registernummer', label: 'Registernummer', type: 'text' },
  managingDirector: { key: 'geschaeftsfuehrung', label: 'Geschäftsführung', type: 'text' },
  smallBusinessId: { key: 'kleinunternehmer_id', label: 'Kleinunternehmer-Identifikationsnummer', type: 'text' },
} as const satisfies Partial<Record<SenderField, { key: string; label: string; type: FieldType }>>;

const CUSTOM_ENTRIES = Object.entries(SENDER_CUSTOM_FIELDS) as Array<
  [keyof typeof SENDER_CUSTOM_FIELDS, { key: string; label: string; type: FieldType }]
>;

/** What the directory returns: the contact and the company's field definitions, archived ones included. */
export interface SenderRecord {
  contact: Contact;
  definitions: FieldDefinition[];
}

export interface SenderDirectory {
  /** null when the contact does not exist for that company. Throws on connection failure. */
  getSender(tenantId: string, contactId: string): Promise<SenderRecord | null>;
}

export function contactsSenderDirectory(handle: () => ContactsDb = contactsDb): SenderDirectory {
  return {
    async getSender(tenantId, contactId) {
      const db = handle();
      await db.ready();
      const contacts = contactsFor(db, tenantId);
      let contact: Contact | null;
      try {
        contact = await contacts.get(contactId);
      } catch (err) {
        if ((err as { code?: unknown } | null)?.code === 'not_found') return null;
        throw err;
      }
      if (!contact) return null;
      return { contact, definitions: await contacts.listFields({ includeArchived: true }) };
    },
  };
}

let defaultDirectory: SenderDirectory | undefined;

export function senderDirectoryFor(scope: { senders?: SenderDirectory }): SenderDirectory {
  if (scope.senders) return scope.senders;
  defaultDirectory ??= contactsSenderDirectory();
  return defaultDirectory;
}

const clean = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/** The keys among the sender's custom fields whose definition exists but cannot be used (archived, other type). */
export function unusableSenderFields(definitions: readonly FieldDefinition[]): Array<{ key: string; why: 'archived' | 'type' }> {
  const byKey = new Map(definitions.map((d) => [d.key, d]));
  const unusable: Array<{ key: string; why: 'archived' | 'type' }> = [];
  for (const [, field] of CUSTOM_ENTRIES) {
    const def = byKey.get(field.key);
    if (!def) continue;
    if (def.type !== field.type) unusable.push({ key: field.key, why: 'type' });
    else if (def.archived) unusable.push({ key: field.key, why: 'archived' });
  }
  return unusable;
}

/** The sender block a contact stands for. No validation: {@link checkSender} is that. */
export function senderBlockFromContact(contact: Contact): SenderBlockV1 {
  const block: Record<string, string | null> = {};
  for (const [field, column] of Object.entries(FIXED_FIELDS)) block[field] = clean(contact[column]);
  for (const [field, custom] of CUSTOM_ENTRIES) block[field] = clean(contact.customFields[custom.key]);
  block.countryCode = block.countryCode?.toUpperCase() ?? null;
  return senderBlockV1Schema.parse(block);
}

function invalidSender(problems: string[], message: string): BooksError {
  // `fields`, the detail the client lists beside its message (lib/books/api.ts).
  return new BooksError('SENDER_INVALID', `SENDER_INVALID: ${message}`, { fields: problems });
}

/**
 * Everything a linked contact must satisfy before anything is printed from it. Custom text accepts anything, so
 * the bank details are checked here: a mistyped IBAN would otherwise be printed and only lose its payment code.
 */
export function checkSender(record: SenderRecord): SenderBlockV1 {
  const { contact, definitions } = record;
  if (contact.archived) {
    throw new BooksError('SENDER_NOT_FOUND', 'SENDER_NOT_FOUND: the sender contact is archived', {
      contactId: contact.id,
      archived: true,
    });
  }
  if (contact.kind !== 'organization') throw invalidSender(['kind'], 'the sender contact is not an organization');
  const unusable = unusableSenderFields(definitions);
  if (unusable.length > 0) {
    const problems = unusable.map((u) => `${u.why === 'archived' ? 'field_archived' : 'field_type'}:${u.key}`);
    throw invalidSender(
      problems,
      `${problems.join(', ')} (restore an archived field on the contact fields screen of the receipts app)`,
    );
  }
  const block = senderBlockFromContact(contact);
  const problems: string[] = [];
  if (block.countryCode !== null && !/^[A-Z]{2}$/.test(block.countryCode)) problems.push('countryCode');
  if (block.iban !== null && !isValidIban(block.iban)) problems.push('iban');
  if (block.bic !== null && !looksLikeBic(block.bic)) problems.push('bic');
  if (problems.length > 0) throw invalidSender(problems, `check these fields of the sender contact: ${problems.join(', ')}`);
  return block;
}

export interface ResolvedSender {
  block: SenderBlockV1;
  /** The contact the block was read from, or null when it is the stored one. */
  contact: { id: string; version: number } | null;
}

/** What {@link resolveSender} needs of a company's settings. */
export interface SenderSource {
  senderContactId: string | null;
  storedSenderBlock: SenderBlockV1;
}

/**
 * The company's sender as it reads now. The one place that decides between the stored block and the contact.
 * A network read when linked: never call it inside a Books transaction.
 */
export async function resolveSender(
  scope: { tenantId: string; senders?: SenderDirectory },
  source: SenderSource,
): Promise<ResolvedSender> {
  const contactId = source.senderContactId;
  if (contactId === null) return { block: source.storedSenderBlock, contact: null };
  let record: SenderRecord | null;
  try {
    record = await senderDirectoryFor(scope).getSender(scope.tenantId, contactId);
  } catch (err) {
    if (isBooksError(err, 'SENDER_UNAVAILABLE')) throw err;
    throw new BooksError(
      'SENDER_UNAVAILABLE',
      'SENDER_UNAVAILABLE: the contacts database could not be read',
      undefined,
      { cause: err },
    );
  }
  if (!record) {
    throw new BooksError('SENDER_NOT_FOUND', 'SENDER_NOT_FOUND: the sender contact no longer exists for this company', {
      contactId,
    });
  }
  return { block: checkSender(record), contact: { id: record.contact.id, version: record.contact.version } };
}

/**
 * The sender to print under the Books transaction's own settings row. `resolved` was read before the transaction
 * (a network read must not hold the document and counter locks): if the company's source changed in between it is
 * CONCURRENT_EDIT. Unlinked, the block is the one the transaction sees.
 */
export function senderUnderTransaction(resolved: ResolvedSender, locked: SenderSource): ResolvedSender {
  if ((resolved.contact?.id ?? null) !== locked.senderContactId) {
    throw new BooksError('CONCURRENT_EDIT', 'CONCURRENT_EDIT: the sender contact was changed during this step');
  }
  return resolved.contact ? resolved : { block: locked.storedSenderBlock, contact: null };
}

/** What an `issued` event records about the sender: ids and the version read, never a value. */
export function senderEventPayload(sender: ResolvedSender): { senderContactId?: string; senderContactVersion?: number } {
  return sender.contact ? { senderContactId: sender.contact.id, senderContactVersion: sender.contact.version } : {};
}
