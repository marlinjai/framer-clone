// src/server/books/__tests__/books-flow.itest.ts
//
// Books plan P1.10: the four stateful-flow paths of a document
// (knowledge-base standard stateful-flow-testing.md), against a real
// provisioned tenant schema, the repository connected as commerce_app, and a
// fake contacts directory.
//
//   1. forward: draft, three lines, issue;
//   2. backtrack and revise: a customer swap invalidates every derived tax
//      figure (and keeping the same tax profile preserves them);
//   3. resume: a draft read in a new session carries its key and recomputes
//      when stale;
//   4. re-entry: a new draft after an issue starts clean, an abandoned draft
//      consumes no number, and a failed issue retried gets the same number.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeDb } from '@marlinjai/tenant-db/node';
import { tenantDb } from '@marlinjai/tenant-db';

import type { CommerceDB } from '../../commerce/db-types';
import { REVERSE_CHARGE_NOTICE } from '../../tax/germanVat';
import { addLine, updateLine } from '../repository/lines';
import { createDraft, setCustomer } from '../repository/documents';
import { getDocument } from '../repository/read';
import { updateCustomerTaxFields } from '../repository/customers';
import { issue } from '../issue';
import { addDays } from '../numbering';
import { DEFAULT_EXEMPTION_NOTE } from '../settings';
import {
  ACTOR,
  FakeDirectory,
  berlinToday,
  initCompany,
  newCustomer,
  newTenantId,
  openBooksEnv,
  scopeFor,
  type BooksEnv,
} from './booksFixtures';

let env: BooksEnv;

beforeAll(async () => {
  env = await openBooksEnv('books-flow');
}, 120_000);

afterAll(async () => {
  await env?.close();
});

async function counterValue(tenantId: string, docType: 'invoice' | 'credit_note' = 'invoice'): Promise<number> {
  const row = await env.ownerDb
    .selectFrom('document_number_counter')
    .select('next_value')
    .where('tenant_id', '=', tenantId)
    .where('doc_type', '=', docType)
    .executeTakeFirstOrThrow();
  return Number(row.next_value);
}

