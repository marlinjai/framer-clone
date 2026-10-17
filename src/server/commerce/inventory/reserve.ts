import 'server-only';

// src/server/commerce/inventory/reserve.ts
//
// The heart of the commerce correctness story: the guarded conditional
// decrement that makes oversell STRUCTURALLY impossible for managed stock, plus
// the per-variant purchasability policy, location selection, kit lock-ordering,
// the four inventory effects, and the READ COMMITTED transaction seam. Runs on
// the scoped Kysely handle `commerceTenantDb(tgId)`; every structured query
// resolves to the company's `tg_<hex32>` schema, and every raw fragment names
// its table through `tenantSchemaRef(tgId)` (CI guard G3, `pnpm lint:guards`).
//
// THREE-WAY POLICY BRANCH (Medusa-style, per line; Marlin 2026-06-27). The flags
// live on `product_variant` (manage_inventory default TRUE, allow_backorder
// default FALSE, migration 006_inventory_policy). They are resolved FIRST, from
// the variant the line carries, BEFORE any inventory_level access:
//   A. manage_inventory = false (untracked): return ok with NO inventory access
//      and NO reservation/movement row. Untracked variants may have no
//      inventory_item/level at all. Always sellable.
//   B. manage_inventory = true && allow_backorder = true (backorder): the guarded
//      UPDATE DROPS its availability predicate, so reserved may exceed stocked and
//      available_quantity goes NEGATIVE (backorder depth). Never a shortage. Still
//      writes the reservation + movement; still idempotent on request_id.
//   C. manage_inventory = true && allow_backorder = false (managed): the guarded
//      decrement WHERE (stocked - reserved) >= needed. 0 matched rows ->
//      { ok:false, shortages }. Migration 006 dropped the DB CHECK
//      (reserved <= stocked) so backorder can exist, so this WHERE clause is the
//      SOLE oversell guard for managed items, and it is atomic (the row lock
//      serializes concurrent reservers).
//
// The other two guards still stand: the non-negativity floor CHECKs
// (stocked >= 0, reserved >= 0) and UNIQUE (request_id) on stock_movement and
// reservation, which makes every operation idempotent against retries.
//
// ISOLATION LEVEL: the guarded-decrement proof relies on Postgres READ COMMITTED
// re-evaluation semantics (a blocked UPDATE re-checks its WHERE against the
// committed row once the lock releases, cleanly matching zero rows for the
// loser). REPEATABLE READ / SERIALIZABLE would raise a 40001 serialization
// failure instead, turning the { ok: false, shortages } contract into a thrown
// error. `reserveTransaction` opens the transaction at RESERVE_ISOLATION_LEVEL
// explicitly, and the concurrency itest pins it.
//
// `numAffectedRows` is a BIGINT: compare to BigInt(0), NEVER 0. There is no
// setStock / setPrice / merge anywhere: this module only ever appends ledger
// movements and drives the guarded conditional UPDATEs.

import { randomUUID } from 'node:crypto';
import { sql, type Insertable, type IsolationLevel, type Kysely } from 'kysely';
import { tenantSchemaRef } from '@marlinjai/tenant-db';

import type { CommerceDB, ReservationTable, StockMovementTable } from '../db-types';

/**
 * The single isolation level the guarded decrement is proven against. Opening
 * the reserve transaction at anything stricter changes the contract (see header).
 */
export const RESERVE_ISOLATION_LEVEL: IsolationLevel = 'read committed';

/**
 * v1 ships ONE constant workspace. resolveLocation keys the default-location
 * lookup by this id; a resolved per-site workspace id replaces it later.
 */
export const DEFAULT_WORKSPACE_ID = 'default';

/** A single unmet line of demand, returned when a guarded reserve matches zero rows. */
export interface Shortage {
  inventoryItemId: string;
  locationId: string;
  needed: number;
  available: number;
}

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
 * race and its insert raised a unique violation (SQLSTATE 23505). This MUST propagate out of the transaction so
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

