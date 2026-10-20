// src/server/books/contactBook.ts
//
// The editor's view of the shared contacts database (Books plan P1.2, phase 2):
// the picker the customer form searches, the labels the customer and document
// lists show, and creating a new contact when the recipient is not in the
// database yet. The issue path never uses this module; it reads the recipient
// through the RecipientDirectory port (recipients.ts), which stays the single
// source of the frozen snapshot.
//
// A PORT again, so route tests substitute a fake; the production implementation
// adapts @marlinjai/contacts-core over the same lazily opened handle as the
// recipient directory. Every call is company-scoped by the auth-brain company id
// (`contactsFor(db, tenantId)`): another company's contact id behaves exactly
// like one that does not exist.
//
// Failures: an unset CONTACTS_DATABASE_URL or an unreachable database is
// BooksError('RECIPIENT_UNAVAILABLE') (a 503 at the routes, with the original
// error as `cause`, never swallowed); a duplicate identity is
// BooksError('DUPLICATE_CONTACT') carrying the existing contact's id only; any
// other refusal of the package (an invalid or too long field) is INVALID_INPUT
// with the field name only.

import { contactsFor, type ContactsDb } from '@marlinjai/contacts-core';

import { BooksError, isBooksError } from './errors';
import { contactsDb, toRecipientContact } from './recipients';
import type { RecipientContact } from './snapshots';

/** What the editor may send to create a contact (no custom fields from here). */
export interface NewContactInput {
  kind: 'person' | 'organization';
  name: string;
  companyOrRole?: string | null;
  legalForm?: string | null;
  email?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country?: string | null;
  vatId?: string | null;
}

export interface ContactBook {
  /** Contacts of the company matching `search` (name, company or role, email), archived left out. */
  search(tenantId: string, opts: { search?: string; limit: number }): Promise<RecipientContact[]>;
  /** The given ids that exist for the company (archived included); others are absent. */
  getMany(tenantId: string, ids: readonly string[]): Promise<RecipientContact[]>;
  /** Create a contact for the company. */
  create(tenantId: string, input: NewContactInput): Promise<RecipientContact>;
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function unavailable(err: unknown): BooksError {
  return new BooksError(
    'RECIPIENT_UNAVAILABLE',
    'RECIPIENT_UNAVAILABLE: the contacts database could not be read',
    undefined,
    { cause: err },
  );
}

/** The package refusals a create can produce that are the caller's input, mapped by field name only. */
const INPUT_CODES = new Set(['invalid_name', 'invalid_field', 'too_long', 'invalid_organization']);

/** The production contact book over a contacts handle (defaults to the shared one). */
export function contactsContactBook(handle: () => ContactsDb = contactsDb): ContactBook {
  async function open(): Promise<ContactsDb> {
    try {
      const db = handle();
      await db.ready();
      return db;
    } catch (err) {
      throw unavailable(err);
    }
  }
  return {
    async search(tenantId, opts) {
      const db = await open();
      try {
        const rows = await contactsFor(db, tenantId).list({
          search: opts.search && opts.search.trim() !== '' ? opts.search.trim() : undefined,
          limit: opts.limit,
        });
        return rows.map(toRecipientContact);
      } catch (err) {
        throw unavailable(err);
      }
    },
    async getMany(tenantId, ids) {
      if (ids.length === 0) return [];
      const db = await open();
      try {
        const rows = await contactsFor(db, tenantId).getMany(ids);
        return rows.map(toRecipientContact);
      } catch (err) {
        throw unavailable(err);
      }
    },
    async create(tenantId, input) {
      const db = await open();
      try {
        const created = await contactsFor(db, tenantId).create({
          kind: input.kind,
          name: input.name,
          companyOrRole: input.companyOrRole ?? null,
          legalForm: input.legalForm ?? null,
          email: input.email ?? null,
          addressLine1: input.addressLine1 ?? null,
          addressLine2: input.addressLine2 ?? null,
          postalCode: input.postalCode ?? null,
          city: input.city ?? null,
          country: input.country ?? null,
          vatId: input.vatId ?? null,
        });
        return toRecipientContact(created);
      } catch (err) {
        if (isBooksError(err)) throw err;
        const code = errorCode(err);
        if (code === 'duplicate') {
          const existing = (err as { existing?: { id?: unknown } }).existing;
          throw new BooksError('DUPLICATE_CONTACT', 'DUPLICATE_CONTACT: a contact with this name already exists', {
            existingContactId: typeof existing?.id === 'string' ? existing.id : null,
          });
        }
        if (code && INPUT_CODES.has(code)) {
          const field = (err as { field?: unknown }).field;
          const path = typeof field === 'string' ? field : code === 'invalid_name' ? 'name' : '(contact)';
          throw new BooksError('INVALID_INPUT', `INVALID_INPUT: ${path}`, {
            issues: [{ path: `contact.${path}`, message: code }],
          });
        }
        throw unavailable(err);
      }
    },
  };
}

let defaultBook: ContactBook | undefined;

/** The contact book the routes use (the shared contacts database). */
export function defaultContactBook(): ContactBook {
  defaultBook ??= contactsContactBook();
  return defaultBook;
}
