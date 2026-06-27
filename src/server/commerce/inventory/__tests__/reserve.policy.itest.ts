// src/server/commerce/inventory/__tests__/reserve.policy.itest.ts
//
// CM-08 — pins the Medusa-style 3-way policy branch of the NEW Kysely reserve
// path (Marlin 2026-06-27). The flags live on product_variant (manage_inventory
// default TRUE, allow_backorder default FALSE — CM-08a) and are resolved per line
// BEFORE any inventory_level access:
//
//   A. untracked (manage_inventory=false, no inventory_level row at all):
//      reserveKysely -> { ok:true, reservationId:null } with ZERO reservation and
//      ZERO stock_movement rows written. Always sellable.
//   B. backorder (manage_inventory=true, allow_backorder=true): stocked=1,
//      reserving 5 succeeds { ok:true }, leaving reserved_quantity=5 and the
//      GENERATED available_quantity=-4 (negative = backorder depth), with a
//      reservation row. A SECOND backorder reserve drives it further negative,
//      never a shortage. This proves CM-08a's DROP of the reserved<=stocked CHECK
//      lets reserved exceed stocked (the old CHECK would have rejected it).
//   C. managed (manage_inventory=true, allow_backorder=false): stocked=1,
//      reserving 5 returns { ok:false, shortages } and does NOT mutate
//      reserved_quantity. The guarded WHERE is the SOLE oversell guard now that
//      the DB CHECK is gone, and it still bites.
//
// This exercises the NEW (CM-08 expand) Kysely path against a REAL provisioned
// tenant schema; the old Prisma reserve path is untouched (reserve.itest.ts).
//
// TRUST auth (POSTGRES_HOST_AUTH_METHOD=trust + username-only URLs, no password
// literals — hardcoded creds trip GitGuardian; see CM-04). The `.itest.ts` suffix
// keeps this file OUT of the headless `pnpm test` unit gate (vitest.config.ts
// matches only *.{test,spec}.{ts,tsx}); it runs ONLY under `pnpm test:integration`
// against Docker. Requires a running Docker daemon.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { createNodeDb } from '@marlinjai/tenant-db/node';
import {
  migratePublic,
  provisionTenant,
  tenantDb,
  assertTenantGroupId,
} from '@marlinjai/tenant-db';
import postgres from 'postgres';

import type { CommerceDB } from '../../db-types';
import { COMMERCE_TENANT_MIGRATIONS } from '../../migrations/tenant/index';
import { reserveWithRetryKysely } from '../reserve';

const DB_NAME = 'framer_clone_test';
const TG = assertTenantGroupId('018f9c10-0000-7000-8000-0000000008c8');

let container: StartedTestContainer | undefined;
let owner: postgres.Sql | undefined;
let ownerBase: Kysely<CommerceDB> | undefined;

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

  owner = postgres(ownerUrl, { max: 1, prepare: false, transform: { undefined: null } });
  await migratePublic(owner);
  await provisionTenant(owner, {
    tenantGroupId: TG,
    slug: 'cm08-policy',
    tenantMigrations: COMMERCE_TENANT_MIGRATIONS,
  });

  ownerBase = createNodeDb<CommerceDB>({ connectionString: ownerUrl });
}, 180_000);

afterAll(async () => {
  await ownerBase?.destroy();
  await owner?.end();
  await container?.stop();
});

/** Seed a product + variant (with the given policy flags). Returns the variant id + sku. */
async function seedVariant(
  db: Kysely<CommerceDB>,
  flags: { manageInventory: boolean; allowBackorder: boolean },
): Promise<{ variantId: string; sku: string }> {
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
      manage_inventory: flags.manageInventory,
      allow_backorder: flags.allowBackorder,
    })
    .execute();
  return { variantId, sku };
}

/** Seed an inventory_item + stock_location + inventory_level. Returns the ids. */
async function seedLevel(
  db: Kysely<CommerceDB>,
  sku: string,
  stocked: number,
): Promise<{ inventoryItemId: string; locationId: string }> {
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
  return { inventoryItemId, locationId };
}

async function readLevel(
  db: Kysely<CommerceDB>,
  inventoryItemId: string,
  locationId: string,
): Promise<{ reserved: number; stocked: number; available: number }> {
  const row = await db
    .selectFrom('inventory_level')
    .select(['reserved_quantity', 'stocked_quantity', 'available_quantity'])
    .where('inventory_item_id', '=', inventoryItemId)
    .where('location_id', '=', locationId)
    .executeTakeFirstOrThrow();
  return {
    reserved: row.reserved_quantity,
    stocked: row.stocked_quantity,
    available: row.available_quantity,
  };
}

