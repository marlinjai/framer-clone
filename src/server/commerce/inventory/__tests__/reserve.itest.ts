// src/server/commerce/inventory/__tests__/reserve.itest.ts
//
// Integration test (Dockerized Postgres) for the sequential guards of the reserve
// heart and for the four inventory effects, run against a REAL provisioned
// company schema (tg_<hex32>) through the scoped Kysely handle. It runs on the
// SHARED integration database (vitest.integration.setup.ts) and provisions its
// own tenant group, so it boots no container of its own.
//
// Ported in CM-13 from the retired Prisma suite of the same name, so the money /
// stock coverage did not drop when the Prisma path was deleted:
//
//   1. a SEQUENTIAL duplicate request_id is a no-op (same reservation, one
//      movement, one reservation row, reserved bumped once),
//   2. omitting locationId resolves the per-workspace default (never a NULL
//      location); an unknown explicit location and a missing default both throw,
//   3. an uncontended shortage returns ok:false with available == the GENERATED
//      available_quantity and writes nothing; a kit with one short component
//      writes nothing for ANY component; a non-positive quantity is rejected,
//   4. applyInventoryEffect: over-release rejected (level unchanged), two
//      CONCURRENT releases with one request_id apply exactly once, over-fulfill
//      rejected, happy-path fulfill decrements BOTH stocked and reserved, a
//      negative adjust that would strand reservations is rejected, a zero delta
//      is rejected, a replayed request_id is a no-op, a managed reserve effect
//      that is short raises InventoryShortageError, and the stocked >= 0 /
//      reserved >= 0 floor CHECKs are the database backstop.
//
// Covered elsewhere (not repeated here): READ COMMITTED, the last-unit race, the
// concurrent duplicate reserve and the ascending kit lock order
// (reserve.concurrency.itest.ts); the untracked / backorder / managed policy
// branch (reserve.policy.itest.ts); the deferred transfer-balance trigger and the
// floor CHECKs at the DDL level (migrations/tenant/__tests__/provision.itest.ts).
// The old `reserved <= stocked` CHECK is intentionally GONE (migration 006 drops
// it so backorder can exist); for managed stock the guarded WHERE is the sole
// oversell guard, and the race suite pins it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';

import type { CommerceDB } from '../../db-types';
import {
  openStorefrontFixtures,
  provisionCommerceTenant,
  type ProvisionedTenant,
  type StorefrontFixtures,
} from '../../__tests__/storefrontFixtures';
import {
  applyInventoryEffect,
  applyInventoryEffectWithRetry,
  DEFAULT_WORKSPACE_ID,
  InventoryShortageError,
  reserve,
  reserveKit,
  reserveTransaction,
  resolveLocation,
} from '../reserve';

let fx: StorefrontFixtures;
let tenant: ProvisionedTenant;
let db: Kysely<CommerceDB>;
let tgId: string;

beforeAll(async () => {
  fx = openStorefrontFixtures();
  tenant = await provisionCommerceTenant(fx, 'cm13-reserve');
  db = tenant.db;
  tgId = tenant.tgId;
}, 120_000);

afterAll(async () => {
  await fx?.close();
});

/** Seed an item + location + level with the given on-hand stock. */
async function seedLevel(
  stocked: number,
  reserved = 0,
  opts: { itemId?: string } = {},
): Promise<{ itemId: string; locationId: string }> {
  const itemId = opts.itemId ?? randomUUID();
  await db
    .insertInto('inventory_item')
    .values({ id: itemId, sku: `SKU-${randomUUID()}`, updated_at: new Date() })
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
      inventory_item_id: itemId,
      location_id: locationId,
      stocked_quantity: stocked,
      reserved_quantity: reserved,
      updated_at: new Date(),
    })
    .execute();
  return { itemId, locationId };
}

async function readLevel(itemId: string, locationId: string) {
  return db
    .selectFrom('inventory_level')
    .select(['stocked_quantity', 'reserved_quantity', 'available_quantity'])
    .where('inventory_item_id', '=', itemId)
    .where('location_id', '=', locationId)
    .executeTakeFirstOrThrow();
}

async function countMovements(requestId: string): Promise<number> {
  const row = await db
    .selectFrom('stock_movement')
    .select((eb) => eb.fn.countAll().as('c'))
    .where('request_id', '=', requestId)
    .executeTakeFirstOrThrow();
  return Number(row.c);
}

