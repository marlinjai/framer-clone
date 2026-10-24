// src/server/books/correct.ts
//
// The Correct flow, step one ("Korrigieren", plan
// docs/plans/2026-10-21-books-visual-template-composer.md, decision 9): an
// issued invoice is never edited (GoBD); instead a REPLACEMENT DRAFT is created,
// prefilled with the invoice's data and pointing at it through
// `replaces_document_id` (011_books_replacement). Nothing is cancelled here.
// Issuing that draft (issue.ts) cancels the old invoice through a credit note
// and issues the replacement in ONE transaction, so a customer never holds a
// credit note without the corrected invoice, and an abandoned draft cancels
// nothing.
//
//   1. Lock the invoice FOR UPDATE (the lock cancelInvoice takes too, so a
//      correction and a cancellation of the same invoice serialize).
//   2. Only an issued (not cancelled) invoice made in the editor can be
//      corrected (NOT_CORRECTABLE otherwise; the database refuses the link too,
//      BK011). Imported invoices keep plain cancellation: an import may be in
//      CHF or carry an incomplete printed address, so a copied draft could not
//      be issued.
//   3. One replacement per invoice: an existing one is returned
//      (`existing: true`), so a second click reopens the same draft (the unique
//      index refuses a second one in any case).
//   4. Insert the draft with the invoice's customer, template, net or gross
//      mode, service date or period, payment terms, contract reference, intro
//      and outro, and copies of its lines (inputs, positions, variant links),
//      then recompute every derived figure under the tax profile as it stands
//      today (the company setting and the customer may have changed since the
//      invoice was issued: the replacement is a new document issued today).
//   5. Write `draft_created` (naming the replaced invoice) and `customer_set`.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { BooksError, invalid } from './errors';
import { finishDraftMutation, inDraftTransaction, requireUsableCustomer } from './repository/documents';
import { insertEvent } from './repository/events';
import { readPersistedView, selectDocumentRow, selectLineRows, type DocumentView } from './repository/read';
import type { BooksScope } from './scope';
import { requireSettings } from './settings';
import { toJsonb } from './snapshots';

const correctInput = z.object({
  actorUserId: z.string().trim().min(1).max(200),
});
export type StartCorrectionInput = z.input<typeof correctInput>;

export interface StartCorrectionResult {
  /** The replacement draft. */
  document: DocumentView;
  /** True when the invoice already had a replacement (returned, not created again). */
  existing: boolean;
}

/** Statuses after issue in which an invoice is still valid (and so can be corrected). */
const CORRECTABLE = new Set(['issued', 'sent', 'accepted', 'rejected', 'paid']);

