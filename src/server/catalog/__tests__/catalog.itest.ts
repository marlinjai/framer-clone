// src/server/catalog/__tests__/catalog.itest.ts
//
// The catalogue repository (src/server/catalog/repository) against a real
// provisioned tenant schema, connected as the low-privilege commerce_app role
// (booksFixtures.openBooksEnv). Proven here, the four stateful-flow paths and
// the company wall:
//
//   1. forward: a product, its options, the generated matrix, a price and a
//      stock per variant, what the table lists for it;
//   2. backtrack and revise: renaming a value keeps every variant (id, price,
//      stock); removing a value removes its variants only; adding an option
//      keeps the variants (with the option's first value); removing an option
//      collapses; a fourth option is refused; the kind cannot change under
//      options;
//   3. resume: a fresh read shows what was stored;
//   4. re-entry: archive and unarchive, a refused save changes nothing;
//   plus company isolation (another company's ids read as NOT_FOUND and never
//   list), search, filters, sort and paging, images, collections, sites,
//   the sample products and the empty state.
// All data is synthetic.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newTenantId, openBooksEnv, type BooksEnv } from '@/server/books/__tests__/booksFixtures';

import { isCatalogError, type CatalogErrorCode } from '../errors';
import { addSampleProducts } from '../repository/samples';
import { addProductImage, readImage, removeProductImage, reorderProductImages } from '../repository/images';
import {
  createCollection,
  getCollection,
  listCollections,
  setCollectionProducts,
  setProductCollections,
  updateCollection,
} from '../repository/collections';
import { bulkProducts, createProduct, getProduct, listProducts, setArchived, setSinglePrice, updateProduct } from '../repository/products';
import { setHiddenSites } from '../repository/sites';
import { setVariantStock } from '../repository/stock';
import { setOptions, updateVariant } from '../repository/variants';
import { catalogScope, type CatalogScope } from '../scope';
import { png } from './imageFixtures';

let env: BooksEnv;

beforeAll(async () => {
  env = await openBooksEnv('catalog-repo');
}, 120_000);

afterAll(async () => {
  await env?.close();
});

function company(): CatalogScope {
  return catalogScope(env.appDb, env.tgId, newTenantId());
}

async function code(p: Promise<unknown>): Promise<CatalogErrorCode | 'ok'> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    if (isCatalogError(err)) return err.code;
    throw err;
  }
}

describe('create', () => {
  it('a product gets one tracked variant with a SKU; a service one untracked variant without', async () => {
    const s = company();
    const ring = await createProduct(s, { title: 'Silver Ring', price: 4900 });
    expect(ring).toMatchObject({ kind: 'physical', status: 'draft', handle: 'silver-ring' });
    expect(ring.variants).toHaveLength(1);
    expect(ring.variants[0]).toMatchObject({ price: 4900, manageInventory: true, stock: 0 });
    expect(ring.variants[0].sku).toMatch(/^SILVER-RING-[0-9A-F]{6}$/);

    const service = await createProduct(s, { title: 'Ring sizing', kind: 'service', price: 2500 });
    expect(service.variants).toEqual([expect.objectContaining({ sku: null, manageInventory: false, stock: null, price: 2500 })]);
    expect(await code(setOptions(s, service.id, [{ title: 'Size', values: [{ value: 'S' }] }]))).toBe('SHAPE');

    // A second product of the same title gets a free handle.
    expect((await createProduct(s, { title: 'Silver ring' })).handle).toBe('silver-ring-2');
    expect(await code(createProduct(s, { title: '   ' }))).toBe('INVALID_INPUT');
  });
});

