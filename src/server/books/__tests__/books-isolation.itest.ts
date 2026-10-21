// src/server/books/__tests__/books-isolation.itest.ts
//
// Books plan P1.10: two companies in ONE tenant group schema. The cross-schema
// wall is already proven by the commerce isolation specs; here one smoke check
// covers it, and the rest proves the company wall inside a schema: the
// repository scope (every query filters tenant_id) and the composite foreign
// keys behind it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgresQueryCompiler,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryResult,
  type RootOperationNode,
  type UnknownRow,
} from 'kysely';

import { cancelInvoice } from '../cancel';
import { archiveCustomer, getCustomer, listCustomers, updateCustomerTaxFields } from '../repository/customers';
import { createDraft, setCustomer, updateDraft } from '../repository/documents';
import { addLine, removeLine, reorderLines, updateLine } from '../repository/lines';
import { getDocument, listDocuments } from '../repository/read';
import { issue } from '../issue';
import type { BooksScope } from '../scope';
import {
  ACTOR,
  FakeDirectory,
  initCompany,
  newCustomer,
  newTenantId,
  openBooksEnv,
  provisionAnotherGroup,
  rejectionCode,
  scopeFor,
  type BooksEnv,
} from './booksFixtures';

let env: BooksEnv;

beforeAll(async () => {
  env = await openBooksEnv('books-isolation');
}, 120_000);

afterAll(async () => {
  await env?.close();
});

/** A company with a customer, a draft with two lines, and an issued invoice. */
async function company(dir: FakeDirectory, scopeDb = env.appDb, invoiceNext = 62) {
  const scope = scopeFor(scopeDb, env.tgId, newTenantId(), dir);
  await initCompany(scope, { invoiceNext });
  const { customer } = await newCustomer(scope, dir);
  const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });
  await addLine(scope, draft.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });
  const draftView = await addLine(scope, draft.document.id, { title: 'Book', quantity: 1000, unitPrice: 2000 });
  const toIssue = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });
  await addLine(scope, toIssue.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });
  const issued = await issue(scope, toIssue.document.id, { actorUserId: ACTOR });
  return { scope, customer, draft: draftView, issued: issued.document };
}

