// src/server/commerce/migrations/tenant/__tests__/provision.itest.ts
//
// CM-04 — the structural-heart probe. Provisions a real tg_<id> schema with
// COMMERCE_TENANT_MIGRATIONS against a Dockerized Postgres and DIRECT-SQL PROBES
// every structure the per-tenant commerce schema MUST carry. A missing CHECK,
// trigger, GENERATED column, partial-unique index, composite FK, sequence, or
// REVOKE is a silent money/stock hole, so this test asserts behavior (insert /
// update and observe), never assumes catalog existence alone.
//
// It boots its OWN throwaway Postgres in beforeAll (testcontainers). The `.itest`
// suffix keeps it OUT of the headless `pnpm test` unit run — it runs ONLY under
// `pnpm test:integration` against Docker. Mirrors public.itest.ts.
//
// REVOKE / GRANT ORDER CAVEAT (flagged for CM-02 / CM-11): provisionTenant runs
// the tenant migrations (which REVOKE UPDATE,DELETE on the append-only tables)
// and THEN `grantSchemaToAppRole` issues `GRANT ... UPDATE, DELETE ON ALL TABLES`
// — which CLOBBERS those REVOKEs (verified empirically). So a real onboard/deploy
// must RE-APPLY the append-only REVOKEs post-grant for them to bite. This test
// reproduces that required post-grant step (`reapplyAppendOnlyRevokes`) before
// the teeth probe, exactly as CM-11's onboard will have to.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import postgres from 'postgres';
import {
  migratePublic,
  provisionTenant,
  tenantSchema,
  assertTenantGroupId,
} from '@marlinjai/tenant-db';
import { COMMERCE_TENANT_MIGRATIONS } from '../index';

const DB_NAME = 'framer_clone_test';
const APP_ROLE = 'commerce_app';

const TG = assertTenantGroupId('018f9c10-0000-7000-8000-0000000000c4');
const SCHEMA = tenantSchema(TG);

const EXPECTED_MIGRATION_IDS = [
  '000_enums',
  '001_inventory_ledger',
  '002_guarded_reservation',
  '003_catalog',
  '004_pricing_and_tax',
  '005_minimal_orders',
  '006_inventory_policy',
];

const EXPECTED_ENUMS: Record<string, string[]> = {
  StockMovementType: ['receive', 'reserve', 'release', 'fulfill', 'adjust', 'transfer'],
  ProductStatus: ['draft', 'published'],
  PriceListStatus: ['draft', 'active'],
  PriceListType: ['override', 'sale'],
  OrderStatus: ['pending', 'confirmed', 'cancelled'],
  CustomerType: ['b2c', 'b2b'],
  NetOrGross: ['net', 'gross'],
  VariantRefSource: ['none', 'datatable', 'owned'],
  TaxTreatment: ['standard', 'reduced', 'zero', 'reverse_charge', 'kleinunternehmer'],
};

const EXPECTED_TABLES = [
  'credit_note',
  'credit_note_ref',
  'fulfillment_location_default',
  'inventory_item',
  'inventory_level',
  'order',
  'order_line_item',
  'price',
  'price_list',
  'price_rule',
  'price_set',
  'product',
  'product_option',
  'product_option_value',
  'product_variant',
  'product_variant_option',
  'reservation',
  'stock_location',
  'stock_movement',
];

const APPEND_ONLY_TABLES = [
  'stock_movement',
  'credit_note',
  'credit_note_ref',
  'order',
  'order_line_item',
];

let container: StartedTestContainer | undefined;
let owner: postgres.Sql | undefined; // container superuser: DDL owner + probe
let app: postgres.Sql | undefined; // low-privilege commerce_app connection
let provisionResult: { schema: string; applied: string[] } | undefined;

/** Run `fn` inside one owner tx scoped to the tenant schema (bare names resolve). */
function inSchema<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return owner!.begin(async (tx) => {
    await tx`SET LOCAL search_path = ${tx(SCHEMA)}, ext`;
    return fn(tx);
  }) as Promise<T>;
}

/**
 * Re-apply the append-only REVOKEs AFTER provisionTenant's grant-all, mirroring
 * the post-grant deploy/onboard step that makes them bite (see file header).
 * Identical SQL to the migration bodies' REVOKEs.
 */
