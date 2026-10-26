// src/app/api/commerce/__tests__/routes.itest.ts
//
// Integration test (Dockerized Postgres) for the b7 commerce REST read routes,
// after CM-10 rewired them onto the per-tenant-group schema. It runs on the
// SHARED integration database (vitest.integration.setup.ts: Prisma public tier,
// the `commerce_app` role, the tenant registry), provisions its OWN tenant group
// `tg_<id>`, seeds a catalog into it, publishes a site stamped with that tenant
// group, and drives the REAL GET route handlers with that site's Host header.
// The routes resolve host -> published site -> tenant group and read through
// `commerceTenantDb(tgId)` as the low-privilege `commerce_app` role, exactly as
// in production. Fixtures: src/server/commerce/__tests__/storefrontFixtures.ts.
//
// What it proves (the b7 test plan, now per tenant):
//   1. the list route returns the TYPED commerce graph (options + values + variant
//      matrix + resolvedPriceCents), NOT a flat CMS Collection/Row, and pages
//      with a cursor.
//   2. the detail route resolves a product BY HANDLE (404 for an unknown one).
//   3. the inventory route returns available_quantity MATCHING the GENERATED
//      column inventory_level.available_quantity, carrying the advisory-only marker.
//   4. reads are UNAUTHENTICATED (no auth header or cookie, only the Host).
//   5. an unpublished host is a 403 on every read route.
// Cross-tenant isolation is proven separately in routes.isolation.itest.ts.
//
// The `.itest.ts` suffix keeps this file OUT of the headless `pnpm test` gate
// (vitest.config.ts matches only *.{test,spec}.{ts,tsx}); it runs only under
// `pnpm test:integration` against Docker. It requires a running Docker daemon.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
  createPublishedSite,
  openStorefrontFixtures,
  provisionCommerceTenant,
  seedBuyableProduct,
  type ProvisionedTenant,
  type StorefrontFixtures,
} from '@/server/commerce/__tests__/storefrontFixtures';
import { GET as productsGET } from '../products/route';
import { GET as productGET } from '../products/[handle]/route';
import { GET as inventoryGET } from '../inventory/route';

let fx: StorefrontFixtures;
let tenant: ProvisionedTenant;
let host = '';

beforeAll(async () => {
  fx = openStorefrontFixtures();
  tenant = await provisionCommerceTenant(fx, 'cm10-routes');
  ({ host } = await createPublishedSite(fx, tenant.tgId, 'cm10-routes'));
}, 120_000);

afterAll(async () => {
  await fx?.close();
});

/** An anonymous storefront request: only a Host header, no auth, no cookie. */
function get(path: string, requestHost = host): Request {
  return new Request(`http://t${path}`, { headers: { host: requestHost } });
}

