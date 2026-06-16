// src/server/commerce/inventory/__tests__/reserve.test.ts
//
// Headless UNIT tests for the reservation orchestration logic. These run in the
// node project of the standard `pnpm test` gate (no Docker, no live Postgres):
// the transaction client is a programmable fake, so what is exercised here is
// the CONTROL FLOW around the guarded decrement, not Postgres semantics:
//   - resolveLocation never yields a NULL location (explicit, default, or throw),
//   - reserve's idempotency pre-check returns the prior reservation,
//   - reserve returns the { ok: false, shortages } contract (no throw) when the
//     guarded UPDATE matches zero rows, and writes movement + reservation on the
//     success path,
//   - applyInventoryEffect dispatches all four effects and raises
//     InventoryShortageError (rolling the caller's tx back) when a guard fails,
//   - reserveKit locks/checks components in ASCENDING inventory_item_id order,
//   - the isolation level constant is READ COMMITTED.
//
// The REAL two-transaction race, the CHECK backstop, the deferred transfer
// trigger, and the live READ COMMITTED assertion are proven against Dockerized
// Postgres in reserve.itest.ts (kept out of this gate by the `.itest.ts` suffix).

import { describe, expect, it, vi } from 'vitest';

import {
  applyInventoryEffect,
  InventoryShortageError,
  RESERVE_ISOLATION_LEVEL,
  reserve,
  reserveKit,
  resolveLocation,
} from '../reserve';

// A programmable fake of Prisma.TransactionClient: only the members reserve.ts
// touches are implemented, each as a vi.fn() the test wires per-scenario. The
// raw `$executeRawUnsafe` / `$queryRawUnsafe` return values stand in for what
// Postgres would do (rows matched, rows locked), so the branching logic is
// tested deterministically without a database.
function makeTx(overrides: Record<string, unknown> = {}) {
  const tx = {
    stockLocation: { findUnique: vi.fn() },
    fulfillmentLocationDefault: { findUnique: vi.fn() },
    inventoryLevel: { findUnique: vi.fn() },
    stockMovement: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
    reservation: { findUnique: vi.fn(), create: vi.fn() },
    $executeRawUnsafe: vi.fn(),
    $queryRawUnsafe: vi.fn(),
  };
  return Object.assign(tx, overrides) as typeof tx & Record<string, unknown>;
}

describe('RESERVE_ISOLATION_LEVEL', () => {
  it('is READ COMMITTED (the only level the guarded decrement is proven against)', () => {
    expect(RESERVE_ISOLATION_LEVEL).toBe('ReadCommitted');
  });
});

describe('resolveLocation', () => {
  it('returns an explicit location when it exists', async () => {
    const tx = makeTx();
    tx.stockLocation.findUnique.mockResolvedValue({ id: 'loc-1' });
    await expect(resolveLocation(tx as never, 'loc-1')).resolves.toBe('loc-1');
  });

  it('throws when the explicit location does not exist (never a NULL location)', async () => {
    const tx = makeTx();
    tx.stockLocation.findUnique.mockResolvedValue(null);
    await expect(resolveLocation(tx as never, 'missing')).rejects.toThrow(/does not exist/);
  });

  it('resolves the per-workspace default when locationId is omitted', async () => {
    const tx = makeTx();
    tx.fulfillmentLocationDefault.findUnique.mockResolvedValue({ locationId: 'default-loc' });
    await expect(resolveLocation(tx as never)).resolves.toBe('default-loc');
  });

  it('throws when no default is configured (never a NULL location)', async () => {
    const tx = makeTx();
    tx.fulfillmentLocationDefault.findUnique.mockResolvedValue(null);
    await expect(resolveLocation(tx as never)).rejects.toThrow(/no default fulfillment location/);
  });
});

describe('reserve', () => {
  it('rejects a non-positive needed', async () => {
    const tx = makeTx();
    await expect(
      reserve(tx as never, { inventoryItemId: 'i', locationId: 'l', needed: 0, requestId: 'r' }),
    ).rejects.toThrow(/positive integer/);
  });

  it('is idempotent: a duplicate request_id returns the prior reservation, no new writes', async () => {
    const tx = makeTx();
    tx.stockLocation.findUnique.mockResolvedValue({ id: 'loc-1' });
    tx.stockMovement.findUnique.mockResolvedValue({ id: 'mv-1' });
    tx.reservation.findUnique.mockResolvedValue({ id: 'res-prior' });

    const result = await reserve(tx as never, {
      inventoryItemId: 'item-1',
      locationId: 'loc-1',
      needed: 1,
      requestId: 'dup',
    });

    expect(result).toEqual({ ok: true, reservationId: 'res-prior' });
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
    expect(tx.reservation.create).not.toHaveBeenCalled();
  });

  it('returns { ok: false, shortages } (no throw, no writes) when the guard matches zero rows', async () => {
    const tx = makeTx();
    tx.stockLocation.findUnique.mockResolvedValue({ id: 'loc-1' });
    tx.$executeRawUnsafe.mockResolvedValue(0); // guarded UPDATE matched nothing
    tx.inventoryLevel.findUnique.mockResolvedValue({ stockedQuantity: 5, reservedQuantity: 3 });

    const result = await reserve(tx as never, {
      inventoryItemId: 'item-1',
      locationId: 'loc-1',
      needed: 4,
      requestId: 'r1',
    });

    expect(result).toEqual({
      ok: false,
      shortages: [{ inventoryItemId: 'item-1', locationId: 'loc-1', needed: 4, available: 2 }],
    });
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
    expect(tx.reservation.create).not.toHaveBeenCalled();
  });

  it('writes the movement + reservation and returns ok on the success path', async () => {
    const tx = makeTx();
    tx.stockLocation.findUnique.mockResolvedValue({ id: 'loc-1' });
    tx.$executeRawUnsafe.mockResolvedValue(1); // guarded UPDATE matched one row
    tx.reservation.create.mockResolvedValue({ id: 'res-new' });

    const result = await reserve(tx as never, {
      inventoryItemId: 'item-1',
      locationId: 'loc-1',
      needed: 2,
      requestId: 'r2',
    });

    expect(result).toEqual({ ok: true, reservationId: 'res-new' });
    expect(tx.stockMovement.create).toHaveBeenCalledTimes(1);
    expect(tx.stockMovement.create.mock.calls[0][0].data).toMatchObject({
      movementType: 'reserve',
      quantity: 2,
      requestId: 'r2',
    });
  });
});

