// src/server/books/cancel.ts
//
// Cancelling an invoice in full through a credit note (Books plan P1.6,
// "cancelInvoice, step by step"; partial credit notes are deferred). An invoice
// is cancelled only through a credit note, never by mutation: the
// sales_document_guard trigger refuses `-> cancelled` unless an issued credit
// note correcting it exists in the same transaction.
//
//   1. Open the transaction; lock the invoice FOR UPDATE (the same lock order as
//      issue: document, then counter). Already cancelled: return the existing
//      credit note (`alreadyCancelled: true`; the partial unique index makes a
//      second credit note impossible). A draft, or not an invoice:
//      NOT_CANCELLABLE.
//   2. Read the setting and build a fresh sender snapshot (the credit note is a
//      document the company issues today). The customer snapshot is copied from
//      the invoice, so a cancellation never depends on the contacts database
//      and always names the invoice's recipient.
//   3. Insert the credit note as a draft with the invoice's customer, currency,
//      net_or_gross, payment terms, tax fields and key, and copies of its lines
//      with the same derived values (no recompute: a cancellation offsets
//      exactly what was invoiced). Amounts stay non-negative; the document type
//      carries the sign. A credit note has no due date and no payment reference.
//   4. Lock the credit_note counter, allocate, issue the credit note; write its
//      `draft_created` and `issued` events.
//   5. Set the invoice to cancelled; write its `cancelled` event. Commit.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { BooksError, invalid, withDbErrors } from './errors';
import { allocateNumber, resolveIssueDate } from './numbering';
import { insertEvent } from './repository/events';
import { readPersistedView, selectDocumentRow, selectLineRows, type DocumentView } from './repository/read';
import type { BooksScope } from './scope';
import { requireSettings } from './settings';
import { buildSenderSnapshot, senderMissingFields, toJsonb } from './snapshots';

const cancelInput = z.object({
  actorUserId: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(1000),
  issueDate: z.string().optional(),
});
export type CancelInvoiceInput = z.input<typeof cancelInput>;

export interface CancelResult {
  invoice: DocumentView;
  creditNote: DocumentView;
  alreadyCancelled: boolean;
}

