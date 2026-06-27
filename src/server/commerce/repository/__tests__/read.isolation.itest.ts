// src/server/commerce/repository/__tests__/read.isolation.itest.ts
//
// CM-07 — the READ-repo isolation crown-jewel (compliance evidence). Provisions
// TWO real tenant-group schemas (tg_a, tg_b) against a Dockerized Postgres, seeds
// DISTINCT catalog / price / inventory data in each, plants a same-named
// `public.product` DECOY (reusing tg_a's handle), and proves — by running the NEW
// `commerceReadRepositoryKysely` / `getCommerceServerRepositoryDb` through scoped
// `tenantDb(...)` handles — that the schema-per-tenant wall holds for every read
// method the publish hydrator consumes:
//
//   - a scoped read returns ONLY its own tenant's rows (zero other-tenant, zero
//     public-decoy), because Kysely `withSchema` rewrites every bare table to
//     `tg_<id>.<table>` and never falls back to `public`;
//   - a tg_b handle handed a tg_a handle/id returns ZERO / null / throws (the
//     schema WALL — tg_b's schema simply has no such row);
//   - symmetry: tg_b sees only tg_b;
//   - THE GRANT PROOF (the auditable control): a `commerce_app`-scoped connection
//     reading a schema it was NOT granted (tg_b) raises `permission denied for
//     schema` — the wall is enforced by Postgres GRANTs, not app discipline;
//   - PLUS a structural proof that `getCommerceServerRepositoryDb(db)` satisfies
//     the `CommerceServerRepository` contract the hydrator expects (compile-time
//     via the typed annotations below + a runtime shape assertion).
//
// This exercises the NEW (CM-07 expand) Kysely path; the old Prisma
// `commerceReadRepository` / `getCommerceServerRepository` is untouched and
// covered by read.test.ts.
//
// TRUST auth (POSTGRES_HOST_AUTH_METHOD=trust + username-only URLs, no password
// literals — hardcoded creds trip GitGuardian; see CM-04). The `.itest.ts` suffix
// keeps this file OUT of the headless `pnpm test` unit gate; it runs ONLY under
// `pnpm test:integration` against Docker. Mirrors catalog.isolation.itest.ts.

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import postgres from 'postgres';
import { Kysely } from 'kysely';
import { createNodeDb } from '@marlinjai/tenant-db/node';
import {
  migratePublic,
  provisionTenant,
  tenantDb,
  tenantSchema,
  assertTenantGroupId,
} from '@marlinjai/tenant-db';

import { ALL_LOCATIONS } from '@/lib/commerce/types';
import type { CommerceServerRepository } from '@/lib/renderer/publish/hydrateBindings';

import type { CommerceDB } from '../../db-types';
import { COMMERCE_TENANT_MIGRATIONS } from '../../migrations/tenant/index';
import { catalogRepositoryKysely } from '../catalog';
import {
  commerceReadRepositoryKysely,
  getCommerceServerRepositoryDb,
} from '../read';

const DB_NAME = 'framer_clone_test';
const APP_ROLE = 'commerce_app';

// TG_A is provisioned WITH the app role (commerce_app gets per-schema grants);
// TG_B WITHOUT it, so commerce_app has NO privilege on tg_b — that is what makes
// the grant-denied proof bite.
const TG_A = assertTenantGroupId('018f9c10-0000-7000-8000-0000000007c7');
const TG_B = assertTenantGroupId('018f9c10-0000-7000-8000-0000000007d7');
const SCHEMA_A = tenantSchema(TG_A);
const SCHEMA_B = tenantSchema(TG_B);

const STOCKED_A = 30; // tg_a seeded stocked units
const RESERVED_A = 8; // tg_a seeded reserved units -> available_quantity = 22 (generated)
const AVAILABLE_A = STOCKED_A - RESERVED_A;
const PRICE_A = 1500; // tg_a stored unit price (integer cents)
const PRICE_B = 2500; // tg_b stored unit price (integer cents)

