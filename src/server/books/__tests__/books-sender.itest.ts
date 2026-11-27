// The sender lookup against the REAL @marlinjai/contacts-core on its own Postgres, as books-contacts.itest.ts does
// for recipients: the field mapping holds on stored rows, another company's contact is not found, and the ways a
// contact stops being usable (archived, erased, a field definition archived, the server gone) each refuse.
// Synthetic data only.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import postgres from 'postgres';
import { contactsFor, createContactsDb, migrate, type ContactsDb } from '@marlinjai/contacts-core';

import { contactsSenderDirectory, resolveSender, SENDER_CUSTOM_FIELDS, type SenderDirectory } from '../sender';
import { newTenantId, syntheticSender } from './booksFixtures';

let container: StartedTestContainer | undefined;
let contacts: ContactsDb | undefined;
let senders: SenderDirectory;

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'postgres', POSTGRES_DB: 'contacts', POSTGRES_HOST_AUTH_METHOD: 'trust' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const url = `postgresql://postgres@${container.getHost()}:${container.getMappedPort(5432)}/contacts`;
  const owner = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(owner);
  } finally {
    await owner.end();
  }
  contacts = createContactsDb(url, { applicationName: 'books-sender-test', connectTimeoutSeconds: 2 });
  const handle = contacts;
  senders = contactsSenderDirectory(() => handle);
}, 180_000);

afterAll(async () => {
  await contacts?.sql.end({ timeout: 1 });
  await container?.stop();
});

async function linkedCompany() {
  const tenantId = newTenantId();
  const book = contactsFor(contacts!, tenantId);
  for (const field of Object.values(SENDER_CUSTOM_FIELDS)) await book.createField({ ...field });
  const contact = await book.create({
    kind: 'organization',
    name: 'Example Studio',
    addressLine1: 'Musterstrasse 1',
    postalCode: '10115',
    city: 'Berlin',
    country: 'DE',
    customFields: { steuernummer: '12/345/67890', iban: 'DE02120300000000202051', website: 'https://example.invalid' },
  });
  const source = { senderContactId: contact.id, storedSenderBlock: syntheticSender() };
  const resolve = (as = tenantId) => resolveSender({ tenantId: as, senders }, source);
  return { tenantId, book, contact, resolve };
}

describe('the sender from the real contacts database', () => {
  it('reads fixed and custom fields, with the contact version', async () => {
    const { contact, resolve } = await linkedCompany();
    const result = await resolve();
    expect(result.contact).toEqual({ id: contact.id, version: contact.version });
    expect(result.block).toMatchObject({
      legalName: 'Example Studio',
      city: 'Berlin',
      taxNumber: '12/345/67890',
      iban: 'DE02120300000000202051',
      website: 'https://example.invalid',
      email: null,
      bankName: null,
    });
  });

  it("another company's contact id reads as not found", async () => {
    const { resolve } = await linkedCompany();
    await expect(resolve(newTenantId())).rejects.toMatchObject({ code: 'SENDER_NOT_FOUND' });
  });

  it('refuses after an archive and works again after the restore', async () => {
    const { book, contact, resolve } = await linkedCompany();
    await book.archive(contact.id);
    await expect(resolve()).rejects.toMatchObject({ code: 'SENDER_NOT_FOUND' });
    await book.restore(contact.id);
    await expect(resolve()).resolves.toMatchObject({ block: { legalName: 'Example Studio' } });
  });

  it('refuses while a sender field definition is archived', async () => {
    const { book, resolve } = await linkedCompany();
    await book.archiveField('iban');
    await expect(resolve()).rejects.toMatchObject({ code: 'SENDER_INVALID', details: { problems: ['field_archived:iban'] } });
  });

  it('an erased sender is not found; a merged away one too', async () => {
    const erased = await linkedCompany();
    await erased.book.erase(erased.contact.id);
    await expect(erased.resolve()).rejects.toMatchObject({ code: 'SENDER_NOT_FOUND' });
    const merged = await linkedCompany();
    const winner = await merged.book.create({ kind: 'organization', name: 'Other Studio' });
    await merged.book.merge(merged.contact.id, winner.id);
    await expect(merged.resolve()).rejects.toMatchObject({ code: 'SENDER_NOT_FOUND' });
  });

  // Last: it stops the server.
  it('a contacts outage is SENDER_UNAVAILABLE', async () => {
    const { resolve } = await linkedCompany();
    await container!.stop();
    container = undefined;
    await expect(resolve()).rejects.toMatchObject({ code: 'SENDER_UNAVAILABLE' });
  }, 60_000);
});
