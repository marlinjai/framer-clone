import 'server-only';

// src/server/commerce/inventory/reserve.ts
//
// The heart of the commerce correctness story: the guarded conditional
// decrement that makes oversell STRUCTURALLY impossible, plus location
// selection, kit lock-ordering, the four inventory effects, and the
// READ COMMITTED transaction seam.
//
// THREE STACKED GUARDS (oversell cannot happen even if two of them are bypassed):
//   (1) the guarded UPDATE ... WHERE (stocked - reserved) >= needed takes a row
//       WRITE-LOCK, so two concurrent reservers SERIALIZE on the row; the loser
//       re-evaluates its WHERE against the winner's committed row, matches ZERO
//       rows, and returns { ok: false, shortages } (no throw, no partial write).
//   (2) the b2 CHECK (reserved_quantity <= stocked_quantity) is the database
//       backstop: any forgotten-guard write path is aborted by Postgres.
//   (3) the b2 UNIQUE (request_id) on stock_movement makes every op idempotent
//       against retries; a duplicate request_id is a clean no-op here.
//
// ISOLATION LEVEL: the guarded-decrement proof relies on Postgres DEFAULT
// READ COMMITTED re-evaluation semantics (a blocked UPDATE re-checks its WHERE
// against the committed row once the lock releases, cleanly matching zero rows
// for the loser). The transaction MUST NOT run at REPEATABLE READ / SERIALIZABLE:
// those raise a 40001 serialization failure instead of cleanly matching zero
// rows, turning the { ok: false, shortages } contract into a thrown error the
// caller would have to retry. `reserveTransaction` opens the transaction at
// READ COMMITTED explicitly; `RESERVE_ISOLATION_LEVEL` documents the requirement.
//
// data-table's adapter-prisma `transaction()` is a verified NO-OP and is never
// used here: every write runs inside a REAL `prisma.$transaction`. There is no
// setStock / setPrice / merge anywhere: this module only ever appends ledger
// movements and drives the guarded conditional UPDATE.

import { Prisma, type PrismaClient } from '@prisma/client';

import { COMMERCE_SCHEMA } from '../withTenant';

/**
 * The single isolation level the guarded decrement is proven against. Opening
 * the reserve transaction at anything stricter changes the contract (see header).
 */
export const RESERVE_ISOLATION_LEVEL = Prisma.TransactionIsolationLevel.ReadCommitted;

/**
 * v1 ships ONE constant workspace. resolveLocation keys the default-location
 * lookup by this id; E7 multi-tenancy threads a resolved workspace id instead.
 */
export const DEFAULT_WORKSPACE_ID = 'default';

/** A single unmet line of demand, returned when a guarded reserve matches zero rows. */
export interface Shortage {
  inventoryItemId: string;
  locationId: string;
  needed: number;
  available: number;
}

export type ReserveResult =
  | { ok: true; reservationId: string }
  | { ok: false; shortages: Shortage[] };

export interface ReserveArgs {
  inventoryItemId: string;
  /** When omitted, the per-workspace default fulfillment location is resolved. */
  locationId?: string;
  needed: number;
  /** Idempotency key: a duplicate request_id is a no-op (UNIQUE on stock_movement). */
  requestId: string;
  refType?: string;
  refId?: string;
}

/** One component of a kit: an inventory item and how many units the kit needs. */
export interface KitComponent {
  inventoryItemId: string;
  requiredQuantity: number;
}

export interface ReserveKitArgs {
  components: KitComponent[];
  /** How many kits to reserve (each component is required * multiplier). Default 1. */
  multiplier?: number;
  locationId?: string;
  requestId: string;
  refType?: string;
  refId?: string;
}

export type ReserveKitResult =
  | { ok: true; reservationIds: string[] }
  | { ok: false; shortages: Shortage[] };

export type InventoryEffect =
  | { type: 'reserve'; inventoryItemId: string; locationId?: string; quantity: number; requestId: string; refType?: string; refId?: string }
  | { type: 'release'; inventoryItemId: string; locationId?: string; quantity: number; requestId: string; refType?: string; refId?: string }
  | { type: 'fulfill'; inventoryItemId: string; locationId?: string; quantity: number; requestId: string; refType?: string; refId?: string }
  | { type: 'adjust'; inventoryItemId: string; locationId?: string; delta: number; requestId: string; refType?: string; refId?: string };

/**
 * Thrown when an inventory effect cannot be applied (a guard matched zero rows).
 * Carries the shortages so the caller's transaction rolls back with the reason
 * intact: the error surfaces, it is never swallowed.
 */
