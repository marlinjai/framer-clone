// src/server/books/__tests__/books-immutability.itest.ts
//
// Books plan P1.10: the database refuses every edit of an issued document, as
// the app role (commerce_app) AND as the owner role, so the freeze triggers are
// proven independent of grants. Each case runs once per role.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { Kysely, UpdateObject } from 'kysely';

import type { CommerceDB } from '../../commerce/db-types';
import { createDraft } from '../repository/documents';
import { addLine } from '../repository/lines';
import { issue } from '../issue';
import { toJsonb } from '../snapshots';
import {
  ACTOR,
  FakeDirectory,
  initCompany,
  newCustomer,
  newTenantId,
  openBooksEnv,
  rejectionCode,
  scopeFor,
  type BooksEnv,
} from './booksFixtures';

let env: BooksEnv;

beforeAll(async () => {
  env = await openBooksEnv('books-immutability');
}, 120_000);

afterAll(async () => {
  await env?.close();
});

/** A company with one issued invoice and one draft (both with lines). */
async function company() {
  const dir = new FakeDirectory();
  const scope = scopeFor(env.appDb, env.tgId, newTenantId(), dir);
  await initCompany(scope);
  const { customer } = await newCustomer(scope, dir);
  const issued = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });
  await addLine(scope, issued.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });
  const done = await issue(scope, issued.document.id, { actorUserId: ACTOR });
  const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });
  const draftView = await addLine(scope, draft.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });
  return { scope, issued: done.document, draft: draftView };
}

const roles: Array<[string, () => Kysely<CommerceDB>]> = [
  ['commerce_app', () => env.appDb],
  ['owner', () => env.ownerDb],
];

