// src/server/commerce/repository/__tests__/read.itest.ts
//
// Integration test (Dockerized Postgres) for the READ-ONLY commerce repository
// (`commerceReadRepository`, behind `getCommerceServerRepository`), run against a
// REAL provisioned company schema (tg_<hex32>) through the scoped Kysely handle.
// It runs on the SHARED integration database (vitest.integration.setup.ts) and
// provisions its own tenant group, so it boots no container of its own.
//
// Ported in CM-13 from the retired Prisma unit suite (read.test.ts, which drove
// the Prisma read repo with a fake transaction client). Every behaviour it pinned
// is asserted here against real rows:
//   - listProducts maps rows to ProductDTOs (options, values, variant ids),
//     omits taxClass when null, hides soft-deleted products / options / values /
//     variants, translates filter (ANDed, case-insensitive, LIKE-escaped) / sort /
//     limit, and reports a total that ignores the limit;
//   - getProductByHandle returns the live product, or null;
//   - listVariants maps option coordinates and labels, falls back to the
//     product's taxClass, prefers the variant's own, omits a null sku / barcode,
//     and returns [] for a product without variants;
//   - getPrices maps integer cents, folds the resolved taxClass onto each row,
//     maps the quantity band only when present, and returns [] without prices;
//   - getAvailability (ADVISORY) sums the GENERATED available_quantity across all
//     locations or one, reports zero for a variant without SKU or without a live
//     inventory item, and THROWS for a missing or soft-deleted variant.
//
// The schema wall (tg_a vs tg_b vs a public decoy) is read.isolation.itest.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';

import { ALL_LOCATIONS } from '@/lib/commerce/types';
import type { CommerceDB } from '../../db-types';
import {
  openStorefrontFixtures,
  provisionCommerceTenant,
  type StorefrontFixtures,
} from '../../__tests__/storefrontFixtures';
import { catalogRepository } from '../catalog';
import { pricingRepository } from '../pricing';
import { commerceReadRepository, getCommerceServerRepository } from '../read';

let fx: StorefrontFixtures;
let db: Kysely<CommerceDB>;

/** The seeded "classic tee": 2 sizes, 2 variants, product taxClass standard. */
const tee = {
  productId: '',
  sizeOptionId: '',
  smallId: '',
  mediumId: '',
  variantS: '',
  variantM: '',
};

beforeAll(async () => {
  fx = openStorefrontFixtures();
  db = (await provisionCommerceTenant(fx, 'cm13-read')).db;

  const product = await catalogRepository.createProduct(db, {
    title: 'Classic Tee',
    handle: 'classic-tee',
    description: 'Cotton',
  });
  await db.updateTable('product').set({ tax_class: 'standard' }).where('id', '=', product.id).execute();
  const size = await catalogRepository.addOption(db, { productId: product.id, title: 'Size' });
  const small = await catalogRepository.addOptionValue(db, { optionId: size.id, value: 'Small' });
  const medium = await catalogRepository.addOptionValue(db, { optionId: size.id, value: 'Medium' });
  // A soft-deleted value and option must never surface.
  const gone = await catalogRepository.addOptionValue(db, { optionId: size.id, value: 'Gone' });
  await db.updateTable('product_option_value').set({ deleted_at: new Date() }).where('id', '=', gone.id).execute();
  const ghostOption = await catalogRepository.addOption(db, { productId: product.id, title: 'Ghost' });
  await db.updateTable('product_option').set({ deleted_at: new Date() }).where('id', '=', ghostOption.id).execute();

  const vS = await catalogRepository.addVariant(db, {
    productId: product.id,
    title: 'Small',
    sku: 'TEE-S',
    barcode: '0000000000017',
  });
  await catalogRepository.setVariantOptions(db, vS.id, [{ optionId: size.id, optionValueId: small.id }]);
  const vM = await catalogRepository.addVariant(db, { productId: product.id, title: 'Medium' });
  await catalogRepository.setVariantOptions(db, vM.id, [{ optionId: size.id, optionValueId: medium.id }]);
  await db.updateTable('product_variant').set({ tax_class: 'reduced' }).where('id', '=', vM.id).execute();
  // A soft-deleted variant must not appear in variantIds or listVariants.
  const vGone = await catalogRepository.addVariant(db, { productId: product.id, title: 'Gone', sku: 'TEE-GONE' });
  await db.updateTable('product_variant').set({ deleted_at: new Date() }).where('id', '=', vGone.id).execute();

  Object.assign(tee, {
    productId: product.id,
    sizeOptionId: size.id,
    smallId: small.id,
    mediumId: medium.id,
    variantS: vS.id,
    variantM: vM.id,
  });

  // More products for filter / sort / limit, one soft-deleted, one with a LIKE
  // metacharacter in its title.
  await catalogRepository.createProduct(db, { title: 'Hoodie', handle: 'hoodie' });
  await catalogRepository.createProduct(db, { title: 'Tee Deluxe', handle: 'hidden' });
  await catalogRepository.createProduct(db, { title: '50% Off Tee', handle: 'sale-tee' });
  const deleted = await catalogRepository.createProduct(db, { title: 'Old Tee', handle: 'old-tee' });
  await db.updateTable('product').set({ deleted_at: new Date() }).where('id', '=', deleted.id).execute();
}, 120_000);

