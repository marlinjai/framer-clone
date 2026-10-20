// src/server/books/upload/__tests__/books-upload.itest.ts
//
// The upload import (docs/plans/2026-10-20-books-upload-import.md) on real
// Postgres as commerce_app, the model stubbed at the client boundary, the
// contacts database a fake. The four paths of the stateful-flow standard:
//
//   1. forward: stage, read, ready, confirm, imported; the original served
//      byte-identical through the download path; the counter raised upwards
//      only; a number in another format imported as printed;
//   2. backtrack and revise: a corrected number re-checks uniqueness and the
//      counter effect; the same input changes nothing; a correction of an old
//      reading is refused; reading again drops the correction (keyed);
//   3. resume: rows survive a reload; an interrupted reading is retried, a
//      running one is not read twice;
//   4. re-entry: a file imported before is a duplicate (no model call); a
//      discarded file can be staged again; a failed import leaves the row
//      ready with the failure named.
//
// Plus the daily ceiling, the parallel limit, a refusal, VAT and CHF invoices,
// and what 010 guarantees for staging rows and the ledger. Synthetic data only.

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ContactBook } from '../../contactBook';
import { BooksError } from '../../errors';
import { cancelInvoice } from '../../cancel';
import { documentPdf } from '../../render/store';
import { getDocument } from '../../repository/read';
import {
  FakeContactBook,
  FakeDirectory,
  initCompany,
  newTenantId,
  openBooksEnv,
  rejectionCode,
  scopeFor,
  type BooksEnv,
} from '../../__tests__/booksFixtures';
import { createCompanySlots } from '../limits';
import { IMPORT_RENDERER, importHistoricalInvoice, newImportSession } from '../../importInvoices';
import { mapPrintedInvoice } from '../../importPrinted';
import {
  confirmItem,
  confirmNumber,
  correctItem,
  discardItem,
  enterByHand,
  extractItem,
  listImportItems,
  MAX_OPEN_ITEMS,
  stageUpload,
  type ExtractDeps,
} from '../service';
import { getItem, itemContent } from '../staging';
import { fakeAnthropic, pdfBytes, toolInput, toolTurn, type Turn } from './fakeAnthropic';

let env: BooksEnv;

beforeAll(async () => {
  env = await openBooksEnv('books-upload');
}, 120_000);

afterAll(async () => {
  await env?.close();
});

async function company(opts: { invoiceNext?: number } = {}) {
  const tenantId = newTenantId();
  const dir = new FakeDirectory();
  const book = new FakeContactBook(dir);
  const scope = scopeFor(env.appDb, env.tgId, tenantId, dir);
  await initCompany(scope, { invoiceNext: opts.invoiceNext ?? 62 });
  return { tenantId, dir, book, scope };
}

function deps(turns: Turn[], book: ContactBook, over: Partial<ExtractDeps> = {}) {
  const fake = fakeAnthropic(turns);
  return {
    fake,
    deps: {
      anthropic: fake.client,
      modelKey: 'SONNET' as const,
      modelId: 'claude-sonnet-5-5',
      slots: createCompanySlots(4),
      dailyLimit: 500,
      signal: new AbortController().signal,
      contactBook: book,
      ...over,
    } satisfies ExtractDeps,
  };
}

async function staged(scope: Parameters<typeof stageUpload>[0], label: string) {
  const r = await stageUpload(scope, { fileName: `${label}.pdf`, bytes: pdfBytes(label) });
  if (r.status !== 'staged') throw new Error('expected a staged row');
  return r.item;
}

const codes = (item: { problems: Array<{ code: string }> }) => item.problems.map((p) => p.code).sort();

/** A printed invoice as the user types it in the form: the model's tool input without its unsure fields. */
function typedByUser(input: Record<string, unknown>): Record<string, unknown> {
  const out = { ...input };
  delete out.uncertainFields;
  return out;
}

