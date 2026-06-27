// src/server/commerce/repository/__tests__/pricing.isolation.itest.ts
//
// CM-06 — the pricing isolation crown-jewel (compliance evidence). Provisions TWO
// real tenant-group schemas (tg_a, tg_b) against a Dockerized Postgres, seeds
// DISTINCT pricing data in each, plants a same-named `public.price_set` +
// `public.price` DECOY (a deliberately CHEAP decoy price keyed to tg_a's variant
// id, so a leaked/unqualified lookup would WIN with the wrong, lower amount), and
// proves — by running the NEW `pricingRepositoryKysely` through scoped
// `tenantDb(...)` handles — that the schema-per-tenant wall holds:
//
//   - resolvePrice scoped to tg_a returns tg_a's stored Int amount, never the
//     public decoy and never tg_b's price;
//   - resolvePrice via a tg_b handle for a tg_a variant returns null (the schema
//     WALL: tg_b has no such price_set);
//   - symmetry: tg_b resolves only tg_b's price;
//   - the money guard is preserved on the NEW path (addPrice rejects a float);
//   - THE GRANT PROOF: a `commerce_app`-scoped connection reading a schema it was
//     NOT granted (tg_b) raises `permission denied for schema`.
//
// Money stays server-authoritative INTEGER cents throughout: resolvePrice does no
// float math; amounts are compared as integers and returned unchanged.
//
// This exercises the NEW (CM-06 expand) Kysely path; the old Prisma
// `pricingRepository` is untouched and covered by pricing.itest.ts /
// pricing.test.ts. TRUST auth, `.itest.ts` (Docker-only) — see catalog
// isolation header for the rationale.

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

import type { CommerceDB } from '../../db-types';
import { COMMERCE_TENANT_MIGRATIONS } from '../../migrations/tenant/index';
import { catalogRepositoryKysely } from '../catalog';
import { pricingRepositoryKysely } from '../pricing';

const DB_NAME = 'framer_clone_test';
const APP_ROLE = 'commerce_app';

const TG_A = assertTenantGroupId('018f9c10-0000-7000-8000-0000000007a7');
const TG_B = assertTenantGroupId('018f9c10-0000-7000-8000-0000000007b7');
const SCHEMA_A = tenantSchema(TG_A);
const SCHEMA_B = tenantSchema(TG_B);

const PRICE_A = 1000; // tg_a's stored unit price (cents)
const PRICE_B = 2000; // tg_b's stored unit price (cents)
const DECOY_PRICE = 1; // the public-decoy price: would WIN (lowest) if leaked

let container: StartedTestContainer | undefined;
let owner: postgres.Sql | undefined;
let ownerBase: Kysely<CommerceDB> | undefined;
let appBase: Kysely<CommerceDB> | undefined;

let variantIdA = '';
let variantIdB = '';

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'postgres',
      POSTGRES_PASSWORD: 'postgres',
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

  // TG_A WITH grants; TG_B WITHOUT (so commerce_app is denied on tg_b).
  await provisionTenant(owner, {
    tenantGroupId: TG_A,
    slug: 'cm06-price-a',
    appRole: APP_ROLE,
    tenantMigrations: COMMERCE_TENANT_MIGRATIONS,
  });
  await provisionTenant(owner, {
    tenantGroupId: TG_B,
    slug: 'cm06-price-b',
    tenantMigrations: COMMERCE_TENANT_MIGRATIONS,
  });

  ownerBase = createNodeDb<CommerceDB>({ connectionString: ownerUrl });
  appBase = createNodeDb<CommerceDB>({ connectionString: appUrl });

  const dbA = tenantDb(ownerBase, TG_A);
  const dbB = tenantDb(ownerBase, TG_B);

  // Seed a variant + price per schema through the NEW Kysely repos.
  const prodA = await catalogRepositoryKysely.createProduct(dbA, {
    title: 'Priced A',
    handle: 'priced-a',
  });
  const varA = await catalogRepositoryKysely.addVariant(dbA, {
    productId: prodA.id,
    sku: 'PRICED-A-1',
  });
  variantIdA = varA.id;
  const psetA = await pricingRepositoryKysely.createPriceSet(dbA, { variantId: varA.id });
  await pricingRepositoryKysely.addPrice(dbA, {
    priceSetId: psetA.id,
    currency: 'EUR',
    amount: PRICE_A,
  });

  const prodB = await catalogRepositoryKysely.createProduct(dbB, {
    title: 'Priced B',
    handle: 'priced-b',
  });
  const varB = await catalogRepositoryKysely.addVariant(dbB, {
    productId: prodB.id,
    sku: 'PRICED-B-1',
  });
  variantIdB = varB.id;
  const psetB = await pricingRepositoryKysely.createPriceSet(dbB, { variantId: varB.id });
  await pricingRepositoryKysely.addPrice(dbB, {
    priceSetId: psetB.id,
    currency: 'EUR',
    amount: PRICE_B,
  });

  // THE DECOY: same-named public.price_set + public.price, keyed to tg_a's
  // variant id with a CHEAP amount. resolvePrice picks the LOWEST applicable
  // amount, so if a lookup ever leaked to public it would return DECOY_PRICE (1)
  // instead of PRICE_A (1000) — the trap. A correctly-qualified read never sees it.
  await owner`
    CREATE TABLE IF NOT EXISTS public.price_set (
      id TEXT PRIMARY KEY,
      variant_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await owner`
    CREATE TABLE IF NOT EXISTS public.price (
      id TEXT PRIMARY KEY,
      price_set_id TEXT NOT NULL,
      price_list_id TEXT,
      currency_code TEXT NOT NULL,
      amount INTEGER NOT NULL,
      min_quantity INTEGER,
      max_quantity INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await owner`INSERT INTO public.price_set (id, variant_id) VALUES ('decoy-ps', ${variantIdA})`;
  await owner`
    INSERT INTO public.price (id, price_set_id, currency_code, amount)
    VALUES ('decoy-pr', 'decoy-ps', 'EUR', ${DECOY_PRICE})
  `;
}, 180_000);