afterAll(async () => {
  await fx?.close();
});

async function seedLevel(itemId: string, stocked: number, reserved: number): Promise<string> {
  const locationId = randomUUID();
  await db
    .insertInto('stock_location')
    .values({ id: locationId, name: `WH-${randomUUID()}`, updated_at: new Date() })
    .execute();
  await db
    .insertInto('inventory_level')
    .values({
      id: randomUUID(),
      inventory_item_id: itemId,
      location_id: locationId,
      stocked_quantity: stocked,
      reserved_quantity: reserved,
      updated_at: new Date(),
    })
    .execute();
  return locationId;
}

describe('listProducts', () => {
  it('maps live rows to ProductDTOs (options, live values, live variant ids) and a total', async () => {
    const page = await commerceReadRepository.listProducts(db, {
      filter: [{ field: 'handle', op: 'eq', value: 'classic-tee' }],
    });
    expect(page.total).toBe(1);
    const [product] = page.products;
    expect(product).toMatchObject({
      id: tee.productId,
      handle: 'classic-tee',
      title: 'Classic Tee',
      description: 'Cotton',
      taxClass: 'standard',
    });
    expect(product.options).toHaveLength(1);
    expect(product.options[0].values.map((v) => v.label).sort()).toEqual(['Medium', 'Small']);
    expect([...product.variantIds].sort()).toEqual([tee.variantS, tee.variantM].sort());
  });

  it('omits taxClass from the DTO when the product has none, and hides soft-deleted products', async () => {
    const page = await commerceReadRepository.listProducts(db);
    const hoodie = page.products.find((p) => p.handle === 'hoodie');
    expect(hoodie).toBeDefined();
    expect('taxClass' in hoodie!).toBe(false);
    expect(page.products.some((p) => p.handle === 'old-tee')).toBe(false);
    expect(page.total).toBe(4);
  });

  it('translates filter (ANDed, case-insensitive) + sort + limit; total ignores the limit', async () => {
    const page = await commerceReadRepository.listProducts(db, {
      filter: [
        { field: 'title', op: 'contains', value: 'TEE' },
        { field: 'handle', op: 'ne', value: 'HIDDEN' },
      ],
      sort: [{ field: 'title', direction: 'desc' }],
      limit: 1,
    });
    // Live titles containing "tee", excluding handle "hidden": Classic Tee, 50% Off Tee.
    expect(page.total).toBe(2);
    expect(page.products.map((p) => p.title)).toEqual(['Classic Tee']);
  });

  it('matches a filter value literally (LIKE metacharacters are escaped)', async () => {
    const page = await commerceReadRepository.listProducts(db, {
      filter: [{ field: 'title', op: 'contains', value: '50%' }],
    });
    expect(page.products.map((p) => p.handle)).toEqual(['sale-tee']);
    const none = await commerceReadRepository.listProducts(db, {
      filter: [{ field: 'title', op: 'contains', value: '_' }],
    });
    expect(none.total).toBe(0);
  });

  it('a negative limit floors at 0 while the total still counts every match', async () => {
    const page = await commerceReadRepository.listProducts(db, { limit: -5 });
    expect(page.products).toEqual([]);
    expect(page.total).toBe(4);
  });
});

describe('getProductByHandle', () => {
  it('returns the mapped ProductDTO for a live handle, and null otherwise (soft-deleted included)', async () => {
    expect((await commerceReadRepository.getProductByHandle(db, 'classic-tee'))?.id).toBe(tee.productId);
    expect(await commerceReadRepository.getProductByHandle(db, 'nope')).toBeNull();
    expect(await commerceReadRepository.getProductByHandle(db, 'old-tee')).toBeNull();
  });
});

describe('listVariants', () => {
  it('maps live variants with option coordinates and labels, and the taxClass fallback / preference', async () => {
    const variants = await commerceReadRepository.listVariants(db, tee.productId);
    expect(variants).toHaveLength(2);
    const small = variants.find((v) => v.id === tee.variantS)!;
    const medium = variants.find((v) => v.id === tee.variantM)!;

    expect(small).toMatchObject({ sku: 'TEE-S', barcode: '0000000000017', taxClass: 'standard' });
    expect(small.optionValues).toEqual([{ optionId: tee.sizeOptionId, valueId: tee.smallId, label: 'Small' }]);

    // The variant's own class wins; a null sku / barcode is omitted.
    expect(medium.taxClass).toBe('reduced');
    expect('sku' in medium).toBe(false);
    expect('barcode' in medium).toBe(false);
  });

  it('returns an empty array when the product has no variants', async () => {
    const page = await commerceReadRepository.listProducts(db, {
      filter: [{ field: 'handle', op: 'eq', value: 'hoodie' }],
    });
    expect(await commerceReadRepository.listVariants(db, page.products[0].id)).toEqual([]);
  });
});