describe('forward', () => {
  it('stage, read, check, import: the original is the document of record, byte for byte', async () => {
    const { tenantId, book, scope } = await company();
    const item = await staged(scope, `fwd-${tenantId}`);
    expect(item.status).toBe('uploaded');
    const { fake, deps: d } = deps([toolTurn(toolInput())], book);
    const read = await extractItem(scope, item.id, d);
    expect(fake.calls).toHaveLength(1);
    expect(read.status).toBe('ready');
    // Warnings and unsure fields never block.
    // The company's sender block fills what the PDF does not show (its VAT id and country here).
    expect(codes(read)).toEqual(['line_price_derived', 'sender_from_company', 'unsure_medium']);
    expect(read.problems.every((p) => !p.blocking)).toBe(true);

    const done = await confirmItem(scope, book, item.id, { expectedVersion: read.version });
    expect(done.item.status).toBe('imported');
    expect(done.counterRaisedTo).toBeNull();
    const row = await env.ownerDb.selectFrom('historical_import_item').select(['content', 'document_id']).where('id', '=', item.id).executeTakeFirstOrThrow();
    expect(row.content).toBeNull();
    expect(row.document_id).toBe(done.documentId);

    const view = await getDocument(scope, done.documentId!);
    expect(view.document).toMatchObject({ source: 'import', documentNumber: '17', numberValue: 17, total: 72000, currencyCode: 'EUR' });
    expect(view.lines.map((l) => l.subtotal)).toEqual([80000, -8000]);
    expect(view.events[0].payload).toMatchObject({ importOrigin: 'upload_extracted', documentNumber: '17' });
    // The sender as printed, its tax number read from the PDF.
    expect(view.document.senderSnapshot).toMatchObject({ legalName: 'Sample Studio', city: 'Berlin', taxNumber: '12/345/67890' });
    const served = await documentPdf(scope, done.documentId!);
    expect(Buffer.from(served.bytes).equals(Buffer.from(pdfBytes(`fwd-${tenantId}`)))).toBe(true);

    const ledger = await env.ownerDb.selectFrom('historical_import_extraction').select(['outcome', 'input_tokens', 'model']).where('item_id', '=', item.id).execute();
    expect(ledger).toEqual([{ outcome: 'ok', input_tokens: 1200, model: 'claude-sonnet-5-5' }]);
  });

  it('a number at or above the counter raises it, upwards only; a number in another format leaves it alone', async () => {
    const { tenantId, book, scope } = await company({ invoiceNext: 62 });
    const counter = async () =>
      Number((await env.ownerDb.selectFrom('document_number_counter').select('next_value').where('tenant_id', '=', tenantId).where('doc_type', '=', 'invoice').executeTakeFirstOrThrow()).next_value);

    const high = await staged(scope, `high-${tenantId}`);
    const r1 = await extractItem(scope, high.id, deps([toolTurn(toolInput({ number: '70', issueDate: '2023-01-10' }))], book).deps);
    expect(r1.problems).toContainEqual({ code: 'counter_raised', path: null, blocking: false, count: 71 });
    // The raise is irreversible: without the confirmed value, or with another one, nothing is imported.
    await expect(confirmItem(scope, book, high.id, { expectedVersion: r1.version })).rejects.toMatchObject({ code: 'COUNTER_RAISE_UNCONFIRMED', details: { raiseTo: 71 } });
    const afterRefusal = await getItem(scope.db, scope, high.id);
    await expect(confirmItem(scope, book, high.id, { expectedVersion: afterRefusal.version, confirmCounterRaiseTo: 70 })).rejects.toMatchObject({ code: 'COUNTER_RAISE_UNCONFIRMED' });
    expect(await counter()).toBe(62);
    const fresh = await getItem(scope.db, scope, high.id);
    const c1 = await confirmItem(scope, book, high.id, { expectedVersion: fresh.version, confirmCounterRaiseTo: 71 });
    expect(c1.counterRaisedTo).toBe(71);
    expect(await counter()).toBe(71);

    const low = await staged(scope, `low-${tenantId}`);
    const r2 = await extractItem(scope, low.id, deps([toolTurn(toolInput({ number: '65', issueDate: '2022-12-01' }))], book).deps);
    expect(codes(r2)).not.toContain('counter_raised');
    expect((await confirmItem(scope, book, low.id, { expectedVersion: r2.version })).counterRaisedTo).toBeNull();
    expect(await counter()).toBe(71);

    const text = await staged(scope, `text-${tenantId}`);
    const r3 = await extractItem(scope, text.id, deps([toolTurn(toolInput({ number: 'RE-2019-0004', issueDate: '2019-04-02' }))], book).deps);
    const c3 = await confirmItem(scope, book, text.id, { expectedVersion: r3.version });
    const doc = (await getDocument(scope, c3.documentId!)).document;
    expect(doc).toMatchObject({ documentNumber: 'RE-2019-0004', numberValue: null });
    expect(await counter()).toBe(71);
  });

  it('a regular VAT invoice in CHF imports with its printed rates, taxes and currency', async () => {
    const { tenantId, book, scope } = await company();
    const item = await staged(scope, `vat-${tenantId}`);
    const input = toolInput({
      number: '30',
      currency: 'CHF',
      taxTreatment: 'regular',
      taxNote: null,
      lines: [
        { description: 'Design work', quantity: 10, unit: 'h', unitPrice: 100, discount: null, lineTotal: 1000, taxRate: 19, taxAmount: 190 },
        { description: 'Rabatt 10 %', quantity: null, unit: null, unitPrice: null, discount: '10 %', lineTotal: -100, taxRate: 19, taxAmount: -19 },
      ],
      taxAmounts: [{ rate: 19, net: 900, tax: 171 }],
      total: 1071,
      uncertainFields: [],
    });
    const read = await extractItem(scope, item.id, deps([toolTurn(input)], book).deps);
    expect(read.status).toBe('ready');
    const done = await confirmItem(scope, book, item.id, { expectedVersion: read.version });
    const view = await getDocument(scope, done.documentId!);
    expect(view.document).toMatchObject({ currencyCode: 'CHF', kleinunternehmer: false, subtotal: 90000, taxAmount: 17100, total: 107100 });
    expect(view.lines.map((l) => [l.taxRate, l.taxAmount, l.taxTreatment])).toEqual([
      [1900, 19000, 'standard'],
      [1900, -1900, 'standard'],
    ]);
    // Cancelled like any invoice: the credit note copies the lines (the discount
    // line with its negative VAT included) and carries the invoice's currency.
    const cancelled = await cancelInvoice(scope, done.documentId!, { actorUserId: 'user-books', reason: 'synthetic cancellation' });
    expect(cancelled.creditNote.document).toMatchObject({ currencyCode: 'CHF', subtotal: 90000, taxAmount: 17100, total: 107100, status: 'issued' });
    expect(cancelled.creditNote.lines.map((l) => [l.subtotal, l.taxAmount])).toEqual([
      [100000, 19000],
      [-10000, -1900],
    ]);
  });
});

