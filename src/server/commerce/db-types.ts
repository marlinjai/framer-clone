// src/server/commerce/db-types.ts
//
// CM-05 — the typed `CommerceDB` `Database` interface that every commerce repo
// (CM-06..CM-09) is generic over: `Kysely<CommerceDB>`. It is the contract the
// whole W2 repo-port wave builds on.
//
// PUBLIC-PREFIX DISCIPLINE (the whole point — see the package's
// database-shape.ts header, mirrored locally below). Inside a `tenantDb(...)`
// query Kysely's `withSchema` rewrites every BARE table identifier to the tenant
// schema (`tg_<id>.<table>`). A GLOBAL ("control") table therefore MUST be
// referenced with an explicit `public.` prefix, or it silently resolves against
// the tenant schema — and if a same-named DECOY exists there, that is a
// cross-tenant read. We make forgetting the prefix a COMPILE error by
// registering:
//   - global tables under their `public.<name>` key ONLY  (a {@link GlobalKey}),
//   - per-tenant commerce tables under their BARE key ONLY (a {@link TenantKey}).
// The two namespaces are disjoint. A consumer who writes
// `.selectFrom('tenant_groups')` inside a tenant query gets "no such table key";
// they are forced to write `.selectFrom('public.tenant_groups')`. The 19
// commerce tables, conversely, exist ONLY as bare keys, so
// `.selectFrom('product')` compiles and resolves to `tg_<id>.product`.
//
// REGENERATION. This file is hand-reconciled but kept in sync with the CM-04
// per-tenant DDL (`migrations/tenant/{000_enums..005_minimal_orders}.ts`) via
// `pnpm db:codegen-commerce` (scripts/commerce-codegen.ts): it provisions a
// throwaway `tg_<id>` schema in a container, runs kysely-codegen against it, and
// post-processes the output into the discipline shape below. The COMMITTED file
// is the contract; the script documents how to refresh it when the DDL changes.
// db-types.ts is a PURE TYPE module (no runtime), so it needs no `server-only`
// and adds zero bytes to the `next build` bundle.
//
// FAITHFULNESS TO THE DDL (where kysely-codegen alone would be wrong):
//   - `inventory_level.available_quantity` is `INTEGER NOT NULL GENERATED ALWAYS
//     AS (stocked_quantity - reserved_quantity) STORED` -> `Generated<number>`:
//     DB-maintained, NEVER inserted/updated. (kysely-codegen DOES detect this.)
//   - `product_variant.option_signature` is a NULLABLE `TEXT` column maintained
//     EXCLUSIVELY by the BEFORE/AFTER triggers in 003_catalog -> wrapped in
//     `Generated<...>` by hand so Kysely never tries to INSERT/UPDATE it
//     (kysely-codegen CANNOT see trigger maintenance and would emit a plain
//     insertable `string | null`). Nullable is preserved: a bare variant with no
//     option values has a NULL signature (see provision.itest.ts).
//   - every column with a DB DEFAULT (CURRENT_TIMESTAMP, 0, 'draft', false, ...)
//     is `Generated<>` so it is optional on INSERT.
//   - money columns are INTEGER minor units -> `number`; `tax_rate` is integer
//     basis points -> `number`. Enum columns are their exact string-union types.

import type { ColumnType, Generated } from 'kysely';

// The package's brand types for the two key namespaces (re-used per the CM-05
// spec: GlobalKey forces `public.<name>` keys, TenantKey forbids a `public.`
// prefix from masquerading as a bare tenant table). Mirrors
// auth-brain/packages/tenant-db/src/database-shape.ts.
import type { GlobalKey, TenantKey } from '@marlinjai/tenant-db';

// --- kysely-codegen scalar aliases (verbatim from its postgres preset) -------

/**
 * A `TIMESTAMP(3)` / `timestamptz` column. Selected as a `Date`; accepted as a
 * `Date` or ISO string on write. Matches kysely-codegen's default
 * `--date-parser timestamp` output.
 */
export type Timestamp = ColumnType<Date, Date | string, Date | string>;

// --- commerce enum types (000_enums) -----------------------------------------
// String unions, value sets ported VERBATIM from 000_enums.ts (do not reorder /
// invent values: the order matches pg_enum.enumsortorder).

export type StockMovementType =
  | 'receive'
  | 'reserve'
  | 'release'
  | 'fulfill'
  | 'adjust'
  | 'transfer';
export type ProductStatus = 'draft' | 'published';
export type PriceListStatus = 'draft' | 'active';
export type PriceListType = 'override' | 'sale';
export type OrderStatus = 'pending' | 'confirmed' | 'cancelled';
export type CustomerType = 'b2c' | 'b2b';
export type NetOrGross = 'net' | 'gross';
export type VariantRefSource = 'none' | 'datatable' | 'owned';
export type TaxTreatment =
  | 'standard'
  | 'reduced'
  | 'zero'
  | 'reverse_charge'
  | 'kleinunternehmer';

// =============================================================================
// GLOBAL tables — registered under `public.<name>` keys ONLY.
// =============================================================================