describe('b7 commerce REST read routes on the tenant schema (Dockerized Postgres)', () => {
  it('the list route returns the typed commerce graph with resolvedPriceCents (NOT a flat CMS Row)', async () => {
    const seeded = await seedBuyableProduct(tenant.db, {
      title: 'List Tee',
      handle: `list-tee-${randomUUID().slice(0, 6)}`,
      amountCents: 1999,
      stocked: 5,
    });

    const res = await productsGET(get('/api/commerce/products?limit=100'));
    expect(res.status).toBe(200);
    const body = await res.json();

    const product = body.products.find((p: { handle: string }) => p.handle === seeded.handle);
    expect(product).toBeDefined();
    // Typed graph, not a flat CMS Row: nested options/values + variant matrix + price.
    expect(product).not.toHaveProperty('values');
    expect(product.options[0].title).toBe('Color');
    expect(product.options[0].values[0].value).toBe('Red');
    const variant = product.variants.find((v: { id: string }) => v.id === seeded.variantId);
    expect(variant.resolvedPriceCents).toBe(1999);
    expect(variant.options[0].optionValueId).toBe(product.options[0].values[0].id);
    // Product-level "from" price equals the single variant's price.
    expect(product.resolvedPriceCents).toBe(1999);
  });

  it('the list route pages by cursor without skipping or repeating a product', async () => {
    for (let i = 0; i < 3; i += 1) {
      await seedBuyableProduct(tenant.db, {
        title: `Page ${i}`,
        handle: `page-${i}-${randomUUID().slice(0, 6)}`,
        amountCents: 100 + i,
        stocked: 1,
      });
    }
    const all = await (await productsGET(get('/api/commerce/products?limit=100'))).json();
    const allIds: string[] = all.products.map((p: { id: string }) => p.id);
    expect(allIds.length).toBeGreaterThanOrEqual(3);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const qs = cursor ? `limit=1&cursor=${cursor}` : 'limit=1';
      const page = await (await productsGET(get(`/api/commerce/products?${qs}`))).json();
      seen.push(...page.products.map((p: { id: string }) => p.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(allIds);
  });

  it('the detail route resolves a product by handle', async () => {
    const seeded = await seedBuyableProduct(tenant.db, {
      title: 'Detail Cap',
      handle: `detail-cap-${randomUUID().slice(0, 6)}`,
      amountCents: 2500,
      stocked: 2,
    });

    const res = await productGET(get(`/api/commerce/products/${seeded.handle}`), {
      params: Promise.resolve({ handle: seeded.handle }),
    });
    expect(res.status).toBe(200);
    const dto = await res.json();
    expect(dto.handle).toBe(seeded.handle);
    expect(dto.title).toBe('Detail Cap');
    expect(dto.variants[0].resolvedPriceCents).toBe(2500);

    // A handle with no live product is a real 404 envelope.
    const missing = await productGET(get('/api/commerce/products/ghost-handle'), {
      params: Promise.resolve({ handle: 'ghost-handle' }),
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('not_found');
  });

  it('the inventory route returns available_quantity matching the generated column (advisory-only)', async () => {
    const seeded = await seedBuyableProduct(tenant.db, {
      title: 'Inv',
      handle: `inv-${randomUUID().slice(0, 6)}`,
      amountCents: 500,
      stocked: 10,
    });
    await tenant.db
      .updateTable('inventory_level')
      .set({ reserved_quantity: 3 })
      .where('inventory_item_id', '=', seeded.inventoryItemId)
      .execute();

    // The DB-computed generated column is the authority we compare against.
    const level = await tenant.db
      .selectFrom('inventory_level')
      .select('available_quantity')
      .where('inventory_item_id', '=', seeded.inventoryItemId)
      .executeTakeFirstOrThrow();
    expect(level.available_quantity).toBe(7); // 10 stocked - 3 reserved

    // UNAUTHENTICATED read of the variant at its location.
    const res = await inventoryGET(
      get(`/api/commerce/inventory?variantId=${seeded.variantId}&locationId=${seeded.locationId}`),
    );
    expect(res.status).toBe(200);
    const dto = await res.json();
    expect(dto.availableQuantity).toBe(level.available_quantity);
    expect(dto.variantId).toBe(seeded.variantId);
    expect(dto.locationId).toBe(seeded.locationId);
    expect(dto.limited).toBe(true);
    expect(dto.advisoryOnly).toBe(true);

    // No location: the sum over every location, what the cart and add to cart ask.
    const all = await (await inventoryGET(get(`/api/commerce/inventory?variantId=${seeded.variantId}`))).json();
    expect(all).toMatchObject({ locationId: 'all', availableQuantity: 7 });

    // A location that holds none of it legitimately reads zero.
    const elsewhere = await inventoryGET(
      get(`/api/commerce/inventory?variantId=${seeded.variantId}&locationId=${randomUUID()}`),
    );
    expect((await elsewhere.json()).availableQuantity).toBe(0);

    // A variant this company does not have is a real 404 envelope; a malformed id a 400.
    const missing = await inventoryGET(get(`/api/commerce/inventory?variantId=${randomUUID()}`));
    expect(missing.status).toBe(404);
    const malformed = await inventoryGET(get('/api/commerce/inventory?variantId=does-not-exist'));
    expect(malformed.status).toBe(400);
    expect((await missing.json()).error.code).toBe('not_found');
  });

  it('an unpublished host is a 403 on every read route', async () => {
    const stranger = 'not-a-store.example.com';
    const list = await productsGET(get('/api/commerce/products', stranger));
    const detail = await productGET(get('/api/commerce/products/x', stranger), {
      params: Promise.resolve({ handle: 'x' }),
    });
    const inventory = await inventoryGET(
      get(`/api/commerce/inventory?variantId=${randomUUID()}&locationId=${randomUUID()}`, stranger),
    );
    for (const res of [list, detail, inventory]) {
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe('forbidden');
    }
  });
});
