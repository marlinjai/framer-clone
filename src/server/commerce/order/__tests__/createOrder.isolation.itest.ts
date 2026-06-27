// src/server/commerce/order/__tests__/createOrder.isolation.itest.ts
//
// CM-09 — the isolation crown-jewel for the NEW Kysely cart -> order WRITE
// (`createOrderKysely`), the money/stock-critical EXPAND path. It provisions TWO
// real tenant-group schemas (tg_a, tg_b), seeds priced + managed inventory in
// each, and proves the order WRITE's correctness story against a LIVE database
// (it is Postgres semantics — atomic rollback, the DB accounting CHECK, the
// schema-per-tenant wall — not mockable):
//
//   1. a full order placement on the NEW path reserves stock AND writes the order
//      + line items atomically; the order row lives ONLY in tg_a (a tg_b handle
//      reading the order id returns ZERO — the schema wall holds);
//   2. a shortage on ANY line rolls back the WHOLE order: zero orders, zero
//      reservations, zero movements, and the ample line's stock is untouched;
//   3. a concurrent duplicate order request_id yields exactly ONE order and the
//      loser re-reads the SAME orderId (no second order, no double reservation);
//   4. the persisted order satisfies total = subtotal + tax_amount, and the DB
//      CHECK (order_total_sum_check) rejects a hand-built violating row;
//   5. a BACKORDER line (manage_inventory=true, allow_backorder=true) with
//      INSUFFICIENT stock PLACES the order SUCCESSFULLY: reserveKysely returns ok,
//      available_quantity goes NEGATIVE, NO OrderShortageError, and the order +
//      line + reservation rows are written (a backorder line never rolls back the
//      order).
//
// Exercises the NEW (CM-09 expand) Kysely path; the old Prisma `createOrder` is
// untouched (its coverage stays in createOrder.itest.ts / createOrder.test.ts).
// TRUST auth (no password literals — see CM-04 / reserve.isolation.itest.ts). The
// `.itest.ts` suffix keeps this file OUT of the headless `pnpm test` unit gate
// (vitest.config.ts matches only *.{test,spec}.{ts,tsx}); it runs ONLY under
// `pnpm test:integration` against Docker. Mirrors reserve.isolation.itest.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { createNodeDb } from '@marlinjai/tenant-db/node';
import {
  migratePublic,
  provisionTenant,
  tenantDb,
  tenantSchema,
  assertTenantGroupId,
} from '@marlinjai/tenant-db';
import postgres from 'postgres';

import type { CommerceDB } from '../../db-types';
import { COMMERCE_TENANT_MIGRATIONS } from '../../migrations/tenant/index';
import { createOrderKysely, type Cart } from '../createOrder';

const DB_NAME = 'framer_clone_test';
const APP_ROLE = 'commerce_app';
const TG_A = assertTenantGroupId('018f9c10-0000-7000-8000-0000000009a9');
const TG_B = assertTenantGroupId('018f9c10-0000-7000-8000-0000000009b9');
const SCHEMA_A = tenantSchema(TG_A);
const SCHEMA_B = tenantSchema(TG_B);

let container: StartedTestContainer | undefined;
let owner: postgres.Sql | undefined;
let ownerBase: Kysely<CommerceDB> | undefined;

interface Seed {
  variantId: string;
  inventoryItemId: string;
  locationId: string;
  priceId: string;
}

/**
 * Seed a priced + managed product/variant + inventory in `db`: a base price in
 * `currency`, an inventory_item bridged by sku, a stock_location, and an
 * inventory_level. `allowBackorder` / `manageInventory` drive the reserve policy.
 */