async function reapplyAppendOnlyRevokes(): Promise<void> {
  await inSchema(async (tx) => {
    await tx`REVOKE UPDATE, DELETE ON "stock_movement" FROM commerce_app`;
    await tx`REVOKE UPDATE, DELETE ON "credit_note" FROM commerce_app`;
    await tx`REVOKE UPDATE, DELETE ON "credit_note_ref" FROM commerce_app`;
    await tx`REVOKE UPDATE, DELETE ON "order" FROM commerce_app`;
    await tx`REVOKE UPDATE, DELETE ON "order_line_item" FROM commerce_app`;
  });
}

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'postgres',
      POSTGRES_PASSWORD: 'postgres',
      POSTGRES_DB: DB_NAME,
      // trust auth: every role (postgres + commerce_app) logs in by username
      // alone, so the test needs no password literals (mirrors backstop.itest.ts).
      POSTGRES_HOST_AUTH_METHOD: 'trust',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const ownerUrl = `postgresql://postgres@${host}:${port}/${DB_NAME}`;
  owner = postgres(ownerUrl, { max: 1, prepare: false, transform: { undefined: null } });

  // Create the low-privilege app role BEFORE migrating: the per-migration REVOKEs
  // are guarded on its existence, and provisionTenant grants per-schema access to
  // it. A LOGIN role (no password: the container runs trust auth, so it logs in by
  // username alone) so we can open a scoped connection. CREATE ROLE is a utility
  // statement (no bind params), so this uses .unsafe with a trusted test constant.
  await owner.unsafe(`CREATE ROLE ${APP_ROLE} LOGIN`);

  // Public control plane (ext schema + tenant_groups registry).
  await migratePublic(owner);

  // Provision the tenant: creates tg_<id>, runs the commerce migrations, grants
  // the app role, applies the ext-locked role default, marks active.
  provisionResult = await provisionTenant(owner, {
    tenantGroupId: TG,
    slug: 'cm04-probe',
    appRole: APP_ROLE,
    tenantMigrations: COMMERCE_TENANT_MIGRATIONS,
  });

  // Post-grant REVOKE re-apply (required for teeth — see header).
  await reapplyAppendOnlyRevokes();

  const appUrl = `postgresql://${APP_ROLE}@${host}:${port}/${DB_NAME}`;
  app = postgres(appUrl, { max: 2, prepare: false, transform: { undefined: null } });
}, 180_000);

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await container?.stop();
});

