// A company that issues under its business contact (docs/plans/2026-11-26-books-sender-from-contacts.md), end to
// end against real Postgres: the real contacts database holds the sender, the operator steps link and unlink it,
// and invoices are drafted, drawn, issued and cancelled. The stateful flow cases: forward, change after the draft
// was drawn, unlink and relink, resume after an outage, issue and cancel again with contacts down.
// Synthetic data only; the IBAN is the published test IBAN of the German banking associations.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import postgres from 'postgres';
import { contactsFor, createContactsDb, migrate, type ContactsDb } from '@marlinjai/contacts-core';

import { receiptReadiness } from '../../commerce/payment/receiptReadiness';
import { cancelInvoice } from '../cancel';
import { issue } from '../issue';
import { documentRenderInput } from '../render/store';
import { createDraft } from '../repository/documents';
import { addLine } from '../repository/lines';
import { getDocument } from '../repository/read';
import { contactsSenderDirectory, SENDER_CUSTOM_FIELDS, type SenderDirectory } from '../sender';
import { linkSenderContact, runBooksSenderLink, unlinkSenderContact } from '../senderLink';
import { readSettings } from '../settings';
import {
  ACTOR,
  FakeDirectory,
  initCompany,
  newCustomer,
  newTenantId,
  openBooksEnv,
  scopeFor,
  syntheticSender,
  type BooksEnv,
} from './booksFixtures';

const IBAN = 'DE02120300000000202051';

let env: BooksEnv;
let container: StartedTestContainer | undefined;
let contacts: ContactsDb;
let contactsUrl: string;
let real: SenderDirectory;

beforeAll(async () => {
  env = await openBooksEnv('books-sender-flow');
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'postgres', POSTGRES_DB: 'contacts', POSTGRES_HOST_AUTH_METHOD: 'trust' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  contactsUrl = `postgresql://postgres@${container.getHost()}:${container.getMappedPort(5432)}/contacts`;
  const owner = postgres(contactsUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(owner);
  } finally {
    await owner.end();
  }
  contacts = createContactsDb(contactsUrl, { applicationName: 'books-sender-flow', connectTimeoutSeconds: 2 });
  real = contactsSenderDirectory(() => contacts);
}, 180_000);

afterAll(async () => {
  await contacts?.sql.end({ timeout: 1 });
  await container?.stop();
  await env?.close();
});

/** A company with Books, one customer, and a business contact that matches the stored sender except where told. */
async function company(contactPatch: { city?: string } = {}) {
  const tenantId = newTenantId();
  const recipients = new FakeDirectory();
  const outage = { on: false, reads: 0 };
  const senders: SenderDirectory = {
    async getSender(tenant, id) {
      outage.reads += 1;
      if (outage.on) throw new Error('synthetic contacts outage');
      return real.getSender(tenant, id);
    },
  };
  const scope = { ...scopeFor(env.appDb, env.tgId, tenantId, recipients), senders };
  await initCompany(scope);
  const stored = syntheticSender();
  const book = contactsFor(contacts, tenantId);
  const contact = await book.create({
    kind: 'organization',
    name: stored.legalName!,
    addressLine1: stored.addressLine1,
    postalCode: stored.postalCode,
    city: contactPatch.city ?? stored.city,
    country: stored.countryCode,
    vatId: stored.vatId,
    email: stored.email,
  });
  /** Fill the sender fields so that the contact prints exactly what the stored block does. */
  const fill = async () => {
    const now = (await book.get(contact.id))!;
    await book.update(contact.id, {
      ...now,
      customFields: { steuernummer: stored.taxNumber, bankname: stored.bankName },
    });
  };
  const { customer } = await newCustomer(scope, recipients);
  const draft = async () => {
    const view = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });
    await addLine(scope, view.document.id, { kind: 'service', title: 'Design', quantity: 1000, unitPrice: 10_000 });
    return view.document.id;
  };
  const link = async () => {
    // First run creates the field definitions; then the values can be entered and the link made.
    await linkSenderContact(scope, contacts, contact.id).catch(() => undefined);
    await fill();
    return linkSenderContact(scope, contacts, contact.id);
  };
  /** Change the contact as the receipts app would: every fixed field passed back. */
  const edit = async (patch: Record<string, unknown>) => {
    const now = (await book.get(contact.id))!;
    return book.update(contact.id, { ...now, ...patch });
  };
  const pointer = async () => (await readSettings(scope.db, scope))!.senderContactId;
  return { tenantId, scope, senders, outage, book, contact, stored, fill, draft, link, edit, pointer };
}

