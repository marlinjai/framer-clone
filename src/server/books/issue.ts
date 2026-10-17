// src/server/books/issue.ts
//
// Issuing an invoice (Books plan P1.6, "issue, step by step"). The document id
// is the idempotency key: a retry after a lost response, or a second click,
// finds the document issued and returns it with `alreadyIssued: true` and the
// same number; two concurrent calls serialize on the document row lock and the
// loser returns the winner's result. No call ever allocates a second number for
// one document.
//
//   1. Validate the input. Outside any transaction, read the document. Already
//      issued (or later): return it. Require an invoice, a customer
//      (CUSTOMER_REQUIRED) and a billable line (NO_BILLABLE_LINES).
//   2. Read the customer, then the contact through the RecipientDirectory,
//      BEFORE the transaction (a network read must not hold the document and
//      counter locks; there is no cross-database transaction). Unreachable:
//      RECIPIENT_UNAVAILABLE; missing: RECIPIENT_NOT_FOUND; archived:
//      RECIPIENT_ARCHIVED; a section 34a field empty: RECIPIENT_INCOMPLETE with
//      the field names. Never an empty, partial or cached recipient.
//   3. Open the transaction; lock the document FOR UPDATE. No longer a draft: a
//      concurrent issue won, return it. Its customer changed since step 2:
//      CONCURRENT_EDIT.
//   4. Read the company setting (SETTINGS_MISSING), validate the sender block
//      (SENDER_INCOMPLETE). Under regular taxation a service date or period is
//      required (SERVICE_DATE_REQUIRED); under Section 19 both stay optional.
//   5. Resolve the tax profile (TAX_CASE_UNSUPPORTED for a third country under
//      regular taxation); recompute every line and the totals from the inputs.
//   6. Determine the issue date (argument or today in Europe/Berlin; never in
//      the future).
//   7. Lock the counter, check the date against the last number of the type
//      (ISSUE_DATE_OUT_OF_ORDER), allocate the number, advance the counter.
//   8. Update the document to issued with its number, dates, payment
//      reference, snapshots and tax fields. The guard trigger checks the totals
//      against the lines (BK005); the CHECKs check completeness.
//   9. Insert the `issued` event. Commit.

import { z } from 'zod';

import { ReverseChargeNotAllowedError } from '../tax/germanVat';
import { BooksError, invalid, withDbErrors } from './errors';
import { addDays, allocateNumber, resolveIssueDate } from './numbering';
import { readRecipient } from './recipients';
import { readPersistedView, selectDocumentRow, selectLineRows, type DocumentView } from './repository/read';
import { profileFor, selectCustomerRow, syncDraftTaxState } from './repository/taxState';
import { insertEvent } from './repository/events';
import type { BooksScope } from './scope';
import { requireSettings } from './settings';
import {
  buildCustomerSnapshot,
  buildSenderSnapshot,
  recipientMissingFields,
  senderMissingFields,
  toJsonb,
} from './snapshots';

const issueInput = z.object({
  actorUserId: z.string().trim().min(1).max(200),
  issueDate: z.string().optional(),
});
export type IssueInput = z.input<typeof issueInput>;

export interface IssueResult {
  document: DocumentView;
  alreadyIssued: boolean;
}

/**
 * Test-only hooks, passed explicitly (never an environment flag): a fault
 * injected after the counter update proves a rolled-back issue leaves no gap.
 */
export interface IssueOptions {
  afterCounterUpdate?: () => void | Promise<void>;
  /** The clock for "today" (Europe/Berlin). */
  now?: Date;
}

const ISSUED_OR_LATER = new Set(['issued', 'sent', 'accepted', 'rejected', 'paid', 'cancelled']);

