// src/server/commerce/provisioning/__tests__/backfill-demo.itest.ts
//
// CM-12 — the integration proof for the FLIPPED seed + the demo BACK-COMPAT
// backfill, against a REAL Postgres (these are Postgres semantics — the schema
// wall, the GENERATED column, the recompute triggers, the per-tenant
// order_number_seq — not mockable). It boots its OWN throwaway container (TRUST
// auth, NO password literals — mirrors createOrder.isolation.itest.ts /
// reserve.isolation.itest.ts), runs `prisma migrate deploy` to stand up the
// Prisma `public` (sites / dt_*) + the legacy `commerce` schemas, then
// `migratePublic` + `provisionTenant` to stand up `tg_<demo>`.
//
// Four proofs:
//   1. SEED-THROUGH-HANDLE — running the real `seedDemoSite` with an injected
//      `commerceTenantDb`-equivalent handle writes the WHOLE commerce catalog into
//      `tg_<demo>`; the legacy `commerce` schema stays EMPTY (no commerce write
//      bypasses the scoped handle into the old schema).
//   2. READ PATH — `getCommerceServerRepositoryDb(tenantDb(base, tg_demo))` returns
//      the seeded catalog (2 products), proving the demo renders on the new path.
//   3. PLACE-ORDER — a `createOrderKysely` order against `tg_<demo>` succeeds on a
//      seeded variant (price + SKU-bridged inventory), proving checkout works.
//   4. BACKFILL — copying a representative `commerce` dataset into a fresh
//      `tg_<backfill>` regenerates the GENERATED `available_quantity` (= stocked -
//      reserved) and the trigger-maintained `option_signature` in the target; a
//      RE-RUN is a no-op (idempotent).
//
// The `.itest.ts` suffix keeps this OUT of the headless `pnpm test` unit gate
// (vitest.config.ts matches only *.{test,spec}.{ts,tsx}); it runs ONLY under
// `pnpm test:integration` against Docker.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { PrismaClient } from '@prisma/client';
import { createNodeDb } from '@marlinjai/tenant-db/node';
import {
  migratePublic,
  provisionTenant,
  tenantDb,
  tenantSchema,
  assertTenantGroupId,
} from '@marlinjai/tenant-db';
import postgres from 'postgres';

import type { CommerceDB } from '../../db-types';
import { COMMERCE_TENANT_MIGRATIONS } from '../../migrations/tenant/index';
import { getCommerceServerRepositoryDb } from '../../repository/read';
import { createOrderKysely, type Cart } from '../../order/createOrder';
import { backfillDemoTenant } from '../backfill-demo';
import {
  seedDemoSite,
  DEMO_TENANT_GROUP_ID,
  DEMO_PRODUCT_TITLES,
} from '@/lib/renderer/server/seedDemoSite';

const DB_NAME = 'framer_clone_test';
const APP_ROLE = 'commerce_app';
const TG_DEMO = assertTenantGroupId(DEMO_TENANT_GROUP_ID);
const TG_BACKFILL = assertTenantGroupId('018f9c10-0000-7000-8000-0000000000bf');
const SCHEMA_DEMO = tenantSchema(TG_DEMO);
const SCHEMA_BACKFILL = tenantSchema(TG_BACKFILL);

let container: StartedTestContainer | undefined;
let owner: postgres.Sql | undefined;
let ownerBase: Kysely<CommerceDB> | undefined;
let prisma: PrismaClient | undefined;
let ownerUrl = '';

/** count(*) for a fully-qualified `schema.table` (schema is reserved-word-safe). */
async function countRows(schema: string, table: string): Promise<number> {
  const rows = await owner!.unsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM "${schema}"."${table}"`,
  );
  return rows[0].n;
}

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'postgres',
      POSTGRES_DB: DB_NAME,
      POSTGRES_HOST_AUTH_METHOD: 'trust',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  // Username-only TRUST URI: NO password literal (GitGuardian-safe).
  ownerUrl = `postgresql://postgres@${host}:${port}/${DB_NAME}`;

  // (a) Prisma migrate -> the `public` (sites / dt_*) + legacy `commerce` schemas.
  execSync('pnpm exec prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: ownerUrl },
  });

  owner = postgres(ownerUrl, { max: 1, prepare: false, transform: { undefined: null } });
  // (b) Roles + the public tenant tier + the demo's tg_<demo> schema.
  await owner.unsafe(`CREATE ROLE ${APP_ROLE} LOGIN`);
  await migratePublic(owner);
  await provisionTenant(owner, {
    tenantGroupId: TG_DEMO,
    slug: 'demo',
    appRole: APP_ROLE,
    tenantMigrations: COMMERCE_TENANT_MIGRATIONS,
  });

  ownerBase = createNodeDb<CommerceDB>({ connectionString: ownerUrl });
  prisma = new PrismaClient({ datasourceUrl: ownerUrl });
}, 240_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await ownerBase?.destroy();
  await owner?.end();
  await container?.stop();
});

