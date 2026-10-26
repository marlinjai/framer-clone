import 'server-only';

// src/server/commerce/company.ts
//
// Which company of a tenant group a catalogue read or write acts for (020_catalogue_company). One tenant
// group schema holds the catalogues of all companies of an auth-brain organisation, each row carrying its
// company in `tenant_id`; the editor knows the company from the session, the storefront from the site
// (`sites.company_id`, stamped by the editor). A site not stamped yet falls back to the schema's sole
// company: the one company id the Books tables know, the same rule migration 020 backfilled existing rows
// with (`catalogue_sole_company()`). With none or several, there is no company and no catalogue.

import type { Kysely } from 'kysely';

import type { CommerceDB } from './db-types';

/** The one company the Books tables of this schema know, or null for none or several. */
export async function soleCompany(db: Kysely<CommerceDB>): Promise<string | null> {
  const rows = await db
    .selectFrom('books_company_settings')
    .select('tenant_id')
    .union(db.selectFrom('customer').select('tenant_id'))
    .union(db.selectFrom('sales_document').select('tenant_id'))
    .union(db.selectFrom('books_product').select('tenant_id'))
    .limit(2)
    .execute();
  return rows.length === 1 ? rows[0].tenant_id : null;
}

/** The company whose catalogue a published site shows: its stamped company, else the sole company. */
export async function companyForSite(
  db: Kysely<CommerceDB>,
  site: { companyId: string | null },
): Promise<string | null> {
  return site.companyId ?? (await soleCompany(db));
}
