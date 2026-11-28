// src/server/commerce/__tests__/catalogue-site.itest.ts
//
// The rehearsal of the catalogue per project (migration 033_catalogue_site and the operator step
// src/server/commerce/provisioning/assignSites.ts; docs/plans/2026-11-27-agent-catalogue-tools.md, decided by
// Marlin on 2026-11-28) against a real Postgres. One tenant group holds:
//
//   SOLO    one site: everything moves there.
//   MULTI   three sites (m1 oldest, m2, m3): a ring with sizes, prices and stock, shown on m1 and m2 (switched off
//           on m3) and sold on both, most recently on m2; a necklace switched off everywhere; a sizing service shown
//           everywhere and never sold; a deleted product; a collection of the ring and the service; an empty one.
//   NOSITE  no site: its service stays a company item.
//
// What it proves: a dry run reports and writes nothing; a site naming no company refuses an applying run; the
// shops read the old way until their company is assigned, one company at a time; after the assignment each site
// shows exactly its own products, a product shown on several sites keeps its row (ids, SKUs, stock, orders) on
// the site that sold it last and is copied, with fresh SKUs and no stock, to the others; collections follow their
// products; a second run changes nothing; a product created afterwards without a site is on no shop.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openBooksEnv, newTenantId, type BooksEnv } from '@/server/books/__tests__/booksFixtures';
import { toJsonb } from '@/server/books/snapshots';
import { createCollection, getCollection, setCollectionProducts } from '@/server/catalog/repository/collections';
import { createProduct, getProduct, isProductOnSite, listProducts } from '@/server/catalog/repository/products';
import { setHiddenSites } from '@/server/catalog/repository/sites';
import { setVariantStock } from '@/server/catalog/repository/stock';
import { setOptions, updateVariant } from '@/server/catalog/repository/variants';
import { catalogScope, type CatalogScope } from '@/server/catalog/scope';
import { AssignSitesRefused, assignCatalogueSites, type MainSite } from '../provisioning/assignSites';
import { getCommerceServerRepository } from '../repository/read';
import { listStorefrontProducts } from '../repository/storefront';

const SOLO = newTenantId();
const MULTI = newTenantId();
const NOSITE = newTenantId();

const s1 = `site-solo-${randomUUID().slice(0, 8)}`;
const [m1, m2, m3] = ['m1', 'm2', 'm3'].map((n) => `site-${n}-${randomUUID().slice(0, 8)}`);

const SITES: MainSite[] = [
  { id: m2, companyId: MULTI, createdAt: new Date('2026-03-02'), published: true },
  { id: s1, companyId: SOLO, createdAt: new Date('2026-01-01'), published: true },
  { id: m3, companyId: MULTI, createdAt: new Date('2026-03-03'), published: true },
  // The oldest site of MULTI is a draft: an unsold product's row (with its stock) prefers a live shop.
  { id: m1, companyId: MULTI, createdAt: new Date('2026-03-01'), published: false },
];

// Six tied rows: random ids on a copy would keep their order by chance once in 720 runs only.
const SIZES = ['52', '54', '56', '58', '60', '62'];

let env: BooksEnv;
let ownerUrl: string;
let multi: CatalogScope;
let ring: string;
let ringSkus: string[];
let necklace: string;
let sizing: string;
let gone: string;
let rings: string;
let empty: string;
let cake: string;
let consulting: string;

/** One order on `siteId` for one unit of `variantId`, placed at `at`, without a payment record. Returns its id. */
async function order(companyId: string, siteId: string, variantId: string, at: Date): Promise<string> {
  const id = randomUUID();
  await env.ownerDb
    .insertInto('order')
    .values({
      id, tenant_id: companyId, site_id: siteId, order_number: `ORD-CS-${randomUUID()}`, request_id: `cs-${randomUUID()}`,
      currency_code: 'EUR', tax_region: 'DE', subtotal: 5200, tax_amount: 0, total: 5200, created_at: at, updated_at: at,
    })
    .execute();
  await env.ownerDb
    .insertInto('order_line_item')
    .values({
      id: randomUUID(), order_id: id, tenant_id: companyId, unit_price: 5200, quantity: 1, subtotal: 5200,
      tax_rate: 0, tax_amount: 0, tax_treatment: 'standard', variant_ref: variantId, variant_ref_source: 'owned',
    })
    .execute();
  return id;
}

