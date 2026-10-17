// src/server/commerce/__tests__/storefrontFixtures.ts
//
// Shared fixtures for the commerce ROUTE integration suites (CM-10):
// routes.itest.ts, orders/route.itest.ts, routes.isolation.itest.ts, the editor
// routes' editorCommerce.itest.ts and the demo checkout itest. Not a
// test file itself (no `.test` / `.itest` suffix, so neither vitest config
// collects it).
//
// They run against the SHARED Dockerized Postgres the integration globalSetup
// (vitest.integration.setup.ts) stands up: `prisma migrate deploy` (sites /
// SiteDomain / dt_* in public), the `commerce_app` role, `migratePublic`, and the
// demo tenant group. globalSetup exports DATABASE_URL (the owner, which the
// routes' Prisma host resolver uses) and COMMERCE_APP_DATABASE_URL (the
// low-privilege role the routes' scoped Kysely handle connects as), so the REAL
// route handlers run unmodified: host -> published site (Prisma) -> tenant group
// -> commerceTenantDb(tgId) as commerce_app -> tg_<id>.
//
// Every suite provisions its OWN tenant groups (random UUIDs) and its own
// published sites (random subdomains), so suites sharing the database in
// parallel workers never see each other's rows. provisionTenant runs
// `ALTER ROLE commerce_app ...`, which two concurrent transactions cannot both
// do on the same role row, so provisioning is serialized across workers with a
// session advisory lock.

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { PrismaClient } from '@prisma/client';
import { createNodeDb } from '@marlinjai/tenant-db/node';
import {
  assertTenantGroupId,
  provisionTenant,
  tenantDb,
  tenantSchema,
  type TenantGroupId,
} from '@marlinjai/tenant-db';
import postgres from 'postgres';

import type { CommerceDB } from '../db-types';
import { DEFAULT_WORKSPACE_ID } from '../inventory/reserve';
import { commerceProvisionOptions } from '../provisioning/provision';

/** A fixed key every fixture takes before provisioning (serializes ALTER ROLE). */
const PROVISION_LOCK_KEY = 74_610_010;

export interface StorefrontFixtures {
  /** Owner-role postgres.js connection (raw counts, provisioning). */
  owner: postgres.Sql;
  /** Owner-role Kysely base; scope it with tenantDb(base, tg) to seed. */
  ownerBase: Kysely<CommerceDB>;
  /** Prisma on the same database, for the public Site / SiteDomain rows. */
  prisma: PrismaClient;
  close(): Promise<void>;
}

/** Open the owner connections on the globalSetup database. */
export function openStorefrontFixtures(): StorefrontFixtures {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.COMMERCE_APP_DATABASE_URL) {
    throw new Error(
      'storefrontFixtures: DATABASE_URL / COMMERCE_APP_DATABASE_URL are unset; run under `pnpm test:integration`',
    );
  }
  const owner = postgres(url, { max: 1, prepare: false, transform: { undefined: null } });
  const ownerBase = createNodeDb<CommerceDB>({ connectionString: url });
  const prisma = new PrismaClient({ datasourceUrl: url });
  return {
    owner,
    ownerBase,
    prisma,
    async close() {
      await prisma.$disconnect();
      await ownerBase.destroy();
      await owner.end();
    },
  };
}

/**
 * A Kysely base on the LOW-PRIVILEGE `commerce_app` role (the role the routes
 * connect as), for suites that prove what that role may NOT do (the append-only
 * REVOKEs). Scope it with tenantDb(base, tgId); destroy it in afterAll.
 */
export function openCommerceAppBase(): Kysely<CommerceDB> {
  const url = process.env.COMMERCE_APP_DATABASE_URL;
  if (!url) {
    throw new Error(
      'storefrontFixtures: COMMERCE_APP_DATABASE_URL is unset; run under `pnpm test:integration`',
    );
  }
  return createNodeDb<CommerceDB>({ connectionString: url });
}

export interface ProvisionedTenant {
  tgId: TenantGroupId;
  schema: string;
  /** Owner-scoped handle into tg_<id> for seeding and direct assertions. */
  db: Kysely<CommerceDB>;
}

/** Provision a fresh tenant group (random UUID) with the commerce migrations. */
export async function provisionCommerceTenant(
  fx: StorefrontFixtures,
  slugPrefix: string,
): Promise<ProvisionedTenant> {
  const tgId = assertTenantGroupId(randomUUID());
  await fx.owner`SELECT pg_advisory_lock(${PROVISION_LOCK_KEY})`;
  try {
    // The production options (migrations, app-role grants, append-only REVOKE
    // seed), so the suites exercise exactly what an onboard provisions.
    await provisionTenant(fx.owner, commerceProvisionOptions(tgId, `${slugPrefix}-${tgId.slice(0, 8)}`));
  } finally {
    await fx.owner`SELECT pg_advisory_unlock(${PROVISION_LOCK_KEY})`;
  }
  return { tgId, schema: tenantSchema(tgId), db: tenantDb(fx.ownerBase, tgId) };
}

