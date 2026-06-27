// src/server/commerce/inventory/__tests__/reserve.concurrency.itest.ts
//
// CM-08 — the concurrency crown-jewel for the NEW Kysely reserve heart. Proves
// the guarded-decrement guarantees against a REAL provisioned tenant schema,
// because the correctness story is Postgres semantics, not mockable:
//
//   1. READ COMMITTED is the isolation the reserve transaction opens at (the
//      guarded-decrement proof relies on it; REPEATABLE READ/SERIALIZABLE would
//      raise 40001 instead of cleanly matching zero rows).
//   2. two concurrent reservers of the last MANAGED unit: exactly one { ok:true },
//      the other { ok:false, shortages } — a matched-ZERO-rows result (numAffected
//      Rows === 0n, a BIGINT), NOT a thrown 40001. The single most error-prone
//      line is this bigint comparison: a `number` comparison would silently never
//      match and turn every reserve into a false success (oversell).
//   3. two CONCURRENT reservers with the SAME request_id (ample stock): the
//      loser's tx rolls back (no double-decrement), the *WithRetryKysely entrypoint
//      re-reads the winner and returns the SAME reservation id.
//   4. two overlapping kits supplied in OPPOSITE component order acquire their
//      locks ASCENDING and do not deadlock; both commit.
//
// Exercises the NEW (CM-08 expand) Kysely path; the old Prisma path is untouched
// (reserve.itest.ts). TRUST auth (no password literals). The `.itest.ts` suffix
// keeps this file OUT of the headless `pnpm test` unit gate; it runs ONLY under
// `pnpm test:integration` against Docker. Requires a running Docker daemon.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { randomUUID } from 'node:crypto';
import { sql, Kysely } from 'kysely';
import { createNodeDb } from '@marlinjai/tenant-db/node';
import {
  migratePublic,
  provisionTenant,
  tenantDb,
  assertTenantGroupId,
} from '@marlinjai/tenant-db';
import postgres from 'postgres';

import type { CommerceDB } from '../../db-types';
import { COMMERCE_TENANT_MIGRATIONS } from '../../migrations/tenant/index';
import {
  reserveKitWithRetryKysely,
  reserveTransactionKysely,
  reserveWithRetryKysely,
} from '../reserve';

const DB_NAME = 'framer_clone_test';
const TG = assertTenantGroupId('018f9c10-0000-7000-8000-0000000008cc');

let container: StartedTestContainer | undefined;
let owner: postgres.Sql | undefined;
let ownerBase: Kysely<CommerceDB> | undefined;

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
  await migratePublic(owner);
  await provisionTenant(owner, {
    tenantGroupId: TG,
    slug: 'cm08-concurrency',
    tenantMigrations: COMMERCE_TENANT_MIGRATIONS,
  });

  ownerBase = createNodeDb<CommerceDB>({ connectionString: ownerUrl });
}, 180_000);

afterAll(async () => {
  await ownerBase?.destroy();
  await owner?.end();
  await container?.stop();
});

/** Seed a managed product+variant + inventory_item + location + level. */
async function seedManaged(
  db: Kysely<CommerceDB>,
  stocked: number,
): Promise<{ variantId: string; inventoryItemId: string; locationId: string }> {
  const productId = randomUUID();
  await db
    .insertInto('product')
    .values({ id: productId, title: 'P', handle: `h-${randomUUID()}`, updated_at: new Date() })
    .execute();
  const variantId = randomUUID();
  const sku = `SKU-${randomUUID()}`;
  await db
    .insertInto('product_variant')
    .values({
      id: variantId,
      product_id: productId,
      sku,
      updated_at: new Date(),
      manage_inventory: true,
      allow_backorder: false,
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
      stocked_quantity: stocked,
      reserved_quantity: 0,
      updated_at: new Date(),
    })
    .execute();
  return { variantId, inventoryItemId, locationId };
}

/** Seed one managed item+level sharing a single location (for the kit race). */
async function seedManagedItemAt(
  db: Kysely<CommerceDB>,
  locationId: string,
  stocked: number,
): Promise<{ variantId: string; inventoryItemId: string }> {
  const productId = randomUUID();
  await db
    .insertInto('product')
    .values({ id: productId, title: 'P', handle: `h-${randomUUID()}`, updated_at: new Date() })
    .execute();
  const variantId = randomUUID();
  const sku = `SKU-${randomUUID()}`;
  await db
    .insertInto('product_variant')
    .values({
      id: variantId,
      product_id: productId,
      sku,
      updated_at: new Date(),
      manage_inventory: true,
      allow_backorder: false,
    })
    .execute();
  const inventoryItemId = randomUUID();
  await db
    .insertInto('inventory_item')
    .values({ id: inventoryItemId, sku, updated_at: new Date() })
    .execute();
  await db
    .insertInto('inventory_level')
    .values({
      id: randomUUID(),
      inventory_item_id: inventoryItemId,
      location_id: locationId,
      stocked_quantity: stocked,
      reserved_quantity: 0,
      updated_at: new Date(),
    })
    .execute();
  return { variantId, inventoryItemId };
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

async function countRows(
  db: Kysely<CommerceDB>,
  table: 'stock_movement' | 'reservation',
  requestId: string,
): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll().as('c'))
    .where('request_id', '=', requestId)
    .executeTakeFirstOrThrow();
  return Number(row.c);
}

