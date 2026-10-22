// src/server/books/__tests__/books-correct.itest.ts
//
// The Correct flow (plan docs/plans/2026-10-21-books-visual-template-composer.md,
// decision 9, phase 1; migration 011_books_replacement) against a real
// provisioned tenant schema, the repository connected as commerce_app, a fake
// contacts directory and the real PDF pipeline (every issued document's PDF is
// rendered, checked and stored inside its transaction, as the routes do).
//
// The four stateful-flow paths (knowledge-base stateful-flow-testing.md):
//   1. forward: Correct, edit, issue: the credit note, the cancellation and the
//      replacement commit together, with their numbers, links, events and PDFs;
//   2. backtrack and revise: a changed customer on the replacement leaves the
//      credit note with the old recipient; an abandoned draft cancels nothing
//      and a second Correct reopens it; a detached draft issues as an ordinary
//      invoice;
//   3. resume: the link survives a fresh read; a failure at the last step rolls
//      everything back (nothing cancelled, no number taken);
//   4. re-entry: a replacement can be corrected again (a chain); a cancelled
//      invoice cannot; a cancellation racing an open replacement is refused at
//      issue and the draft can still be issued as an ordinary invoice.
// Plus what 011 guarantees in the database whatever the code does. All data is
// synthetic.

import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cancelInvoice } from '../cancel';
import { startCorrection } from '../correct';
import { importHistoricalInvoice, newImportSession, type HistoricalInvoiceInput } from '../importInvoices';
import { issue, REPLACEMENT_CANCEL_REASON } from '../issue';
import { createDraft, setCustomer, updateDraft } from '../repository/documents';
import { addLine, updateLine } from '../repository/lines';
import { getDocument } from '../repository/read';
import { extractPdfText } from '../render/extractText';
import { storeBeforeCommit } from '../render/store';
import { createTemplate, deleteTemplate } from '../repository/templates';
import type { BooksScope } from '../scope';
import { toJsonb } from '../snapshots';
import {
  ACTOR,
  FakeContactBook,
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
  env = await openBooksEnv('books-correct');
}, 120_000);

afterAll(async () => {
  await env?.close();
});

async function counter(tenantId: string, docType: 'invoice' | 'credit_note'): Promise<number> {
  const row = await env.ownerDb
    .selectFrom('document_number_counter')
    .select('next_value')
    .where('tenant_id', '=', tenantId)
    .where('doc_type', '=', docType)
    .executeTakeFirstOrThrow();
  return Number(row.next_value);
}

