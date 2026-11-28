import 'server-only';

// src/server/catalog/siteRetire.ts
//
// Deleting a project takes its shop catalogue along (docs/plans/2026-11-27-agent-catalogue-tools.md, point 6 of "What
// the proposal changes and costs", slice 2b). Since migration 033 a product or collection may belong to one site
// (`site_id`); when that site is deleted, its catalogue must not stay behind holding SKUs and handles, nor be sold anywhere.
//
// What happens to the rows of the deleted site (company AND site, never anything else):
//   - a product that an order line or a Books document line references (`variant_ref` on any of its variants) is ARCHIVED
//     and kept whole, variants, prices and stock included, so orders, receipts, invoices and the stock ledger keep pointing
//     at real rows;
//   - every other product is SOFT-DELETED with its variants and their stock items (`deleted_at`), which releases its SKUs
//     (the SKU indexes are partial on `deleted_at`) so another site of the company can use them again, starting at zero stock;
//   - its collections are ARCHIVED (a collection has no `deleted_at`; archiving frees its handle the same way) and lose
//     their members;
//   - the old switch-off rows of the site (`product_site_hidden`) go: the site they name no longer exists.
// Rows without a site (company items, or the catalogue of a company not yet assigned) are never touched: they are not the
// site's. Everything runs in one transaction and is idempotent, so the immediate attempt and the job can both run.
//
// The site row (Prisma, `public`) and the catalogue (the tenant schema) are two connections, so no transaction covers both.
// As for the form submissions (src/server/forms/purge.ts), a write-ahead job is written BEFORE the site row is deleted
// (`scheduleSiteCatalogueRetire`), due ten minutes later; it acts only once the site row is really gone, so a delete that was
// refused or never committed costs nothing.
//
// Tenant scope: the company is the one the caller's verified session acts for (the delete route's active company, whose
// workspace the site was deleted from), carried as the job's tenant; every statement filters on that company and the site.
// So a caller who names another company's site id can retire nothing of that company's: protects against an admin of one
// company reaching another company's catalogue in the same tenant group.
//
// A known race, accepted: an order whose request resolved the site just before the delete committed can land after the
// retirement looked for references; its product is then soft-deleted rather than archived. The order line keeps its own
// snapshot (title, SKU, price) and its `variant_ref` still names the (soft-deleted) variant row, so nothing issued breaks.

import { isTenantGroupId } from '@marlinjai/tenant-db';
import type { PrismaClient } from '@prisma/client';
import type { Kysely, Transaction } from 'kysely';

import type { CommerceDB } from '@/server/commerce/db-types';
import { commerceTenantDbChecked, isCommerceTenantNotProvisioned } from '@/server/commerce/db';
import { scheduleJob } from '@/server/commerce/jobs/schedule';
import { SITE_CLEANUP_DELAY_MS, SITE_CLEANUP_PATIENCE_MS, siteGoneOrLookAgain } from '@/server/commerce/jobs/siteGone';
import { getPrismaClient } from '@/server/db';
import { CATALOGUE_RETIRE_JOB_KIND } from './siteRetireJob';

/** What one retirement changed (all zero on a repeat). */
export interface SiteCatalogueRetired {
  archivedProducts: number;
  deletedProducts: number;
  archivedCollections: number;
}

const retireJobKey = (companyId: string, siteId: string, at: Date) =>
  `catretire:${companyId}:${siteId}:${Math.floor(at.getTime() / SITE_CLEANUP_DELAY_MS)}`;

/**
 * Retire the catalogue of a deleted site, for one company, in one transaction (see the file header). Idempotent. The caller
 * guarantees the site row is gone; this function does not look.
 */
export async function retireSiteCatalogue(
  db: Kysely<CommerceDB>,
  companyId: string,
  siteId: string,
  now: Date = new Date(),
): Promise<SiteCatalogueRetired> {
  return db.transaction().execute(async (trx) => retireIn(trx, companyId, siteId, now));
}

