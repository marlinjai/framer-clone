import type { Migration } from '@marlinjai/tenant-db';

/**
 * CM-08a — `006_inventory_policy`: the Medusa-style configurable inventory
 * policy. Adds the two purchasability flags to `product_variant` and RELAXES the
 * inventory oversell guard so backorder can reserve beyond stock.
 *
 * Decided by Marlin 2026-06-27 (see
 * docs/research/2026-06-27-medusa-inventory-backorder-reference.md): overselling
 * is NOT a hard error; it is per-variant configurable.
 *
 *   - `manage_inventory` (default TRUE): when true the variant's stock is tracked
 *     and gates purchasability. A deliberate DIVERGENCE from Medusa's `false`
 *     default — our engine is SKU-bridge-first, so every bridged SKU already has
 *     an inventory_item/level and should stay stock-gated; digital/unlimited
 *     variants opt out with `false`.
 *   - `allow_backorder` (default FALSE, matches Medusa): when true the variant may
 *     be purchased while out of stock, pushing `reserved_quantity` above
 *     `stocked_quantity` so the GENERATED `available_quantity` goes negative (the
 *     backorder depth).
 *
 * Why DROP the table-level CHECK (reserved <= stocked): the flags live on
 * `product_variant`, but the constraint is on `inventory_level`, which has no
 * knowledge of the variant's `allow_backorder`. A table CHECK cannot express
 * "block oversell only for non-backorder variants". So the oversell guard moves
 * OUT of the schema and INTO the reserve path's `WHERE` clause (CM-08), where the
 * caller knows the variant's flags and the guarded `UPDATE ... WHERE
 * (stocked - reserved) >= n` is an atomic, conditional backstop. Until CM-08
 * reworks the reserve heart, the OLD guarded decrement (002) still protects the
 * managed-no-backorder case; this migration only relaxes the schema.
 *
 * Forward-only evolution: `006` drops what `001` added. The non-negativity
 * floors (`stocked >= 0`, `reserved >= 0`) stay INTACT — only the
 * reserved<=stocked RELATION is relaxed. The GENERATED `available_quantity`
 * column is unchanged and may now go negative; we add NO `available >= 0` CHECK
 * and NO floor (negative availability IS the backorder-depth source of truth).
 *
 * Idempotent (ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS): re-running
 * provisionTenant / migrateAllTenants is a no-op once applied. BARE table names;
 * the runner injects `SET LOCAL search_path = <tg_id>, ext`.
 */
export const inventoryPolicy: Migration = {
  id: '006_inventory_policy',
  up: async (tx) => {
    // (1) The two per-variant purchasability flags (Medusa parity, on the
    // sellable/merchandising unit — NOT on inventory_item / inventory_level).
    await tx`
      ALTER TABLE "product_variant"
        ADD COLUMN IF NOT EXISTS "manage_inventory" boolean NOT NULL DEFAULT true
    `;
    await tx`
      ALTER TABLE "product_variant"
        ADD COLUMN IF NOT EXISTS "allow_backorder" boolean NOT NULL DEFAULT false
    `;

    // (2) Drop the hard oversell CHECK so backorder can reserve beyond stock.
    // The guard moves into the reserve path's WHERE clause (CM-08), conditional
    // on the variant flags. The non-negativity floors below are KEPT.
    await tx`
      ALTER TABLE "inventory_level"
        DROP CONSTRAINT IF EXISTS "inventory_level_reserved_lte_stocked_check"
    `;
  },
};