/**
 * `public.tenant_groups` — the runner's registry (one row per `tg_<id>`
 * schema), owned by @marlinjai/tenant-db's `002_tenant_groups` public
 * migration. The commerce layer reads it (resolve schema/status for a
 * tenant-group). Shape mirrors the package DDL exactly:
 *   id uuid PK DEFAULT ext.gen_uuid_v7(), slug text UNIQUE, schema_name text
 *   UNIQUE, status text DEFAULT 'provisioning', created_at/updated_at timestamptz
 *   DEFAULT now().
 * (The package also exports an example `TenantGroupsTable`, but it omits
 * `updated_at`; this local interface reflects the real shipped DDL.)
 */
export interface TenantGroupsTable {
  id: Generated<string>;
  slug: string;
  schema_name: string;
  status: Generated<'provisioning' | 'active' | 'suspended'>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

// =============================================================================
// PER-TENANT commerce tables — registered under BARE keys ONLY.
// Columns ported 1:1 from migrations/tenant/{001..005}.
// =============================================================================

/** 001_inventory_ledger — owned inventory item (SKU-bridged to variants). */
export interface InventoryItemTable {
  id: string;
  sku: string;
  title: string | null;
  length_mm: number | null;
  width_mm: number | null;
  height_mm: number | null;
  weight_g: number | null;
  created_at: Generated<Timestamp>;
  updated_at: Timestamp;
  deleted_at: Timestamp | null;
}

/** 001_inventory_ledger — a physical stock location. */
export interface StockLocationTable {
  id: string;
  name: string;
  created_at: Generated<Timestamp>;
  updated_at: Timestamp;
}

/**
 * 001_inventory_ledger — per-(item, location) stock level. `available_quantity`
 * is GENERATED ALWAYS (stocked - reserved) STORED: read-only, never written.
 */
export interface InventoryLevelTable {
  id: string;
  inventory_item_id: string;
  location_id: string;
  stocked_quantity: Generated<number>;
  reserved_quantity: Generated<number>;
  version: Generated<number>;
  // GENERATED ALWAYS AS (stocked_quantity - reserved_quantity) STORED.
  available_quantity: Generated<number>;
  created_at: Generated<Timestamp>;
  updated_at: Timestamp;
}

/** 001_inventory_ledger — append-only stock movement ledger (no updated_at). */
export interface StockMovementTable {
  id: string;
  inventory_item_id: string;
  location_id: string;
  movement_type: StockMovementType;
  quantity: number;
  request_id: string;
  ref_type: string | null;
  ref_id: string | null;
  transfer_group_id: string | null;
  created_at: Generated<Timestamp>;
}

/** 002_guarded_reservation — soft stock reservation. */
export interface ReservationTable {
  id: string;
  line_item_id: string | null;
  location_id: string;
  quantity: number;
  request_id: string;
  created_at: Generated<Timestamp>;
  updated_at: Timestamp;
}

/** 002_guarded_reservation — per-workspace default fulfillment location. */
export interface FulfillmentLocationDefaultTable {
  workspace_id: string;
  location_id: string;
  created_at: Generated<Timestamp>;
  updated_at: Timestamp;
}

/** 003_catalog (+ 004 tax_class) — product. */
export interface ProductTable {
  id: string;
  title: string;
  handle: string;
  description: string | null;
  status: Generated<ProductStatus>;
  created_at: Generated<Timestamp>;
  updated_at: Timestamp;
  deleted_at: Timestamp | null;
  // Added in 004_pricing_and_tax (classification string, not a rate).
  tax_class: string | null;
}

/** 003_catalog — product option (e.g. "Size"). */
export interface ProductOptionTable {
  id: string;
  product_id: string;
  title: string;
  created_at: Generated<Timestamp>;
  updated_at: Timestamp;
  deleted_at: Timestamp | null;
}

/** 003_catalog — product option value (e.g. "Large"). */
export interface ProductOptionValueTable {
  id: string;
  option_id: string;
  value: string;
  created_at: Generated<Timestamp>;
  updated_at: Timestamp;
  deleted_at: Timestamp | null;
}

/**
 * 003_catalog (+ 004 tax_class) — product variant. `option_signature` is
 * NULLABLE and maintained EXCLUSIVELY by the BEFORE/AFTER triggers; wrapped in
 * `Generated<>` so it is never inserted/updated by app code.
 */
export interface ProductVariantTable {
  id: string;
  product_id: string;
  title: string | null;
  sku: string | null;
  barcode: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Timestamp;
  deleted_at: Timestamp | null;
  // Trigger-maintained (003_catalog). Nullable: a bare variant has NULL.
  option_signature: Generated<string | null>;
  // Added in 004_pricing_and_tax (per-variant override of product.tax_class).
  tax_class: string | null;
}

/** 003_catalog — the variant<->option-value matrix (composite PK). */
export interface ProductVariantOptionTable {
  variant_id: string;
  option_id: string;
  option_value_id: string;
}

/** 004_pricing_and_tax — one price set per variant. */
export interface PriceSetTable {
  id: string;
  variant_id: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Timestamp;
}

/** 004_pricing_and_tax — a price (amount = INTEGER minor units / cents). */
export interface PriceTable {
  id: string;
  price_set_id: string;
  price_list_id: string | null;
  currency_code: string;
  amount: number;
  min_quantity: number | null;
  max_quantity: number | null;
  created_at: Generated<Timestamp>;
  updated_at: Timestamp;
}

/** 004_pricing_and_tax — price rule (attribute match). */
export interface PriceRuleTable {
  id: string;
  price_id: string;
  attribute: string;
  value: string;
  operator: Generated<string>;
  priority: Generated<number>;
  created_at: Generated<Timestamp>;
  updated_at: Timestamp;
}

/** 004_pricing_and_tax — price list (override / sale window). */
export interface PriceListTable {
  id: string;
  title: string | null;
  status: Generated<PriceListStatus>;
  type: Generated<PriceListType>;
  starts_at: Timestamp | null;
  ends_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Timestamp;
}

/**
 * 004_pricing_and_tax (+ 005 order_id) — credit note (Storno / Gutschrift).
 * Append-only, no updated_at. amount = INTEGER minor units (cents).
 */
export interface CreditNoteTable {
  id: string;
  corrected_ref: string | null;
  reason: string | null;
  currency_code: string;
  amount: number;
  created_at: Generated<Timestamp>;
  // Added in 005_minimal_orders (hard FK to "order").
  order_id: string | null;
}

/** 004_pricing_and_tax — credit-note reference (append-only, no updated_at). */
export interface CreditNoteRefTable {
  id: string;
  credit_note_id: string;
  ref_type: string;
  ref_id: string;
  created_at: Generated<Timestamp>;
}

/**
 * 005_minimal_orders — order ("order" is a reserved word; key stays bare). Full
 * German order-level tax model; all money columns are INTEGER minor units.
 */
export interface OrderTable {
  id: string;
  order_number: string;
  request_id: string;
  status: Generated<OrderStatus>;
  currency_code: string;
  tax_region: string;
  vat_id: string | null;
  customer_type: Generated<CustomerType>;
  reverse_charge: Generated<boolean>;
  net_or_gross: Generated<NetOrGross>;
  kleinunternehmer: Generated<boolean>;
  tax_note: string | null;
  subtotal: number;
  tax_amount: number;
  total: number;
  created_at: Generated<Timestamp>;
  updated_at: Timestamp;
}

/**
 * 005_minimal_orders — order line item (variant snapshot + tax treatment).
 * Append-only, no updated_at. `tax_rate` is integer BASIS POINTS (1900 = 19%).
 */
export interface OrderLineItemTable {
  id: string;
  order_id: string;
  variant_title: string | null;
  variant_sku: string | null;
  unit_price: number;
  quantity: number;
  subtotal: number;
  tax_class: string | null;
  tax_rate: number;
  tax_amount: number;
  tax_treatment: TaxTreatment;
  variant_ref: string | null;
  variant_ref_source: Generated<VariantRefSource>;
  created_at: Generated<Timestamp>;
}

// =============================================================================
// The Database interface. GLOBAL keys are `public.`-qualified; the 19 commerce
// tables are BARE. The two namespaces are disjoint by construction.
// =============================================================================

export interface CommerceDB {
  // --- global tables (public.<name> keys ONLY) ---
  'public.tenant_groups': TenantGroupsTable;

