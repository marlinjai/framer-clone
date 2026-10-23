// src/server/books/repository/lines.ts
//
// The lines of a draft (Books plan P1.6). Each write locks the draft, computes
// the touched line's derived values under the tax profile computed now, and
// rewrites the document totals; when the stored profile key is stale, every
// line is recomputed (taxState.ts). The line guard trigger refuses any write to
// a line of a non-draft document (BK001 -> NOT_DRAFT) for every role.
//
// A line may reference a catalog variant (services as products, amendment item
// 4): `variant_ref_source = 'owned'`, and every input the caller left out
// (title, unit price, tax class) is copied from the variant and its product at
// that moment. A later catalog change never alters a line already added.
//
// A line filled from the product and service list (015_books_products) is a
// plain copy of the item's values, never a reference. Its `priceBasis` (net or
// gross, the basis the item's price is quoted in) may differ from the draft's:
// the price is then converted here, under the draft's tax profile at that
// moment (convertUnitPrice in totals.ts), and stored in the draft's basis, so
// the client never converts a price itself.

import { randomUUID } from 'node:crypto';
import type { Transaction } from 'kysely';
import { z } from 'zod';

import type { CommerceDB } from '../../commerce/db-types';
import { pricingRepository } from '../../commerce/repository/pricing';
import { BooksError, invalid } from '../errors';
import type { BooksScope } from '../scope';
import { requireSettings } from '../settings';
import { MAX_AMOUNT_CENTS, convertUnitPrice, deriveLine, lineExceedsLimit, type LineInputs, type TaxClass } from '../totals';
import { finishDraftMutation, inDraftTransaction, lockDraft } from './documents';
import { readPersistedView, selectLineRows, type DocumentRowWithSnapshots, type DocumentView } from './read';
import { profileFor, selectCustomerRow } from './taxState';

const TAX_CLASSES = ['standard', 'reduced', 'zero'] as const;

const lineFields = {
  kind: z.enum(['service', 'product', 'text']),
  title: z.string().trim().min(1).max(300),
  description: z.string().max(4000).nullable(),
  quantity: z.number().int().min(0).max(1_000_000_000),
  unitLabel: z.string().trim().min(1).max(20),
  unitPrice: z.number().int().min(0).max(MAX_AMOUNT_CENTS),
  discountBp: z.number().int().min(0).max(10000),
  taxClass: z.enum(TAX_CLASSES).nullable(),
  taxRateOverride: z.number().int().min(0).max(10000).nullable(),
};

const addInput = z.object({
  kind: lineFields.kind.default('service'),
  title: lineFields.title.optional(),
  description: lineFields.description.optional(),
  quantity: lineFields.quantity.optional(),
  unitLabel: lineFields.unitLabel.optional(),
  unitPrice: lineFields.unitPrice.optional(),
  discountBp: lineFields.discountBp.optional(),
  taxClass: lineFields.taxClass.optional(),
  taxRateOverride: lineFields.taxRateOverride.optional(),
  variantRef: z.string().min(1).optional(),
  /** The basis `unitPrice` is quoted in, when it may differ from the draft's (a product list item). */
  priceBasis: z.enum(['net', 'gross']).optional(),
  expectedVersion: z.number().int().min(0).optional(),
});
export type AddLineInput = z.input<typeof addInput>;

const patchInput = z
  .object({
    kind: lineFields.kind.optional(),
    title: lineFields.title.optional(),
    description: lineFields.description.optional(),
    quantity: lineFields.quantity.optional(),
    unitLabel: lineFields.unitLabel.optional(),
    unitPrice: lineFields.unitPrice.optional(),
    discountBp: lineFields.discountBp.optional(),
    taxClass: lineFields.taxClass.optional(),
    taxRateOverride: lineFields.taxRateOverride.optional(),
    expectedVersion: z.number().int().min(0).optional(),
  })
  .strict();
export type UpdateLineInput = z.input<typeof patchInput>;

/** A complete line before its derived values: what the INSERT / UPDATE writes. */
interface LineDraft extends LineInputs {
  title: string;
  description: string | null;
  unitLabel: string;
}

