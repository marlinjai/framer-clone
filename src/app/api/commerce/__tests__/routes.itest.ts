// src/app/api/commerce/__tests__/routes.itest.ts
//
// Integration test (Dockerized Postgres) for the b7 commerce REST read routes. It
// boots its OWN throwaway Postgres in beforeAll (testcontainers), applies every
// migration (dt_* init + b2 ledger + b3 guarded reservation + b4 catalog + b5
// pricing + b6 orders), and drives the REAL GET route handlers against a LIVE
// database. It binds the route's Prisma singleton (getPrismaClient, which reads
// DATABASE_URL) to the container by setting DATABASE_URL BEFORE the first call, so
// the same client seeds the catalog/pricing/inventory and serves the routes.
//
// What it proves (the b7 test plan):
//   1. the list route returns the TYPED commerce graph (options + values + variant
//      matrix + resolvedPriceCents), NOT a flat CMS Collection/Row.
//   2. the detail route resolves a product BY HANDLE.
//   3. the inventory route returns available_quantity MATCHING the b2 GENERATED
//      column inventory_level.available_quantity, carrying the advisory-only marker.
//   4. reads are UNAUTHENTICATED (every call below passes no auth header).
//
// The `.itest.ts` suffix keeps this file OUT of the headless `pnpm test` gate
// (vitest.config.ts matches only *.{test,spec}.{ts,tsx}); it runs only under
// `pnpm test:integration` against Docker. It requires a running Docker daemon.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { execSync } from 'node:child_process';
import type { PrismaClient } from '@prisma/client';

import { getPrismaClient } from '@/server/db';
import { withTenant, COMMERCE_SCHEMA } from '@/server/commerce';
import { catalogRepository } from '@/server/commerce/repository/catalog';
import { pricingRepository } from '@/server/commerce/repository/pricing';
import { GET as productsGET } from '../products/route';
import { GET as productGET } from '../products/[handle]/route';
import { GET as inventoryGET } from '../inventory/route';

let container: StartedTestContainer | undefined;
let prisma: PrismaClient | undefined;

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'test',
      POSTGRES_PASSWORD: 'test',
      POSTGRES_DB: 'framer_clone_test',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const url = `postgresql://test:test@${container.getHost()}:${container.getMappedPort(5432)}/framer_clone_test`;

  // Apply every migration to the throwaway DB.
  execSync('pnpm exec prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });

  // Bind the route's lazy Prisma singleton to THIS container: getPrismaClient()
  // (called inside the route handlers) constructs new PrismaClient() reading
  // DATABASE_URL, so setting it BEFORE the first call points both the seed and the
  // routes at the same database.
  process.env.DATABASE_URL = url;
  prisma = getPrismaClient();
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await container?.stop();
});

/** Read the b2 GENERATED available_quantity column directly (absent from the model). */
async function readGeneratedAvailable(itemId: string, locationId: string): Promise<number> {
  const rows = await prisma!.$queryRawUnsafe<Array<{ available_quantity: number }>>(
    `SELECT "available_quantity" FROM "${COMMERCE_SCHEMA}"."inventory_level"
      WHERE "inventory_item_id" = $1 AND "location_id" = $2`,
    itemId,
    locationId,
  );
  return rows[0].available_quantity;
}