type Company = Awaited<ReturnType<typeof company>>;

/** Number, status and frozen sender of every issued document of the company, as one string. */
async function fingerprint(c: Company): Promise<string> {
  const rows = await env.ownerDb
    .selectFrom('sales_document')
    .select(['document_number', 'status', 'sender_snapshot'])
    .where('tenant_id', '=', c.tenantId)
    .where('status', '<>', 'draft')
    .orderBy('document_number')
    .execute();
  return JSON.stringify(rows);
}

const issuedEvent = (c: Company, documentId: string) =>
  env.ownerDb
    .selectFrom('sales_document_event')
    .select('payload')
    .where('tenant_id', '=', c.tenantId)
    .where('document_id', '=', documentId)
    .where('event_type', '=', 'issued')
    .executeTakeFirstOrThrow();

describe('linking', () => {
  it('a dry run writes nothing, in either database, and says what it would do', async () => {
    const c = await company();
    // The contact still lacks nothing it needs (it has a VAT id), but not the stored tax number and bank name.
    const result = await linkSenderContact(c.scope, contacts, c.contact.id, { dryRun: true });
    expect(result).toEqual({
      differences: ['taxNumber', 'bankName'],
      definitions: Object.values(SENDER_CUSTOM_FIELDS).map((f) => f.key),
      changed: false,
    });
    expect(await c.pointer()).toBeNull();
    expect(await c.book.listFields({ includeArchived: true })).toEqual([]);
  });

  it('refuses while a field would print differently, naming fields and no values, then links once they match', async () => {
    const c = await company({ city: 'Potsdam' });
    const refused = await linkSenderContact(c.scope, contacts, c.contact.id).then(
      () => null,
      (err: Error & { details?: unknown }) => err,
    );
    expect(refused).toMatchObject({ code: 'SENDER_INVALID' });
    expect(refused!.message).toContain('city');
    expect(`${refused!.message} ${JSON.stringify(refused!.details)}`).not.toMatch(/Potsdam|Berlin|12\/345/);
    expect(await c.pointer()).toBeNull();
    await c.fill();
    await c.edit({ city: c.stored.city });
    expect(await linkSenderContact(c.scope, contacts, c.contact.id)).toMatchObject({ differences: [], changed: true });
    expect(await c.pointer()).toBe(c.contact.id);
    expect(await linkSenderContact(c.scope, contacts, c.contact.id)).toMatchObject({ changed: false });
  });

  it('--accept-differences links a contact that prints differently', async () => {
    const c = await company({ city: 'Potsdam' });
    await expect(linkSenderContact(c.scope, contacts, c.contact.id, { acceptDifferences: true })).resolves.toMatchObject({
      changed: true,
    });
  });

  it("another company's contact cannot be linked", async () => {
    const c = await company();
    const other = await company();
    await expect(linkSenderContact(c.scope, contacts, other.contact.id)).rejects.toMatchObject({ code: 'SENDER_NOT_FOUND' });
    expect(await c.pointer()).toBeNull();
  });

  it('a custom field that already has a sender key with another type is refused by name, nothing created', async () => {
    const c = await company();
    await c.book.createField({ key: 'website', label: 'Homepage', type: 'text' });
    await expect(linkSenderContact(c.scope, contacts, c.contact.id)).rejects.toMatchObject({
      code: 'SENDER_INVALID',
      details: { fields: ['field_type:website'] },
    });
    expect((await c.book.listFields()).map((d) => d.key)).toEqual(['website']);
  });

  it('the operator command links and reports names only', async () => {
    const c = await company();
    await linkSenderContact(c.scope, contacts, c.contact.id).catch(() => undefined);
    await c.fill();
    const lines: string[] = [];
    const args = ['--tenant-group', env.tgId, '--tenant', c.tenantId, '--sender-contact', c.contact.id];
    const cliEnv = { COMMERCE_APP_DATABASE_URL: process.env.COMMERCE_APP_DATABASE_URL, CONTACTS_DATABASE_URL: contactsUrl };
    await runBooksSenderLink([...args, '--dry-run'], cliEnv, (l) => lines.push(l));
    expect(lines.slice(0, 2)).toEqual(['dry run: nothing was written', 'fields that differ: none']);
    expect(await c.pointer()).toBeNull();
    await runBooksSenderLink(args, cliEnv, (l) => lines.push(l));
    expect(await c.pointer()).toBe(c.contact.id);
    expect(lines.join('\n')).not.toMatch(/12\/345|Musterstrasse|Example Bank/);
  });
});

