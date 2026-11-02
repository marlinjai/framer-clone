import 'server-only';

// src/server/commerce/payment/receiptReadiness.ts
//
// Whether a company's Books can issue a shop order's receipt, asked before any real money moves (decided by Marlin on
// 2026-11-02): a Stripe payment is refused until they can, so no paid order ever lacks its invoice. The order route
// refuses to open such a payment, the pay route refuses to start one, and the owner's payments page names what is
// missing and where it is set.
//
// The three things the Issue button needs from the company itself, with the same rules it applies:
//   - the Books settings (SETTINGS_MISSING at issue);
//   - the invoice number series (COUNTER_MISSING at issue);
//   - a sender block complete for a domestic invoice (SENDER_INCOMPLETE at issue). Domestic, because the shop only
//     invoices buyers in Germany (invoiceable.ts), and a German buyer is never reverse charge (germanVat.ts), so
//     the issuer's VAT id is never the only acceptable tax id.
// What depends on the buyer (the contacts database answering, an archived contact, a namesake with another VAT id) is
// not the company's state and is not checked here.

import type { Kysely } from 'kysely';

import { booksScope } from '@/server/books/scope';
import { readCounters, readSettings } from '@/server/books/settings';
import { senderMissingFields } from '@/server/books/snapshots';

import type { CommerceDB } from '../db-types';

export type ReceiptBlocker = 'books_not_set_up' | 'invoice_numbers_missing' | 'sender_incomplete';

export type ReceiptReadiness =
  | { ready: true }
  | {
      ready: false;
      /** The first thing missing, in the order an operator sets them up. */
      blocker: ReceiptBlocker;
      /** For `sender_incomplete`: the sender fields that are empty (names only, never values). */
      missing: string[];
    };

export async function receiptReadiness(
  db: Kysely<CommerceDB>,
  tenantGroupId: string,
  companyId: string,
): Promise<ReceiptReadiness> {
  const scope = booksScope(db, tenantGroupId, companyId);
  const settings = await readSettings(db, scope);
  if (!settings) return { ready: false, blocker: 'books_not_set_up', missing: [] };
  const counters = await readCounters(db, scope);
  if (!counters.some((counter) => counter.docType === 'invoice')) {
    return { ready: false, blocker: 'invoice_numbers_missing', missing: [] };
  }
  const missing = senderMissingFields(settings.senderBlock, { taxStatus: settings.taxStatus, reverseCharge: false });
  if (missing.length > 0) return { ready: false, blocker: 'sender_incomplete', missing };
  return { ready: true };
}

/** What a buyer reads when the shop cannot take a payment yet. Says that nothing moved and offers no retry. */
export const PAYMENTS_UNAVAILABLE_MESSAGE =
  'This shop cannot take payments yet. Nothing has been charged. Please come back later or contact the shop.';