describe.each(roles)('an issued document is frozen (as %s)', (_role, db) => {
  it('UPDATE of any content column of an issued document raises BK001', async () => {
    const { scope, issued } = await company();
    const id = issued.document.id;
    const update = (set: UpdateObject<CommerceDB, 'sales_document'>) =>
      db().updateTable('sales_document').set(set).where('tenant_id', '=', scope.tenantId).where('id', '=', id).execute();
    expect(await rejectionCode(update({ total: 1 }))).toBe('BK001');
    expect(await rejectionCode(update({ customer_snapshot: toJsonb({ v: 1, name: 'Changed' }) }))).toBe('BK001');
    expect(await rejectionCode(update({ issue_date: '2020-01-01' }))).toBe('BK001');
    expect(await rejectionCode(update({ document_number: '999' }))).toBe('BK001');
  });

  it('INSERT, UPDATE and DELETE of a line of an issued document raise BK001', async () => {
    const { scope, issued } = await company();
    const line = issued.lines[0];
    expect(
      await rejectionCode(
        db()
          .insertInto('sales_document_line')
          .values({
            id: randomUUID(),
            tenant_id: scope.tenantId,
            document_id: issued.document.id,
            position: 2,
            title: 'Smuggled',
            quantity: 1000,
            unit_price: 100,
            subtotal: 100,
            tax_rate: 0,
            tax_amount: 0,
            tax_treatment: 'kleinunternehmer',
            updated_at: new Date(),
          })
          .execute(),
      ),
    ).toBe('BK001');
    expect(
      await rejectionCode(
        db().updateTable('sales_document_line').set({ unit_price: 1 }).where('tenant_id', '=', scope.tenantId).where('id', '=', line.id).execute(),
      ),
    ).toBe('BK001');
    expect(
      await rejectionCode(
        db().deleteFrom('sales_document_line').where('tenant_id', '=', scope.tenantId).where('id', '=', line.id).execute(),
      ),
    ).toBe('BK001');
  });

  it('DELETE of a document raises BK001, for an issued one and for a draft', async () => {
    const { scope, issued, draft } = await company();
    for (const id of [issued.document.id, draft.document.id]) {
      expect(
        await rejectionCode(db().deleteFrom('sales_document').where('tenant_id', '=', scope.tenantId).where('id', '=', id).execute()),
      ).toBe('BK001');
    }
  });

  it('issued -> draft raises BK004; issued -> cancelled without a credit note raises BK004', async () => {
    const { scope, issued } = await company();
    const id = issued.document.id;
    expect(
      await rejectionCode(
        db().updateTable('sales_document').set({ status: 'draft' }).where('tenant_id', '=', scope.tenantId).where('id', '=', id).execute(),
      ),
    ).toBe('BK004');
    expect(
      await rejectionCode(
        db().updateTable('sales_document').set({ status: 'cancelled' }).where('tenant_id', '=', scope.tenantId).where('id', '=', id).execute(),
      ),
    ).toBe('BK004');
  });

  it('rendered_pdf_file_id may be set once and never changed', async () => {
    const { scope, issued } = await company();
    const id = issued.document.id;
    // Since 008 the id must name a stored file of the same company (composite FK).
    const content = Buffer.from('%PDF-1.7 synthetic');
    const fileId = randomUUID();
    await db()
      .insertInto('sales_document_file')
      .values({
        id: fileId,
        tenant_id: scope.tenantId,
        document_id: id,
        content_type: 'application/pdf',
        byte_size: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
        renderer: 'test',
        content,
      })
      .execute();
    await db()
      .updateTable('sales_document')
      .set({ rendered_pdf_file_id: fileId, updated_at: new Date() })
      .where('tenant_id', '=', scope.tenantId)
      .where('id', '=', id)
      .execute();
    expect(
      await rejectionCode(
        db().updateTable('sales_document').set({ rendered_pdf_file_id: 'file-2' }).where('tenant_id', '=', scope.tenantId).where('id', '=', id).execute(),
      ),
    ).toBe('BK001');
    expect(
      await rejectionCode(
        db().updateTable('sales_document').set({ rendered_pdf_file_id: null }).where('tenant_id', '=', scope.tenantId).where('id', '=', id).execute(),
      ),
    ).toBe('BK001');
  });

  it('a counter can never move backwards', async () => {
    const { scope } = await company();
    expect(
      await rejectionCode(
        db()
          .updateTable('document_number_counter')
          .set({ next_value: 5 })
          .where('tenant_id', '=', scope.tenantId)
          .where('doc_type', '=', 'invoice')
          .execute(),
      ),
    ).toBe('BK003');
  });

  it('issuing with totals that disagree with the lines raises BK005', async () => {
    const { scope, draft, issued } = await company();
    const d = draft.document;
    expect(
      await rejectionCode(
        db()
          .updateTable('sales_document')
          .set({
            status: 'issued',
            document_number: 'X-1',
            number_value: 1000,
            issue_date: '2026-10-01',
            issued_at: new Date(),
            customer_snapshot: toJsonb(issued.document.customerSnapshot),
            sender_snapshot: toJsonb(issued.document.senderSnapshot),
            subtotal: d.subtotal + 1,
            total: d.total + 1,
          })
          .where('tenant_id', '=', scope.tenantId)
          .where('id', '=', d.id)
          .execute(),
      ),
    ).toBe('BK005');
  });
});