describe('b7 commerce REST read routes (Dockerized Postgres)', () => {
  it('the list route returns the typed commerce graph with resolvedPriceCents (NOT a flat CMS Row)', async () => {
    const db = prisma!;
    // Seed a product with one option/value, one variant, and a base price.
    const { variantId } = await withTenant(db, async (tx) => {
      const product = await catalogRepository.createProduct(tx, { title: 'List Tee', handle: 'list-tee' });
      const color = await catalogRepository.addOption(tx, { productId: product.id, title: 'Color' });
      const red = await catalogRepository.addOptionValue(tx, { optionId: color.id, value: 'Red' });
      const variant = await catalogRepository.addVariant(tx, { productId: product.id, sku: 'LIST-TEE-RED' });
      await catalogRepository.setVariantOptions(tx, variant.id, [
        { optionId: color.id, optionValueId: red.id },
      ]);
      const priceSet = await pricingRepository.createPriceSet(tx, { variantId: variant.id });
      await pricingRepository.addPrice(tx, { priceSetId: priceSet.id, currency: 'EUR', amount: 1999 });
      return { variantId: variant.id };
    });

    // UNAUTHENTICATED read: no auth header.
    const res = await productsGET(new Request('http://t/api/commerce/products?limit=100'));
    expect(res.status).toBe(200);
    const body = await res.json();

    const product = body.products.find((p: { handle: string }) => p.handle === 'list-tee');
    expect(product).toBeDefined();
    // Typed graph, not a flat CMS Row: nested options/values + variant matrix + price.
    expect(product).not.toHaveProperty('values');
    expect(product.options[0].values[0].value).toBe('Red');
    const variant = product.variants.find((v: { id: string }) => v.id === variantId);
    expect(variant.resolvedPriceCents).toBe(1999);
    expect(variant.options[0].optionValueId).toBeTruthy();
    // Product-level "from" price equals the single variant's price.
    expect(product.resolvedPriceCents).toBe(1999);
  });

  it('the detail route resolves a product by handle', async () => {
    const db = prisma!;
    await withTenant(db, async (tx) => {
      const product = await catalogRepository.createProduct(tx, { title: 'Detail Cap', handle: 'detail-cap' });
      const variant = await catalogRepository.addVariant(tx, { productId: product.id, sku: 'DETAIL-CAP-1' });
      const priceSet = await pricingRepository.createPriceSet(tx, { variantId: variant.id });
      await pricingRepository.addPrice(tx, { priceSetId: priceSet.id, currency: 'EUR', amount: 2500 });
    });

    const res = await productGET(new Request('http://t/api/commerce/products/detail-cap'), {
      params: Promise.resolve({ handle: 'detail-cap' }),
    });
    expect(res.status).toBe(200);
    const dto = await res.json();
    expect(dto.handle).toBe('detail-cap');
    expect(dto.title).toBe('Detail Cap');
    expect(dto.variants[0].resolvedPriceCents).toBe(2500);

    // A handle with no live product is a real 404 envelope.
    const missing = await productGET(new Request('http://t/api/commerce/products/ghost-handle'), {
      params: Promise.resolve({ handle: 'ghost-handle' }),
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('not_found');
  });

  it('the inventory route returns available_quantity matching the b2 generated column (advisory-only)', async () => {
    const db = prisma!;
    const item = await db.inventoryItem.create({ data: { sku: 'INV-SKU-1' } });
    const location = await db.stockLocation.create({ data: { name: 'INV-WH-1' } });
    await db.inventoryLevel.create({
      data: {
        inventoryItemId: item.id,
        locationId: location.id,
        stockedQuantity: 10,
        reservedQuantity: 3,
      },
    });

    // The DB-computed generated column is the authority we compare against.
    const generated = await readGeneratedAvailable(item.id, location.id);
    expect(generated).toBe(7); // 10 stocked - 3 reserved

    // UNAUTHENTICATED read; variantId is the inventory_item_id at the v1 boundary.
    const res = await inventoryGET(
      new Request(`http://t/api/commerce/inventory?variantId=${item.id}&locationId=${location.id}`),
    );
    expect(res.status).toBe(200);
    const dto = await res.json();
    expect(dto.availableQuantity).toBe(generated);
    expect(dto.variantId).toBe(item.id);
    expect(dto.locationId).toBe(location.id);
    // The advisory-only marker is on the payload (no client may treat it as sale authority).
    expect(dto.advisoryOnly).toBe(true);

    // An (item, location) pair with no level row is a real 404 envelope.
    const missing = await inventoryGET(
      new Request(`http://t/api/commerce/inventory?variantId=${item.id}&locationId=does-not-exist`),
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('not_found');
  });
});