async function fileCount(tenantId: string): Promise<number> {
  const row = await env.ownerDb
    .selectFrom('sales_document_file')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('tenant_id', '=', tenantId)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/** A company with one customer and one issued invoice (number 62), its PDF stored. */
async function companyWithInvoice() {
  const tenantId = newTenantId();
  const dir = new FakeDirectory();
  const scope = scopeFor(env.appDb, env.tgId, tenantId, dir);
  await initCompany(scope, { taxStatus: 'small_business', invoiceNext: 62 });
  const { customer, contact } = await newCustomer(scope, dir, { customerType: 'b2b' });
  const draft = await createDraft(scope, {
    docType: 'invoice',
    actorUserId: ACTOR,
    customerId: customer.id,
    serviceDate: '2026-10-01',
    introText: 'Thank you for the order.',
  });
  await addLine(scope, draft.document.id, { kind: 'service', title: 'Workshop', quantity: 1500, unitPrice: 8000 });
  await addLine(scope, draft.document.id, { kind: 'text', title: 'Note for the record' });
  const issued = await issue(scope, draft.document.id, { actorUserId: ACTOR }, { beforeCommit: storeBeforeCommit(scope) });
  return { tenantId, dir, scope, customer, contact, invoiceId: issued.document.document.id };
}

/** Issue with the routes' PDF hook. */
function issueWithPdf(scope: BooksScope, id: string, expectedVersion?: number) {
  return issue(scope, id, { actorUserId: ACTOR, expectedVersion }, { beforeCommit: storeBeforeCommit(scope) });
}

describe('the Correct flow', () => {
  it('forward: Correct, edit a line, issue: credit note, cancellation and replacement commit together', async () => {
    const { tenantId, scope, customer, invoiceId } = await companyWithInvoice();
    const original = await getDocument(scope, invoiceId);
    expect(original.document.documentNumber).toBe('62');

    const started = await startCorrection(scope, invoiceId, { actorUserId: ACTOR });
    expect(started.existing).toBe(false);
    const draft = started.document;
    const draftId = draft.document.id;
    expect(draft.document).toMatchObject({
      status: 'draft',
      docType: 'invoice',
      source: 'editor',
      replacesDocumentId: invoiceId,
      customerId: customer.id,
      serviceDate: '2026-10-01',
      introText: 'Thank you for the order.',
      documentNumber: null,
      total: original.document.total,
    });
    expect(draft.lines.map((l) => [l.position, l.kind, l.title, l.quantity, l.unitPrice])).toEqual(
      original.lines.map((l) => [l.position, l.kind, l.title, l.quantity, l.unitPrice]),
    );
    expect(draft.events[0]).toMatchObject({ eventType: 'draft_created', payload: { replacesDocumentId: invoiceId } });
    expect(draft.related.replaces).toMatchObject({ id: invoiceId, documentNumber: '62', status: 'issued' });
    // Nothing is cancelled by starting a correction.
    expect((await getDocument(scope, invoiceId)).document.status).toBe('issued');
    expect((await getDocument(scope, invoiceId)).related.replacedBy).toMatchObject({ id: draftId, status: 'draft' });

    const workshop = draft.lines.find((l) => l.kind !== 'text')!;
    const edited = await updateLine(scope, draftId, workshop.id, { quantity: 2000, expectedVersion: draft.document.version });

    const result = await issueWithPdf(scope, draftId, edited.document.version);
    expect(result.alreadyIssued).toBe(false);
    expect(result.replaced?.invoiceId).toBe(invoiceId);
    const creditNoteId = result.replaced!.creditNoteId;

    const replacement = await getDocument(scope, draftId);
    expect(replacement.document).toMatchObject({ status: 'issued', documentNumber: '63', total: 16000 });
    expect(replacement.document.renderedPdfFileId).not.toBeNull();
    expect(replacement.events.at(-1)).toMatchObject({
      eventType: 'issued',
      payload: { replacesDocumentId: invoiceId, creditNoteId },
    });

    const creditNote = await getDocument(scope, creditNoteId);
    expect(creditNote.document).toMatchObject({
      docType: 'credit_note',
      status: 'issued',
      documentNumber: 'GS-1',
      correctsDocumentId: invoiceId,
      total: original.document.total,
    });
    expect(creditNote.document.renderedPdfFileId).not.toBeNull();

    const old = await getDocument(scope, invoiceId);
    expect(old.document.status).toBe('cancelled');
    expect(old.events.at(-1)).toMatchObject({
      eventType: 'cancelled',
      payload: { creditNoteId, reason: REPLACEMENT_CANCEL_REASON, replacedByDocumentId: draftId },
    });
    // The links, both ways.
    expect(old.related).toMatchObject({
      correctedBy: { id: creditNoteId, documentNumber: 'GS-1' },
      replacedBy: { id: draftId, documentNumber: '63', status: 'issued' },
      corrects: null,
      replaces: null,
    });
    expect(replacement.related.replaces).toMatchObject({ id: invoiceId, status: 'cancelled' });
    expect(creditNote.related.corrects).toMatchObject({ id: invoiceId });

    // Each number used once, three stored documents of record.
    expect(await counter(tenantId, 'invoice')).toBe(64);
    expect(await counter(tenantId, 'credit_note')).toBe(2);
    expect(await fileCount(tenantId)).toBe(3);
  });

  it('backtrack and revise: a new customer on the replacement leaves the credit note with the old recipient', async () => {
    const { dir, scope, contact, invoiceId } = await companyWithInvoice();
    const { customer: other } = await newCustomer(scope, dir, { customerType: 'b2b', contact: { name: 'Other Client AG' } });
    const { document: draft } = await startCorrection(scope, invoiceId, { actorUserId: ACTOR });
    const moved = await setCustomer(scope, draft.document.id, {
      customerId: other.id,
      actorUserId: ACTOR,
      expectedVersion: draft.document.version,
    });
    const result = await issueWithPdf(scope, draft.document.id, moved.document.version);
    const creditNote = await getDocument(scope, result.replaced!.creditNoteId);
    expect(creditNote.document.customerSnapshot?.name).toBe(contact.name);
    expect((await getDocument(scope, draft.document.id)).document.customerSnapshot?.name).toBe('Other Client AG');
  });

  it('backtrack: an abandoned replacement cancels nothing, and a second Correct reopens the same draft', async () => {
    const { tenantId, scope, invoiceId } = await companyWithInvoice();
    const first = await startCorrection(scope, invoiceId, { actorUserId: ACTOR });
    const second = await startCorrection(scope, invoiceId, { actorUserId: ACTOR });
    expect(second.existing).toBe(true);
    expect(second.document.document.id).toBe(first.document.document.id);
    expect((await getDocument(scope, invoiceId)).document.status).toBe('issued');
    expect(await counter(tenantId, 'invoice')).toBe(63);
    expect(await counter(tenantId, 'credit_note')).toBe(1);
  });

  it('backtrack: a detached replacement issues as an ordinary invoice and cancels nothing', async () => {
    const { tenantId, scope, invoiceId } = await companyWithInvoice();
    const { document: draft } = await startCorrection(scope, invoiceId, { actorUserId: ACTOR });
    const detached = await updateDraft(scope, draft.document.id, {
      replacesDocumentId: null,
      expectedVersion: draft.document.version,
    });
    expect(detached.document.replacesDocumentId).toBeNull();
    const result = await issueWithPdf(scope, draft.document.id, detached.document.version);
    expect(result.replaced).toBeUndefined();
    expect(result.document.document.documentNumber).toBe('63');
    expect((await getDocument(scope, invoiceId)).document.status).toBe('issued');
    expect(await counter(tenantId, 'credit_note')).toBe(1);
    // The invoice can be corrected again, since the detached draft no longer replaces it.
    expect((await startCorrection(scope, invoiceId, { actorUserId: ACTOR })).existing).toBe(false);
  });

  it('resume: the link and its banner data survive a fresh read', async () => {
    const { scope, invoiceId } = await companyWithInvoice();
    const { document: draft } = await startCorrection(scope, invoiceId, { actorUserId: ACTOR });
    const reread = await getDocument(scope, draft.document.id);
    expect(reread.document.replacesDocumentId).toBe(invoiceId);
    expect(reread.related.replaces).toMatchObject({ id: invoiceId, documentNumber: '62' });
  });

  it('resume after failure: a failure at the last step rolls back the credit note and the cancellation too', async () => {
    const { tenantId, scope, invoiceId } = await companyWithInvoice();
    const { document: draft } = await startCorrection(scope, invoiceId, { actorUserId: ACTOR });
    const filesBefore = await fileCount(tenantId);
    const store = storeBeforeCommit(scope);
    let calls = 0;
    await expect(
      issue(scope, draft.document.id, { actorUserId: ACTOR }, {
        beforeCommit: async (trx, view) => {
          calls += 1;
          // The credit note's PDF is stored; the replacement's render then fails.
          if (view.document.docType === 'credit_note') return store(trx, view);
          throw new Error('render failed');
        },
      }),
    ).rejects.toThrow('render failed');
    expect(calls).toBe(2);
    expect((await getDocument(scope, invoiceId)).document.status).toBe('issued');
    expect((await getDocument(scope, draft.document.id)).document.status).toBe('draft');
    expect(await counter(tenantId, 'invoice')).toBe(63);
    expect(await counter(tenantId, 'credit_note')).toBe(1);
    expect(await fileCount(tenantId)).toBe(filesBefore);
    const creditNotes = await env.ownerDb
      .selectFrom('sales_document')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('doc_type', '=', 'credit_note')
      .execute();
    expect(creditNotes).toEqual([]);
    // The retry goes through, with the numbers the failed attempt would have had.
    const retry = await issueWithPdf(scope, draft.document.id);
    expect(retry.document.document.documentNumber).toBe('63');
    expect((await getDocument(scope, retry.replaced!.creditNoteId)).document.documentNumber).toBe('GS-1');
  });

  it('re-entry: a replacement can itself be corrected (a chain), a cancelled invoice cannot', async () => {
    const { scope, invoiceId } = await companyWithInvoice();
    const first = await startCorrection(scope, invoiceId, { actorUserId: ACTOR });
    await issueWithPdf(scope, first.document.document.id);
    const second = await startCorrection(scope, first.document.document.id, { actorUserId: ACTOR });
    expect(second.existing).toBe(false);
    const result = await issueWithPdf(scope, second.document.document.id);
    expect(result.document.document.documentNumber).toBe('64');
    expect((await getDocument(scope, first.document.document.id)).document.status).toBe('cancelled');

    expect(await rejectionCode(startCorrection(scope, invoiceId, { actorUserId: ACTOR }))).toBe('NOT_CORRECTABLE');
    // A credit note and a draft are not correctable either.
    const creditNoteId = result.replaced!.creditNoteId;
    expect(await rejectionCode(startCorrection(scope, creditNoteId, { actorUserId: ACTOR }))).toBe('NOT_CORRECTABLE');
    const plainDraft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR });
    expect(await rejectionCode(startCorrection(scope, plainDraft.document.id, { actorUserId: ACTOR }))).toBe('NOT_CORRECTABLE');
    // Another company's invoice reads as unknown.
    const stranger = scopeFor(env.appDb, env.tgId, newTenantId(), new FakeDirectory());
    expect(await rejectionCode(startCorrection(stranger, result.document.document.id, { actorUserId: ACTOR }))).toBe('NOT_FOUND');
  });

  it('re-entry after a race: an invoice cancelled while its replacement is open refuses the issue, the draft can still go out as an ordinary invoice', async () => {
    const { tenantId, scope, invoiceId } = await companyWithInvoice();
    const { document: draft } = await startCorrection(scope, invoiceId, { actorUserId: ACTOR });
    await cancelInvoice(scope, invoiceId, { actorUserId: ACTOR, reason: 'Wrong recipient' }, { beforeCommit: storeBeforeCommit(scope) });
    expect(await rejectionCode(issueWithPdf(scope, draft.document.id))).toBe('REPLACED_INVOICE_CANCELLED');
    expect(await counter(tenantId, 'invoice')).toBe(63);
    expect(await counter(tenantId, 'credit_note')).toBe(2);
    const reread = await getDocument(scope, draft.document.id);
    expect(reread.related.replaces).toMatchObject({ status: 'cancelled' });
    const detached = await updateDraft(scope, draft.document.id, { replacesDocumentId: null, expectedVersion: reread.document.version });
    const result = await issueWithPdf(scope, draft.document.id, detached.document.version);
    expect(result.document.document.documentNumber).toBe('63');
    expect(await counter(tenantId, 'credit_note')).toBe(2);
  });

  it('an imported invoice cannot be corrected (it keeps plain cancellation)', async () => {
    const { scope, dir } = await companyWithInvoice();
    const record: HistoricalInvoiceInput = {
      origin: 'upload_extracted',
      documentNumber: '40',
      issueDate: '2025-04-01',
      serviceDate: null,
      servicePeriod: null,
      paymentTermsDays: 0,
      dueDate: null,
      recipient: {
        kind: 'organization',
        name: 'Example Client GmbH',
        addressLine1: 'Beispielweg 2',
        addressLine2: null,
        postalCode: '20095',
        city: 'Hamburg',
        country: 'DE',
        customerNumber: null,
        customerNumberText: null,
        vatId: null,
      },
      sender: {
        legalName: 'Sample Studio', addressLine1: 'Musterstrasse 1', addressLine2: null, postalCode: '10115', city: 'Berlin', countryCode: 'DE',
        taxNumber: null, vatId: null, smallBusinessId: null, email: null, phone: null, website: null, bankName: null, iban: null, bic: null,
        registerCourt: null, registerNumber: null, managingDirector: null,
      },
      lines: [{ kind: 'service', title: 'Design work', description: null, quantity: 1000, unitLabel: 'Stk', unitPrice: 5000, discountBp: 0, subtotal: 5000 }],
      total: 5000,
      currency: 'EUR',
      taxTreatment: 'small_business',
      taxNote: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.',
    };
    const pdf = new Uint8Array(Buffer.from(`%PDF-1.4\n% synthetic original ${randomUUID()}\n%%EOF\n`, 'latin1'));
    const imported = await importHistoricalInvoice(scope, new FakeContactBook(dir), record, pdf, newImportSession());
    expect(imported.status).toBe('imported');
    expect(await rejectionCode(startCorrection(scope, imported.documentId, { actorUserId: ACTOR }))).toBe('NOT_CORRECTABLE');
  });
});

