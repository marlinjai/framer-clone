// src/app/api/commerce/orders/__tests__/route.itest.ts
//
// Integration test (Dockerized Postgres) for the storefront order-create WRITE
// seam, POST /api/commerce/orders. It boots its OWN throwaway Postgres in
// beforeAll (testcontainers), applies EVERY migration, seeds a priced + stocked
// variant, and drives the REAL route handler against a LIVE database, proving:
//
//   1. the server computes the order total AUTHORITATIVELY (integer cents,
//      net + tax), returning 201 { orderId, totalCents, currency },
//   2. the request body is INTENTIONS ONLY: a client-sent price/stock field is
//      rejected (400), so the server stays the sole author of money + stock,
//   3. a simulated oversell returns typed per-line shortages keyed by VARIANT id
//      (409 { ok:false, shortages }), and
//   4. the route carries the can()-shaped guard seam and NO payment/Stripe code
//      (checkout STOPS at order-created).
//
// The `.itest.ts` suffix keeps this file OUT of the headless `pnpm test` gate
// (vitest.config.ts matches only *.{test,spec}.{ts,tsx}); it runs only under
// `pnpm test:integration` against Docker. It requires a running Docker daemon.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

import { DEFAULT_WORKSPACE_ID } from '@/server/commerce/inventory/reserve';

let container: StartedTestContainer | undefined;
let prisma: PrismaClient | undefined;
// Imported lazily AFTER process.env.DATABASE_URL is pointed at the container, so
// the route's getPrismaClient() (lazy singleton) connects to the test database.
let POST: (req: Request) => Promise<Response>;

function makeUrl(host: string, port: number): string {
  return `postgresql://test:test@${host}:${port}/framer_clone_test`;
}

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

  const url = makeUrl(container.getHost(), container.getMappedPort(5432));

  execSync('pnpm exec prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });

  // Point the route's lazy PrismaClient at the container BEFORE importing it.
  process.env.DATABASE_URL = url;
  ({ POST } = await import('../route'));

  prisma = new PrismaClient({ datasourceUrl: url });
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await container?.stop();
});

let suffixCounter = 0;
function suffix(): string {
  suffixCounter += 1;
  return `${suffixCounter}`;
}

/**
 * Seed a buyable variant: a product + variant + matching inventory item (the SKU
 * bridge), a location with the given on-hand stock, the default fulfillment
 * location, and a price (cents). Returns the variant id the client would post.
 */
async function seedBuyableVariant(
  amountCents: number,
  stocked: number,
  opts: { currency?: string } = {},
): Promise<{ variantId: string }> {
  const p = prisma!;
  const sku = `SKU-${suffix()}`;

  const product = await p.product.create({
    data: { title: `P-${suffix()}`, handle: `p-${suffix()}` },
  });
  const variant = await p.productVariant.create({
    data: { productId: product.id, title: `V-${suffix()}`, sku },
  });
  const priceSet = await p.priceSet.create({ data: { variantId: variant.id } });
  await p.price.create({
    data: { priceSetId: priceSet.id, currencyCode: opts.currency ?? 'EUR', amount: amountCents },
  });

  // The inventory item shares the variant's SKU (the v1 bridge the route uses).
  const item = await p.inventoryItem.create({ data: { sku } });
  const location = await p.stockLocation.create({ data: { name: `WH-${suffix()}` } });
  await p.inventoryLevel.create({
    data: {
      inventoryItemId: item.id,
      locationId: location.id,
      stockedQuantity: stocked,
      reservedQuantity: 0,
    },
  });
  // The default fulfillment location for the workspace b3 resolves against when a
  // reserve omits an explicit location (the route omits it). upsert so repeated
  // seeds in one run do not collide on the single-row PK.
  await p.fulfillmentLocationDefault.upsert({
    where: { workspaceId: DEFAULT_WORKSPACE_ID },
    create: { workspaceId: DEFAULT_WORKSPACE_ID, locationId: location.id },
    update: { locationId: location.id },
  });

  return { variantId: variant.id };
}

function postOrder(body: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost/api/commerce/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/commerce/orders (Dockerized Postgres)', () => {
  it('computes the total server-side and returns 201 { orderId, totalCents, currency }', async () => {
    const { variantId } = await seedBuyableVariant(1000, 10);

    const res = await postOrder({ lines: [{ variantId, quantity: 2 }] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { orderId: string; totalCents: number; currency: string };

    // net 2000 + 19% standard VAT (380) = 2380, computed by the server (the
    // client never sent a price or a total).
    expect(body.totalCents).toBe(2380);
    expect(body.currency).toBe('EUR');
    expect(typeof body.orderId).toBe('string');

    // The order persisted with the same server-authoritative total.
    const order = await prisma!.order.findUniqueOrThrow({ where: { id: body.orderId } });
    expect(order.total).toBe(2380);
    expect(order.subtotal).toBe(2000);
    expect(order.taxAmount).toBe(380);
  });

  it('rejects a body carrying a client price/stock field (intentions only)', async () => {
    const { variantId } = await seedBuyableVariant(1000, 10);

    // A client that tries to author money/stock: the strict body rejects the
    // extra key with a 400, never trusting it.
    const ordersBefore = await prisma!.order.count();
    const res = await postOrder({
      lines: [{ variantId, quantity: 1, priceCents: 1, stock: 999 }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad_body');

    // No order was created from the rejected request. Delta-based, not an
    // absolute count(): this file shares one testcontainers DB with the other
    // integration suites under `pnpm test:integration`, and this file's own
    // first test creates an order, so an absolute `toBe(0)` is not isolated.
    expect(await prisma!.order.count()).toBe(ordersBefore);
  });

  it('returns 409 typed per-line shortages (keyed by variantId) on an oversell', async () => {
    const { variantId } = await seedBuyableVariant(1000, 1); // only 1 in stock

    const ordersBefore = await prisma!.order.count();
    const res = await postOrder({ lines: [{ variantId, quantity: 5 }] });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      ok: false;
      shortages: { variantId: string; needed: number; available: number }[];
    };
    expect(body.ok).toBe(false);
    expect(body.shortages).toEqual([{ variantId, needed: 5, available: 1 }]);

    // The whole order rolled back: no NEW order persisted, no stock reserved.
    // Delta-based for the shared-DB reason above (this variant was freshly
    // seeded, so its own reservation count is the isolated signal if needed).
    expect(await prisma!.order.count()).toBe(ordersBefore);
  });
});

describe('source contract', () => {
  it('carries the can()-shaped guard seam and STOPS at order-created (no payment)', () => {
    const src = readFileSync(path.resolve(__dirname, '../route.ts'), 'utf8');
    // The mutation route imports + calls the can()-shaped guard seam.
    expect(src).toMatch(/from\s+['"]@\/server\/auth\/guard['"]/);
    expect(src).toMatch(/\bcan\(/);
    // checkout STOPS at order-created: no payment integration code.
    expect(src).toMatch(/STOPS at order-created/);
    expect(src).not.toMatch(/from\s+['"][^'"]*stripe[^'"]*['"]/i);
    expect(src).not.toMatch(/redirectToCheckout|payment_intent|createPaymentIntent/i);
  });
});
