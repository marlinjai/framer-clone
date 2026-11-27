// src/server/books/senderLink.ts
//
// Linking a company's sender to its business contact, and unlinking it again
// (docs/plans/2026-11-26-books-sender-from-contacts.md). Run by an operator through `pnpm books:init-company
// --sender-contact <id>` and `--unlink`; there is no route and no button.
//
// Both compare the two sources first ("parity") and refuse to switch while a field would print differently, unless
// the operator says the difference is meant (`--accept-differences`). `--dry-run` writes nothing, in either
// database. Everything reported is field names and keys, never a value.
//
// No `server-only`: the operator script runs this under tsx.

import { parseArgs } from 'node:util';

import { contactsFor, createContactsDb, type ContactsDb } from '@marlinjai/contacts-core';
import { tenantDb } from '@marlinjai/tenant-db';
import { createNodeDb } from '@marlinjai/tenant-db/node';

import type { CommerceDB } from '../commerce/db-types';
import { BooksError, isBooksError, withDbErrors } from './errors';
import { booksScope, type BooksScope } from './scope';
import { checkSender, contactsSenderDirectory, resolveSender, SENDER_CUSTOM_FIELDS, unusableSenderFields } from './sender';
import { requireSettings } from './settings';
import { senderBlockV1Schema, senderMissingFields, type SenderBlockV1 } from './snapshots';

const SENDER_FIELDS = Object.keys(senderBlockV1Schema.shape) as Array<keyof SenderBlockV1>;

/** The sender fields that would print differently (compared as printed: surrounding space and emptiness ignored). */
export function senderDifferences(a: SenderBlockV1, b: SenderBlockV1): Array<keyof SenderBlockV1> {
  const printed = (v: string | null) => v?.trim() || null;
  return SENDER_FIELDS.filter((f) => printed(a[f]) !== printed(b[f]));
}

export interface LinkOptions {
  dryRun?: boolean;
  acceptDifferences?: boolean;
}

export interface LinkResult {
  /** Fields that print differently from the contact than from the stored block. */
  differences: string[];
  /** Custom field keys that were missing and have been created (on a dry run: would be created). */
  definitions: string[];
  /** Whether the pointer was written. */
  changed: boolean;
}

async function writePointer(scope: BooksScope, from: string | null, to: string | null): Promise<void> {
  await withDbErrors(async () => {
    let update = scope.db
      .updateTable('books_company_settings')
      .set({ sender_contact_id: to, updated_at: new Date() })
      .where('tenant_id', '=', scope.tenantId);
    // Only from the state that was compared: another operator's change in between is not overwritten.
    update = from === null ? update.where('sender_contact_id', 'is', null) : update.where('sender_contact_id', '=', from);
    const result = await update.executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) {
      throw new BooksError('CONCURRENT_EDIT', 'CONCURRENT_EDIT: the sender link changed during this step; run it again');
    }
  });
}

/** Link the company's sender to an organization of its contacts, or relink it to another one. */
export async function linkSenderContact(
  scope: BooksScope,
  contacts: ContactsDb,
  contactId: string,
  options: LinkOptions = {},
): Promise<LinkResult> {
  const settings = await requireSettings(scope.db, scope);
  await contacts.ready();
  const book = contactsFor(contacts, scope.tenantId);
  let definitions = await book.listFields({ includeArchived: true });
  const unusable = unusableSenderFields(definitions);
  if (unusable.length > 0) {
    const fields = unusable.map((u) => `${u.why === 'archived' ? 'field_archived' : 'field_type'}:${u.key}`);
    throw new BooksError('SENDER_INVALID', `SENDER_INVALID: these contact fields are taken: ${fields.join(', ')}`, { fields });
  }
  const contact = await book.get(contactId);
  if (!contact) {
    throw new BooksError('SENDER_NOT_FOUND', 'SENDER_NOT_FOUND: no such contact for this company', { contactId });
  }

  const missing = Object.values(SENDER_CUSTOM_FIELDS).filter((f) => !definitions.some((d) => d.key === f.key));
  // Created before the contact is judged: without the definitions nobody could fill the fields it may be lacking.
  // Additive and unused until a value is entered.
  if (!options.dryRun) {
    for (const field of missing) await book.createField({ ...field });
    if (missing.length > 0) definitions = await book.listFields({ includeArchived: true });
  }

  const block = checkSender({ contact, definitions });
  const lacking = senderMissingFields(block, { taxStatus: settings.taxStatus, reverseCharge: false });
  if (lacking.length > 0) {
    throw new BooksError('SENDER_INCOMPLETE', `SENDER_INCOMPLETE: ${lacking.join(', ')}`, { missing: lacking });
  }
  const current =
    settings.senderContactId === null
      ? settings.storedSenderBlock
      : // Relinking: compare with what prints now, or with the stored block when the old contact cannot be read.
        await resolveSender({ tenantId: scope.tenantId, senders: contactsSenderDirectory(() => contacts) }, settings)
          .then((r) => r.block)
          .catch((err: unknown) => {
            if (isBooksError(err, 'SENDER_NOT_FOUND') || isBooksError(err, 'SENDER_INVALID')) return settings.storedSenderBlock;
            throw err;
          });
  const result: LinkResult = {
    differences: senderDifferences(current, block),
    definitions: missing.map((f) => f.key),
    changed: false,
  };
  if (options.dryRun || settings.senderContactId === contact.id) return result;
  if (result.differences.length > 0 && !options.acceptDifferences) {
    throw new BooksError(
      'SENDER_INVALID',
      `SENDER_INVALID: nothing was linked, these fields would print differently: ${result.differences.join(', ')} (correct the contact, or pass --accept-differences)`,
      { fields: result.differences },
    );
  }
  await writePointer(scope, settings.senderContactId, contact.id);
  return { ...result, changed: true };
}