/** The text-line and billable-line rules (INVALID_LINE with the offending fields). */
function assertLineRules(line: LineDraft): void {
  const issues: Array<{ path: string[]; message: string }> = [];
  if (line.kind === 'text') {
    if (line.quantity !== 0) issues.push({ path: ['quantity'], message: 'a text line has no quantity' });
    if (line.unitPrice !== 0) issues.push({ path: ['unitPrice'], message: 'a text line has no price' });
    if (line.discountBp !== 0) issues.push({ path: ['discountBp'], message: 'a text line has no discount' });
    if (line.taxClass !== null || line.taxRateOverride !== null) {
      issues.push({ path: ['taxClass'], message: 'a text line carries no tax inputs' });
    }
  } else if (line.quantity <= 0) {
    issues.push({ path: ['quantity'], message: 'a billable line needs a quantity above 0 (in thousandths)' });
  }
  if (issues.length > 0) throw invalid('INVALID_LINE', issues);
}

/** Catalog defaults for a variant line: the variant and its product, live rows only. */
async function variantDefaults(
  trx: Transaction<CommerceDB>,
  variantId: string,
): Promise<{ title: string; unitPrice: number | null; taxClass: TaxClass | null }> {
  const v = await trx
    .selectFrom('product_variant')
    .innerJoin('product', 'product.id', 'product_variant.product_id')
    .select([
      'product_variant.title as variantTitle',
      'product_variant.tax_class as variantTaxClass',
      'product.title as productTitle',
      'product.tax_class as productTaxClass',
    ])
    .where('product_variant.id', '=', variantId)
    .where('product_variant.deleted_at', 'is', null)
    .where('product.deleted_at', 'is', null)
    .executeTakeFirst();
  if (!v) throw new BooksError('VARIANT_NOT_FOUND', 'VARIANT_NOT_FOUND', { variantRef: variantId });
  const variantTitle = v.variantTitle?.trim() ?? '';
  const title =
    variantTitle !== '' && variantTitle !== v.productTitle ? `${v.productTitle} (${variantTitle})` : v.productTitle;
  const unitPrice = await pricingRepository.resolvePrice(trx, variantId, { currency: 'EUR', quantity: 1 });
  // The catalog's tax_class is free text; only the three classes the line table
  // accepts are carried over (anything else rates as standard, as resolveLineRate does).
  const raw = v.variantTaxClass ?? v.productTaxClass;
  const taxClass = (TAX_CLASSES as readonly string[]).includes(raw ?? '') ? (raw as TaxClass) : null;
  return { title: title.slice(0, 300), unitPrice, taxClass };
}

/** The draft's tax profile computed now (company settings and its customer's current tax fields). */
async function draftProfile(trx: Transaction<CommerceDB>, scope: BooksScope, row: DocumentRowWithSnapshots) {
  const settings = await requireSettings(trx, scope);
  const customer = row.customer_id ? ((await selectCustomerRow(trx, scope, row.customer_id)) ?? null) : null;
  return profileFor(settings, customer);
}

/** Derived values of one line under the draft's current profile (INVALID_LINE beyond the money limit). */
async function deriveForDraft(trx: Transaction<CommerceDB>, scope: BooksScope, row: DocumentRowWithSnapshots, line: LineInputs) {
  const profile = await draftProfile(trx, scope, row);
  const derived = deriveLine(line, {
    netOrGross: row.net_or_gross,
    kleinunternehmer: profile.kleinunternehmer,
    reverseCharge: profile.reverseCharge,
  });
  if (lineExceedsLimit(derived)) {
    throw invalid('INVALID_LINE', [
      { path: ['unitPrice'], message: 'quantity times price exceeds the largest amount (21,474,836.47 EUR)' },
    ]);
  }
  return derived;
}