export async function startCorrection(
  scope: BooksScope,
  invoiceId: string,
  input: StartCorrectionInput,
): Promise<StartCorrectionResult> {
  const parsed = correctInput.safeParse(input);
  if (!parsed.success) throw invalid('INVALID_INPUT', parsed.error.issues);
  const args = parsed.data;

  return inDraftTransaction(scope, async (trx): Promise<StartCorrectionResult> => {
    // (1) Lock the invoice.
    const invoice = await selectDocumentRow(trx, scope, invoiceId, { forUpdate: true });
    if (!invoice) throw new BooksError('NOT_FOUND', 'NOT_FOUND: document', { documentId: invoiceId });

    // (2) What can be corrected.
    if (invoice.doc_type !== 'invoice' || invoice.source !== 'editor' || !CORRECTABLE.has(invoice.status)) {
      throw new BooksError(
        'NOT_CORRECTABLE',
        `NOT_CORRECTABLE: a ${invoice.status} ${invoice.source} ${invoice.doc_type}`,
        { documentId: invoiceId, docType: invoice.doc_type, source: invoice.source, status: invoice.status },
      );
    }

    // (3) An existing replacement is returned (a second click reopens it).
    const existing = await trx
      .selectFrom('sales_document')
      .select('id')
      .where('tenant_id', '=', scope.tenantId)
      .where('replaces_document_id', '=', invoiceId)
      .executeTakeFirst();
    if (existing) {
      return { document: await readPersistedView(trx, scope, existing.id), existing: true };
    }
    if (!invoice.customer_id) {
      // An issued editor invoice always has a customer (007's CHECKs); kept as a guard.
      throw new BooksError('CUSTOMER_REQUIRED', 'CUSTOMER_REQUIRED', { documentId: invoiceId });
    }

    // (4) The draft, then copies of the lines, then the recomputation.
    await requireSettings(trx, scope);
    const customer = await requireUsableCustomer(trx, scope, invoice.customer_id);
    const now = new Date();
    const id = randomUUID();
    // The invoice's template, unless it was archived since: then the company's default (or none).
    const template = invoice.template_id
      ? await trx
          .selectFrom('document_template')
          .select('id')
          .where('tenant_id', '=', scope.tenantId)
          .where('id', '=', invoice.template_id)
          .where('archived_at', 'is', null)
          .forShare()
          .executeTakeFirst()
      : undefined;
    const fallback = template
      ? undefined
      : await trx
          .selectFrom('document_template')
          .select('id')
          .where('tenant_id', '=', scope.tenantId)
          .where('is_default', '=', true)
          .where('archived_at', 'is', null)
          .forShare()
          .executeTakeFirst();
    await trx
      .insertInto('sales_document')
      .values({
        id,
        tenant_id: scope.tenantId,
        doc_type: 'invoice',
        status: 'draft',
        source: 'editor',
        customer_id: customer.id,
        template_id: template?.id ?? fallback?.id ?? null,
        replaces_document_id: invoiceId,
        net_or_gross: invoice.net_or_gross,
        service_date: invoice.service_date,
        service_period_start: invoice.service_period_start,
        service_period_end: invoice.service_period_end,
        payment_terms_days: invoice.payment_terms_days,
        contract_reference: invoice.contract_reference,
        subject: invoice.subject,
        intro_text: invoice.intro_text,
        outro_text: invoice.outro_text,
        intro_format: invoice.intro_format === null ? null : toJsonb(invoice.intro_format),
        outro_format: invoice.outro_format === null ? null : toJsonb(invoice.outro_format),
        currency_code: invoice.currency_code,
        updated_at: now,
      })
      .execute();
    for (const line of await selectLineRows(trx, scope, invoiceId)) {
      await trx
        .insertInto('sales_document_line')
        .values({
          id: randomUUID(),
          tenant_id: scope.tenantId,
          document_id: id,
          position: line.position,
          kind: line.kind,
          title: line.title,
          description: line.description,
          quantity: line.quantity,
          unit_label: line.unit_label,
          unit_price: line.unit_price,
          discount_bp: line.discount_bp,
          subtotal: line.subtotal,
          tax_class: line.tax_class,
          tax_rate_override: line.tax_rate_override,
          tax_rate: line.tax_rate,
          tax_amount: line.tax_amount,
          tax_treatment: line.tax_treatment,
          variant_ref: line.variant_ref,
          variant_ref_source: line.variant_ref_source,
          updated_at: now,
        })
        .execute();
    }
    const draft = await selectDocumentRow(trx, scope, id, { forUpdate: true });
    if (!draft) throw new BooksError('NOT_FOUND', 'NOT_FOUND: document', { documentId: id });
    await finishDraftMutation(trx, scope, draft, {}, { forceAll: true, customer });

    // (5) The events (ids only, no recipient data).
    await insertEvent(trx, scope, {
      documentId: id,
      eventType: 'draft_created',
      fromStatus: null,
      toStatus: 'draft',
      actorUserId: args.actorUserId,
      payload: { docType: 'invoice', replacesDocumentId: invoiceId },
    });
    await insertEvent(trx, scope, {
      documentId: id,
      eventType: 'customer_set',
      fromStatus: null,
      toStatus: null,
      actorUserId: args.actorUserId,
      payload: { customerId: customer.id, previousCustomerId: null, taxProfileChanged: true },
    });
    return { document: await readPersistedView(trx, scope, id), existing: false };
  });
}