let container: StartedTestContainer | undefined;
let owner: postgres.Sql | undefined; // container superuser: DDL + decoy + checks
let ownerBase: Kysely<CommerceDB> | undefined; // base for the functional scoped reads
let appBase: Kysely<CommerceDB> | undefined; // base connected as low-priv commerce_app

let productIdA = '';
let variantIdA = '';
let productIdB = '';
let variantIdB = '';

/** Seed a full catalog->price->inventory graph in one scoped schema; return ids. */
async function seedTenant(
  db: Kysely<CommerceDB>,
  opts: {
    productTitle: string;
    handle: string;
    sku: string;
    price: number;
    stocked?: number;
    reserved?: number;
  },
): Promise<{ productId: string; variantId: string }> {
  const product = await catalogRepositoryKysely.createProduct(db, {
    title: opts.productTitle,
    handle: opts.handle,
  });
  const option = await catalogRepositoryKysely.addOption(db, {
    productId: product.id,
    title: 'Size',
  });
  const value = await catalogRepositoryKysely.addOptionValue(db, {
    optionId: option.id,
    value: 'Small',
  });
  const variant = await catalogRepositoryKysely.addVariant(db, {
    productId: product.id,
    title: 'Small',
    sku: opts.sku,
  });
  await catalogRepositoryKysely.setVariantOptions(db, variant.id, [
    { optionId: option.id, optionValueId: value.id },
  ]);

  // price_set -> price (integer cents).
  const priceSetId = randomUUID();
  await db
    .insertInto('price_set')
    .values({ id: priceSetId, variant_id: variant.id, updated_at: new Date() })
    .execute();
  await db
    .insertInto('price')
    .values({
      id: randomUUID(),
      price_set_id: priceSetId,
      currency_code: 'EUR',
      amount: opts.price,
      updated_at: new Date(),
    })
    .execute();

  // inventory_item (SKU-bridged) -> stock_location -> inventory_level. The
  // available_quantity column is GENERATED ALWAYS and is intentionally NOT
  // inserted; the DB computes it as stocked - reserved.
  if (opts.stocked !== undefined) {
    const itemId = randomUUID();
    const locationId = randomUUID();
    await db
      .insertInto('inventory_item')
      .values({ id: itemId, sku: opts.sku, updated_at: new Date() })
      .execute();
    await db
      .insertInto('stock_location')
      .values({ id: locationId, name: 'Main', updated_at: new Date() })
      .execute();
    await db
      .insertInto('inventory_level')
      .values({
        id: randomUUID(),
        inventory_item_id: itemId,
        location_id: locationId,
        stocked_quantity: opts.stocked,
        reserved_quantity: opts.reserved ?? 0,
        updated_at: new Date(),
      })
      .execute();
  }

  return { productId: product.id, variantId: variant.id };
}

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'postgres',
      POSTGRES_PASSWORD: 'postgres',
      POSTGRES_DB: DB_NAME,
      // trust auth: every role logs in by username alone, so no password literals.
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

  // The low-privilege app role must exist before provisioning (the migration
  // REVOKEs are role-guarded; provisionTenant grants per-schema access to it).
  await owner.unsafe(`CREATE ROLE ${APP_ROLE} LOGIN`);

  // Public control plane (ext schema + tenant_groups registry).
  await migratePublic(owner);

  // TG_A WITH grants; TG_B WITHOUT (so commerce_app is denied on tg_b).
  await provisionTenant(owner, {
    tenantGroupId: TG_A,
    slug: 'cm07-read-a',
    appRole: APP_ROLE,
    tenantMigrations: COMMERCE_TENANT_MIGRATIONS,
  });
  await provisionTenant(owner, {
    tenantGroupId: TG_B,
    slug: 'cm07-read-b',
    tenantMigrations: COMMERCE_TENANT_MIGRATIONS,
  });

  // Base handles via the REAL production factory.
  ownerBase = createNodeDb<CommerceDB>({ connectionString: ownerUrl });
  appBase = createNodeDb<CommerceDB>({ connectionString: appUrl });

  const dbA = tenantDb(ownerBase, TG_A);
  const dbB = tenantDb(ownerBase, TG_B);

  const seededA = await seedTenant(dbA, {
    productTitle: 'Widget A',
    handle: 'widget-a',
    sku: 'WIDGET-A-S',
    price: PRICE_A,
    stocked: STOCKED_A,
    reserved: RESERVED_A,
  });
  productIdA = seededA.productId;
  variantIdA = seededA.variantId;

  const seededB = await seedTenant(dbB, {
    productTitle: 'Widget B',
    handle: 'widget-b',
    sku: 'WIDGET-B-S',
    price: PRICE_B,
  });
  productIdB = seededB.productId;
  variantIdB = seededB.variantId;

  // THE DECOY: a same-named `public.product` holding a DECOY row that reuses
  // tg_a's handle. Any unqualified read that fell back to the default path would
  // surface it; a correctly-qualified Kysely read must never see it.
  await owner`
    CREATE TABLE IF NOT EXISTS public.product (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      handle TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'published',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      deleted_at TIMESTAMPTZ,
      tax_class TEXT
    )
  `;
  await owner`
    INSERT INTO public.product (id, title, handle)
    VALUES ('decoy-1', 'DECOY_PUBLIC', 'widget-a'), ('decoy-2', 'DECOY_PUBLIC', 'widget-b')
  `;
}, 180_000);

