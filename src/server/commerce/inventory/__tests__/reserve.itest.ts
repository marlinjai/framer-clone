// src/server/commerce/inventory/__tests__/reserve.itest.ts
//
// Integration test (Dockerized Postgres) for the b3 guarded reservation. It
// boots its OWN throwaway Postgres in beforeAll (testcontainers), applies every
// migration (dt_* init + b2 ledger + b3 guarded reservation), and proves the
// race/guard guarantees plus the isolation-level assertion against a LIVE
// database, because the correctness story is Postgres semantics, not mockable:
//
//   1. two concurrent reserves of the last unit -> exactly one ok:true, one
//      ok:false with shortages (the guarded decrement under READ COMMITTED), and
//      the generated available_quantity column is 0 after the race,
//   2. a forgotten-guard write path is caught by the b2 CHECK backstop,
//   3. a SEQUENTIAL duplicate request_id is a no-op (idempotent),
//   4. omitting locationId resolves the per-workspace default and never creates
//      a NULL-location reservation,
//   5. a kit reservation locks item rows in ASCENDING inventory_item_id order so
//      two concurrent kit reserves are deadlock-free,
//   6. a half-completed transfer fails to commit (the deferred trigger), while a
//      balanced pair commits,
//   7. the reserve transaction runs at READ COMMITTED (asserted live),
//   8. two CONCURRENT reserves with the SAME request_id are idempotent: both
//      return ok:true with the SAME reservationId, exactly one movement + one
//      reservation, reserved bumped exactly once (the P2002 catch on the loser),
//   9. an uncontended shortage returns ok:false with available == the generated
//      column and writes nothing,
//  10. applyInventoryEffect release/fulfill/adjust against real Postgres: over-
//      release rejected (level unchanged), over-fulfill rejected (level
//      unchanged), happy-path fulfill decrements BOTH stocked and reserved, a
//      negative adjust that would strand reservations is rejected (zero rows),
//      and the b2 stocked >= 0 floor CHECK is the database backstop.
//
// The `.itest.ts` suffix keeps this file OUT of the headless `pnpm test` gate
// (vitest.config.ts matches only *.{test,spec}.{ts,tsx}); it runs only under
// `pnpm test:integration` against Docker. It requires a running Docker daemon.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

import {
  applyInventoryEffect,
  applyInventoryEffectWithRetry,
  DEFAULT_WORKSPACE_ID,
  InventoryShortageError,
  reserve,
  reserveKit,
  reserveTransaction,
  reserveWithRetry,
  resolveLocation,
} from '../reserve';

let container: StartedTestContainer | undefined;
let prisma: PrismaClient | undefined;

function makeUrl(user: string, password: string, host: string, port: number): string {
  return `postgresql://${user}:${password}@${host}:${port}/framer_clone_test`;
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

  const url = makeUrl('test', 'test', container.getHost(), container.getMappedPort(5432));

  // Apply dt_* init + the b2 ledger + the b3 guarded-reservation migration.
  execSync('pnpm exec prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });

  prisma = new PrismaClient({ datasourceUrl: url });
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await container?.stop();
});

/** Seed an item + location + level with the given on-hand stock. */
async function seedLevel(
  stocked: number,
  reserved = 0,
  opts: { itemId?: string; sku?: string; locationName?: string } = {},
): Promise<{ itemId: string; locationId: string; levelId: string }> {
  const p = prisma!;
  const item = await p.inventoryItem.create({
    data: { ...(opts.itemId ? { id: opts.itemId } : {}), sku: opts.sku ?? `SKU-${cryptoSuffix()}` },
  });
  const location = await p.stockLocation.create({
    data: { name: opts.locationName ?? `WH-${cryptoSuffix()}` },
  });
  const level = await p.inventoryLevel.create({
    data: {
      inventoryItemId: item.id,
      locationId: location.id,
      stockedQuantity: stocked,
      reservedQuantity: reserved,
    },
  });
  return { itemId: item.id, locationId: location.id, levelId: level.id };
}

let suffixCounter = 0;
function cryptoSuffix(): string {
  suffixCounter += 1;
  return `${suffixCounter}`;
}