describe('reserveKit', () => {
  it('locks components in ASCENDING inventory_item_id order before writing', async () => {
    const tx = makeTx();
    tx.stockLocation.findUnique.mockResolvedValue({ id: 'loc-1' });
    // Lock-phase SELECT ... FOR UPDATE returns ample stock for both items.
    tx.$queryRawUnsafe.mockResolvedValue([
      { inventory_item_id: 'item-a', stocked_quantity: 10, reserved_quantity: 0 },
      { inventory_item_id: 'item-b', stocked_quantity: 10, reserved_quantity: 0 },
    ]);
    tx.$executeRawUnsafe.mockResolvedValue(1);
    tx.reservation.create
      .mockResolvedValueOnce({ id: 'res-a' })
      .mockResolvedValueOnce({ id: 'res-b' });

    // Pass components OUT of order; reserveKit must sort ascending.
    const result = await reserveKit(tx as never, {
      components: [
        { inventoryItemId: 'item-b', requiredQuantity: 1 },
        { inventoryItemId: 'item-a', requiredQuantity: 2 },
      ],
      locationId: 'loc-1',
      requestId: 'kit-1',
    });

    expect(result.ok).toBe(true);
    // The single locking SELECT received the item ids in ascending order.
    const lockCall = tx.$queryRawUnsafe.mock.calls[0];
    expect(lockCall.slice(2)).toEqual(['item-a', 'item-b']);
    expect(lockCall[0]).toMatch(/ORDER BY "inventory_item_id" ASC[\s\S]*FOR UPDATE/);
    // The guarded UPDATE was driven once per component, ascending.
    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('fails the whole kit with shortages and writes nothing if any component is short', async () => {
    const tx = makeTx();
    tx.stockLocation.findUnique.mockResolvedValue({ id: 'loc-1' });
    tx.$queryRawUnsafe.mockResolvedValue([
      { inventory_item_id: 'item-a', stocked_quantity: 10, reserved_quantity: 0 },
      { inventory_item_id: 'item-b', stocked_quantity: 1, reserved_quantity: 0 },
    ]);

    const result = await reserveKit(tx as never, {
      components: [
        { inventoryItemId: 'item-a', requiredQuantity: 1 },
        { inventoryItemId: 'item-b', requiredQuantity: 5 },
      ],
      locationId: 'loc-1',
      requestId: 'kit-2',
    });

    expect(result).toEqual({
      ok: false,
      shortages: [{ inventoryItemId: 'item-b', locationId: 'loc-1', needed: 5, available: 1 }],
    });
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled(); // no guarded writes
    expect(tx.reservation.create).not.toHaveBeenCalled();
  });
});

describe('applyInventoryEffect', () => {
  it('is idempotent: an effect whose request_id is already in the ledger is a no-op', async () => {
    const tx = makeTx();
    tx.stockMovement.findUnique.mockResolvedValue({ id: 'mv-existing' });

    await applyInventoryEffect(tx as never, {
      type: 'adjust',
      inventoryItemId: 'item-1',
      locationId: 'loc-1',
      delta: 5,
      requestId: 'seen',
    });

    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('release: appends a release movement on success', async () => {
    const tx = makeTx();
    tx.stockLocation.findUnique.mockResolvedValue({ id: 'loc-1' });
    tx.$executeRawUnsafe.mockResolvedValue(1);

    await applyInventoryEffect(tx as never, {
      type: 'release',
      inventoryItemId: 'item-1',
      locationId: 'loc-1',
      quantity: 2,
      requestId: 'rel-1',
    });

    expect(tx.stockMovement.create.mock.calls[0][0].data).toMatchObject({
      movementType: 'release',
      quantity: 2,
    });
  });

  it('fulfill: raises InventoryShortageError (rolling the tx back) when the guard fails', async () => {
    const tx = makeTx();
    tx.stockLocation.findUnique.mockResolvedValue({ id: 'loc-1' });
    tx.$executeRawUnsafe.mockResolvedValue(0);
    tx.inventoryLevel.findUnique.mockResolvedValue({ stockedQuantity: 1, reservedQuantity: 1 });

    await expect(
      applyInventoryEffect(tx as never, {
        type: 'fulfill',
        inventoryItemId: 'item-1',
        locationId: 'loc-1',
        quantity: 5,
        requestId: 'ful-1',
      }),
    ).rejects.toBeInstanceOf(InventoryShortageError);
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('adjust: rejects a zero delta', async () => {
    const tx = makeTx();
    tx.stockLocation.findUnique.mockResolvedValue({ id: 'loc-1' });

    await expect(
      applyInventoryEffect(tx as never, {
        type: 'adjust',
        inventoryItemId: 'item-1',
        locationId: 'loc-1',
        delta: 0,
        requestId: 'adj-0',
      }),
    ).rejects.toThrow(/non-zero integer/);
  });
});