describe('a linked company', () => {
  it('draws and issues from the contact, records which version, and leaves earlier documents alone', async () => {
    const c = await company();
    const before = await c.draft();
    await issue(c.scope, before, { actorUserId: ACTOR });
    const frozen = await fingerprint(c);
    await c.link();
    expect(await fingerprint(c)).toBe(frozen);

    const id = await c.draft();
    const saved = await c.edit({ addressLine1: 'Kontaktweg 3' });
    expect((await documentRenderInput(c.scope, id)).sender).toMatchObject({ addressLine1: 'Kontaktweg 3' });
    const result = await issue(c.scope, id, { actorUserId: ACTOR });
    expect(result.document.document).toMatchObject({ status: 'issued', senderSnapshot: { v: 1, addressLine1: 'Kontaktweg 3' } });
    expect((await issuedEvent(c, id)).payload).toMatchObject({
      senderContactId: c.contact.id,
      senderContactVersion: saved.version,
    });
    await c.edit({ addressLine1: 'Kontaktweg 4' });
    expect((await getDocument(c.scope, id)).document.senderSnapshot).toMatchObject({ addressLine1: 'Kontaktweg 3' });
    expect((await issuedEvent(c, before)).payload).not.toHaveProperty('senderContactId');
  });

  it('a contact broken after the draft was drawn stops the issue with nothing written; corrected, the new data prints', async () => {
    const c = await company();
    await c.link();
    const id = await c.draft();
    await documentRenderInput(c.scope, id);
    await c.edit({ customFields: { iban: 'DE02120300000000202052' } });
    await expect(issue(c.scope, id, { actorUserId: ACTOR })).rejects.toMatchObject({
      code: 'SENDER_INVALID',
      details: { fields: ['iban'] },
    });
    expect((await getDocument(c.scope, id)).document).toMatchObject({ status: 'draft', documentNumber: null });
    await c.edit({ customFields: { iban: IBAN } });
    expect((await documentRenderInput(c.scope, id)).sender).toMatchObject({ iban: IBAN });
    const issued = await issue(c.scope, id, { actorUserId: ACTOR });
    // The number the refused attempt did not take.
    expect(issued.document.document.documentNumber).toBe('62');
  });

  it('an archived sender refuses issue until restored; an archived sender field refuses it too', async () => {
    const c = await company();
    await c.link();
    const id = await c.draft();
    await c.book.archive(c.contact.id);
    await expect(issue(c.scope, id, { actorUserId: ACTOR })).rejects.toMatchObject({ code: 'SENDER_NOT_FOUND' });
    await c.book.restore(c.contact.id);
    await c.book.archiveField('bic');
    await expect(issue(c.scope, id, { actorUserId: ACTOR })).rejects.toMatchObject({
      code: 'SENDER_INVALID',
      details: { fields: ['field_archived:bic'] },
    });
    await c.book.restoreField('bic');
    await expect(issue(c.scope, id, { actorUserId: ACTOR })).resolves.toMatchObject({ alreadyIssued: false });
  });

  it('during an outage nothing is issued or cancelled; afterwards both work; repeating them needs no contacts', async () => {
    const c = await company();
    await c.link();
    const id = await c.draft();
    c.outage.on = true;
    await expect(issue(c.scope, id, { actorUserId: ACTOR })).rejects.toMatchObject({ code: 'SENDER_UNAVAILABLE' });
    c.outage.on = false;
    await issue(c.scope, id, { actorUserId: ACTOR });

    c.outage.on = true;
    await expect(issue(c.scope, id, { actorUserId: ACTOR })).resolves.toMatchObject({ alreadyIssued: true });
    const issuedState = await fingerprint(c);
    await expect(cancelInvoice(c.scope, id, { actorUserId: ACTOR, reason: 'Test' })).rejects.toMatchObject({
      code: 'SENDER_UNAVAILABLE',
    });
    expect(await fingerprint(c)).toBe(issuedState);

    c.outage.on = false;
    const cancelled = await cancelInvoice(c.scope, id, { actorUserId: ACTOR, reason: 'Test' });
    expect((await issuedEvent(c, cancelled.creditNote.document.id)).payload).toMatchObject({ senderContactId: c.contact.id });
    c.outage.on = true;
    const reads = c.outage.reads;
    await expect(cancelInvoice(c.scope, id, { actorUserId: ACTOR, reason: 'Test' })).resolves.toMatchObject({
      alreadyCancelled: true,
    });
    expect(c.outage.reads).toBe(reads);
  });

  it('a link changed while an invoice is being issued is a concurrent edit, never a mix of both sources', async () => {
    const c = await company();
    await c.link();
    const id = await c.draft();
    await expect(
      issue(c.scope, id, { actorUserId: ACTOR }, { beforeTransaction: async () => void (await unlinkSenderContact(c.scope, contacts)) }),
    ).rejects.toMatchObject({ code: 'CONCURRENT_EDIT' });
    expect((await getDocument(c.scope, id)).document.status).toBe('draft');
  });

  it('shop payments wait while the sender cannot be used', async () => {
    const c = await company();
    await c.link();
    const ready = () => receiptReadiness(env.appDb, env.tgId, c.tenantId, { senders: c.senders });
    expect(await ready()).toEqual({ ready: true });
    c.outage.on = true;
    expect(await ready()).toEqual({ ready: false, blocker: 'sender_unavailable', missing: [] });
    c.outage.on = false;
    await c.book.archive(c.contact.id);
    expect(await ready()).toEqual({ ready: false, blocker: 'sender_unavailable', missing: [] });
  });
});

