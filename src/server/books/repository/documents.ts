// src/server/books/repository/documents.ts
//
// Draft documents (Books plan P1.6): create, edit, assign the customer. Every
// write runs in ONE read committed transaction; every mutation of an existing
// draft locks the document row FOR UPDATE, refuses anything but a draft
// (NOT_DRAFT), checks `expectedVersion` when given (CONCURRENT_EDIT, the
// optimistic concurrency of phase 2's editor), increments `version`, stamps
// `updated_at`, and brings the derived tax state in line with the tax profile
// key computed now (taxState.ts).

import { randomUUID } from 'node:crypto';
import type { Transaction } from 'kysely';
import { z } from 'zod';

import type { CommerceDB, NetOrGross } from '../../commerce/db-types';
import { BooksError, invalid, withDbErrors } from '../errors';
import { isIsoDate } from '../numbering';
import type { BooksScope } from '../scope';
import { requireSettings } from '../settings';
import { normalizeRichText, needsFormat, plainOf, richFromPlain, richTextSchema, type RichText } from '../render/richText';
import { toJsonb } from '../snapshots';
import { totalsExceedLimit } from '../totals';
import { insertEvent } from './events';
import { readPersistedView, selectDocumentRow, type DocumentRowWithSnapshots, type DocumentView } from './read';
import { profileFor, selectCustomerRow, syncDraftTaxState, type CustomerRow } from './taxState';

const isoDate = z.string().refine(isIsoDate, 'expected a calendar day YYYY-MM-DD');
const servicePeriod = z
  .object({ start: isoDate, end: isoDate })
  .refine((p) => p.start <= p.end, { message: 'start must not be after end', path: ['end'] });
const optionalText = (max: number) => z.string().max(max).nullable().optional();
/** A formatted intro or closing text (render/richText.ts); the plain text is derived from it, never sent with it. */
const optionalFormat = richTextSchema.optional();

/**
 * The stored pair of an intro or closing text, derived one way so the two can never disagree: from a format, its
 * plain words (and the format only when it is needed to print as written); from a plain text, no format, except
 * paragraphs for a text with line breaks, so they print as typed. Undefined when neither was sent.
 */
function textPair(
  which: 'introText' | 'outroText',
  text: string | null | undefined,
  format: RichText | undefined,
): { text: string | null; format: ReturnType<typeof toJsonb> | null } | undefined {
  if (text !== undefined && format !== undefined) {
    throw invalid('INVALID_INPUT', [{ path: [which], message: 'send the text or its format, not both' }]);
  }
  if (format !== undefined) {
    const rich = normalizeRichText(format);
    const plain = plainOf(rich);
    if (plain.trim() === '') return { text: null, format: null };
    return { text: plain, format: needsFormat(rich) ? toJsonb(rich) : null };
  }
  if (text === undefined) return undefined;
  if (text === null || text.trim() === '') return { text: null, format: null };
  return { text, format: /\r?\n/.test(text) ? toJsonb(normalizeRichText(richFromPlain(text))) : null };
}
/** The subject prints as one line: no line breaks, at most 200 characters (the column's CHECK, 016). */
const subjectText = z
  .string()
  .max(200)
  .refine((s) => !/[\r\n]/.test(s), 'the subject is one line')
  .nullable()
  .optional();
const actorUserId = z.string().trim().min(1).max(200);
const expectedVersion = z.number().int().min(0).optional();

/** Run a draft write in one read committed transaction, mapping trigger errors. */
export function inDraftTransaction<T>(
  scope: BooksScope,
  fn: (trx: Transaction<CommerceDB>) => Promise<T>,
): Promise<T> {
  return withDbErrors(() => scope.db.transaction().setIsolationLevel('read committed').execute(fn));
}

/**
 * Lock one draft of the company FOR UPDATE: NOT_FOUND (also for another
 * company's id), NOT_DRAFT, CONCURRENT_EDIT when `expectedVersion` is given and
 * stale.
 */
export async function lockDraft(
  trx: Transaction<CommerceDB>,
  scope: BooksScope,
  id: string,
  version?: number,
): Promise<DocumentRowWithSnapshots> {
  const row = await selectDocumentRow(trx, scope, id, { forUpdate: true });
  if (!row) throw new BooksError('NOT_FOUND', 'NOT_FOUND: document', { documentId: id });
  if (row.status !== 'draft') {
    throw new BooksError('NOT_DRAFT', `NOT_DRAFT: the document is ${row.status}`, { documentId: id, status: row.status });
  }
  if (version !== undefined && version !== row.version) {
    throw new BooksError('CONCURRENT_EDIT', 'CONCURRENT_EDIT: the draft changed since it was read', {
      documentId: id,
      expectedVersion: version,
      version: row.version,
    });
  }
  return row;
}

