// src/server/commerce/payment/invoiceable.ts
//
// Whether a paid order can get a correct invoice for this buyer. The pay route asks before any money moves
// (decided by Marlin on 2026-11-01): the receipt comes after the payment, so a buyer it cannot be made out to
// would have paid for nothing the books can state. Pure, so the rule can be read and tested on its own.
//
// Germany only, for every company: that is the decision, with no exception for a small business. Under regular
// taxation it is also what the code can do: the shop charges German VAT on every order, and the module that prices
// the invoice knows only that and reverse charge, so anywhere else the two disagree (the German VAT research of
// 2026-11-01, section 6):
//   - an EU business with a VAT id: reverse charge on the invoice, German VAT in the payment. Net prices fail
//     with TOTALS_MISMATCH; gross prices issue an invoice saying no VAT was charged, which is false;
//   - outside the EU: TAX_CASE_UNSUPPORTED, no invoice;
//   - an EU consumer: invoiced, but what the VAT should be depends on sales this platform cannot see.
// A VAT id, when one is given, must be German for every company too, so a section 19 company is no exception and
// a company without Books, priced as a regular business (shopTax.ts), answers the same way.

import { isGermanVatId, normalizeVatId } from '@/server/tax/germanVat';

import type { Buyer } from './buyer';

export interface BuyerRefusal {
  /** The buyer's field that has to change for the order to be paid. */
  field: 'country' | 'vatId';
  /** What the buyer reads: why, what to do next, and that no money moved. */
  message: string;
}

const NOTHING_CHARGED = 'Nothing has been charged.';

/** Why this buyer cannot pay, or null when the invoice will be correct. */
export function buyerRefusal(buyer: Pick<Buyer, 'country' | 'vatId'>): BuyerRefusal | null {
  if (buyer.country !== 'DE') {
    return {
      field: 'country',
      message: `This shop can only invoice addresses in Germany. Enter a German address to continue, or go back to the cart. ${NOTHING_CHARGED}`,
    };
  }
  const vatId = normalizeVatId(buyer.vatId ?? '');
  if (vatId !== '' && !isGermanVatId(vatId)) {
    return {
      field: 'vatId',
      message: `This shop can only invoice German VAT ids (DE and nine digits). Correct the VAT id or remove it to continue. ${NOTHING_CHARGED}`,
    };
  }
  return null;
}
