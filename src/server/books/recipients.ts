// src/server/books/recipients.ts
//
// Where a recipient's name and address come from (Books plan P1.2): the shared
// contacts database of the suite, opened through the published package
// @marlinjai/contacts-core (one PostgreSQL instance, company-scoped by the
// auth-brain company id, no cross-database transactions). A `customer` row only
// holds the tax fields and the contact's id.
//
// The Books domain talks to a PORT, RecipientDirectory, so tests substitute a
// fake; the production implementation below adapts the package. A contact that
// does not exist for the company (unknown or another company's id) reads as
// null; every thrown error becomes BooksError('RECIPIENT_UNAVAILABLE') with the
// original as `cause` (never swallowed). The handle is opened lazily on first
// use, so importing this module needs no database and `next build` stays clean.

import { contactsFor, createContactsDb, type Contact, type ContactsDb } from '@marlinjai/contacts-core';

import { BooksError, isBooksError } from './errors';
import type { RecipientContact } from './snapshots';

export type { RecipientContact } from './snapshots';

export interface RecipientDirectory {
  /** The company's contact, or null when it does not exist for that company. Throws on connection failure. */
  getContact(tenantId: string, contactId: string): Promise<RecipientContact | null>;
}

/** Thrown when CONTACTS_DATABASE_URL is not set (surfaced as RECIPIENT_UNAVAILABLE). */
export class ContactsNotConfiguredError extends Error {
  constructor() {
    super(
      'CONTACTS_DATABASE_URL is not set. The Books read recipients (name and address) from the ' +
        "shared contacts database; set the variable in the app's environment (Infisical).",
    );
    this.name = 'ContactsNotConfiguredError';
  }
}

const globalForContacts = globalThis as unknown as { __framerCloneBooksContactsDb?: ContactsDb };

/** The process-wide contacts handle, opened on first call and cached on globalThis (HMR-safe). */
export function contactsDb(): ContactsDb {
  if (!globalForContacts.__framerCloneBooksContactsDb) {
    const url = process.env.CONTACTS_DATABASE_URL;
    if (!url) throw new ContactsNotConfiguredError();
    globalForContacts.__framerCloneBooksContactsDb = createContactsDb(url, { applicationName: 'books' });
  }
  return globalForContacts.__framerCloneBooksContactsDb;
}

/** Map the package's Contact to the port's shape (only what an invoice needs). */
export function toRecipientContact(contact: Contact): RecipientContact {
  return {
    id: contact.id,
    kind: contact.kind,
    name: contact.name,
    companyOrRole: contact.companyOrRole,
    legalForm: contact.legalForm,
    addressLine1: contact.addressLine1,
    addressLine2: contact.addressLine2,
    postalCode: contact.postalCode,
    city: contact.city,
    country: contact.country,
    vatId: contact.vatId,
    customerNumber: contact.customerNumber,
    archived: contact.archived,
  };
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'not_found';
}

/** The production directory over a contacts handle (defaults to {@link contactsDb}). */
export function contactsRecipientDirectory(handle: () => ContactsDb = contactsDb): RecipientDirectory {
  return {
    async getContact(tenantId, contactId) {
      try {
        const db = handle();
        await db.ready();
        const contact = await contactsFor(db, tenantId).get(contactId);
        return contact ? toRecipientContact(contact) : null;
      } catch (err) {
        if (isNotFound(err)) return null;
        throw new BooksError(
          'RECIPIENT_UNAVAILABLE',
          'RECIPIENT_UNAVAILABLE: the contacts database could not be read',
          undefined,
          { cause: err },
        );
      }
    },
  };
}

let defaultDirectory: RecipientDirectory | undefined;

/** The directory a scope uses: its own, or the shared contacts database. */
export function directoryFor(scope: { recipients?: RecipientDirectory }): RecipientDirectory {
  if (scope.recipients) return scope.recipients;
  defaultDirectory ??= contactsRecipientDirectory();
  return defaultDirectory;
}

/**
 * Read one contact through the scope's directory. null when it does not exist
 * for the company; any failure (a fake that throws, a connection error) is
 * RECIPIENT_UNAVAILABLE. Never called inside a Books transaction: a network read
 * must not hold the document and counter locks.
 */
export async function readRecipient(
  scope: { tenantId: string; recipients?: RecipientDirectory },
  contactId: string,
): Promise<RecipientContact | null> {
  try {
    return await directoryFor(scope).getContact(scope.tenantId, contactId);
  } catch (err) {
    if (isBooksError(err, 'RECIPIENT_UNAVAILABLE')) throw err;
    throw new BooksError(
      'RECIPIENT_UNAVAILABLE',
      'RECIPIENT_UNAVAILABLE: the contacts database could not be read',
      undefined,
      { cause: err },
    );
  }
}