afterAll(async () => {
  await ownerBase?.destroy();
  await appBase?.destroy();
  await owner?.end();
  await container?.stop();
});

describe('CM-06 pricing isolation — schema-per-tenant wall (NEW Kysely path)', () => {
  it('provisioned both tenant schemas and marked them active', async () => {
    const groups = await owner!`
      SELECT schema_name, status FROM public.tenant_groups ORDER BY slug
    `;
    expect(groups.map((g) => g.status)).toEqual(['active', 'active']);
    expect(groups.map((g) => g.schema_name).sort()).toEqual([SCHEMA_A, SCHEMA_B].sort());
  });

  it('resolvePrice scoped to tg_a returns tg_a stored cents, never the cheap decoy', async () => {
    const dbA = tenantDb(ownerBase!, TG_A);
    const amount = await pricingRepositoryKysely.resolvePrice(dbA, variantIdA, {
      currency: 'EUR',
    });
    expect(amount).toBe(PRICE_A);
    expect(amount).not.toBe(DECOY_PRICE); // the decoy would undercut if leaked
    expect(Number.isInteger(amount)).toBe(true); // integer cents, no float math
  });

  it('resolvePrice via a tg_b handle for a tg_a variant returns null (schema WALL)', async () => {
    const dbB = tenantDb(ownerBase!, TG_B);
    const amount = await pricingRepositoryKysely.resolvePrice(dbB, variantIdA, {
      currency: 'EUR',
    });
    expect(amount).toBeNull();
  });

  it('symmetry: tg_b resolves only tg_b price, and tg_a cannot see tg_b price', async () => {
    const dbA = tenantDb(ownerBase!, TG_A);
    const dbB = tenantDb(ownerBase!, TG_B);
    expect(await pricingRepositoryKysely.resolvePrice(dbB, variantIdB, { currency: 'EUR' })).toBe(
      PRICE_B,
    );
    expect(await pricingRepositoryKysely.resolvePrice(dbA, variantIdB, { currency: 'EUR' })).toBeNull();
  });

  it('the money guard is preserved on the NEW path (addPrice rejects a float)', () => {
    const dbA = tenantDb(ownerBase!, TG_A);
    // assertIntegerCents fires SYNCHRONOUSLY at the boundary, before any insert
    // promise is built, so the bad amount throws at the call site (no I/O). The
    // thunk form captures that synchronous throw (mirrors pricing.test.ts).
    expect(() =>
      pricingRepositoryKysely.addPrice(dbA, {
        priceSetId: 'irrelevant',
        currency: 'EUR',
        amount: 19.99, // euros, not cents — a float, rejected at the boundary
      }),
    ).toThrow(/integer number of minor units|cents/);
  });

  it('GRANT PROOF: commerce_app may resolve in its granted schema but is DENIED a non-granted one', async () => {
    const appDbA = tenantDb(appBase!, TG_A);
    expect(await pricingRepositoryKysely.resolvePrice(appDbA, variantIdA, { currency: 'EUR' })).toBe(
      PRICE_A,
    );

    const appDbB = tenantDb(appBase!, TG_B);
    await expect(
      pricingRepositoryKysely.resolvePrice(appDbB, variantIdB, { currency: 'EUR' }),
    ).rejects.toThrow(/permission denied for schema/);
  });
});
