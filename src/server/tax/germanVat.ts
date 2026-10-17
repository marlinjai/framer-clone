// src/server/tax/germanVat.ts
//
// The ONE implementation of the German VAT rules this repository applies ("one
// semantic, one implementation"). Two callers share it:
//
//   - the order orchestrator (src/server/commerce/order/createOrder.ts), which
//     prices a storefront cart into an order, and
//   - the Books domain (src/server/books), which prices offers, invoices and
//     credit notes.
//
// Everything above the "Books" divider moved here unchanged from the order
// orchestrator (Books plan P1.4); the orchestrator's existing unit tests are the
// proof that the move kept its behaviour. The module is pure (no database, no
// `server-only`), so it is safe in unit tests and in operator scripts.
//
// Units: money is integer cents, rates are integer basis points (1900 = 19
// percent, ceiling 10000). Every computation is integer (Math.round), so no float
// can enter a total.

// German VAT default rates in integer BASIS POINTS (1900 = 19.00%, 700 = 7.00%,
// 0 = zero-rated). The catalog stores only a tax_class CLASSIFICATION, not a
// rate, so a class maps to one of these defaults; a caller may override per line
// with an explicit rate.
export const STANDARD_RATE_BPS = 1900;
export const REDUCED_RATE_BPS = 700;
export const ZERO_RATE_BPS = 0;
// 100% in basis points: the upper bound on any tax rate. Mirrors the CHECK
// (tax_rate <= 10000) on the line tables; an explicit rate above this is a
// programming error, surfaced loudly at the boundary (never persisted).
export const MAX_RATE_BPS = 10000;

// The legal notices set when VAT is suppressed. ASCII-safe text (no long dashes
// per the repo convention).
export const REVERSE_CHARGE_NOTICE =
  'Steuerschuldnerschaft des Leistungsempfaengers (Reverse-Charge-Verfahren, Section 13b UStG).';
export const KLEINUNTERNEHMER_NOTICE =
  'Gemaess Section 19 UStG wird keine Umsatzsteuer ausgewiesen (Kleinunternehmer).';

/** The tax treatment discriminator, the value set of the `"TaxTreatment"` enum. */
export type TaxTreatment = 'standard' | 'reduced' | 'zero' | 'reverse_charge' | 'kleinunternehmer';

/** The resolved tax treatment for one line (the full snapshot, not a bare rate). */
export interface LineTax {
  net: number;
  tax: number;
  gross: number;
  rate: number;
  treatment: TaxTreatment;
}

function assertNonNegativeIntCents(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `createOrder: ${label} must be a non-negative integer number of cents, got ${value}`,
    );
  }
}

/**
 * Compute one line's net/tax/gross in integer cents plus the snapshotted rate and
 * treatment discriminator. VAT suppression (reverse_charge / kleinunternehmer)
 * forces a zero tax_amount and the matching treatment; kleinunternehmer takes
 * precedence (a small-business seller never charges VAT, regardless of the B2B
 * reverse-charge mechanism). Otherwise the rate is the explicit per-line rate, or
 * the class-derived default. All arithmetic is integer (Math.round), so no float
 * can enter the totals.
 */
export function computeLineTax(
  base: number,
  opts: {
    taxClass?: string | null;
    explicitRate?: number;
    netOrGross: 'net' | 'gross';
    reverseCharge: boolean;
    kleinunternehmer: boolean;
  },
): LineTax {
  if (opts.kleinunternehmer) {
    return { net: base, tax: 0, gross: base, rate: 0, treatment: 'kleinunternehmer' };
  }
  if (opts.reverseCharge) {
    return { net: base, tax: 0, gross: base, rate: 0, treatment: 'reverse_charge' };
  }

  const rate = resolveLineRate(opts.taxClass, opts.explicitRate);
  if (rate === ZERO_RATE_BPS) {
    return { net: base, tax: 0, gross: base, rate: 0, treatment: 'zero' };
  }

  // Derive the treatment discriminator from the RESOLVED rate, not from taxClass
  // alone: an explicit per-line rate override (e.g. 700 with a null taxClass) must
  // snapshot a CONSISTENT (rate, treatment) pair so a per-Steuersatz reprint buckets
  // it correctly. The reduced-rate bps maps to 'reduced', anything else 'standard'
  // (the zero case is already returned above).
  const treatment = treatmentForRate(rate);
  if (opts.netOrGross === 'gross') {
    // base is gross (tax-inclusive): extract the tax from within.
    const tax = Math.round((base * rate) / (10000 + rate));
    return { net: base - tax, tax, gross: base, rate, treatment };
  }
  // base is net: add the tax on top.
  const tax = Math.round((base * rate) / 10000);
  return { net: base, tax, gross: base + tax, rate, treatment };
}

/** Map an applied tax class to its default rate, or honor an explicit override. */
export function resolveLineRate(taxClass: string | null | undefined, explicitRate?: number): number {
  if (explicitRate != null) {
    assertNonNegativeIntCents(explicitRate, 'taxRate');
    // Reject an explicit rate above the basis-points ceiling (mirrors the CHECK
    // (tax_rate <= 10000)); a rate over 100% is a bug, not data.
    if (explicitRate > MAX_RATE_BPS) {
      throw new Error(
        `createOrder: taxRate must be <= ${MAX_RATE_BPS} basis points, got ${explicitRate}`,
      );
    }
    return explicitRate;
  }
  if (taxClass === 'reduced') return REDUCED_RATE_BPS;
  if (taxClass === 'zero') return ZERO_RATE_BPS;
  return STANDARD_RATE_BPS;
}