describe('CM-08 reserve concurrency (NEW Kysely path, Dockerized Postgres)', () => {
  it('opens the reserve transaction at READ COMMITTED', async () => {
    const db = tenantDb(ownerBase!, TG);
    const isolation = await reserveTransactionKysely(db, async (trx) => {
      const result = await sql<{ transaction_isolation: string }>`SHOW transaction_isolation`.execute(
        trx,
      );
      return result.rows[0]!.transaction_isolation;
    });
    expect(isolation).toBe('read committed');
  });

  it('two concurrent reservers of the last MANAGED unit: exactly one ok:true, one ok:false (matched-zero, NOT a thrown 40001)', async () => {
    const db = tenantDb(ownerBase!, TG);
    const { variantId, inventoryItemId, locationId } = await seedManaged(db, 1);

    const [a, b] = await Promise.all([
      reserveWithRetryKysely(db, TG, {
        inventoryItemId,
        variantId,
        locationId,
        needed: 1,
        requestId: `race-a-${randomUUID()}`,
      }),
      reserveWithRetryKysely(db, TG, {
        inventoryItemId,
        variantId,
        locationId,
        needed: 1,
        requestId: `race-b-${randomUUID()}`,
      }),
    ]);

    const oks = [a, b].filter((r) => r.ok);
    const fails = [a, b].filter((r) => !r.ok);
    expect(oks).toHaveLength(1);
    expect(fails).toHaveLength(1);
    const failure = fails[0]!;
    if (failure.ok) throw new Error('unreachable');
    expect(failure.shortages).toEqual([
      { inventoryItemId, locationId, needed: 1, available: 0 },
    ]);

    // The winner reserved exactly the one unit; available is now exactly 0.
    const after = await readLevel(db, inventoryItemId, locationId);
    expect(after.reserved).toBe(1);
    expect(after.available).toBe(0);
  });

  it('two CONCURRENT reservers with the SAME request_id: both ok:true, same reservationId, single decrement', async () => {
    const db = tenantDb(ownerBase!, TG);
    const { variantId, inventoryItemId, locationId } = await seedManaged(db, 50);
    const requestId = `concurrent-dup-${randomUUID()}`;

    const [a, b] = await Promise.all([
      reserveWithRetryKysely(db, TG, {
        inventoryItemId,
        variantId,
        locationId,
        needed: 3,
        requestId,
      }),
      reserveWithRetryKysely(db, TG, {
        inventoryItemId,
        variantId,
        locationId,
        needed: 3,
        requestId,
      }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error('unreachable');
    expect(a.reservationId).toBe(b.reservationId);

    // Exactly ONE movement + ONE reservation; reserved bumped EXACTLY once (by 3).
    expect(await countRows(db, 'stock_movement', requestId)).toBe(1);
    expect(await countRows(db, 'reservation', requestId)).toBe(1);
    const after = await readLevel(db, inventoryItemId, locationId);
    expect(after.reserved).toBe(3);
    expect(after.available).toBe(47);
  });

  it('two overlapping kits in OPPOSITE component order acquire locks ascending and do not deadlock', async () => {
    const db = tenantDb(ownerBase!, TG);
    // One shared location, two ample-stock items with deterministic ascending ids.
    const locationId = randomUUID();
    await db
      .insertInto('stock_location')
      .values({ id: locationId, name: `kit-WH-${randomUUID()}`, updated_at: new Date() })
      .execute();
    const a = await seedManagedItemAt(db, locationId, 100);
    const b = await seedManagedItemAt(db, locationId, 100);
    const [lo, hi] =
      a.inventoryItemId < b.inventoryItemId
        ? [a.inventoryItemId, b.inventoryItemId]
        : [b.inventoryItemId, a.inventoryItemId];
    const variantByItem = new Map<string, string>([
      [a.inventoryItemId, a.variantId],
      [b.inventoryItemId, b.variantId],
    ]);

    // Two concurrent kits each need BOTH items, supplied in OPPOSITE input order.
    const [k1, k2] = await Promise.all([
      reserveKitWithRetryKysely(db, TG, {
        components: [
          { inventoryItemId: hi, variantId: variantByItem.get(hi)!, requiredQuantity: 1 },
          { inventoryItemId: lo, variantId: variantByItem.get(lo)!, requiredQuantity: 1 },
        ],
        locationId,
        requestId: `kit-race-1-${randomUUID()}`,
      }),
      reserveKitWithRetryKysely(db, TG, {
        components: [
          { inventoryItemId: lo, variantId: variantByItem.get(lo)!, requiredQuantity: 1 },
          { inventoryItemId: hi, variantId: variantByItem.get(hi)!, requiredQuantity: 1 },
        ],
        locationId,
        requestId: `kit-race-2-${randomUUID()}`,
      }),
    ]);

    expect(k1.ok).toBe(true);
    expect(k2.ok).toBe(true);
    // Both kits reserved one of each item: reserved_quantity == 2 per item.
    expect((await readLevel(db, lo, locationId)).reserved).toBe(2);
    expect((await readLevel(db, hi, locationId)).reserved).toBe(2);
  });
});