describe('the invoice counter: confirmed raises and numbers that jump far ahead', () => {
  it('a confirmation of an earlier target is refused after the number changed', async () => {
    const { tenantId, book, scope } = await company();
    const item = await staged(scope, `st-${tenantId}`);
    const read = await extractItem(scope, item.id, deps([toolTurn(toolInput({ number: '70' }))], book).deps);
    expect(read.problems).toContainEqual({ code: 'counter_raised', path: null, blocking: false, count: 71 });
    const corrected = await correctItem(scope, book, item.id, {
      printed: { ...read.extracted!.printed, number: '80' },
      extractionId: read.extractionId!,
      expectedVersion: read.version,
    });
    // The user saw "71" earlier; the row now raises to 81.
    await expect(confirmItem(scope, book, item.id, { expectedVersion: corrected.version, confirmCounterRaiseTo: 71 })).rejects.toMatchObject({
      code: 'COUNTER_RAISE_UNCONFIRMED',
      details: { raiseTo: 81, confirmed: 71 },
    });
    const now = await getItem(scope.db, scope, item.id);
    expect(now.status).toBe('ready');
    expect((await confirmItem(scope, book, item.id, { expectedVersion: now.version, confirmCounterRaiseTo: 81 })).counterRaisedTo).toBe(81);
  });

  it('a number more than 50 above the next value blocks until the user confirms that exact number', async () => {
    const { tenantId, book, scope } = await company({ invoiceNext: 62 });
    const item = await staged(scope, `j-${tenantId}`);
    const read = await extractItem(scope, item.id, deps([toolTurn(toolInput({ number: '9999' }))], book).deps);
    expect(read.status).toBe('needs_attention');
    expect(read.problems).toContainEqual({ code: 'number_jump', path: 'number', blocking: true, count: 62 });
    await expect(confirmItem(scope, book, item.id, { expectedVersion: read.version, confirmCounterRaiseTo: 10000 })).rejects.toMatchObject({ code: 'IMPORT_NOT_READY' });
    // A confirmation of another number than the current one is refused.
    await expect(confirmNumber(scope, book, item.id, { documentNumber: '999', expectedVersion: (await getItem(scope.db, scope, item.id)).version })).rejects.toMatchObject({ code: 'CONCURRENT_EDIT' });
    const confirmed = await confirmNumber(scope, book, item.id, { documentNumber: '9999', expectedVersion: (await getItem(scope.db, scope, item.id)).version });
    expect(confirmed.status).toBe('ready');
    expect(codes(confirmed)).not.toContain('number_jump');
    // Changing the number makes the problem come back: the confirmation was for 9999 only.
    const changed = await correctItem(scope, book, item.id, {
      printed: { ...read.extracted!.printed, number: '8888' },
      extractionId: read.extractionId!,
      expectedVersion: confirmed.version,
    });
    expect(changed.problems).toContainEqual({ code: 'number_jump', path: 'number', blocking: true, count: 62 });
  });

  it('a number more than 50 above the highest of the other staged rows blocks, below the counter too', async () => {
    const { tenantId, book, scope } = await company({ invoiceNext: 200 });
    for (const n of ['10', '11']) {
      const row = await staged(scope, `seq-${n}-${tenantId}`);
      await extractItem(scope, row.id, deps([toolTurn(toolInput({ number: n }))], book).deps);
    }
    const odd = await staged(scope, `seq-odd-${tenantId}`);
    const read = await extractItem(scope, odd.id, deps([toolTurn(toolInput({ number: '99' }))], book).deps);
    expect(read.problems).toContainEqual({ code: 'number_jump', path: 'number', blocking: true, count: 11 });
    const near = await staged(scope, `seq-near-${tenantId}`);
    const ok = await extractItem(scope, near.id, deps([toolTurn(toolInput({ number: '12' }))], book).deps);
    expect(codes(ok)).not.toContain('number_jump');
  });
});

