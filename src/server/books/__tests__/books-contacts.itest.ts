// src/server/books/__tests__/books-contacts.itest.ts
//
// Books plan P1.10: the REAL @marlinjai/contacts-core package against a second
// Postgres container (schema parity over the mocked boundary): the production
// RecipientDirectory reads name and address from a migrated contacts database,
// scoped by company. TRUST auth, no password literals; synthetic contacts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import postgres from 'postgres';
import { contactsFor, createContactsDb, migrate, type ContactsDb } from '@marlinjai/contacts-core';

import { createCustomer } from '../repository/customers';
import { createDraft } from '../repository/documents';
import { addLine } from '../repository/lines';
import { getDocument } from '../repository/read';
import { contactsRecipientDirectory, type RecipientDirectory } from '../recipients';
import { issue } from '../issue';
import { ACTOR, initCompany, newTenantId, openBooksEnv, scopeFor, type BooksEnv } from './booksFixtures';

let env: BooksEnv;
let container: StartedTestContainer | undefined;
let contacts: ContactsDb | undefined;
let directory: RecipientDirectory;

beforeAll(async () => {
  env = await openBooksEnv('books-contacts');
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
  contacts = createContactsDb(url, { applicationName: 'books-test', connectTimeoutSeconds: 2 });
  const handle = contacts;
  directory = contactsRecipientDirectory(() => handle);
}, 180_000);

afterAll(async () => {
  // The last case stops the contacts server; a graceful close would wait for it.
  await contacts?.sql.end({ timeout: 1 });
  await container?.stop();
  await env?.close();
});

async function companyWith(dir: RecipientDirectory) {
  const scope = scopeFor(env.appDb, env.tgId, newTenantId(), dir);
  await initCompany(scope);
  return scope;
}

function organization(name: string) {
  return {
    kind: 'organization' as const,
    name,
    legalForm: 'GmbH',
    addressLine1: 'Beispielweg 2',
    postalCode: '20095',
    city: 'Hamburg',
    country: 'DE',
    vatId: 'DE123456789',
  };
}

describe('Books with the real contacts database', () => {
  it('createCustomer and issue read name and address from the real contacts database', async () => {
    const scope = await companyWith(directory);
    const contact = await contactsFor(contacts!, scope.tenantId).create(organization('Sample Customer GmbH'));
    const numbered = await contactsFor(contacts!, scope.tenantId).assignCustomerNumber(contact.id);

    const customer = await createCustomer(scope, { contactId: contact.id, customerType: 'b2b' });
    // VAT id and country prefilled once from the contact.
    expect(customer).toMatchObject({ vatId: 'DE123456789', countryCode: 'DE' });

    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });
    await addLine(scope, draft.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });
    const { document } = await issue(scope, draft.document.id, { actorUserId: ACTOR });
    expect(document.document.customerSnapshot).toEqual({
      v: 1,
      contactId: contact.id,
      kind: 'organization',
      name: 'Sample Customer GmbH',
      companyOrRole: '',
      legalForm: 'GmbH',
      addressLine1: 'Beispielweg 2',
      addressLine2: null,
      postalCode: '20095',
      city: 'Hamburg',
      country: 'DE',
      customerNumber: numbered.customerNumber,
      customerType: 'b2b',
      vatId: 'DE123456789',
      taxNumber: null,
    });
  });

  it('a contact of another company is not found', async () => {
    const scope = await companyWith(directory);
    const foreign = await contactsFor(contacts!, newTenantId()).create(organization('Other Company GmbH'));
    await expect(createCustomer(scope, { contactId: foreign.id, customerType: 'b2b' })).rejects.toMatchObject({
      code: 'RECIPIENT_NOT_FOUND',
    });
  });

  it('an archived contact refuses issue', async () => {
    const scope = await companyWith(directory);
    const book = contactsFor(contacts!, scope.tenantId);
    const contact = await book.create(organization('Archived Customer GmbH'));
    const customer = await createCustomer(scope, { contactId: contact.id, customerType: 'b2b' });
    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });
    await addLine(scope, draft.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });
    await book.archive(contact.id);
    await expect(issue(scope, draft.document.id, { actorUserId: ACTOR })).rejects.toMatchObject({
      code: 'RECIPIENT_ARCHIVED',
    });
    expect((await getDocument(scope, draft.document.id)).document.status).toBe('draft');
  });

  it('an incomplete contact reports the missing fields', async () => {
    const scope = await companyWith(directory);
    const contact = await contactsFor(contacts!, scope.tenantId).create({
      kind: 'organization',
      name: 'Incomplete Customer GmbH',
      country: 'DE',
    });
    const customer = await createCustomer(scope, { contactId: contact.id, customerType: 'b2b' });
    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });
    await addLine(scope, draft.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });
    await expect(issue(scope, draft.document.id, { actorUserId: ACTOR })).rejects.toMatchObject({
      code: 'RECIPIENT_INCOMPLETE',
      details: { missing: ['addressLine1', 'postalCode', 'city'] },
    });
  });

  it('a stopped contacts container gives RECIPIENT_UNAVAILABLE and writes nothing', async () => {
    const scope = await companyWith(directory);
    const contact = await contactsFor(contacts!, scope.tenantId).create(organization('Last Customer GmbH'));
    const customer = await createCustomer(scope, { contactId: contact.id, customerType: 'b2b' });
    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });
    await addLine(scope, draft.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });
    const before = await getDocument(scope, draft.document.id);

    await container!.stop();
    container = undefined;
    await expect(issue(scope, draft.document.id, { actorUserId: ACTOR })).rejects.toMatchObject({
      code: 'RECIPIENT_UNAVAILABLE',
    });
    const after = await getDocument(scope, draft.document.id);
    expect(after.document.status).toBe('draft');
    expect(after.events).toEqual(before.events);
    const counter = await env.ownerDb
      .selectFrom('document_number_counter')
      .select('next_value')
      .where('tenant_id', '=', scope.tenantId)
      .where('doc_type', '=', 'invoice')
      .executeTakeFirstOrThrow();
    expect(Number(counter.next_value)).toBe(62);
  }, 60_000);
});