afterAll(async () => {
  await ownerBase?.destroy();
  await appBase?.destroy();
  await owner?.end();
  await container?.stop();
});

describe('CM-07 read isolation — schema-per-tenant wall (NEW Kysely path)', () => {
  it('provisioned both tenant schemas and marked them active', async () => {
    const groups = await owner!`
      SELECT schema_name, status FROM public.tenant_groups ORDER BY slug
    `;
    expect(groups.map((g) => g.status)).toEqual(['active', 'active']);
    expect(groups.map((g) => g.schema_name).sort()).toEqual([SCHEMA_A, SCHEMA_B].sort());
  });

  it('listProducts scoped to tg_a sees ONLY tg_a (zero tg_b, zero decoy)', async () => {
    const dbA = tenantDb(ownerBase!, TG_A);
    const page = await commerceReadRepositoryKysely.listProducts(dbA);
    expect(page.total).toBe(1);
    expect(page.products).toHaveLength(1);
    expect(page.products[0]!.title).toBe('Widget A');
    expect(page.products[0]!.handle).toBe('widget-a');
    expect(page.products.every((p) => p.title !== 'DECOY_PUBLIC')).toBe(true);
    expect(page.products.every((p) => p.title !== 'Widget B')).toBe(true);
    // The option/value graph hydrated correctly under the scoped read.
    expect(page.products[0]!.options[0]!.values.map((v) => v.label)).toEqual(['Small']);
    expect(page.products[0]!.variantIds).toEqual([variantIdA]);
  });

  it('getProductByHandle scoped to tg_a returns the live product, never the public decoy', async () => {
    const dbA = tenantDb(ownerBase!, TG_A);
    const product = await commerceReadRepositoryKysely.getProductByHandle(dbA, 'widget-a');
    expect(product).not.toBeNull();
    expect(product!.id).toBe(productIdA);
    expect(product!.title).toBe('Widget A'); // not 'DECOY_PUBLIC'
  });

  it('listVariants / getPrices / getAvailability scoped to tg_a read tg_a data', async () => {
    const dbA = tenantDb(ownerBase!, TG_A);

    const variants = await commerceReadRepositoryKysely.listVariants(dbA, productIdA);
    expect(variants).toHaveLength(1);
    expect(variants[0]!.id).toBe(variantIdA);
    expect(variants[0]!.sku).toBe('WIDGET-A-S');
    expect(variants[0]!.optionValues.map((o) => o.label)).toEqual(['Small']);

    const prices = await commerceReadRepositoryKysely.getPrices(dbA, variantIdA);
    expect(prices).toHaveLength(1);
    expect(prices[0]!.amountCents).toBe(PRICE_A);
    expect(Number.isInteger(prices[0]!.amountCents)).toBe(true);
    expect(prices[0]!.currency).toBe('EUR');

    // available_quantity is read DIRECTLY from the GENERATED column and aggregated.
    const availability = await commerceReadRepositoryKysely.getAvailability(dbA, variantIdA);
    expect(availability).toEqual({
      variantId: variantIdA,
      locationId: ALL_LOCATIONS,
      availableQuantity: AVAILABLE_A,
      stale: false,
    });
  });

  it('a tg_b handle handed tg_a handle/ids returns ZERO / null / throws (the schema WALL)', async () => {
    const dbB = tenantDb(ownerBase!, TG_B);

    // tg_b has no product with tg_a's handle.
    expect(await commerceReadRepositoryKysely.getProductByHandle(dbB, 'widget-a')).toBeNull();
    // tg_b has no variants under tg_a's product id.
    expect(await commerceReadRepositoryKysely.listVariants(dbB, productIdA)).toEqual([]);
    // tg_b has no price_set for tg_a's variant.
    expect(await commerceReadRepositoryKysely.getPrices(dbB, variantIdA)).toEqual([]);
    // tg_b has no such variant -> getAvailability throws (advisory contract).
    await expect(
      commerceReadRepositoryKysely.getAvailability(dbB, variantIdA),
    ).rejects.toThrow(/no variant with id/);
  });

  it('symmetry: tg_b sees only tg_b, with zero decoys on any path', async () => {
    const dbA = tenantDb(ownerBase!, TG_A);
    const dbB = tenantDb(ownerBase!, TG_B);

    const pageB = await commerceReadRepositoryKysely.listProducts(dbB);
    expect(pageB.total).toBe(1);
    expect(pageB.products[0]!.title).toBe('Widget B');
    expect(pageB.products.some((p) => p.title === 'DECOY_PUBLIC')).toBe(false);

    expect(await commerceReadRepositoryKysely.getPrices(dbB, variantIdB)).toHaveLength(1);
    // tg_a cannot see tg_b's variant/price either.
    expect(await commerceReadRepositoryKysely.getPrices(dbA, variantIdB)).toEqual([]);
    // The seeded ids are distinct and live only in their own schema.
    expect(productIdA).not.toBe(productIdB);
    expect(variantIdA).not.toBe(variantIdB);
  });

  it('GRANT PROOF: commerce_app may read its granted schema but is DENIED a non-granted one', async () => {
    // commerce_app WAS granted on tg_a -> the scoped read succeeds.
    const appDbA = tenantDb(appBase!, TG_A);
    const page = await commerceReadRepositoryKysely.listProducts(appDbA);
    expect(page.total).toBe(1);

    // commerce_app was NOT granted on tg_b -> Postgres refuses at the grant layer,
    // not the app layer: `permission denied for schema tg_<b>`.
    const appDbB = tenantDb(appBase!, TG_B);
    await expect(commerceReadRepositoryKysely.listProducts(appDbB)).rejects.toThrow(
      /permission denied for schema/,
    );
  });

  it('getCommerceServerRepositoryDb(db) satisfies the CommerceServerRepository contract', async () => {
    // Compile-time: the annotation pins the factory's return to the hydrator's
    // contract (the in-loop `tsc` enforces this whole-program). Runtime: the five
    // methods exist as functions and the wired factory delegates to the Kysely
    // read repo against the scoped handle.
    const repo: CommerceServerRepository = getCommerceServerRepositoryDb(
      tenantDb(ownerBase!, TG_A),
    );
    expect(typeof repo.listProducts).toBe('function');
    expect(typeof repo.getProductByHandle).toBe('function');
    expect(typeof repo.listVariants).toBe('function');
    expect(typeof repo.getPrices).toBe('function');
    expect(typeof repo.getAvailability).toBe('function');

    const page = await repo.listProducts();
    expect(page.total).toBe(1);
    expect(page.products[0]!.handle).toBe('widget-a');
  });
});