describe('backtrack and revise', () => {
  it('a corrected number re-checks uniqueness and the counter; the same input changes nothing; old readings are refused', async () => {
    const { tenantId, book, scope } = await company();
    const first = await staged(scope, `b1-${tenantId}`);
    const r1 = await extractItem(scope, first.id, deps([toolTurn(toolInput({ number: '20' }))], book).deps);
    await confirmItem(scope, book, first.id, { expectedVersion: r1.version });

    const second = await staged(scope, `b2-${tenantId}`);
    const r2 = await extractItem(scope, second.id, deps([toolTurn(toolInput({ number: '21' }))], book).deps);
    expect(r2.status).toBe('ready');
    const printed = r2.extracted!.printed;

    // Changing the number to one that is taken: blocking, with the field named.
    const taken = await correctItem(scope, book, second.id, { printed: { ...printed, number: '20' }, extractionId: r2.extractionId!, expectedVersion: r2.version });
    expect(taken.status).toBe('needs_attention');
    expect(taken.problems).toContainEqual({ code: 'number_taken', path: 'number', blocking: true, count: null });
    // To one above the counter: ready again, with the counter effect recomputed.
    const raised = await correctItem(scope, book, second.id, { printed: { ...printed, number: '65' }, extractionId: r2.extractionId!, expectedVersion: taken.version });
    expect(raised.status).toBe('ready');
    expect(raised.problems).toContainEqual({ code: 'counter_raised', path: null, blocking: false, count: 66 });
    // The same input again: nothing re-spent, no version bump.
    const same = await correctItem(scope, book, second.id, { printed: { ...printed, number: '65' }, extractionId: r2.extractionId!, expectedVersion: raised.version });
    expect(same.version).toBe(raised.version);
    // A stale version and a stale reading are refused.
    await expect(correctItem(scope, book, second.id, { printed, extractionId: r2.extractionId!, expectedVersion: r2.version })).rejects.toMatchObject({ code: 'CONCURRENT_EDIT' });
    await expect(correctItem(scope, book, second.id, { printed, extractionId: 'an-old-reading', expectedVersion: raised.version })).rejects.toMatchObject({ code: 'STALE_EXTRACTION' });

    // Reading again (asked for by the user) replaces the reading and drops the correction keyed to the old one.
    const again = await extractItem(scope, second.id, deps([toolTurn(toolInput({ number: '22' }))], book).deps, { replace: true });
    expect(again.extractionId).not.toBe(r2.extractionId);
    expect(again.corrected).toBeNull();
    expect(again.extracted!.printed.number).toBe('22');
    // The same number on two staged rows is blocking on both.
    const third = await staged(scope, `b3-${tenantId}`);
    const r3 = await extractItem(scope, third.id, deps([toolTurn(toolInput({ number: '22' }))], book).deps);
    expect(r3.problems).toContainEqual({ code: 'number_staged_twice', path: 'number', blocking: true, count: null });
  });
});

describe('resume', () => {
  it('rows survive a reload; an interrupted reading goes back to be read; a running one is not read twice', async () => {
    const { tenantId, book, scope } = await company();
    const a = await staged(scope, `r1-${tenantId}`);
    const b = await staged(scope, `r2-${tenantId}`);
    expect((await listImportItems(scope)).items.map((i) => i.id)).toEqual([a.id, b.id]);

    // The caller leaves mid-way: aborted in the ledger, the row free again.
    const controller = new AbortController();
    const pending = extractItem(scope, a.id, deps([{ ...toolTurn(toolInput()), wait: new Promise(() => {}) }], book, { signal: controller.signal }).deps);
    await new Promise((r) => setTimeout(r, 50));
    expect((await getItem(scope.db, scope, a.id)).status).toBe('extracting');
    // Meanwhile a second reader of the same file is refused.
    await expect(extractItem(scope, a.id, deps([toolTurn(toolInput())], book).deps)).rejects.toMatchObject({ code: 'EXTRACTION_RUNNING' });
    controller.abort();
    expect((await pending).status).toBe('uploaded');
    const outcomes = await env.ownerDb.selectFrom('historical_import_extraction').select('outcome').where('item_id', '=', a.id).execute();
    expect(outcomes).toEqual([{ outcome: 'aborted' }]);

    // A claim left behind by a crash (older than the claim timeout) is taken over.
    await env.ownerDb
      .updateTable('historical_import_item')
      .set({ status: 'extracting', claimed_at: new Date(Date.now() - 20 * 60 * 1000), claim_id: 'crashed-call', updated_at: new Date() })
      .where('id', '=', b.id)
      .execute();
    const resumed = await extractItem(scope, b.id, deps([toolTurn(toolInput({ number: '40' }))], book).deps);
    expect(resumed.status).toBe('ready');
  });
});