/** A customer of the company that may go on a draft: CUSTOMER_NOT_FOUND, CUSTOMER_ARCHIVED. */
export async function requireUsableCustomer(
  trx: Transaction<CommerceDB>,
  scope: BooksScope,
  customerId: string,
): Promise<CustomerRow> {
  const customer = await selectCustomerRow(trx, scope, customerId, { forShare: true });
  if (!customer) throw new BooksError('CUSTOMER_NOT_FOUND', 'CUSTOMER_NOT_FOUND', { customerId });
  if (customer.archived_at !== null) throw new BooksError('CUSTOMER_ARCHIVED', 'CUSTOMER_ARCHIVED', { customerId });
  return customer;
}

/** The document columns a draft edit may set directly (besides the derived ones). */
export interface DraftPatch {
  customer_id?: string | null;
  template_id?: string | null;
  net_or_gross?: NetOrGross;
  service_date?: string | null;
  service_period_start?: string | null;
  service_period_end?: string | null;
  payment_terms_days?: number;
  contract_reference?: string | null;
  subject?: string | null;
  intro_text?: string | null;
  intro_format?: ReturnType<typeof toJsonb> | null;
  outro_format?: ReturnType<typeof toJsonb> | null;
  outro_text?: string | null;
  /** Only ever set to null: a replacement draft becomes an ordinary invoice (the Correct flow). */
  replaces_document_id?: null;
  print_replaces_reference?: boolean;
}

/**
 * Finish a draft mutation inside its transaction: compute the tax profile from
 * the company setting and the (possibly new) customer, recompute every line
 * when the key changed (or `forceAll`, e.g. net_or_gross changed), rewrite the
 * document's derived fields and the patch, bump the version. Returns the profile
 * key now stored.
 */
export async function finishDraftMutation(
  trx: Transaction<CommerceDB>,
  scope: BooksScope,
  row: DocumentRowWithSnapshots,
  patch: DraftPatch,
  opts: { forceAll?: boolean; customer?: CustomerRow | null } = {},
): Promise<string> {
  const now = new Date();
  const settings = await requireSettings(trx, scope);
  const customerId = patch.customer_id !== undefined ? patch.customer_id : row.customer_id;
  const customer =
    opts.customer !== undefined
      ? opts.customer
      : customerId
        ? ((await selectCustomerRow(trx, scope, customerId)) ?? null)
        : null;
  const profile = profileFor(settings, customer);
  const netOrGross = patch.net_or_gross ?? row.net_or_gross;
  const fields = await syncDraftTaxState(trx, scope, row.id, profile, customer, netOrGross, {
    forceAll: Boolean(opts.forceAll) || profile.key !== row.tax_profile_key,
    now,
  });
  if (totalsExceedLimit({ subtotal: fields.subtotal, taxAmount: fields.tax_amount, total: fields.total })) {
    throw invalid('INVALID_LINE', [
      { path: ['total'], message: 'the document total would exceed the largest amount (21,474,836.47 EUR)' },
    ]);
  }
  await trx
    .updateTable('sales_document')
    .set({
      ...patch,
      ...fields,
      tax_summary: toJsonb(fields.tax_summary),
      version: row.version + 1,
      updated_at: now,
    })
    .where('tenant_id', '=', scope.tenantId)
    .where('id', '=', row.id)
    .execute();
  return profile.key;
}

/** A live (not archived) template of the company (INVALID_INPUT when it does not exist for it). */
async function assertTemplate(trx: Transaction<CommerceDB>, scope: BooksScope, templateId: string): Promise<void> {
  const t = await trx
    .selectFrom('document_template')
    .select('id')
    .where('tenant_id', '=', scope.tenantId)
    .where('id', '=', templateId)
    .where('archived_at', 'is', null)
    // Shared lock: an archive running at the same moment waits for this draft or is seen by it
    // (read committed re-checks archived_at after the wait), so no draft lands on an archived template.
    .forShare()
    .executeTakeFirst();
  if (!t) throw invalid('INVALID_INPUT', [{ path: ['templateId'], message: 'no such template for this company' }]);
}

