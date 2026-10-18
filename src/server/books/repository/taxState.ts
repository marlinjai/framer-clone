// src/server/books/repository/taxState.ts
//
// The derived tax state of a draft and the key it is computed under (Books plan
// P1.4, the stateful-flow invariant). Every line's tax_rate, tax_amount and
// tax_treatment, and the document's totals, tax_summary, tax_note,
// reverse_charge, kleinunternehmer, customer_type and vat_id are DERIVED from
// the inputs (the lines' quantity, price, discount, tax_class and
// tax_rate_override; the customer's tax fields; the company's tax status) under
// one `tax_profile_key`. A mutation that finds the stored key different from the
// key computed now recomputes all of it; with an equal key, untouched lines are
// not rewritten. A read finding a stale key returns the recomputation, never the
// stored figures as current.

import type { Kysely, Transaction } from 'kysely';

import type { CommerceDB, CustomerType, NetOrGross } from '../../commerce/db-types';
import { resolveTaxProfile, type TaxProfile } from '../../tax/germanVat';
import type { BooksScope } from '../scope';
import type { CompanySettings } from '../settings';
import type { TaxSummary } from '../snapshots';
import { deriveLine, summarize, type DerivedLine, type LineKind, type TaxClass } from '../totals';
import { CUSTOMER_COLUMNS, LINE_COLUMNS } from './columns';
import type { LineRow } from './read';

type Db = Kysely<CommerceDB> | Transaction<CommerceDB>;

/** The customer row as the Books read it (tax fields only). */
export interface CustomerRow {
  id: string;
  contact_id: string;
  customer_type: CustomerType;
  vat_id: string | null;
  country_code: string;
  tax_number: string | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** One customer of the company, optionally locked FOR SHARE. */
export async function selectCustomerRow(
  db: Db,
  scope: BooksScope,
  id: string,
  opts: { forShare?: boolean } = {},
): Promise<CustomerRow | undefined> {
  let q = db
    .selectFrom('customer')
    .select(CUSTOMER_COLUMNS)
    .where('tenant_id', '=', scope.tenantId)
    .where('id', '=', id);
  if (opts.forShare) q = q.forShare();
  return q.executeTakeFirst();
}

/**
 * The tax profile of a draft: from the company setting and the customer. A
 * draft without a customer is computed as a domestic consumer (German rates
 * under regular taxation) under its own key, so the first customer assignment
 * always changes the key.
 */
export function profileFor(settings: CompanySettings, customer: CustomerRow | null): TaxProfile {
  if (!customer) {
    const p = resolveTaxProfile({
      companyTaxStatus: settings.taxStatus,
      exemptionNote: settings.exemptionNote,
      customerType: 'b2c',
      vatId: null,
      countryCode: 'DE',
    });
    return { ...p, key: `${settings.taxStatus}|||` };
  }
  return resolveTaxProfile({
    companyTaxStatus: settings.taxStatus,
    exemptionNote: settings.exemptionNote,
    customerType: customer.customer_type,
    vatId: customer.vat_id,
    countryCode: customer.country_code,
  });
}

function lineInputs(row: LineRow) {
  return {
    kind: row.kind as LineKind,
    quantity: row.quantity,
    unitPrice: row.unit_price,
    discountBp: row.discount_bp,
    taxClass: (row.tax_class as TaxClass | null) ?? null,
    taxRateOverride: row.tax_rate_override,
  };
}

export interface RecomputedLine {
  row: LineRow;
  derived: DerivedLine;
  /** True when the derived values differ from the stored ones. */
  changed: boolean;
}

/** Recompute every line's derived values under `profile` (pure). */
export function recomputeLines(
  rows: readonly LineRow[],
  profile: TaxProfile,
  netOrGross: NetOrGross,
): RecomputedLine[] {
  return rows.map((row) => {
    const derived = deriveLine(lineInputs(row), {
      netOrGross,
      kleinunternehmer: profile.kleinunternehmer,
      reverseCharge: profile.reverseCharge,
    });
    const changed =
      derived.subtotal !== row.subtotal ||
      derived.taxRate !== row.tax_rate ||
      derived.taxAmount !== row.tax_amount ||
      derived.taxTreatment !== row.tax_treatment;
    return { row, derived, changed };
  });
}

/** The document-level derived fields for a profile, a customer and the lines. */
export interface DocumentTaxFields {
  customer_type: CustomerType | null;
  vat_id: string | null;
  reverse_charge: boolean;
  kleinunternehmer: boolean;
  tax_note: string | null;
  tax_profile_key: string;
  subtotal: number;
  tax_amount: number;
  total: number;
  tax_summary: TaxSummary;
}

export function documentTaxFields(
  profile: TaxProfile,
  customer: CustomerRow | null,
  lines: ReadonlyArray<{ kind: LineKind; derived: DerivedLine }>,
): DocumentTaxFields {
  const totals = summarize(lines.map((l) => ({ ...l.derived, kind: l.kind })));
  return {
    customer_type: customer?.customer_type ?? null,
    vat_id: customer?.vat_id ?? null,
    reverse_charge: profile.reverseCharge,
    kleinunternehmer: profile.kleinunternehmer,
    tax_note: profile.taxNote,
    tax_profile_key: profile.key,
    subtotal: totals.subtotal,
    tax_amount: totals.taxAmount,
    total: totals.total,
    tax_summary: totals.taxSummary,
  };
}

/**
 * Bring a locked draft's derived state in line with `profile` inside the
 * transaction: when `forceAll` (the key changed, or net_or_gross changed),
 * every line whose derived values differ is rewritten; otherwise lines are left
 * as stored (the caller computed the touched line already). The document's
 * derived fields are always rewritten from the lines. Returns the fields
 * written to the document.
 */
export async function syncDraftTaxState(
  trx: Transaction<CommerceDB>,
  scope: BooksScope,
  documentId: string,
  profile: TaxProfile,
  customer: CustomerRow | null,
  netOrGross: NetOrGross,
  opts: { forceAll: boolean; now: Date },
): Promise<DocumentTaxFields> {
  const rows = await trx
    .selectFrom('sales_document_line')
    .select(LINE_COLUMNS)
    .where('tenant_id', '=', scope.tenantId)
    .where('document_id', '=', documentId)
    .orderBy('position')
    .execute();

  const recomputed = opts.forceAll
    ? recomputeLines(rows, profile, netOrGross)
    : rows.map((row) => ({
        row,
        derived: {
          subtotal: row.subtotal,
          taxRate: row.tax_rate,
          taxAmount: row.tax_amount,
          taxTreatment: row.tax_treatment,
        },
        changed: false,
      }));

  for (const line of recomputed) {
    if (!line.changed) continue;
    await trx
      .updateTable('sales_document_line')
      .set({
        subtotal: line.derived.subtotal,
        tax_rate: line.derived.taxRate,
        tax_amount: line.derived.taxAmount,
        tax_treatment: line.derived.taxTreatment,
        updated_at: opts.now,
      })
      .where('tenant_id', '=', scope.tenantId)
      .where('id', '=', line.row.id)
      .execute();
  }

  return documentTaxFields(
    profile,
    customer,
    recomputed.map((l) => ({ kind: l.row.kind as LineKind, derived: l.derived })),
  );
}