export class InventoryShortageError extends Error {
  readonly shortages: Shortage[];
  constructor(message: string, shortages: Shortage[]) {
    super(message);
    this.name = 'InventoryShortageError';
    this.shortages = shortages;
  }
}

// The commerce schema is a constant, allowlisted identifier (single-tenant v1).
// It is interpolated into raw SQL for the table reference; every VALUE is bound
// as a parameter ($1, $2, ...), never interpolated.
const SCHEMA = COMMERCE_SCHEMA;
const LEVEL = `"${SCHEMA}"."inventory_level"`;

/**
 * Open a REAL prisma.$transaction at READ COMMITTED (the only isolation the
 * guarded decrement is proven against) and run `fn` inside it. This is the seam
 * reserve callers use; the guarded UPDATE, the stock_movement append, and the
 * reservation row all land in this one transaction.
 */
export function reserveTransaction<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(fn, { isolationLevel: RESERVE_ISOLATION_LEVEL });
}

/**
 * Resolve the concrete location for a reservation. An explicit location is
 * validated to exist; otherwise the per-workspace default is read from
 * commerce.fulfillment_location_default. Throws if neither resolves, so NO
 * reservation is ever created without a concrete location.
 */
export async function resolveLocation(
  tx: Prisma.TransactionClient,
  lineLocationId?: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<string> {
  if (lineLocationId) {
    const location = await tx.stockLocation.findUnique({ where: { id: lineLocationId } });
    if (!location) {
      throw new Error(`resolveLocation: stock location ${lineLocationId} does not exist`);
    }
    return location.id;
  }

  const fallback = await tx.fulfillmentLocationDefault.findUnique({ where: { workspaceId } });
  if (!fallback) {
    throw new Error(
      `resolveLocation: no default fulfillment location configured for workspace ${workspaceId}`,
    );
  }
  return fallback.locationId;
}

/** Read the current level row (or null) for an item at a location. */
async function readLevel(
  tx: Prisma.TransactionClient,
  inventoryItemId: string,
  locationId: string,
): Promise<{ stockedQuantity: number; reservedQuantity: number } | null> {
  return tx.inventoryLevel.findUnique({
    where: { inventoryItemId_locationId: { inventoryItemId, locationId } },
    select: { stockedQuantity: true, reservedQuantity: true },
  });
}

/** available = stocked - reserved, floored at 0 when the row is absent. */
async function readAvailable(
  tx: Prisma.TransactionClient,
  inventoryItemId: string,
  locationId: string,
): Promise<number> {
  const level = await readLevel(tx, inventoryItemId, locationId);
  return level ? level.stockedQuantity - level.reservedQuantity : 0;
}

function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer, got ${value}`);
  }
}

/**
 * The single guarded conditional decrement, write-locking the level row:
 *   UPDATE inventory_level
 *      SET reserved_quantity = reserved_quantity + needed, version = version + 1
 *    WHERE item AND location AND (stocked - reserved) >= needed
 * Returns the number of rows it matched: 1 on success, 0 when the guard fails
 * (insufficient available, or the row does not exist). Run inside the caller's
 * READ COMMITTED transaction so a concurrent reserver serializes on the lock.
 */
async function guardedReserveUpdate(
  tx: Prisma.TransactionClient,
  inventoryItemId: string,
  locationId: string,
  needed: number,
): Promise<number> {
  return tx.$executeRawUnsafe(
    `UPDATE ${LEVEL}
        SET "reserved_quantity" = "reserved_quantity" + $1,
            "version" = "version" + 1,
            "updated_at" = CURRENT_TIMESTAMP
      WHERE "inventory_item_id" = $2
        AND "location_id" = $3
        AND ("stocked_quantity" - "reserved_quantity") >= $1`,
    needed,
    inventoryItemId,
    locationId,
  );
}

/**
 * Reserve `needed` units of one item, resolving the location if omitted. Runs
 * the guarded UPDATE + the stock_movement(reserve) append + the reservation row
 * in the caller's READ COMMITTED transaction (`tx`). Returns the explicit
 * { ok: false, shortages } contract when the guard matches zero rows; never
 * throws on insufficient stock, and never writes a partial result on that path.
 * Idempotent: a duplicate request_id returns the prior reservation unchanged.
 */
export async function reserve(tx: Prisma.TransactionClient, args: ReserveArgs): Promise<ReserveResult> {
  assertPositiveInt(args.needed, 'reserve.needed');
  const locationId = await resolveLocation(tx, args.locationId);

  // Guard (3): idempotency. If this request_id already appended a reserve
  // movement, return its reservation unchanged rather than reserving twice.
  const existing = await tx.stockMovement.findUnique({ where: { requestId: args.requestId } });
  if (existing) {
    const priorReservation = await tx.reservation.findUnique({ where: { requestId: args.requestId } });
    if (!priorReservation) {
      throw new Error(
        `reserve: request_id ${args.requestId} already used by a non-reserve movement`,
      );
    }
    return { ok: true, reservationId: priorReservation.id };
  }

  // Guard (1): the guarded conditional decrement (write-lock + WHERE available >= needed).
  const matched = await guardedReserveUpdate(tx, args.inventoryItemId, locationId, args.needed);
  if (matched === 0) {
    const available = await readAvailable(tx, args.inventoryItemId, locationId);
    return {
      ok: false,
      shortages: [{ inventoryItemId: args.inventoryItemId, locationId, needed: args.needed, available }],
    };
  }

  // The decrement committed to the row lock; append the ledger movement and the
  // reservation in the SAME transaction. Both carry the request_id (UNIQUE), so
  // a concurrent duplicate that slipped past the pre-check aborts here. Guard (2),
  // the reserved <= stocked CHECK, has already vetoed any oversell at the UPDATE.
  await tx.stockMovement.create({
    data: {
      inventoryItemId: args.inventoryItemId,
      locationId,
      movementType: 'reserve',
      quantity: args.needed,
      requestId: args.requestId,
      refType: args.refType ?? null,
      refId: args.refId ?? null,
    },
  });
  const reservation = await tx.reservation.create({
    data: {
      locationId,
      quantity: args.needed,
      requestId: args.requestId,
      lineItemId: args.refType === 'order_line' ? (args.refId ?? null) : null,
    },
  });

  return { ok: true, reservationId: reservation.id };
}

/**
 * Lock the given level rows in ASCENDING inventory_item_id order, inside the
 * caller's transaction. A single SELECT ... ORDER BY inventory_item_id ASC
 * FOR UPDATE acquires the row locks in a deterministic order, so two concurrent
 * kit reservations that share items can never deadlock (they queue on the same
 * first row instead of grabbing each other's second row). Returns the locked
 * rows keyed by inventory_item_id.
 */
async function lockLevelsAscending(
  tx: Prisma.TransactionClient,
  locationId: string,
  inventoryItemIds: string[],
): Promise<Map<string, { stockedQuantity: number; reservedQuantity: number }>> {
  if (inventoryItemIds.length === 0) return new Map();
  // $1 = locationId; $2.. = the item ids. Placeholders are generated, values bound.
  const placeholders = inventoryItemIds.map((_, i) => `$${i + 2}`).join(', ');
  const rows = await tx.$queryRawUnsafe<
    Array<{ inventory_item_id: string; stocked_quantity: number; reserved_quantity: number }>
  >(
    `SELECT "inventory_item_id", "stocked_quantity", "reserved_quantity"
       FROM ${LEVEL}
      WHERE "location_id" = $1
        AND "inventory_item_id" IN (${placeholders})
      ORDER BY "inventory_item_id" ASC
      FOR UPDATE`,
    locationId,
    ...inventoryItemIds,
  );
  const byItem = new Map<string, { stockedQuantity: number; reservedQuantity: number }>();
  for (const row of rows) {
    byItem.set(row.inventory_item_id, {
      stockedQuantity: row.stocked_quantity,
      reservedQuantity: row.reserved_quantity,
    });
  }
  return byItem;
}

/**
 * Reserve a kit (one variant -> N items via requiredQuantity) atomically. The N
 * item rows are locked in ASCENDING inventory_item_id order FIRST (deadlock-free),
 * then checked for availability; if ANY component is short the whole kit fails
 * with { ok: false, shortages } and NO movement/reservation is written (the
 * lock-then-check-then-write order guarantees no partial reservation). On
 * success every component gets its own stock_movement(reserve) + reservation,
 * each keyed by a per-component request_id derived from the kit request_id.
 */
export async function reserveKit(
  tx: Prisma.TransactionClient,
  args: ReserveKitArgs,
): Promise<ReserveKitResult> {
  const multiplier = args.multiplier ?? 1;
  assertPositiveInt(multiplier, 'reserveKit.multiplier');
  if (args.components.length === 0) {
    throw new Error('reserveKit: a kit must have at least one component');
  }
  for (const component of args.components) {
    assertPositiveInt(component.requiredQuantity, 'reserveKit.component.requiredQuantity');
  }

  const locationId = await resolveLocation(tx, args.locationId);

  // Sort ascending so the lock acquisition order is deterministic kit-wide.
  const componentsAscending = [...args.components].sort((a, b) =>
    a.inventoryItemId < b.inventoryItemId ? -1 : a.inventoryItemId > b.inventoryItemId ? 1 : 0,
  );
  const itemIds = componentsAscending.map((c) => c.inventoryItemId);

  // Idempotency: if the kit's first component movement already exists, the kit
  // was reserved before; return the prior reservations unchanged.
  const firstRequestId = kitComponentRequestId(args.requestId, itemIds[0]);
  const priorFirst = await tx.stockMovement.findUnique({ where: { requestId: firstRequestId } });
  if (priorFirst) {
    const reservationIds: string[] = [];
    for (const itemId of itemIds) {
      const prior = await tx.reservation.findUnique({
        where: { requestId: kitComponentRequestId(args.requestId, itemId) },
      });
      if (prior) reservationIds.push(prior.id);
    }
    return { ok: true, reservationIds };
  }

  // Phase 1: lock all rows ascending, then check availability. No writes yet.
  const locked = await lockLevelsAscending(tx, locationId, itemIds);
  const shortages: Shortage[] = [];
  for (const component of componentsAscending) {
    const needed = component.requiredQuantity * multiplier;
    const row = locked.get(component.inventoryItemId);
    const available = row ? row.stockedQuantity - row.reservedQuantity : 0;
    if (available < needed) {
      shortages.push({ inventoryItemId: component.inventoryItemId, locationId, needed, available });
    }
  }
  if (shortages.length > 0) {
    return { ok: false, shortages };
  }

  // Phase 2: every component is satisfiable under the held locks; write all.
  const reservationIds: string[] = [];
  for (const component of componentsAscending) {
    const needed = component.requiredQuantity * multiplier;
    const requestId = kitComponentRequestId(args.requestId, component.inventoryItemId);
    const matched = await guardedReserveUpdate(tx, component.inventoryItemId, locationId, needed);
    if (matched === 0) {
      // Unreachable under the held FOR UPDATE locks; surface loudly if it ever happens.
      throw new Error(
        `reserveKit: guarded update matched zero rows for ${component.inventoryItemId} despite a held lock`,
      );
    }
    await tx.stockMovement.create({
      data: {
        inventoryItemId: component.inventoryItemId,
        locationId,
        movementType: 'reserve',
        quantity: needed,
        requestId,
        refType: args.refType ?? null,
        refId: args.refId ?? null,
      },
    });
    const reservation = await tx.reservation.create({
      data: { locationId, quantity: needed, requestId },
    });
    reservationIds.push(reservation.id);
  }

  return { ok: true, reservationIds };
}

/** Derive a unique, deterministic per-component request_id for a kit reservation. */
function kitComponentRequestId(kitRequestId: string, inventoryItemId: string): string {
  return `${kitRequestId}:${inventoryItemId}`;
}

/**
 * Apply one inventory effect (reserve / release / fulfill / adjust) atomically
 * inside the caller's READ COMMITTED transaction, with request_id idempotency.
 * Every effect appends exactly one stock_movement and drives the matching
 * guarded conditional UPDATE; a guard that matches zero rows surfaces as an
 * InventoryShortageError (the transaction rolls back), never a silent drop.
 */
export async function applyInventoryEffect(
  tx: Prisma.TransactionClient,
  effect: InventoryEffect,
): Promise<void> {
  // Idempotency (all effect types): a request_id already in the ledger is a no-op.
  const existing = await tx.stockMovement.findUnique({ where: { requestId: effect.requestId } });
  if (existing) return;

  const locationId = await resolveLocation(tx, effect.locationId);

  switch (effect.type) {
    case 'reserve': {
      const result = await reserve(tx, {
        inventoryItemId: effect.inventoryItemId,
        locationId,
        needed: effect.quantity,
        requestId: effect.requestId,
        refType: effect.refType,
        refId: effect.refId,
      });
      if (!result.ok) {
        throw new InventoryShortageError(
          `applyInventoryEffect(reserve): insufficient available stock for ${effect.inventoryItemId}`,
          result.shortages,
        );
      }
      return;
    }

    case 'release': {
      assertPositiveInt(effect.quantity, 'release.quantity');
      // Guard: cannot release more than is currently reserved.
      const matched = await tx.$executeRawUnsafe(
        `UPDATE ${LEVEL}
            SET "reserved_quantity" = "reserved_quantity" - $1,
                "version" = "version" + 1,
                "updated_at" = CURRENT_TIMESTAMP
          WHERE "inventory_item_id" = $2
            AND "location_id" = $3
            AND "reserved_quantity" >= $1`,
        effect.quantity,
        effect.inventoryItemId,
        locationId,
      );
      if (matched === 0) {
        const level = await readLevel(tx, effect.inventoryItemId, locationId);
        throw new InventoryShortageError(
          `applyInventoryEffect(release): cannot release ${effect.quantity} of ${effect.inventoryItemId}`,
          [
            {
              inventoryItemId: effect.inventoryItemId,
              locationId,
              needed: effect.quantity,
              available: level?.reservedQuantity ?? 0,
            },
          ],
        );
      }
      await appendMovement(tx, 'release', effect, locationId, effect.quantity);
      return;
    }

    case 'fulfill': {
      assertPositiveInt(effect.quantity, 'fulfill.quantity');
      // Guard: cannot fulfill more than is reserved AND stocked; consumes both.
      const matched = await tx.$executeRawUnsafe(
        `UPDATE ${LEVEL}
            SET "reserved_quantity" = "reserved_quantity" - $1,
                "stocked_quantity" = "stocked_quantity" - $1,
                "version" = "version" + 1,
                "updated_at" = CURRENT_TIMESTAMP
          WHERE "inventory_item_id" = $2
            AND "location_id" = $3
            AND "reserved_quantity" >= $1
            AND "stocked_quantity" >= $1`,
        effect.quantity,
        effect.inventoryItemId,
        locationId,
      );
      if (matched === 0) {
        const level = await readLevel(tx, effect.inventoryItemId, locationId);
        throw new InventoryShortageError(
          `applyInventoryEffect(fulfill): cannot fulfill ${effect.quantity} of ${effect.inventoryItemId}`,
          [
            {
              inventoryItemId: effect.inventoryItemId,
              locationId,
              needed: effect.quantity,
              available: Math.min(level?.reservedQuantity ?? 0, level?.stockedQuantity ?? 0),
            },
          ],
        );
      }
      await appendMovement(tx, 'fulfill', effect, locationId, effect.quantity);
      return;
    }

    case 'adjust': {
      if (!Number.isInteger(effect.delta) || effect.delta === 0) {
        throw new Error(`adjust.delta must be a non-zero integer, got ${effect.delta}`);
      }
      // Guard: the resulting stocked must stay at or above the reserved floor
      // (the b2 CHECK reserved <= stocked is the backstop). A negative adjust
      // that would strand reservations matches zero rows and surfaces.
      const matched = await tx.$executeRawUnsafe(
        `UPDATE ${LEVEL}
            SET "stocked_quantity" = "stocked_quantity" + $1,
                "version" = "version" + 1,
                "updated_at" = CURRENT_TIMESTAMP
          WHERE "inventory_item_id" = $2
            AND "location_id" = $3
            AND ("stocked_quantity" + $1) >= "reserved_quantity"`,
        effect.delta,
        effect.inventoryItemId,
        locationId,
      );
      if (matched === 0) {
        const level = await readLevel(tx, effect.inventoryItemId, locationId);
        throw new InventoryShortageError(
          `applyInventoryEffect(adjust): cannot adjust ${effect.inventoryItemId} by ${effect.delta} (no such level, or it would strand reservations)`,
          [
            {
              inventoryItemId: effect.inventoryItemId,
              locationId,
              needed: -effect.delta,
              available: level ? level.stockedQuantity - level.reservedQuantity : 0,
            },
          ],
        );
      }
      await appendMovement(tx, 'adjust', effect, locationId, effect.delta);
      return;
    }

    default: {
      // Exhaustiveness: a new effect type must be handled explicitly.
      const exhaustive: never = effect;
      throw new Error(`applyInventoryEffect: unhandled effect ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Append the append-only ledger movement for a release/fulfill/adjust effect. */
async function appendMovement(
  tx: Prisma.TransactionClient,
  movementType: 'release' | 'fulfill' | 'adjust',
  effect: { inventoryItemId: string; requestId: string; refType?: string; refId?: string },
  locationId: string,
  quantity: number,
): Promise<void> {
  await tx.stockMovement.create({
    data: {
      inventoryItemId: effect.inventoryItemId,
      locationId,
      movementType,
      quantity,
      requestId: effect.requestId,
      refType: effect.refType ?? null,
      refId: effect.refId ?? null,
    },
  });
}