/** Back to the stored sender block. It was frozen while linked, so it may be out of date: compared first. */
export async function unlinkSenderContact(
  scope: BooksScope,
  contacts: ContactsDb,
  options: LinkOptions = {},
): Promise<LinkResult> {
  const settings = await requireSettings(scope.db, scope);
  const result: LinkResult = { differences: [], definitions: [], changed: false };
  if (settings.senderContactId === null) return result;
  let comparable = true;
  try {
    const now = await resolveSender({ tenantId: scope.tenantId, senders: contactsSenderDirectory(() => contacts) }, settings);
    result.differences = senderDifferences(now.block, settings.storedSenderBlock);
  } catch (err) {
    if (!isBooksError(err)) throw err;
    comparable = false;
  }
  if (options.dryRun) {
    if (!comparable) result.differences = ['(the linked contact cannot be read, so nothing can be compared)'];
    return result;
  }
  if ((!comparable || result.differences.length > 0) && !options.acceptDifferences) {
    const why = comparable
      ? `these fields of the stored block differ from what prints now: ${result.differences.join(', ')} (update the stored block with --sender first)`
      : 'the linked contact cannot be read, so the stored block cannot be compared with it';
    throw new BooksError('SENDER_INVALID', `SENDER_INVALID: nothing was unlinked, ${why}, or pass --accept-differences`, {
      fields: result.differences,
    });
  }
  await writePointer(scope, settings.senderContactId, null);
  return { ...result, changed: true };
}

/** Whether argv asks for a link step rather than an initialisation. */
export function isSenderLinkRun(argv: string[]): boolean {
  return argv.some((a) => a === '--unlink' || a === '--sender-contact' || a.startsWith('--sender-contact='));
}

export async function runBooksSenderLink(
  argv: string[],
  env: Record<string, string | undefined>,
  log: (line: string) => void,
): Promise<LinkResult> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'tenant-group': { type: 'string' },
      tenant: { type: 'string' },
      'sender-contact': { type: 'string' },
      unlink: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'accept-differences': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const need = (value: string | undefined, what: string): string => {
    if (!value) throw new Error(`books:init-company: ${what} is required`);
    return value;
  };
  const tenantGroupId = need(values['tenant-group'], '--tenant-group');
  const tenantId = need(values.tenant, '--tenant');
  const contactId = values['sender-contact'];
  if (values.unlink === (contactId !== undefined)) {
    throw new Error('books:init-company: pass either --sender-contact <contact id> or --unlink');
  }
  const connectionString = need(env.COMMERCE_APP_DATABASE_URL, 'COMMERCE_APP_DATABASE_URL');
  const contactsUrl = need(env.CONTACTS_DATABASE_URL, 'CONTACTS_DATABASE_URL');
  const options = { dryRun: values['dry-run'], acceptDifferences: values['accept-differences'] };

  const base = createNodeDb<CommerceDB>({ connectionString, max: 1 });
  const contacts = createContactsDb(contactsUrl, { applicationName: 'books-sender-link' });
  try {
    const scope = booksScope(tenantDb(base, tenantGroupId), tenantGroupId, tenantId);
    const result = values.unlink
      ? await unlinkSenderContact(scope, contacts, options)
      : await linkSenderContact(scope, contacts, contactId!, options);
    log(options.dryRun ? 'dry run: nothing was written' : result.changed ? (values.unlink ? 'unlinked' : 'linked') : 'unchanged');
    if (result.definitions.length > 0) {
      log(`contact fields ${options.dryRun ? 'that would be created' : 'created'}: ${result.definitions.join(', ')}`);
    }
    log(`fields that differ: ${result.differences.length > 0 ? result.differences.join(', ') : 'none'}`);
    if (!values.unlink) {
      log(
        'note: while linked, whoever may edit this contact decides what invoices print. A company with more than one user, or a client company, needs the bank change confirmation first (the plan, option A).',
      );
    }
    return result;
  } finally {
    await contacts.sql.end({ timeout: 5 });
    await base.destroy();
  }
}
