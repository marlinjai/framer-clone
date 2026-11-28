// Deleting a project takes its shop catalogue along (src/server/catalog/siteRetire.ts), against real Postgres, connected as
// the low-privilege commerce role the routes use. One tenant group holds:
//
//   ACME    site A (the one deleted) with: an ordered ring (an order line names a variant), an invoiced service (a Books
//           line names it), an unsold mug with stock, an already archived scarf, and a collection; site B with a lamp;
//           a company item (no site); a product of a company not yet assigned is not modelled here (NULL rows are
//           company items either way and the rule never touches NULL).
//   OTHER   a second company in the same tenant group whose product and collection carry site A's id (a forged
//           stamp): another company's rows are never touched, whatever site id they name.
//
// What it proves: the job written before the delete is a no-op while the site exists (refused or uncommitted delete); after
// the delete the job alone retires the catalogue (a crash right after the commit); referenced products are archived whole,
// the rest are soft-deleted with their variants and stock items, so their SKUs are free again; collections are archived and
// emptied; a second run changes nothing; and the rows of another site, of another company and without a site stay as
// they were. All data is synthetic.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { ACTOR, FakeDirectory, initCompany, newCustomer, newTenantId, openBooksEnv, scopeFor, type BooksEnv } from '@/server/books/__tests__/booksFixtures';
import { addLine } from '@/server/books/repository/lines';
import { createDraft } from '@/server/books/repository/documents';
import { createPublishedSite } from '@/server/commerce/__tests__/storefrontFixtures';
import { runJobNow } from '@/server/commerce/jobs/run';
import { SITE_CLEANUP_DELAY_MS, SITE_CLEANUP_PATIENCE_MS } from '@/server/commerce/jobs/siteGone';
import { countStuckPurges } from '@/server/forms/purge';
import { createCollection, setCollectionProducts } from '../repository/collections';
import { createProduct, getProduct } from '../repository/products';
import { setVariantStock } from '../repository/stock';
import { setOptions, updateVariant } from '../repository/variants';
import { catalogScope, type CatalogScope } from '../scope';
import { IMMEDIATE_LOCK_TIMEOUT_MS, retireDeletedSiteCatalogue, retireDeletedSiteCatalogueNow, retireSiteCatalogue, scheduleSiteCatalogueRetire } from '../siteRetire';

const ACME = newTenantId();
const OTHER = newTenantId();

let env: BooksEnv;
let acme: CatalogScope;
let siteA: { siteId: string; workspaceId: string };
let siteB: { siteId: string; workspaceId: string };
const ids = {} as Record<'ring' | 'service' | 'mug' | 'scarf' | 'lamp' | 'companyItem' | 'otherProduct' | 'collA' | 'collB' | 'otherColl', string>;
let mugSkus: string[] = [];
const clock = { now: new Date('2026-11-28T09:00:00Z') };

const stamp = (table: 'product' | 'collection', id: string, siteId: string | null) =>
  env.ownerDb.updateTable(table).set({ site_id: siteId }).where('id', '=', id).execute();

async function snapshot() {
  const products = await env.ownerDb.selectFrom('product').select(['id', 'archived_at', 'deleted_at', 'site_id', 'tenant_id']).orderBy('id').execute();
  const variants = await env.ownerDb.selectFrom('product_variant').select(['id', 'product_id', 'deleted_at', 'sku']).orderBy('id').execute();
  const items = await env.ownerDb.selectFrom('inventory_item').select(['id', 'sku', 'deleted_at']).orderBy('id').execute();
  const collections = await env.ownerDb.selectFrom('collection').select(['id', 'archived_at', 'site_id']).orderBy('id').execute();
  const members = await env.ownerDb.selectFrom('collection_product').select(['collection_id', 'product_id']).orderBy('collection_id').orderBy('product_id').execute();
  return { products, variants, items, collections, members };
}

const product = (id: string) => env.ownerDb.selectFrom('product').select(['archived_at', 'deleted_at']).where('id', '=', id).executeTakeFirstOrThrow();
const liveVariants = async (productId: string) =>
  (await env.ownerDb.selectFrom('product_variant').select('id').where('product_id', '=', productId).where('deleted_at', 'is', null).execute()).length;
