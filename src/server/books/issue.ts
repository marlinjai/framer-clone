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
//   4. Repeat the billable-line check on the lines under the lock. Read the
//      company setting (SETTINGS_MISSING). Under regular taxation a service date or period is
//      required (SERVICE_DATE_REQUIRED); under Section 19 both stay optional.
//   5. Resolve the tax profile (TAX_CASE_UNSUPPORTED for a third country under
//      regular taxation); validate the sender block for it (SENDER_INCOMPLETE:
//      under Section 19 one of tax number, VAT id or small-business id, under
//      regular taxation tax number or VAT id, under reverse charge the VAT id);
//      recompute every line and the totals from the inputs.
//   6. Determine the issue date (argument or today in Europe/Berlin; never in
//      the future).
//   7. Lock the counter, check the date against the last number of the type
//      (ISSUE_DATE_OUT_OF_ORDER), allocate the number, advance the counter.
//   8. Update the document to issued with its number, dates, payment
//      reference, snapshots and tax fields. The guard trigger checks the totals
//      against the lines (BK005); the CHECKs check completeness.
//   9. Insert the `issued` event. Commit.
//
// A REPLACEMENT draft (the Correct flow, correct.ts; `replaces_document_id`
// set) additionally cancels the invoice it replaces, inside the same
// transaction, between steps 5 and 7: the cancellation's steps run through
// cancelInvoiceIn (cancel.ts), so the credit note takes the next credit note
// number, the old invoice turns cancelled, and only then does the replacement
// take the next invoice number. Lock order: this draft, the old invoice, the
// credit note counter, the invoice counter. An old invoice cancelled by
// another path in the meantime is REPLACED_INVOICE_CANCELLED (checked before
// the transaction for a fast answer, and again under its lock); the user can
// then issue the draft as an ordinary invoice (updateDraft with
// `replacesDocumentId: null`). Any failure rolls all of it back: nothing is
// cancelled, no number is taken. The database refuses a replacement issued
// without the cancellation (011, BK011).

import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';

import type { CommerceDB } from '../commerce/db-types';

import { ReverseChargeNotAllowedError } from '../tax/germanVat';
import { totalsExceedLimit } from './totals';
import { BooksError, invalid, withDbErrors } from './errors';
import { addDays, allocateNumber, resolveIssueDate } from './numbering';
import { readRecipient } from './recipients';
import { readPersistedView, selectDocumentRow, selectLineRows, type DocumentView } from './repository/read';
import { profileFor, selectCustomerRow, syncDraftTaxState } from './repository/taxState';
import { insertEvent } from './repository/events';
import { cancelInvoiceIn } from './cancel';
import { templateSnapshotFor } from './repository/templates';
import { logoBlocks } from './template/schema';
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
  // The draft version the caller confirmed (phase 2's editor shows the totals
  // and asks for confirmation; a change made elsewhere in between must not be
  // issued unseen). Checked before and again under the document lock.
  expectedVersion: z.number().int().min(0).optional(),
});
export type IssueInput = z.input<typeof issueInput>;

export interface IssueResult {
  document: DocumentView;
  alreadyIssued: boolean;
  /**
   * For a replacement issued now: the invoice it replaced (now cancelled) and
   * the credit note that cancelled it (also on an `alreadyIssued` return, so a
   * retry answers what the first call would have). Absent otherwise.
   */
  replaced?: { invoiceId: string; creditNoteId: string };
}

/** The cancellation reason written for a replaced invoice (a business reason, no personal data). */
export const REPLACEMENT_CANCEL_REASON = 'Ersetzt durch eine korrigierte Rechnung';

/**
 * Test-only hooks, passed explicitly (never an environment flag): a fault
 * injected after the counter update proves a rolled-back issue leaves no gap.
 */