async function seedPriced(
  db: Kysely<CommerceDB>,
  opts: {
    amountCents: number;
    stocked: number;
    currency?: string;
    taxClass?: string | null;
    manageInventory?: boolean;
    allowBackorder?: boolean;
  },
): Promise<Seed> {
  const productId = randomUUID();
  await db
    .insertInto('product')
    .values({
      id: productId,
      title: 'P',
      handle: `h-${randomUUID()}`,
      tax_class: opts.taxClass ?? null,
      updated_at: new Date(),
    })
    .execute();

  const variantId = randomUUID();
  const sku = `SKU-${randomUUID()}`;
  await db
    .insertInto('product_variant')
    .values({
      id: variantId,
      product_id: productId,
      title: 'V',
      sku,
      tax_class: opts.taxClass ?? null,
      manage_inventory: opts.manageInventory ?? true,
      allow_backorder: opts.allowBackorder ?? false,
      updated_at: new Date(),
    })
    .execute();

  const priceSetId = randomUUID();
  await db
    .insertInto('price_set')
    .values({ id: priceSetId, variant_id: variantId, updated_at: new Date() })
    .execute();
  const priceId = randomUUID();
  await db
    .insertInto('price')
    .values({
      id: priceId,
      price_set_id: priceSetId,
      currency_code: opts.currency ?? 'EUR',
      amount: opts.amountCents,
      updated_at: new Date(),
    })
    .execute();

  const inventoryItemId = randomUUID();
  await db
    .insertInto('inventory_item')
    .values({ id: inventoryItemId, sku, updated_at: new Date() })
    .execute();
  const locationId = randomUUID();
  await db
    .insertInto('stock_location')
    .values({ id: locationId, name: `WH-${randomUUID()}`, updated_at: new Date() })
    .execute();
  await db
    .insertInto('inventory_level')
    .values({
      id: randomUUID(),
      inventory_item_id: inventoryItemId,
      location_id: locationId,
      stocked_quantity: opts.stocked,
      reserved_quantity: 0,
      updated_at: new Date(),
    })
    .execute();

  return { variantId, inventoryItemId, locationId, priceId };
}

async function readLevel(
  db: Kysely<CommerceDB>,
  inventoryItemId: string,
  locationId: string,
): Promise<{ reserved: number; available: number }> {
  const row = await db
    .selectFrom('inventory_level')
    .select(['reserved_quantity', 'available_quantity'])
    .where('inventory_item_id', '=', inventoryItemId)
    .where('location_id', '=', locationId)
    .executeTakeFirstOrThrow();
  return { reserved: row.reserved_quantity, available: row.available_quantity };
}

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'postgres',
      POSTGRES_DB: DB_NAME,
      POSTGRES_HOST_AUTH_METHOD: 'trust',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const ownerUrl = `postgresql://postgres@${host}:${port}/${DB_NAME}`;

  owner = postgres(ownerUrl, { max: 1, prepare: false, transform: { undefined: null } });
  await owner.unsafe(`CREATE ROLE ${APP_ROLE} LOGIN`);
  await migratePublic(owner);

  await provisionTenant(owner, {
    tenantGroupId: TG_A,
    slug: 'cm09-iso-a',
    appRole: APP_ROLE,
    tenantMigrations: COMMERCE_TENANT_MIGRATIONS,
  });
  await provisionTenant(owner, {
    tenantGroupId: TG_B,
    slug: 'cm09-iso-b',
    appRole: APP_ROLE,
    tenantMigrations: COMMERCE_TENANT_MIGRATIONS,
  });

  ownerBase = createNodeDb<CommerceDB>({ connectionString: ownerUrl });
}, 180_000);

afterAll(async () => {
  await ownerBase?.destroy();
  await owner?.end();
  await container?.stop();
});

