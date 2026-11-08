// src/server/books/__tests__/books-mirror.itest.ts
//
// The read-only Books endpoint receipt-ocr-app mirrors its income from
// (src/server/books/machine.ts, repository/mirror.ts) against a real
// provisioned tenant schema, the repository connected as commerce_app. The key
// verification is stubbed (it has its own tests in auth-machine.test.ts); what
// is proven here is the read: only issued invoices and credit notes, in the
// mirror's shape, only the key's company, every document once across pages.
// All data is synthetic.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CompanyKey } from '@/lib/auth-machine';

import { cancelInvoice } from '../cancel';
import { issue } from '../issue';
import { handleMirrorRequest, type MirrorEndpointDeps } from '../machine';
import { createDraft } from '../repository/documents';
import { addLine } from '../repository/lines';
import { listMirrorDocuments, TooManyMirrorDocumentsError, type MirrorDocument } from '../repository/mirror';
import { storeBeforeCommit } from '../render/store';
import type { BooksScope } from '../scope';
import { ACTOR, FakeDirectory, initCompany, newCustomer, newTenantId, openBooksEnv, scopeFor, type BooksEnv } from './booksFixtures';

let env: BooksEnv;

beforeAll(async () => {
  env = await openBooksEnv('books-mirror');
}, 120_000);

afterAll(async () => {
  await env?.close();
});

async function issuedInvoice(scope: BooksScope, customerId: string, unitPrice: number): Promise<string> {
  const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId, serviceDate: '2026-10-01' });
  await addLine(scope, draft.document.id, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice });
  const issued = await issue(scope, draft.document.id, { actorUserId: ACTOR }, { beforeCommit: storeBeforeCommit(scope) });
  return issued.document.document.id;
}

/** A company with two issued invoices (one later cancelled by a credit note) and one open draft. */
async function company() {
  const tenantId = newTenantId();
  const dir = new FakeDirectory();
  const scope = scopeFor(env.appDb, env.tgId, tenantId, dir);
  await initCompany(scope, { taxStatus: 'small_business', invoiceNext: 62 });
  const { customer } = await newCustomer(scope, dir, { customerType: 'b2b' });
  const first = await issuedInvoice(scope, customer.id, 7500);
  const second = await issuedInvoice(scope, customer.id, 3870);
  const cancelled = await cancelInvoice(scope, second, { actorUserId: ACTOR, reason: 'Wrong amount' }, { beforeCommit: storeBeforeCommit(scope) });
  // A draft is no issued invoice and never handed over.
  await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });
  return { tenantId, dir, scope, first, second, creditNoteId: cancelled.creditNote.document.id };
}

const MIRROR_KEYS = [
  'correctsDocumentId',
  'currencyCode',
  'docType',
  'dueDate',
  'id',
  'issueDate',
  'kleinunternehmer',
  'number',
  'replacesDocumentId',
  'reverseCharge',
  'status',
  'taxCents',
  'taxSummary',
  'totalCents',
];

describe('the Books mirror read', () => {
  it('hands over the issued invoices and the credit note in the mirror shape, nothing else', async () => {
    const { scope, first, second, creditNoteId } = await company();
    const { documents, nextCursor } = await listMirrorDocuments(scope);
    expect(nextCursor).toBeNull();
    expect(documents.map((d) => d.id).sort()).toEqual([first, second, creditNoteId].sort());
    for (const d of documents) expect(Object.keys(d).sort()).toEqual(MIRROR_KEYS);

    const byId = new Map(documents.map((d) => [d.id, d]));
    expect(byId.get(first)).toMatchObject({
      docType: 'invoice',
      status: 'issued',
      number: '62',
      currencyCode: 'EUR',
      kleinunternehmer: true,
      reverseCharge: false,
      totalCents: 7500,
      taxCents: 0,
      correctsDocumentId: null,
      replacesDocumentId: null,
    });
    expect(byId.get(first)!.issueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(byId.get(second)).toMatchObject({ status: 'cancelled', number: '63', totalCents: 3870 });
    // The credit note states its own amount positive, over the whole invoice.
    expect(byId.get(creditNoteId)).toMatchObject({
      docType: 'credit_note',
      status: 'issued',
      correctsDocumentId: second,
      totalCents: 3870,
    });
    for (const d of documents) {
      for (const g of d.taxSummary) expect(Object.keys(g).sort()).toEqual(['netCents', 'rateBp', 'taxCents']);
    }
  });

  it('hands over every document in one answer, in the order of issue, with no next page', async () => {
    const { scope, dir, first, second, creditNoteId } = await company();
    // Drafts issued later, also after the documents above, in one statement's answer.
    const { customer } = await newCustomer(scope, dir, { customerType: 'b2b' });
    const later: string[] = [];
    for (let i = 0; i < 3; i += 1) later.push(await issuedInvoice(scope, customer.id, 1000 + i));
    const page = await listMirrorDocuments(scope);
    expect(page.nextCursor).toBeNull();
    const ids = page.documents.map((d) => d.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    // Issue order: the two invoices and the credit note of the cancellation, then the three later invoices.
    expect(ids.slice(0, 3).sort()).toEqual([first, second, creditNoteId].sort());
    expect(ids.slice(3)).toEqual(later);
  });

  it('refuses a cut list: above the cap the read throws instead of answering part of the documents', async () => {
    const { scope } = await company();
    await expect(listMirrorDocuments(scope, { max: 2 })).rejects.toBeInstanceOf(TooManyMirrorDocumentsError);
    expect((await listMirrorDocuments(scope, { max: 3 })).documents).toHaveLength(3);
  });

  it('never shows another company of the same tenant group', async () => {
    const a = await company();
    const b = await company();
    const ids = (await listMirrorDocuments(a.scope)).documents.map((d) => d.id);
    expect(ids).not.toContain(b.first);
    expect(ids).toContain(a.first);
  });

  it('answers through the endpoint for a key of the company, scoped by the key alone', async () => {
    const { tenantId, first } = await company();
    const key: CompanyKey = Object.freeze({
      kind: 'key' as const,
      tenantId,
      companySlug: 'synthetic',
      keyId: 'key_1',
      serviceAccountId: 'sa_1',
      scope: Object.freeze({ workspaceId: 'ws_1', tenantGroupId: env.tgId }),
      workspaceRole: 'admin' as const,
      appGrants: Object.freeze(['sites', 'books']),
    });
    const deps: MirrorEndpointDeps = {
      verify: async () => key,
      tenantDb: async () => env.appDb,
      list: (scope) => listMirrorDocuments(scope),
    };
    // A company id in the query is ignored: the key decides.
    const res = await handleMirrorRequest(
      new Request(`https://app.lumitra.co/api/machine/books/documents?companyId=${newTenantId()}`),
      deps,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { companyId: string; documents: MirrorDocument[]; nextCursor: string | null };
    expect(body.companyId).toBe(tenantId);
    expect(body.documents.map((d) => d.id)).toContain(first);
    expect(JSON.stringify(body)).not.toMatch(/Workshop|name|address/i);
  });
});