export interface IssueOptions {
  afterCounterUpdate?: () => void | Promise<void>;
  /** Runs between the pre-checks and the transaction (proves the checks are repeated under the lock). */
  beforeTransaction?: () => void | Promise<void>;
  /** The clock: "today" (Europe/Berlin) and `issued_at`. */
  now?: Date;
  /**
   * Runs inside the issue transaction after the document is frozen and its
   * event written, before the commit, with the issued view (for a replacement
   * also once with the credit note that cancels the replaced invoice). A throw rolls the
   * whole issue back: the document stays a draft and no number is taken. The
   * routes render, check and store the PDF of record here (render/store.ts), so
   * an invoice is never issued without a complete document of record.
   */
  beforeCommit?: (trx: Transaction<CommerceDB>, view: DocumentView) => Promise<void>;
}

/**
 * The answer for a document found already issued (a retry after a lost answer,
 * or a second click). A replacement also reports the invoice it replaced and
 * the credit note that cancelled it, so the retry says the same as the first
 * answer would have.
 */
async function alreadyIssued(db: Db, scope: BooksScope, id: string): Promise<IssueResult> {
  const view = await readPersistedView(db, scope, id);
  const replacedId = view.document.replacesDocumentId;
  if (!replacedId) return { document: view, alreadyIssued: true };
  const creditNote = await db
    .selectFrom('sales_document')
    .select('id')
    .where('tenant_id', '=', scope.tenantId)
    .where('corrects_document_id', '=', replacedId)
    .where('status', '<>', 'draft')
    .executeTakeFirst();
  // The deferred trigger of 011 guarantees the credit note exists once the replacement is issued.
  if (!creditNote) return { document: view, alreadyIssued: true };
  return { document: view, alreadyIssued: true, replaced: { invoiceId: replacedId, creditNoteId: creditNote.id } };
}

