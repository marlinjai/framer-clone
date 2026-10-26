// src/server/books/__tests__/books-migration.itest.ts
//
// Books plan P1.10: the structure of 007_books, proven by behaviour (a write the
// schema must refuse is attempted and refused), in the style of the commerce
// provision.itest.ts probes. Raw writes go through the OWNER-scoped handle, so
// what refuses them is the schema, not a missing grant.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { provisionTenant } from '@marlinjai/tenant-db';

import { commerceProvisionOptions } from '../../commerce/provisioning/provision';
import { createDraft } from '../repository/documents';
import { addLine } from '../repository/lines';
import { getDocument } from '../repository/read';
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
  env = await openBooksEnv('books-migration');
}, 120_000);

afterAll(async () => {
  await env?.close();
});

const BOOKS_TABLES = [
  'books_company_settings',
  'customer',
  'document_number_counter',
  'document_template',
  'sales_document',
  'sales_document_event',
  'sales_document_line',
];

/** A minimal draft row for raw inserts (owner handle). */
function rawDraft(tenantId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    tenant_id: tenantId,
    doc_type: 'invoice' as const,
    payment_terms_days: 14,
    updated_at: new Date(),
    ...overrides,
  };
}

describe('007_books structure', () => {
  it('007 creates the seven tables, enums, constraints and triggers in tg_<id>; re-provision is a no-op', async () => {
    const tables = await env.fx.owner<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = ${env.schema} AND table_name = ANY(${BOOKS_TABLES})
       ORDER BY table_name
    `;
    expect(tables.map((t) => t.table_name)).toEqual(BOOKS_TABLES);
    const triggers = await env.fx.owner<{ tgname: string }[]>`
      SELECT t.tgname FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ${env.schema} AND NOT t.tgisinternal AND c.relname = ANY(${BOOKS_TABLES})
       ORDER BY t.tgname
    `;
    expect(triggers.map((t) => t.tgname)).toEqual([
      'document_number_counter_monotonic',
      'document_number_counter_no_truncate',
      // A draft that never had a number can be deleted with its lines and events.
      'sales_document_draft_delete',
      'sales_document_event_append_only',
      'sales_document_event_no_truncate',
      'sales_document_guard',
      // 009_books_import: an import commits only with its stored original.
      'sales_document_import_complete',
      'sales_document_line_guard',
      'sales_document_line_no_truncate',
      'sales_document_no_truncate',
      // 011_books_replacement: a replacement is issued only with the cancellation it replaces.
      'sales_document_replacement_complete',
      'sales_document_replaces_guard',
    ]);
    const again = await provisionTenant(
      env.fx.owner,
      commerceProvisionOptions(env.tgId, `books-migration-${env.tgId.slice(0, 8)}`),
    );
    expect(again.applied).toEqual([]);
  });

  it('a draft cannot carry a number', async () => {
    const tenantId = newTenantId();
    const code = await rejectionCode(
      env.ownerDb.insertInto('sales_document').values(rawDraft(tenantId, { document_number: '1', number_value: 1 })).execute(),
    );
    expect(code).toBe('23514');
  });

  it('an issued row without snapshots is refused', async () => {
    // Since the review fixes the insert trigger refuses a non-draft editor row
    // first (BK004); the CHECK behind it is proven by an UPDATE to issued below
    // and by the import case.
    const dir = new FakeDirectory();
    const scope = scopeFor(env.appDb, env.tgId, newTenantId(), dir);
    await initCompany(scope);
    const { customer } = await newCustomer(scope, dir);
    const code = await rejectionCode(
      env.ownerDb
        .insertInto('sales_document')
        .values(
          rawDraft(scope.tenantId, {
            status: 'issued',
            customer_id: customer.id,
            customer_type: 'b2b',
            document_number: '1',
            number_value: 1,
            issue_date: '2026-10-01',
            issued_at: new Date(),
            tax_profile_key: 'k',
          }),
        )
        .execute(),
    );
    expect(code).toBe('BK004');
    // The CHECK itself: a draft updated to issued without its snapshots.
    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });
    await addLine(scope, draft.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });
    const row = await env.ownerDb
      .selectFrom('sales_document')
      .select(['subtotal', 'tax_amount'])
      .where('id', '=', draft.document.id)
      .executeTakeFirstOrThrow();
    expect(
      await rejectionCode(
        env.ownerDb
          .updateTable('sales_document')
          .set({
            status: 'issued',
            document_number: 'X-1',
            number_value: 5000,
            issue_date: '2026-10-01',
            issued_at: new Date(),
            subtotal: row.subtotal,
            tax_amount: row.tax_amount,
          })
          .where('id', '=', draft.document.id)
          .execute(),
      ),
    ).toBe('23514');
  });

  it('a credit note without corrects_document_id is refused', async () => {
    const code = await rejectionCode(
      env.ownerDb.insertInto('sales_document').values(rawDraft(newTenantId(), { doc_type: 'credit_note' })).execute(),
    );
    expect(code).toBe('23514');
  });

  it('an import carries its number and snapshots and is never a draft', async () => {
    const tenantId = newTenantId();
    // Issued import without number or snapshots. Since 009 an issued import writes
    // its lines first (the line's foreign key deferred), so the line is there and
    // the CHECK is what refuses it.
    const id = randomUUID();
    expect(
      await rejectionCode(
        env.ownerDb.transaction().execute(async (trx) => {
          await sql`SET CONSTRAINTS ALL DEFERRED`.execute(trx);
          await trx
            .insertInto('sales_document_line')
            .values({
              id: randomUUID(), tenant_id: tenantId, document_id: id, position: 1, kind: 'service', title: 'Synthetic line',
              quantity: 1000, unit_price: 0, subtotal: 0, tax_rate: 0, tax_amount: 0, tax_treatment: 'kleinunternehmer', updated_at: new Date(),
            })
            .execute();
          await trx.insertInto('sales_document').values(rawDraft(tenantId, { id, status: 'issued', source: 'import' })).execute();
        }),
      ),
    ).toBe('23514');
    // An import that claims to be a draft.
    expect(
      await rejectionCode(env.ownerDb.insertInto('sales_document').values(rawDraft(tenantId, { source: 'import' })).execute()),
    ).toBe('23514');
  });

  it('JSONB columns hold the shape they promise', async () => {
    const tenantId = newTenantId();
    // A tax summary that is not a list.
    expect(
      await rejectionCode(
        env.ownerDb.insertInto('sales_document').values(rawDraft(tenantId, { tax_summary: toJsonb({ not: 'a list' }) })).execute(),
      ),
    ).toBe('23514');
    // A sender block that is a JSON string instead of an object.
    expect(
      await rejectionCode(
        env.ownerDb
          .insertInto('books_company_settings')
          .values({ tenant_id: tenantId, exemption_note: 'n', sender_block: toJsonb('a string'), updated_at: new Date() })
          .execute(),
      ),
    ).toBe('23514');
  });

  it('reverse charge on b2c is refused', async () => {
    const code = await rejectionCode(
      env.ownerDb
        .insertInto('sales_document')
        .values(
          rawDraft(newTenantId(), {
            reverse_charge: true,
            kleinunternehmer: false,
            customer_type: 'b2c',
            vat_id: 'FR12345678901',
          }),
        )
        .execute(),
    );
    expect(code).toBe('23514');
  });

  it('composite FKs refuse cross-company references in one schema', async () => {
    const dirA = new FakeDirectory();
    const a = scopeFor(env.appDb, env.tgId, newTenantId(), dirA);
    await initCompany(a);
    const { customer: customerA } = await newCustomer(a, dirA);
    const draftA = await createDraft(a, { docType: 'invoice', actorUserId: ACTOR, customerId: customerA.id });
    const tenantB = newTenantId();

    // A document of company B pointing at company A's customer.
    expect(
      await rejectionCode(
        env.ownerDb.insertInto('sales_document').values(rawDraft(tenantB, { customer_id: customerA.id })).execute(),
      ),
    ).toBe('23503');
    // A line of company B on company A's document.
    expect(
      await rejectionCode(
        env.ownerDb
          .insertInto('sales_document_line')
          .values({
            id: randomUUID(),
            tenant_id: tenantB,
            document_id: draftA.document.id,
            position: 1,
            title: 'Cross-company',
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
    ).toBe('23503');
    // An event of company B on company A's document.
    expect(
      await rejectionCode(
        env.ownerDb
          .insertInto('sales_document_event')
          .values({
            id: randomUUID(),
            tenant_id: tenantB,
            document_id: draftA.document.id,
            event_type: 'draft_created',
            payload: toJsonb({}),
          })
          .execute(),
      ),
    ).toBe('23503');
  });

  it('the deferred position constraint allows swapping two positions in one transaction', async () => {
    const dir = new FakeDirectory();
    const scope = scopeFor(env.appDb, env.tgId, newTenantId(), dir);
    await initCompany(scope);
    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR });
    await addLine(scope, draft.document.id, { title: 'First', quantity: 1000, unitPrice: 100 });
    const view = await addLine(scope, draft.document.id, { title: 'Second', quantity: 1000, unitPrice: 200 });
    const [first, second] = view.lines;
    await env.appDb.transaction().execute(async (trx) => {
      await trx.updateTable('sales_document_line').set({ position: 2 }).where('tenant_id', '=', scope.tenantId).where('id', '=', first.id).execute();
      await trx.updateTable('sales_document_line').set({ position: 1 }).where('tenant_id', '=', scope.tenantId).where('id', '=', second.id).execute();
    });
    const after = await getDocument(scope, draft.document.id);
    expect(after.lines.map((l) => l.title)).toEqual(['Second', 'First']);
    // Outside a transaction that resolves it, a duplicate position is still refused.
    expect(
      await rejectionCode(
        env.appDb.updateTable('sales_document_line').set({ position: 1 }).where('tenant_id', '=', scope.tenantId).where('id', '=', first.id).execute(),
      ),
    ).toBe('23505');
  });

  it('DATE columns round-trip as YYYY-MM-DD', async () => {
    const dir = new FakeDirectory();
    const scope = scopeFor(env.appDb, env.tgId, newTenantId(), dir);
    await initCompany(scope);
    const draft = await createDraft(scope, {
      docType: 'invoice',
      actorUserId: ACTOR,
      serviceDate: '2026-12-31',
      servicePeriod: { start: '2026-01-01', end: '2026-12-31' },
    });
    const read = await getDocument(scope, draft.document.id);
    expect(read.document.serviceDate).toBe('2026-12-31');
    expect(read.document.servicePeriodStart).toBe('2026-01-01');
    expect(read.document.servicePeriodEnd).toBe('2026-12-31');
  });

  it('the event REVOKE survives provisioning grants', async () => {
    const dir = new FakeDirectory();
    const scope = scopeFor(env.appDb, env.tgId, newTenantId(), dir);
    await initCompany(scope);
    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR });
    const eventId = draft.events[0].id;
    // As commerce_app: the REVOKE (re-applied after the grants) denies it.
    expect(
      await rejectionCode(
        env.appDb.updateTable('sales_document_event').set({ actor_user_id: null }).where('tenant_id', '=', scope.tenantId).where('id', '=', eventId).execute(),
      ),
    ).toBe('42501');
    // As the owner: the trigger still refuses it.
    expect(
      await rejectionCode(
        env.ownerDb.updateTable('sales_document_event').set({ actor_user_id: null }).where('tenant_id', '=', scope.tenantId).where('id', '=', eventId).execute(),
      ),
    ).toBe('BK002');
    const privileges = await env.fx.owner<{ upd: boolean; del: boolean; ins: boolean }[]>`
      SELECT has_table_privilege('commerce_app', ${`${env.schema}.sales_document_event`}, 'UPDATE') AS upd,
             has_table_privilege('commerce_app', ${`${env.schema}.sales_document_event`}, 'DELETE') AS del,
             has_table_privilege('commerce_app', ${`${env.schema}.sales_document_event`}, 'INSERT') AS ins
    `;
    expect(privileges[0]).toEqual({ upd: false, del: false, ins: true });
  });
});