const retireJobs = () =>
  env.ownerDb.selectFrom('commerce_job').selectAll().where('kind', '=', 'catalogue_retire').orderBy('created_at').orderBy('id').execute();

async function runDue(at: Date): Promise<string[]> {
  const due = await env.ownerDb
    .selectFrom('commerce_job')
    .select(['id', 'tenant_id'])
    .where('kind', '=', 'catalogue_retire')
    .where('status', '=', 'pending')
    .where('run_at', '<=', at)
    .orderBy('run_at')
    .execute();
  const outcomes: string[] = [];
  for (const job of due) {
    outcomes.push((await runJobNow({ id: env.tgId, db: env.appDb }, job.tenant_id, job.id, { now: () => at }))?.outcome ?? 'none');
  }
  return outcomes;
}

beforeAll(async () => {
  env = await openBooksEnv('site-retire');
  siteA = await createPublishedSite(env.fx, env.tgId, 'retireA', ACME);
  siteB = await createPublishedSite(env.fx, env.tgId, 'retireB', ACME);
  acme = catalogScope(env.appDb, env.tgId, ACME);

  // The ring: sizes with stock, one ordered.
  ids.ring = (await createProduct(acme, { title: 'Silver Ring', price: 4900, status: 'published' })).id;
  const ring = await setOptions(acme, ids.ring, [{ title: 'Size', values: [{ value: '52' }, { value: '54' }] }]);
  for (const v of ring.variants) {
    await updateVariant(acme, ids.ring, v.id, { price: 5200 });
    await setVariantStock(acme, ids.ring, v.id, 2);
  }
  const orderId = randomUUID();
  await env.ownerDb
    .insertInto('order')
    .values({
      id: orderId, tenant_id: ACME, site_id: siteA.siteId, order_number: `ORD-SR-${randomUUID()}`, request_id: `sr-${randomUUID()}`,
      currency_code: 'EUR', tax_region: 'DE', subtotal: 5200, tax_amount: 0, total: 5200, created_at: clock.now, updated_at: clock.now,
    })
    .execute();
  await env.ownerDb
    .insertInto('order_line_item')
    .values({
      id: randomUUID(), order_id: orderId, tenant_id: ACME, unit_price: 5200, quantity: 1, subtotal: 5200,
      tax_rate: 0, tax_amount: 0, tax_treatment: 'standard', variant_ref: ring.variants[0].id, variant_ref_source: 'owned',
    })
    .execute();

  // The service: invoiced through the Books (a draft line naming its variant).
  ids.service = (await createProduct(acme, { title: 'Ring sizing', kind: 'service', price: 1500, status: 'published' })).id;
  const serviceVariant = (await getProduct(acme, ids.service)).variants[0].id;
  const dir = new FakeDirectory();
  const books = scopeFor(env.appDb, env.tgId, ACME, dir);
  await initCompany(books);
  const { customer } = await newCustomer(books, dir);
  const draft = await createDraft(books, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });
  await addLine(books, draft.document.id, { variantRef: serviceVariant });

  // The mug: sizes with stock, never sold.
  ids.mug = (await createProduct(acme, { title: 'Mug', price: 1200, status: 'published' })).id;
  const mug = await setOptions(acme, ids.mug, [{ title: 'Colour', values: [{ value: 'Red' }, { value: 'Blue' }] }]);
  for (const v of mug.variants) {
    await updateVariant(acme, ids.mug, v.id, { sku: `MUG-${v.id.slice(0, 6)}-${randomUUID().slice(0, 4)}` });
    await setVariantStock(acme, ids.mug, v.id, 7);
  }
  mugSkus = (await getProduct(acme, ids.mug)).variants.map((v) => v.sku as string);

  ids.scarf = (await createProduct(acme, { title: 'Scarf', price: 2500, status: 'published' })).id;
  await env.ownerDb.updateTable('product').set({ archived_at: new Date('2026-10-01') }).where('id', '=', ids.scarf).execute();
  ids.lamp = (await createProduct(acme, { title: 'Lamp', price: 9900, status: 'published' })).id;
  ids.companyItem = (await createProduct(acme, { title: 'Consulting hour', kind: 'service', price: 9000 })).id;
  for (const id of [ids.ring, ids.service, ids.mug, ids.scarf]) await stamp('product', id, siteA.siteId);
  await stamp('product', ids.lamp, siteB.siteId);

  ids.collA = (await createCollection(acme, { title: 'Shop A' })).id;
  await setCollectionProducts(acme, ids.collA, [ids.ring, ids.mug]);
  await stamp('collection', ids.collA, siteA.siteId);
  ids.collB = (await createCollection(acme, { title: 'Shop B' })).id;
  await setCollectionProducts(acme, ids.collB, [ids.lamp]);
  await stamp('collection', ids.collB, siteB.siteId);

  // Another company of the same tenant group, its rows forged to name site A.
  const other = catalogScope(env.appDb, env.tgId, OTHER);
  ids.otherProduct = (await createProduct(other, { title: 'Their Mug', price: 1100, status: 'published' })).id;
  await stamp('product', ids.otherProduct, siteA.siteId);
  ids.otherColl = (await createCollection(other, { title: 'Theirs' })).id;
  await setCollectionProducts(other, ids.otherColl, [ids.otherProduct]);
  await stamp('collection', ids.otherColl, siteA.siteId);
}, 180_000);