function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer, got ${value}`);
  }
}

/** Derive a unique, deterministic per-component request_id for a kit reservation. */
function kitComponentRequestId(kitRequestId: string, inventoryItemId: string): string {
  return `${kitRequestId}:${inventoryItemId}`;
}

/**
 * The resolved per-variant purchasability policy (migration 006 flags). `manageInventory`
 * false => Case A (untracked); `allowBackorder` true => Case B; both default-ish
 * (true/false) => Case C (managed). The DB default (manage=true, backorder=false,
 * = strictest, Case C) is used when the variant cannot be resolved.
 */
interface VariantPolicy {
  manageInventory: boolean;
  allowBackorder: boolean;
}

/** Args for a single-item reserve. */
export interface ReserveArgs {
  /**
   * The inventory item to decrement. OPTIONAL: an untracked variant (Case A) may
   * have no inventory_item at all. Required for a managed/backorder variant.
   */
  inventoryItemId?: string;
  /** Resolve the variant policy from product_variant by id (preferred). */
  variantId?: string;
  /** ...or by sku, when the line carries the sku rather than the variant id. */
  variantSku?: string;
  /** When omitted, the per-workspace default fulfillment location is resolved. */
  locationId?: string;
  needed: number;
  /** Idempotency key: a duplicate request_id is a no-op (UNIQUE on stock_movement). */
  requestId: string;
  refType?: string;
  refId?: string;
}

/**
 * The reserve result. `reservationId` is `null` for an untracked variant
 * (Case A): the reserve succeeded structurally but no reservation row was written.
 */
export type ReserveResult =
  | { ok: true; reservationId: string | null }
  | { ok: false; shortages: Shortage[] };

/** One component of a kit (carries the per-component variant). */
export interface KitComponent {
  inventoryItemId?: string;
  variantId?: string;
  variantSku?: string;
  requiredQuantity: number;
}

export interface ReserveKitArgs {
  components: KitComponent[];
  multiplier?: number;
  locationId?: string;
  requestId: string;
  refType?: string;
  refId?: string;
}

export type ReserveKitResult =
  | { ok: true; reservationIds: string[] }
  | { ok: false; shortages: Shortage[] };

/** The inventory-effect shape; the reserve case carries the variant. */
export type InventoryEffect =
  | {
      type: 'reserve';
      inventoryItemId?: string;
      variantId?: string;
      variantSku?: string;
      locationId?: string;
      quantity: number;
      requestId: string;
      refType?: string;
      refId?: string;
    }
  | { type: 'release'; inventoryItemId: string; locationId?: string; quantity: number; requestId: string; refType?: string; refId?: string }
  | { type: 'fulfill'; inventoryItemId: string; locationId?: string; quantity: number; requestId: string; refType?: string; refId?: string }
  | { type: 'adjust'; inventoryItemId: string; locationId?: string; delta: number; requestId: string; refType?: string; refId?: string };

/**
 * True iff `err` is a postgres.js unique-violation (SQLSTATE 23505) on one of the
 * request_id UNIQUE indexes (stock_movement_request_id_key / reservation_request_id_key).
 * kysely-postgres-js rethrows the raw postgres.js `PostgresError`, which carries
 * `.code` ('23505') and `.constraint_name` (the violated index). Any OTHER 23505
 * (e.g. a real primary-key duplicate) MUST propagate unchanged: it is never
 * swallowed. Exported only so the unit suite can pin that distinction.
 */
export function isRequestIdUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; constraint_name?: unknown };
  if (e.code !== '23505') return false;
  return (
    e.constraint_name === 'stock_movement_request_id_key' ||
    e.constraint_name === 'reservation_request_id_key'
  );
}

/**
 * Open a REAL Kysely transaction at READ COMMITTED (the only isolation the guarded
 * decrement is proven against) on the scoped `db` and run `fn` inside it. The
 * guarded UPDATE, the stock_movement append, and the reservation row all land in
 * this one transaction. The handle is already schema-qualified (it inherits
 * `withSchema` from `commerceTenantDb(tgId)`), so structured queries resolve to
 * `tg_<id>`; raw fragments still qualify via `tenantSchemaRef(tgId)`.
 */
export function reserveTransaction<T>(
  db: Kysely<CommerceDB>,
  fn: (trx: Kysely<CommerceDB>) => Promise<T>,
): Promise<T> {
  return db.transaction().setIsolationLevel(RESERVE_ISOLATION_LEVEL).execute(fn);
}

/**
 * Resolve the per-variant purchasability policy (migration 006 flags) BEFORE any
 * inventory_level access. Resolution order: explicit variantId, then variantSku,
 * then the SKU bridge (inventory_item.sku -> product_variant.sku) when only an
 * inventory item is known. Falls back to the DB default (manage=true,
 * backorder=false — the strictest, Case C) when the variant cannot be resolved.
 */
async function resolveVariantPolicy(
  trx: Kysely<CommerceDB>,
  ref: { inventoryItemId?: string; variantId?: string; variantSku?: string },
): Promise<VariantPolicy> {
  if (ref.variantId) {
    const v = await trx
      .selectFrom('product_variant')
      .select(['manage_inventory', 'allow_backorder'])
      .where('id', '=', ref.variantId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (v) return { manageInventory: v.manage_inventory, allowBackorder: v.allow_backorder };
  }

  if (ref.variantSku) {
    const v = await trx
      .selectFrom('product_variant')
      .select(['manage_inventory', 'allow_backorder'])
      .where('sku', '=', ref.variantSku)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (v) return { manageInventory: v.manage_inventory, allowBackorder: v.allow_backorder };
  }

  if (ref.inventoryItemId) {
    const item = await trx
      .selectFrom('inventory_item')
      .select('sku')
      .where('id', '=', ref.inventoryItemId)
      .executeTakeFirst();
    if (item?.sku) {
      const v = await trx
        .selectFrom('product_variant')
        .select(['manage_inventory', 'allow_backorder'])
        .where('sku', '=', item.sku)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (v) return { manageInventory: v.manage_inventory, allowBackorder: v.allow_backorder };
    }
  }

  // Unresolved => the strictest safe default (managed, no backorder, Case C).
  return { manageInventory: true, allowBackorder: false };
}

/**
 * Resolve the concrete location for a reservation: validate an explicit location
 * or read the per-workspace default from fulfillment_location_default. Structured queries on the scoped `trx` resolve to the
 * tenant schema, so no `tenantSchemaRef` is needed here. Throws if neither
 * resolves, so NO reservation is ever created without a concrete location.
 */
export async function resolveLocation(
  trx: Kysely<CommerceDB>,
  lineLocationId?: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<string> {
  if (lineLocationId) {
    const location = await trx
      .selectFrom('stock_location')
      .select('id')
      .where('id', '=', lineLocationId)
      .executeTakeFirst();
    if (!location) {
      throw new Error(`resolveLocation: stock location ${lineLocationId} does not exist`);
    }
    return location.id;
  }

  const fallback = await trx
    .selectFrom('fulfillment_location_default')
    .select('location_id')
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  if (!fallback) {
    throw new Error(
      `resolveLocation: no default fulfillment location configured for workspace ${workspaceId}`,
    );
  }
  return fallback.location_id;
}

/** Read the current level row (or undefined) for an item at a location. */
async function readLevel(
  trx: Kysely<CommerceDB>,
  inventoryItemId: string,
  locationId: string,
): Promise<{ stockedQuantity: number; reservedQuantity: number } | undefined> {
  const row = await trx
    .selectFrom('inventory_level')
    .select(['stocked_quantity', 'reserved_quantity'])
    .where('inventory_item_id', '=', inventoryItemId)
    .where('location_id', '=', locationId)
    .executeTakeFirst();
  return row
    ? { stockedQuantity: row.stocked_quantity, reservedQuantity: row.reserved_quantity }
    : undefined;
}

/** available = stocked - reserved (may be NEGATIVE for a backorder level), floor 0 when absent. */
async function readAvailable(
  trx: Kysely<CommerceDB>,
  inventoryItemId: string,
  locationId: string,
): Promise<number> {
  const level = await readLevel(trx, inventoryItemId, locationId);
  return level ? level.stockedQuantity - level.reservedQuantity : 0;
}

/**
 * The guarded conditional decrement, write-locking the level
 * row. For a MANAGED variant (allowBackorder false) it carries the availability
 * predicate `(stocked - reserved) >= needed` — the SOLE oversell guard now that
 * migration 006 dropped the DB CHECK, so the loser of a race re-evaluates against the
 * winner's committed row and matches ZERO rows. For a BACKORDER variant
 * (allowBackorder true) the predicate is DROPPED, so reserved may exceed stocked
 * and available goes negative (this is the feature, not a bug). Raw fragment;
 * the tenant table is named via `tenantSchemaRef(tgId)`; every value is bound.
 * Returns the matched-row count as a BIGINT (compare to BigInt(0)).
 */
async function guardedReserveUpdate(
  trx: Kysely<CommerceDB>,
  tgId: string,
  inventoryItemId: string,
  locationId: string,
  needed: number,
  allowBackorder: boolean,
): Promise<bigint> {
  const schema = tenantSchemaRef(tgId);
  const result = allowBackorder
    ? await sql`
        UPDATE ${schema}.inventory_level
           SET reserved_quantity = reserved_quantity + ${needed},
               version = version + 1,
               updated_at = CURRENT_TIMESTAMP
         WHERE inventory_item_id = ${inventoryItemId}
           AND location_id = ${locationId}
      `.execute(trx)
    : await sql`
        UPDATE ${schema}.inventory_level
           SET reserved_quantity = reserved_quantity + ${needed},
               version = version + 1,
               updated_at = CURRENT_TIMESTAMP
         WHERE inventory_item_id = ${inventoryItemId}
           AND location_id = ${locationId}
           AND (stocked_quantity - reserved_quantity) >= ${needed}
      `.execute(trx);
  return result.numAffectedRows ?? BigInt(0);
}

/**
 * Lock the given level rows in ASCENDING inventory_item_id order. A
 * single SELECT ... ORDER BY inventory_item_id ASC FOR UPDATE acquires the row
 * locks deterministically, so two concurrent kit reserves that share items never
 * deadlock. Raw fragment; tenant table via `tenantSchemaRef(tgId)`. The ids are
 * sorted ascending by the caller before this query.
 */
async function lockLevelsAscending(
  trx: Kysely<CommerceDB>,
  tgId: string,
  locationId: string,
  inventoryItemIds: string[],
): Promise<Map<string, { stockedQuantity: number; reservedQuantity: number }>> {
  const byItem = new Map<string, { stockedQuantity: number; reservedQuantity: number }>();
  if (inventoryItemIds.length === 0) return byItem;
  const schema = tenantSchemaRef(tgId);
  const result = await sql<{
    inventory_item_id: string;
    stocked_quantity: number;
    reserved_quantity: number;
  }>`
    SELECT inventory_item_id, stocked_quantity, reserved_quantity
      FROM ${schema}.inventory_level
     WHERE location_id = ${locationId}
       AND inventory_item_id IN (${sql.join(inventoryItemIds)})
     ORDER BY inventory_item_id ASC
     FOR UPDATE
  `.execute(trx);
  for (const row of result.rows) {
    byItem.set(row.inventory_item_id, {
      stockedQuantity: row.stocked_quantity,
      reservedQuantity: row.reserved_quantity,
    });
  }
  return byItem;
}

/** Insert the reserve stock_movement row. */
async function insertReserveMovement(
  trx: Kysely<CommerceDB>,
  inventoryItemId: string,
  locationId: string,
  quantity: number,
  requestId: string,
  refType?: string,
  refId?: string,
): Promise<void> {
  const values: Insertable<StockMovementTable> = {
    id: randomUUID(),
    inventory_item_id: inventoryItemId,
    location_id: locationId,
    movement_type: 'reserve',
    quantity,
    request_id: requestId,
    ref_type: refType ?? null,
    ref_id: refId ?? null,
  };
  await trx.insertInto('stock_movement').values(values).execute();
}

/** Insert the reservation row and return its id. */
async function insertReservation(
  trx: Kysely<CommerceDB>,
  locationId: string,
  quantity: number,
  requestId: string,
  lineItemId: string | null,
): Promise<string> {
  const values: Insertable<ReservationTable> = {
    id: randomUUID(),
    location_id: locationId,
    quantity,
    request_id: requestId,
    line_item_id: lineItemId,
    updated_at: new Date(),
  };
  const row = await trx
    .insertInto('reservation')
    .values(values)
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/**
 * Reserve `needed` units of one item, inside the caller's
 * READ COMMITTED transaction (`trx`). Resolves the variant policy FIRST (Cases
 * A/B/C above), then runs the guarded UPDATE + the stock_movement(reserve) append
 * + the reservation row. Returns { ok:false, shortages } only for a managed
 * (no-backorder) variant whose guard matches zero rows; never throws on
 * insufficient stock; never writes a partial result on that path. Idempotent: a
 * duplicate request_id returns the prior reservation unchanged. A CONCURRENT
 * duplicate request_id throws the un-exported {@link DuplicateRequestError}
 * sentinel OUT of the transaction (so Postgres rolls back the loser's own guarded
 * decrement, no double-decrement); the *WithRetry entrypoints re-read the
 * winner in a FRESH transaction. createOrder calls THIS inner function (not the
 * WithRetry entrypoint) so the sentinel propagates to its order-level mirror.
 */
export async function reserve(
  trx: Kysely<CommerceDB>,
  tgId: string,
  args: ReserveArgs,
): Promise<ReserveResult> {
  assertPositiveInt(args.needed, 'reserve.needed');

  // Policy FIRST, BEFORE any inventory_level access (untracked variants may have
  // no inventory_item/level row at all).
  const policy = await resolveVariantPolicy(trx, args);

  // Case A — untracked: always sellable, no inventory access, no rows written.
  if (!policy.manageInventory) {
    return { ok: true, reservationId: null };
  }

  // Managed/backorder need a concrete inventory item + location.
  if (!args.inventoryItemId) {
    throw new Error(
      'reserve: a managed variant (manage_inventory=true) requires inventoryItemId',
    );
  }
  const inventoryItemId = args.inventoryItemId;
  const locationId = await resolveLocation(trx, args.locationId);

  // Idempotency pre-check: a request_id already in the ledger returns its prior
  // reservation rather than reserving twice.
  const existing = await trx
    .selectFrom('stock_movement')
    .select('id')
    .where('request_id', '=', args.requestId)
    .executeTakeFirst();
  if (existing) {
    const priorReservation = await trx
      .selectFrom('reservation')
      .select('id')
      .where('request_id', '=', args.requestId)
      .executeTakeFirst();
    if (!priorReservation) {
      throw new Error(
        `reserve: request_id ${args.requestId} already used by a non-reserve movement`,
      );
    }
    return { ok: true, reservationId: priorReservation.id };
  }

  // The guarded conditional decrement. Case B (backorder) drops the availability
  // predicate; Case C (managed) keeps it as the SOLE oversell guard.
  const matched = await guardedReserveUpdate(
    trx,
    tgId,
    inventoryItemId,
    locationId,
    args.needed,
    policy.allowBackorder,
  );
  if (matched === BigInt(0)) {
    if (policy.allowBackorder) {
      // Case B never returns a shortage; zero rows means the level row is missing
      // for a managed variant — a data-integrity problem, surfaced loudly.
      throw new Error(
        `reserve(backorder): no inventory_level row for ${inventoryItemId} @ ${locationId}`,
      );
    }
    const available = await readAvailable(trx, inventoryItemId, locationId);
    return {
      ok: false,
      shortages: [{ inventoryItemId, locationId, needed: args.needed, available }],
    };
  }

  // The decrement committed to the row lock; append the ledger movement and the
  // reservation in the SAME transaction. Both carry the UNIQUE request_id, so a
  // concurrent duplicate that slipped past the pre-check aborts here on 23505.
  try {
    await insertReserveMovement(
      trx,
      inventoryItemId,
      locationId,
      args.needed,
      args.requestId,
      args.refType,
      args.refId,
    );
    const reservationId = await insertReservation(
      trx,
      locationId,
      args.needed,
      args.requestId,
      args.refType === 'order_line' ? (args.refId ?? null) : null,
    );
    return { ok: true, reservationId };
  } catch (error) {
    if (isRequestIdUniqueViolation(error)) {
      throw new DuplicateRequestError(args.requestId);
    }
    throw error;
  }
}

/**
 * Reserve a kit atomically. Each component resolves its OWN
 * policy (a kit can mix tracked, untracked, and backorder components). Untracked
 * components (Case A) are skipped entirely (no lock, no write). The tracked
 * components are locked in ASCENDING inventory_item_id order FIRST (deadlock-free),
 * then checked for availability (backorder components skip the check); if ANY
 * managed component is short the whole kit fails with { ok:false, shortages } and
 * NO movement/reservation is written. On success every tracked component gets its
 * own stock_movement(reserve) + reservation keyed by a per-component request_id.
 */
export async function reserveKit(
  trx: Kysely<CommerceDB>,
  tgId: string,
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

  const locationId = await resolveLocation(trx, args.locationId);

  // Resolve each component's policy. Untracked components (Case A) drop out: no
  // lock, no availability check, no write. Tracked components (B/C) participate.
  const tracked: Array<{
    inventoryItemId: string;
    requiredQuantity: number;
    allowBackorder: boolean;
  }> = [];
  for (const component of args.components) {
    const policy = await resolveVariantPolicy(trx, component);
    if (!policy.manageInventory) continue; // Case A — untracked, skip.
    if (!component.inventoryItemId) {
      throw new Error(
        'reserveKit: a managed kit component requires inventoryItemId',
      );
    }
    tracked.push({
      inventoryItemId: component.inventoryItemId,
      requiredQuantity: component.requiredQuantity,
      allowBackorder: policy.allowBackorder,
    });
  }

  // All-untracked kit: nothing to reserve, trivially idempotent success.
  if (tracked.length === 0) {
    return { ok: true, reservationIds: [] };
  }

  // Sort ascending so the lock acquisition order is deterministic kit-wide.
  const componentsAscending = [...tracked].sort((a, b) =>
    a.inventoryItemId < b.inventoryItemId ? -1 : a.inventoryItemId > b.inventoryItemId ? 1 : 0,
  );
  const itemIds = componentsAscending.map((c) => c.inventoryItemId);

  // Idempotency: if the first tracked component's movement already exists, the kit
  // was reserved before; return the prior reservations unchanged.
  const firstRequestId = kitComponentRequestId(args.requestId, itemIds[0]);
  const priorFirst = await trx
    .selectFrom('stock_movement')
    .select('id')
    .where('request_id', '=', firstRequestId)
    .executeTakeFirst();
  if (priorFirst) {
    const reservationIds: string[] = [];
    for (const itemId of itemIds) {
      const prior = await trx
        .selectFrom('reservation')
        .select('id')
        .where('request_id', '=', kitComponentRequestId(args.requestId, itemId))
        .executeTakeFirst();
      if (prior) reservationIds.push(prior.id);
    }
    return { ok: true, reservationIds };
  }

  // Phase 1: lock all tracked rows ascending, then check availability. No writes.
  const locked = await lockLevelsAscending(trx, tgId, locationId, itemIds);
  const shortages: Shortage[] = [];
  for (const component of componentsAscending) {
    if (component.allowBackorder) continue; // Case B never short.
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
  try {
    for (const component of componentsAscending) {
      const needed = component.requiredQuantity * multiplier;
      const requestId = kitComponentRequestId(args.requestId, component.inventoryItemId);
      const matched = await guardedReserveUpdate(
        trx,
        tgId,
        component.inventoryItemId,
        locationId,
        needed,
        component.allowBackorder,
      );
      if (matched === BigInt(0)) {
        // Unreachable under the held FOR UPDATE locks; surface loudly.
        throw new Error(
          `reserveKit: guarded update matched zero rows for ${component.inventoryItemId} despite a held lock`,
        );
      }
      await insertReserveMovement(
        trx,
        component.inventoryItemId,
        locationId,
        needed,
        requestId,
        args.refType,
        args.refId,
      );
      const reservationId = await insertReservation(trx, locationId, needed, requestId, null);
      reservationIds.push(reservationId);
    }
  } catch (error) {
    if (isRequestIdUniqueViolation(error)) {
      throw new DuplicateRequestError(args.requestId);
    }
    throw error;
  }

  return { ok: true, reservationIds };
}

/**
 * Apply one inventory effect inside the caller's READ
 * COMMITTED transaction, with request_id idempotency. The 'reserve' case delegates
 * to {@link reserve} (honouring the variant policy: an untracked reserve is
 * a no-op success, a managed shortage raises InventoryShortageError, a backorder
 * always applies). release/fulfill/adjust operate on existing tracked levels by
 * inventory item (policy does not gate post-reservation inventory ops).
 */
export async function applyInventoryEffect(
  trx: Kysely<CommerceDB>,
  tgId: string,
  effect: InventoryEffect,
): Promise<void> {
  // Idempotency (all effect types): a request_id already in the ledger is a no-op.
  const existing = await trx
    .selectFrom('stock_movement')
    .select('id')
    .where('request_id', '=', effect.requestId)
    .executeTakeFirst();
  if (existing) return;

  try {
    await applyInventoryEffectInner(trx, tgId, effect);
  } catch (error) {
    if (isRequestIdUniqueViolation(error)) {
      throw new DuplicateRequestError(effect.requestId);
    }
    throw error;
  }
}

/**
 * The effect dispatch itself, separated so the caller wraps it in the
 * single CONCURRENT-duplicate-request_id 23505 translation.
 */
async function applyInventoryEffectInner(
  trx: Kysely<CommerceDB>,
  tgId: string,
  effect: InventoryEffect,
): Promise<void> {
  switch (effect.type) {
    case 'reserve': {
      const result = await reserve(trx, tgId, {
        inventoryItemId: effect.inventoryItemId,
        variantId: effect.variantId,
        variantSku: effect.variantSku,
        locationId: effect.locationId,
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
      const locationId = await resolveLocation(trx, effect.locationId);
      const schema = tenantSchemaRef(tgId);
      const result = await sql`
        UPDATE ${schema}.inventory_level
           SET reserved_quantity = reserved_quantity - ${effect.quantity},
               version = version + 1,
               updated_at = CURRENT_TIMESTAMP
         WHERE inventory_item_id = ${effect.inventoryItemId}
           AND location_id = ${locationId}
           AND reserved_quantity >= ${effect.quantity}
      `.execute(trx);
      if ((result.numAffectedRows ?? BigInt(0)) === BigInt(0)) {
        const level = await readLevel(trx, effect.inventoryItemId, locationId);
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
      await appendMovement(trx, 'release', effect, locationId, effect.quantity);
      return;
    }

    case 'fulfill': {
      assertPositiveInt(effect.quantity, 'fulfill.quantity');
      const locationId = await resolveLocation(trx, effect.locationId);
      const schema = tenantSchemaRef(tgId);
      const result = await sql`
        UPDATE ${schema}.inventory_level
           SET reserved_quantity = reserved_quantity - ${effect.quantity},
               stocked_quantity = stocked_quantity - ${effect.quantity},
               version = version + 1,
               updated_at = CURRENT_TIMESTAMP
         WHERE inventory_item_id = ${effect.inventoryItemId}
           AND location_id = ${locationId}
           AND reserved_quantity >= ${effect.quantity}
           AND stocked_quantity >= ${effect.quantity}
      `.execute(trx);
      if ((result.numAffectedRows ?? BigInt(0)) === BigInt(0)) {
        const level = await readLevel(trx, effect.inventoryItemId, locationId);
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
      await appendMovement(trx, 'fulfill', effect, locationId, effect.quantity);
      return;
    }

    case 'adjust': {
      if (!Number.isInteger(effect.delta) || effect.delta === 0) {
        throw new Error(`adjust.delta must be a non-zero integer, got ${effect.delta}`);
      }
      const locationId = await resolveLocation(trx, effect.locationId);
      const schema = tenantSchemaRef(tgId);
      const result = await sql`
        UPDATE ${schema}.inventory_level
           SET stocked_quantity = stocked_quantity + ${effect.delta},
               version = version + 1,
               updated_at = CURRENT_TIMESTAMP
         WHERE inventory_item_id = ${effect.inventoryItemId}
           AND location_id = ${locationId}
           AND (stocked_quantity + ${effect.delta}) >= reserved_quantity
      `.execute(trx);
      if ((result.numAffectedRows ?? BigInt(0)) === BigInt(0)) {
        const level = await readLevel(trx, effect.inventoryItemId, locationId);
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
      await appendMovement(trx, 'adjust', effect, locationId, effect.delta);
      return;
    }

    default: {
      const exhaustive: never = effect;
      throw new Error(`applyInventoryEffect: unhandled effect ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Append the ledger movement for a release/fulfill/adjust effect. */