/**
 * Read the DB-computed available_quantity GENERATED column for a level. It is
 * deliberately absent from the Prisma model (it is GENERATED ALWAYS STORED), so
 * it can only be read via raw SQL. This is the authoritative available value the
 * guarded WHERE evaluates against, so the race tests assert it directly.
 */
async function readAvailableQuantity(itemId: string, locationId: string): Promise<number> {
  const rows = await prisma!.$queryRawUnsafe<Array<{ available_quantity: number }>>(
    `SELECT "available_quantity"
       FROM "commerce"."inventory_level"
      WHERE "inventory_item_id" = $1 AND "location_id" = $2`,
    itemId,
    locationId,
  );
  return rows[0].available_quantity;
}

describe('b3 guarded reservation (Dockerized Postgres)', () => {
  it('runs the reserve transaction at READ COMMITTED', async () => {
    const isolation = await reserveTransaction(prisma!, async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ transaction_isolation: string }>>(
        'SHOW transaction_isolation',
      );
      return rows[0].transaction_isolation;
    });
    expect(isolation).toBe('read committed');
  });

  it('two concurrent reserves of the last unit: exactly one ok:true, one ok:false with shortages', async () => {
    const { itemId, locationId } = await seedLevel(1);

    // Both reservers race for the single available unit, each in its own real
    // READ COMMITTED transaction. The row write-lock serializes them: the loser
    // re-evaluates WHERE available >= 1 against the winner's committed row,
    // matches zero rows, and returns ok:false (no throw, no oversell).
    const [a, b] = await Promise.all([
      reserveTransaction(prisma!, (tx) =>
        reserve(tx, { inventoryItemId: itemId, locationId, needed: 1, requestId: 'race-a' }),
      ),
      reserveTransaction(prisma!, (tx) =>
        reserve(tx, { inventoryItemId: itemId, locationId, needed: 1, requestId: 'race-b' }),
      ),
    ]);

    const oks = [a, b].filter((r) => r.ok);
    const fails = [a, b].filter((r) => !r.ok);
    expect(oks).toHaveLength(1);
    expect(fails).toHaveLength(1);
    const failure = fails[0];
    if (failure.ok) throw new Error('unreachable');
    expect(failure.shortages).toEqual([
      { inventoryItemId: itemId, locationId, needed: 1, available: 0 },
    ]);

    // The winner reserved exactly the one unit; the ledger has exactly one reserve.
    const level = await prisma!.inventoryLevel.findUniqueOrThrow({
      where: { inventoryItemId_locationId: { inventoryItemId: itemId, locationId } },
    });
    expect(level.reservedQuantity).toBe(1);
    const movements = await prisma!.stockMovement.count({
      where: { inventoryItemId: itemId, movementType: 'reserve' },
    });
    expect(movements).toBe(1);
    // The DB-computed available is now exactly 0 (stocked 1 - reserved 1): the
    // structural source of the loser's zero-row match.
    expect(await readAvailableQuantity(itemId, locationId)).toBe(0);
  });

  it('a forgotten-guard write path is caught by the b2 CHECK backstop', async () => {
    const { itemId, locationId } = await seedLevel(3);

    // Simulate a path that forgot the WHERE available >= needed guard: push
    // reserved past stocked with a bare UPDATE. The reserved <= stocked CHECK
    // rejects it, so oversell is impossible even if the application guard is bypassed.
    await expect(
      prisma!.$executeRawUnsafe(
        `UPDATE "commerce"."inventory_level"
            SET "reserved_quantity" = "stocked_quantity" + 1
          WHERE "inventory_item_id" = $1 AND "location_id" = $2`,
        itemId,
        locationId,
      ),
    ).rejects.toThrow(/inventory_level_reserved_lte_stocked_check/);
  });

  it('a duplicate request_id is a no-op (idempotent)', async () => {
    const { itemId, locationId } = await seedLevel(10);

    const first = await reserveTransaction(prisma!, (tx) =>
      reserve(tx, { inventoryItemId: itemId, locationId, needed: 2, requestId: 'idem-1' }),
    );
    const second = await reserveTransaction(prisma!, (tx) =>
      reserve(tx, { inventoryItemId: itemId, locationId, needed: 2, requestId: 'idem-1' }),
    );

    expect(first.ok).toBe(true);
    expect(second).toEqual(first); // same reservation id returned, not a second reserve

    // Reserved moved by 2 once, not twice; exactly one movement + one reservation.
    const level = await prisma!.inventoryLevel.findUniqueOrThrow({
      where: { inventoryItemId_locationId: { inventoryItemId: itemId, locationId } },
    });
    expect(level.reservedQuantity).toBe(2);
    expect(await prisma!.stockMovement.count({ where: { requestId: 'idem-1' } })).toBe(1);
    expect(await prisma!.reservation.count({ where: { requestId: 'idem-1' } })).toBe(1);
  });

  it('omitting locationId resolves the per-workspace default and never creates a NULL-location reservation', async () => {
    const { itemId, locationId } = await seedLevel(5);
    await prisma!.fulfillmentLocationDefault.create({
      data: { workspaceId: DEFAULT_WORKSPACE_ID, locationId },
    });

    const result = await reserveTransaction(prisma!, async (tx) => {
      const resolved = await resolveLocation(tx); // no explicit location
      expect(resolved).toBe(locationId);
      return reserve(tx, { inventoryItemId: itemId, needed: 1, requestId: 'default-loc-1' });
    });

    expect(result.ok).toBe(true);
    const reservation = await prisma!.reservation.findUniqueOrThrow({
      where: { requestId: 'default-loc-1' },
    });
    expect(reservation.locationId).toBe(locationId); // concrete, NOT NULL
  });

  it('a kit reservation locks item rows in ASCENDING inventory_item_id order (deadlock-free under concurrency)', async () => {
    // Two items with deterministic ascending ids, same location, ample stock.
    const location = await prisma!.stockLocation.create({ data: { name: 'kit-WH' } });
    const itemA = await prisma!.inventoryItem.create({ data: { id: 'kit-item-aaaa', sku: `KIT-A-${cryptoSuffix()}` } });
    const itemB = await prisma!.inventoryItem.create({ data: { id: 'kit-item-bbbb', sku: `KIT-B-${cryptoSuffix()}` } });
    for (const item of [itemA, itemB]) {
      await prisma!.inventoryLevel.create({
        data: { inventoryItemId: item.id, locationId: location.id, stockedQuantity: 100, reservedQuantity: 0 },
      });
    }

    // Two concurrent kits each need BOTH items, supplied in OPPOSITE input order.
    // Unordered locking would let one grab A->B and the other B->A and deadlock;
    // reserveKit sorts ascending, so both lock A then B and serialize cleanly.
    const [k1, k2] = await Promise.all([
      reserveTransaction(prisma!, (tx) =>
        reserveKit(tx, {
          components: [
            { inventoryItemId: itemB.id, requiredQuantity: 1 },
            { inventoryItemId: itemA.id, requiredQuantity: 1 },
          ],
          locationId: location.id,
          requestId: 'kit-race-1',
        }),
      ),
      reserveTransaction(prisma!, (tx) =>
        reserveKit(tx, {
          components: [
            { inventoryItemId: itemA.id, requiredQuantity: 1 },
            { inventoryItemId: itemB.id, requiredQuantity: 1 },
          ],
          locationId: location.id,
          requestId: 'kit-race-2',
        }),
      ),
    ]);

    expect(k1.ok).toBe(true);
    expect(k2.ok).toBe(true);
    // Both kits reserved one of each item: reserved_quantity == 2 per item.
    for (const item of [itemA, itemB]) {
      const level = await prisma!.inventoryLevel.findUniqueOrThrow({
        where: { inventoryItemId_locationId: { inventoryItemId: item.id, locationId: location.id } },
      });
      expect(level.reservedQuantity).toBe(2);
    }
  });

  it('a half-completed transfer fails to commit; a balanced pair commits (deferred trigger)', async () => {
    const item = await prisma!.inventoryItem.create({ data: { sku: `XFER-${cryptoSuffix()}` } });
    const src = await prisma!.stockLocation.create({ data: { name: 'xfer-src' } });
    const dst = await prisma!.stockLocation.create({ data: { name: 'xfer-dst' } });

    // A lone transfer half: at COMMIT the deferred trigger sees one row (sum != 0,
    // count != 2) and aborts. So a half-transfer can never persist.
    await expect(
      prisma!.stockMovement.create({
        data: {
          inventoryItemId: item.id,
          locationId: src.id,
          movementType: 'transfer',
          quantity: -5,
          requestId: `xfer-half-${cryptoSuffix()}`,
          transferGroupId: 'tg-half',
        },
      }),
    ).rejects.toThrow(/unbalanced|check_violation|transfer group/i);

    // The balanced pair (-5 out of src, +5 into dst, same group) commits.
    const groupId = 'tg-whole';
    await prisma!.$transaction(async (tx) => {
      await tx.stockMovement.create({
        data: {
          inventoryItemId: item.id,
          locationId: src.id,
          movementType: 'transfer',
          quantity: -5,
          requestId: `xfer-out-${cryptoSuffix()}`,
          transferGroupId: groupId,
        },
      });
      await tx.stockMovement.create({
        data: {
          inventoryItemId: item.id,
          locationId: dst.id,
          movementType: 'transfer',
          quantity: 5,
          requestId: `xfer-in-${cryptoSuffix()}`,
          transferGroupId: groupId,
        },
      });
    });

    const count = await prisma!.stockMovement.count({ where: { transferGroupId: groupId } });
    expect(count).toBe(2);
  });

  it('two CONCURRENT reserves with the SAME request_id: both ok:true, same reservationId, single decrement (idempotent under the race)', async () => {
    // Ample stock, so this is NOT a shortage race: it isolates the IDEMPOTENCY
    // race. Two reserveWithRetry calls fire the SAME request_id via Promise.all.
    // Both pass the read-then-write pre-check under READ COMMITTED (each sees null),
    // both run the guarded decrement, and the LOSER trips the UNIQUE(request_id) on
    // the winner's commit. The loser's transaction aborts (rolling back its own
    // guarded decrement, so reserved bumps EXACTLY once) and reserveWithRetry
    // re-reads the winner's committed reservation in a FRESH transaction, returning
    // the idempotent { ok:true, reservationId } with the SAME id.
    const { itemId, locationId } = await seedLevel(50);
    const requestId = 'concurrent-dup-1';

    const [a, b] = await Promise.all([
      reserveWithRetry(prisma!, { inventoryItemId: itemId, locationId, needed: 3, requestId }),
      reserveWithRetry(prisma!, { inventoryItemId: itemId, locationId, needed: 3, requestId }),
    ]);

    // BOTH resolve ok:true with the SAME reservationId (no unhandled 500-shaped throw).
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error('unreachable');
    expect(a.reservationId).toBe(b.reservationId);

    // Exactly ONE stock_movement row and ONE reservation row for the request_id.
    expect(await prisma!.stockMovement.count({ where: { requestId } })).toBe(1);
    expect(await prisma!.reservation.count({ where: { requestId } })).toBe(1);

    // reserved bumped EXACTLY once (by 3), not twice: no double-decrement.
    const level = await prisma!.inventoryLevel.findUniqueOrThrow({
      where: { inventoryItemId_locationId: { inventoryItemId: itemId, locationId } },
    });
    expect(level.reservedQuantity).toBe(3);
    expect(await readAvailableQuantity(itemId, locationId)).toBe(47);
  });

  it('uncontended shortage: reserve needed > available returns ok:false with the generated-column available, and writes nothing', async () => {
    // No concurrency: a single reserve for more than is available. The guarded
    // WHERE matches zero rows, so the contract is { ok:false } with the shortage
    // available == the DB-computed available_quantity, and NOTHING is written.
    const { itemId, locationId } = await seedLevel(3, 0);

    const result = await reserveTransaction(prisma!, (tx) =>
      reserve(tx, { inventoryItemId: itemId, locationId, needed: 5, requestId: 'shortage-uncontended-1' }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    const generatedAvailable = await readAvailableQuantity(itemId, locationId);
    expect(generatedAvailable).toBe(3);
    expect(result.shortages).toEqual([
      { inventoryItemId: itemId, locationId, needed: 5, available: generatedAvailable },
    ]);

    // Nothing changed: reserved still 0, no movement, no reservation.
    const level = await prisma!.inventoryLevel.findUniqueOrThrow({
      where: { inventoryItemId_locationId: { inventoryItemId: itemId, locationId } },
    });
    expect(level.reservedQuantity).toBe(0);
    expect(await prisma!.stockMovement.count({ where: { requestId: 'shortage-uncontended-1' } })).toBe(0);
    expect(await prisma!.reservation.count({ where: { requestId: 'shortage-uncontended-1' } })).toBe(0);
  });

  it('applyInventoryEffect(release): releasing more than reserved is rejected and the level is unchanged', async () => {
    const { itemId, locationId } = await seedLevel(10, 2); // reserved 2

    await expect(
      reserveTransaction(prisma!, (tx) =>
        applyInventoryEffect(tx, {
          type: 'release',
          inventoryItemId: itemId,
          locationId,
          quantity: 5, // more than the 2 reserved
          requestId: 'release-over-1',
        }),
      ),
    ).rejects.toBeInstanceOf(InventoryShortageError);

    // The aborted transaction left the level untouched and wrote no movement.
    const level = await prisma!.inventoryLevel.findUniqueOrThrow({
      where: { inventoryItemId_locationId: { inventoryItemId: itemId, locationId } },
    });
    expect(level.stockedQuantity).toBe(10);
    expect(level.reservedQuantity).toBe(2);
    expect(await prisma!.stockMovement.count({ where: { requestId: 'release-over-1' } })).toBe(0);
  });

  it('applyInventoryEffectWithRetry(release): two CONCURRENT releases with the SAME request_id apply EXACTLY once (idempotent under the race)', async () => {
    // seed reserved 5; two concurrent releases of 2 with the SAME request_id. Both
    // pass the pre-check, both run the guarded UPDATE, the loser trips
    // UNIQUE(request_id) and its transaction rolls back (undoing its own decrement).
    // applyInventoryEffectWithRetry absorbs the sentinel as the idempotent no-op,
    // so BOTH calls resolve and reserved drops by EXACTLY 2 (to 3), not 4.
    const { itemId, locationId } = await seedLevel(10, 5);
    const requestId = 'concurrent-release-1';

    const results = await Promise.allSettled([
      applyInventoryEffectWithRetry(prisma!, {
        type: 'release',
        inventoryItemId: itemId,
        locationId,
        quantity: 2,
        requestId,
      }),
      applyInventoryEffectWithRetry(prisma!, {
        type: 'release',
        inventoryItemId: itemId,
        locationId,
        quantity: 2,
        requestId,
      }),
    ]);

    // Neither rejected: the loser recovered as an idempotent no-op.
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const level = await prisma!.inventoryLevel.findUniqueOrThrow({
      where: { inventoryItemId_locationId: { inventoryItemId: itemId, locationId } },
    });
    expect(level.reservedQuantity).toBe(3); // dropped by 2 once, not 4
    expect(await prisma!.stockMovement.count({ where: { requestId } })).toBe(1);
  });

  it('applyInventoryEffect(fulfill): fulfilling more than reserved/stocked is rejected and the level is unchanged', async () => {
    const { itemId, locationId } = await seedLevel(4, 2); // stocked 4, reserved 2

    await expect(
      reserveTransaction(prisma!, (tx) =>
        applyInventoryEffect(tx, {
          type: 'fulfill',
          inventoryItemId: itemId,
          locationId,
          quantity: 3, // more than the 2 reserved
          requestId: 'fulfill-over-1',
        }),
      ),
    ).rejects.toBeInstanceOf(InventoryShortageError);

    const level = await prisma!.inventoryLevel.findUniqueOrThrow({
      where: { inventoryItemId_locationId: { inventoryItemId: itemId, locationId } },
    });
    expect(level.stockedQuantity).toBe(4);
    expect(level.reservedQuantity).toBe(2);
    expect(await prisma!.stockMovement.count({ where: { requestId: 'fulfill-over-1' } })).toBe(0);
  });

  it('applyInventoryEffect(fulfill): happy path decrements BOTH stocked and reserved by qty and appends a fulfill movement', async () => {
    const { itemId, locationId } = await seedLevel(10, 6); // stocked 10, reserved 6

    await reserveTransaction(prisma!, (tx) =>
      applyInventoryEffect(tx, {
        type: 'fulfill',
        inventoryItemId: itemId,
        locationId,
        quantity: 4,
        requestId: 'fulfill-happy-1',
      }),
    );

    // Fulfilling 4 consumes BOTH: stocked 10 -> 6, reserved 6 -> 2.
    const level = await prisma!.inventoryLevel.findUniqueOrThrow({
      where: { inventoryItemId_locationId: { inventoryItemId: itemId, locationId } },
    });
    expect(level.stockedQuantity).toBe(6);
    expect(level.reservedQuantity).toBe(2);
    expect(await readAvailableQuantity(itemId, locationId)).toBe(4);

    const movement = await prisma!.stockMovement.findUniqueOrThrow({
      where: { requestId: 'fulfill-happy-1' },
    });
    expect(movement.movementType).toBe('fulfill');
    expect(movement.quantity).toBe(4);
  });

  it('applyInventoryEffect(adjust): a negative adjust that would strand reservations is rejected (zero rows), level unchanged', async () => {
    const { itemId, locationId } = await seedLevel(10, 8); // reserved 8

    // Removing 5 would drop stocked to 5 < reserved 8: the guard ((stocked+delta)
    // >= reserved) matches zero rows and surfaces as a shortage error, NOT a CHECK
    // violation (the guarded UPDATE simply never fires the write).
    await expect(
      reserveTransaction(prisma!, (tx) =>
        applyInventoryEffect(tx, {
          type: 'adjust',
          inventoryItemId: itemId,
          locationId,
          delta: -5,
          requestId: 'adjust-strand-1',
        }),
      ),
    ).rejects.toBeInstanceOf(InventoryShortageError);

    const level = await prisma!.inventoryLevel.findUniqueOrThrow({
      where: { inventoryItemId_locationId: { inventoryItemId: itemId, locationId } },
    });
    expect(level.stockedQuantity).toBe(10);
    expect(level.reservedQuantity).toBe(8);
    expect(await prisma!.stockMovement.count({ where: { requestId: 'adjust-strand-1' } })).toBe(0);
  });

  it('applyInventoryEffect(adjust): a non-negativity-violating adjust hits the b2 floor CHECK', async () => {
    const { itemId, locationId } = await seedLevel(3, 0); // reserved 0

    // Through the guarded path, removing 5 from stocked 3 (reserved 0): the strand
    // guard ((stocked-5) >= reserved) is FALSE, so the guarded UPDATE matches zero
    // rows and surfaces a shortage error: stocked can never go negative via the
    // application path.
    await expect(
      reserveTransaction(prisma!, (tx) =>
        applyInventoryEffect(tx, {
          type: 'adjust',
          inventoryItemId: itemId,
          locationId,
          delta: -5,
          requestId: 'adjust-floor-1',
        }),
      ),
    ).rejects.toBeInstanceOf(InventoryShortageError);

    // And the b2 floor is the database backstop: a bare UPDATE that bypasses the
    // guard and drives stocked negative is rejected by Postgres directly. With a
    // valid reserved (>= 0), a negative stocked is unreachable: it ALSO breaks
    // reserved <= stocked, so Postgres may report either floor; both encode the
    // same invariant (stocked can never go negative). The non-negativity floor is
    // exercised in isolation just below.
    await expect(
      prisma!.$executeRawUnsafe(
        `UPDATE "commerce"."inventory_level"
            SET "stocked_quantity" = -1
          WHERE "inventory_item_id" = $1 AND "location_id" = $2`,
        itemId,
        locationId,
      ),
    ).rejects.toThrow(/inventory_level_(stocked_nonneg|reserved_lte_stocked)_check/);

    // The stocked >= 0 floor CHECK in isolation: drop stocked to -1 while keeping
    // reserved <= stocked satisfied (reserved also -1). This now trips ONLY the
    // non-negativity floors, not the lte check, isolating the b2 floor backstop.
    await expect(
      prisma!.$executeRawUnsafe(
        `UPDATE "commerce"."inventory_level"
            SET "stocked_quantity" = -1, "reserved_quantity" = -1
          WHERE "inventory_item_id" = $1 AND "location_id" = $2`,
        itemId,
        locationId,
      ),
    ).rejects.toThrow(/inventory_level_(stocked|reserved)_nonneg_check/);

    const level = await prisma!.inventoryLevel.findUniqueOrThrow({
      where: { inventoryItemId_locationId: { inventoryItemId: itemId, locationId } },
    });
    expect(level.stockedQuantity).toBe(3);
    expect(level.reservedQuantity).toBe(0);
  });
});