export async function cancelInvoice(
  scope: BooksScope,
  invoiceId: string,
  input: CancelInvoiceInput,
  options: { now?: Date } = {},
): Promise<CancelResult> {
  const parsed = cancelInput.safeParse(input);
  if (!parsed.success) throw invalid('INVALID_INPUT', parsed.error.issues);
  const args = parsed.data;
  const issueDate = resolveIssueDate(args.issueDate, options.now);

  return withDbErrors(() =>
    scope.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<CancelResult> => {
        // (1) Lock the invoice.
        const invoice = await selectDocumentRow(trx, scope, invoiceId, { forUpdate: true });
        if (!invoice) throw new BooksError('NOT_FOUND', 'NOT_FOUND: document', { documentId: invoiceId });
        if (invoice.doc_type !== 'invoice' || invoice.status === 'draft') {
          throw new BooksError('NOT_CANCELLABLE', `NOT_CANCELLABLE: a ${invoice.status} ${invoice.doc_type}`, {
            documentId: invoiceId,
            docType: invoice.doc_type,
            status: invoice.status,
          });
        }
        if (invoice.status === 'cancelled') {
          const existing = await trx
            .selectFrom('sales_document')
            .select('id')
            .where('tenant_id', '=', scope.tenantId)
            .where('corrects_document_id', '=', invoiceId)
            .executeTakeFirstOrThrow();
          return {
            invoice: await readPersistedView(trx, scope, invoiceId),
            creditNote: await readPersistedView(trx, scope, existing.id),
            alreadyCancelled: true,
          };
        }

        // (2) A fresh sender; the invoice's recipient.
        const settings = await requireSettings(trx, scope);
        const missingSender = senderMissingFields(settings.senderBlock);
        if (missingSender.length > 0) {
          throw new BooksError('SENDER_INCOMPLETE', `SENDER_INCOMPLETE: ${missingSender.join(', ')}`, {
            missing: missingSender,
          });
        }
        const senderSnapshot = buildSenderSnapshot(settings.senderBlock);

        // (3) The credit note as a draft, with copies of the lines.
        const now = new Date();
        const creditNoteId = randomUUID();
        await trx
          .insertInto('sales_document')
          .values({
            id: creditNoteId,
            tenant_id: scope.tenantId,
            doc_type: 'credit_note',
            status: 'draft',
            source: 'editor',
            customer_id: invoice.customer_id,
            template_id: invoice.template_id,
            corrects_document_id: invoiceId,
            service_date: invoice.service_date,
            service_period_start: invoice.service_period_start,
            service_period_end: invoice.service_period_end,
            payment_terms_days: invoice.payment_terms_days,
            contract_reference: invoice.contract_reference,
            currency_code: invoice.currency_code,
            tax_region: invoice.tax_region,
            customer_type: invoice.customer_type,
            vat_id: invoice.vat_id,
            reverse_charge: invoice.reverse_charge,
            net_or_gross: invoice.net_or_gross,
            kleinunternehmer: invoice.kleinunternehmer,
            tax_note: invoice.tax_note,
            tax_profile_key: invoice.tax_profile_key,
            subtotal: invoice.subtotal,
            tax_amount: invoice.tax_amount,
            total: invoice.total,
            tax_summary: toJsonb(invoice.tax_summary),
            updated_at: now,
          })
          .execute();
        for (const line of await selectLineRows(trx, scope, invoiceId)) {
          await trx
            .insertInto('sales_document_line')
            .values({
              id: randomUUID(),
              tenant_id: scope.tenantId,
              document_id: creditNoteId,
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
        await insertEvent(trx, scope, {
          documentId: creditNoteId,
          eventType: 'draft_created',
          fromStatus: null,
          toStatus: 'draft',
          actorUserId: args.actorUserId,
          payload: { docType: 'credit_note' },
        });

        // (4) Number and issue the credit note.
        const number = await allocateNumber(trx, scope, 'credit_note', issueDate);
        await trx
          .updateTable('sales_document')
          .set({
            status: 'issued',
            document_number: number.documentNumber,
            number_value: number.numberValue,
            issue_date: issueDate,
            customer_snapshot: toJsonb(invoice.customer_snapshot),
            sender_snapshot: toJsonb(senderSnapshot),
            issued_at: now,
            updated_at: now,
          })
          .where('tenant_id', '=', scope.tenantId)
          .where('id', '=', creditNoteId)
          .execute();
        await insertEvent(trx, scope, {
          documentId: creditNoteId,
          eventType: 'issued',
          fromStatus: 'draft',
          toStatus: 'issued',
          actorUserId: args.actorUserId,
          payload: {
            documentNumber: number.documentNumber,
            numberValue: number.numberValue,
            issueDate,
            total: invoice.total,
            correctsDocumentId: invoiceId,
          },
        });

        // (5) Cancel the invoice (the trigger finds the issued credit note).
        await trx
          .updateTable('sales_document')
          .set({ status: 'cancelled', updated_at: now })
          .where('tenant_id', '=', scope.tenantId)
          .where('id', '=', invoiceId)
          .execute();
        await insertEvent(trx, scope, {
          documentId: invoiceId,
          eventType: 'cancelled',
          fromStatus: invoice.status,
          toStatus: 'cancelled',
          actorUserId: args.actorUserId,
          payload: { creditNoteId, creditNoteNumber: number.documentNumber, reason: args.reason },
        });

        return {
          invoice: await readPersistedView(trx, scope, invoiceId),
          creditNote: await readPersistedView(trx, scope, creditNoteId),
          alreadyCancelled: false,
        };
      }),
  );
}