describe('Books isolation: two companies in one tenant group schema', () => {
  it('company A cannot read, list, edit, issue or cancel company B\'s documents', async () => {
    const dir = new FakeDirectory();
    const a = await company(dir);
    const b = await company(dir);
    const bDraft = b.draft.document.id;
    const bLine = b.draft.lines[0].id;
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ['getDocument', () => getDocument(a.scope, bDraft)],
      ['getDocument issued', () => getDocument(a.scope, b.issued.document.id)],
      ['updateDraft', () => updateDraft(a.scope, bDraft, { introText: 'hello' })],
      ['setCustomer', () => setCustomer(a.scope, bDraft, { customerId: a.customer.id, actorUserId: ACTOR })],
      ['addLine', () => addLine(a.scope, bDraft, { title: 'x', quantity: 1000, unitPrice: 1 })],
      ['updateLine', () => updateLine(a.scope, bDraft, bLine, { quantity: 2000 })],
      ['reorderLines', () => reorderLines(a.scope, bDraft, { lineIds: b.draft.lines.map((l) => l.id).reverse() })],
      ['removeLine', () => removeLine(a.scope, bDraft, bLine)],
      ['issue', () => issue(a.scope, bDraft, { actorUserId: ACTOR })],
      ['cancelInvoice', () => cancelInvoice(a.scope, b.issued.document.id, { actorUserId: ACTOR, reason: 'x' })],
      ['getCustomer', () => getCustomer(a.scope, b.customer.id)],
      ['updateCustomerTaxFields', () => updateCustomerTaxFields(a.scope, b.customer.id, { taxNumber: '1' })],
      ['archiveCustomer', () => archiveCustomer(a.scope, b.customer.id)],
    ];
    for (const [name, attempt] of attempts) {
      expect([name, await rejectionCode(attempt())]).toEqual([name, 'NOT_FOUND']);
    }
    // B's rows are untouched.
    const bView = await getDocument(b.scope, bDraft);
    expect(bView.document.version).toBe(b.draft.document.version);
    expect(bView.lines).toEqual(b.draft.lines);

    const listed = await listDocuments(a.scope, { limit: 100 });
    expect(listed.items.length).toBeGreaterThan(0);
    expect(listed.items.every((d) => d.tenantId === a.scope.tenantId)).toBe(true);
    const customers = await listCustomers(a.scope, { includeArchived: true });
    expect(customers.items.map((c) => c.id)).toEqual([a.customer.id]);
    // The totals count only the company's own rows too.
    expect(listed.total).toBe(listed.items.length);
    expect(customers.total).toBe(1);
  });

  it('company A cannot attach company B\'s customer', async () => {
    const dir = new FakeDirectory();
    const a = await company(dir);
    const b = await company(dir);
    await expect(
      setCustomer(a.scope, a.draft.document.id, { customerId: b.customer.id, actorUserId: ACTOR }),
    ).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
    await expect(
      createDraft(a.scope, { docType: 'invoice', actorUserId: ACTOR, customerId: b.customer.id }),
    ).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
    // The composite foreign key is the backstop when the application is bypassed.
    expect(
      await rejectionCode(
        env.ownerDb
          .updateTable('sales_document')
          .set({ customer_id: b.customer.id })
          .where('tenant_id', '=', a.scope.tenantId)
          .where('id', '=', a.draft.document.id)
          .execute(),
      ),
    ).toBe('23503');
  });

  it('counters are per company', async () => {
    const dir = new FakeDirectory();
    const a = await company(dir, env.appDb, 62);
    const b = await company(dir, env.appDb, 1);
    expect(a.issued.document.documentNumber).toBe('62');
    expect(b.issued.document.documentNumber).toBe('1');
    const next = await issue(a.scope, a.draft.document.id, { actorUserId: ACTOR });
    expect(next.document.document.documentNumber).toBe('63');
    const counters = await env.ownerDb
      .selectFrom('document_number_counter')
      .select(['tenant_id', 'next_value'])
      .where('doc_type', '=', 'invoice')
      .where('tenant_id', 'in', [a.scope.tenantId, b.scope.tenantId])
      .execute();
    expect(Object.fromEntries(counters.map((c) => [c.tenant_id, Number(c.next_value)]))).toEqual({
      [a.scope.tenantId]: 64,
      [b.scope.tenantId]: 2,
    });
  });

  it('smoke: a scope on tg_b sees nothing of tg_a', async () => {
    const dir = new FakeDirectory();
    const a = await company(dir);
    const groupB = await provisionAnotherGroup(env, 'books-isolation-b');
    const onB = scopeFor(groupB.appDb, groupB.tgId, a.scope.tenantId, dir);
    await expect(getDocument(onB, a.issued.document.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await listDocuments(onB)).items).toEqual([]);
    await expect(getCustomer(onB, a.customer.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('every Books query carries tenant_id', async () => {
    const BOOKS_TABLES = new Set([
      'books_company_settings',
      'customer',
      'document_number_counter',
      'document_template',
      'sales_document',
      'sales_document_event',
      'sales_document_line',
    ]);
    const compiler = new PostgresQueryCompiler();
    const captured: string[] = [];
    const logger: KyselyPlugin = {
      transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
        captured.push(compiler.compileQuery(args.node).sql);
        return args.node;
      },
      async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
        return args.result;
      },
    };
    const dir = new FakeDirectory();
    const logged = env.appDb.withPlugin(logger);
    const { scope, customer, draft, issued } = await company(dir, logged);
    const s: BooksScope = scope;
    const lines = draft.lines;
    await updateLine(s, draft.document.id, lines[1].id, { quantity: 2000 });
    await reorderLines(s, draft.document.id, { lineIds: [lines[1].id, lines[0].id] });
    await removeLine(s, draft.document.id, lines[0].id);
    await updateDraft(s, draft.document.id, { netOrGross: 'gross' });
    const { customer: other } = await newCustomer(s, dir);
    await setCustomer(s, draft.document.id, { customerId: other.id, actorUserId: ACTOR });
    await getDocument(s, draft.document.id);
    await listDocuments(s, { docType: 'invoice', limit: 1 });
    await listCustomers(s);
    await getCustomer(s, customer.id);
    await updateCustomerTaxFields(s, customer.id, { taxNumber: '99/999/99999' });
    await archiveCustomer(s, other.id);
    await cancelInvoice(s, issued.document.id, { actorUserId: ACTOR, reason: 'Isolation check' });

    const checked: string[] = [];
    for (const text of captured) {
      const kind = /^\s*(select|update|delete)\b/i.exec(text)?.[1]?.toLowerCase();
      if (!kind) continue;
      const target = /\b(?:from|update)\s+"[^"]+"\."(\w+)"/i.exec(text)?.[1];
      if (!target || !BOOKS_TABLES.has(target)) continue;
      checked.push(target);
      expect([target, /\bwhere\b[\s\S]*"tenant_id"\s*=\s*\$\d+/i.test(text)]).toEqual([target, true]);
    }
    // The flow really exercised the Books tables.
    for (const table of ['books_company_settings', 'customer', 'document_number_counter', 'sales_document', 'sales_document_event', 'sales_document_line']) {
      expect(checked).toContain(table);
    }
  });

  it('a forged cursor is INVALID_INPUT, never a database error', async () => {
    const dir = new FakeDirectory();
    const { scope } = await company(dir);
    const forge = (c: unknown) => Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
    for (const cursor of [
      'not-base64-json',
      forge({ issueDate: null, createdAt: 'yesterday', id: 'x' }),
      forge({ issueDate: null, createdAt: '2026-13-45 99:99:99', id: 'x' }),
      forge({ issueDate: '2026-02-30', createdAt: '2026-10-01 10:00:00.000', id: 'x' }),
    ]) {
      await expect(listDocuments(scope, { cursor })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    // A cursor the list returned works.
    const first = await listDocuments(scope, { limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    const second = await listDocuments(scope, { limit: 1, cursor: first.nextCursor as string });
    expect(second.items[0].id).not.toBe(first.items[0].id);
  });
});