describe('getPrices', () => {
  it('maps price rows to PriceDTOs: integer cents, resolved taxClass, band only when present', async () => {
    const priceSet = await pricingRepository.createPriceSet(db, { variantId: tee.variantS });
    await pricingRepository.addPrice(db, { priceSetId: priceSet.id, currency: 'USD', amount: 2700 });
    await pricingRepository.addPrice(db, { priceSetId: priceSet.id, currency: 'USD', amount: 2400, minQuantity: 10 });

    const prices = await commerceReadRepository.getPrices(db, tee.variantS);
    expect(prices).toHaveLength(2);
    const base = prices.find((p) => p.amountCents === 2700)!;
    const banded = prices.find((p) => p.amountCents === 2400)!;
    expect(base).toEqual({ variantId: tee.variantS, amountCents: 2700, currency: 'USD', taxClass: 'standard' });
    expect(banded.minQuantity).toBe(10);
    expect('maxQuantity' in banded).toBe(false);
  });

  it('returns an empty array when the variant has no prices or does not exist', async () => {
    expect(await commerceReadRepository.getPrices(db, tee.variantM)).toEqual([]);
    expect(await commerceReadRepository.getPrices(db, randomUUID())).toEqual([]);
  });
});

describe('getAvailability (ADVISORY, never permission to sell)', () => {
  it('sums available (stocked - reserved) across ALL locations, or reports one location', async () => {
    const itemId = randomUUID();
    await db.insertInto('inventory_item').values({ id: itemId, sku: 'TEE-S', updated_at: new Date() }).execute();
    const main = await seedLevel(itemId, 12, 2); // 10
    await seedLevel(itemId, 30, 0); // 30

    expect(await commerceReadRepository.getAvailability(db, tee.variantS)).toEqual({
      variantId: tee.variantS,
      locationId: ALL_LOCATIONS,
      availableQuantity: 40,
      stale: false,
    });
    expect(await commerceReadRepository.getAvailability(db, tee.variantS, main)).toEqual({
      variantId: tee.variantS,
      locationId: main,
      availableQuantity: 10,
      stale: false,
    });
    // A location with no level row for this item legitimately sums to zero.
    const empty = await commerceReadRepository.getAvailability(db, tee.variantS, randomUUID());
    expect(empty.availableQuantity).toBe(0);
  });

  it('reports zero (not an error) for a variant without SKU', async () => {
    const availability = await commerceReadRepository.getAvailability(db, tee.variantM);
    expect(availability).toEqual({
      variantId: tee.variantM,
      locationId: ALL_LOCATIONS,
      availableQuantity: 0,
      stale: false,
    });
  });

  it('reports zero when the SKU has no LIVE inventory_item', async () => {
    const product = await catalogRepository.createProduct(db, { title: 'Cap', handle: 'cap-avail' });
    const variant = await catalogRepository.addVariant(db, { productId: product.id, sku: 'CAP-1' });
    const itemId = randomUUID();
    await db
      .insertInto('inventory_item')
      .values({ id: itemId, sku: 'CAP-1', deleted_at: new Date(), updated_at: new Date() })
      .execute();
    await seedLevel(itemId, 5, 0);
    expect((await commerceReadRepository.getAvailability(db, variant.id)).availableQuantity).toBe(0);
  });

  it('throws for a missing variant and for a soft-deleted one', async () => {
    const ghost = randomUUID();
    await expect(commerceReadRepository.getAvailability(db, ghost)).rejects.toThrow(
      `no variant with id "${ghost}"`,
    );
    const gone = await db
      .selectFrom('product_variant')
      .select('id')
      .where('sku', '=', 'TEE-GONE')
      .executeTakeFirstOrThrow();
    await expect(commerceReadRepository.getAvailability(db, gone.id)).rejects.toThrow(/no variant with id/);
  });
});

describe('getCommerceServerRepository', () => {
  it('delegates every CommerceServerRepository method to the scoped read repository', async () => {
    const repo = getCommerceServerRepository(db);
    expect((await repo.getProductByHandle('classic-tee'))?.id).toBe(tee.productId);
    expect((await repo.listProducts({ filter: [{ field: 'handle', op: 'eq', value: 'hoodie' }] })).total).toBe(1);
    expect(await repo.listVariants(tee.productId)).toHaveLength(2);
    expect(await repo.getPrices(tee.variantM)).toEqual([]);
    expect((await repo.getAvailability(tee.variantM)).availableQuantity).toBe(0);
  });
});