type Db = Kysely<CommerceDB> | Transaction<CommerceDB>;

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
    return alreadyIssued(scope.db, scope, id);
  }
  if (args.expectedVersion !== undefined && before.version !== args.expectedVersion) {
    throw new BooksError('CONCURRENT_EDIT', 'CONCURRENT_EDIT: the draft changed since it was confirmed', {
      documentId: id,
    });
  }
  if (before.doc_type !== 'invoice') {
    throw new BooksError('DOC_TYPE_NOT_SUPPORTED', `DOC_TYPE_NOT_SUPPORTED: ${before.doc_type}`, {
      docType: before.doc_type,
    });
  }
  if (!before.customer_id) throw new BooksError('CUSTOMER_REQUIRED', 'CUSTOMER_REQUIRED', { documentId: id });
  if (before.replaces_document_id) {
    const replaced = await selectDocumentRow(scope.db, scope, before.replaces_document_id);
    if (replaced?.status === 'cancelled') {
      throw new BooksError(
        'REPLACED_INVOICE_CANCELLED',
        'REPLACED_INVOICE_CANCELLED: the invoice this draft replaces is already cancelled',
        { documentId: before.replaces_document_id, replacementId: id },
      );
    }
  }
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

  if (options.beforeTransaction) await options.beforeTransaction();

  return withDbErrors(() =>
    scope.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<IssueResult> => {
        // (3) Lock the document.
        const row = await selectDocumentRow(trx, scope, id, { forUpdate: true });
        if (!row) throw new BooksError('NOT_FOUND', 'NOT_FOUND: document', { documentId: id });
        if (row.status !== 'draft') {
          return alreadyIssued(trx, scope, id);
        }
        if (args.expectedVersion !== undefined && row.version !== args.expectedVersion) {
          throw new BooksError('CONCURRENT_EDIT', 'CONCURRENT_EDIT: the draft changed since it was confirmed', {
            documentId: id,
          });
        }
        if (row.customer_id !== customerBefore.id) {
          throw new BooksError('CONCURRENT_EDIT', 'CONCURRENT_EDIT: the customer changed during the issue', {
            documentId: id,
          });
        }
        const customer = await selectCustomerRow(trx, scope, customerBefore.id, { forShare: true });
        if (!customer) throw new BooksError('CUSTOMER_NOT_FOUND', 'CUSTOMER_NOT_FOUND', { customerId: customerBefore.id });
        // The billable-line check again, on the lines as they are under the lock:
        // a line removed after the pre-check must not let a zero-line invoice through.
        const lockedLines = await selectLineRows(trx, scope, id);
        if (!lockedLines.some((l) => l.kind !== 'text')) {
          throw new BooksError('NO_BILLABLE_LINES', 'NO_BILLABLE_LINES', { documentId: id });
        }

        // (4) Company setting.
        const settings = await requireSettings(trx, scope);
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
        // The sender, now that the profile says whether this is reverse charge
        // (which needs the issuer's VAT id).
        const missingSender = senderMissingFields(settings.senderBlock, {
          taxStatus: settings.taxStatus,
          reverseCharge: profile.reverseCharge,
        });
        if (missingSender.length > 0) {
          throw new BooksError('SENDER_INCOMPLETE', `SENDER_INCOMPLETE: ${missingSender.join(', ')}`, {
            missing: missingSender,
          });
        }
        const senderSnapshot = buildSenderSnapshot(settings.senderBlock);

        const now = options.now ?? new Date();
        const fields = await syncDraftTaxState(trx, scope, id, profile, customer, row.net_or_gross, {
          forceAll: true,
          now,
        });
        if (totalsExceedLimit({ subtotal: fields.subtotal, taxAmount: fields.tax_amount, total: fields.total })) {
          throw invalid('INVALID_LINE', [{ path: ['total'], message: 'the document total exceeds the largest amount (21,474,836.47 EUR)' }]);
        }

        // The Correct flow: cancel the replaced invoice first (its credit note
        // takes its number before this invoice takes its own).
        let replaced: IssueResult['replaced'];
        if (row.replaces_document_id) {
          const cancellation = await cancelInvoiceIn(trx, scope, row.replaces_document_id, {
            actorUserId: args.actorUserId,
            reason: REPLACEMENT_CANCEL_REASON,
            issueDate,
            now,
            completedRecipient: null,
            beforeCommit: options.beforeCommit,
            replacementId: id,
          });
          replaced = { invoiceId: row.replaces_document_id, creditNoteId: cancellation.creditNote.document.id };
        }

        // (7) The counter (the issue date was resolved in step 6, up front).
        const number = await allocateNumber(trx, scope, 'invoice', issueDate);
        if (options.afterCounterUpdate) await options.afterCounterUpdate();

        // (8) Freeze.
        const customerSnapshot = buildCustomerSnapshot(contact, {
          customerType: customer.customer_type,
          vatId: customer.vat_id,
          taxNumber: customer.tax_number,
        });
        // Reverse charge must name the recipient's VAT id (section 14a (1) UStG).
        if (profile.reverseCharge && !customerSnapshot.vatId?.trim()) {
          throw new BooksError('REVERSE_CHARGE_NOT_ALLOWED', 'REVERSE_CHARGE_NOT_ALLOWED: the recipient has no VAT id', {
            missing: ['recipient.vatId'],
          });
        }
        const templateSnapshot = await templateSnapshotFor(trx, scope, row.template_id);
        // One template, one logo (the snapshot freezes one): a layout saved before that rule named
        // two images would lose one silently, so it is refused like any layout that does not fit.
        const differing = logoBlocks(templateSnapshot.document).filter(
          (l) => l.block.assetSha256 !== null && l.block.assetSha256 !== templateSnapshot.logo?.sha256,
        );
        if (differing.length > 0) {
          const missing = differing.map((l) => `layout.logo_assets_differ.${l.block.id}`);
          throw new BooksError('RENDER_INCOMPLETE', `RENDER_INCOMPLETE: ${missing.join(', ')}`, { missing });
        }
        await trx
          .updateTable('sales_document')
          .set({
            ...fields,
            tax_summary: toJsonb(fields.tax_summary),
            template_snapshot: toJsonb(templateSnapshot),
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
            ...(replaced ? { replacesDocumentId: replaced.invoiceId, creditNoteId: replaced.creditNoteId } : {}),
          },
        });
        const issued = await readPersistedView(trx, scope, id);
        if (options.beforeCommit) await options.beforeCommit(trx, issued);
        return replaced ? { document: issued, alreadyIssued: false, replaced } : { document: issued, alreadyIssued: false };
      }),
  );
}
