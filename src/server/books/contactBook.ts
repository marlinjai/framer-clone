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

import { contactIdentityKey, contactsFor, type ContactsDb } from '@marlinjai/contacts-core';

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

/** A person at a business, as the customer screen and the invoice picker list them: name and the role held there. */
export interface ContactPersonView {
  /** The affiliation (the person's open membership of the business). */
  affiliationId: string;
  /** The person's contact id. */
  contactId: string;
  name: string;
  /** The role at that business; '' when none was recorded. */
  role: string;
  /** 'YYYY-MM-DD' or null. */
  startedOn: string | null;
  /** The person's main business. */
  primary: boolean;
}

/** What a new contact person is made of: an existing person, or a new one (name only; no mail or phone is taken). */
export interface NewContactPersonInput {
  /** The business (an organization contact of the company) the person works for. */
  organizationContactId: string;
  /** An existing person of the company, or ... */
  personContactId?: string;
  /** ... a new person, created in the shared contacts database and affiliated in one step. */
  person?: { name: string };
  /** Their role at the business. */
  role?: string | null;
}

export interface ContactBook {
  /** Contacts of the company matching `search` (name, company or role, email), archived left out. */
  search(tenantId: string, opts: { search?: string; limit: number }): Promise<RecipientContact[]>;
  /** The given ids that exist for the company (archived included); others are absent. */
  getMany(tenantId: string, ids: readonly string[]): Promise<RecipientContact[]>;
  /** Create a contact for the company. */
  create(tenantId: string, input: NewContactInput): Promise<RecipientContact>;
  /**
   * The company's contact with the same identity (the package's duplicate key:
   * kind plus name, and for a person also company or role; case and repeated
   * whitespace do not count), archived included; null when there is none.
   */
  findSame(
    tenantId: string,
    identity: { kind: 'person' | 'organization'; name: string; companyOrRole?: string | null },
  ): Promise<RecipientContact | null>;
  /**
   * Every person contact of the company whose name is this one (case and
   * repeated whitespace ignored), whatever their company or role, archived
   * included (like findSame). Refuses with RECIPIENT_AMBIGUOUS rather than
   * return a cut list.
   */
  personsNamed(tenantId: string, name: string): Promise<RecipientContact[]>;
  /** The business's people with an open affiliation, archived persons left out, the primary and oldest first. */
  listContactPersons(tenantId: string, organizationContactId: string): Promise<ContactPersonView[]>;
  /**
   * Make a person a contact person of the business, in one step (creating the person when `person` is given).
   * BooksError: RECIPIENT_NOT_FOUND (the business or the person is not a contact of the company),
   * INVALID_INPUT (a kind or a field the package refuses), DUPLICATE_CONTACT (a new person whose name exists;
   * `existingContactId` names them), DUPLICATE_CONTACT_PERSON (already a contact person of this business).
   */
  addContactPerson(tenantId: string, input: NewContactPersonInput): Promise<ContactPersonView>;
  /**
   * End a person's affiliation with the business (the row stays as history in the contacts database).
   * RECIPIENT_NOT_FOUND when the affiliation is not one of this business's in this company. Ending an ended one is a no-op.
   * Resolves to the person's contact id, read from the affiliation itself, so it is known for an ended affiliation and
   * an archived person too (the caller's retry after a half-done leave still finds who left).
   */
  endContactPerson(tenantId: string, organizationContactId: string, affiliationId: string): Promise<string>;
}

/** How many contacts one name lookup reads at most; more hits than this cannot be told apart and are refused. */
export const NAME_LOOKUP_LIMIT = 1000;

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
const INPUT_CODES = new Set(['invalid_name', 'invalid_field', 'too_long', 'invalid_organization', 'invalid_affiliation']);

/**
 * A refusal of the package that is the caller's input (an invalid or too long
 * field) becomes INVALID_INPUT naming the field only; anything else means the
 * database could not be used (RECIPIENT_UNAVAILABLE).
 */