async function countReservations(requestId: string): Promise<number> {
  const row = await db
    .selectFrom('reservation')
    .select((eb) => eb.fn.countAll().as('c'))
    .where('request_id', '=', requestId)
    .executeTakeFirstOrThrow();
  return Number(row.c);
}

describe('reserve: sequential guards (tenant schema, Dockerized Postgres)', () => {
  it('a duplicate request_id is a no-op (idempotent)', async () => {
    const { itemId, locationId } = await seedLevel(10);

    const first = await reserveTransaction(db, (trx) =>
      reserve(trx, tgId, { inventoryItemId: itemId, locationId, needed: 2, requestId: 'idem-1' }),
    );
    const second = await reserveTransaction(db, (trx) =>
      reserve(trx, tgId, { inventoryItemId: itemId, locationId, needed: 2, requestId: 'idem-1' }),
    );

    expect(first.ok).toBe(true);
    expect(second).toEqual(first); // same reservation id, not a second reserve
    expect((await readLevel(itemId, locationId)).reserved_quantity).toBe(2);
    expect(await countMovements('idem-1')).toBe(1);
    expect(await countReservations('idem-1')).toBe(1);
  });

  it('omitting locationId resolves the per-workspace default and never creates a NULL-location reservation', async () => {
    const { itemId, locationId } = await seedLevel(5);
    await db
      .insertInto('fulfillment_location_default')
      .values({ workspace_id: DEFAULT_WORKSPACE_ID, location_id: locationId, updated_at: new Date() })
      .execute();

    const result = await reserveTransaction(db, async (trx) => {
      expect(await resolveLocation(trx)).toBe(locationId); // no explicit location
      return reserve(trx, tgId, { inventoryItemId: itemId, needed: 1, requestId: 'default-loc-1' });
    });

    expect(result.ok).toBe(true);
    const reservation = await db
      .selectFrom('reservation')
      .select('location_id')
      .where('request_id', '=', 'default-loc-1')
      .executeTakeFirstOrThrow();
    expect(reservation.location_id).toBe(locationId); // concrete, NOT NULL
  });

  it('resolveLocation throws for an unknown explicit location and for a workspace with no default', async () => {
    await expect(reserveTransaction(db, (trx) => resolveLocation(trx, randomUUID()))).rejects.toThrow(
      /does not exist/,
    );
    await expect(
      reserveTransaction(db, (trx) => resolveLocation(trx, undefined, 'workspace-without-default')),
    ).rejects.toThrow(/no default fulfillment location/);
  });

  it('uncontended shortage: needed > available returns ok:false with the generated-column available, and writes nothing', async () => {
    const { itemId, locationId } = await seedLevel(3, 0);

    const result = await reserveTransaction(db, (trx) =>
      reserve(trx, tgId, { inventoryItemId: itemId, locationId, needed: 5, requestId: 'shortage-1' }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    const level = await readLevel(itemId, locationId);
    expect(level.available_quantity).toBe(3);
    expect(result.shortages).toEqual([
      { inventoryItemId: itemId, locationId, needed: 5, available: level.available_quantity },
    ]);
    expect(level.reserved_quantity).toBe(0);
    expect(await countMovements('shortage-1')).toBe(0);
    expect(await countReservations('shortage-1')).toBe(0);
  });

  it('rejects a non-positive quantity before touching any row', async () => {
    const { itemId, locationId } = await seedLevel(3);
    for (const needed of [0, -1, 1.5]) {
      await expect(
        reserveTransaction(db, (trx) =>
          reserve(trx, tgId, { inventoryItemId: itemId, locationId, needed, requestId: `bad-${needed}` }),
        ),
      ).rejects.toThrow(/must be a positive integer/);
    }
    expect((await readLevel(itemId, locationId)).reserved_quantity).toBe(0);
  });

  it('a kit with ONE short component fails whole: shortages listed, nothing written for any component', async () => {
    const location = await seedLevel(10); // ample component
    const shortItem = randomUUID();
    await db
      .insertInto('inventory_item')
      .values({ id: shortItem, sku: `SKU-${randomUUID()}`, updated_at: new Date() })
      .execute();
    await db
      .insertInto('inventory_level')
      .values({
        id: randomUUID(),
        inventory_item_id: shortItem,
        location_id: location.locationId,
        stocked_quantity: 1,
        reserved_quantity: 0,
        updated_at: new Date(),
      })
      .execute();

    const result = await reserveTransaction(db, (trx) =>
      reserveKit(trx, tgId, {
        components: [
          { inventoryItemId: location.itemId, requiredQuantity: 1 },
          { inventoryItemId: shortItem, requiredQuantity: 1 },
        ],
        multiplier: 2,
        locationId: location.locationId,
        requestId: 'kit-short-1',
      }),
    );

    expect(result).toEqual({
      ok: false,
      shortages: [{ inventoryItemId: shortItem, locationId: location.locationId, needed: 2, available: 1 }],
    });
    expect((await readLevel(location.itemId, location.locationId)).reserved_quantity).toBe(0);
    expect((await readLevel(shortItem, location.locationId)).reserved_quantity).toBe(0);
    const kitMovements = await db
      .selectFrom('stock_movement')
      .select((eb) => eb.fn.countAll().as('c'))
      .where('request_id', 'like', 'kit-short-1:%')
      .executeTakeFirstOrThrow();
    expect(Number(kitMovements.c)).toBe(0);
  });
});

describe('applyInventoryEffect (tenant schema, Dockerized Postgres)', () => {
  it('release: releasing more than reserved is rejected and the level is unchanged', async () => {
    const { itemId, locationId } = await seedLevel(10, 2);

    await expect(
      reserveTransaction(db, (trx) =>
        applyInventoryEffect(trx, tgId, {
          type: 'release',
          inventoryItemId: itemId,
          locationId,
          quantity: 5,
          requestId: 'release-over-1',
        }),
      ),
    ).rejects.toBeInstanceOf(InventoryShortageError);

    const level = await readLevel(itemId, locationId);
    expect(level.stocked_quantity).toBe(10);
    expect(level.reserved_quantity).toBe(2);
    expect(await countMovements('release-over-1')).toBe(0);
  });

  it('release (WithRetry): two CONCURRENT releases with the SAME request_id apply EXACTLY once', async () => {
    const { itemId, locationId } = await seedLevel(10, 5);
    const requestId = 'concurrent-release-1';
    const effect = { type: 'release' as const, inventoryItemId: itemId, locationId, quantity: 2, requestId };

    const results = await Promise.allSettled([
      applyInventoryEffectWithRetry(db, tgId, effect),
      applyInventoryEffectWithRetry(db, tgId, effect),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect((await readLevel(itemId, locationId)).reserved_quantity).toBe(3); // by 2 once, not 4
    expect(await countMovements(requestId)).toBe(1);
  });

  it('fulfill: fulfilling more than reserved is rejected and the level is unchanged', async () => {
    const { itemId, locationId } = await seedLevel(4, 2);

    await expect(
      reserveTransaction(db, (trx) =>
        applyInventoryEffect(trx, tgId, {
          type: 'fulfill',
          inventoryItemId: itemId,
          locationId,
          quantity: 3,
          requestId: 'fulfill-over-1',
        }),
      ),
    ).rejects.toBeInstanceOf(InventoryShortageError);

    const level = await readLevel(itemId, locationId);
    expect(level.stocked_quantity).toBe(4);
    expect(level.reserved_quantity).toBe(2);
    expect(await countMovements('fulfill-over-1')).toBe(0);
  });

  it('fulfill: happy path decrements BOTH stocked and reserved and appends a fulfill movement', async () => {
    const { itemId, locationId } = await seedLevel(10, 6);

    await reserveTransaction(db, (trx) =>
      applyInventoryEffect(trx, tgId, {
        type: 'fulfill',
        inventoryItemId: itemId,
        locationId,
        quantity: 4,
        requestId: 'fulfill-happy-1',
      }),
    );

    const level = await readLevel(itemId, locationId);
    expect(level.stocked_quantity).toBe(6);
    expect(level.reserved_quantity).toBe(2);
    expect(level.available_quantity).toBe(4);
    const movement = await db
      .selectFrom('stock_movement')
      .select(['movement_type', 'quantity'])
      .where('request_id', '=', 'fulfill-happy-1')
      .executeTakeFirstOrThrow();
    expect(movement).toEqual({ movement_type: 'fulfill', quantity: 4 });
  });

  it('a replayed request_id is a no-op for every effect type (the ledger already has it)', async () => {
    const { itemId, locationId } = await seedLevel(10, 6);
    const effect = {
      type: 'fulfill' as const,
      inventoryItemId: itemId,
      locationId,
      quantity: 1,
      requestId: 'fulfill-replay-1',
    };
    await reserveTransaction(db, (trx) => applyInventoryEffect(trx, tgId, effect));
    await reserveTransaction(db, (trx) => applyInventoryEffect(trx, tgId, effect));

    const level = await readLevel(itemId, locationId);
    expect(level.stocked_quantity).toBe(9); // applied once
    expect(level.reserved_quantity).toBe(5);
    expect(await countMovements('fulfill-replay-1')).toBe(1);
  });

  it('adjust: a negative adjust that would strand reservations is rejected, level unchanged', async () => {
    const { itemId, locationId } = await seedLevel(10, 8);

    await expect(
      reserveTransaction(db, (trx) =>
        applyInventoryEffect(trx, tgId, {
          type: 'adjust',
          inventoryItemId: itemId,
          locationId,
          delta: -5,
          requestId: 'adjust-strand-1',
        }),
      ),
    ).rejects.toBeInstanceOf(InventoryShortageError);

    const level = await readLevel(itemId, locationId);
    expect(level.stocked_quantity).toBe(10);
    expect(level.reserved_quantity).toBe(8);
    expect(await countMovements('adjust-strand-1')).toBe(0);
  });

  it('adjust: a zero delta is rejected; a positive delta restocks and appends an adjust movement', async () => {
    const { itemId, locationId } = await seedLevel(2, 0);
    await expect(
      reserveTransaction(db, (trx) =>
        applyInventoryEffect(trx, tgId, {
          type: 'adjust',
          inventoryItemId: itemId,
          locationId,
          delta: 0,
          requestId: 'adjust-zero-1',
        }),
      ),
    ).rejects.toThrow(/non-zero integer/);

    await reserveTransaction(db, (trx) =>
      applyInventoryEffect(trx, tgId, {
        type: 'adjust',
        inventoryItemId: itemId,
        locationId,
        delta: 5,
        requestId: 'adjust-restock-1',
      }),
    );
    expect((await readLevel(itemId, locationId)).stocked_quantity).toBe(7);
    expect(await countMovements('adjust-zero-1')).toBe(0);
    expect(await countMovements('adjust-restock-1')).toBe(1);
  });

  it('a managed reserve effect that is short raises InventoryShortageError and writes nothing', async () => {
    const { itemId, locationId } = await seedLevel(1, 0);

    await expect(
      reserveTransaction(db, (trx) =>
        applyInventoryEffect(trx, tgId, {
          type: 'reserve',
          inventoryItemId: itemId,
          locationId,
          quantity: 2,
          requestId: 'effect-reserve-short-1',
        }),
      ),
    ).rejects.toBeInstanceOf(InventoryShortageError);
    expect((await readLevel(itemId, locationId)).reserved_quantity).toBe(0);
    expect(await countMovements('effect-reserve-short-1')).toBe(0);
  });

  it('adjust below zero: the guarded path refuses, and the floor CHECKs are the database backstop', async () => {
    const { itemId, locationId } = await seedLevel(3, 0);

    await expect(
      reserveTransaction(db, (trx) =>
        applyInventoryEffect(trx, tgId, {
          type: 'adjust',
          inventoryItemId: itemId,
          locationId,
          delta: -5,
          requestId: 'adjust-floor-1',
        }),
      ),
    ).rejects.toBeInstanceOf(InventoryShortageError);

    // A bare UPDATE that bypasses the guard and drives stocked negative is
    // rejected by Postgres directly (the stocked >= 0 floor).
    await expect(
      sql`UPDATE ${sql.id(tenant.schema)}.inventory_level SET stocked_quantity = -1
          WHERE inventory_item_id = ${itemId} AND location_id = ${locationId}`.execute(db),
    ).rejects.toThrow(/inventory_level_stocked_nonneg_check/);
    await expect(
      sql`UPDATE ${sql.id(tenant.schema)}.inventory_level SET reserved_quantity = -1
          WHERE inventory_item_id = ${itemId} AND location_id = ${locationId}`.execute(db),
    ).rejects.toThrow(/inventory_level_reserved_nonneg_check/);

    const level = await readLevel(itemId, locationId);
    expect(level.stocked_quantity).toBe(3);
    expect(level.reserved_quantity).toBe(0);
  });
});