/** Append a line at the end of a draft. */
export async function addLine(scope: BooksScope, id: string, input: AddLineInput): Promise<DocumentView> {
  const parsed = addInput.safeParse(input);
  if (!parsed.success) throw invalid('INVALID_LINE', parsed.error.issues);
  const args = parsed.data;
  // The basis qualifies the price the caller sends, never a catalog price it leaves out.
  if (args.priceBasis !== undefined && args.unitPrice === undefined) {
    throw invalid('INVALID_LINE', [{ path: ['priceBasis'], message: 'priceBasis is sent only with the unitPrice it describes' }]);
  }

  return inDraftTransaction(scope, async (trx) => {
    const row = await lockDraft(trx, scope, id, args.expectedVersion);
    const defaults = args.variantRef ? await variantDefaults(trx, args.variantRef) : null;
    const title = args.title ?? defaults?.title;
    const unitPrice = args.unitPrice ?? (args.kind === 'text' ? 0 : defaults?.unitPrice ?? undefined);
    const missing: Array<{ path: string[]; message: string }> = [];
    if (title === undefined) missing.push({ path: ['title'], message: 'required' });
    if (unitPrice === undefined || unitPrice === null) missing.push({ path: ['unitPrice'], message: 'required (no catalog price in EUR)' });
    if (missing.length > 0) throw invalid('INVALID_LINE', missing);

    const line: LineDraft = {
      kind: args.kind,
      title: title as string,
      description: args.description ?? null,
      quantity: args.quantity ?? (args.kind === 'text' ? 0 : 1000),
      unitLabel: args.unitLabel ?? 'Stk',
      unitPrice: unitPrice as number,
      discountBp: args.discountBp ?? 0,
      taxClass: args.taxClass !== undefined ? args.taxClass : (defaults?.taxClass ?? null),
      taxRateOverride: args.taxRateOverride ?? null,
    };
    assertLineRules(line);
    if (args.priceBasis !== undefined && line.kind !== 'text' && args.priceBasis !== row.net_or_gross) {
      const profile = await draftProfile(trx, scope, row);
      line.unitPrice = convertUnitPrice(line.unitPrice, args.priceBasis, row.net_or_gross, {
        taxClass: line.taxClass,
        taxRateOverride: line.taxRateOverride,
        kleinunternehmer: profile.kleinunternehmer,
        reverseCharge: profile.reverseCharge,
      });
      if (line.unitPrice > MAX_AMOUNT_CENTS) {
        throw invalid('INVALID_LINE', [
          { path: ['unitPrice'], message: 'the price in the draft\'s basis exceeds the largest amount (21,474,836.47 EUR)' },
        ]);
      }
    }
    const derived = await deriveForDraft(trx, scope, row, line);

    const last = await trx
      .selectFrom('sales_document_line')
      .select((eb) => eb.fn.max('position').as('max'))
      .where('tenant_id', '=', scope.tenantId)
      .where('document_id', '=', id)
      .executeTakeFirst();
    const now = new Date();
    await trx
      .insertInto('sales_document_line')
      .values({
        id: randomUUID(),
        tenant_id: scope.tenantId,
        document_id: id,
        position: (last?.max ?? 0) + 1,
        kind: line.kind,
        title: line.title,
        description: line.description,
        quantity: line.quantity,
        unit_label: line.unitLabel,
        unit_price: line.unitPrice,
        discount_bp: line.discountBp,
        subtotal: derived.subtotal,
        tax_class: line.taxClass,
        tax_rate_override: line.taxRateOverride,
        tax_rate: derived.taxRate,
        tax_amount: derived.taxAmount,
        tax_treatment: derived.taxTreatment,
        variant_ref: args.variantRef ?? null,
        variant_ref_source: args.variantRef ? 'owned' : 'none',
        updated_at: now,
      })
      .execute();

    await finishDraftMutation(trx, scope, row, {});
    return readPersistedView(trx, scope, id);
  });
}

/** Change a line of a draft; recomputes that line and the totals. */
export async function updateLine(
  scope: BooksScope,
  id: string,
  lineId: string,
  patch: UpdateLineInput,
): Promise<DocumentView> {
  const parsed = patchInput.safeParse(patch);
  if (!parsed.success) throw invalid('INVALID_LINE', parsed.error.issues);
  const args = parsed.data;

  return inDraftTransaction(scope, async (trx) => {
    const row = await lockDraft(trx, scope, id, args.expectedVersion);
    const current = (await selectLineRows(trx, scope, id)).find((l) => l.id === lineId);
    if (!current) throw new BooksError('LINE_NOT_FOUND', 'LINE_NOT_FOUND', { documentId: id, lineId });

    const kind = args.kind ?? current.kind;
    const line: LineDraft = {
      kind,
      title: args.title ?? current.title,
      description: args.description !== undefined ? args.description : current.description,
      quantity: args.quantity ?? current.quantity,
      unitLabel: args.unitLabel ?? current.unit_label,
      unitPrice: args.unitPrice ?? current.unit_price,
      discountBp: args.discountBp ?? current.discount_bp,
      taxClass: args.taxClass !== undefined ? args.taxClass : ((current.tax_class as TaxClass | null) ?? null),
      taxRateOverride: args.taxRateOverride !== undefined ? args.taxRateOverride : current.tax_rate_override,
    };
    assertLineRules(line);
    const derived = await deriveForDraft(trx, scope, row, line);

    await trx
      .updateTable('sales_document_line')
      .set({
        kind: line.kind,
        title: line.title,
        description: line.description,
        quantity: line.quantity,
        unit_label: line.unitLabel,
        unit_price: line.unitPrice,
        discount_bp: line.discountBp,
        subtotal: derived.subtotal,
        tax_class: line.taxClass,
        tax_rate_override: line.taxRateOverride,
        tax_rate: derived.taxRate,
        tax_amount: derived.taxAmount,
        tax_treatment: derived.taxTreatment,
        updated_at: new Date(),
      })
      .where('tenant_id', '=', scope.tenantId)
      .where('id', '=', lineId)
      .execute();

    await finishDraftMutation(trx, scope, row, {});
    return readPersistedView(trx, scope, id);
  });
}

