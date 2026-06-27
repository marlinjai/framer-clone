// src/server/commerce/repository/__tests__/catalog.isolation.itest.ts
//
// CM-06 — the catalog isolation crown-jewel (compliance evidence). Provisions
// TWO real tenant-group schemas (tg_a, tg_b) against a Dockerized Postgres,
// seeds DISTINCT catalog data in each, plants a same-named `public.product`
// DECOY, and proves — by running the NEW `catalogRepositoryKysely` through scoped
// `tenantDb(...)` handles — that the schema-per-tenant wall holds:
//
//   - a scoped read returns ONLY its own tenant's rows (zero other-tenant, zero
//     public-decoy), because Kysely `withSchema` rewrites every bare table to
//     `tg_<id>.<table>` and never falls back to `public`;
//   - a tg_b handle handed a tg_a id returns ZERO (the schema WALL, not a logical
//     filter — tg_b's schema simply has no such row);
//   - symmetry: tg_b sees only tg_b; the cross-schema total is exactly the seeded
//     sum with zero decoys on any path;
//   - THE GRANT PROOF (the auditable control): a `commerce_app`-scoped connection
//     reading a schema it was NOT granted (tg_b) raises `permission denied for
//     schema` — the wall is enforced by Postgres GRANTs, not app discipline.
//
// This exercises the NEW (CM-06 expand) Kysely path; the old Prisma
// `catalogRepository` is untouched and covered by catalog.itest.ts.
//
// TRUST auth (POSTGRES_HOST_AUTH_METHOD=trust + username-only URLs, no password
// literals — hardcoded creds trip GitGuardian; see CM-04). The `.itest.ts`
// suffix keeps this file OUT of the headless `pnpm test` unit gate
// (vitest.config.ts matches only *.{test,spec}.{ts,tsx}); it runs ONLY under
// `pnpm test:integration` against Docker. Mirrors provision.itest.ts.

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

const DB_NAME = 'framer_clone_test';
const APP_ROLE = 'commerce_app';

// Two tenant-groups. TG_A is provisioned WITH the app role (commerce_app gets
// per-schema grants); TG_B is provisioned WITHOUT it, so commerce_app has NO
// privilege on tg_b — that is what makes the grant-denied proof bite.
const TG_A = assertTenantGroupId('018f9c10-0000-7000-8000-0000000006a6');
const TG_B = assertTenantGroupId('018f9c10-0000-7000-8000-0000000006b6');
const SCHEMA_A = tenantSchema(TG_A);
const SCHEMA_B = tenantSchema(TG_B);

let container: StartedTestContainer | undefined;
let owner: postgres.Sql | undefined; // container superuser: DDL + decoy + seeding-of-record
let ownerBase: Kysely<CommerceDB> | undefined; // base for the functional scoped reads
let appBase: Kysely<CommerceDB> | undefined; // base connected as low-priv commerce_app

let productIdA = '';
let productIdB = '';

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
    slug: 'cm06-cat-a',
    appRole: APP_ROLE,
    tenantMigrations: COMMERCE_TENANT_MIGRATIONS,
  });
  await provisionTenant(owner, {
    tenantGroupId: TG_B,
    slug: 'cm06-cat-b',
    tenantMigrations: COMMERCE_TENANT_MIGRATIONS,
  });

  // Base handles via the REAL production factory.
  ownerBase = createNodeDb<CommerceDB>({ connectionString: ownerUrl });
  appBase = createNodeDb<CommerceDB>({ connectionString: appUrl });

  const dbA = tenantDb(ownerBase, TG_A);
  const dbB = tenantDb(ownerBase, TG_B);

  // Seed DISTINCT catalog data per schema THROUGH THE NEW Kysely repo (also
  // proves the write path lands in the right schema).
  const prodA = await catalogRepositoryKysely.createProduct(dbA, {
    title: 'Widget A',
    handle: 'widget-a',
  });
  productIdA = prodA.id;
  const optA = await catalogRepositoryKysely.addOption(dbA, {
    productId: prodA.id,
    title: 'Size',
  });
  const valA = await catalogRepositoryKysely.addOptionValue(dbA, {
    optionId: optA.id,
    value: 'S',
  });
  const varA = await catalogRepositoryKysely.addVariant(dbA, {
    productId: prodA.id,
    sku: 'WIDGET-A-S',
  });
  await catalogRepositoryKysely.setVariantOptions(dbA, varA.id, [
    { optionId: optA.id, optionValueId: valA.id },
  ]);

  const prodB = await catalogRepositoryKysely.createProduct(dbB, {
    title: 'Widget B',
    handle: 'widget-b',
  });
  productIdB = prodB.id;
  await catalogRepositoryKysely.addVariant(dbB, { productId: prodB.id, sku: 'WIDGET-B-1' });

  // THE DECOY: a same-named `public.product` holding a DECOY row that reuses
  // tg_a's handle. Any unqualified query that fell back to the default path would
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