afterAll(async () => {
  await env?.close();
});

describe('deleting a project retires its shop catalogue', () => {
  it('the intent is a durable job of the company, due after the delete, carrying the site id only', async () => {
    expect(await scheduleSiteCatalogueRetire(env.tgId, ACME, siteA.siteId, clock.now, async () => env.appDb)).toBe(true);
    const jobs = await retireJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ tenant_id: ACME, kind: 'catalogue_retire', status: 'pending' });
    expect(jobs[0].payload).toEqual({
      siteId: siteA.siteId,
      notAfter: new Date(clock.now.getTime() + SITE_CLEANUP_DELAY_MS + SITE_CLEANUP_PATIENCE_MS).toISOString(),
    });
    expect(new Date(jobs[0].run_at).getTime()).toBe(clock.now.getTime() + SITE_CLEANUP_DELAY_MS);
    // The same delete asked again in the window is the same job.
    await scheduleSiteCatalogueRetire(env.tgId, ACME, siteA.siteId, clock.now, async () => env.appDb);
    expect(await retireJobs()).toHaveLength(1);
  });

  it('while the site row exists (a refused or uncommitted delete) the job retires nothing and hands the look on', async () => {
    const before = await snapshot();
    expect(await runDue(new Date(clock.now.getTime() + SITE_CLEANUP_DELAY_MS + 1_000))).toEqual(['done']);
    expect(await snapshot()).toEqual(before);
    // A fresh look ten minutes on, a job of its own, not a retry of a failure.
    const pending = (await retireJobs()).filter((j) => j.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].attempts).toBe(0);
  });

  it('once the site row is gone, the job alone (no immediate attempt) retires exactly the site catalogue of the company', async () => {
    const before = await snapshot();
    await env.fx.prisma.site.delete({ where: { id: siteA.siteId } });
    expect(await runDue(new Date(clock.now.getTime() + 3 * SITE_CLEANUP_DELAY_MS))).toEqual(['done']);

    // Referenced products are archived and kept whole: variants and stock stay live, so orders and invoices point at real rows.
    expect((await product(ids.ring)).archived_at).not.toBeNull();
    expect((await product(ids.ring)).deleted_at).toBeNull();
    expect(await liveVariants(ids.ring)).toBe(2);
    expect((await product(ids.service)).archived_at).not.toBeNull();
    expect((await product(ids.service)).deleted_at).toBeNull();
    // The unsold mug and the already archived scarf are soft-deleted with their variants and stock items.
    for (const id of [ids.mug, ids.scarf]) {
      expect((await product(id)).deleted_at).not.toBeNull();
      expect(await liveVariants(id)).toBe(0);
    }
    const mugItems = await env.ownerDb.selectFrom('inventory_item').select(['sku', 'deleted_at']).where('sku', 'in', mugSkus).execute();
    expect(mugItems).toHaveLength(2);
    expect(mugItems.every((i) => i.deleted_at !== null)).toBe(true);
    // The site's collection is archived and emptied.
    const collA = await env.ownerDb.selectFrom('collection').select('archived_at').where('id', '=', ids.collA).executeTakeFirstOrThrow();
    expect(collA.archived_at).not.toBeNull();
    expect(await env.ownerDb.selectFrom('collection_product').select('product_id').where('collection_id', '=', ids.collA).execute()).toEqual([]);

    // Nothing else moved: the other site, the company item and the other company's forged rows are exactly as before.
    const after = await snapshot();
    const untouched = new Set([ids.lamp, ids.companyItem, ids.otherProduct]);
    expect(after.products.filter((p) => untouched.has(p.id))).toEqual(before.products.filter((p) => untouched.has(p.id)));
    const untouchedColl = new Set([ids.collB, ids.otherColl]);
    expect(after.collections.filter((c) => untouchedColl.has(c.id))).toEqual(before.collections.filter((c) => untouchedColl.has(c.id)));
    expect(after.members.filter((m) => untouchedColl.has(m.collection_id))).toEqual(before.members.filter((m) => untouchedColl.has(m.collection_id)));
    const keptVariantIds = new Set(before.variants.filter((v) => ![ids.mug, ids.scarf].includes(v.product_id)).map((v) => v.id));
    expect(after.variants.filter((v) => keptVariantIds.has(v.id))).toEqual(before.variants.filter((v) => keptVariantIds.has(v.id)));
    expect(after.items.filter((i) => !mugSkus.includes(i.sku))).toEqual(before.items.filter((i) => !mugSkus.includes(i.sku)));
  });

  it('a second run (the immediate attempt and the job both ran) changes nothing', async () => {
    const before = await snapshot();
    expect(await retireSiteCatalogue(env.appDb, ACME, siteA.siteId, new Date(clock.now.getTime() + 60 * 60 * 1000))).toEqual({
      archivedProducts: 0,
      deletedProducts: 0,
      archivedCollections: 0,
    });
    expect(await retireDeletedSiteCatalogue(env.appDb, ACME, siteA.siteId, env.fx.prisma, { now: clock.now })).toBe('retired');
    expect(await snapshot()).toEqual(before);
    expect(await countStuckPurges(env.appDb)).toBe(0);
  });

  it("the deleted shop's SKUs are free again: a product on another site may take one, starting at zero stock", async () => {
    const reuse = (await createProduct(acme, { title: 'Mug again', price: 1200, status: 'published' })).id;
    await stamp('product', reuse, siteB.siteId);
    const variant = (await getProduct(acme, reuse)).variants[0];
    const updated = await updateVariant(acme, reuse, variant.id, { sku: mugSkus[0] });
    expect(updated.variants[0].sku).toBe(mugSkus[0]);
    await updateVariant(acme, reuse, variant.id, { manageInventory: true });
    // Not the deleted shop's 7: the old stock item is gone, so the reused SKU has none yet.
    expect([0, null]).toContain((await getProduct(acme, reuse)).variants[0].stock);
    await setVariantStock(acme, reuse, variant.id, 3);
    expect((await getProduct(acme, reuse)).variants[0].stock).toBe(3);
  });

  it('the immediate attempt gives up on a row a long transaction holds (the delete request is not stalled); the job then finishes it', async () => {
    const siteC = await createPublishedSite(env.fx, env.tgId, 'retireC', ACME);
    const held = (await createProduct(acme, { title: 'Held', price: 500, status: 'published' })).id;
    await stamp('product', held, siteC.siteId);
    await env.fx.prisma.site.delete({ where: { id: siteC.siteId } });
    const started = Date.now();
    await env.fx.owner.begin(async (tx) => {
      await tx`SELECT id FROM ${tx(env.schema)}.product WHERE id = ${held} FOR UPDATE`;
      await expect(retireDeletedSiteCatalogueNow(env.tgId, ACME, siteC.siteId, async () => env.appDb)).rejects.toThrow(/lock timeout/);
    });
    expect(Date.now() - started).toBeLessThan(IMMEDIATE_LOCK_TIMEOUT_MS + 5_000);
    expect((await product(held)).deleted_at).toBeNull();
    // The lock released, the job's run retires it.
    expect(await retireDeletedSiteCatalogue(env.appDb, ACME, siteC.siteId, env.fx.prisma, { now: clock.now })).toBe('retired');
    expect((await product(held)).deleted_at).not.toBeNull();
  }, 30_000);
});
