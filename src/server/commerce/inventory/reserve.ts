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

/**
 * Internal sentinel: a CONCURRENT duplicate request_id lost the UNIQUE(request_id)
 * race and its insert raised P2002. This MUST propagate out of the transaction so
 * Postgres rolls it back (rolling back the loser's own guarded decrement, so there
 * is NO double-decrement). The prior, now-committed result CANNOT be re-read inside
 * the same transaction (a constraint violation puts Postgres in state 25P02,
 * "current transaction is aborted"), so the idempotent re-read happens in a FRESH
 * transaction in the *WithRetry entrypoints below. This type is not exported: it
 * never escapes the module; the entrypoints translate it into the idempotent
 * success and any other error propagates unchanged.
 */
class DuplicateRequestError extends Error {
  readonly requestId: string;
  constructor(requestId: string) {
    super(`duplicate request_id ${requestId} (concurrent idempotency)`);
    this.name = 'DuplicateRequestError';
    this.requestId = requestId;
  }
}

// The commerce schema is a constant, allowlisted identifier (single-tenant v1).
// It is interpolated into raw SQL for the table reference; every VALUE is bound
// as a parameter ($1, $2, ...), never interpolated.
const SCHEMA = COMMERCE_SCHEMA;
const LEVEL = `"${SCHEMA}"."inventory_level"`;

// The Postgres UNIQUE(request_id) constraints whose violation means a concurrent
// duplicate request beat us to the commit. b2 creates these as named indexes:
//   CREATE UNIQUE INDEX "stock_movement_request_id_key" ON ...("request_id")
//   CREATE UNIQUE INDEX "reservation_request_id_key"    ON ...("request_id")
// Either insert in a reserve/effect path can hit one of these on the concurrent
// duplicate-request_id race; both translate to the idempotent prior-result return.
const REQUEST_ID_CONSTRAINTS = ['stock_movement_request_id_key', 'reservation_request_id_key'];

/**
 * True iff `error` is a Prisma P2002 unique-constraint violation on one of the
 * request_id constraints. Prisma's Postgres connector reports `meta.target` as
 * the constraint name (a string) in current versions; older shapes report an
 * array of field names. We accept either: a named request_id constraint, or a
 * target that references the request_id column. Any OTHER P2002 (a real bug,
 * e.g. a duplicate primary key) is NOT swallowed: it propagates unchanged.
 */
function isRequestIdUniqueViolation(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2002'
  ) {
    return false;
  }
  const target = error.meta?.target;
  if (typeof target === 'string') {
    return REQUEST_ID_CONSTRAINTS.includes(target) || target.includes('request_id');
  }
  if (Array.isArray(target)) {
    return target.some((t) => t === 'request_id' || t === 'requestId');
  }
  return false;
}

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
 * Reserve `needed` units, owning the transaction AND the concurrent-duplicate
 * recovery. This is the entrypoint a caller that does not already hold a `tx`
 * should use. It opens the READ COMMITTED transaction, runs `reserve`, and if a
 * CONCURRENT duplicate request_id lost the UNIQUE(request_id) race (the inner
 * transaction aborts and rolls back its own guarded decrement, so no double
 * decrement), it re-reads the winner's now-committed reservation in a FRESH
 * transaction and returns it as the idempotent success. The re-read is in a new
 * transaction because Postgres forbids any query in the aborted one (state 25P02).
 */
export async function reserveWithRetry(prisma: PrismaClient, args: ReserveArgs): Promise<ReserveResult> {
  try {
    return await reserveTransaction(prisma, (tx) => reserve(tx, args));
  } catch (error) {
    if (error instanceof DuplicateRequestError) {
      return reserveTransaction(prisma, (tx) => resolvePriorReservation(tx, error.requestId));
    }
    throw error;
  }
}

/**
 * Reserve a kit, owning the transaction AND the concurrent-duplicate recovery
 * (see reserveWithRetry). On a lost CONCURRENT duplicate-kit race, re-reads the
 * winner's now-committed per-component reservations in a FRESH transaction.
 */
export async function reserveKitWithRetry(
  prisma: PrismaClient,
  args: ReserveKitArgs,
): Promise<ReserveKitResult> {
  try {
    return await reserveTransaction(prisma, (tx) => reserveKit(tx, args));
  } catch (error) {
    if (error instanceof DuplicateRequestError) {
      const itemIds = args.components.map((c) => c.inventoryItemId);
      return reserveTransaction(prisma, (tx) =>
        resolvePriorKitReservations(tx, error.requestId, itemIds),
      );
    }
    throw error;
  }
}

/**
 * Apply one inventory effect, owning the transaction AND the concurrent-duplicate
 * recovery. On a lost CONCURRENT duplicate race, the inner transaction rolls back
 * its own guarded UPDATE (no double-apply) and the prior effect already committed,
 * so the idempotent outcome is simply a no-op: the sentinel is absorbed.
 */