describe('options and variants: forward, backtrack and revise, resume', () => {
  it('generates the matrix and keeps what survives each revision', async () => {
    const s = company();
    const p = await createProduct(s, { title: 'Stacking ring', price: 5000 });
    const defaultVariant = p.variants[0].id;

    // 1. forward: two options make four variants; the default variant becomes the first combination.
    let d = await setOptions(s, p.id, [
      { title: 'Size', values: [{ value: 'S' }, { value: 'M' }] },
      { title: 'Metal', values: [{ value: 'Silver' }, { value: 'Gold' }] },
    ]);
    expect(d.variants.map((v) => v.title)).toEqual(['S / Silver', 'S / Gold', 'M / Silver', 'M / Gold']);
    expect(d.variants[0].id).toBe(defaultVariant);
    expect(d.variants.every((v) => v.price === 5000)).toBe(true);
    const mGold = d.variants.find((v) => v.title === 'M / Gold')!;
    const mSilver = d.variants.find((v) => v.title === 'M / Silver')!;
    d = await updateVariant(s, p.id, mGold.id, { price: 9000, compareAt: 11000 });
    d = await setVariantStock(s, p.id, mGold.id, 3);
    d = await setVariantStock(s, p.id, mSilver.id, 7);
    expect(d.variants.find((v) => v.id === mGold.id)).toMatchObject({ price: 9000, compareAt: 11000, stock: 3 });

    const listed = (await listProducts(s)).items.find((i) => i.id === p.id)!;
    expect(listed).toMatchObject({ variantCount: 4, priceMin: 5000, priceMax: 9000, stock: 10, single: null });

    // 2a. rename a value: same ids, same price and stock.
    const size = d.options[0];
    const metal = d.options[1];
    d = await setOptions(s, p.id, [
      { id: size.id, title: 'Ring size', values: [{ id: size.values[0].id, value: 'S' }, { id: size.values[1].id, value: 'Medium' }] },
      { id: metal.id, title: 'Metal', values: metal.values },
    ]);
    expect(d.variants.find((v) => v.id === mGold.id)).toMatchObject({ title: 'Medium / Gold', price: 9000, stock: 3 });
    expect(d.options[0].title).toBe('Ring size');

    // 2b. remove the value S: its two variants go, the Medium ones stay with their figures.
    d = await setOptions(s, p.id, [
      { id: size.id, title: 'Ring size', values: [{ id: size.values[1].id, value: 'Medium' }] },
      { id: metal.id, title: 'Metal', values: metal.values },
    ]);
    expect(d.variants.map((v) => v.id).sort()).toEqual([mGold.id, mSilver.id].sort());
    expect(d.variants.find((v) => v.id === mSilver.id)?.stock).toBe(7);

    // 2c. add an option: the kept variants take its first value, the new combinations are new variants.
    d = await setOptions(s, p.id, [
      { id: size.id, title: 'Ring size', values: [{ id: size.values[1].id, value: 'Medium' }] },
      { id: metal.id, title: 'Metal', values: metal.values },
      { title: 'Finish', values: [{ value: 'Polished' }, { value: 'Matte' }] },
    ]);
    expect(d.variants).toHaveLength(4);
    expect(d.variants.find((v) => v.id === mGold.id)).toMatchObject({ title: 'Medium / Gold / Polished', price: 9000, stock: 3 });

    // 2d. a fourth option is refused, and nothing changed.
    const before = d;
    expect(
      await code(
        setOptions(s, p.id, [
          ...d.options.map((o) => ({ id: o.id, title: o.title, values: o.values })),
          { title: 'Engraving', values: [{ value: 'None' }] },
        ]),
      ),
    ).toBe('INVALID_INPUT');
    // A product with options cannot become a service.
    expect(await code(updateProduct(s, p.id, { kind: 'service' }))).toBe('KIND_LOCKED');

    // 2e. remove an option: variants that differ only in it collapse to the oldest.
    d = await setOptions(
      s,
      p.id,
      d.options.filter((o) => o.title !== 'Finish').map((o) => ({ id: o.id, title: o.title, values: o.values })),
    );
    expect(d.variants.map((v) => v.id).sort()).toEqual([mGold.id, mSilver.id].sort());

    // 3. resume: a fresh read shows exactly what was stored.
    const fresh = await getProduct(catalogScope(env.appDb, env.tgId, s.tenantId), p.id);
    expect(fresh.variants).toEqual(d.variants);
    expect(fresh.options).toEqual(d.options);
    expect(before.variants).toHaveLength(4);

    // Swapping two value names in one save works (the temporary rename).
    const [silver, gold] = fresh.options[1].values;
    d = await setOptions(s, p.id, [
      { id: fresh.options[0].id, title: 'Ring size', values: fresh.options[0].values },
      { id: fresh.options[1].id, title: 'Metal', values: [{ id: silver.id, value: 'Gold' }, { id: gold.id, value: 'Silver' }] },
    ]);
    expect(d.variants.find((v) => v.id === mGold.id)?.title).toBe('Medium / Silver');
  });

  it('stock needs tracking and a SKU, and never goes below what is reserved', async () => {
    const s = company();
    const p = await createProduct(s, { title: 'Pearl necklace' });
    const v = p.variants[0];
    await updateVariant(s, p.id, v.id, { sku: null });
    expect(await code(setVariantStock(s, p.id, v.id, 4))).toBe('SKU_REQUIRED');
    await updateVariant(s, p.id, v.id, { manageInventory: false, sku: `PEARL-${randomUUID().slice(0, 8)}` });
    expect(await code(setVariantStock(s, p.id, v.id, 4))).toBe('STOCK_NOT_TRACKED');
    await updateVariant(s, p.id, v.id, { manageInventory: true });
    expect((await setVariantStock(s, p.id, v.id, 4)).variants[0].stock).toBe(4);
    expect((await setVariantStock(s, p.id, v.id, 1)).variants[0].stock).toBe(1);
    expect(await code(setVariantStock(s, p.id, v.id, -1))).toBe('INVALID_INPUT');
    const movements = await env.ownerDb.selectFrom('stock_movement').select(['movement_type', 'quantity']).where('ref_id', '=', v.id).execute();
    expect(movements.map((m) => [m.movement_type, m.quantity])).toEqual(
      expect.arrayContaining([
        ['adjust', 4],
        ['adjust', -3],
      ]),
    );
    // A SKU another variant of the tenant group uses is refused.
    const other = await createProduct(s, { title: 'Other' });
    expect(await code(updateVariant(s, other.id, other.variants[0].id, { sku: (await getProduct(s, p.id)).variants[0].sku }))).toBe('DUPLICATE_SKU');
  });
});