async function countRows(
  db: Kysely<CommerceDB>,
  table: 'stock_movement' | 'reservation',
  requestId: string,
): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll().as('c'))
    .where('request_id', '=', requestId)
    .executeTakeFirstOrThrow();
  return Number(row.c);
}

describe('CM-08 reserve policy branch (NEW Kysely path, Dockerized Postgres)', () => {
  it('Case A — untracked variant: ok:true, reservationId null, ZERO movement/reservation rows', async () => {
    const db = tenantDb(ownerBase!, TG);
    // Untracked variant; deliberately NO inventory_item / inventory_level row.
    const { variantId } = await seedVariant(db, { manageInventory: false, allowBackorder: false });
    const requestId = `untracked-${randomUUID()}`;

    const result = await reserveWithRetryKysely(db, TG, {
      variantId,
      needed: 7,
      requestId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.reservationId).toBeNull();
    expect(await countRows(db, 'stock_movement', requestId)).toBe(0);
    expect(await countRows(db, 'reservation', requestId)).toBe(0);
  });

  it('Case B — backorder variant: stocked 1, reserve 5 succeeds; reserved=5, available=-4; reservation row written; never short', async () => {
    const db = tenantDb(ownerBase!, TG);
    const { variantId, sku } = await seedVariant(db, {
      manageInventory: true,
      allowBackorder: true,
    });
    const { inventoryItemId, locationId } = await seedLevel(db, sku, 1);
    const requestId = `backorder-1-${randomUUID()}`;

    const result = await reserveWithRetryKysely(db, TG, {
      inventoryItemId,
      variantId,
      locationId,
      needed: 5,
      requestId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.reservationId).not.toBeNull();

    // reserved exceeds stocked (the dropped CHECK would have rejected this);
    // available goes NEGATIVE (backorder depth).
    const after = await readLevel(db, inventoryItemId, locationId);
    expect(after.reserved).toBe(5);
    expect(after.stocked).toBe(1);
    expect(after.available).toBe(-4);
    expect(await countRows(db, 'reservation', requestId)).toBe(1);
    expect(await countRows(db, 'stock_movement', requestId)).toBe(1);

    // A SECOND backorder reserve drives it further negative, never a shortage.
    const requestId2 = `backorder-2-${randomUUID()}`;
    const result2 = await reserveWithRetryKysely(db, TG, {
      inventoryItemId,
      variantId,
      locationId,
      needed: 3,
      requestId: requestId2,
    });
    expect(result2.ok).toBe(true);
    const after2 = await readLevel(db, inventoryItemId, locationId);
    expect(after2.reserved).toBe(8);
    expect(after2.available).toBe(-7);
  });

  it('Case C — managed variant: stocked 1, reserve 5 returns ok:false shortages; reserved unchanged; no rows', async () => {
    const db = tenantDb(ownerBase!, TG);
    const { variantId, sku } = await seedVariant(db, {
      manageInventory: true,
      allowBackorder: false,
    });
    const { inventoryItemId, locationId } = await seedLevel(db, sku, 1);
    const requestId = `managed-${randomUUID()}`;

    const result = await reserveWithRetryKysely(db, TG, {
      inventoryItemId,
      variantId,
      locationId,
      needed: 5,
      requestId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.shortages).toEqual([
      { inventoryItemId, locationId, needed: 5, available: 1 },
    ]);

    // The guard matched zero rows: reserved is untouched and nothing was written.
    const after = await readLevel(db, inventoryItemId, locationId);
    expect(after.reserved).toBe(0);
    expect(after.available).toBe(1);
    expect(await countRows(db, 'stock_movement', requestId)).toBe(0);
    expect(await countRows(db, 'reservation', requestId)).toBe(0);
  });

  it('Case C still bites at the exact boundary: reserving the last unit succeeds, one more is short', async () => {
    const db = tenantDb(ownerBase!, TG);
    const { variantId, sku } = await seedVariant(db, {
      manageInventory: true,
      allowBackorder: false,
    });
    const { inventoryItemId, locationId } = await seedLevel(db, sku, 1);

    const ok = await reserveWithRetryKysely(db, TG, {
      inventoryItemId,
      variantId,
      locationId,
      needed: 1,
      requestId: `boundary-ok-${randomUUID()}`,
    });
    expect(ok.ok).toBe(true);
    expect((await readLevel(db, inventoryItemId, locationId)).available).toBe(0);

    const short = await reserveWithRetryKysely(db, TG, {
      inventoryItemId,
      variantId,
      locationId,
      needed: 1,
      requestId: `boundary-short-${randomUUID()}`,
    });
    expect(short.ok).toBe(false);
  });
});
