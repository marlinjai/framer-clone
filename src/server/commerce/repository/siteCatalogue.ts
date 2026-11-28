// src/server/commerce/repository/siteCatalogue.ts
//
// Which products belong to a site's catalogue: the one rule the published shop, its checkout and the agent
// catalogue tools share (migration 033_catalogue_site; docs/plans/2026-11-27-agent-catalogue-tools.md, the
// catalogue per project, decided 2026-11-28).
//
//   - A product that names the site is on it.
//   - A product that names no site is on it only while its company is NOT yet assigned (`catalogue_per_site`):
//     then the old rule holds, the company's products not switched off for the site (`product_site_hidden`). Once
//     the company is assigned, a product without a site is a company item, sold through the Books and on no site.
//
// So a deploy of 033 changes no live shop; each company switches when its assignment runs
// (src/server/commerce/provisioning/assignSites.ts). The caller adds the company condition (`product.tenant_id`):
// the site id alone never decides whose products are read.

import type { Expression, ExpressionBuilder, SqlBool } from 'kysely';

import type { CommerceDB } from '../db-types';

/** The product is in `siteId`'s catalogue (see the file header). Combine with the company condition. */
export function productOnSite(eb: ExpressionBuilder<CommerceDB, 'product'>, siteId: string): Expression<SqlBool> {
  return eb.or([
    eb('product.site_id', '=', siteId),
    eb.and([
      eb('product.site_id', 'is', null),
      eb.not(
        eb.exists(
          eb
            .selectFrom('catalogue_per_site')
            .select('catalogue_per_site.tenant_id')
            .whereRef('catalogue_per_site.tenant_id', '=', 'product.tenant_id'),
        ),
      ),
      eb.not(
        eb.exists(
          eb
            .selectFrom('product_site_hidden')
            .select('product_site_hidden.product_id')
            .whereRef('product_site_hidden.tenant_id', '=', 'product.tenant_id')
            .whereRef('product_site_hidden.product_id', '=', 'product.id')
            .where('product_site_hidden.site_id', '=', siteId),
        ),
      ),
    ]),
  ]);
}