describe('Books stateful flow', () => {
  it('forward: draft, three lines, issue', async () => {
    const dir = new FakeDirectory();
    const scope = scopeFor(env.appDb, env.tgId, newTenantId(), dir);
    await initCompany(scope, { taxStatus: 'small_business', invoiceNext: 62 });
    const { customer } = await newCustomer(scope, dir, { customerType: 'b2b', vatId: 'DE123456789' });

    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });
    expect(draft.document.documentNumber).toBeNull();
    const id = draft.document.id;
    await addLine(scope, id, { kind: 'service', title: 'Workshop', quantity: 1500, unitPrice: 8000, taxClass: 'standard' });
    await addLine(scope, id, { kind: 'text', title: 'Note for the record' });
    await addLine(scope, id, { kind: 'product', title: 'Handout', quantity: 2000, unitPrice: 1250, taxClass: 'reduced' });

    const today = berlinToday();
    const { document: view, alreadyIssued } = await issue(scope, id, { actorUserId: ACTOR });
    expect(alreadyIssued).toBe(false);
    const doc = view.document;
    expect(doc.status).toBe('issued');
    expect(doc.documentNumber).toBe('62');
    expect(doc.numberValue).toBe(62);
    expect(doc.issueDate).toBe(today);
    expect(doc.dueDate).toBe(addDays(today, 14));
    expect(doc.paymentReference).toBe('Rechnung 62');
    expect(doc.taxNote).toBe(DEFAULT_EXEMPTION_NOTE);
    expect(doc.kleinunternehmer).toBe(true);
    expect(doc.taxAmount).toBe(0);
    expect(doc.subtotal).toBe(12000 + 2500);
    expect(doc.total).toBe(14500);
    expect(doc.taxSummary).toEqual([{ taxRate: 0, taxTreatment: 'kleinunternehmer', net: 14500, tax: 0 }]);
    expect(doc.customerSnapshot).toMatchObject({ v: 1, name: 'Sample Customer GmbH', city: 'Hamburg', vatId: 'DE123456789' });
    expect(doc.senderSnapshot).toMatchObject({ v: 1, legalName: 'Example Studio' });
    expect(view.lines.map((l) => l.position)).toEqual([1, 2, 3]);
    const issued = view.events.filter((e) => e.eventType === 'issued');
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ fromStatus: 'draft', toStatus: 'issued' });
    expect(issued[0].payload).toMatchObject({ documentNumber: '62', numberValue: 62, total: 14500 });
    // The payload never carries the recipient.
    expect(JSON.stringify(view.events.map((e) => e.payload))).not.toContain('Sample Customer');
    expect(await counterValue(scope.tenantId)).toBe(63);
  });

  it('backtrack and revise: customer swap to an EU business flips every line to reverse charge', async () => {
    const dir = new FakeDirectory();
    const scope = scopeFor(env.appDb, env.tgId, newTenantId(), dir);
    await initCompany(scope, { taxStatus: 'regular' });
    const { customer: consumer } = await newCustomer(scope, dir, { customerType: 'b2c', countryCode: 'DE' });
    const { customer: business } = await newCustomer(scope, dir, {
      customerType: 'b2b',
      vatId: 'FR12345678901',
      countryCode: 'FR',
    });

    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: consumer.id });
    const id = draft.document.id;
    await addLine(scope, id, { title: 'Consulting', quantity: 1000, unitPrice: 10000, taxClass: 'standard' });
    await addLine(scope, id, { title: 'Book', quantity: 1000, unitPrice: 2000, taxClass: 'reduced' });
    const domestic = await getDocument(scope, id);
    expect(domestic.lines.map((l) => [l.taxRate, l.taxAmount, l.taxTreatment])).toEqual([
      [1900, 1900, 'standard'],
      [700, 140, 'reduced'],
    ]);
    const domesticKey = domestic.document.taxProfileKey;

    const swapped = await setCustomer(scope, id, { customerId: business.id, actorUserId: ACTOR });
    expect(swapped.lines.every((l) => l.taxTreatment === 'reverse_charge' && l.taxRate === 0 && l.taxAmount === 0)).toBe(true);
    expect(swapped.document).toMatchObject({
      reverseCharge: true,
      taxNote: REVERSE_CHARGE_NOTICE,
      taxAmount: 0,
      subtotal: 12000,
      total: 12000,
      customerType: 'b2b',
      vatId: 'FR12345678901',
    });
    expect(swapped.document.taxProfileKey).not.toBe(domesticKey);
    const swapEvent = swapped.events.filter((e) => e.eventType === 'customer_set').at(-1);
    expect(swapEvent?.payload).toMatchObject({
      customerId: business.id,
      previousCustomerId: consumer.id,
      taxProfileChanged: true,
    });

    // Swap back: the intended rates come back from the stored inputs.
    const back = await setCustomer(scope, id, { customerId: consumer.id, actorUserId: ACTOR });
    expect(back.lines.map((l) => [l.taxRate, l.taxAmount, l.taxTreatment])).toEqual([
      [1900, 1900, 'standard'],
      [700, 140, 'reduced'],
    ]);
    expect(back.document).toMatchObject({ reverseCharge: false, taxNote: null, taxAmount: 2040, total: 14040 });
    expect(back.document.taxProfileKey).toBe(domesticKey);
  });

  it('backtrack and revise counter-case: swap to another German consumer leaves line tax untouched', async () => {
    const dir = new FakeDirectory();
    const scope = scopeFor(env.appDb, env.tgId, newTenantId(), dir);
    await initCompany(scope, { taxStatus: 'regular' });
    const { customer: first } = await newCustomer(scope, dir, { customerType: 'b2c', countryCode: 'DE' });
    const { customer: second } = await newCustomer(scope, dir, { customerType: 'b2c', countryCode: 'DE' });

    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: first.id });
    const id = draft.document.id;
    await addLine(scope, id, { title: 'Consulting', quantity: 1000, unitPrice: 10000, taxClass: 'standard' });
    const before = await addLine(scope, id, { title: 'Book', quantity: 1000, unitPrice: 2000, taxClass: 'reduced' });

    const after = await setCustomer(scope, id, { customerId: second.id, actorUserId: ACTOR });
    expect(after.document.customerId).toBe(second.id);
    expect(after.document.version).toBe(before.document.version + 1);
    expect(after.document.taxProfileKey).toBe(before.document.taxProfileKey);
    expect(after.lines.map((l) => ({ ...l }))).toEqual(before.lines.map((l) => ({ ...l })));
    expect(after.events.filter((e) => e.eventType === 'customer_set')).toHaveLength(2);
    expect(after.events.at(-1)?.payload).toMatchObject({ taxProfileChanged: false });

    // Setting the same customer again is a no-op: no version bump, no event.
    const same = await setCustomer(scope, id, { customerId: second.id, actorUserId: ACTOR });
    expect(same.document.version).toBe(after.document.version);
    expect(same.events).toHaveLength(after.events.length);
  });

  it('backtrack under section 19: swapping to an EU business changes no tax', async () => {
    const dir = new FakeDirectory();
    const scope = scopeFor(env.appDb, env.tgId, newTenantId(), dir);
    await initCompany(scope, { taxStatus: 'small_business' });
    const { customer: consumer } = await newCustomer(scope, dir, { customerType: 'b2c', countryCode: 'DE' });
    const { customer: business } = await newCustomer(scope, dir, {
      customerType: 'b2b',
      vatId: 'FR12345678901',
      countryCode: 'FR',
    });
    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: consumer.id });
    await addLine(scope, draft.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000, taxClass: 'standard' });
    await addLine(scope, draft.document.id, { title: 'Book', quantity: 1000, unitPrice: 2000, taxClass: 'reduced' });
    const swapped = await setCustomer(scope, draft.document.id, { customerId: business.id, actorUserId: ACTOR });
    expect(swapped.lines.every((l) => l.taxTreatment === 'kleinunternehmer' && l.taxAmount === 0)).toBe(true);
    expect(swapped.document).toMatchObject({ reverseCharge: false, kleinunternehmer: true, taxAmount: 0, total: 12000 });
  });

  it('backtrack and revise: a line edit recomputes only that line and the totals', async () => {
    const dir = new FakeDirectory();
    const scope = scopeFor(env.appDb, env.tgId, newTenantId(), dir);
    await initCompany(scope, { taxStatus: 'regular' });
    const { customer } = await newCustomer(scope, dir, { customerType: 'b2c', countryCode: 'DE' });
    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });
    const id = draft.document.id;
    await addLine(scope, id, { title: 'Consulting', quantity: 1000, unitPrice: 10000, taxClass: 'standard' });
    const before = await addLine(scope, id, { title: 'Book', quantity: 1000, unitPrice: 2000, taxClass: 'reduced' });
    const [first, second] = before.lines;

    const after = await updateLine(scope, id, second.id, { quantity: 3000 });
    expect(after.lines[0]).toEqual(first);
    expect(after.lines[1]).toMatchObject({ quantity: 3000, subtotal: 6000, taxAmount: 420 });
    expect(after.lines[1].updatedAt.getTime()).toBeGreaterThanOrEqual(second.updatedAt.getTime());
    expect(after.document).toMatchObject({ subtotal: 16000, taxAmount: 2320, total: 18320 });
    expect(after.document.taxSummary).toEqual([
      { taxRate: 1900, taxTreatment: 'standard', net: 10000, tax: 1900 },
      { taxRate: 700, taxTreatment: 'reduced', net: 6000, tax: 420 },
    ]);
  });

  it('resume: a draft read in a new session carries its key and recomputes when stale', async () => {
    const dir = new FakeDirectory();
    const tenantId = newTenantId();
    const scope = scopeFor(env.appDb, env.tgId, tenantId, dir);
    await initCompany(scope, { taxStatus: 'regular' });
    const { customer } = await newCustomer(scope, dir, { customerType: 'b2b', vatId: 'DE123456789', countryCode: 'DE' });
    const draft = await createDraft(scope, {
      docType: 'invoice',
      actorUserId: ACTOR,
      customerId: customer.id,
      serviceDate: '2026-10-01',
    });
    const id = draft.document.id;
    await addLine(scope, id, { title: 'Consulting', quantity: 1000, unitPrice: 10000, taxClass: 'standard' });
    const persisted = await addLine(scope, id, { title: 'Book', quantity: 1000, unitPrice: 2000, taxClass: 'reduced' });

    // A new session: a fresh base handle and scope, nothing carried over.
    const url = process.env.COMMERCE_APP_DATABASE_URL as string;
    const freshBase = createNodeDb<CommerceDB>({ connectionString: url });
    try {
      const fresh = scopeFor(tenantDb(freshBase, env.tgId), env.tgId, tenantId, dir);
      const resumed = await getDocument(fresh, id);
      expect(resumed.stale).toBe(false);
      expect(resumed.lines).toEqual(persisted.lines);
      expect(resumed.document.total).toBe(persisted.document.total);
      expect(resumed.document.taxProfileKey).toBe(persisted.document.taxProfileKey);

      // The customer moves to another EU member state: the stored key is stale.
      await updateCustomerTaxFields(fresh, customer.id, { vatId: 'FR12345678901', countryCode: 'FR' });
      const stale = await getDocument(fresh, id);
      expect(stale.stale).toBe(true);
      expect(stale.document).toMatchObject({ reverseCharge: true, taxAmount: 0, total: 12000 });
      expect(stale.lines.every((l) => l.taxTreatment === 'reverse_charge')).toBe(true);
      // Nothing was written by the read.
      const row = await env.ownerDb
        .selectFrom('sales_document')
        .select(['total', 'tax_profile_key'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(row.total).toBe(persisted.document.total);
      expect(row.tax_profile_key).toBe(persisted.document.taxProfileKey);

      // The next mutation persists the recomputation...
      const mutated = await addLine(fresh, id, { kind: 'text', title: 'Thanks' });
      expect(mutated.document).toMatchObject({ reverseCharge: true, taxAmount: 0, total: 12000 });
      expect(mutated.document.taxProfileKey).toBe(stale.document.taxProfileKey);
      expect((await getDocument(fresh, id)).stale).toBe(false);

      // ...and a further change is frozen by issue, never the stored stale figures.
      await updateCustomerTaxFields(fresh, customer.id, { vatId: 'DE123456789', countryCode: 'DE' });
      expect((await getDocument(fresh, id)).stale).toBe(true);
      const { document: issued } = await issue(fresh, id, { actorUserId: ACTOR });
      expect(issued.document).toMatchObject({ status: 'issued', reverseCharge: false, taxAmount: 2040, total: 14040 });
      expect(issued.document.customerSnapshot).toMatchObject({ vatId: 'DE123456789' });
    } finally {
      await freshBase.destroy();
    }
  });

  it('resume: a draft whose tax_profile_key is NULL reads as stale and recomputes', async () => {
    const dir = new FakeDirectory();
    const scope = scopeFor(env.appDb, env.tgId, newTenantId(), dir);
    await initCompany(scope, { taxStatus: 'regular' });
    const { customer } = await newCustomer(scope, dir, { customerType: 'b2c', countryCode: 'DE' });
    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });
    await addLine(scope, draft.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000, taxClass: 'standard' });
    // As an older writer would leave it: no key, and figures that were never computed.
    await env.ownerDb
      .updateTable('sales_document')
      .set({ tax_profile_key: null, subtotal: 0, tax_amount: 0, total: 0, updated_at: new Date() })
      .where('id', '=', draft.document.id)
      .execute();
    const read = await getDocument(scope, draft.document.id);
    expect(read.stale).toBe(true);
    expect(read.document).toMatchObject({ subtotal: 10000, taxAmount: 1900, total: 11900 });
    expect(read.document.taxProfileKey).not.toBeNull();
  });

  it('re-entry: a new draft after an issue starts clean and an abandoned draft consumes no number', async () => {
    const dir = new FakeDirectory();
    const scope = scopeFor(env.appDb, env.tgId, newTenantId(), dir);
    await initCompany(scope, { invoiceNext: 62 });
    const { customer } = await newCustomer(scope, dir);

    const first = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });
    await addLine(scope, first.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });
    const issuedFirst = await issue(scope, first.document.id, { actorUserId: ACTOR });
    expect(issuedFirst.document.document.documentNumber).toBe('62');

    const abandoned = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR });
    expect(abandoned.document.id).not.toBe(first.document.id);
    expect(abandoned.document).toMatchObject({
      status: 'draft',
      documentNumber: null,
      numberValue: null,
      customerSnapshot: null,
      senderSnapshot: null,
    });
    expect(abandoned.events.map((e) => e.eventType)).toEqual(['draft_created']);
    expect(abandoned.lines).toEqual([]);
    await setCustomer(scope, abandoned.document.id, { customerId: customer.id, actorUserId: ACTOR });
    await addLine(scope, abandoned.document.id, { title: 'Never billed', quantity: 1000, unitPrice: 500 });

    const third = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });
    await addLine(scope, third.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });
    const issuedThird = await issue(scope, third.document.id, { actorUserId: ACTOR });
    expect(issuedThird.document.document.documentNumber).toBe('63');

    const stillDraft = await getDocument(scope, abandoned.document.id);
    expect(stillDraft.document).toMatchObject({ status: 'draft', documentNumber: null });
    expect(await counterValue(scope.tenantId)).toBe(64);
  });

  it('re-entry after a failed issue', async () => {
    const dir = new FakeDirectory();
    const scope = scopeFor(env.appDb, env.tgId, newTenantId(), dir);
    await initCompany(scope, { invoiceNext: 62 });
    const { customer } = await newCustomer(scope, dir);
    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });
    await addLine(scope, draft.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });

    dir.failing = true;
    await expect(issue(scope, draft.document.id, { actorUserId: ACTOR })).rejects.toMatchObject({
      code: 'RECIPIENT_UNAVAILABLE',
    });
    const after = await getDocument(scope, draft.document.id);
    expect(after.document.status).toBe('draft');
    expect(after.events.some((e) => e.eventType === 'issued')).toBe(false);
    expect(await counterValue(scope.tenantId)).toBe(62);

    dir.failing = false;
    const retried = await issue(scope, draft.document.id, { actorUserId: ACTOR });
    expect(retried.document.document.documentNumber).toBe('62');
    // The retry after success is idempotent too.
    const again = await issue(scope, draft.document.id, { actorUserId: ACTOR });
    expect(again).toMatchObject({ alreadyIssued: true });
    expect(again.document.document.documentNumber).toBe('62');
    expect(await counterValue(scope.tenantId)).toBe(63);
  });
});