export async function issue(
  scope: BooksScope,
  id: string,
  input: IssueInput,
  options: IssueOptions = {},
): Promise<IssueResult> {
  const parsed = issueInput.safeParse(input);
  if (!parsed.success) throw invalid('INVALID_INPUT', parsed.error.issues);
  const args = parsed.data;
  // (6) The issue date is validated up front (a real day, not in the future);
  // its order against the last number is checked under the counter lock (7).
  const issueDate = resolveIssueDate(args.issueDate, options.now);

  // (1) Read outside any transaction.
  const before = await selectDocumentRow(scope.db, scope, id);
  if (!before) throw new BooksError('NOT_FOUND', 'NOT_FOUND: document', { documentId: id });
  if (ISSUED_OR_LATER.has(before.status)) {
    return { document: await readPersistedView(scope.db, scope, id), alreadyIssued: true };
  }
  if (before.doc_type !== 'invoice') {
    throw new BooksError('DOC_TYPE_NOT_SUPPORTED', `DOC_TYPE_NOT_SUPPORTED: ${before.doc_type}`, {
      docType: before.doc_type,
    });
  }
  if (!before.customer_id) throw new BooksError('CUSTOMER_REQUIRED', 'CUSTOMER_REQUIRED', { documentId: id });
  const lines = await selectLineRows(scope.db, scope, id);
  if (!lines.some((l) => l.kind !== 'text')) {
    throw new BooksError('NO_BILLABLE_LINES', 'NO_BILLABLE_LINES', { documentId: id });
  }

  // (2) The customer, then the contact, before the transaction.
  const customerBefore = await selectCustomerRow(scope.db, scope, before.customer_id);
  if (!customerBefore) throw new BooksError('CUSTOMER_NOT_FOUND', 'CUSTOMER_NOT_FOUND', { customerId: before.customer_id });
  const contact = await readRecipient(scope, customerBefore.contact_id);
  if (!contact) throw new BooksError('RECIPIENT_NOT_FOUND', 'RECIPIENT_NOT_FOUND', { customerId: customerBefore.id });
  if (contact.archived) throw new BooksError('RECIPIENT_ARCHIVED', 'RECIPIENT_ARCHIVED', { customerId: customerBefore.id });
  const missingRecipient = recipientMissingFields(contact);
  if (missingRecipient.length > 0) {
    throw new BooksError('RECIPIENT_INCOMPLETE', `RECIPIENT_INCOMPLETE: ${missingRecipient.join(', ')}`, {
      missing: missingRecipient,
    });
  }

  return withDbErrors(() =>
    scope.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<IssueResult> => {
        // (3) Lock the document.
        const row = await selectDocumentRow(trx, scope, id, { forUpdate: true });
        if (!row) throw new BooksError('NOT_FOUND', 'NOT_FOUND: document', { documentId: id });
        if (row.status !== 'draft') {
          return { document: await readPersistedView(trx, scope, id), alreadyIssued: true };
        }
        if (row.customer_id !== customerBefore.id) {
          throw new BooksError('CONCURRENT_EDIT', 'CONCURRENT_EDIT: the customer changed during the issue', {
            documentId: id,
          });
        }
        const customer = await selectCustomerRow(trx, scope, customerBefore.id, { forShare: true });
        if (!customer) throw new BooksError('CUSTOMER_NOT_FOUND', 'CUSTOMER_NOT_FOUND', { customerId: customerBefore.id });

        // (4) Company setting and sender.
        const settings = await requireSettings(trx, scope);
        const missingSender = senderMissingFields(settings.senderBlock);
        if (missingSender.length > 0) {
          throw new BooksError('SENDER_INCOMPLETE', `SENDER_INCOMPLETE: ${missingSender.join(', ')}`, {
            missing: missingSender,
          });
        }
        const senderSnapshot = buildSenderSnapshot(settings.senderBlock);
        if (settings.taxStatus === 'regular' && !row.service_date && !row.service_period_start) {
          throw new BooksError('SERVICE_DATE_REQUIRED', 'SERVICE_DATE_REQUIRED', { documentId: id });
        }

        // (5) Tax profile, every line and the totals recomputed from the inputs.
        let profile;
        try {
          profile = profileFor(settings, customer);
        } catch (err) {
          if (err instanceof ReverseChargeNotAllowedError) {
            throw new BooksError('REVERSE_CHARGE_NOT_ALLOWED', 'REVERSE_CHARGE_NOT_ALLOWED', undefined, { cause: err });
          }
          throw err;
        }
        if (!profile.supported) {
          throw new BooksError('TAX_CASE_UNSUPPORTED', 'TAX_CASE_UNSUPPORTED: a recipient outside the EU under regular taxation', {
            countryCode: customer.country_code,
          });
        }
        const now = new Date();
        const fields = await syncDraftTaxState(trx, scope, id, profile, customer, row.net_or_gross, {
          forceAll: true,
          now,
        });

        // (7) The counter (the issue date was resolved in step 6, up front).
        const number = await allocateNumber(trx, scope, 'invoice', issueDate);
        if (options.afterCounterUpdate) await options.afterCounterUpdate();

        // (8) Freeze.
        const customerSnapshot = buildCustomerSnapshot(contact, {
          customerType: customer.customer_type,
          vatId: customer.vat_id,
          taxNumber: customer.tax_number,
        });
        await trx
          .updateTable('sales_document')
          .set({
            ...fields,
            tax_summary: toJsonb(fields.tax_summary),
            status: 'issued',
            document_number: number.documentNumber,
            number_value: number.numberValue,
            issue_date: issueDate,
            due_date: addDays(issueDate, row.payment_terms_days),
            payment_reference: `Rechnung ${number.documentNumber}`,
            customer_snapshot: toJsonb(customerSnapshot),
            sender_snapshot: toJsonb(senderSnapshot),
            issued_at: now,
            updated_at: now,
          })
          .where('tenant_id', '=', scope.tenantId)
          .where('id', '=', id)
          .execute();

        // (9) The event (no recipient data in the payload).
        await insertEvent(trx, scope, {
          documentId: id,
          eventType: 'issued',
          fromStatus: 'draft',
          toStatus: 'issued',
          actorUserId: args.actorUserId,
          payload: {
            documentNumber: number.documentNumber,
            numberValue: number.numberValue,
            issueDate,
            total: fields.total,
            taxProfileKey: fields.tax_profile_key,
          },
        });
        return { document: await readPersistedView(trx, scope, id), alreadyIssued: false };
      }),
  );
}