describe('CM-06 catalog isolation — schema-per-tenant wall (NEW Kysely path)', () => {
  it('provisioned both tenant schemas and marked them active', async () => {
    const groups = await owner!`
      SELECT schema_name, status FROM public.tenant_groups ORDER BY slug
    `;
    expect(groups.map((g) => g.status)).toEqual(['active', 'active']);
    expect(groups.map((g) => g.schema_name).sort()).toEqual([SCHEMA_A, SCHEMA_B].sort());
  });

  it('count() scoped to tg_a sees ONLY tg_a products (zero tg_b, zero decoy)', async () => {
    const dbA = tenantDb(ownerBase!, TG_A);
    expect(await catalogRepositoryKysely.count(dbA)).toBe(1);
  });

  it('a scoped read returns ONLY tg_a rows, never tg_b or the public decoy', async () => {
    const dbA = tenantDb(ownerBase!, TG_A);
    const rows = await dbA.selectFrom('product').select(['title', 'handle']).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Widget A');
    expect(rows.every((r) => r.title !== 'DECOY_PUBLIC')).toBe(true);
    expect(rows.every((r) => r.title !== 'Widget B')).toBe(true);
  });

  it('a tg_b handle handed a tg_a product id returns ZERO (the schema WALL)', async () => {
    const dbB = tenantDb(ownerBase!, TG_B);
    const row = await dbB
      .selectFrom('product')
      .selectAll()
      .where('id', '=', productIdA)
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it('symmetry: tg_b sees only tg_b, and the cross-schema total has zero decoys', async () => {
    const dbA = tenantDb(ownerBase!, TG_A);
    const dbB = tenantDb(ownerBase!, TG_B);
    expect(await catalogRepositoryKysely.count(dbB)).toBe(1);

    const a = await dbA.selectFrom('product').select(['title']).execute();
    const b = await dbB.selectFrom('product').select(['title']).execute();
    const all = [...a, ...b];
    expect(all).toHaveLength(2); // 1 A + 1 B, zero decoys
    expect(all.some((r) => r.title === 'DECOY_PUBLIC')).toBe(false);
    expect(b[0]!.title).toBe('Widget B');
    // The seeded ids are distinct and live only in their own schema.
    expect(productIdA).not.toBe(productIdB);
  });

  it('GRANT PROOF: commerce_app may read its granted schema but is DENIED a non-granted one', async () => {
    // commerce_app WAS granted on tg_a -> the scoped read succeeds.
    const appDbA = tenantDb(appBase!, TG_A);
    expect(await catalogRepositoryKysely.count(appDbA)).toBe(1);

    // commerce_app was NOT granted on tg_b -> Postgres refuses at the grant layer,
    // not the app layer: `permission denied for schema tg_<b>`.
    const appDbB = tenantDb(appBase!, TG_B);
    await expect(catalogRepositoryKysely.count(appDbB)).rejects.toThrow(
      /permission denied for schema/,
    );
  });
});