const reorderInput = z.object({
  lineIds: z.array(z.string().min(1)),
  expectedVersion: z.number().int().min(0).optional(),
});
export type ReorderLinesInput = z.input<typeof reorderInput>;

/**
 * Rewrite the positions 1..n in the given order. `lineIds` must be exactly the
 * draft's line ids (INVALID_POSITIONS). The deferred unique constraint lets
 * every position change in one transaction.
 */
export async function reorderLines(scope: BooksScope, id: string, input: ReorderLinesInput): Promise<DocumentView> {
  const parsed = reorderInput.safeParse(input);
  if (!parsed.success) throw invalid('INVALID_INPUT', parsed.error.issues);
  const args = parsed.data;

  return inDraftTransaction(scope, async (trx) => {
    const row = await lockDraft(trx, scope, id, args.expectedVersion);
    const lines = await selectLineRows(trx, scope, id);
    const current = new Set(lines.map((l) => l.id));
    const given = new Set(args.lineIds);
    if (
      given.size !== args.lineIds.length ||
      given.size !== current.size ||
      args.lineIds.some((l) => !current.has(l))
    ) {
      throw new BooksError('INVALID_POSITIONS', 'INVALID_POSITIONS: lineIds must be exactly the draft\'s lines', {
        documentId: id,
      });
    }
    const now = new Date();
    for (let i = 0; i < args.lineIds.length; i += 1) {
      const line = lines.find((l) => l.id === args.lineIds[i]);
      if (line && line.position === i + 1) continue;
      await trx
        .updateTable('sales_document_line')
        .set({ position: i + 1, updated_at: now })
        .where('tenant_id', '=', scope.tenantId)
        .where('id', '=', args.lineIds[i])
        .execute();
    }
    await finishDraftMutation(trx, scope, row, {});
    return readPersistedView(trx, scope, id);
  });
}

const removeInput = z.object({ expectedVersion: z.number().int().min(0).optional() });

/** Delete a line of a draft and close the position gap. */
export async function removeLine(
  scope: BooksScope,
  id: string,
  lineId: string,
  input: z.input<typeof removeInput> = {},
): Promise<DocumentView> {
  const parsed = removeInput.safeParse(input);
  if (!parsed.success) throw invalid('INVALID_INPUT', parsed.error.issues);
  const args = parsed.data;

  return inDraftTransaction(scope, async (trx) => {
    const row = await lockDraft(trx, scope, id, args.expectedVersion);
    const removed = await trx
      .deleteFrom('sales_document_line')
      .where('tenant_id', '=', scope.tenantId)
      .where('document_id', '=', id)
      .where('id', '=', lineId)
      .returning('position')
      .executeTakeFirst();
    if (!removed) throw new BooksError('LINE_NOT_FOUND', 'LINE_NOT_FOUND', { documentId: id, lineId });
    await trx
      .updateTable('sales_document_line')
      .set((eb) => ({ position: eb('position', '-', 1), updated_at: new Date() }))
      .where('tenant_id', '=', scope.tenantId)
      .where('document_id', '=', id)
      .where('position', '>', removed.position)
      .execute();
    await finishDraftMutation(trx, scope, row, {});
    return readPersistedView(trx, scope, id);
  });
}