/**
 * Map a RESOLVED rate (basis points) to its treatment discriminator. The
 * reduced-rate bps is 'reduced', zero is 'zero', everything else 'standard'.
 * Deriving the treatment from the rate (not from taxClass) keeps the snapshotted
 * (rate, treatment) pair consistent even when an explicit per-line rate overrides
 * the class-derived default.
 */
export function treatmentForRate(rate: number): TaxTreatment {
  if (rate === ZERO_RATE_BPS) return 'zero';
  if (rate === REDUCED_RATE_BPS) return 'reduced';
  return 'standard';
}

/**
 * Thrown when the Section 13b reverse-charge mechanism is requested for a
 * recipient it cannot apply to. The order orchestrator lets it propagate (a
 * malformed cart is a programming error); the Books domain maps it to
 * `BooksError('REVERSE_CHARGE_NOT_ALLOWED')`.
 */
export class ReverseChargeNotAllowedError extends Error {
  readonly reason: 'not_b2b' | 'missing_vat_id';
  constructor(reason: 'not_b2b' | 'missing_vat_id') {
    super(
      reason === 'not_b2b'
        ? 'createOrder: reverseCharge requires customerType "b2b" (a B2C reverse-charge invoice is illegal)'
        : 'createOrder: reverseCharge requires a non-empty vatId (the recipient must be VAT-registered)',
    );
    this.name = 'ReverseChargeNotAllowedError';
    this.reason = reason;
  }
}

/**
 * Reverse-charge precondition: the Section 13b mechanism only applies to a B2B
 * supply to a VAT-registered recipient. Reverse charge SUPPRESSES VAT and prints
 * the 13b notice, so without this gate a b2c recipient would silently receive a
 * zero-VAT invoice (illegal). Throws {@link ReverseChargeNotAllowedError} unless
 * `customerType === 'b2b'` and `vatId` is non-empty after trim. (Validation of
 * the VAT id against VIES stays out of scope; only this precondition is
 * enforced.)
 */
export function assertReverseChargeAllowed(p: {
  customerType: 'b2c' | 'b2b' | null | undefined;
  vatId: string | null | undefined;
}): void {
  if (p.customerType !== 'b2b') throw new ReverseChargeNotAllowedError('not_b2b');
  if (!p.vatId || p.vatId.trim() === '') throw new ReverseChargeNotAllowedError('missing_vat_id');
}

// =============================================================================
// Books: the document-level tax profile (Books plan P1.4).
// =============================================================================

/** The company's VAT regime: Section 19 small business, or regular taxation. */
export type CompanyTaxStatus = 'small_business' | 'regular';

/** The EU member states (ISO 3166-1 alpha-2), for the reverse-charge test. */
export const EU_MEMBER_STATES: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU',
  'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
]);

export interface TaxProfileInput {
  companyTaxStatus: CompanyTaxStatus;
  /** The company's configured exemption note (printed under Section 19). */
  exemptionNote: string;
  customerType: 'b2c' | 'b2b';
  vatId: string | null;
  /** The recipient's country, ISO 3166-1 alpha-2. */
  countryCode: string;
}

export interface TaxProfile {
  kleinunternehmer: boolean;
  reverseCharge: boolean;
  taxNote: string | null;
  /** The key every piece of derived tax state is computed under (`tax_profile_key`). */
  key: string;
  /**
   * False for a case the books do not cover (a regular-taxed company invoicing a
   * recipient outside the EU). A draft may still be built under such a profile;
   * issue refuses it with `TAX_CASE_UNSUPPORTED`.
   */
  supported: boolean;
}

/** The tax profile key: it changes exactly when one of its four inputs changes. */
export function taxProfileKey(input: Omit<TaxProfileInput, 'exemptionNote'>): string {
  return [input.companyTaxStatus, input.customerType, input.vatId ?? '', input.countryCode].join('|');
}

/**
 * Resolve the document-level tax profile, in this order:
 *  1. Section 19 small business: no VAT whatever the recipient, the company's
 *     exemption note.
 *  2. Regular, a b2b recipient with a VAT id in another EU member state: reverse
 *     charge, the 13b notice.
 *  3. Regular, a recipient outside the EU: not supported (flagged; issue refuses).
 *  4. Regular, everything else (domestic, or an EU consumer): German rates, no
 *     note.
 */
export function resolveTaxProfile(input: TaxProfileInput): TaxProfile {
  const countryCode = input.countryCode.trim().toUpperCase();
  const vatId = input.vatId && input.vatId.trim() !== '' ? input.vatId : null;
  const key = taxProfileKey({
    companyTaxStatus: input.companyTaxStatus,
    customerType: input.customerType,
    vatId,
    countryCode,
  });

  if (input.companyTaxStatus === 'small_business') {
    return { kleinunternehmer: true, reverseCharge: false, taxNote: input.exemptionNote, key, supported: true };
  }

  if (!EU_MEMBER_STATES.has(countryCode)) {
    return { kleinunternehmer: false, reverseCharge: false, taxNote: null, key, supported: false };
  }

  if (input.customerType === 'b2b' && vatId !== null && countryCode !== 'DE') {
    assertReverseChargeAllowed({ customerType: input.customerType, vatId });
    return { kleinunternehmer: false, reverseCharge: true, taxNote: REVERSE_CHARGE_NOTICE, key, supported: true };
  }

  return { kleinunternehmer: false, reverseCharge: false, taxNote: null, key, supported: true };
}
