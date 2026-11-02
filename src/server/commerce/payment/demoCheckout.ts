// src/server/commerce/payment/demoCheckout.ts
//
// Who may check out with the demo provider (decided on 2026-11-02 after the money review, finding 4). The demo provider
// moves no money but marks an order paid, and the order's receipt is a real, numbered invoice in the company's Books.
// On any other live shop a visitor could create issued invoices for sales that never happened, which use up invoice
// numbers and can only be undone with credit notes. So the demo checkout is for the demo company alone: every other shop
// without a Stripe account that can take payments refuses checkout before anything is reserved, as it does while its
// Books cannot issue receipts (receiptReadiness.ts), with the same answer.

import { DEMO_COMPANY_ID } from '@/lib/renderer/server/demoTenant';

/** True only for the demo company, whose shop shows the checkout without real money. */
export function demoCheckoutAllowed(companyId: string): boolean {
  return companyId === DEMO_COMPANY_ID;
}