describe.each(roles)('documents and counters keep their identity (as %s)', (_role, db) => {
  it('a document is inserted as a draft; only an import may arrive issued', async () => {
    const { scope, issued } = await company();
    const d = issued.document;
    const base = {
      tenant_id: scope.tenantId,
      doc_type: 'invoice' as const,
      payment_terms_days: 14,
      customer_id: d.customerId,
      customer_type: d.customerType,
      tax_profile_key: d.taxProfileKey,
      document_number: `X-${randomUUID().slice(0, 8)}`,
      number_value: 900_000 + Math.floor(Math.random() * 1000),
      issue_date: d.issueDate,
      issued_at: new Date(),
      customer_snapshot: toJsonb(d.customerSnapshot),
      sender_snapshot: toJsonb(d.senderSnapshot),
      updated_at: new Date(),
    };
    expect(
      await rejectionCode(db().insertInto('sales_document').values({ ...base, id: randomUUID(), status: 'issued' }).execute()),
    ).toBe('BK004');
    // The import path: allowed when it carries its number and snapshots.
    await db().insertInto('sales_document').values({ ...base, id: randomUUID(), status: 'issued', source: 'import' }).execute();
  });

  it('a draft cannot become an import, change its type or move to another company', async () => {
    const { scope, draft } = await company();
    const update = (set: UpdateObject<CommerceDB, 'sales_document'>) =>
      db().updateTable('sales_document').set(set).where('tenant_id', '=', scope.tenantId).where('id', '=', draft.document.id).execute();
    expect(await rejectionCode(update({ source: 'import' }))).toBe('BK001');
    expect(await rejectionCode(update({ doc_type: 'offer' }))).toBe('BK001');
    expect(await rejectionCode(update({ tenant_id: newTenantId() }))).toBe('BK001');
  });

  it('a counter row cannot be deleted and re-inserted, nor moved', async () => {
    const { scope } = await company();
    const del = db()
      .deleteFrom('document_number_counter')
      .where('tenant_id', '=', scope.tenantId)
      .where('doc_type', '=', 'invoice')
      .execute();
    // commerce_app has no DELETE (the REVOKE); the owner is stopped by the trigger.
    expect(await rejectionCode(del)).toBe(_role === 'owner' ? 'BK003' : '42501');
    expect(
      await rejectionCode(
        db()
          .insertInto('document_number_counter')
          .values({ tenant_id: scope.tenantId, doc_type: 'invoice', next_value: 1, format: '{n}', updated_at: new Date() })
          .execute(),
      ),
    ).toBe('23505');
    expect(
      await rejectionCode(
        db()
          .updateTable('document_number_counter')
          .set({ tenant_id: newTenantId() })
          .where('tenant_id', '=', scope.tenantId)
          .where('doc_type', '=', 'invoice')
          .execute(),
      ),
    ).toBe('BK003');
  });
});

describe('TRUNCATE is refused on every frozen Books table (as owner)', () => {
  it('sales_document, sales_document_line and document_number_counter raise BK001 / BK003', async () => {
    await company();
    const o = env.fx.owner;
    // A cascade also reaches the lines and events; whichever trigger fires first refuses it.
    expect(['BK001', 'BK002']).toContain(await rejectionCode(o`TRUNCATE ${o(env.schema)}.sales_document CASCADE`));
    expect(await rejectionCode(o`TRUNCATE ${o(env.schema)}.sales_document_line`)).toBe('BK001');
    expect(await rejectionCode(o`TRUNCATE ${o(env.schema)}.document_number_counter`)).toBe('BK003');
    // A cascade from the customer table reaches the documents and is refused there.
    expect(['BK001', 'BK002']).toContain(await rejectionCode(o`TRUNCATE ${o(env.schema)}.customer CASCADE`));
  });
});

describe('the event log is append-only', () => {
  it('UPDATE, DELETE and TRUNCATE on sales_document_event raise BK002', async () => {
    const { scope, issued } = await company();
    const eventId = issued.events[0].id;
    // The owner: the trigger refuses all three.
    expect(
      await rejectionCode(
        env.ownerDb.updateTable('sales_document_event').set({ actor_user_id: null }).where('tenant_id', '=', scope.tenantId).where('id', '=', eventId).execute(),
      ),
    ).toBe('BK002');
    expect(
      await rejectionCode(env.ownerDb.deleteFrom('sales_document_event').where('tenant_id', '=', scope.tenantId).where('id', '=', eventId).execute()),
    ).toBe('BK002');
    expect(await rejectionCode(env.fx.owner`TRUNCATE ${env.fx.owner(env.schema)}.sales_document_event CASCADE`)).toBe('BK002');
    // commerce_app never gets that far: the REVOKE denies it first (42501).
    expect(
      await rejectionCode(env.appDb.deleteFrom('sales_document_event').where('tenant_id', '=', scope.tenantId).where('id', '=', eventId).execute()),
    ).toBe('42501');
  });
});