/** The intro and closing columns of a create or an update: only the texts that were sent. */
function texts(args: { introText?: string | null; outroText?: string | null; introFormat?: RichText; outroFormat?: RichText }): DraftPatch {
  const out: DraftPatch = {};
  const intro = textPair('introText', args.introText, args.introFormat);
  if (intro) Object.assign(out, { intro_text: intro.text, intro_format: intro.format });
  const outro = textPair('outroText', args.outroText, args.outroFormat);
  if (outro) Object.assign(out, { outro_text: outro.text, outro_format: outro.format });
  return out;
}

// --- createDraft -------------------------------------------------------------------

const createInput = z.object({
  docType: z.enum(['offer', 'invoice', 'credit_note']),
  actorUserId,
  customerId: z.string().min(1).optional(),
  templateId: z.string().min(1).optional(),
  netOrGross: z.enum(['net', 'gross']).optional(),
  serviceDate: isoDate.optional(),
  servicePeriod: servicePeriod.optional(),
  contractReference: optionalText(200),
  subject: subjectText,
  introText: optionalText(4000),
  outroText: optionalText(4000),
  introFormat: optionalFormat,
  outroFormat: optionalFormat,
});
export type CreateDraftInput = z.input<typeof createInput>;

/**
 * Create a draft invoice (phase 1 accepts `invoice` only: credit notes come from
 * cancelInvoice, offers later). Payment terms come from the company setting,
 * the tax state from its tax status (and the customer, when given). Writes the
 * `draft_created` event, and with a customer the `customer_set` event, in the
 * same transaction.
 */
export async function createDraft(scope: BooksScope, input: CreateDraftInput): Promise<DocumentView> {
  const parsed = createInput.safeParse(input);
  if (!parsed.success) throw invalid('INVALID_INPUT', parsed.error.issues);
  const args = parsed.data;
  if (args.docType !== 'invoice') {
    throw new BooksError('DOC_TYPE_NOT_SUPPORTED', `DOC_TYPE_NOT_SUPPORTED: ${args.docType}`, { docType: args.docType });
  }

  return inDraftTransaction(scope, async (trx) => {
    const settings = await requireSettings(trx, scope);
    const customer = args.customerId ? await requireUsableCustomer(trx, scope, args.customerId) : null;
    if (args.templateId) await assertTemplate(trx, scope, args.templateId);
    const profile = profileFor(settings, customer);

    const id = randomUUID();
    await trx
      .insertInto('sales_document')
      .values({
        id,
        tenant_id: scope.tenantId,
        doc_type: 'invoice',
        status: 'draft',
        customer_id: customer?.id ?? null,
        template_id: args.templateId ?? null,
        net_or_gross: args.netOrGross ?? 'net',
        service_date: args.serviceDate ?? null,
        service_period_start: args.servicePeriod?.start ?? null,
        service_period_end: args.servicePeriod?.end ?? null,
        payment_terms_days: settings.defaultPaymentTermsDays,
        contract_reference: args.contractReference ?? null,
        subject: args.subject ?? null,
        ...texts(args),
        customer_type: customer?.customer_type ?? null,
        vat_id: customer?.vat_id ?? null,
        reverse_charge: profile.reverseCharge,
        kleinunternehmer: profile.kleinunternehmer,
        tax_note: profile.taxNote,
        tax_profile_key: profile.key,
        updated_at: new Date(),
      })
      .execute();

    await insertEvent(trx, scope, {
      documentId: id,
      eventType: 'draft_created',
      fromStatus: null,
      toStatus: 'draft',
      actorUserId: args.actorUserId,
      payload: { docType: 'invoice' },
    });
    if (customer) {
      await insertEvent(trx, scope, {
        documentId: id,
        eventType: 'customer_set',
        fromStatus: null,
        toStatus: null,
        actorUserId: args.actorUserId,
        payload: { customerId: customer.id, previousCustomerId: null, taxProfileChanged: true },
      });
    }
    return readPersistedView(trx, scope, id);
  });
}

// --- updateDraft -------------------------------------------------------------------