  // --- per-tenant commerce tables (bare keys ONLY) ---
  product: ProductTable;
  product_option: ProductOptionTable;
  product_option_value: ProductOptionValueTable;
  product_variant: ProductVariantTable;
  product_variant_option: ProductVariantOptionTable;
  price_set: PriceSetTable;
  price: PriceTable;
  price_rule: PriceRuleTable;
  price_list: PriceListTable;
  credit_note: CreditNoteTable;
  credit_note_ref: CreditNoteRefTable;
  inventory_item: InventoryItemTable;
  stock_location: StockLocationTable;
  inventory_level: InventoryLevelTable;
  stock_movement: StockMovementTable;
  reservation: ReservationTable;
  fulfillment_location_default: FulfillmentLocationDefaultTable;
  order: OrderTable;
  order_line_item: OrderLineItemTable;
}

// --- compile-time discipline guards (use the package's brand types) ----------
// These aliases partition CommerceDB's keys by namespace using GlobalKey /
// TenantKey and prove (at compile time, consumed by type-discipline.test-d.ts)
// that the two halves stay disjoint: a global is reachable ONLY via its
// `public.` key, a commerce table ONLY via its bare key.

/** The `public.`-qualified global keys of CommerceDB (a {@link GlobalKey} subset). */
export type CommerceGlobalKey = Extract<keyof CommerceDB, GlobalKey>;

/** The bare per-tenant keys of CommerceDB (a {@link TenantKey} subset). */
export type CommerceTenantKey = TenantKey<Extract<keyof CommerceDB, string>>;
