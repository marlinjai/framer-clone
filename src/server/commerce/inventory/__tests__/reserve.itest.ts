// src/server/commerce/inventory/__tests__/reserve.itest.ts
//
// Integration test (Dockerized Postgres) for the b3 guarded reservation. It
// boots its OWN throwaway Postgres in beforeAll (testcontainers), applies every
// migration (dt_* init + b2 ledger + b3 guarded reservation), and proves the six
// race/guard guarantees plus the isolation-level assertion against a LIVE
// database, because the correctness story is Postgres semantics, not mockable:
//
//   1. two concurrent reserves of the last unit -> exactly one ok:true, one
//      ok:false with shortages (the guarded decrement under READ COMMITTED),
//   2. a forgotten-guard write path is caught by the b2 CHECK backstop,
//   3. a duplicate request_id is a no-op (idempotent),
//   4. omitting locationId resolves the per-workspace default and never creates
//      a NULL-location reservation,
//   5. a kit reservation locks item rows in ASCENDING inventory_item_id order so
//      two concurrent kit reserves are deadlock-free,
//   6. a half-completed transfer fails to commit (the deferred trigger), while a
//      balanced pair commits,
//   7. the reserve transaction runs at READ COMMITTED (asserted live).
//
// The `.itest.ts` suffix keeps this file OUT of the headless `pnpm test` gate
// (vitest.config.ts matches only *.{test,spec}.{ts,tsx}); it runs only under
// `pnpm test:integration` against Docker. It requires a running Docker daemon.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

import {
  DEFAULT_WORKSPACE_ID,
  reserve,
  reserveKit,
  reserveTransaction,
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
});
