// src/server/catalog/__tests__/testShop.itest.ts
//
// The test shop's catalogue against real Postgres: everything the design's acceptance criteria name (rings
// with size and metal options, necklaces, earrings, one archived product, two collections), published so a
// site shows it, the archived one never; a second run changes nothing. All data is synthetic.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { catalogScope } from '../scope';
import { seedTestShop, TEST_SHOP_PRODUCTS } from '../testShop';
import { listStorefrontProducts } from '@/server/commerce/repository/storefront';
import { openBooksEnv, type BooksEnv } from '@/server/books/__tests__/booksFixtures';

let env: BooksEnv;

beforeAll(async () => {
  env = await openBooksEnv('test-shop');
}, 120_000);

afterAll(async () => {
  await env?.close();
});

describe('seedTestShop', () => {
  it('seeds the acceptance criteria once, and a second run changes nothing', async () => {
    const company = randomUUID();
    const scope = catalogScope(env.appDb, env.tgId, company);
    expect(await seedTestShop(scope)).toEqual({ productsCreated: TEST_SHOP_PRODUCTS.length, productsKept: 0, collectionsCreated: 2 });

    const products = await env.ownerDb
      .selectFrom('product')
      .select(['handle', 'status', 'archived_at', 'kind', 'price_basis'])
      .where('tenant_id', '=', company)
      .orderBy('handle')
      .execute();
    expect(products).toHaveLength(TEST_SHOP_PRODUCTS.length);
    expect(products.filter((p) => p.archived_at !== null).map((p) => p.handle)).toEqual(['brosche-vintage']);
    expect(products.every((p) => p.price_basis === 'gross')).toBe(true);

    // The stacking ring has size times metal variants with their gold prices.
    const variants = await env.ownerDb
      .selectFrom('product_variant')
      .innerJoin('product', 'product.id', 'product_variant.product_id')
      .select(['product_variant.title as title'])
      .where('product.tenant_id', '=', company)
      .where('product.handle', '=', 'stapelring')
      .where('product_variant.deleted_at', 'is', null)
      .execute();
    expect(variants).toHaveLength(8);

    // A site of the company shows the published products, never the archived one.
    const page = await listStorefrontProducts(env.appDb, { companyId: company, siteId: 'shop' }, { limit: 50, currency: 'EUR' });
    const shown = page.products.map((p) => p.handle).sort();
    expect(shown).not.toContain('brosche-vintage');
    expect(shown).toContain('stapelring');
    expect(shown).toHaveLength(TEST_SHOP_PRODUCTS.length - 1);

    const collections = await env.ownerDb
      .selectFrom('collection')
      .select(['handle'])
      .where('tenant_id', '=', company)
      .orderBy('handle')
      .execute();
    expect(collections.map((c) => c.handle)).toEqual(['geschenke-unter-100', 'ringe']);

    expect(await seedTestShop(scope)).toEqual({ productsCreated: 0, productsKept: TEST_SHOP_PRODUCTS.length, collectionsCreated: 0 });
  });
});