async function appendMovement(
  trx: Kysely<CommerceDB>,
  movementType: 'release' | 'fulfill' | 'adjust',
  effect: { inventoryItemId: string; requestId: string; refType?: string; refId?: string },
  locationId: string,
  quantity: number,
): Promise<void> {
  const values: Insertable<StockMovementTable> = {
    id: randomUUID(),
    inventory_item_id: effect.inventoryItemId,
    location_id: locationId,
    movement_type: movementType,
    quantity,
    request_id: effect.requestId,
    ref_type: effect.refType ?? null,
    ref_id: effect.refId ?? null,
  };
  await trx.insertInto('stock_movement').values(values).execute();
}

/**
 * Re-read the now-committed prior reservation for `requestId` and return
 * it as the idempotent success. Called in a FRESH transaction after a
 * UNIQUE(request_id) violation proved the winner committed; surfaces loudly if
 * the prior reservation is somehow absent.
 */
async function resolvePriorReservation(
  trx: Kysely<CommerceDB>,
  requestId: string,
): Promise<ReserveResult> {
  const prior = await trx
    .selectFrom('reservation')
    .select('id')
    .where('request_id', '=', requestId)
    .executeTakeFirst();
  if (!prior) {
    throw new Error(
      `reserve: request_id ${requestId} hit a UNIQUE violation but no prior reservation was found`,
    );
  }
  return { ok: true, reservationId: prior.id };
}