/** The payment record of an order: opened pending, then moved through `moves`. */
async function payment(companyId: string, orderId: string, moves: Array<'paid' | 'refunded'>): Promise<void> {
  const at = new Date('2026-06-02');
  await env.ownerDb
    .insertInto('order_payment')
    .values({
      tenant_id: companyId, order_id: orderId, provider: 'demo', amount: 5200, currency_code: 'EUR', application_fee_amount: 52,
      buyer: toJsonb({}), expires_at: at, updated_at: at,
    })
    .execute();
  for (const status of moves) {
    await env.ownerDb
      .updateTable('order_payment')
      .set({ status, ...(status === 'paid' ? { paid_at: at } : {}) })
      .where('order_id', '=', orderId)
      .execute();
  }
}

/** The handles a site's published shop lists. */
async function shop(companyId: string, siteId: string): Promise<string[]> {
  const page = await listStorefrontProducts(env.appDb, { companyId, siteId }, { limit: 100, currency: 'EUR' });
  return page.products.map((p) => p.handle).sort();
}

async function siteOf(id: string): Promise<string | null> {
  const row = await env.ownerDb.selectFrom('product').select('site_id').where('id', '=', id).executeTakeFirstOrThrow();
  return row.site_id;
}

async function rowCounts() {
  const count = async (table: 'product' | 'product_variant' | 'collection' | 'collection_product' | 'catalogue_per_site') =>
    Number((await env.ownerDb.selectFrom(table).select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow()).n);
  return {
    product: await count('product'),
    variant: await count('product_variant'),
    collection: await count('collection'),
    member: await count('collection_product'),
    marked: await count('catalogue_per_site'),
    placed: Number((await env.ownerDb.selectFrom('product').select((eb) => eb.fn.countAll<string>().as('n')).where('site_id', 'is not', null).executeTakeFirstOrThrow()).n),
  };
}

beforeAll(async () => {
  env = await openBooksEnv('catalogue-site');
  ownerUrl = process.env.DATABASE_URL as string;

  multi = catalogScope(env.appDb, env.tgId, MULTI);
  const r = await createProduct(multi, { title: 'Silver Ring', price: 4900, status: 'published' });
  ring = r.id;
  const withSizes = await setOptions(multi, ring, [{ title: 'Size', values: SIZES.map((value) => ({ value })) }]);
  for (const v of withSizes.variants) {
    await updateVariant(multi, ring, v.id, { price: 5200 });
    await setVariantStock(multi, ring, v.id, 3);
  }
  ringSkus = withSizes.variants.map((v) => v.sku as string).sort();
  necklace = (await createProduct(multi, { title: 'Gold Necklace', price: 12900, status: 'published' })).id;
  sizing = (await createProduct(multi, { title: 'Ring sizing', kind: 'service', price: 1500, status: 'published' })).id;
  gone = (await createProduct(multi, { title: 'Old Brooch', price: 900, status: 'published' })).id;
  await env.ownerDb.updateTable('product').set({ deleted_at: new Date() }).where('id', '=', gone).execute();
  const all = new Set([m1, m2, m3]);
  await setHiddenSites(multi, ring, [m3], all);
  await setHiddenSites(multi, necklace, [m1, m2, m3], all);
  await order(MULTI, m1, withSizes.variants[0].id, new Date('2026-05-01'));
  // The winning sale goes the checkout's way: a payment record that ends paid.
  const sale = await order(MULTI, m2, withSizes.variants[1].id, new Date('2026-06-01'));
  await payment(MULTI, sale, ['paid']);
  await order(MULTI, m3, withSizes.variants[1].id, new Date('2026-07-01')); // before it was switched off on m3
  // Newer orders on m1 that are no sale: one still waiting for its payment, one refunded, one cancelled.
  await payment(MULTI, await order(MULTI, m1, withSizes.variants[0].id, new Date('2026-08-01')), []);
  await payment(MULTI, await order(MULTI, m1, withSizes.variants[0].id, new Date('2026-08-15')), ['paid', 'refunded']);
  const cancelled = await order(MULTI, m1, withSizes.variants[0].id, new Date('2026-09-01'));
  await env.ownerDb.updateTable('order').set({ status: 'cancelled' }).where('id', '=', cancelled).execute();
  // The sizes were written at the same moment: only their ids order them, in the original and in a copy.
  const tied = new Date('2026-04-01');
  await env.ownerDb.updateTable('product_option_value').set({ created_at: tied }).where('tenant_id', '=', MULTI).execute();
  await env.ownerDb.updateTable('product_variant').set({ created_at: tied }).where('product_id', '=', ring).execute();
  rings = (await createCollection(multi, { title: 'Rings' })).id;
  await setCollectionProducts(multi, rings, [ring, necklace, sizing]);
  empty = (await createCollection(multi, { title: 'Empty' })).id;

  const solo = catalogScope(env.appDb, env.tgId, SOLO);
  cake = (await createProduct(solo, { title: 'Torte', price: 3800, status: 'published' })).id;
  await setCollectionProducts(solo, (await createCollection(solo, { title: 'Cakes' })).id, [cake]);
  consulting = (await createProduct(catalogScope(env.appDb, env.tgId, NOSITE), { title: 'Beratung', kind: 'service', price: 9000 })).id;
}, 120_000);