describe('the Correct flow under concurrency and retries', () => {
  it('two Correct clicks at once make one draft', async () => {
    const { scope, invoiceId } = await companyWithInvoice();
    const [a, b] = await Promise.all([
      startCorrection(scope, invoiceId, { actorUserId: ACTOR }),
      startCorrection(scope, invoiceId, { actorUserId: ACTOR }),
    ]);
    expect(a.document.document.id).toBe(b.document.document.id);
    expect([a.existing, b.existing].sort()).toEqual([false, true]);
  });

  it('the replacement issued twice at once: one issue, one credit note, the second answers alreadyIssued with the same link', async () => {
    const { tenantId, scope, invoiceId } = await companyWithInvoice();
    const { document: draft } = await startCorrection(scope, invoiceId, { actorUserId: ACTOR });
    const [a, b] = await Promise.all([issueWithPdf(scope, draft.document.id), issueWithPdf(scope, draft.document.id)]);
    expect([a.alreadyIssued, b.alreadyIssued].sort()).toEqual([false, true]);
    expect(a.document.document.documentNumber).toBe(b.document.document.documentNumber);
    expect(a.replaced).toEqual(b.replaced);
    expect(await counter(tenantId, 'invoice')).toBe(64);
    expect(await counter(tenantId, 'credit_note')).toBe(2);
    // A retry long after the success says the same.
    const retry = await issueWithPdf(scope, draft.document.id);
    expect(retry).toMatchObject({ alreadyIssued: true, replaced: a.replaced });
    expect(await counter(tenantId, 'credit_note')).toBe(2);
  });

  it('the replacement issued while the invoice is cancelled directly: exactly one credit note either way', async () => {
    const { tenantId, scope, invoiceId } = await companyWithInvoice();
    const { document: draft } = await startCorrection(scope, invoiceId, { actorUserId: ACTOR });
    const results = await Promise.allSettled([
      issueWithPdf(scope, draft.document.id),
      cancelInvoice(scope, invoiceId, { actorUserId: ACTOR, reason: 'Wrong recipient' }, { beforeCommit: storeBeforeCommit(scope) }),
    ]);
    const creditNotes = await env.ownerDb
      .selectFrom('sales_document')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('doc_type', '=', 'credit_note')
      .execute();
    expect(creditNotes).toHaveLength(1);
    expect((await getDocument(scope, invoiceId)).document.status).toBe('cancelled');
    const [issued, cancelled] = results;
    expect(cancelled.status).toBe('fulfilled');
    if (issued.status === 'fulfilled') {
      // The issue won: the cancel found the invoice cancelled and returned its credit note.
      expect(issued.value.replaced?.creditNoteId).toBe(creditNotes[0].id);
      expect(cancelled.status === 'fulfilled' && cancelled.value.alreadyCancelled).toBe(true);
    } else {
      // The cancel won: the issue was refused and the draft is still a draft.
      expect((issued.reason as { code?: string }).code).toBe('REPLACED_INVOICE_CANCELLED');
      expect((await getDocument(scope, draft.document.id)).document.status).toBe('draft');
    }
  });
});