function inputOrUnavailable(err: unknown): BooksError {
  if (isBooksError(err)) return err;
  const code = errorCode(err);
  if (code && INPUT_CODES.has(code)) {
    const field = (err as { field?: unknown }).field;
    const path = typeof field === 'string' ? field : code === 'invalid_name' ? 'name' : '(contact)';
    return new BooksError('INVALID_INPUT', `INVALID_INPUT: ${path}`, {
      issues: [{ path: `contact.${path}`, message: code }],
    });
  }
  return unavailable(err);
}

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
    async findSame(tenantId, identity) {
      const db = await open();
      try {
        const found = await contactsFor(db, tenantId).findSame({
          kind: identity.kind,
          name: identity.name,
          companyOrRole: identity.companyOrRole ?? null,
        });
        return found ? toRecipientContact(found) : null;
      } catch (err) {
        throw inputOrUnavailable(err);
      }
    },
    async personsNamed(tenantId, name) {
      const db = await open();
      let rows;
      try {
        rows = await contactsFor(db, tenantId).list({ kind: 'person', includeArchived: true, search: name.trim().replace(/\s+/g, ' '), limit: NAME_LOOKUP_LIMIT });
      } catch (err) {
        throw inputOrUnavailable(err);
      }
      if (rows.length >= NAME_LOOKUP_LIMIT) {
        throw new BooksError('RECIPIENT_AMBIGUOUS', 'RECIPIENT_AMBIGUOUS: too many contacts match this name to tell them apart');
      }
      const key = contactIdentityKey('person', name, '');
      return rows.filter((c) => contactIdentityKey('person', c.name, '') === key).map(toRecipientContact);
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
        throw inputOrUnavailable(err);
      }
    },
    async listContactPersons(tenantId, organizationContactId) {
      const db = await open();
      try {
        const contacts = contactsFor(db, tenantId);
        const affiliations = await contacts.affiliationsAt(organizationContactId);
        const people = await contacts.getMany(affiliations.map((a) => a.personId));
        const byId = new Map(people.map((p) => [p.id, p]));
        return affiliations.flatMap((a) => {
          const person = byId.get(a.personId);
          if (!person || person.archived) return [];
          return [{ affiliationId: a.id, contactId: person.id, name: person.name, role: a.role, startedOn: a.startedOn, primary: a.primary }];
        });
      } catch (err) {
        throw unavailable(err);
      }
    },
    async addContactPerson(tenantId, input) {
      const db = await open();
      const contacts = contactsFor(db, tenantId);
      try {
        const organization = (await contacts.getMany([input.organizationContactId]))[0];
        if (!organization || organization.kind !== 'organization') {
          throw new BooksError('RECIPIENT_NOT_FOUND', 'RECIPIENT_NOT_FOUND: no such business for this company');
        }
        let person;
        if (input.personContactId !== undefined) {
          person = (await contacts.getMany([input.personContactId]))[0];
          if (!person || person.kind !== 'person') {
            throw new BooksError('RECIPIENT_NOT_FOUND', 'RECIPIENT_NOT_FOUND: no such person for this company');
          }
        } else if (input.person) {
          // The person stays in the contacts database when the affiliation then fails (a valid contact of the company).
          person = await contacts.create({ kind: 'person', name: input.person.name });
        } else {
          throw new BooksError('INVALID_INPUT', 'INVALID_INPUT: person', { issues: [{ path: 'person', message: 'name a person or give a new one' }] });
        }
        const a = await contacts.addAffiliation({ personId: person.id, organizationId: organization.id, role: input.role ?? '' });
        return { affiliationId: a.id, contactId: person.id, name: person.name, role: a.role, startedOn: a.startedOn, primary: a.primary };
      } catch (err) {
        if (isBooksError(err)) throw err;
        const code = errorCode(err);
        if (code === 'duplicate') {
          const existing = (err as { existing?: { id?: unknown } }).existing;
          throw new BooksError('DUPLICATE_CONTACT', 'DUPLICATE_CONTACT: a contact with this name already exists', {
            existingContactId: typeof existing?.id === 'string' ? existing.id : null,
          });
        }
        if (code === 'duplicate_affiliation') {
          throw new BooksError('DUPLICATE_CONTACT_PERSON', 'DUPLICATE_CONTACT_PERSON: this person already is a contact person of this customer');
        }
        throw inputOrUnavailable(err);
      }
    },
    async endContactPerson(tenantId, organizationContactId, affiliationId): Promise<string> {
      const db = await open();
      const contacts = contactsFor(db, tenantId);
      try {
        const a = await contacts.getAffiliation(affiliationId);
        if (!a || a.organizationId !== organizationContactId) {
          throw new BooksError('RECIPIENT_NOT_FOUND', 'RECIPIENT_NOT_FOUND: no such contact person for this customer');
        }
        await contacts.endAffiliation(affiliationId);
        return a.personId;
      } catch (err) {
        if (isBooksError(err)) throw err;
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