afterAll(async () => {
  await env?.close();
});

describe('033_catalogue_site and catalogue:assign-sites', () => {
  it('before the assignment every shop reads the old way (company products not switched off for the site)', async () => {
    expect(await shop(MULTI, m1)).toEqual(['ring-sizing', 'silver-ring']);
    expect(await shop(MULTI, m3)).toEqual(['ring-sizing']);
    expect(await shop(SOLO, s1)).toEqual(['torte']);
  });

  it('a dry run reports the whole assignment and writes nothing', async () => {
    const before = await rowCounts();
    const report = await assignCatalogueSites({ connectionString: ownerUrl, tenantGroupId: env.tgId, sites: SITES });
    expect(report.applied).toBe(false);
    const m = report.companies.find((c) => c.companyId === MULTI)!;
    expect(m.sites).toEqual([m1, m2, m3]);
    expect(m.productsOnSite).toEqual({ [m1]: 2, [m2]: 2, [m3]: 1 });
    expect(m.companyItems).toBe(1);
    expect(m.productCopies.map((c) => [c.title, c.siteId]).sort()).toEqual([
      ['Ring sizing', m1], ['Ring sizing', m3], ['Silver Ring', m1],
    ].sort());
    expect(report.companies.find((c) => c.companyId === NOSITE)).toMatchObject({ sites: [], companyItems: 1 });
    expect(await rowCounts()).toEqual(before);
    expect(await shop(MULTI, m1)).toEqual(['ring-sizing', 'silver-ring']);
  });

  it('a main site that names no company refuses an applying run, and a dry run lists it', async () => {
    const unstamped = [...SITES, { id: 'site-unstamped', companyId: null, createdAt: new Date(), published: true }];
    const dry = await assignCatalogueSites({ connectionString: ownerUrl, tenantGroupId: env.tgId, sites: unstamped });
    expect(dry.unstampedSites).toEqual(['site-unstamped']);
    await expect(
      assignCatalogueSites({ connectionString: ownerUrl, tenantGroupId: env.tgId, sites: unstamped, apply: true }),
    ).rejects.toBeInstanceOf(AssignSitesRefused);
    expect((await rowCounts()).marked).toBe(0);
  });

  it('one company at a time: the assigned one reads its own products, the others still the old way', async () => {
    const report = await assignCatalogueSites({ connectionString: ownerUrl, tenantGroupId: env.tgId, sites: SITES, companyId: SOLO, apply: true });
    expect(report.companies.map((c) => c.companyId)).toEqual([SOLO]);
    expect(await siteOf(cake)).toBe(s1);
    expect(await shop(SOLO, s1)).toEqual(['torte']);
    expect(await shop(MULTI, m1)).toEqual(['ring-sizing', 'silver-ring']);
    expect(await siteOf(ring)).toBeNull();
  });

  it('applies: each site shows exactly its own products; the row stays where it sold last, copies elsewhere', async () => {
    const report = await assignCatalogueSites({ connectionString: ownerUrl, tenantGroupId: env.tgId, sites: SITES, apply: true });
    expect(report.applied).toBe(true);
    expect(report.companies.find((c) => c.companyId === SOLO)?.alreadyAssigned).toBe(true);

    // The ring sold last on m2 (the later m3 sale is on a site it is switched off for): the row moves there.
    expect(await siteOf(ring)).toBe(m2);
    // Never sold: its row goes to the oldest PUBLISHED site it is shown on (m2), not to the draft m1.
    expect(await siteOf(sizing)).toBe(m2);
    expect(await siteOf(necklace)).toBeNull();
    expect(await siteOf(gone)).toBeNull();
    expect(await siteOf(consulting)).toBeNull();

    expect(await shop(MULTI, m1)).toEqual(['ring-sizing', 'silver-ring']);
    expect(await shop(MULTI, m2)).toEqual(['ring-sizing', 'silver-ring']);
    expect(await shop(MULTI, m3)).toEqual(['ring-sizing']);

    // The original keeps its SKUs and its stock; the copy on m1 has the same sizes and prices, new SKUs, no stock.
    const original = await getProduct(multi, ring);
    expect(original.variants.map((v) => v.sku).sort()).toEqual(ringSkus);
    expect(original.variants.map((v) => v.stock)).toEqual(SIZES.map(() => 3));
    const copyId = report.companies.find((c) => c.companyId === MULTI)!.productCopies.find((c) => c.siteId === m1)!.id;
    const copy = await getProduct(multi, copyId);
    expect(copy.handle).toBe(original.handle);
    expect(copy.options.map((o) => [o.title, o.values.map((v) => v.value).sort()])).toEqual([['Size', SIZES]]);
    // Every reader lists the copy's tied sizes and variants in the original's order: the editor, the shop's REST
    // read and the published page's read.
    const unsuffixed = (sku: string | undefined | null) => sku?.replace(/-2$/, '');
    expect(copy.options.map((o) => o.values.map((v) => v.value))).toEqual(original.options.map((o) => o.values.map((v) => v.value)));
    expect(copy.variants.map((v) => unsuffixed(v.sku))).toEqual(original.variants.map((v) => v.sku));
    const rest = async (siteId: string) => {
      const page = await listStorefrontProducts(env.appDb, { companyId: MULTI, siteId }, { limit: 100, currency: 'EUR' });
      const p = page.products.find((x) => x.handle === 'silver-ring')!;
      return { values: p.options.map((o) => o.values.map((v) => v.value)), skus: p.variants.map((v) => unsuffixed(v.sku)) };
    };
    expect(await rest(m1)).toEqual(await rest(m2));
    const published = async (siteId: string, productId: string) => {
      const shopRead = getCommerceServerRepository(env.appDb, { companyId: MULTI, siteId });
      const p = (await shopRead.getProductByHandle('silver-ring'))!;
      const variants = await shopRead.listVariants(productId);
      return {
        values: p.options.map((o) => o.values.map((v) => v.label)),
        variantIds: p.variantIds.map((id) => unsuffixed(variants.find((v) => v.id === id)!.sku)),
        skus: variants.map((v) => unsuffixed(v.sku)),
      };
    };
    expect(await published(m1, copyId)).toEqual(await published(m2, ring));
    expect(copy.variants.map((v) => v.price)).toEqual(SIZES.map(() => 5200));
    expect(copy.variants.map((v) => v.sku).sort()).toEqual(ringSkus.map((s) => `${s}-2`).sort());
    expect(copy.variants.map((v) => v.stock)).toEqual(SIZES.map(() => 0));
    // Each copied SKU has its own stock record (at zero), so checkout finds it as it found the original's.
    const items = await env.ownerDb.selectFrom('inventory_item').select('sku').where('sku', 'in', copy.variants.map((v) => v.sku as string)).execute();
    expect(items).toHaveLength(SIZES.length);
    expect(new Set(copy.variants.map((v) => v.id)).isDisjointFrom(new Set(original.variants.map((v) => v.id)))).toBe(true);

    // The agent tools' site filter and check follow the same rule.
    expect(await isProductOnSite(multi, copyId, m1)).toBe(true);
    expect(await isProductOnSite(multi, ring, m1)).toBe(false);
    expect((await listProducts(multi, { site: m3 })).items.map((p) => p.title)).toEqual(['Ring sizing']);
  });

  it('collections follow their products: the first site keeps the row, the others get copies in the same order', async () => {
    const c = report2Collections(await env.ownerDb.selectFrom('collection').select(['id', 'title', 'site_id']).where('tenant_id', '=', MULTI).execute());
    expect(c.get('Rings')).toEqual([m1, m2, m3]);
    expect(c.get('Empty')).toEqual([m1]);
    // The necklace is a company item now (on no site): its membership is dropped, and counted in the report.
    const stored = await env.ownerDb.selectFrom('catalogue_per_site').select('report').where('tenant_id', '=', MULTI).executeTakeFirstOrThrow();
    expect((stored.report as { collectionMembersDropped: number }).collectionMembersDropped).toBe(1);
    const kept = await env.ownerDb.selectFrom('collection').select('site_id').where('id', '=', rings).executeTakeFirstOrThrow();
    expect(kept.site_id).toBe(m1);
    expect((await env.ownerDb.selectFrom('collection').select('site_id').where('id', '=', empty).executeTakeFirstOrThrow()).site_id).toBe(m1);

    const members = async (siteId: string) => {
      const row = await env.ownerDb.selectFrom('collection').select('id').where('tenant_id', '=', MULTI).where('title', '=', 'Rings').where('site_id', '=', siteId).executeTakeFirstOrThrow();
      const detail = await getCollection(multi, row.id);
      return Promise.all(detail.products.map(async (p) => [p.title, await siteOf(p.id)]));
    };
    expect(await members(m1)).toEqual([['Silver Ring', m1], ['Ring sizing', m1]]);
    expect(await members(m2)).toEqual([['Silver Ring', m2], ['Ring sizing', m2]]);
    expect(await members(m3)).toEqual([['Ring sizing', m3]]);
  });

  it('a second run changes nothing', async () => {
    const before = await rowCounts();
    const again = await assignCatalogueSites({ connectionString: ownerUrl, tenantGroupId: env.tgId, sites: SITES, apply: true });
    expect(again.companies.every((c) => c.alreadyAssigned)).toBe(true);
    expect(await rowCounts()).toEqual(before);
  });

  it('once assigned, a product without a site is a company item and on no shop', async () => {
    await createProduct(multi, { title: 'Gift card', price: 2500, status: 'published' });
    expect(await shop(MULTI, m1)).toEqual(['ring-sizing', 'silver-ring']);
    expect(await shop(MULTI, m2)).toEqual(['ring-sizing', 'silver-ring']);
  });
});

