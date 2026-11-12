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

import { createCustomer, setCustomerDefaultContactPerson } from '../repository/customers';
import { createDraft, setContactPerson } from '../repository/documents';
import { addLine } from '../repository/lines';
import { getDocument } from '../repository/read';
import { contactsRecipientDirectory, type RecipientDirectory } from '../recipients';
import { issue } from '../issue';
import { contactsContactBook } from '../contactBook';
import { importHistoricalInvoice, newImportSession, type HistoricalInvoiceInput } from '../importInvoices';
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

  it('the import lookups on the real package: findSame ignores case and spacing, personsNamed any company or role, archived included', async () => {
    const tenantId = newTenantId();
    const handle = contacts!;
    const book = contactsContactBook(() => handle);
    const db = contactsFor(handle, tenantId);
    const org = await db.create(organization('Example Client GmbH'));
    expect((await book.findSame(tenantId, { kind: 'organization', name: '  example   client gmbh ' }))?.id).toBe(org.id);
    const person = await db.create({ kind: 'person', name: 'Erika Beispiel', companyOrRole: 'Studio A' });
    await db.archive(person.id);
    expect((await book.personsNamed(tenantId, 'erika  beispiel')).map((c) => c.id)).toEqual([person.id]);
    expect(await book.personsNamed(tenantId, 'Erika')).toEqual([]);
    // Another company's contact is never found.
    expect(await book.findSame(newTenantId(), { kind: 'organization', name: 'Example Client GmbH' })).toBeNull();
  });

  it('an import through the real package creates the client once and reuses it for the next number', async () => {
    const handle = contacts!;
    const book = contactsContactBook(() => handle);
    const scope = await companyWith(directory);
    const record = (numberValue: number): HistoricalInvoiceInput => ({
      origin: 'upload_extracted',
      documentNumber: String(numberValue),
      issueDate: '2025-04-01',
      serviceDate: null,
      servicePeriod: null,
      paymentTermsDays: 0,
      dueDate: null,
      recipient: {
        kind: 'organization', name: 'Sample Customer GmbH', addressLine1: 'Beispielweg 2', addressLine2: null, postalCode: '20095',
        city: 'Hamburg', country: 'DE', customerNumber: null, customerNumberText: null, vatId: null,
      },
      sender: {
        legalName: 'Example Studio', addressLine1: 'Musterstrasse 1', addressLine2: null, postalCode: '10115', city: 'Berlin', countryCode: 'DE',
        taxNumber: null, vatId: null, smallBusinessId: null, email: null, phone: null, website: null, bankName: null, iban: null, bic: null,
        registerCourt: null, registerNumber: null, managingDirector: null,
      },
      lines: [{ kind: 'service', title: 'Design work', description: null, quantity: 1000, unitLabel: 'Stk', unitPrice: 5000, discountBp: 0, subtotal: 5000 }],
      total: 5000,
      currency: 'EUR',
      taxTreatment: 'small_business',
      taxNote: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.',
    });
    const pdf = (n: number) => new Uint8Array(Buffer.from(`%PDF-1.4\n% synthetic ${scope.tenantId} ${n}\n%%EOF\n`, 'latin1'));
    const session = newImportSession();
    const a = await importHistoricalInvoice(scope, book, record(20), pdf(20), session);
    const b = await importHistoricalInvoice(scope, book, record(21), pdf(21), newImportSession());
    expect([a.status, b.status]).toEqual(['imported', 'imported']);
    const docA = (await getDocument(scope, a.documentId)).document;
    const docB = (await getDocument(scope, b.documentId)).document;
    expect(docA.customerId).toBe(docB.customerId);
    expect((await contactsFor(handle, scope.tenantId).list({ search: 'Sample Customer' })).map((c) => c.id)).toEqual([docA.customerSnapshot!.contactId]);
  });

  it('contact persons on the real package: a person with a role is chosen, issue freezes name and role, later changes never reach the issued invoice', async () => {
    const handle = contacts!;
    const book = contactsContactBook(() => handle);
    const scope = await companyWith(directory);
    const db = contactsFor(handle, scope.tenantId);
    const org = await db.create(organization('Contact Person Customer GmbH'));
    const customer = await createCustomer(scope, { contactId: org.id, customerType: 'b2b' });

    const anna = await book.addContactPerson(scope.tenantId, { organizationContactId: org.id, person: { name: 'Anna Beispiel' }, role: 'Einkauf' });
    expect(anna).toMatchObject({ name: 'Anna Beispiel', role: 'Einkauf', primary: true });
    expect((await book.listContactPersons(scope.tenantId, org.id)).map((p) => [p.name, p.role])).toEqual([['Anna Beispiel', 'Einkauf']]);

    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });
    await addLine(scope, draft.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });
    const set = await setContactPerson(scope, draft.document.id, { contactPersonId: anna.contactId });
    expect(set.document.contactPersonId).toBe(anna.contactId);

    // The role changes before issue: the draft follows, and issue freezes what holds at that moment.
    const affiliation = (await db.affiliationsOf(anna.contactId))[0]!;
    await db.updateAffiliation(affiliation.id, { role: 'Leitung Einkauf' });
    const { document } = await issue(scope, draft.document.id, { actorUserId: ACTOR });
    expect(document.document.customerSnapshot).toMatchObject({
      v: 2,
      contactPerson: { contactId: anna.contactId, affiliationId: affiliation.id, name: 'Anna Beispiel', role: 'Leitung Einkauf' },
    });
    // After issue the person changes role and leaves: the issued snapshot does not move.
    await db.updateAffiliation(affiliation.id, { role: 'Beirat' });
    await db.endAffiliation(affiliation.id);
    const reread = (await getDocument(scope, draft.document.id)).document.customerSnapshot;
    expect(reread).toMatchObject({ contactPerson: { name: 'Anna Beispiel', role: 'Leitung Einkauf' } });
  });

  it('contact persons on the real package: the refusals (another business, another company, archived, left, duplicate)', async () => {
    const handle = contacts!;
    const book = contactsContactBook(() => handle);
    const scope = await companyWith(directory);
    const db = contactsFor(handle, scope.tenantId);
    const org = await db.create(organization('First Business GmbH'));
    const other = await db.create(organization('Second Business GmbH'));
    const customer = await createCustomer(scope, { contactId: org.id, customerType: 'b2b' });
    const ben = await book.addContactPerson(scope.tenantId, { organizationContactId: other.id, person: { name: 'Ben Muster' } });
    const cora = await book.addContactPerson(scope.tenantId, { organizationContactId: org.id, person: { name: 'Cora Archiv' } });
    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });

    // A person of the other business, and of another company, are "not found" for this customer.
    await expect(setContactPerson(scope, draft.document.id, { contactPersonId: ben.contactId })).rejects.toMatchObject({ code: 'CONTACT_PERSON_NOT_FOUND' });
    const foreign = await contactsFor(handle, newTenantId()).create({ kind: 'person', name: 'Foreign Person' });
    await expect(setContactPerson(scope, draft.document.id, { contactPersonId: foreign.id })).rejects.toMatchObject({ code: 'CONTACT_PERSON_NOT_FOUND' });
    await expect(setCustomerDefaultContactPerson(scope, customer.id, ben.contactId)).rejects.toMatchObject({ code: 'CONTACT_PERSON_NOT_FOUND' });

    // Archived: unavailable. Left: not found for a new choice, and a stored one stops the issue.
    await db.archive(cora.contactId);
    await expect(setContactPerson(scope, draft.document.id, { contactPersonId: cora.contactId })).rejects.toMatchObject({ code: 'CONTACT_PERSON_UNAVAILABLE' });
    await db.restore(cora.contactId);
    await setContactPerson(scope, draft.document.id, { contactPersonId: cora.contactId });
    await addLine(scope, draft.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });
    await db.endAffiliation(cora.affiliationId);
    await expect(issue(scope, draft.document.id, { actorUserId: ACTOR })).rejects.toMatchObject({ code: 'CONTACT_PERSON_UNAVAILABLE' });
    expect((await getDocument(scope, draft.document.id)).document.status).toBe('draft');
    await setContactPerson(scope, draft.document.id, { contactPersonId: null });
    await expect(issue(scope, draft.document.id, { actorUserId: ACTOR })).resolves.toBeDefined();

    // The same person twice, and a new person whose name exists: the book names both.
    await expect(book.addContactPerson(scope.tenantId, { organizationContactId: other.id, personContactId: ben.contactId })).rejects.toMatchObject({ code: 'DUPLICATE_CONTACT_PERSON' });
    await expect(book.addContactPerson(scope.tenantId, { organizationContactId: other.id, person: { name: 'Ben Muster' } })).rejects.toMatchObject({ code: 'DUPLICATE_CONTACT' });
    // A person cannot be made a contact person of a person, nor of a business of another company.
    await expect(book.addContactPerson(scope.tenantId, { organizationContactId: ben.contactId, personContactId: cora.contactId })).rejects.toMatchObject({ code: 'RECIPIENT_NOT_FOUND' });
    const theirOrg = await contactsFor(handle, newTenantId()).create(organization('Their GmbH'));
    await expect(book.addContactPerson(scope.tenantId, { organizationContactId: theirOrg.id, personContactId: cora.contactId })).rejects.toMatchObject({ code: 'RECIPIENT_NOT_FOUND' });
  });

  it('contact persons on the real package: company_or_role is never read as a role', async () => {
    const handle = contacts!;
    const book = contactsContactBook(() => handle);
    const scope = await companyWith(directory);
    const db = contactsFor(handle, scope.tenantId);
    const org = await db.create(organization('Legacy Text GmbH'));
    const customer = await createCustomer(scope, { contactId: org.id, customerType: 'b2b' });
    // A person recorded the old way: the free text "Firma oder Funktion" holds a company name.
    const old = await db.create({ kind: 'person', name: 'Dora Alt', companyOrRole: 'Muster GmbH' });
    const added = await book.addContactPerson(scope.tenantId, { organizationContactId: org.id, personContactId: old.id });
    expect(added.role).toBe('');
    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });
    await addLine(scope, draft.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });
    await setContactPerson(scope, draft.document.id, { contactPersonId: old.id });
    const { document } = await issue(scope, draft.document.id, { actorUserId: ACTOR });
    expect(document.document.customerSnapshot).toMatchObject({ contactPerson: { name: 'Dora Alt', role: '' } });
    expect(JSON.stringify(document.document.customerSnapshot)).not.toContain('Muster GmbH');
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