describe('CM-12 seed FLIP — every commerce write routes through commerceTenantDb', () => {
  it('provisioned tg_<demo>', async () => {
    const groups = await owner!`SELECT schema_name FROM public.tenant_groups WHERE slug = 'demo'`;
    expect(groups.map((g) => g.schema_name)).toEqual([SCHEMA_DEMO]);
  });

  it('seeds the WHOLE catalog into tg_<demo>; the legacy commerce schema stays EMPTY', async () => {
    const dbDemo = tenantDb(ownerBase!, TG_DEMO);
    // Inject the scoped handle so the seed's commerce writes land in tg_<demo>
    // (the prod default `commerceTenantDb(tgId)` builds the same handle from env).
    await seedDemoSite(prisma!, { commerceDb: dbDemo, tenantGroupId: TG_DEMO });

    // The catalog landed in tg_<demo>: 2 products, 4 variants, 4 inventory items +
    // levels + locations (PRODUCT_SPECS = 2 products x 2 values).
    expect(await countRows(SCHEMA_DEMO, 'product')).toBe(2);
    expect(await countRows(SCHEMA_DEMO, 'product_variant')).toBe(4);
    expect(await countRows(SCHEMA_DEMO, 'price')).toBe(4);
    expect(await countRows(SCHEMA_DEMO, 'inventory_item')).toBe(4);
    expect(await countRows(SCHEMA_DEMO, 'inventory_level')).toBe(4);
    expect(await countRows(SCHEMA_DEMO, 'stock_location')).toBe(4);

    // THE PROOF: NO commerce write hit the legacy `commerce` schema — every write
    // went through the scoped handle into tg_<demo>, none bypassed it.
    expect(await countRows('commerce', 'product')).toBe(0);
    expect(await countRows('commerce', 'product_variant')).toBe(0);
    expect(await countRows('commerce', 'inventory_item')).toBe(0);
    expect(await countRows('commerce', 'inventory_level')).toBe(0);
    expect(await countRows('commerce', 'stock_location')).toBe(0);
    expect(await countRows('commerce', 'price')).toBe(0);
  });

  it('the demo read path returns the seeded catalog from tg_<demo>', async () => {
    const repo = getCommerceServerRepositoryDb(tenantDb(ownerBase!, TG_DEMO));
    const page = await repo.listProducts();
    expect(page.total).toBe(2);
    expect(page.products.map((p) => p.title).sort()).toEqual([...DEMO_PRODUCT_TITLES].sort());

    // Advisory availability resolves through the SKU bridge for a seeded variant.
    const product = page.products.find((p) => p.variantIds.length > 0);
    expect(product).toBeDefined();
    const availability = await repo.getAvailability(product!.variantIds[0]);
    expect(availability.availableQuantity).toBeGreaterThan(0);
  });

  it('places an order against tg_<demo> via createOrderKysely (checkout works)', async () => {
    const dbDemo = tenantDb(ownerBase!, TG_DEMO);
    // Pick a seeded variant + its SKU-bridged inventory item + a stock location.
    const variant = await dbDemo
      .selectFrom('product_variant')
      .select(['id', 'sku'])
      .where('sku', 'is not', null)
      .executeTakeFirstOrThrow();
    const item = await dbDemo
      .selectFrom('inventory_item')
      .select('id')
      .where('sku', '=', variant.sku!)
      .executeTakeFirstOrThrow();
    const level = await dbDemo
      .selectFrom('inventory_level')
      .select('location_id')
      .where('inventory_item_id', '=', item.id)
      .executeTakeFirstOrThrow();

    const cart: Cart = {
      requestId: `cm12-demo-order-${randomUUID()}`,
      currency: 'EUR',
      taxRegion: 'DE',
      lines: [
        {
          inventoryItemId: item.id,
          variantId: variant.id,
          quantity: 1,
          locationId: level.location_id,
        },
      ],
    };
    const result = await createOrderKysely(dbDemo, TG_DEMO, cart);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const order = await dbDemo
      .selectFrom('order')
      .selectAll()
      .where('id', '=', result.orderId)
      .executeTakeFirstOrThrow();
    expect(order.total).toBe(order.subtotal + order.tax_amount);
    expect(order.order_number).toMatch(/^ORD-\d{6}$/);
  });
});

