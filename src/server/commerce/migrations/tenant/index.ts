import type { MigrationSet } from '@marlinjai/tenant-db';
import { enums } from './000_enums';
import { inventoryLedger } from './001_inventory_ledger';
import { guardedReservation } from './002_guarded_reservation';
import { catalog } from './003_catalog';
import { pricingAndTax } from './004_pricing_and_tax';
import { minimalOrders } from './005_minimal_orders';

/**
 * CM-04 — `COMMERCE_TENANT_MIGRATIONS`: the per-tenant (`tg_<id>`) commerce
 * migration set, supplied to `provisionTenant` / `migrateAllTenants` (it REPLACES
 * the package's example workspaces/memberships/outbox set).
 *
 * The runner runs each `up` inside a transaction that already holds
 * `SET LOCAL search_path = <tg_id>, ext`, so every body uses BARE table names and
 * the structures land in the target schema. Each per-tenant schema is therefore
 * structurally identical and self-contained: `pg_dump -n tg_x` extracts one
 * customer with its own enums, constraints, triggers, sequence, and migration
 * history.
 *
 * ORDER MATTERS (every type / FK target / referenced table must exist before
 * use):
 *   000_enums              — the 9 enum TYPES (no table references them yet)
 *   001_inventory_ledger   — inventory_item, stock_location, inventory_level
 *                            (GENERATED available_quantity), stock_movement
 *   002_guarded_reservation— reservation, fulfillment_location_default, the
 *                            deferred transfer-balance constraint trigger
 *   003_catalog            — product graph, composite FK, option_signature triggers
 *   004_pricing_and_tax    — pricing graph, credit_note(_ref), money/currency CHECKs
 *   005_minimal_orders     — order, order_line_item, order_number_seq, the
 *                            accounting-identity CHECK, the credit_note->order FK
 */
export const COMMERCE_TENANT_MIGRATIONS: MigrationSet = [
  enums,
  inventoryLedger,
  guardedReservation,
  catalog,
  pricingAndTax,
  minimalOrders,
];