describe('the mixed state 2b leaves before the assignment runs (rows stamped in the editor beside rows without a site)', () => {
  // MIXED is not yet assigned. Its owner used the per-site editor (slice 2b): a "Torte" on x1 now holds the handle `torte`
  // that the company's older, siteless "Torte" (shown on both sites) brings to x1; and a collection stamped with x1 holds
  // the siteless "Kekse" (shown on x2 only), and an old siteless collection holds both Tortes (both allowed until assigned).
  const MIXED = newTenantId();
  const [x1, x2] = ['x1', 'x2'].map((n) => `site-${n}-${randomUUID().slice(0, 8)}`);
  const MIXED_SITES: MainSite[] = [
    { id: x1, companyId: MIXED, createdAt: new Date('2026-04-01'), published: true },
    { id: x2, companyId: MIXED, createdAt: new Date('2026-04-02'), published: true },
  ];

  it('the assignment completes: a clashing handle gets the next free one on the site, a stamped membership follows its product or goes', async () => {
    const mixed = catalogScope(env.appDb, env.tgId, MIXED);
    const oldTorte = (await createProduct(mixed, { title: 'Torte', handle: 'torte', price: 3800, status: 'published' })).id;
    const kekse = (await createProduct(mixed, { title: 'Kekse', price: 900, status: 'published' })).id;
    await setHiddenSites(mixed, kekse, [x1], new Set([x1, x2]));
    const newTorte = (await createProduct(mixed, { title: 'Torte', handle: 'torte', price: 4200, status: 'published' }, { siteId: x1 })).id;
    const stampedColl = (await createCollection(mixed, { title: 'Auf x1' }, { siteId: x1 })).id;
    await setCollectionProducts(mixed, stampedColl, [newTorte]);
    // An old collection without a site takes the new Torte too (allowed while the company is not assigned).
    const oldColl = (await createCollection(mixed, { title: 'Alles' })).id;
    await setCollectionProducts(mixed, oldColl, [oldTorte, newTorte]);
    // Memberships of products without a site in the stamped collection (allowed until the assignment), written directly.
    await env.ownerDb
      .insertInto('collection_product')
      .values([
        { tenant_id: MIXED, collection_id: stampedColl, product_id: oldTorte, position: 2 },
        { tenant_id: MIXED, collection_id: stampedColl, product_id: kekse, position: 3 },
      ])
      .execute();

    const report = await assignCatalogueSites({ connectionString: ownerUrl, tenantGroupId: env.tgId, sites: MIXED_SITES, companyId: MIXED, apply: true });
    const m = report.companies.find((c) => c.companyId === MIXED)!;
    // The old Torte stays on x1 (the oldest live site, never sold) and must yield `torte` there to the stamped one; its copy on x2 keeps it.
    expect(await siteOf(oldTorte)).toBe(x1);
    expect(m.handlesRenamed).toEqual([{ table: 'product', id: oldTorte, siteId: x1, from: 'torte', to: 'torte-2' }]);
    expect((await getProduct(mixed, oldTorte)).handle).toBe('torte-2');
    expect((await getProduct(mixed, newTorte)).handle).toBe('torte');
    const torteCopy = m.productCopies.find((c) => c.from === oldTorte)!;
    expect(torteCopy.siteId).toBe(x2);
    expect((await getProduct(mixed, torteCopy.id)).handle).toBe('torte');
    // The stamped collection on x1: the old Torte's row is on x1, so it stays; Kekse is on x2 only, so its membership goes.
    expect(m.stampedCollectionMembers).toEqual({ remapped: 0, dropped: 1 });
    expect((await getCollection(mixed, stampedColl)).products.map((p) => p.id)).toEqual([newTorte, oldTorte]);
    // The old collection goes to x1 with both Tortes, and its copy on x2 holds the old Torte's copy there.
    expect((await getCollection(mixed, oldColl)).products.map((p) => p.id)).toEqual([oldTorte, newTorte]);
    const collCopy = m.collectionCopies.find((c) => c.from === oldColl)!;
    expect(collCopy.siteId).toBe(x2);
    expect((await getCollection(mixed, collCopy.id)).products.map((p) => p.id)).toEqual([torteCopy.id]);
    // Each shop lists its own products, with distinct handles on x1.
    expect(await shop(MIXED, x1)).toEqual(['torte', 'torte-2']);
    expect(await shop(MIXED, x2)).toEqual(['kekse', 'torte']);
  });
});

function report2Collections(rows: Array<{ title: string; site_id: string | null }>): Map<string, Array<string | null>> {
  const out = new Map<string, Array<string | null>>();
  for (const r of rows) out.set(r.title, [...(out.get(r.title) ?? []), r.site_id]);
  for (const [k, v] of out) out.set(k, v.sort((a, b) => (a ?? '').localeCompare(b ?? '')));
  return out;
}