describe('CM-12 backfill — copy commerce -> tg_<backfill>, regenerate generated/trigger cols', () => {
  // A representative source dataset in the legacy `commerce` schema: one product
  // with an option + option value + a variant (matrix -> option_signature), a
  // price, and inventory with stocked 10 / reserved 3 (-> available 7).
  const ids = {
    product: randomUUID(),
    option: randomUUID(),
    optionValue: randomUUID(),
    variant: randomUUID(),
    priceSet: randomUUID(),
    price: randomUUID(),
    item: randomUUID(),
    location: randomUUID(),
    level: randomUUID(),
  };

  beforeAll(async () => {
    const sql = owner!;
    // updated_at has no DB default (Prisma @updatedAt is app-side), so supply it;
    // created_at / status default at the DB. FK-safe insertion order.
    await sql.unsafe(
      `INSERT INTO commerce.product (id, title, handle, updated_at)
       VALUES ('${ids.product}', 'BF Widget', 'bf-${ids.product}', now())`,
    );
    await sql.unsafe(
      `INSERT INTO commerce.product_option (id, product_id, title, updated_at)
       VALUES ('${ids.option}', '${ids.product}', 'Size', now())`,
    );
    await sql.unsafe(
      `INSERT INTO commerce.product_option_value (id, option_id, value, updated_at)
       VALUES ('${ids.optionValue}', '${ids.option}', 'Large', now())`,
    );
    await sql.unsafe(
      `INSERT INTO commerce.product_variant (id, product_id, title, sku, updated_at)
       VALUES ('${ids.variant}', '${ids.product}', 'BF Widget / Large', 'BF-L', now())`,
    );
    await sql.unsafe(
      `INSERT INTO commerce.product_variant_option (variant_id, option_id, option_value_id)
       VALUES ('${ids.variant}', '${ids.option}', '${ids.optionValue}')`,
    );
    await sql.unsafe(
      `INSERT INTO commerce.price_set (id, variant_id, updated_at)
       VALUES ('${ids.priceSet}', '${ids.variant}', now())`,
    );
    await sql.unsafe(
      `INSERT INTO commerce.price (id, price_set_id, currency_code, amount, updated_at)
       VALUES ('${ids.price}', '${ids.priceSet}', 'EUR', 4200, now())`,
    );
    await sql.unsafe(
      `INSERT INTO commerce.inventory_item (id, sku, title, updated_at)
       VALUES ('${ids.item}', 'BF-L', 'BF Widget Large', now())`,
    );
    await sql.unsafe(
      `INSERT INTO commerce.stock_location (id, name, updated_at)
       VALUES ('${ids.location}', 'BF Warehouse', now())`,
    );
    await sql.unsafe(
      `INSERT INTO commerce.inventory_level
         (id, inventory_item_id, location_id, stocked_quantity, reserved_quantity, updated_at)
       VALUES ('${ids.level}', '${ids.item}', '${ids.location}', 10, 3, now())`,
    );
  }, 60_000);

  it('copies the commerce dataset into tg_<backfill> and REGENERATES the generated/trigger columns', async () => {
    // backfillDemoTenant provisions tg_<backfill> ITSELF (no pre-provision) and
    // copies, all on the owner connection. The slug travels with the tenant-group:
    // 'demo' is already taken by TG_DEMO (beforeAll), and tenant_groups.slug is
    // UNIQUE, so this second group carries its own slug.
    await backfillDemoTenant({
      tenantGroupId: TG_BACKFILL,
      slug: 'demo-backfill',
      connectionString: ownerUrl,
    });

    // tg_<backfill> was provisioned by the backfill.
    const groups = await owner!`SELECT schema_name FROM public.tenant_groups WHERE schema_name = ${SCHEMA_BACKFILL}`;
    expect(groups).toHaveLength(1);

    const dbBackfill = tenantDb(ownerBase!, TG_BACKFILL);

    // The rows landed (counts match the source).
    expect(await countRows(SCHEMA_BACKFILL, 'product')).toBe(1);
    expect(await countRows(SCHEMA_BACKFILL, 'product_variant')).toBe(1);
    expect(await countRows(SCHEMA_BACKFILL, 'price')).toBe(1);
    expect(await countRows(SCHEMA_BACKFILL, 'inventory_level')).toBe(1);

    // GENERATED available_quantity = stocked - reserved = 10 - 3 = 7, RECOMPUTED in
    // the target (it was NOT copied — it cannot be, it is GENERATED ALWAYS).
    const level = await dbBackfill
      .selectFrom('inventory_level')
      .select(['stocked_quantity', 'reserved_quantity', 'available_quantity'])
      .executeTakeFirstOrThrow();
    expect(level.stocked_quantity).toBe(10);
    expect(level.reserved_quantity).toBe(3);
    expect(level.available_quantity).toBe(7);

    // Trigger-maintained option_signature RECOMPUTED after the matrix rows copied
    // (it was excluded from the copy; the AFTER trigger fired on the matrix insert).
    const variant = await dbBackfill
      .selectFrom('product_variant')
      .select('option_signature')
      .executeTakeFirstOrThrow();
    expect(variant.option_signature).not.toBeNull();
  });

  it('re-running the backfill is a no-op (idempotent)', async () => {
    // Same (id, slug) pair as the first run: the registry upsert no-ops.
    await backfillDemoTenant({
      tenantGroupId: TG_BACKFILL,
      slug: 'demo-backfill',
      connectionString: ownerUrl,
    });
    // Still exactly one of each — ON CONFLICT DO NOTHING skipped the already-copied
    // rows rather than double-inserting.
    expect(await countRows(SCHEMA_BACKFILL, 'product')).toBe(1);
    expect(await countRows(SCHEMA_BACKFILL, 'product_variant')).toBe(1);
    expect(await countRows(SCHEMA_BACKFILL, 'price')).toBe(1);
    expect(await countRows(SCHEMA_BACKFILL, 'inventory_level')).toBe(1);
  });
});
