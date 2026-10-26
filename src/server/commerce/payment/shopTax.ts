import 'server-only';

// src/server/commerce/payment/shopTax.ts
//
// How the shop charges VAT for a company: from its Books settings, the same setting the receipt is issued
// under, so the receipt adds up to the order. A small business (section 19 UStG) charges none; a company
// without Books settings charges VAT as a regular business (and its paid orders get no receipt until the
// Books are set up: the reason is kept on the payment, see payments.ts).

import type { Kysely } from 'kysely';

import type { CommerceDB } from '../db-types';

export async function shopTaxProfile(
  db: Kysely<CommerceDB>,
  companyId: string,
): Promise<{ kleinunternehmer: boolean; booksReady: boolean }> {
  const settings = await db
    .selectFrom('books_company_settings')
    .select('tax_status')
    .where('tenant_id', '=', companyId)
    .executeTakeFirst();
  return { kleinunternehmer: settings?.tax_status === 'small_business', booksReady: settings !== undefined };
}