/** Re-read the prior per-component kit reservations as the idempotent success. */
async function resolvePriorKitReservations(
  trx: Kysely<CommerceDB>,
  kitRequestId: string,
  itemIds: string[],
): Promise<ReserveKitResult> {
  const reservationIds: string[] = [];
  for (const itemId of itemIds) {
    const prior = await trx
      .selectFrom('reservation')
      .select('id')
      .where('request_id', '=', kitComponentRequestId(kitRequestId, itemId))
      .executeTakeFirst();
    if (prior) reservationIds.push(prior.id);
  }
  return { ok: true, reservationIds };
}

/**
 * Reserve `needed` units owning the transaction AND the concurrent-duplicate
 * recovery. Opens the READ COMMITTED transaction, runs reserve, and
 * on a lost CONCURRENT duplicate request_id re-reads the winner's now-committed
 * reservation in a FRESH transaction. The entrypoint a caller that does not
 * already hold a `trx` should use.
 */
export async function reserveWithRetry(
  db: Kysely<CommerceDB>,
  tgId: string,
  args: ReserveArgs,
): Promise<ReserveResult> {
  try {
    return await reserveTransaction(db, (trx) => reserve(trx, tgId, args));
  } catch (error) {
    if (error instanceof DuplicateRequestError) {
      return reserveTransaction(db, (trx) =>
        resolvePriorReservation(trx, error.requestId),
      );
    }
    throw error;
  }
}

