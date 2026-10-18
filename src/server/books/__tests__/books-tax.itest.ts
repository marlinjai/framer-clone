// src/server/books/__tests__/books-tax.itest.ts
//
// Books plan P1.10: the phase 1 verify list of section 5, through the
// repository: domestic 19 percent, reduced 7 percent, EU business reverse
// charge, Section 19 suppression, mixed-rate grouping, and a credit note that
// references and offsets an issued invoice.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REVERSE_CHARGE_NOTICE } from '../../tax/germanVat';
import { cancelInvoice } from '../cancel';
import { createDraft } from '../repository/documents';
import { addLine } from '../repository/lines';
import { getDocument } from '../repository/read';
import { issue } from '../issue';
import { DEFAULT_EXEMPTION_NOTE, initBooksCompany } from '../settings';
import { addDays } from '../numbering';
import { MAX_AMOUNT_CENTS } from '../totals';
import {
  ACTOR,
  FakeDirectory,
  initCompany,
  newCustomer,
  newTenantId,
  openBooksEnv,
  scopeFor,
  syntheticSender,
  berlinToday,
  type BooksEnv,
} from './booksFixtures';

let env: BooksEnv;

beforeAll(async () => {
  env = await openBooksEnv('books-tax');
}, 120_000);

afterAll(async () => {
  await env?.close();
});

async function regularCompany() {
  const dir = new FakeDirectory();
  const scope = scopeFor(env.appDb, env.tgId, newTenantId(), dir);
  await initCompany(scope, { taxStatus: 'regular' });
  return { dir, scope };
}