const updateInput = z
  .object({
    expectedVersion,
    templateId: z.string().min(1).nullable().optional(),
    netOrGross: z.enum(['net', 'gross']).optional(),
    serviceDate: isoDate.nullable().optional(),
    servicePeriod: servicePeriod.nullable().optional(),
    paymentTermsDays: z.number().int().min(0).max(365).optional(),
    contractReference: optionalText(200),
    subject: subjectText,
    introText: optionalText(4000),
    outroText: optionalText(4000),
    introFormat: optionalFormat,
    outroFormat: optionalFormat,
    // The Correct flow: null turns a replacement draft into an ordinary
    // invoice (the link is never set through this route, only by
    // startCorrection).
    replacesDocumentId: z.null().optional(),
    // A replacement's optional line "Ersetzt Rechnung 62 vom 14.10.2026" under its title.
    printReplacesReference: z.boolean().optional(),
  })
  .strict();
export type UpdateDraftInput = z.input<typeof updateInput>;

/** Edit a draft's header fields. A netOrGross change recomputes every line. */
export async function updateDraft(scope: BooksScope, id: string, input: UpdateDraftInput): Promise<DocumentView> {
  const parsed = updateInput.safeParse(input);
  if (!parsed.success) throw invalid('INVALID_INPUT', parsed.error.issues);
  const args = parsed.data;

  return inDraftTransaction(scope, async (trx) => {
    const row = await lockDraft(trx, scope, id, args.expectedVersion);
    if (args.templateId) await assertTemplate(trx, scope, args.templateId);
    const patch: DraftPatch = {};
    if (args.templateId !== undefined) patch.template_id = args.templateId;
    if (args.netOrGross !== undefined) patch.net_or_gross = args.netOrGross;
    if (args.serviceDate !== undefined) patch.service_date = args.serviceDate;
    if (args.servicePeriod !== undefined) {
      patch.service_period_start = args.servicePeriod?.start ?? null;
      patch.service_period_end = args.servicePeriod?.end ?? null;
    }
    if (args.paymentTermsDays !== undefined) patch.payment_terms_days = args.paymentTermsDays;
    if (args.contractReference !== undefined) patch.contract_reference = args.contractReference;
    if (args.subject !== undefined) patch.subject = args.subject;
    Object.assign(patch, texts(args));
    if (args.printReplacesReference !== undefined) {
      if (args.printReplacesReference && (args.replacesDocumentId === null || !row.replaces_document_id)) {
        throw invalid('INVALID_INPUT', [{ path: ['printReplacesReference'], message: 'only a replacement draft prints the replaced invoice' }]);
      }
      patch.print_replaces_reference = args.printReplacesReference;
    }
    if (args.replacesDocumentId === null) {
      // An ordinary invoice has nothing to refer to.
      patch.replaces_document_id = null;
      patch.print_replaces_reference = false;
    }

    await finishDraftMutation(trx, scope, row, patch, {
      forceAll: args.netOrGross !== undefined && args.netOrGross !== row.net_or_gross,
    });
    return readPersistedView(trx, scope, id);
  });
}

// --- setCustomer -------------------------------------------------------------------

const setCustomerInput = z.object({
  customerId: z.string().min(1),
  actorUserId,
  expectedVersion,
});
export type SetCustomerInput = z.input<typeof setCustomerInput>;

/**
 * Put a customer on a draft. Recomputes the derived tax state only when the tax
 * profile key changes; writes the `customer_set` event only when the customer
 * actually changed. Setting the same customer again is a no-op that returns the
 * document unchanged, version included.
 */
export async function setCustomer(scope: BooksScope, id: string, input: SetCustomerInput): Promise<DocumentView> {
  const parsed = setCustomerInput.safeParse(input);
  if (!parsed.success) throw invalid('INVALID_INPUT', parsed.error.issues);
  const args = parsed.data;

  return inDraftTransaction(scope, async (trx) => {
    const row = await lockDraft(trx, scope, id, args.expectedVersion);
    if (row.customer_id === args.customerId) return readPersistedView(trx, scope, id);
    const customer = await requireUsableCustomer(trx, scope, args.customerId);
    const previousKey = row.tax_profile_key;
    const key = await finishDraftMutation(trx, scope, row, { customer_id: customer.id }, { customer });
    await insertEvent(trx, scope, {
      documentId: id,
      eventType: 'customer_set',
      fromStatus: null,
      toStatus: null,
      actorUserId: args.actorUserId,
      payload: {
        customerId: customer.id,
        previousCustomerId: row.customer_id,
        taxProfileChanged: key !== previousKey,
      },
    });
    return readPersistedView(trx, scope, id);
  });
}
