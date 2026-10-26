// src/server/catalog/repository/sites.ts
//
// Per-site visibility (020 guarantee 9, the design's "sales channels"): every
// site of the company shows every published product, unless the product is
// switched off for that site in `product_site_hidden`. The panel sends the full
// list of sites the product is hidden on; the route passes the company's own
// site ids (from the session's workspace), so a product can only be hidden on
// a site of its company (UNKNOWN_SITE otherwise). Rows for sites that no
// longer exist are left alone: they hide nothing and vanish with the product.

import { z } from 'zod';

import type { ProductDetail } from '@/lib/catalog/types';

import { CatalogError, invalid, withDbErrors } from '../errors';
import type { CatalogScope } from '../scope';
import { getProduct } from './products';
import { lockProduct, touchProduct } from './shared';

const siteIds = z
  .array(z.string().min(1).max(100))
  .max(200)
  .refine((ids) => new Set(ids).size === ids.length, 'a site is listed twice');

/** Hide the product on exactly these of the company's sites (and show it on the others). */
export async function setHiddenSites(
  scope: CatalogScope,
  productId: string,
  hidden: string[],
  companySiteIds: ReadonlySet<string>,
): Promise<ProductDetail> {
  const parsed = siteIds.safeParse(hidden);
  if (!parsed.success) throw invalid(parsed.error.issues.map((i) => ({ ...i, path: ['hiddenSiteIds', ...i.path] })));
  const unknown = parsed.data.find((id) => !companySiteIds.has(id));
  if (unknown) throw new CatalogError('UNKNOWN_SITE', 'this site is not one of the company’s sites', { siteId: unknown });
  await withDbErrors(() =>
    scope.db.transaction().execute(async (trx) => {
      await lockProduct(trx, scope, productId);
      const known = [...companySiteIds];
      if (known.length > 0) {
        await trx
          .deleteFrom('product_site_hidden')
          .where('tenant_id', '=', scope.tenantId)
          .where('product_id', '=', productId)
          .where('site_id', 'in', known)
          .execute();
      }
      if (parsed.data.length > 0) {
        await trx
          .insertInto('product_site_hidden')
          .values(parsed.data.map((siteId) => ({ tenant_id: scope.tenantId, product_id: productId, site_id: siteId })))
          .execute();
      }
      await touchProduct(trx, scope, productId);
    }),
  );
  return getProduct(scope, productId);
}
