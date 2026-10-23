// src/server/books/totals.ts
//
// The pure money math of a sales document (Books plan P1.4), integer only.
//
//   - line net before discount = round(quantity * unit_price / 1000)
//     (quantity is in thousandths: 1.5 hours = 1500);
//   - line subtotal = round(net_before_discount * (10000 - discount_bp) / 10000);
//   - line tax from computeLineTax(subtotal, ...), PER LINE, as the order path
//     does, so the document's tax_amount is exactly the sum of the line taxes
//     (the identity the BK005 trigger checks at issue);
//   - tax_summary: the non-text lines grouped by (tax_rate, tax_treatment),
//     sorted by rate descending;
//   - document subtotal = sum of line subtotals, tax_amount = sum of line taxes,
//     total = subtotal + tax_amount.
//
// Under net_or_gross = 'gross' the unit price is gross: computeLineTax extracts
// the tax and the stored subtotal is the net part, so total = subtotal +
// tax_amount holds in both modes. Rounding is half up (Math.round on
// non-negative values).

import { computeLineTax, resolveLineRate, type TaxTreatment } from '../tax/germanVat';
import type { TaxSummary } from './snapshots';

export type LineKind = 'service' | 'product' | 'text';
export type TaxClass = 'standard' | 'reduced' | 'zero';

/** The inputs a line's derived values are computed from. */
export interface LineInputs {
  kind: LineKind;
  /** Thousandths. */
  quantity: number;
  /** Cents, in the document's net_or_gross basis. */
  unitPrice: number;
  /** Basis points. */
  discountBp: number;
  taxClass: TaxClass | null;
  /** Basis points; wins over taxClass. */
  taxRateOverride: number | null;
}

/** The values derived from a line's inputs and the document's tax profile. */
export interface DerivedLine {
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  taxTreatment: TaxTreatment | null;
}

/** The parts of the tax profile the line math needs. */
export interface LineTaxContext {
  netOrGross: 'net' | 'gross';
  kleinunternehmer: boolean;
  reverseCharge: boolean;
}

/**
 * The largest amount a money column holds (PostgreSQL INTEGER, 2^31 - 1 cents).
 * A line whose net or gross, or a document whose total, would exceed it is
 * refused (INVALID_LINE) instead of failing as a database overflow.
 */
export const MAX_AMOUNT_CENTS = 2_147_483_647;

/** True when a derived line (or its gross, net + tax) does not fit a money column. */
export function lineExceedsLimit(derived: DerivedLine): boolean {
  return derived.subtotal > MAX_AMOUNT_CENTS || derived.subtotal + derived.taxAmount > MAX_AMOUNT_CENTS;
}

/** True when a document's totals do not fit a money column. */
export function totalsExceedLimit(totals: { subtotal: number; taxAmount: number; total: number }): boolean {
  return totals.subtotal > MAX_AMOUNT_CENTS || totals.taxAmount > MAX_AMOUNT_CENTS || totals.total > MAX_AMOUNT_CENTS;
}

/** round(quantity * unitPrice / 1000), quantity in thousandths. */
export function lineNetBeforeDiscount(quantity: number, unitPrice: number): number {
  return Math.round((quantity * unitPrice) / 1000);
}

/** The amount after a basis-points discount. */
export function applyDiscount(amount: number, discountBp: number): number {
  return Math.round((amount * (10000 - discountBp)) / 10000);
}

/** Compute one line's derived values. A text line carries none. */
export function deriveLine(line: LineInputs, ctx: LineTaxContext): DerivedLine {
  if (line.kind === 'text') {
    return { subtotal: 0, taxRate: 0, taxAmount: 0, taxTreatment: null };
  }
  const base = applyDiscount(lineNetBeforeDiscount(line.quantity, line.unitPrice), line.discountBp);
  const tax = computeLineTax(base, {
    taxClass: line.taxClass,
    explicitRate: line.taxRateOverride ?? undefined,
    netOrGross: ctx.netOrGross,
    reverseCharge: ctx.reverseCharge,
    kleinunternehmer: ctx.kleinunternehmer,
  });
  return { subtotal: tax.net, taxRate: tax.rate, taxAmount: tax.tax, taxTreatment: tax.treatment };
}

/**
 * A unit price quoted in one basis (net or gross), in the other: what a line
 * picked from the product list stores when the item's price basis differs
 * from the draft's (invoice editor plan, phase 4). The rate is the line's
 * (its override, else its class). Rounded half up exactly as computeLineTax
 * rounds the tax of one unit: net to gross adds round(net * rate / 10000),
 * gross to net takes off round(gross * rate / (10000 + rate)).
 *
 * A small business charges no VAT, so its net and gross are the same: no
 * change. Under reverse charge the draft charges no VAT either, so a net price
 * goes into a gross draft as it is; but a GROSS quote still contains German VAT
 * at its class rate, which the customer accounts for themselves, so it is taken
 * off (the customer never pays the VAT amount as price).
 */
export function convertUnitPrice(
  unitPrice: number,
  from: 'net' | 'gross',
  to: 'net' | 'gross',
  ctx: { taxClass: TaxClass | null; taxRateOverride: number | null; kleinunternehmer: boolean; reverseCharge: boolean },
): number {
  if (from === to || ctx.kleinunternehmer) return unitPrice;
  if (ctx.reverseCharge && from === 'net') return unitPrice;
  const rate = resolveLineRate(ctx.taxClass, ctx.taxRateOverride ?? undefined);
  return from === 'net'
    ? unitPrice + Math.round((unitPrice * rate) / 10000)
    : unitPrice - Math.round((unitPrice * rate) / (10000 + rate));
}

export interface DocumentTotals {
  subtotal: number;
  taxAmount: number;
  total: number;
  taxSummary: TaxSummary;
}

/** Sum the lines and group the non-text lines by (rate, treatment). */
export function summarize(lines: ReadonlyArray<DerivedLine & { kind: LineKind }>): DocumentTotals {
  let subtotal = 0;
  let taxAmount = 0;
  const groups = new Map<string, TaxSummary[number]>();
  for (const line of lines) {
    if (line.kind === 'text' || line.taxTreatment === null) continue;
    subtotal += line.subtotal;
    taxAmount += line.taxAmount;
    const key = `${line.taxRate}|${line.taxTreatment}`;
    const group = groups.get(key) ?? { taxRate: line.taxRate, taxTreatment: line.taxTreatment, net: 0, tax: 0 };
    group.net += line.subtotal;
    group.tax += line.taxAmount;
    groups.set(key, group);
  }
  const taxSummary = [...groups.values()].sort(
    (a, b) => b.taxRate - a.taxRate || a.taxTreatment.localeCompare(b.taxTreatment),
  );
  return { subtotal, taxAmount, total: subtotal + taxAmount, taxSummary };
}