describe('011_books_replacement in the database', () => {
  it('refuses a second replacement, a link to anything but an issued editor invoice, and a replacement issued without the cancellation', async () => {
    const { tenantId, scope, customer, invoiceId } = await companyWithInvoice();
    const { document: draft } = await startCorrection(scope, invoiceId, { actorUserId: ACTOR });

    // A second replacement of the same invoice (written around the code): the unique index.
    const second = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR });
    expect(
      await rejectionCode(
        env.appDb.updateTable('sales_document').set({ replaces_document_id: invoiceId }).where('id', '=', second.document.id).execute(),
      ),
    ).toBe('23505');
    // A link to something that is not an issued editor invoice: BK011.
    expect(
      await rejectionCode(
        env.appDb.updateTable('sales_document').set({ replaces_document_id: draft.document.id }).where('id', '=', second.document.id).execute(),
      ),
    ).toBe('BK011');
    // A link to an invoice that is already cancelled: BK011.
    const third = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });
    await addLine(scope, third.document.id, { kind: 'service', title: 'Extra', quantity: 1000, unitPrice: 1000 });
    const thirdIssued = await issueWithPdf(scope, third.document.id);
    await cancelInvoice(scope, thirdIssued.document.document.id, { actorUserId: ACTOR, reason: 'Duplicate' }, { beforeCommit: storeBeforeCommit(scope) });
    expect(
      await rejectionCode(
        env.appDb
          .updateTable('sales_document')
          .set({ replaces_document_id: thirdIssued.document.document.id })
          .where('id', '=', second.document.id)
          .execute(),
      ),
    ).toBe('BK011');
    // On the document itself: refused (the BEFORE trigger fires before the CHECK,
    // and finds a draft; the CHECK is the second line of defence).
    expect(
      await rejectionCode(
        env.appDb.updateTable('sales_document').set({ replaces_document_id: second.document.id }).where('id', '=', second.document.id).execute(),
      ),
    ).toBe('BK011');

    // The replacement draft set to issued directly, as a buggy writer would, with the
    // old invoice still valid: refused at commit (the deferred trigger).
    const old = await env.ownerDb
      .selectFrom('sales_document')
      .select(['customer_snapshot', 'sender_snapshot', 'template_snapshot'])
      .where('id', '=', invoiceId)
      .executeTakeFirstOrThrow();
    const attempt = env.appDb.transaction().execute(async (trx) => {
      await trx
        .updateTable('sales_document')
        .set({
          status: 'issued',
          document_number: '999',
          number_value: '999',
          issue_date: sql<string>`CURRENT_DATE`,
          customer_snapshot: toJsonb(old.customer_snapshot),
          sender_snapshot: toJsonb(old.sender_snapshot),
          template_snapshot: toJsonb(old.template_snapshot),
          issued_at: new Date(),
          updated_at: new Date(),
        })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', draft.document.id)
        .execute();
    });
    expect(await rejectionCode(attempt)).toBe('BK013');
    expect((await getDocument(scope, draft.document.id)).document.status).toBe('draft');
  });
});