describe('re-entry, isolation and the list', () => {
  it('archive and unarchive; a refused save changes nothing', async () => {
    const s = company();
    const a = await createProduct(s, { title: 'Earrings' });
    const b = await createProduct(s, { title: 'Bangle' });
    await setArchived(s, a.id, true);
    expect((await listProducts(s)).items.map((i) => i.id)).toEqual([b.id]);
    expect((await listProducts(s, { status: 'archived' })).items.map((i) => i.id)).toEqual([a.id]);
    expect((await setArchived(s, a.id, true)).status).toBe('archived'); // idempotent
    expect((await setArchived(s, a.id, false)).status).toBe('draft');

    expect(await code(updateProduct(s, a.id, { handle: b.handle, title: 'Changed' }))).toBe('DUPLICATE_HANDLE');
    expect(await getProduct(s, a.id)).toMatchObject({ title: 'Earrings', handle: a.handle });

    await updateProduct(s, a.id, { status: 'published' });
    expect((await listProducts(s, { status: 'published' })).items.map((i) => i.id)).toEqual([a.id]);
    await bulkProducts(s, { action: 'archive', ids: [a.id, b.id] });
    expect((await listProducts(s)).total).toBe(0);
    await bulkProducts(s, { action: 'status', ids: [a.id], status: 'draft' });
    expect((await listProducts(s)).items.map((i) => i.id)).toEqual([a.id]);
  });

  it("another company's ids read as NOT_FOUND and never list", async () => {
    const mine = company();
    const theirs = company();
    const p = await createProduct(theirs, { title: 'Their ring' });
    const c = await createCollection(theirs, { title: 'Theirs' });
    expect(await code(getProduct(mine, p.id))).toBe('NOT_FOUND');
    expect(await code(updateProduct(mine, p.id, { title: 'Mine now' }))).toBe('NOT_FOUND');
    expect(await code(setOptions(mine, p.id, []))).toBe('NOT_FOUND');
    expect(await code(updateVariant(mine, p.id, p.variants[0].id, { price: 1 }))).toBe('NOT_FOUND');
    expect(await code(setVariantStock(mine, p.id, p.variants[0].id, 1))).toBe('NOT_FOUND');
    expect(await code(setArchived(mine, p.id, true))).toBe('NOT_FOUND');
    expect(await code(getCollection(mine, c.id))).toBe('NOT_FOUND');
    const own = await createProduct(mine, { title: 'Mine' });
    expect(await code(bulkProducts(mine, { action: 'archive', ids: [own.id, p.id] }))).toBe('NOT_FOUND');
    expect((await getProduct(mine, own.id)).status).toBe('draft'); // all or nothing
    expect(await code(setProductCollections(mine, own.id, [c.id]))).toBe('NOT_FOUND');
    expect((await listProducts(mine)).items.map((i) => i.id)).toEqual([own.id]);
    expect((await getProduct(theirs, p.id)).title).toBe('Their ring');
  });

  it('an empty catalogue lists nothing', async () => {
    expect(await listProducts(company())).toEqual({ items: [], total: 0, nextCursor: null });
  });

  it('searches folded text and SKUs, filters, sorts and pages', async () => {
    const s = company();
    const cheap = await createProduct(s, { title: 'Créole earrings', price: 1500, productType: 'Earrings' });
    const dear = await createProduct(s, { title: 'Gold chain', price: 30000, productType: 'Necklace' });
    const none = await createProduct(s, { title: 'Gift wrap', kind: 'service' });
    await updateProduct(s, dear.id, { description: 'Massive Kette, 18 Karat' });
    await setVariantStock(s, cheap.id, cheap.variants[0].id, 2);

    expect((await listProducts(s, { q: 'CREOLE' })).items.map((i) => i.id)).toEqual([cheap.id]);
    expect((await listProducts(s, { q: 'kette karat' })).items.map((i) => i.id)).toEqual([dear.id]);
    expect((await listProducts(s, { q: dear.variants[0].sku!.slice(0, 10).toLowerCase() })).items.map((i) => i.id)).toEqual([dear.id]);
    expect((await listProducts(s, { q: '100%' })).items).toEqual([]);
    expect((await listProducts(s, { type: 'Necklace' })).items.map((i) => i.id)).toEqual([dear.id]);
    expect((await listProducts(s, { stock: 'in_stock' })).items.map((i) => i.id)).toEqual([cheap.id]);
    expect((await listProducts(s, { stock: 'out_of_stock' })).items.map((i) => i.id)).toEqual([dear.id]);
    expect((await listProducts(s, { stock: 'untracked' })).items.map((i) => i.id)).toEqual([none.id]);

    const byPrice = await listProducts(s, { sort: 'price', dir: 'asc' });
    expect(byPrice.items.map((i) => i.id)).toEqual([none.id, cheap.id, dear.id]);

    // Paging one at a time by price, descending, reaches every row once.
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listProducts(s, { sort: 'price', dir: 'desc', limit: 1, cursor });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual([dear.id, cheap.id, none.id]);
    // By title, and a cursor of another sort is refused.
    const first = await listProducts(s, { sort: 'title', limit: 2 });
    expect(first.items.map((i) => i.title)).toEqual(['Créole earrings', 'Gift wrap']);
    expect((await listProducts(s, { sort: 'title', limit: 2, cursor: first.nextCursor! })).items.map((i) => i.title)).toEqual(['Gold chain']);
    expect(await code(listProducts(s, { sort: 'price', cursor: first.nextCursor! }))).toBe('INVALID_INPUT');
    // The single variant is what the table edits inline.
    await setSinglePrice(s, cheap.id, 1700);
    expect((await listProducts(s, { q: 'creole' })).items[0].single).toMatchObject({ price: 1700, stock: 2, manageInventory: true });
  });
});