async function retireIn(trx: Transaction<CommerceDB>, companyId: string, siteId: string, now: Date): Promise<SiteCatalogueRetired> {
  const products = await trx
    .selectFrom('product')
    .select((eb) => [
      'product.id',
      'product.archived_at',
      eb
        .or([
          eb.exists(
            eb
              .selectFrom('order_line_item')
              .innerJoin('product_variant as v', (join) =>
                join.onRef('v.id', '=', 'order_line_item.variant_ref').onRef('v.tenant_id', '=', 'order_line_item.tenant_id'),
              )
              .select('order_line_item.id')
              .where('order_line_item.tenant_id', '=', companyId)
              .whereRef('v.product_id', '=', 'product.id'),
          ),
          eb.exists(
            eb
              .selectFrom('sales_document_line')
              .innerJoin('product_variant as v', (join) =>
                join.onRef('v.id', '=', 'sales_document_line.variant_ref').onRef('v.tenant_id', '=', 'sales_document_line.tenant_id'),
              )
              .select('sales_document_line.id')
              .where('sales_document_line.tenant_id', '=', companyId)
              .whereRef('v.product_id', '=', 'product.id'),
          ),
        ])
        .as('referenced'),
    ])
    .where('product.tenant_id', '=', companyId)
    .where('product.site_id', '=', siteId)
    .where('product.deleted_at', 'is', null)
    // Rows a concurrent editor save or checkout might touch wait for this transaction, and it for them.
    .forUpdate()
    .execute();

  const keep = products.filter((p) => p.referenced);
  const drop = products.filter((p) => !p.referenced).map((p) => p.id);
  const toArchive = keep.filter((p) => p.archived_at === null).map((p) => p.id);

  if (toArchive.length > 0) {
    await trx
      .updateTable('product')
      .set({ archived_at: now, updated_at: now })
      .where('tenant_id', '=', companyId)
      .where('id', 'in', toArchive)
      .execute();
  }

  if (drop.length > 0) {
    const variants = await trx
      .selectFrom('product_variant')
      .select(['id', 'sku'])
      .where('tenant_id', '=', companyId)
      .where('product_id', 'in', drop)
      .where('deleted_at', 'is', null)
      .execute();
    const skus = variants.map((v) => v.sku).filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (variants.length > 0) {
      await trx
        .updateTable('product_variant')
        .set({ deleted_at: now, updated_at: now })
        .where('tenant_id', '=', companyId)
        .where('id', 'in', variants.map((v) => v.id))
        .execute();
    }
    // The stock items of those SKUs: a SKU is unique in the tenant group and was this company's live variant's, so the item
    // is that variant's stock and no one else's. Soft-deleting it lets a reused SKU start at zero, not at the deleted shop's count.
    if (skus.length > 0) {
      await trx.updateTable('inventory_item').set({ deleted_at: now, updated_at: now }).where('sku', 'in', skus).where('deleted_at', 'is', null).execute();
    }
    await trx.deleteFrom('collection_product').where('tenant_id', '=', companyId).where('product_id', 'in', drop).execute();
    await trx
      .updateTable('product')
      .set({ deleted_at: now, updated_at: now })
      .where('tenant_id', '=', companyId)
      .where('id', 'in', drop)
      .execute();
  }

  const collections = await trx
    .updateTable('collection')
    .set({ archived_at: now, updated_at: now })
    .where('tenant_id', '=', companyId)
    .where('site_id', '=', siteId)
    .where('archived_at', 'is', null)
    .returning('id')
    .execute();
  if (collections.length > 0) {
    await trx
      .deleteFrom('collection_product')
      .where('tenant_id', '=', companyId)
      .where('collection_id', 'in', collections.map((c) => c.id))
      .execute();
  }

  await trx.deleteFrom('product_site_hidden').where('tenant_id', '=', companyId).where('site_id', '=', siteId).execute();

  return { archivedProducts: toArchive.length, deletedProducts: drop.length, archivedCollections: collections.length };
}

/**
 * Write the intent to retire a project's catalogue, before the project is deleted. A tenant group without a commerce schema
 * has no catalogue: nothing is written and false is answered. True confirms a durable job exists. Any other failure throws,
 * and the caller must not delete the project then (nothing would retire its catalogue).
 */
export async function scheduleSiteCatalogueRetire(
  tenantGroupId: string,
  companyId: string,
  siteId: string,
  now: Date = new Date(),
  dbFor: (tenantGroupId: string) => Promise<Kysely<CommerceDB>> = (id) => commerceTenantDbChecked(id as never),
): Promise<boolean> {
  if (!isTenantGroupId(tenantGroupId)) return false;
  let db: Kysely<CommerceDB>;
  try {
    db = await dbFor(tenantGroupId);
  } catch (err) {
    if (isCommerceTenantNotProvisioned(err)) return false;
    throw err;
  }
  await db.transaction().execute(async (trx) => {
    await scheduleJob(trx, {
      tenantId: companyId,
      kind: CATALOGUE_RETIRE_JOB_KIND,
      // One per company, site and ten minutes, as the form purge's key (src/server/forms/purge.ts says why).
      dedupeKey: retireJobKey(companyId, siteId, now),
      payload: { siteId, notAfter: new Date(now.getTime() + SITE_CLEANUP_DELAY_MS + SITE_CLEANUP_PATIENCE_MS).toISOString() },
      runAt: new Date(now.getTime() + SITE_CLEANUP_DELAY_MS),
      at: now,
    });
  });
  return true;
}

/**
 * The immediate retirement, right after the delete committed. Null for a tenant group without a commerce schema. Throws on a
 * failure; the job written before the delete finishes it then.
 */
export async function retireDeletedSiteCatalogueNow(
  tenantGroupId: string,
  companyId: string,
  siteId: string,
  dbFor: (tenantGroupId: string) => Promise<Kysely<CommerceDB>> = (id) => commerceTenantDbChecked(id as never),
): Promise<SiteCatalogueRetired | null> {
  if (!isTenantGroupId(tenantGroupId)) return null;
  let db: Kysely<CommerceDB>;
  try {
    db = await dbFor(tenantGroupId);
  } catch (err) {
    if (isCommerceTenantNotProvisioned(err)) return null;
    throw err;
  }
  return retireSiteCatalogue(db, companyId, siteId);
}

/**
 * The job's work, for the company the job belongs to (its tenant). The site row still there: nothing is retired (and, within
 * the patience, the look is handed on). The row gone: the catalogue is retired. A failure is a retry; nothing kills the job.
 */
export async function retireDeletedSiteCatalogue(
  db: Kysely<CommerceDB>,
  companyId: string,
  siteId: string,
  prisma: PrismaClient = getPrismaClient(),
  options: { notAfter?: string | null; now?: Date } = {},
): Promise<'kept' | 'retired'> {
  const now = options.now ?? new Date();
  const gone = await siteGoneOrLookAgain(prisma, {
    db,
    tenantId: companyId,
    kind: CATALOGUE_RETIRE_JOB_KIND,
    lookKeyPrefix: `catretire:look:${companyId}:${siteId}`,
    siteId,
    payload: { siteId },
    notAfter: options.notAfter,
    now,
  });
  if (!gone) return 'kept';
  await retireSiteCatalogue(db, companyId, siteId, now);
  return 'retired';
}