describe('re-entry', () => {
  it('a file imported before is a duplicate and never read again; a discarded file can be staged again', async () => {
    const { tenantId, book, scope } = await company();
    const item = await staged(scope, `e1-${tenantId}`);
    const r = await extractItem(scope, item.id, deps([toolTurn(toolInput({ number: '50' }))], book).deps);
    const done = await confirmItem(scope, book, item.id, { expectedVersion: r.version });
    const dup = await stageUpload(scope, { fileName: 'again.pdf', bytes: pdfBytes(`e1-${tenantId}`) });
    expect(dup).toMatchObject({ status: 'duplicate', documentId: done.documentId });

    const other = await staged(scope, `e2-${tenantId}`);
    expect(await stageUpload(scope, { fileName: 'twice.pdf', bytes: pdfBytes(`e2-${tenantId}`) })).toMatchObject({ status: 'duplicate', documentId: null });
    await discardItem(scope, other.id);
    expect((await listImportItems(scope)).items.map((i) => i.id)).not.toContain(other.id);
    const again = await stageUpload(scope, { fileName: 'back.pdf', bytes: pdfBytes(`e2-${tenantId}`) });
    expect(again.status).toBe('staged');
  });

  it('a failed import leaves the row ready with the failure named, and nothing imported', async () => {
    const { tenantId, dir, scope } = await company();
    // A contacts database that refuses to create the new contact (the import's first write).
    const book = new FakeContactBook(dir);
    const failing: ContactBook = {
      search: (t, o) => book.search(t, o),
      getMany: (t, ids) => book.getMany(t, ids),
      findSame: (t, i) => book.findSame(t, i),
      personsNamed: (t, n) => book.personsNamed(t, n),
      create: async () => {
        throw new BooksError('INVALID_INPUT', 'INVALID_INPUT: contact.name', { issues: [{ path: 'contact.name', message: 'too_long' }] });
      },
    };
    const item = await staged(scope, `f-${tenantId}`);
    const r = await extractItem(scope, item.id, deps([toolTurn(toolInput({ number: '55' }))], failing).deps);
    await expect(confirmItem(scope, failing, item.id, { expectedVersion: r.version })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const after = await getItem(scope.db, scope, item.id);
    expect(after.status).toBe('ready');
    expect(after.problems).toContainEqual({ code: 'import_failed:invalid_input', path: null, blocking: false, count: null });
    const docs = await env.ownerDb.selectFrom('sales_document').select('id').where('tenant_id', '=', tenantId).execute();
    expect(docs).toEqual([]);
    // Fixed (here: the contacts database accepts the contact again), the same row imports.
    const fixed = await confirmItem(scope, book, item.id, { expectedVersion: after.version });
    expect(fixed.item.status).toBe('imported');
  });

  it('a row with a blocking problem is not imported', async () => {
    const { tenantId, book, scope } = await company();
    const item = await staged(scope, `nr-${tenantId}`);
    const r = await extractItem(scope, item.id, deps([toolTurn(toolInput({ number: null }))], book).deps);
    expect(r.problems).toContainEqual({ code: 'number_missing', path: null, blocking: true, count: null });
    await expect(confirmItem(scope, book, item.id, { expectedVersion: r.version })).rejects.toMatchObject({ code: 'IMPORT_NOT_READY' });
  });
});

describe('limits and failed readings', () => {
  it('the daily ceiling and the parallel limit refuse before any model call; a refusal says so and can be read again', async () => {
    const { tenantId, book, scope } = await company();
    const a = await staged(scope, `l1-${tenantId}`);
    const b = await staged(scope, `l2-${tenantId}`);
    await extractItem(scope, a.id, deps([toolTurn(toolInput({ number: '90' }))], book, { dailyLimit: 1 }).deps);
    const limited = deps([toolTurn(toolInput())], book, { dailyLimit: 1 });
    await expect(extractItem(scope, b.id, limited.deps)).rejects.toMatchObject({ code: 'IMPORT_LIMIT' });
    expect(limited.fake.calls).toHaveLength(0);

    const full = createCompanySlots(1);
    const held = full.acquire(tenantId);
    const busy = deps([toolTurn(toolInput())], book, { slots: full });
    await expect(extractItem(scope, b.id, busy.deps)).rejects.toMatchObject({ code: 'EXTRACT_BUSY' });
    expect(busy.fake.calls).toHaveLength(0);
    if (held.ok) held.release();

    const refused = await extractItem(scope, b.id, deps([{ content: [], stop_reason: 'refusal' }], book).deps);
    expect(refused.status).toBe('needs_attention');
    expect(refused.problems).toEqual([{ code: 'extraction_failed:refused', path: null, blocking: true, count: null }]);
    const reread = await extractItem(scope, b.id, deps([toolTurn(toolInput({ number: '91' }))], book).deps);
    expect(reread.status).toBe('ready');
  });
});

describe('010_books_upload_import: staging rows and the ledger', () => {
  it('an imported row is frozen for every role; bytes are never replaced; a ledger row is finished once and never deleted', async () => {
    const { tenantId, book, scope } = await company();
    const item = await staged(scope, `g-${tenantId}`);
    expect(
      await rejectionCode(env.ownerDb.updateTable('historical_import_item').set({ content: Buffer.from('%PDF-other') }).where('id', '=', item.id).execute()),
    ).toBe('BK010');
    expect(await rejectionCode(env.ownerDb.updateTable('historical_import_item').set({ status: 'imported' }).where('id', '=', item.id).execute())).toBe('BK010');
    const r = await extractItem(scope, item.id, deps([toolTurn(toolInput({ number: '45' }))], book).deps);
    await confirmItem(scope, book, item.id, { expectedVersion: r.version });
    expect(await rejectionCode(env.ownerDb.updateTable('historical_import_item').set({ file_name: 'x.pdf' }).where('id', '=', item.id).execute())).toBe('BK010');
    expect(await rejectionCode(env.ownerDb.deleteFrom('historical_import_item').where('id', '=', item.id).execute())).toBe('BK010');
    expect(await rejectionCode(env.appDb.deleteFrom('historical_import_item').where('tenant_id', '=', tenantId).execute())).toBe('42501');

    const ledger = await env.ownerDb.selectFrom('historical_import_extraction').select('id').where('item_id', '=', item.id).executeTakeFirstOrThrow();
    expect(await rejectionCode(env.ownerDb.updateTable('historical_import_extraction').set({ outcome: 'error' }).where('id', '=', ledger.id).execute())).toBe('BK010');
    expect(await rejectionCode(env.ownerDb.deleteFrom('historical_import_extraction').where('id', '=', ledger.id).execute())).toBe('BK010');
    const owner = env.fx.owner;
    expect(await rejectionCode(owner`TRUNCATE ${owner(env.schema)}.historical_import_extraction`)).toBe('BK010');
    expect(await rejectionCode(owner`TRUNCATE ${owner(env.schema)}.historical_import_item CASCADE`)).toBe('BK010');
  });
});

describe('unhappy paths of reading and importing', () => {
  it('a PDF the AI cannot read is filled in by hand and imported; a row with a reading cannot be', async () => {
    const { tenantId, book, scope } = await company();
    const item = await staged(scope, `hand-${tenantId}`);
    // The API refuses the PDF itself: unreadable, not offered again.
    const unreadable = await extractItem(scope, item.id, deps([{ throws: Object.assign(new Error('bad pdf'), { status: 400 }) }], book).deps);
    expect(unreadable.problems).toEqual([{ code: 'extraction_failed:unreadable', path: null, blocking: true, count: null }]);
    expect(unreadable.extractionId).toBeNull();

    const blank = await enterByHand(scope, book, item.id, { expectedVersion: unreadable.version });
    expect(blank.extractionId).toMatch(/^manual:/);
    expect(blank.status).toBe('needs_attention');
    expect(codes(blank)).toContain('number_missing');
    // Nothing was spent: the ledger holds only the failed call.
    expect(await env.ownerDb.selectFrom('historical_import_extraction').select('outcome').where('item_id', '=', item.id).execute()).toEqual([{ outcome: 'unreadable' }]);

    const typed = typedByUser(toolInput({ number: '58' }));
    const filled = await correctItem(scope, book, item.id, { printed: typed, extractionId: blank.extractionId!, expectedVersion: blank.version });
    expect(filled.status).toBe('ready');
    expect((await confirmItem(scope, book, item.id, { expectedVersion: filled.version })).item.status).toBe('imported');

    const read = await staged(scope, `hand2-${tenantId}`);
    const r = await extractItem(scope, read.id, deps([toolTurn(toolInput({ number: '59' }))], book).deps);
    await expect(enterByHand(scope, book, read.id, { expectedVersion: r.version })).rejects.toMatchObject({ code: 'CONCURRENT_EDIT' });
  });

  it('a call whose claim was taken over writes nothing while the newer call is still running, read or failed', async () => {
    for (const [n, slowEnds] of (['with a reading', 'with a failure'] as const).entries()) {
      const { tenantId, book, scope } = await company();
      const item = await staged(scope, `take-${n}-${tenantId}`);
      let finishSlow!: () => void;
      const slowTurn: Turn =
        slowEnds === 'with a reading'
          ? { ...toolTurn(toolInput({ number: '30' })), wait: new Promise<void>((r) => (finishSlow = r)) }
          : { content: [], stop_reason: 'refusal', wait: new Promise<void>((r) => (finishSlow = r)) };
      const slow = extractItem(scope, item.id, deps([slowTurn], book).deps);
      await new Promise((r) => setTimeout(r, 50));
      // The slow call looks crashed: its claim is old, and a newer call takes it over.
      await env.ownerDb.updateTable('historical_import_item').set({ claimed_at: new Date(Date.now() - 20 * 60 * 1000) }).where('id', '=', item.id).execute();
      let finishNewer!: () => void;
      const newer = extractItem(scope, item.id, deps([{ ...toolTurn(toolInput({ number: '31' })), wait: new Promise<void>((r) => (finishNewer = r)) }], book).deps);
      await new Promise((r) => setTimeout(r, 50));
      const newerClaim = (await env.ownerDb.selectFrom('historical_import_item').select('claim_id').where('id', '=', item.id).executeTakeFirstOrThrow()).claim_id;
      // The slow call ends while the newer one still runs: it must write nothing.
      finishSlow();
      await slow;
      const between = await env.ownerDb.selectFrom('historical_import_item').select(['status', 'claim_id', 'extracted', 'problems']).where('id', '=', item.id).executeTakeFirstOrThrow();
      expect(between).toMatchObject({ status: 'extracting', claim_id: newerClaim, extracted: null });
      expect(between.problems).toEqual([]);
      finishNewer();
      const done = await newer;
      expect(done.extracted!.printed.number).toBe('31');
      expect(done.status).toBe('ready');
    }
  });

  it('an aborted reading again keeps the reading, its correction and the status', async () => {
    const { tenantId, book, scope } = await company();
    const item = await staged(scope, `keep-${tenantId}`);
    const r = await extractItem(scope, item.id, deps([toolTurn(toolInput({ number: '33' }))], book).deps);
    const typed = typedByUser(toolInput({ number: '34' }));
    const fixed = await correctItem(scope, book, item.id, { printed: typed, extractionId: r.extractionId!, expectedVersion: r.version });
    expect(fixed.status).toBe('ready');
    const controller = new AbortController();
    const pending = extractItem(scope, item.id, deps([{ ...toolTurn(toolInput()), wait: new Promise(() => {}) }], book, { signal: controller.signal }).deps, { replace: true });
    await new Promise((res) => setTimeout(res, 50));
    controller.abort();
    const back = await pending;
    expect(back.status).toBe('ready');
    expect(back.extractionId).toBe(r.extractionId);
    expect(back.corrected).toMatchObject({ number: '34' });
  });

  it('the daily ceiling holds for parallel calls: never more calls than the limit', async () => {
    const { tenantId, book, scope } = await company();
    const rows = await Promise.all([1, 2, 3, 4].map((n) => staged(scope, `par-${n}-${tenantId}`)));
    const slots = createCompanySlots(4);
    const results = await Promise.allSettled(
      rows.map((row, i) => extractItem(scope, row.id, deps([toolTurn(toolInput({ number: String(100 + i) }))], book, { dailyLimit: 2, slots }).deps)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(['IMPORT_LIMIT', 'IMPORT_LIMIT']);
    const ledger = await env.ownerDb.selectFrom('historical_import_extraction').select('id').where('tenant_id', '=', tenantId).execute();
    expect(ledger).toHaveLength(2);
    // The refused rows are as they were, free to be read later.
    const statuses = await Promise.all(rows.map((row) => getItem(scope.db, scope, row.id)));
    expect(statuses.map((x) => x.status).sort()).toEqual(['ready', 'ready', 'uploaded', 'uploaded']);
  });

  it('discarding clears the bytes at once; the list shows every open row and the newest imported with their total', async () => {
    const { tenantId, book, scope } = await company();
    const gone = await staged(scope, `dis-${tenantId}`);
    await discardItem(scope, gone.id);
    expect(await itemContent(scope.db, scope, gone.id)).toBeNull();
    const imported = await staged(scope, `li-${tenantId}`);
    const r = await extractItem(scope, imported.id, deps([toolTurn(toolInput({ number: '44' }))], book).deps);
    await confirmItem(scope, book, imported.id, { expectedVersion: r.version });
    const open = await staged(scope, `lo-${tenantId}`);
    const listed = await listImportItems(scope);
    expect(listed.items.map((i) => i.id)).toEqual([open.id, imported.id]);
    expect(listed.importedTotal).toBe(1);
  });

  it('NUL characters in a correction are dropped instead of failing the write', async () => {
    const { tenantId, book, scope } = await company();
    const item = await staged(scope, `nul-${tenantId}`);
    const r = await extractItem(scope, item.id, deps([toolTurn(toolInput({ number: '35' }))], book).deps);
    const typed = typedByUser(toolInput({ number: '3\u00006' }));
    const fixed = await correctItem(scope, book, item.id, { printed: typed, extractionId: r.extractionId!, expectedVersion: r.version });
    expect(fixed.corrected).toMatchObject({ number: '36' });
  });

  it('a file imported meanwhile by another path (the same number and bytes) marks the row imported, nothing twice', async () => {
    const { tenantId, book, scope } = await company();
    const item = await staged(scope, `race-${tenantId}`);
    const r = await extractItem(scope, item.id, deps([toolTurn(toolInput({ number: '47' }))], book).deps);
    // Another session imports the same invoice with the same original first.
    const mapped = mapPrintedInvoice(r.extracted!.printed, { origin: 'upload_extracted', now: new Date() });
    if (!mapped.ok) throw new Error(mapped.issue.reason);
    const first = await importHistoricalInvoice(scope, book, mapped.record, pdfBytes(`race-${tenantId}`), newImportSession(), { counterPolicy: 'raise' });
    if (first.status !== 'imported') throw new Error(first.status);
    const done = await confirmItem(scope, book, item.id, { expectedVersion: r.version });
    expect(done).toMatchObject({ documentId: first.documentId, item: { status: 'imported' } });
    const files = await env.ownerDb.selectFrom('sales_document_file').select('id').where('tenant_id', '=', tenantId).where('renderer', '=', IMPORT_RENDERER).execute();
    expect(files).toHaveLength(1);
  });

  it('what the user typed is not replaced by a reading nobody asked for; asked for, it is', async () => {
    const { tenantId, book, scope } = await company();
    const item = await staged(scope, `typed-${tenantId}`);
    const refused = await extractItem(scope, item.id, deps([{ content: [], stop_reason: 'refusal' }], book).deps);
    const blank = await enterByHand(scope, book, item.id, { expectedVersion: refused.version });
    const typed = await correctItem(scope, book, item.id, { printed: typedByUser(toolInput({ number: '61' })), extractionId: blank.extractionId!, expectedVersion: blank.version });
    const queued = deps([toolTurn(toolInput({ number: '99' }))], book);
    await expect(extractItem(scope, item.id, queued.deps)).rejects.toMatchObject({ code: 'READING_WOULD_BE_REPLACED' });
    expect(queued.fake.calls).toHaveLength(0);
    expect((await getItem(scope.db, scope, item.id)).corrected).toMatchObject({ number: '61' });
    const asked = await extractItem(scope, item.id, deps([toolTurn(toolInput({ number: '62' }))], book).deps, { replace: true });
    expect(asked.extracted!.printed.number).toBe('62');
    expect(asked.corrected).toBeNull();
    expect(typed.status).toBe('ready');
  });

  it('a failed reading again keeps the earlier reading and its status, the failure noted', async () => {
    const { tenantId, book, scope } = await company();
    const item = await staged(scope, `rf-${tenantId}`);
    const r = await extractItem(scope, item.id, deps([toolTurn(toolInput({ number: '37' }))], book).deps);
    expect(r.status).toBe('ready');
    const failed = await extractItem(scope, item.id, deps([{ throws: Object.assign(new Error('overloaded'), { status: 529 }) }], book).deps);
    expect(failed.status).toBe('ready');
    expect(failed.extractionId).toBe(r.extractionId);
    expect(failed.problems).toContainEqual({ code: 'reread_failed:error', path: null, blocking: false, count: null });
    expect(failed.problems.every((p) => !p.blocking)).toBe(true);
  });

  it('a call is bounded as a whole (a stalled stream is aborted), recorded as an error, and the row can be read again', async () => {
    const { tenantId, book, scope } = await company();
    const item = await staged(scope, `slow-${tenantId}`);
    const stalled = await extractItem(scope, item.id, deps([{ ...toolTurn(toolInput()), wait: new Promise(() => {}) }], book, { callBudgetMs: 100 }).deps);
    expect(stalled.status).toBe('needs_attention');
    expect(stalled.problems).toEqual([{ code: 'extraction_failed:error', path: null, blocking: true, count: null }]);
    expect(await env.ownerDb.selectFrom('historical_import_extraction').select('outcome').where('item_id', '=', item.id).execute()).toEqual([{ outcome: 'error' }]);
  });

  it('a call the caller left before it began is not made and not counted', async () => {
    const { tenantId, book, scope } = await company();
    const item = await staged(scope, `gone-${tenantId}`);
    const controller = new AbortController();
    controller.abort();
    const d = deps([toolTurn(toolInput())], book, { signal: controller.signal });
    const back = await extractItem(scope, item.id, d.deps);
    expect(back.status).toBe('uploaded');
    expect(d.fake.calls).toHaveLength(0);
    expect(await env.ownerDb.selectFrom('historical_import_extraction').select('id').where('item_id', '=', item.id).execute()).toEqual([]);
  });

  it('parallel uploads cannot pass the open-row bound together', async () => {
    const { tenantId, scope } = await company();
    // Fill up to one below the bound directly (as the owner), then race two uploads.
    const rows = Array.from({ length: MAX_OPEN_ITEMS - 1 }, (_, i) => ({
      id: crypto.randomUUID(), tenant_id: tenantId, file_name: 'f.pdf', content: Buffer.from(`%PDF-${i}`), byte_size: Buffer.from(`%PDF-${i}`).byteLength,
      sha256: i.toString(16).padStart(64, '0'), updated_at: new Date(),
    }));
    await env.ownerDb.insertInto('historical_import_item').values(rows).execute();
    // Ten at once for the last free place: without the lock several would pass the count together.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => stageUpload(scope, { fileName: `${i}.pdf`, bytes: pdfBytes(`race-${i}-${tenantId}`) })),
    );
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((x) => x.status === 'rejected').map((x) => (x as PromiseRejectedResult).reason.code)).toEqual(Array(9).fill('IMPORT_LIMIT'));
  });

  it('010 keeps the claim with the status, and a discarded row without bytes', async () => {
    const { tenantId, scope } = await company();
    const item = await staged(scope, `ck-${tenantId}`);
    expect(await rejectionCode(env.ownerDb.updateTable('historical_import_item').set({ status: 'extracting' }).where('id', '=', item.id).execute())).toBe('23514');
    expect(
      await rejectionCode(env.ownerDb.updateTable('historical_import_item').set({ status: 'discarded', discarded_at: new Date() }).where('id', '=', item.id).execute()),
    ).toBe('23514');
  });

  it('a caller who leaves while the ceiling is being counted gets no model call that runs on', async () => {
    const { tenantId, book, scope } = await company();
    const item = await staged(scope, `lock-${tenantId}`);
    // Another reading holds the company's ceiling lock for a moment.
    let unlock!: () => void;
    const held = env.ownerDb.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`books-import-extract:${tenantId}`}, 0))`.execute(trx);
      await new Promise<void>((r) => (unlock = r));
    });
    // Exactly this company's ceiling lock in this database (the test Postgres may be shared by other files).
    const key = `books-import-extract:${tenantId}`;
    const waiting = async (granted: boolean) => {
      for (let i = 0; i < 200; i += 1) {
        const n = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM pg_locks
           WHERE locktype = 'advisory' AND objsubid = 1 AND granted = ${granted}
             AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
             AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${key}, 0)`.execute(env.ownerDb);
        if (n.rows[0].n > 0) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('the advisory lock was never seen');
    };
    await waiting(true);
    const controller = new AbortController();
    const d = deps([{ ...toolTurn(toolInput()), wait: new Promise(() => {}) }], book, { signal: controller.signal, callBudgetMs: 60_000 });
    const pending = extractItem(scope, item.id, d.deps);
    // The reading is queued behind the lock (an ungranted advisory lock), then its caller leaves.
    await waiting(false);
    controller.abort();
    unlock();
    await held;
    const back = await pending;
    expect(back.status).toBe('uploaded');
    // Not called, and not counted against the day.
    expect(d.fake.calls).toHaveLength(0);
    expect(await env.ownerDb.selectFrom('historical_import_extraction').select('outcome').where('item_id', '=', item.id).execute()).toEqual([]);
  }, 20_000);

  it('010 keeps the claim id and time together outside a reading too', async () => {
    const { tenantId, scope } = await company();
    const item = await staged(scope, `half-${tenantId}`);
    expect(await rejectionCode(env.ownerDb.updateTable('historical_import_item').set({ claim_id: 'x' }).where('id', '=', item.id).execute())).toBe('23514');
    expect(await rejectionCode(env.ownerDb.updateTable('historical_import_item').set({ claimed_at: new Date() }).where('id', '=', item.id).execute())).toBe('23514');
  });
});