describe('images, collections, sites, samples', () => {
  it('stores an image once per company, orders it, ties it to a variant, removes it', async () => {
    const s = company();
    const p = await createProduct(s, { title: 'Ring' });
    const red = png(4, 3, [200, 0, 0]);
    let d = await addProductImage(s, p.id, red);
    d = await addProductImage(s, p.id, png(2, 2, [0, 0, 200]));
    d = await addProductImage(s, p.id, red); // the same file again is not added twice
    expect(d.images.map((i) => [i.position, i.width, i.height])).toEqual([
      [1, 4, 3],
      [2, 2, 2],
    ]);
    const other = await createProduct(s, { title: 'Other' });
    await addProductImage(s, other.id, red);
    const rows = await env.ownerDb.selectFrom('catalog_image').select('id').where('tenant_id', '=', s.tenantId).execute();
    expect(rows).toHaveLength(2);

    d = await reorderProductImages(s, p.id, [d.images[1].id, d.images[0].id]);
    expect(d.images.map((i) => i.width)).toEqual([2, 4]);
    expect(await code(reorderProductImages(s, p.id, [d.images[0].id]))).toBe('INVALID_INPUT');
    d = await updateVariant(s, p.id, d.variants[0].id, { imageId: d.images[1].id });
    expect(d.variants[0].imageId).toBe(d.images[1].id);
    d = await removeProductImage(s, p.id, d.images[1].id);
    expect(d.variants[0].imageId).toBeNull();
    expect(d.images.map((i) => i.position)).toEqual([1]);

    expect((await readImage(s, d.images[0].sha256)).contentType).toBe('image/png');
    expect(await code(readImage(company(), d.images[0].sha256))).toBe('NOT_FOUND');
    expect(await code(addProductImage(s, p.id, new TextEncoder().encode('not an image')))).toBe('UNSUPPORTED_IMAGE_TYPE');
  });

  it('collections keep their order; a product joins and leaves from its panel', async () => {
    const s = company();
    const a = await createProduct(s, { title: 'A' });
    const b = await createProduct(s, { title: 'B' });
    const rings = await createCollection(s, { title: 'Rings' });
    const gifts = await createCollection(s, { title: 'Gifts' });
    expect(await code(createCollection(s, { title: '' }))).toBe('INVALID_INPUT');

    let c = await setCollectionProducts(s, rings.id, [b.id, a.id]);
    expect(c.products.map((p) => p.id)).toEqual([b.id, a.id]);
    await bulkProducts(s, { action: 'addToCollection', ids: [a.id, b.id], collectionId: gifts.id });
    expect((await getCollection(s, gifts.id)).products.map((p) => p.id)).toEqual([a.id, b.id]);

    const d = await setProductCollections(s, a.id, [gifts.id]);
    expect(d.collections.map((x) => x.title)).toEqual(['Gifts']);
    c = await getCollection(s, rings.id);
    expect(c.products.map((p) => p.id)).toEqual([b.id]);
    expect((await listProducts(s, { collection: rings.id })).items.map((i) => i.id)).toEqual([b.id]);

    await updateCollection(s, rings.id, { archived: true, description: 'All our rings' });
    expect((await listCollections(s)).map((x) => x.title)).toEqual(['Gifts']);
    expect((await getCollection(s, rings.id)).description).toBe('All our rings');
    // An archived collection frees its handle.
    expect((await createCollection(s, { title: 'Rings' })).handle).toBe('rings');
    expect(await code(updateCollection(s, rings.id, { archived: false }))).toBe('DUPLICATE_COLLECTION');
  });

  it('hides a product per site of the company only', async () => {
    const s = company();
    const p = await createProduct(s, { title: 'Ring' });
    const sites = new Set(['site-a', 'site-b']);
    expect((await setHiddenSites(s, p.id, ['site-b'], sites)).hiddenSiteIds).toEqual(['site-b']);
    expect((await setHiddenSites(s, p.id, [], sites)).hiddenSiteIds).toEqual([]);
    expect(await code(setHiddenSites(s, p.id, ['site-x'], sites))).toBe('UNKNOWN_SITE');
  });

  it('adds the three sample products once', async () => {
    const s = company();
    const first = await addSampleProducts(s);
    expect(first.map((p) => p.title)).toEqual(['Stacking ring', 'Pearl necklace', 'Ring sizing']);
    expect(first[0].variants).toHaveLength(6);
    expect(first[0].variants.find((v) => v.title === '54 / Silver')).toMatchObject({ price: 4900, stock: 7 });
    expect(first[0].variants.find((v) => v.title === '54 / Gold')).toMatchObject({ price: 8900, stock: 3 });
    const again = await addSampleProducts(s);
    expect(again.map((p) => p.id)).toEqual(first.map((p) => p.id));
    expect((await listProducts(s)).total).toBe(3);
    // Two companies of one organisation both get samples (SKUs never collide).
    expect(await addSampleProducts(company())).toHaveLength(3);
  });
});