describe('CM-09 createOrderKysely isolation — atomic order WRITE (NEW Kysely path)', () => {
  it('provisioned both tenant schemas', async () => {
    const groups = await owner!`SELECT schema_name FROM public.tenant_groups ORDER BY slug`;
    expect(groups.map((g) => g.schema_name).sort()).toEqual([SCHEMA_A, SCHEMA_B].sort());
  });

  it('places an order atomically in tg_a; the order is invisible to a tg_b handle', async () => {
    const dbA = tenantDb(ownerBase!, TG_A);
    const seed = await seedPriced(dbA, { amountCents: 1000, stocked: 10 });

    const cart: Cart = {
      requestId: `iso-ok-${randomUUID()}`,
      currency: 'EUR',
      taxRegion: 'DE',
      // A wildly wrong client total: it MUST be ignored (server-authoritative).
      clientTotal: 999999,
      lines: [
        { inventoryItemId: seed.inventoryItemId, variantId: seed.variantId, quantity: 2, locationId: seed.locationId },
      ],
    };
    const result = await createOrderKysely(dbA, TG_A, cart);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    // The order + its single line landed, with SERVER-computed integer cents.
    const order = await dbA
      .selectFrom('order')
      .selectAll()
      .where('id', '=', result.orderId)
      .executeTakeFirstOrThrow();
    expect(order.subtotal).toBe(2000); // 1000 * 2
    expect(order.tax_amount).toBe(380); // 19% standard
    expect(order.total).toBe(2380); // NOT the client's 999999
    expect(order.order_number).toMatch(/^ORD-\d{6}$/);

    const lines = await dbA
      .selectFrom('order_line_item')
      .selectAll()
      .where('order_id', '=', result.orderId)
      .execute();
    expect(lines).toHaveLength(1);
    expect(lines[0].unit_price).toBe(1000);

    // The reservation + movement for the single line's per-line request_id exist.
    const reservations = await dbA
      .selectFrom('reservation')
      .selectAll()
      .where('request_id', '=', `${cart.requestId}:0`)
      .execute();
    expect(reservations).toHaveLength(1);
    const level = await readLevel(dbA, seed.inventoryItemId, seed.locationId);
    expect(level.reserved).toBe(2);

    // THE SCHEMA WALL: a tg_b handle reading tg_a's order id returns ZERO rows.
    const dbB = tenantDb(ownerBase!, TG_B);
    const inB = await dbB
      .selectFrom('order')
      .selectAll()
      .where('id', '=', result.orderId)
      .execute();
    expect(inB).toHaveLength(0);
  });

  it('rolls back the ENTIRE order and creates zero reservations when a line short-stocks', async () => {
    const dbA = tenantDb(ownerBase!, TG_A);
    const ample = await seedPriced(dbA, { amountCents: 1000, stocked: 10 });
    const short = await seedPriced(dbA, { amountCents: 2000, stocked: 1 }); // needs 5, has 1

    const requestId = `iso-short-${randomUUID()}`;
    const cart: Cart = {
      requestId,
      currency: 'EUR',
      taxRegion: 'DE',
      lines: [
        { inventoryItemId: ample.inventoryItemId, variantId: ample.variantId, quantity: 3, locationId: ample.locationId },
        { inventoryItemId: short.inventoryItemId, variantId: short.variantId, quantity: 5, locationId: short.locationId },
      ],
    };
    const result = await createOrderKysely(dbA, TG_A, cart);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.shortages).toEqual([
      { inventoryItemId: short.inventoryItemId, locationId: short.locationId, needed: 5, available: 1 },
    ]);

    // The whole order rolled back: no order row for the request_id.
    const orders = await dbA
      .selectFrom('order')
      .selectAll()
      .where('request_id', '=', requestId)
      .execute();
    expect(orders).toHaveLength(0);

    // Zero reservations / movements for EITHER per-line request_id (line 0 too).
    for (const i of [0, 1]) {
      const res = await dbA
        .selectFrom('reservation')
        .selectAll()
        .where('request_id', '=', `${requestId}:${i}`)
        .execute();
      expect(res).toHaveLength(0);
      const mov = await dbA
        .selectFrom('stock_movement')
        .selectAll()
        .where('request_id', '=', `${requestId}:${i}`)
        .execute();
      expect(mov).toHaveLength(0);
    }

    // The ample line's stock is untouched: reserved still 0.
    const level = await readLevel(dbA, ample.inventoryItemId, ample.locationId);
    expect(level.reserved).toBe(0);
  });

  it('concurrent duplicate request_id: one order, the loser re-reads the SAME orderId, no double reservation', async () => {
    const dbA = tenantDb(ownerBase!, TG_A);
    const seed = await seedPriced(dbA, { amountCents: 1000, stocked: 50 }); // ample: isolates the idempotency race

    const requestId = `iso-conc-${randomUUID()}`;
    const cart: Cart = {
      requestId,
      currency: 'EUR',
      taxRegion: 'DE',
      lines: [
        { inventoryItemId: seed.inventoryItemId, variantId: seed.variantId, quantity: 3, locationId: seed.locationId },
      ],
    };

    const [a, b] = await Promise.all([
      createOrderKysely(dbA, TG_A, cart),
      createOrderKysely(dbA, TG_A, cart),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error('unreachable');

    // BOTH resolve to the SAME orderId (no unhandled throw): the loser re-read it.
    expect(a.orderId).toBe(b.orderId);

    // EXACTLY one order row and one reservation/movement for the per-line key.
    const orders = await dbA
      .selectFrom('order')
      .selectAll()
      .where('request_id', '=', requestId)
      .execute();
    expect(orders).toHaveLength(1);
    const res = await dbA
      .selectFrom('reservation')
      .selectAll()
      .where('request_id', '=', `${requestId}:0`)
      .execute();
    expect(res).toHaveLength(1);

    // reserved bumped EXACTLY once (by 3), not twice: no double-decrement.
    const level = await readLevel(dbA, seed.inventoryItemId, seed.locationId);
    expect(level.reserved).toBe(3);
  });

  it('the persisted order satisfies total = subtotal + tax_amount and the DB CHECK rejects a violating row', async () => {
    const dbA = tenantDb(ownerBase!, TG_A);
    // Two lines at different rates so the per-line accumulation is non-trivial.
    const a = await seedPriced(dbA, { amountCents: 1000, stocked: 10 }); // standard 19%
    const b = await seedPriced(dbA, { amountCents: 2000, stocked: 10, taxClass: 'reduced' }); // 7%

    const cart: Cart = {
      requestId: `iso-identity-${randomUUID()}`,
      currency: 'EUR',
      taxRegion: 'DE',
      lines: [
        { inventoryItemId: a.inventoryItemId, variantId: a.variantId, quantity: 2, locationId: a.locationId }, // net 2000, tax 380
        { inventoryItemId: b.inventoryItemId, variantId: b.variantId, quantity: 3, locationId: b.locationId }, // net 6000, tax 420
      ],
    };
    const result = await createOrderKysely(dbA, TG_A, cart);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const order = await dbA
      .selectFrom('order')
      .selectAll()
      .where('id', '=', result.orderId)
      .executeTakeFirstOrThrow();
    // The accounting identity holds on the persisted row.
    expect(order.total).toBe(order.subtotal + order.tax_amount);
    expect(order.subtotal).toBe(8000);
    expect(order.tax_amount).toBe(800);
    expect(order.total).toBe(8800);

    // The DB CHECK (order_total_sum_check) rejects a hand-built violating row:
    // total != subtotal + tax_amount can never be persisted.
    await expect(
      dbA
        .insertInto('order')
        .values({
          id: randomUUID(),
          order_number: `ORD-BAD-${randomUUID()}`,
          request_id: `iso-badcheck-${randomUUID()}`,
          currency_code: 'EUR',
          tax_region: 'DE',
          subtotal: 1000,
          tax_amount: 190,
          total: 9999, // != 1000 + 190
          updated_at: new Date(),
        })
        .execute(),
    ).rejects.toThrow(/order_total_sum_check|violates check constraint/i);
  });

  it('backorder line: an order on a manage_inventory + allow_backorder variant with insufficient stock PLACES successfully (availability goes negative)', async () => {
    const dbA = tenantDb(ownerBase!, TG_A);
    // stocked 2, allow_backorder true: ordering 5 drives available to -3.
    const seed = await seedPriced(dbA, {
      amountCents: 1500,
      stocked: 2,
      manageInventory: true,
      allowBackorder: true,
    });

    const requestId = `iso-backorder-${randomUUID()}`;
    const cart: Cart = {
      requestId,
      currency: 'EUR',
      taxRegion: 'DE',
      lines: [
        { inventoryItemId: seed.inventoryItemId, variantId: seed.variantId, quantity: 5, locationId: seed.locationId },
      ],
    };
    const result = await createOrderKysely(dbA, TG_A, cart);
    // NO OrderShortageError: a backorder line never rolls the order back.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    // The order + line + reservation rows were written.
    const orders = await dbA
      .selectFrom('order')
      .selectAll()
      .where('request_id', '=', requestId)
      .execute();
    expect(orders).toHaveLength(1);
    const lines = await dbA
      .selectFrom('order_line_item')
      .selectAll()
      .where('order_id', '=', orders[0].id)
      .execute();
    expect(lines).toHaveLength(1);
    const res = await dbA
      .selectFrom('reservation')
      .selectAll()
      .where('request_id', '=', `${requestId}:0`)
      .execute();
    expect(res).toHaveLength(1);

    // available_quantity went NEGATIVE (backorder depth): reserved 5 over stocked 2.
    const level = await readLevel(dbA, seed.inventoryItemId, seed.locationId);
    expect(level.reserved).toBe(5);
    expect(level.available).toBe(-3);
  });
});