export async function applyInventoryEffectWithRetry(
  prisma: PrismaClient,
  effect: InventoryEffect,
): Promise<void> {
  try {
    await reserveTransaction(prisma, (tx) => applyInventoryEffect(tx, effect));
  } catch (error) {
    if (error instanceof DuplicateRequestError) return;
    throw error;
  }
}

/**
 * Re-read the now-committed prior reservation for `requestId` and return it as the
 * idempotent success, mirroring the SEQUENTIAL pre-check branch's return shape
 * exactly. Called in a FRESH transaction after a UNIQUE(request_id) violation
 * proved the winner committed; if the prior reservation is somehow absent, surface
 * loudly (never a silent 500).
 */
async function resolvePriorReservation(
  tx: Prisma.TransactionClient,
  requestId: string,
): Promise<ReserveResult> {
  const priorReservation = await tx.reservation.findUnique({ where: { requestId } });
  if (!priorReservation) {
    throw new Error(
      `reserve: request_id ${requestId} hit a UNIQUE violation but no prior reservation was found`,
    );
  }
  return { ok: true, reservationId: priorReservation.id };
}

/**
 * Re-read the now-committed prior per-component reservations for a kit and return
 * them as the idempotent success, mirroring the priorFirst pre-check branch's
 * return shape exactly. Called in a FRESH transaction after a UNIQUE(request_id)
 * violation proved a concurrent duplicate kit committed first.
 */
async function resolvePriorKitReservations(
  tx: Prisma.TransactionClient,
  kitRequestId: string,
  itemIds: string[],
): Promise<ReserveKitResult> {
  const reservationIds: string[] = [];
  for (const itemId of itemIds) {
    const prior = await tx.reservation.findUnique({
      where: { requestId: kitComponentRequestId(kitRequestId, itemId) },
    });
    if (prior) reservationIds.push(prior.id);
  }
  return { ok: true, reservationIds };
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
  //
  // CONCURRENT idempotency (guard (3), live path): two transactions with the same
  // request_id both pass the read-then-write pre-check under READ COMMITTED (each
  // sees null), both run the guarded decrement, and the LOSER's insert below trips
  // the UNIQUE(request_id) on the winner's commit (P2002). We re-throw it as the
  // DuplicateRequestError sentinel so it propagates OUT of this transaction:
  // Postgres rolls the loser's transaction back (undoing its own guarded decrement,
  // so there is NO double decrement) and the reserveWithRetry entrypoint re-reads
  // the winner's committed reservation in a FRESH transaction (the prior result
  // cannot be read inside this now-aborted one). Any OTHER error propagates
  // unchanged: it is never swallowed.
  try {
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
  } catch (error) {
    if (isRequestIdUniqueViolation(error)) {
      throw new DuplicateRequestError(args.requestId);
    }
    throw error;
  }
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
  //
  // CONCURRENT idempotency: two kit reserves with the same kit request_id both
  // pass the priorFirst pre-check under READ COMMITTED, both serialize on the
  // ascending FOR UPDATE locks, and the LOSER trips the per-component
  // UNIQUE(request_id) here on the winner's commit (P2002). We re-throw the
  // DuplicateRequestError sentinel so it propagates out and Postgres rolls the
  // loser's transaction back (undoing its guarded decrements, no double decrement);
  // reserveKitWithRetry re-reads the winner's committed reservations in a FRESH
  // transaction. Any other error propagates unchanged.
  const reservationIds: string[] = [];
  try {
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
  } catch (error) {
    if (isRequestIdUniqueViolation(error)) {
      throw new DuplicateRequestError(args.requestId);
    }
    throw error;
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

  // CONCURRENT idempotency: two effects with the same request_id both pass the
  // pre-check above under READ COMMITTED, both run their guarded UPDATE, and the
  // LOSER trips the UNIQUE(request_id) on stock_movement at the winner's commit
  // (P2002). We re-throw the DuplicateRequestError sentinel so it propagates out
  // and Postgres rolls the loser's transaction back (undoing its own guarded
  // UPDATE, so no double-apply); applyInventoryEffectWithRetry treats the sentinel
  // as the idempotent no-op the sequential pre-check produces (no re-read needed:
  // the effect itself is void). The 'reserve' case delegates to reserve(), which
  // raises the same sentinel; it propagates here unchanged.
  try {
    await applyInventoryEffectInner(tx, effect, locationId);
  } catch (error) {
    if (isRequestIdUniqueViolation(error)) {
      throw new DuplicateRequestError(effect.requestId);
    }
    throw error;
  }
}

/**
 * The effect dispatch itself, separated from applyInventoryEffect so the caller
 * can wrap it in the single CONCURRENT-duplicate-request_id P2002 translation.
 * The location is already resolved by the caller.
 */
async function applyInventoryEffectInner(
  tx: Prisma.TransactionClient,
  effect: InventoryEffect,
  locationId: string,
): Promise<void> {
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