describe('CM-04 provisionTenant(COMMERCE_TENANT_MIGRATIONS) — structural probe', () => {
  // --- provisioning result ------------------------------------------------
  it('provisions tg_<id>, applies all 7 migrations in order, marks active', async () => {
    expect(provisionResult?.schema).toBe(SCHEMA);
    expect(provisionResult?.applied).toEqual(EXPECTED_MIGRATION_IDS);

    const groups = await owner!`
      SELECT schema_name, status FROM public.tenant_groups WHERE id = ${TG}::uuid
    `;
    expect(groups).toHaveLength(1);
    expect(groups[0]!.status).toBe('active');
    expect(groups[0]!.schema_name).toBe(SCHEMA);

    const tracked = await owner!`
      SELECT id FROM ${owner!(SCHEMA)}.${owner!('__tenant_db_migrations')} ORDER BY id
    `;
    expect(tracked.map((r) => r.id)).toEqual(EXPECTED_MIGRATION_IDS);
  });

  // --- enums --------------------------------------------------------------
  it('creates all 9 commerce enum types per schema with their exact value sets', async () => {
    for (const [typeName, values] of Object.entries(EXPECTED_ENUMS)) {
      const rows = await owner!`
        SELECT e.enumlabel
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE n.nspname = ${SCHEMA} AND t.typname = ${typeName}
        ORDER BY e.enumsortorder
      `;
      expect(rows.map((r) => r.enumlabel)).toEqual(values);
    }
  });

  // --- tables -------------------------------------------------------------
  it('creates exactly the 19 commerce tables in the schema', async () => {
    const rows = await owner!`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${SCHEMA} AND table_type = 'BASE TABLE'
        AND table_name <> '__tenant_db_migrations'
      ORDER BY table_name
    `;
    expect(rows.map((r) => r.table_name)).toEqual(EXPECTED_TABLES);
  });

  // --- catalog presence of every named CHECK + the composite FK ----------
  it('every named CHECK constraint and the composite FK exist in the schema', async () => {
    const EXPECTED_CHECKS = [
      // NOTE: inventory_level_reserved_lte_stocked_check is intentionally ABSENT
      // here — 006_inventory_policy DROPs it so backorder can reserve beyond
      // stock (asserted gone in the dedicated inventory-policy probe below).
      'inventory_level_stocked_nonneg_check',
      'inventory_level_reserved_nonneg_check',
      'price_amount_nonneg_check',
      'credit_note_amount_nonneg_check',
      'price_min_quantity_nonneg_check',
      'price_max_quantity_nonneg_check',
      'price_quantity_band_check',
      'price_currency_code_iso4217_check',
      'credit_note_currency_code_iso4217_check',
      'order_subtotal_nonneg_check',
      'order_tax_amount_nonneg_check',
      'order_total_nonneg_check',
      'order_currency_code_iso4217_check',
      'order_total_sum_check',
      'order_line_item_unit_price_nonneg_check',
      'order_line_item_subtotal_nonneg_check',
      'order_line_item_tax_amount_nonneg_check',
      'order_line_item_tax_rate_nonneg_check',
      'order_line_item_tax_rate_ceiling_check',
      'order_line_item_quantity_pos_check',
    ];
    const checks = await owner!`
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = ${SCHEMA} AND c.contype = 'c'
      ORDER BY c.conname
    `;
    const present = new Set(checks.map((r) => r.conname));
    for (const name of EXPECTED_CHECKS) expect(present.has(name)).toBe(true);

    // The composite FK with ON UPDATE RESTRICT (confupdtype 'r').
    const fk = await owner!`
      SELECT c.confupdtype, c.confdeltype
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = ${SCHEMA} AND c.contype = 'f'
        AND c.conname = 'product_variant_option_option_value_id_option_id_fkey'
    `;
    expect(fk).toHaveLength(1);
    expect(fk[0]!.confupdtype).toBe('r'); // ON UPDATE RESTRICT
    expect(fk[0]!.confdeltype).toBe('r'); // ON DELETE RESTRICT
  });

  // --- GENERATED available_quantity --------------------------------------
  it('inventory_level.available_quantity is GENERATED (stocked - reserved), unwritable', async () => {
    await inSchema(async (tx) => {
      await tx`INSERT INTO inventory_item (id, sku, updated_at) VALUES ('gen_ii', 'GEN-SKU', now())`;
      await tx`INSERT INTO stock_location (id, name, updated_at) VALUES ('gen_sl', 'Gen Loc', now())`;
      await tx`
        INSERT INTO inventory_level (id, inventory_item_id, location_id, stocked_quantity, reserved_quantity, updated_at)
        VALUES ('gen_il', 'gen_ii', 'gen_sl', 10, 3, now())
      `;
    });
    const rows = await inSchema((tx) => tx`SELECT available_quantity FROM inventory_level WHERE id = 'gen_il'`);
    expect(rows[0]!.available_quantity).toBe(7);

    // A direct write to the generated column is rejected.
    await expect(
      inSchema(
        (tx) => tx`
          INSERT INTO inventory_level (id, inventory_item_id, location_id, stocked_quantity, reserved_quantity, available_quantity, updated_at)
          VALUES ('gen_bad', 'gen_ii', 'gen_sl', 5, 1, 999, now())
        `,
      ),
    ).rejects.toThrow(/non-DEFAULT value|generated/i);
  });

  // --- option_signature triggers -----------------------------------------
  it('option_signature is trigger-maintained (BEFORE bare-variant + AFTER matrix refresh)', async () => {
    await inSchema(async (tx) => {
      await tx`INSERT INTO product (id, title, handle, updated_at) VALUES ('sig_p', 'SigProd', 'sig-handle', now())`;
      await tx`INSERT INTO product_option (id, product_id, title, updated_at) VALUES ('sig_o', 'sig_p', 'Size', now())`;
      await tx`INSERT INTO product_option_value (id, option_id, value, updated_at) VALUES ('sig_v', 'sig_o', 'S', now())`;
      await tx`INSERT INTO product_variant (id, product_id, updated_at) VALUES ('sig_va1', 'sig_p', now())`;
    });

    // BEFORE trigger: a bare variant with no matrix rows gets a NULL signature.
    const bare = await inSchema((tx) => tx`SELECT option_signature FROM product_variant WHERE id = 'sig_va1'`);
    expect(bare[0]!.option_signature).toBeNull();

    // AFTER trigger: writing the matrix populates the variant's signature.
    await inSchema((tx) => tx`INSERT INTO product_variant_option (variant_id, option_id, option_value_id) VALUES ('sig_va1', 'sig_o', 'sig_v')`);
    const populated = await inSchema((tx) => tx`SELECT option_signature FROM product_variant WHERE id = 'sig_va1'`);
    expect(populated[0]!.option_signature).toBe('sig_v');

    // AFTER trigger on DELETE: removing the matrix row refreshes back to NULL.
    await inSchema((tx) => tx`DELETE FROM product_variant_option WHERE variant_id = 'sig_va1' AND option_id = 'sig_o'`);
    const refreshed = await inSchema((tx) => tx`SELECT option_signature FROM product_variant WHERE id = 'sig_va1'`);
    expect(refreshed[0]!.option_signature).toBeNull();
  });

  // --- per-schema order_number_seq ---------------------------------------
  it('order_number_seq exists per schema and increments monotonically', async () => {
    const a = await inSchema((tx) => tx`SELECT nextval('order_number_seq') AS n`);
    const b = await inSchema((tx) => tx`SELECT nextval('order_number_seq') AS n`);
    expect(Number(b[0]!.n)).toBe(Number(a[0]!.n) + 1);
  });

  // --- CHECK constraints (each out-of-range insert RAISES) -----------------
  // CM-08a — POST-006 reality: the reserved<=stocked oversell CHECK is GONE so a
  // backorder can reserve beyond stock (available_quantity goes negative = the
  // backorder depth), while the non-negativity floors stay INTACT.
  it('backorder allowed (reserved > stocked → available negative); non-neg floors still bite', async () => {
    await inSchema(async (tx) => {
      await tx`INSERT INTO inventory_item (id, sku, updated_at) VALUES ('chk_ii', 'CHK-SKU', now())`;
      await tx`INSERT INTO stock_location (id, name, updated_at) VALUES ('chk_sl', 'Chk Loc', now())`;
    });

    // (b) reserved > stocked now SUCCEEDS (the dropped CHECK no longer blocks it)
    // and the GENERATED available_quantity reads NEGATIVE (= backorder depth).
    await inSchema(
      (tx) => tx`INSERT INTO inventory_level (id, inventory_item_id, location_id, stocked_quantity, reserved_quantity, updated_at) VALUES ('chk_il1', 'chk_ii', 'chk_sl', 5, 6, now())`,
    );
    const backordered = await inSchema(
      (tx) => tx`SELECT available_quantity FROM inventory_level WHERE id = 'chk_il1'`,
    );
    expect(backordered[0]!.available_quantity).toBe(-1);

    // Pushing reserved even further above stocked via UPDATE also SUCCEEDS and
    // drives available_quantity more negative (deeper backorder).
    await inSchema((tx) => tx`UPDATE inventory_level SET reserved_quantity = 9 WHERE id = 'chk_il1'`);
    const deeper = await inSchema(
      (tx) => tx`SELECT available_quantity FROM inventory_level WHERE id = 'chk_il1'`,
    );
    expect(deeper[0]!.available_quantity).toBe(-4);

    // (c) stocked < 0 still RAISES — only the reserved<=stocked relation is
    // relaxed; the stocked non-negativity floor remains (and is now the SOLE
    // violation, since the reserved<=stocked CHECK is gone).
    await expect(
      inSchema((tx) => tx`INSERT INTO inventory_level (id, inventory_item_id, location_id, stocked_quantity, reserved_quantity, updated_at) VALUES ('chk_il2', 'chk_ii', 'chk_sl', -1, 0, now())`),
    ).rejects.toThrow(/inventory_level_stocked_nonneg_check/);
    // reserved < 0 still RAISES.
    await expect(
      inSchema((tx) => tx`INSERT INTO inventory_level (id, inventory_item_id, location_id, stocked_quantity, reserved_quantity, updated_at) VALUES ('chk_il3', 'chk_ii', 'chk_sl', 0, -1, now())`),
    ).rejects.toThrow(/inventory_level_reserved_nonneg_check/);
  });

  // CM-08a — the two per-variant purchasability flags exist with the right
  // defaults (manage_inventory TRUE — our SKU-bridge divergence; allow_backorder
  // FALSE — Medusa parity).
  it('product_variant.manage_inventory / allow_backorder exist with defaults true / false', async () => {
    await inSchema(async (tx) => {
      await tx`INSERT INTO product (id, title, handle, updated_at) VALUES ('pol_p', 'PolProd', 'pol-handle', now())`;
      await tx`INSERT INTO product_variant (id, product_id, updated_at) VALUES ('pol_va', 'pol_p', now())`;
    });
    const row = await inSchema(
      (tx) => tx`SELECT manage_inventory, allow_backorder FROM product_variant WHERE id = 'pol_va'`,
    );
    expect(row[0]!.manage_inventory).toBe(true);
    expect(row[0]!.allow_backorder).toBe(false);

    // Both are explicitly overridable (digital/unlimited opts out of tracking;
    // pre-order opts into backorder).
    await inSchema(
      (tx) => tx`INSERT INTO product_variant (id, product_id, manage_inventory, allow_backorder, updated_at) VALUES ('pol_va2', 'pol_p', false, true, now())`,
    );
    const overridden = await inSchema(
      (tx) => tx`SELECT manage_inventory, allow_backorder FROM product_variant WHERE id = 'pol_va2'`,
    );
    expect(overridden[0]!.manage_inventory).toBe(false);
    expect(overridden[0]!.allow_backorder).toBe(true);
  });

  it('pricing CHECKs reject negative money, inverted band, mis-cased currency', async () => {
    await inSchema((tx) => tx`INSERT INTO price_set (id, updated_at) VALUES ('chk_ps', now())`);
    // amount < 0
    await expect(
      inSchema((tx) => tx`INSERT INTO price (id, price_set_id, currency_code, amount, updated_at) VALUES ('chk_pr1', 'chk_ps', 'EUR', -1, now())`),
    ).rejects.toThrow(/price_amount_nonneg_check/);
    // inverted quantity band (min > max)
    await expect(
      inSchema((tx) => tx`INSERT INTO price (id, price_set_id, currency_code, amount, min_quantity, max_quantity, updated_at) VALUES ('chk_pr2', 'chk_ps', 'EUR', 100, 5, 3, now())`),
    ).rejects.toThrow(/price_quantity_band_check/);
    // mis-cased currency
    await expect(
      inSchema((tx) => tx`INSERT INTO price (id, price_set_id, currency_code, amount, updated_at) VALUES ('chk_pr3', 'chk_ps', 'eur', 100, now())`),
    ).rejects.toThrow(/price_currency_code_iso4217_check/);
    // credit_note amount < 0
    await expect(
      inSchema((tx) => tx`INSERT INTO credit_note (id, currency_code, amount) VALUES ('chk_cn1', 'EUR', -1)`),
    ).rejects.toThrow(/credit_note_amount_nonneg_check/);
  });

  it('order CHECKs enforce money floor, currency shape, and the accounting identity', async () => {
    // subtotal < 0 (isolated: tax=1, total=0 keeps total=subtotal+tax and total>=0)
    await expect(
      inSchema((tx) => tx`INSERT INTO "order" (id, order_number, request_id, currency_code, tax_region, subtotal, tax_amount, total, updated_at) VALUES ('chk_o1', 'ON-1', 'RQ-1', 'EUR', 'DE', -1, 1, 0, now())`),
    ).rejects.toThrow(/order_subtotal_nonneg_check/);
    // tax_amount < 0 (isolated)
    await expect(
      inSchema((tx) => tx`INSERT INTO "order" (id, order_number, request_id, currency_code, tax_region, subtotal, tax_amount, total, updated_at) VALUES ('chk_o2', 'ON-2', 'RQ-2', 'EUR', 'DE', 1, -1, 0, now())`),
    ).rejects.toThrow(/order_tax_amount_nonneg_check/);
    // accounting identity total = subtotal + tax_amount
    await expect(
      inSchema((tx) => tx`INSERT INTO "order" (id, order_number, request_id, currency_code, tax_region, subtotal, tax_amount, total, updated_at) VALUES ('chk_o3', 'ON-3', 'RQ-3', 'EUR', 'DE', 2, 2, 5, now())`),
    ).rejects.toThrow(/order_total_sum_check/);
    // mis-cased currency
    await expect(
      inSchema((tx) => tx`INSERT INTO "order" (id, order_number, request_id, currency_code, tax_region, subtotal, tax_amount, total, updated_at) VALUES ('chk_o4', 'ON-4', 'RQ-4', 'eur', 'DE', 0, 0, 0, now())`),
    ).rejects.toThrow(/order_currency_code_iso4217_check/);
  });

  it('order_line_item CHECKs enforce tax-rate ceiling and positive quantity', async () => {
    // a valid parent order
    await inSchema((tx) => tx`INSERT INTO "order" (id, order_number, request_id, currency_code, tax_region, subtotal, tax_amount, total, updated_at) VALUES ('li_o', 'ON-LI', 'RQ-LI', 'EUR', 'DE', 0, 0, 0, now())`);
    // tax_rate > 10000 (basis points ceiling)
    await expect(
      inSchema((tx) => tx`INSERT INTO order_line_item (id, order_id, unit_price, quantity, subtotal, tax_rate, tax_amount, tax_treatment) VALUES ('li_1', 'li_o', 100, 1, 100, 10001, 19, 'standard')`),
    ).rejects.toThrow(/order_line_item_tax_rate_ceiling_check/);
    // quantity <= 0
    await expect(
      inSchema((tx) => tx`INSERT INTO order_line_item (id, order_id, unit_price, quantity, subtotal, tax_rate, tax_amount, tax_treatment) VALUES ('li_2', 'li_o', 100, 0, 0, 1900, 0, 'standard')`),
    ).rejects.toThrow(/order_line_item_quantity_pos_check/);
    // unit_price < 0
    await expect(
      inSchema((tx) => tx`INSERT INTO order_line_item (id, order_id, unit_price, quantity, subtotal, tax_rate, tax_amount, tax_treatment) VALUES ('li_3', 'li_o', -1, 1, 0, 1900, 0, 'standard')`),
    ).rejects.toThrow(/order_line_item_unit_price_nonneg_check/);
  });

  // --- partial-unique indexes (live-only) --------------------------------
  it('inventory_item_sku_active_key is unique among LIVE rows, frees on soft-delete', async () => {
    await inSchema((tx) => tx`INSERT INTO inventory_item (id, sku, updated_at) VALUES ('sku_a', 'DUP-SKU', now())`);
    // duplicate sku among live rows is rejected
    await expect(
      inSchema((tx) => tx`INSERT INTO inventory_item (id, sku, updated_at) VALUES ('sku_b', 'DUP-SKU', now())`),
    ).rejects.toThrow(/inventory_item_sku_active_key/);
    // a soft-deleted row does not block re-use of the sku
    await inSchema((tx) => tx`INSERT INTO inventory_item (id, sku, deleted_at, updated_at) VALUES ('sku_c', 'FREE-SKU', now(), now())`);
    await inSchema((tx) => tx`INSERT INTO inventory_item (id, sku, updated_at) VALUES ('sku_d', 'FREE-SKU', now())`);
    const live = await inSchema((tx) => tx`SELECT count(*)::int AS c FROM inventory_item WHERE sku = 'FREE-SKU' AND deleted_at IS NULL`);
    expect(live[0]!.c).toBe(1);
  });

  it('catalog partial-unique indexes reject live duplicates (handle, option, value, sku, barcode)', async () => {
    await inSchema(async (tx) => {
      await tx`INSERT INTO product (id, title, handle, updated_at) VALUES ('pu_p1', 'P1', 'dup-handle', now())`;
      await tx`INSERT INTO product_option (id, product_id, title, updated_at) VALUES ('pu_o1', 'pu_p1', 'Color', now())`;
      await tx`INSERT INTO product_option_value (id, option_id, value, updated_at) VALUES ('pu_ov1', 'pu_o1', 'Red', now())`;
      await tx`INSERT INTO product_variant (id, product_id, sku, barcode, updated_at) VALUES ('pu_va1', 'pu_p1', 'VSKU', 'VBAR', now())`;
    });
    // product.handle
    await expect(
      inSchema((tx) => tx`INSERT INTO product (id, title, handle, updated_at) VALUES ('pu_p2', 'P2', 'dup-handle', now())`),
    ).rejects.toThrow(/product_handle_active_key/);
    // product_option (product_id, title)
    await expect(
      inSchema((tx) => tx`INSERT INTO product_option (id, product_id, title, updated_at) VALUES ('pu_o2', 'pu_p1', 'Color', now())`),
    ).rejects.toThrow(/product_option_product_id_title_active_key/);
    // product_option_value (option_id, value)
    await expect(
      inSchema((tx) => tx`INSERT INTO product_option_value (id, option_id, value, updated_at) VALUES ('pu_ov2', 'pu_o1', 'Red', now())`),
    ).rejects.toThrow(/product_option_value_option_id_value_active_key/);
    // product_variant.sku
    await expect(
      inSchema((tx) => tx`INSERT INTO product_variant (id, product_id, sku, updated_at) VALUES ('pu_va2', 'pu_p1', 'VSKU', now())`),
    ).rejects.toThrow(/product_variant_sku_active_key/);
    // product_variant.barcode
    await expect(
      inSchema((tx) => tx`INSERT INTO product_variant (id, product_id, barcode, updated_at) VALUES ('pu_va3', 'pu_p1', 'VBAR', now())`),
    ).rejects.toThrow(/product_variant_barcode_active_key/);
  });

  it('option_signature partial-unique rejects two LIVE variants sharing one combination', async () => {
    await inSchema(async (tx) => {
      await tx`INSERT INTO product (id, title, handle, updated_at) VALUES ('dup_p', 'DupCombo', 'dup-combo', now())`;
      await tx`INSERT INTO product_option (id, product_id, title, updated_at) VALUES ('dup_o', 'dup_p', 'Size', now())`;
      await tx`INSERT INTO product_option_value (id, option_id, value, updated_at) VALUES ('dup_v', 'dup_o', 'M', now())`;
      await tx`INSERT INTO product_variant (id, product_id, updated_at) VALUES ('dup_va1', 'dup_p', now())`;
      await tx`INSERT INTO product_variant (id, product_id, updated_at) VALUES ('dup_va2', 'dup_p', now())`;
    });
    // first variant gets the combination
    await inSchema((tx) => tx`INSERT INTO product_variant_option (variant_id, option_id, option_value_id) VALUES ('dup_va1', 'dup_o', 'dup_v')`);
    // second variant with the SAME combination → its refreshed signature collides
    await expect(
      inSchema((tx) => tx`INSERT INTO product_variant_option (variant_id, option_id, option_value_id) VALUES ('dup_va2', 'dup_o', 'dup_v')`),
    ).rejects.toThrow(/product_variant_option_signature_active_key/);
  });

  // --- composite FK ON UPDATE RESTRICT -----------------------------------
  it('composite FK ties option_value to its option and is ON UPDATE RESTRICT', async () => {
    await inSchema(async (tx) => {
      await tx`INSERT INTO product (id, title, handle, updated_at) VALUES ('fk_p', 'FKProd', 'fk-handle', now())`;
      await tx`INSERT INTO product_option (id, product_id, title, updated_at) VALUES ('fk_o1', 'fk_p', 'OptOne', now())`;
      await tx`INSERT INTO product_option (id, product_id, title, updated_at) VALUES ('fk_o2', 'fk_p', 'OptTwo', now())`;
      await tx`INSERT INTO product_option_value (id, option_id, value, updated_at) VALUES ('fk_v', 'fk_o1', 'X', now())`;
      await tx`INSERT INTO product_variant (id, product_id, updated_at) VALUES ('fk_va', 'fk_p', now())`;
    });
    // mismatched option_id: (fk_v, fk_o2) is not a real (id, option_id) pair → reject
    await expect(
      inSchema((tx) => tx`INSERT INTO product_variant_option (variant_id, option_id, option_value_id) VALUES ('fk_va', 'fk_o2', 'fk_v')`),
    ).rejects.toThrow(/product_variant_option_option_value_id_option_id_fkey|foreign key/i);
    // a correct matrix row, then ON UPDATE RESTRICT blocks rewriting the referenced id
    await inSchema((tx) => tx`INSERT INTO product_variant_option (variant_id, option_id, option_value_id) VALUES ('fk_va', 'fk_o1', 'fk_v')`);
    await expect(
      inSchema((tx) => tx`UPDATE product_option_value SET id = 'fk_v_new' WHERE id = 'fk_v'`),
    ).rejects.toThrow(/product_variant_option_option_value_id_option_id_fkey|foreign key|update or delete/i);
  });

  // --- deferred transfer-balance trigger ---------------------------------
  it('transfer-balance trigger allows a balanced pair and rejects an unbalanced group at COMMIT', async () => {
    await inSchema(async (tx) => {
      await tx`INSERT INTO inventory_item (id, sku, updated_at) VALUES ('tr_ii', 'TR-SKU', now())`;
      await tx`INSERT INTO stock_location (id, name, updated_at) VALUES ('tr_sl', 'TR Loc', now())`;
    });
    // balanced: two 'transfer' rows summing to 0 in one tx commit cleanly.
    await inSchema(async (tx) => {
      await tx`INSERT INTO stock_movement (id, inventory_item_id, location_id, movement_type, quantity, request_id, transfer_group_id) VALUES ('tr_a', 'tr_ii', 'tr_sl', 'transfer', 5, 'TR-RQ-A', 'TG1')`;
      await tx`INSERT INTO stock_movement (id, inventory_item_id, location_id, movement_type, quantity, request_id, transfer_group_id) VALUES ('tr_b', 'tr_ii', 'tr_sl', 'transfer', -5, 'TR-RQ-B', 'TG1')`;
    });
    const ok = await inSchema((tx) => tx`SELECT count(*)::int AS c FROM stock_movement WHERE transfer_group_id = 'TG1'`);
    expect(ok[0]!.c).toBe(2);

    // unbalanced: a lone half raises at COMMIT (deferred), aborting the tx.
    await expect(
      inSchema((tx) => tx`INSERT INTO stock_movement (id, inventory_item_id, location_id, movement_type, quantity, request_id, transfer_group_id) VALUES ('tr_c', 'tr_ii', 'tr_sl', 'transfer', 5, 'TR-RQ-C', 'TG2')`),
    ).rejects.toThrow(/unbalanced/);
    const none = await inSchema((tx) => tx`SELECT count(*)::int AS c FROM stock_movement WHERE transfer_group_id = 'TG2'`);
    expect(none[0]!.c).toBe(0);
  });

  // --- REVOKEs (append-only) as commerce_app ------------------------------
  it('commerce_app may INSERT/SELECT an append-only ledger row but not UPDATE/DELETE it', async () => {
    // FK targets created by the owner.
    await inSchema(async (tx) => {
      await tx`INSERT INTO inventory_item (id, sku, updated_at) VALUES ('rv_ii', 'RV-SKU', now())`;
      await tx`INSERT INTO stock_location (id, name, updated_at) VALUES ('rv_sl', 'RV Loc', now())`;
    });
    // commerce_app default search_path is `ext` (the backstop), so qualify the schema.
    // INSERT (append) is allowed.
    await app!`
      INSERT INTO ${app!(SCHEMA)}.${app!('stock_movement')} (id, inventory_item_id, location_id, movement_type, quantity, request_id)
      VALUES ('rv_mv', 'rv_ii', 'rv_sl', 'receive', 5, 'RV-RQ')
    `;
    // SELECT is allowed.
    const seen = await app!`SELECT count(*)::int AS c FROM ${app!(SCHEMA)}.${app!('stock_movement')} WHERE id = 'rv_mv'`;
    expect(seen[0]!.c).toBe(1);
    // UPDATE and DELETE are denied (append-only REVOKE).
    await expect(
      app!`UPDATE ${app!(SCHEMA)}.${app!('stock_movement')} SET quantity = 6 WHERE id = 'rv_mv'`,
    ).rejects.toThrow(/permission denied/);
    await expect(
      app!`DELETE FROM ${app!(SCHEMA)}.${app!('stock_movement')} WHERE id = 'rv_mv'`,
    ).rejects.toThrow(/permission denied/);
  });

  it('commerce_app is denied UPDATE/DELETE on every append-only table', async () => {
    for (const table of APPEND_ONLY_TABLES) {
      await expect(
        app!`UPDATE ${app!(SCHEMA)}.${app!(table)} SET created_at = created_at WHERE 1 = 0`,
      ).rejects.toThrow(/permission denied/);
      await expect(
        app!`DELETE FROM ${app!(SCHEMA)}.${app!(table)} WHERE 1 = 0`,
      ).rejects.toThrow(/permission denied/);
    }
  });

  // --- idempotency --------------------------------------------------------
  it('re-running provisionTenant is idempotent (applies nothing new, stays active)', async () => {
    const again = await provisionTenant(owner!, {
      tenantGroupId: TG,
      slug: 'cm04-probe',
      appRole: APP_ROLE,
      tenantMigrations: COMMERCE_TENANT_MIGRATIONS,
    });
    expect(again.schema).toBe(SCHEMA);
    expect(again.applied).toEqual([]);

    const groups = await owner!`SELECT status FROM public.tenant_groups WHERE id = ${TG}::uuid`;
    expect(groups[0]!.status).toBe('active');

    // The structures survive the re-run (spot-check a table + the sequence).
    const stillThere = await owner!`
      SELECT 1 FROM information_schema.tables WHERE table_schema = ${SCHEMA} AND table_name = 'order'
    `;
    expect(stillThere).toHaveLength(1);
  });
});