describe('the replacement reference line (phase 2 of the composer plan)', () => {
  it('a replacement prints "Ersetzt Rechnung 62 vom ..." when switched on; an ordinary invoice cannot, and detaching clears it', async () => {
    const { scope, invoiceId } = await companyWithInvoice();
    const original = await getDocument(scope, invoiceId);
    const started = await startCorrection(scope, invoiceId, { actorUserId: ACTOR });
    const draftId = started.document.document.id;
    expect(started.document.document.printReplacesReference).toBe(false);

    const on = await updateDraft(scope, draftId, { printReplacesReference: true, expectedVersion: started.document.document.version });
    expect(on.document.printReplacesReference).toBe(true);
    const [day, month, year] = [original.document.issueDate!.slice(8, 10), original.document.issueDate!.slice(5, 7), original.document.issueDate!.slice(0, 4)];
    const line = `Ersetzt Rechnung 62 vom ${day}.${month}.${year}`;
    const issued = await issueWithPdf(scope, draftId);
    const file = await env.ownerDb
      .selectFrom('sales_document_file')
      .select('content')
      .where('document_id', '=', issued.document.document.id)
      .executeTakeFirstOrThrow();
    expect(await extractPdfText(new Uint8Array(file.content))).toContain(line);

    // An ordinary draft cannot switch it on.
    const plain = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR });
    await expect(updateDraft(scope, plain.document.id, { printReplacesReference: true })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // And the database refuses it too.
    expect(
      await rejectionCode(env.ownerDb.updateTable('sales_document').set({ print_replaces_reference: true }).where('id', '=', plain.document.id).execute()),
    ).toBe('23514');
  });

  it('turning a replacement into an ordinary invoice clears the line', async () => {
    const { scope, invoiceId } = await companyWithInvoice();
    const started = await startCorrection(scope, invoiceId, { actorUserId: ACTOR });
    const id = started.document.document.id;
    const on = await updateDraft(scope, id, { printReplacesReference: true });
    const off = await updateDraft(scope, id, { replacesDocumentId: null, expectedVersion: on.document.version });
    expect(off.document).toMatchObject({ replacesDocumentId: null, printReplacesReference: false });
  });
});

describe('a correction whose invoice template was archived meanwhile', () => {
  it('starts the replacement on the company default instead of the hidden template', async () => {
    const { scope, invoiceId } = await companyWithInvoice();
    const archived = await createTemplate(scope, { name: 'Alt', isDefault: false });
    const current = await createTemplate(scope, { name: 'Neu', isDefault: true });
    // An invoice issued on a template that is archived afterwards.
    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: (await getDocument(scope, invoiceId)).document.customerId!, templateId: archived.id, serviceDate: '2026-10-01' });
    await addLine(scope, draft.document.id, { kind: 'service', title: 'Workshop', quantity: 1000, unitPrice: 5000 });
    const issued = await issueWithPdf(scope, draft.document.id);
    await deleteTemplate(scope, archived.id);
    const started = await startCorrection(scope, issued.document.document.id, { actorUserId: ACTOR });
    expect(started.document.document.templateId).toBe(current.id);
  });
});
