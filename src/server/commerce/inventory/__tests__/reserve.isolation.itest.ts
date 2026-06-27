// src/server/commerce/inventory/__tests__/reserve.isolation.itest.ts
//
// CM-08 — the isolation crown-jewel for the NEW Kysely reserve heart (compliance
// evidence). Provisions TWO real tenant-group schemas (tg_a, tg_b), seeds DISTINCT
// managed inventory in each, plants a same-named `public.inventory_level` DECOY,
// and proves the schema-per-tenant wall holds for the reserve path's RAW guarded
// UPDATE (which names the tenant table via `tenantSchemaRef(tgId)`):
//
//   - a guarded reserve scoped to tg_a mutates ONLY tg_a's inventory_level: tg_b's
//     level is untouched and the public decoy is untouched (the raw fragment is
//     schema-qualified, never falls back to the search_path);
//   - THE GRANT PROOF: a `commerce_app`-scoped reserve on a schema it was NOT
//     granted (tg_b) raises `permission denied for schema` — the wall is enforced
//     by Postgres GRANTs, not app discipline; the SAME role reserving its granted
//     schema (tg_a) succeeds.
//
// Exercises the NEW (CM-08 expand) Kysely path; the old Prisma path is untouched.
// TRUST auth (no password literals — see CM-04). The `.itest.ts` suffix keeps this
// file OUT of the headless `pnpm test` unit gate; it runs ONLY under
// `pnpm test:integration` against Docker. Mirrors catalog.isolation.itest.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
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
import { reserveWithRetryKysely } from '../reserve';

const DB_NAME = 'framer_clone_test';
const APP_ROLE = 'commerce_app';
const TG_A = assertTenantGroupId('018f9c10-0000-7000-8000-0000000008a8');
const TG_B = assertTenantGroupId('018f9c10-0000-7000-8000-0000000008b8');
const SCHEMA_A = tenantSchema(TG_A);
const SCHEMA_B = tenantSchema(TG_B);

let container: StartedTestContainer | undefined;
let owner: postgres.Sql | undefined;
let ownerBase: Kysely<CommerceDB> | undefined;
let appBase: Kysely<CommerceDB> | undefined;

// Seeded handles (scoped to each tenant) reused across the assertions.
let seedA: { variantId: string; inventoryItemId: string; locationId: string };
let seedB: { variantId: string; inventoryItemId: string; locationId: string };

/** Seed a managed product+variant + inventory_item + location + level in `db`. */
async function seedManaged(
  db: Kysely<CommerceDB>,
  stocked: number,
): Promise<{ variantId: string; inventoryItemId: string; locationId: string }> {
  const productId = randomUUID();
  await db
    .insertInto('product')
    .values({ id: productId, title: 'P', handle: `h-${randomUUID()}`, updated_at: new Date() })
    .execute();
  const variantId = randomUUID();
  const sku = `SKU-${randomUUID()}`;
  await db
    .insertInto('product_variant')
    .values({
      id: variantId,
      product_id: productId,
      sku,
      updated_at: new Date(),
      manage_inventory: true,
      allow_backorder: false,
    })
    .execute();
  const inventoryItemId = randomUUID();
  await db
    .insertInto('inventory_item')
    .values({ id: inventoryItemId, sku, updated_at: new Date() })
    .execute();
  const locationId = randomUUID();
  await db
    .insertInto('stock_location')
    .values({ id: locationId, name: `WH-${randomUUID()}`, updated_at: new Date() })
    .execute();
  await db
    .insertInto('inventory_level')
    .values({
      id: randomUUID(),
      inventory_item_id: inventoryItemId,
      location_id: locationId,
      stocked_quantity: stocked,
      reserved_quantity: 0,
      updated_at: new Date(),
    })
    .execute();
  return { variantId, inventoryItemId, locationId };
}

