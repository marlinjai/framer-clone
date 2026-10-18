// src/server/books/__tests__/books-concurrency.itest.ts
//
// Books plan P1.10: numbering under concurrency. Parallel calls run on separate
// pooled connections of the commerce_app base, so the document and counter row
// locks really serialize them.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cancelInvoice } from '../cancel';
import { createDraft } from '../repository/documents';
import { addLine } from '../repository/lines';
import { getDocument } from '../repository/read';
import { issue } from '../issue';
import type { BooksScope } from '../scope';
import {
  ACTOR,
  FakeDirectory,
  initCompany,
  newCustomer,
  newTenantId,
  openBooksEnv,
  scopeFor,
  type BooksEnv,
} from './booksFixtures';

let env: BooksEnv;

beforeAll(async () => {
  env = await openBooksEnv('books-concurrency');
}, 120_000);

afterAll(async () => {
  await env?.close();
});

async function company(invoiceNext = 62) {
  const dir = new FakeDirectory();
  const scope = scopeFor(env.appDb, env.tgId, newTenantId(), dir);
  await initCompany(scope, { invoiceNext });
  const { customer } = await newCustomer(scope, dir);
  return { scope, customerId: customer.id };
}

async function billableDraft(scope: BooksScope, customerId: string): Promise<string> {
  const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId });
  await addLine(scope, draft.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });
  return draft.document.id;
}

async function counterValue(tenantId: string, docType: 'invoice' | 'credit_note' = 'invoice'): Promise<number> {
  const row = await env.ownerDb
    .selectFrom('document_number_counter')
    .select('next_value')
    .where('tenant_id', '=', tenantId)
    .where('doc_type', '=', docType)
    .executeTakeFirstOrThrow();
  return Number(row.next_value);
}

describe('Books numbering under concurrency', () => {
  it('two parallel issues of different drafts get consecutive distinct numbers', async () => {
    const { scope, customerId } = await company();
    const a = await billableDraft(scope, customerId);
    const b = await billableDraft(scope, customerId);
    const results = await Promise.all([issue(scope, a, { actorUserId: ACTOR }), issue(scope, b, { actorUserId: ACTOR })]);
    expect(results.map((r) => r.alreadyIssued)).toEqual([false, false]);
    expect(results.map((r) => r.document.document.numberValue).sort()).toEqual([62, 63]);
    expect(await counterValue(scope.tenantId)).toBe(64);
  });

  it('two parallel issues of the same draft allocate one number', async () => {
    const { scope, customerId } = await company();
    const id = await billableDraft(scope, customerId);
    const results = await Promise.all([issue(scope, id, { actorUserId: ACTOR }), issue(scope, id, { actorUserId: ACTOR })]);
    expect(results.map((r) => r.document.document.documentNumber)).toEqual(['62', '62']);
    expect(results.map((r) => r.alreadyIssued).sort()).toEqual([false, true]);
    expect(await counterValue(scope.tenantId)).toBe(63);
    const view = await getDocument(scope, id);
    expect(view.events.filter((e) => e.eventType === 'issued')).toHaveLength(1);
  });

  it('a rolled-back issue leaves no gap', async () => {
    const { scope, customerId } = await company();
    const id = await billableDraft(scope, customerId);
    await expect(
      issue(scope, id, { actorUserId: ACTOR }, {
        afterCounterUpdate: () => {
          throw new Error('synthetic fault after the counter update');
        },
      }),
    ).rejects.toThrow(/synthetic fault/);
    expect(await counterValue(scope.tenantId)).toBe(62);
    expect((await getDocument(scope, id)).document.status).toBe('draft');
    const retried = await issue(scope, id, { actorUserId: ACTOR });
    expect(retried.document.document.numberValue).toBe(62);
  });

  it('two companies issue in parallel without contending', async () => {
    const a = await company(62);
    const b = await company(1);
    const da = await billableDraft(a.scope, a.customerId);
    const db = await billableDraft(b.scope, b.customerId);
    const [ra, rb] = await Promise.all([
      issue(a.scope, da, { actorUserId: ACTOR }),
      issue(b.scope, db, { actorUserId: ACTOR }),
    ]);
    expect(ra.document.document.documentNumber).toBe('62');
    expect(rb.document.document.documentNumber).toBe('1');
    expect(await counterValue(a.scope.tenantId)).toBe(63);
    expect(await counterValue(b.scope.tenantId)).toBe(2);
  });

  it('two parallel cancellations create one credit note', async () => {
    const { scope, customerId } = await company();
    const id = await billableDraft(scope, customerId);
    await issue(scope, id, { actorUserId: ACTOR });
    const results = await Promise.all([
      cancelInvoice(scope, id, { actorUserId: ACTOR, reason: 'First click' }),
      cancelInvoice(scope, id, { actorUserId: ACTOR, reason: 'Second click' }),
    ]);
    expect(results.map((r) => r.alreadyCancelled).sort()).toEqual([false, true]);
    expect(results[0].creditNote.document.id).toBe(results[1].creditNote.document.id);
    expect(await counterValue(scope.tenantId, 'credit_note')).toBe(2);
    const creditNotes = await env.ownerDb
      .selectFrom('sales_document')
      .select('id')
      .where('tenant_id', '=', scope.tenantId)
      .where('corrects_document_id', '=', id)
      .execute();
    expect(creditNotes).toHaveLength(1);
  });
});