/**
 * Create a PUBLISHED site + its SiteDomain for `tenantGroupId` (any string, so a
 * suite can also stamp an invalid one to prove fail-closed). Returns the Host
 * header that resolves to it: `<subdomain>.example.com`, three labels, which
 * parseSubdomain accepts without PUBLIC_SITE_BASE_HOST.
 */
export async function createPublishedSite(
  fx: StorefrontFixtures,
  tenantGroupId: string,
  label: string,
): Promise<{ host: string; siteId: string; workspaceId: string }> {
  const subdomain = `${label}-${randomUUID().slice(0, 8)}`;
  const workspaceId = `ws-${subdomain}`;
  const site = await fx.prisma.site.create({
    data: {
      workspaceId,
      tenantGroupId,
      name: `Store ${label}`,
      status: 'published',
      projectCreatedAt: new Date(),
      projectUpdatedAt: new Date(),
    },
  });
  await fx.prisma.siteDomain.create({
    data: {
      siteId: site.id,
      workspaceId,
      tenantGroupId,
      subdomain,
      verificationStatus: 'active',
      isPrimary: true,
    },
  });
  return { host: `${subdomain}.example.com`, siteId: site.id, workspaceId };
}

export interface SeededProduct {
  productId: string;
  handle: string;
  title: string;
  variantId: string;
  inventoryItemId: string;
  locationId: string;
}

/**
 * Seed one buyable product into a tenant schema: product + option/value +
 * variant (with its option matrix row) + base price (integer cents) + the
 * SKU-bridged inventory item, a stock location, its inventory level, and the
 * workspace default fulfillment location the order reserve falls back to.
 */
export async function seedBuyableProduct(
  db: Kysely<CommerceDB>,
  opts: { title: string; handle: string; amountCents: number; stocked: number; currency?: string },
): Promise<SeededProduct> {
  const now = new Date();
  const productId = randomUUID();
  await db
    .insertInto('product')
    .values({ id: productId, title: opts.title, handle: opts.handle, updated_at: now })
    .execute();

  const optionId = randomUUID();
  await db
    .insertInto('product_option')
    .values({ id: optionId, product_id: productId, title: 'Color', updated_at: now })
    .execute();
  const valueId = randomUUID();
  await db
    .insertInto('product_option_value')
    .values({ id: valueId, option_id: optionId, value: 'Red', updated_at: now })
    .execute();

  const variantId = randomUUID();
  const sku = `SKU-${randomUUID()}`;
  await db
    .insertInto('product_variant')
    .values({ id: variantId, product_id: productId, title: 'Red', sku, updated_at: now })
    .execute();
  await db
    .insertInto('product_variant_option')
    .values({ variant_id: variantId, option_id: optionId, option_value_id: valueId })
    .execute();

  const priceSetId = randomUUID();
  await db
    .insertInto('price_set')
    .values({ id: priceSetId, variant_id: variantId, updated_at: now })
    .execute();
  await db
    .insertInto('price')
    .values({
      id: randomUUID(),
      price_set_id: priceSetId,
      currency_code: opts.currency ?? 'EUR',
      amount: opts.amountCents,
      updated_at: now,
    })
    .execute();

  const inventoryItemId = randomUUID();
  await db
    .insertInto('inventory_item')
    .values({ id: inventoryItemId, sku, updated_at: now })
    .execute();
  const locationId = randomUUID();
  await db
    .insertInto('stock_location')
    .values({ id: locationId, name: `WH-${randomUUID()}`, updated_at: now })
    .execute();
  await db
    .insertInto('inventory_level')
    .values({
      id: randomUUID(),
      inventory_item_id: inventoryItemId,
      location_id: locationId,
      stocked_quantity: opts.stocked,
      reserved_quantity: 0,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('fulfillment_location_default')
    .values({ workspace_id: DEFAULT_WORKSPACE_ID, location_id: locationId, updated_at: now })
    .onConflict((oc) => oc.column('workspace_id').doUpdateSet({ location_id: locationId }))
    .execute();

  return {
    productId,
    handle: opts.handle,
    title: opts.title,
    variantId,
    inventoryItemId,
    locationId,
  };
}

/** count(*) of a table inside one tenant schema (owner role, schema-qualified). */
export async function countInSchema(
  fx: StorefrontFixtures,
  schema: string,
  table: string,
): Promise<number> {
  const rows = await fx.owner<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ${fx.owner(schema)}.${fx.owner(table)}
  `;
  return rows[0].n;
}