describe('Books tax cases', () => {
  it('domestic 19 percent', async () => {
    const { dir, scope } = await regularCompany();
    const { customer } = await newCustomer(scope, dir, { customerType: 'b2c', countryCode: 'DE' });
    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id, serviceDate: '2026-10-01' });
    await addLine(scope, draft.document.id, { title: 'Consulting', quantity: 2000, unitPrice: 5000, taxClass: 'standard' });
    const { document } = await issue(scope, draft.document.id, { actorUserId: ACTOR });
    expect(document.document).toMatchObject({ subtotal: 10000, taxAmount: 1900, total: 11900, taxNote: null, reverseCharge: false, kleinunternehmer: false });
    expect(document.lines[0]).toMatchObject({ taxRate: 1900, taxAmount: 1900, taxTreatment: 'standard' });
    expect(document.document.taxSummary).toEqual([{ taxRate: 1900, taxTreatment: 'standard', net: 10000, tax: 1900 }]);
  });

  it('reduced 7 percent', async () => {
    const { dir, scope } = await regularCompany();
    const { customer } = await newCustomer(scope, dir, { customerType: 'b2c', countryCode: 'DE' });
    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id, serviceDate: '2026-10-01' });
    await addLine(scope, draft.document.id, { title: 'Book', quantity: 1000, unitPrice: 2000, taxClass: 'reduced' });
    // An explicit override wins over the class and snapshots a consistent pair.
    await addLine(scope, draft.document.id, { title: 'Ticket', quantity: 1000, unitPrice: 1000, taxRateOverride: 700 });
    const { document } = await issue(scope, draft.document.id, { actorUserId: ACTOR });
    expect(document.lines.map((l) => [l.taxRate, l.taxAmount, l.taxTreatment])).toEqual([
      [700, 140, 'reduced'],
      [700, 70, 'reduced'],
    ]);
    expect(document.document).toMatchObject({ subtotal: 3000, taxAmount: 210, total: 3210 });
  });

  it('EU business reverse charge: zero VAT plus the note', async () => {
    const { dir, scope } = await regularCompany();
    const { customer } = await newCustomer(scope, dir, { customerType: 'b2b', vatId: 'FR12345678901', countryCode: 'FR' });
    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id, serviceDate: '2026-10-01' });
    await addLine(scope, draft.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 50000, taxClass: 'standard' });
    const { document } = await issue(scope, draft.document.id, { actorUserId: ACTOR });
    expect(document.document).toMatchObject({
      reverseCharge: true,
      taxNote: REVERSE_CHARGE_NOTICE,
      taxAmount: 0,
      total: 50000,
      customerType: 'b2b',
      vatId: 'FR12345678901',
    });
    expect(document.document.taxSummary).toEqual([{ taxRate: 0, taxTreatment: 'reverse_charge', net: 50000, tax: 0 }]);
  });

  it('section 19 suppression: zero VAT, the exemption note, only the kleinunternehmer group', async () => {
    const dir = new FakeDirectory();
    const scope = scopeFor(env.appDb, env.tgId, newTenantId(), dir);
    await initCompany(scope, { taxStatus: 'small_business' });
    const { customer } = await newCustomer(scope, dir, { customerType: 'b2b', vatId: 'DE123456789' });
    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });
    await addLine(scope, draft.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000, taxClass: 'standard' });
    await addLine(scope, draft.document.id, { title: 'Book', quantity: 1000, unitPrice: 2000, taxClass: 'reduced' });
    // Under Section 19 no service date is required.
    const { document } = await issue(scope, draft.document.id, { actorUserId: ACTOR });
    expect(document.document).toMatchObject({ kleinunternehmer: true, taxAmount: 0, total: 12000, taxNote: DEFAULT_EXEMPTION_NOTE });
    expect(document.document.taxSummary).toEqual([{ taxRate: 0, taxTreatment: 'kleinunternehmer', net: 12000, tax: 0 }]);
  });

  it('mixed-rate tax_summary grouping', async () => {
    const { dir, scope } = await regularCompany();
    const { customer } = await newCustomer(scope, dir, { customerType: 'b2b', vatId: 'DE123456789', countryCode: 'DE' });
    const draft = await createDraft(scope, {
      docType: 'invoice',
      actorUserId: ACTOR,
      customerId: customer.id,
      servicePeriod: { start: '2026-09-01', end: '2026-09-30' },
    });
    await addLine(scope, draft.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000, taxClass: 'standard' });
    await addLine(scope, draft.document.id, { title: 'Hosting', quantity: 3000, unitPrice: 1000, taxClass: 'standard', discountBp: 1000 });
    await addLine(scope, draft.document.id, { title: 'Book', quantity: 1000, unitPrice: 2000, taxClass: 'reduced' });
    await addLine(scope, draft.document.id, { title: 'Export item', quantity: 1000, unitPrice: 500, taxClass: 'zero' });
    await addLine(scope, draft.document.id, { kind: 'text', title: 'Thank you' });
    const { document } = await issue(scope, draft.document.id, { actorUserId: ACTOR });
    expect(document.document.taxSummary).toEqual([
      { taxRate: 1900, taxTreatment: 'standard', net: 12700, tax: 2413 },
      { taxRate: 700, taxTreatment: 'reduced', net: 2000, tax: 140 },
      { taxRate: 0, taxTreatment: 'zero', net: 500, tax: 0 },
    ]);
    expect(document.document).toMatchObject({ subtotal: 15200, taxAmount: 2553, total: 17753 });
  });

  it('a regular company requires a service date, and refuses a third-country recipient', async () => {
    const { dir, scope } = await regularCompany();
    const { customer } = await newCustomer(scope, dir, { customerType: 'b2c', countryCode: 'DE' });
    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });
    await addLine(scope, draft.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });
    await expect(issue(scope, draft.document.id, { actorUserId: ACTOR })).rejects.toMatchObject({ code: 'SERVICE_DATE_REQUIRED' });

    const { customer: abroad } = await newCustomer(scope, dir, { customerType: 'b2b', countryCode: 'US' });
    const third = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: abroad.id, serviceDate: '2026-10-01' });
    await addLine(scope, third.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });
    await expect(issue(scope, third.document.id, { actorUserId: ACTOR })).rejects.toMatchObject({ code: 'TAX_CASE_UNSUPPORTED' });
    expect((await getDocument(scope, third.document.id)).document.status).toBe('draft');
  });

  it('a credit note references and offsets an issued invoice', async () => {
    const { dir, scope } = await regularCompany();
    const { customer } = await newCustomer(scope, dir, { customerType: 'b2c', countryCode: 'DE' });
    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id, serviceDate: '2026-10-01' });
    await addLine(scope, draft.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000, taxClass: 'standard' });
    await addLine(scope, draft.document.id, { title: 'Book', quantity: 1000, unitPrice: 2000, taxClass: 'reduced' });
    const { document: invoice } = await issue(scope, draft.document.id, { actorUserId: ACTOR });

    // The contacts database is not needed for a cancellation.
    dir.failing = true;
    const result = await cancelInvoice(scope, invoice.document.id, { actorUserId: ACTOR, reason: 'Wrong recipient' });
    expect(result.alreadyCancelled).toBe(false);
    const cn = result.creditNote.document;
    expect(cn).toMatchObject({
      docType: 'credit_note',
      status: 'issued',
      correctsDocumentId: invoice.document.id,
      documentNumber: 'GS-1',
      numberValue: 1,
      subtotal: invoice.document.subtotal,
      taxAmount: invoice.document.taxAmount,
      total: invoice.document.total,
      dueDate: null,
      paymentReference: null,
    });
    expect(cn.taxSummary).toEqual(invoice.document.taxSummary);
    expect(cn.customerSnapshot).toEqual(invoice.document.customerSnapshot);
    expect(result.creditNote.lines.map((l) => [l.title, l.subtotal, l.taxAmount])).toEqual(
      invoice.lines.map((l) => [l.title, l.subtotal, l.taxAmount]),
    );
    expect(result.creditNote.events.map((e) => e.eventType)).toEqual(['draft_created', 'issued']);
    expect(result.invoice.document.status).toBe('cancelled');
    expect(result.invoice.document.documentNumber).toBe('62');
    expect(result.invoice.events.at(-1)).toMatchObject({
      eventType: 'cancelled',
      fromStatus: 'issued',
      toStatus: 'cancelled',
      payload: { creditNoteId: cn.id, creditNoteNumber: 'GS-1', reason: 'Wrong recipient' },
    });

    // Idempotent: a second cancellation returns the same credit note.
    const again = await cancelInvoice(scope, invoice.document.id, { actorUserId: ACTOR, reason: 'Retry' });
    expect(again.alreadyCancelled).toBe(true);
    expect(again.creditNote.document.id).toBe(cn.id);
    // A draft or a credit note cannot be cancelled.
    await expect(cancelInvoice(scope, cn.id, { actorUserId: ACTOR, reason: 'x' })).rejects.toMatchObject({ code: 'NOT_CANCELLABLE' });
  });

  it('the issuer tax id follows the tax status and reverse charge', async () => {
    // Section 19: the small-business id alone is enough.
    const dir = new FakeDirectory();
    const small = scopeFor(env.appDb, env.tgId, newTenantId(), dir);
    await initBooksCompany(small, {
      taxStatus: 'small_business',
      senderBlock: syntheticSender({ taxNumber: null, vatId: null, smallBusinessId: 'DE123456789-00001' }),
      counters: [{ docType: 'invoice', format: '{n}', nextValue: 62 }],
    });
    const { customer: c1 } = await newCustomer(small, dir);
    const d1 = await createDraft(small, { docType: 'invoice', actorUserId: ACTOR, customerId: c1.id });
    await addLine(small, d1.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });
    expect((await issue(small, d1.document.id, { actorUserId: ACTOR })).document.document.documentNumber).toBe('62');

    // Regular taxation: the small-business id alone is refused.
    const regular = scopeFor(env.appDb, env.tgId, newTenantId(), dir);
    await initBooksCompany(regular, {
      taxStatus: 'regular',
      senderBlock: syntheticSender({ taxNumber: null, vatId: null, smallBusinessId: 'DE123456789-00001' }),
      counters: [{ docType: 'invoice', format: '{n}', nextValue: 1 }],
    });
    const { customer: c2 } = await newCustomer(regular, dir, { customerType: 'b2c' });
    const d2 = await createDraft(regular, { docType: 'invoice', actorUserId: ACTOR, customerId: c2.id, serviceDate: '2026-10-01' });
    await addLine(regular, d2.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });
    await expect(issue(regular, d2.document.id, { actorUserId: ACTOR })).rejects.toMatchObject({
      code: 'SENDER_INCOMPLETE',
      details: { missing: ['taxNumber|vatId'] },
    });

    // Reverse charge: the issuer's VAT id is required even with a tax number.
    const rc = scopeFor(env.appDb, env.tgId, newTenantId(), dir);
    await initBooksCompany(rc, {
      taxStatus: 'regular',
      senderBlock: syntheticSender({ vatId: null }),
      counters: [{ docType: 'invoice', format: '{n}', nextValue: 1 }],
    });
    const { customer: c3 } = await newCustomer(rc, dir, { customerType: 'b2b', vatId: 'FR12345678901', countryCode: 'FR' });
    const d3 = await createDraft(rc, { docType: 'invoice', actorUserId: ACTOR, customerId: c3.id, serviceDate: '2026-10-01' });
    await addLine(rc, d3.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });
    await expect(issue(rc, d3.document.id, { actorUserId: ACTOR })).rejects.toMatchObject({
      code: 'SENDER_INCOMPLETE',
      details: { missing: ['vatId'] },
    });
  });

  it('a credit note is never dated before the invoice it cancels', async () => {
    const { dir, scope } = await regularCompany();
    const { customer } = await newCustomer(scope, dir, { customerType: 'b2c' });
    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id, serviceDate: '2026-10-01' });
    await addLine(scope, draft.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });
    const today = berlinToday();
    await issue(scope, draft.document.id, { actorUserId: ACTOR, issueDate: today });
    await expect(
      cancelInvoice(scope, draft.document.id, { actorUserId: ACTOR, reason: 'Backdated', issueDate: addDays(today, -1) }),
    ).rejects.toMatchObject({ code: 'ISSUE_DATE_OUT_OF_ORDER' });
    const same = await cancelInvoice(scope, draft.document.id, { actorUserId: ACTOR, reason: 'Same day', issueDate: today });
    expect(same.creditNote.document.issueDate).toBe(today);
  });

  it('the cancellation reason is capped at 200 characters', async () => {
    const { dir, scope } = await regularCompany();
    const { customer } = await newCustomer(scope, dir, { customerType: 'b2c' });
    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id, serviceDate: '2026-10-01' });
    await addLine(scope, draft.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });
    await issue(scope, draft.document.id, { actorUserId: ACTOR });
    await expect(
      cancelInvoice(scope, draft.document.id, { actorUserId: ACTOR, reason: 'x'.repeat(201) }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const ok = await cancelInvoice(scope, draft.document.id, { actorUserId: ACTOR, reason: 'x'.repeat(200) });
    expect(ok.alreadyCancelled).toBe(false);
  });

  it('line and document amounts stay within INTEGER (2^31 - 1 cents)', async () => {
    // Section 19 (no tax): a line of exactly the limit fits and issues.
    const dir = new FakeDirectory();
    const small = scopeFor(env.appDb, env.tgId, newTenantId(), dir);
    await initCompany(small);
    const { customer } = await newCustomer(small, dir);
    const draft = await createDraft(small, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });
    const atLimit = await addLine(small, draft.document.id, { title: 'Large', quantity: 1000, unitPrice: MAX_AMOUNT_CENTS });
    expect(atLimit.document.total).toBe(MAX_AMOUNT_CENTS);
    // One more cent on the document: refused, nothing written.
    await expect(addLine(small, draft.document.id, { title: 'Cent', quantity: 1000, unitPrice: 1 })).rejects.toMatchObject({
      code: 'INVALID_LINE',
    });
    // One line above the limit: refused.
    await expect(
      addLine(small, draft.document.id, { title: 'Too large', quantity: 1001, unitPrice: MAX_AMOUNT_CENTS }),
    ).rejects.toMatchObject({ code: 'INVALID_LINE' });
    expect((await getDocument(small, draft.document.id)).lines).toHaveLength(1);
    expect((await issue(small, draft.document.id, { actorUserId: ACTOR })).document.document.total).toBe(MAX_AMOUNT_CENTS);

    // Regular taxation: the net fits but net plus 19 percent does not.
    const { dir: dir2, scope: regular } = await regularCompany();
    const { customer: c2 } = await newCustomer(regular, dir2, { customerType: 'b2c' });
    const d2 = await createDraft(regular, { docType: 'invoice', actorUserId: ACTOR, customerId: c2.id });
    await expect(
      addLine(regular, d2.document.id, { title: 'Large', quantity: 1000, unitPrice: MAX_AMOUNT_CENTS, taxClass: 'standard' }),
    ).rejects.toMatchObject({ code: 'INVALID_LINE' });
  });
});