/**
 * Reserve a kit owning the transaction AND the concurrent-duplicate recovery
 *. On a lost CONCURRENT duplicate-kit race, re-reads the winner's
 * now-committed per-component reservations in a FRESH transaction.
 */
export async function reserveKitWithRetry(
  db: Kysely<CommerceDB>,
  tgId: string,
  args: ReserveKitArgs,
): Promise<ReserveKitResult> {
  try {
    return await reserveTransaction(db, (trx) => reserveKit(trx, tgId, args));
  } catch (error) {
    if (error instanceof DuplicateRequestError) {
      const itemIds = args.components
        .map((c) => c.inventoryItemId)
        .filter((id): id is string => Boolean(id));
      return reserveTransaction(db, (trx) =>
        resolvePriorKitReservations(trx, error.requestId, itemIds),
      );
    }
    throw error;
  }
}

/**
 * Apply one inventory effect owning the transaction AND the concurrent-duplicate
 * recovery. On a lost CONCURRENT duplicate race, the inner transaction
 * rolls back its own guarded UPDATE (no double-apply) and the prior effect already
 * committed, so the idempotent outcome is a no-op: the sentinel is absorbed.
 */
export async function applyInventoryEffectWithRetry(
  db: Kysely<CommerceDB>,
  tgId: string,
  effect: InventoryEffect,
): Promise<void> {
  try {
    await reserveTransaction(db, (trx) => applyInventoryEffect(trx, tgId, effect));
  } catch (error) {
    if (error instanceof DuplicateRequestError) return;
    throw error;
  }
}