async function readReserved(
  db: Kysely<CommerceDB>,
  inventoryItemId: string,
  locationId: string,
): Promise<number> {
  const row = await db
    .selectFrom('inventory_level')
    .select('reserved_quantity')
    .where('inventory_item_id', '=', inventoryItemId)
    .where('location_id', '=', locationId)
    .executeTakeFirstOrThrow();
  return row.reserved_quantity;
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
  const ownerUrl = `postgresql://postgres@${host}:${port}/${DB_NAME}`;
  const appUrl = `postgresql://${APP_ROLE}@${host}:${port}/${DB_NAME}`;

  owner = postgres(ownerUrl, { max: 1, prepare: false, transform: { undefined: null } });
  await owner.unsafe(`CREATE ROLE ${APP_ROLE} LOGIN`);
  await migratePublic(owner);

  // TG_A WITH grants; TG_B WITHOUT (so commerce_app is DENIED on tg_b).
  await provisionTenant(owner, {
    tenantGroupId: TG_A,
    slug: 'cm08-iso-a',
    appRole: APP_ROLE,
    tenantMigrations: COMMERCE_TENANT_MIGRATIONS,
  });
  await provisionTenant(owner, {
    tenantGroupId: TG_B,
    slug: 'cm08-iso-b',
    tenantMigrations: COMMERCE_TENANT_MIGRATIONS,
  });

  ownerBase = createNodeDb<CommerceDB>({ connectionString: ownerUrl });
  appBase = createNodeDb<CommerceDB>({ connectionString: appUrl });

  seedA = await seedManaged(tenantDb(ownerBase, TG_A), 10);
  seedB = await seedManaged(tenantDb(ownerBase, TG_B), 10);

  // THE DECOY: a same-named public.inventory_level holding a row that reuses
  // tg_a's (item, location). Any raw fragment that fell back to the search_path
  // (instead of tenantSchemaRef-qualifying) would mutate it.
  await owner`
    CREATE TABLE IF NOT EXISTS public.inventory_level (
      id TEXT PRIMARY KEY,
      inventory_item_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      stocked_quantity INTEGER NOT NULL DEFAULT 0,
      reserved_quantity INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await owner`
    INSERT INTO public.inventory_level (id, inventory_item_id, location_id, stocked_quantity, reserved_quantity)
    VALUES (${'decoy-1'}, ${seedA.inventoryItemId}, ${seedA.locationId}, 999, 0)
  `;
}, 180_000);

afterAll(async () => {
  await ownerBase?.destroy();
  await appBase?.destroy();
  await owner?.end();
  await container?.stop();
});

describe('CM-08 reserve isolation — schema-per-tenant wall (NEW Kysely path)', () => {
  it('provisioned both tenant schemas', async () => {
    const groups = await owner!`SELECT schema_name FROM public.tenant_groups ORDER BY slug`;
    expect(groups.map((g) => g.schema_name).sort()).toEqual([SCHEMA_A, SCHEMA_B].sort());
  });

  it('a guarded reserve scoped to tg_a mutates ONLY tg_a (tg_b and the public decoy untouched)', async () => {
    const dbA = tenantDb(ownerBase!, TG_A);
    const result = await reserveWithRetryKysely(dbA, TG_A, {
      inventoryItemId: seedA.inventoryItemId,
      variantId: seedA.variantId,
      locationId: seedA.locationId,
      needed: 4,
      requestId: `iso-a-${randomUUID()}`,
    });
    expect(result.ok).toBe(true);

    // tg_a moved by 4.
    expect(await readReserved(dbA, seedA.inventoryItemId, seedA.locationId)).toBe(4);

    // tg_b's level (same shape, different schema) is UNTOUCHED.
    const dbB = tenantDb(ownerBase!, TG_B);
    expect(await readReserved(dbB, seedB.inventoryItemId, seedB.locationId)).toBe(0);

    // The public.inventory_level DECOY is UNTOUCHED (the raw UPDATE qualified via
    // tenantSchemaRef, never fell back to the search_path).
    const decoy = await owner!`
      SELECT reserved_quantity FROM public.inventory_level WHERE id = ${'decoy-1'}
    `;
    expect(Number(decoy[0]!.reserved_quantity)).toBe(0);
  });

  it('GRANT PROOF: commerce_app may reserve its granted schema (tg_a) but is DENIED a non-granted one (tg_b)', async () => {
    // commerce_app WAS granted on tg_a -> the scoped reserve succeeds.
    const appDbA = tenantDb(appBase!, TG_A);
    const ok = await reserveWithRetryKysely(appDbA, TG_A, {
      inventoryItemId: seedA.inventoryItemId,
      variantId: seedA.variantId,
      locationId: seedA.locationId,
      needed: 1,
      requestId: `iso-app-a-${randomUUID()}`,
    });
    expect(ok.ok).toBe(true);

    // commerce_app was NOT granted on tg_b -> Postgres refuses at the grant layer.
    const appDbB = tenantDb(appBase!, TG_B);
    await expect(
      reserveWithRetryKysely(appDbB, TG_B, {
        inventoryItemId: seedB.inventoryItemId,
        variantId: seedB.variantId,
        locationId: seedB.locationId,
        needed: 1,
        requestId: `iso-app-b-${randomUUID()}`,
      }),
    ).rejects.toThrow(/permission denied for schema/);
  });
});