describe('unlinking and relinking', () => {
  it('compares first: an out of date stored block is not returned to silently', async () => {
    const c = await company();
    await c.link();
    await c.edit({ city: 'Potsdam' });
    await expect(unlinkSenderContact(c.scope, contacts)).rejects.toMatchObject({
      code: 'SENDER_INVALID',
      details: { fields: ['city'] },
    });
    expect(await unlinkSenderContact(c.scope, contacts, { dryRun: true })).toEqual({
      differences: ['city'],
      definitions: [],
      changed: false,
    });
    expect(await c.pointer()).toBe(c.contact.id);
    expect(await unlinkSenderContact(c.scope, contacts, { acceptDifferences: true })).toMatchObject({ changed: true });
    const id = await c.draft();
    expect((await documentRenderInput(c.scope, id)).sender).toMatchObject({ city: c.stored.city });
  });

  it('a contact that can no longer be read cannot be compared, and another one can be linked in its place', async () => {
    const c = await company();
    await c.link();
    const next = await c.book.create({
      kind: 'organization',
      name: 'Successor Studio',
      addressLine1: 'Neuweg 1',
      postalCode: '10117',
      city: 'Berlin',
      country: 'DE',
      vatId: 'DE123456789',
    });
    await c.book.erase(c.contact.id);
    await expect(unlinkSenderContact(c.scope, contacts)).rejects.toMatchObject({ code: 'SENDER_INVALID' });
    await expect(linkSenderContact(c.scope, contacts, next.id, { acceptDifferences: true })).resolves.toMatchObject({
      changed: true,
    });
    expect(await c.pointer()).toBe(next.id);
  });

  it('unlinking a company that is not linked changes nothing', async () => {
    const c = await company();
    expect(await unlinkSenderContact(c.scope, contacts)).toEqual({ differences: [], definitions: [], changed: false });
  });
});
