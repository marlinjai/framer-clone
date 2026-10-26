// src/server/commerce/__tests__/catalogue-company.itest.ts
//
// The catalogue per company, migration 020_catalogue_company (docs/plans/2026-10-25-catalogue-design.md,
// slice 1), against real Postgres:
//
//   1. the migration on a schema that already holds rows (provisioned up to 019, then the fleet runner):
//      existing products and orders go to the schema's sole company, children follow their parent, the
//      Books' own list moves in as catalogue products with their price, a re-run moves nothing twice, and
//      a schema with two companies leaves its rows unassigned;
//   2. the guarantees on a fresh schema: a new row must name its company, a child cannot hang under
//      another company's parent, a service has one variant and no options, a product at most three
//      options, handles are unique per company;
//   3. the application: the storefront shows only the site's company's published, unarchived products that
//      are not hidden for the site; an order is refused another company's variant and records company and
//      site; a site not stamped yet falls back to the sole company; the editor's stamp fills an empty
//      company and never overwrites one.
// All data is synthetic.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import postgres from 'postgres';
import type { Kysely } from 'kysely';
import { assertTenantGroupId, migratePublic, provisionTenant, tenantSchema } from '@marlinjai/tenant-db';

import type { CommerceDB } from '../db-types';
import { COMMERCE_TENANT_MIGRATIONS } from '../migrations/tenant';
import { commerceProvisionOptions, migrateAllCommerceTenants } from '../provisioning/provision';
import { assignCatalogueCompany } from '../provisioning/assignCompany';
import { catalogRepository } from '../repository/catalog';
import { pricingRepository } from '../repository/pricing';
import { commerceReadRepository } from '../repository/read';
import { listStorefrontProducts, resolveOrderLines } from '../repository/storefront';
import { UnknownVariantError } from '../repository/errors';
import { companyForSite, soleCompany } from '../company';
import { booksScope } from '@/server/books/scope';
import { createOrder } from '../order/createOrder';
import {
  FakeDirectory,
  initCompany,
  openBooksEnv,
  provisionAnotherGroup,
  rejectionCode,
  type BooksEnv,
} from '@/server/books/__tests__/booksFixtures';

const COMPANY_A = '018f9c10-0000-7000-8000-00000000c0a1';
const COMPANY_B = '018f9c10-0000-7000-8000-00000000c0b2';

// --- 1. the migration on existing rows -----------------------------------------------------------

describe('020_catalogue_company on a schema that already holds rows', () => {
  const DB_NAME = 'catalogue_company';
  let container: StartedTestContainer | undefined;
  let ownerUrl: string;
  let owner: postgres.Sql;

  beforeAll(async () => {
    container = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({ POSTGRES_USER: 'postgres', POSTGRES_DB: DB_NAME, POSTGRES_HOST_AUTH_METHOD: 'trust' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
    ownerUrl = `postgresql://postgres@${container.getHost()}:${container.getMappedPort(5432)}/${DB_NAME}`;
    owner = postgres(ownerUrl, { max: 1, prepare: false, onnotice: () => {} });
    await owner`CREATE ROLE commerce_app LOGIN`;
    await owner`ALTER ROLE commerce_app SET search_path = ext`;
    await migratePublic(owner);
    await owner`GRANT USAGE ON SCHEMA ext TO commerce_app`;
  }, 180_000);

  afterAll(async () => {
    await owner?.end();
    await container?.stop();
  });

  /** A schema at 019 with a legacy product graph, an order, and the given Books companies. */
  async function legacySchema(companies: string[]): Promise<string> {
    const tgId = assertTenantGroupId(randomUUID());
    await provisionTenant(owner, {
      ...commerceProvisionOptions(tgId, `cat-${tgId.slice(0, 8)}`),
      tenantMigrations: COMMERCE_TENANT_MIGRATIONS.filter((m) => m.id < '020'),
    });
    const schema = tenantSchema(tgId);
    await owner.begin(async (tx) => {
      await tx`INSERT INTO ${tx(schema)}.product (id, title, handle, updated_at) VALUES ('p1', 'Ring', 'ring', now())`;
      await tx`INSERT INTO ${tx(schema)}.product_option (id, product_id, title, updated_at) VALUES ('o1', 'p1', 'Size', now())`;
      await tx`INSERT INTO ${tx(schema)}.product_option_value (id, option_id, value, updated_at) VALUES ('ov1', 'o1', '52', now())`;
      await tx`INSERT INTO ${tx(schema)}.product_variant (id, product_id, sku, updated_at) VALUES ('v1', 'p1', 'RING-52', now())`;
      await tx`INSERT INTO ${tx(schema)}.product_variant_option (variant_id, option_id, option_value_id) VALUES ('v1', 'o1', 'ov1')`;
      await tx`INSERT INTO ${tx(schema)}.price_set (id, variant_id, updated_at) VALUES ('ps1', 'v1', now())`;
      await tx`INSERT INTO ${tx(schema)}.price (id, price_set_id, currency_code, amount, updated_at) VALUES ('pr1', 'ps1', 'EUR', 4900, now())`;
      await tx`INSERT INTO ${tx(schema)}."order" (id, order_number, request_id, currency_code, tax_region, subtotal, tax_amount, total, updated_at)
               VALUES ('ord1', 'ORD-000001', 'rq1', 'EUR', 'DE', 1000, 190, 1190, now())`;
      await tx`INSERT INTO ${tx(schema)}.order_line_item (id, order_id, unit_price, quantity, subtotal, tax_rate, tax_amount, tax_treatment)
               VALUES ('li1', 'ord1', 1000, 1, 1000, 1900, 190, 'standard')`;
      for (const [i, company] of companies.entries()) {
        await tx`INSERT INTO ${tx(schema)}.books_product (id, tenant_id, kind, name, name_key, search_text, unit_label, unit_price, price_basis, tax_class, discount_bp, updated_at, archived_at)
                 VALUES (${`bp-${i}-s`}, ${company}, 'service', ${`Beratung ${i}`}, ${`beratung ${i}`}, ${`beratung ${i}`}, 'Std', 9500, 'net', 'standard', 500, now(), NULL),
                        (${`bp-${i}-p`}, ${company}, 'product', ${`Kabel ${i}`}, ${`kabel ${i}`}, ${`kabel ${i}`}, 'Stk', 1200, 'gross', 'reduced', 0, now(), now())`;
      }
    });
    return schema;
  }

  async function companiesOf(schema: string) {
    return owner.begin(async (tx) => {
      return {
        product: (await tx`SELECT tenant_id FROM ${tx(schema)}.product WHERE books_product_id IS NULL`).map((r) => r.tenant_id),
        option: (await tx`SELECT tenant_id FROM ${tx(schema)}.product_option`).map((r) => r.tenant_id),
        value: (await tx`SELECT tenant_id FROM ${tx(schema)}.product_option_value`).map((r) => r.tenant_id),
        matrix: (await tx`SELECT tenant_id FROM ${tx(schema)}.product_variant_option`).map((r) => r.tenant_id),
        priceSet: (await tx`SELECT tenant_id FROM ${tx(schema)}.price_set WHERE id = 'ps1'`).map((r) => r.tenant_id),
        price: (await tx`SELECT tenant_id FROM ${tx(schema)}.price WHERE id = 'pr1'`).map((r) => r.tenant_id),
        order: (await tx`SELECT tenant_id FROM ${tx(schema)}."order"`).map((r) => r.tenant_id),
        line: (await tx`SELECT tenant_id FROM ${tx(schema)}.order_line_item`).map((r) => r.tenant_id),
      };
    });
  }

  it('assigns every existing row to the sole company and moves the Books list in with its prices', async () => {
    const schema = await legacySchema([COMPANY_A]);
    const result = await migrateAllCommerceTenants({ connectionString: ownerUrl });
    // 020 and every migration after it.
    expect(result.schemas.find((s) => s.schema === schema)?.applied).toEqual(
      COMMERCE_TENANT_MIGRATIONS.filter((m) => m.id >= '020').map((m) => m.id),
    );

    expect(await companiesOf(schema)).toEqual({
      product: [COMPANY_A],
      option: [COMPANY_A],
      value: [COMPANY_A],
      matrix: [COMPANY_A],
      priceSet: [COMPANY_A],
      price: [COMPANY_A],
      order: [COMPANY_A],
      line: [COMPANY_A],
    });

    const moved = await owner.begin(async (tx) => {
      return tx`
        SELECT p.books_product_id, p.tenant_id, p.kind, p.title, p.status::text AS status, p.unit_label, p.price_basis,
               p.tax_class, p.discount_bp, p.archived_at IS NOT NULL AS archived, v.manage_inventory, pr.amount, pr.currency_code,
               (SELECT count(*)::int FROM ${tx(schema)}.product_variant x WHERE x.product_id = p.id) AS variants
          FROM ${tx(schema)}.product p
          JOIN ${tx(schema)}.product_variant v ON v.product_id = p.id
          JOIN ${tx(schema)}.price_set s ON s.variant_id = v.id
          JOIN ${tx(schema)}.price pr ON pr.price_set_id = s.id
         WHERE p.books_product_id IS NOT NULL
         ORDER BY p.books_product_id`;
    });
    // The existing product keeps the net basis the shop priced it on.
    const legacy = await owner`SELECT price_basis FROM ${owner(schema)}.product WHERE id = 'p1'`;
    expect(legacy[0].price_basis).toBe('net');
    expect(moved.map((r) => ({ ...r }))).toEqual([
      {
        books_product_id: 'bp-0-p', tenant_id: COMPANY_A, kind: 'physical', title: 'Kabel 0', status: 'draft',
        unit_label: 'Stk', price_basis: 'gross', tax_class: 'reduced', discount_bp: 0, archived: true,
        manage_inventory: false, amount: 1200, currency_code: 'EUR', variants: 1,
      },
      {
        books_product_id: 'bp-0-s', tenant_id: COMPANY_A, kind: 'service', title: 'Beratung 0', status: 'draft',
        unit_label: 'Std', price_basis: 'net', tax_class: 'standard', discount_bp: 500, archived: false,
        manage_inventory: false, amount: 9500, currency_code: 'EUR', variants: 1,
      },
    ]);
  });

  it('a second run of the move changes nothing (idempotent through books_product_id)', async () => {
    const schema = await legacySchema([COMPANY_A]);
    await migrateAllCommerceTenants({ connectionString: ownerUrl });
    const count = async () =>
      owner.begin(async (tx) => {
        const [p] = await tx`SELECT count(*)::int AS n FROM ${tx(schema)}.product`;
        const [pr] = await tx`SELECT count(*)::int AS n FROM ${tx(schema)}.price`;
        return { products: p.n as number, prices: pr.n as number };
      });
    const before = await count();
    // Forget that 020 ran and let the fleet runner apply it a second time (its body is re-runnable).
    await owner`DELETE FROM ${owner(schema)}.__tenant_db_migrations WHERE id = '020_catalogue_company'`;
    const again = await migrateAllCommerceTenants({ connectionString: ownerUrl });
    expect(again.schemas.find((x) => x.schema === schema)?.applied).toEqual(['020_catalogue_company']);
    expect(await count()).toEqual(before);
  });

  it('with two companies in the schema, the legacy rows stay unassigned and cannot be edited until assigned', async () => {
    const schema = await legacySchema([COMPANY_A, COMPANY_B]);
    await migrateAllCommerceTenants({ connectionString: ownerUrl });
    const companies = await companiesOf(schema);
    expect(companies.product).toEqual([null]);
    expect(companies.order).toEqual([null]);
    const code = await owner
      .begin(async (tx) => {
        await tx`UPDATE ${tx(schema)}.product SET title = 'Ring II' WHERE id = 'p1'`;
      })
      .then(() => 'updated')
      .catch((err: { code?: string; constraint_name?: string }) => `${err.code}:${err.constraint_name}`);
    expect(code).toBe('23514:product_tenant_id_present');
    // The Books items moved in under their own companies.
    const moved = await owner.begin(async (tx) => {
      return tx`SELECT tenant_id FROM ${tx(schema)}.product WHERE books_product_id IS NOT NULL ORDER BY books_product_id`;
    });
    expect(moved.map((r) => r.tenant_id)).toEqual([COMPANY_A, COMPANY_A, COMPANY_B, COMPANY_B]);
  });

  it('the operator assigns the rest to their company and validates the constraints; a re-run changes nothing', async () => {
    const schema = await legacySchema([COMPANY_A, COMPANY_B]);
    await migrateAllCommerceTenants({ connectionString: ownerUrl });
    const tenantGroupId = `${schema.slice(3, 11)}-${schema.slice(11, 15)}-${schema.slice(15, 19)}-${schema.slice(19, 23)}-${schema.slice(23)}`;
    const first = await assignCatalogueCompany({ connectionString: ownerUrl, tenantGroupId, companyId: COMPANY_B, validate: true });
    expect(first).toEqual({
      assigned: {
        product: 1,
        order: 1,
        product_option: 1,
        product_option_value: 1,
        product_variant: 1,
        product_variant_option: 1,
        price_set: 1,
        price: 1,
        order_line_item: 1,
      },
      // The legacy ring was a draft the old storefront showed anyway: published with its assignment.
      published: 1,
      validated: true,
    });
    expect((await companiesOf(schema)).line).toEqual([COMPANY_B]);
    const validated = await owner`
      SELECT bool_and(c.convalidated) AS all_valid
        FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = ${schema} AND c.conname LIKE '%_tenant_id_present'`;
    expect(validated[0].all_valid).toBe(true);
    const again = await assignCatalogueCompany({ connectionString: ownerUrl, tenantGroupId, companyId: COMPANY_A });
    expect(Object.values(again.assigned).every((n) => n === 0)).toBe(true);
    expect((await companiesOf(schema)).product).toEqual([COMPANY_B]);
    const ring = await owner`SELECT status::text AS status FROM ${owner(schema)}.product WHERE id = 'p1'`;
    expect(ring[0].status).toBe('published');
  });
});

// --- 2. and 3. a fresh schema -------------------------------------------------------------------

describe('the catalogue per company on a fresh schema', () => {
  let env: BooksEnv;
  let db: Kysely<CommerceDB>;

  beforeAll(async () => {
    env = await openBooksEnv('catalogue-company');
    db = env.ownerDb;
  }, 120_000);

  afterAll(async () => {
    await env?.close();
  });

  /** A published product of `company` with one priced, stocked variant. */
  async function product(company: string, opts: { handle?: string; status?: 'draft' | 'published' } = {}) {
    const p = await catalogRepository.createProduct(db, {
      tenantId: company,
      title: 'Ring',
      handle: opts.handle ?? `ring-${randomUUID().slice(0, 8)}`,
      status: opts.status ?? 'published',
    });
    const sku = `SKU-${randomUUID()}`;
    const v = await catalogRepository.addVariant(db, { tenantId: company, productId: p.id, sku });
    const set = await pricingRepository.createPriceSet(db, { tenantId: company, variantId: v.id });
    await pricingRepository.addPrice(db, { tenantId: company, priceSetId: set.id, currency: 'EUR', amount: 4900 });
    return { productId: p.id, variantId: v.id, sku };
  }

  it('a new row without a company is refused, for the app role too', async () => {
    const insert = (handle: typeof db) =>
      handle
        .insertInto('product')
        .values({ id: randomUUID(), title: 'Nameless', handle: `n-${randomUUID().slice(0, 8)}`, updated_at: new Date() })
        .execute();
    expect(await rejectionCode(insert(env.ownerDb))).toBe('23514');
    expect(await rejectionCode(insert(env.appDb))).toBe('23514');
  });

  it("a child cannot hang under another company's parent (composite foreign key)", async () => {
    const a = await product(COMPANY_A);
    expect(
      await rejectionCode(catalogRepository.addOption(db, { tenantId: COMPANY_B, productId: a.productId, title: 'Size' })),
    ).toBe('23503');
    expect(
      await rejectionCode(catalogRepository.addVariant(db, { tenantId: COMPANY_B, productId: a.productId, sku: `X-${randomUUID()}` })),
    ).toBe('23503');
    // A variant of A without a price set yet: B cannot attach one to it.
    const bare = await catalogRepository.addVariant(db, { tenantId: COMPANY_A, productId: a.productId, sku: `B-${randomUUID()}` });
    expect(await rejectionCode(pricingRepository.createPriceSet(db, { tenantId: COMPANY_B, variantId: bare.id }))).toBe('23503');
  });

  it('a service has exactly one variant and no options; a product at most three options (BK017)', async () => {
    const s = await catalogRepository.createProduct(db, {
      tenantId: COMPANY_A,
      title: 'Beratung',
      handle: `beratung-${randomUUID().slice(0, 8)}`,
      kind: 'service',
    });
    await catalogRepository.addVariant(db, { tenantId: COMPANY_A, productId: s.id });
    expect(await rejectionCode(catalogRepository.addVariant(db, { tenantId: COMPANY_A, productId: s.id }))).toBe('BK017');
    expect(await rejectionCode(catalogRepository.addOption(db, { tenantId: COMPANY_A, productId: s.id, title: 'Size' }))).toBe(
      'BK017',
    );

    const p = await product(COMPANY_A);
    for (const title of ['Size', 'Metal', 'Stone']) {
      await catalogRepository.addOption(db, { tenantId: COMPANY_A, productId: p.productId, title });
    }
    expect(
      await rejectionCode(catalogRepository.addOption(db, { tenantId: COMPANY_A, productId: p.productId, title: 'Finish' })),
    ).toBe('BK017');
  });

  it('two companies may use the same handle; one company may not use it twice', async () => {
    const handle = `same-${randomUUID().slice(0, 8)}`;
    await product(COMPANY_A, { handle });
    await product(COMPANY_B, { handle });
    expect(await rejectionCode(product(COMPANY_A, { handle }))).toBe('23505');
  });

  it("the storefront shows only the site's company's published, unarchived products not hidden for the site", async () => {
    const company = randomUUID();
    const other = randomUUID();
    const shown = await product(company);
    const draft = await product(company, { status: 'draft' });
    const archived = await product(company);
    await db.updateTable('product').set({ archived_at: new Date() }).where('id', '=', archived.productId).execute();
    const hidden = await product(company);
    await db
      .insertInto('product_site_hidden')
      .values({ tenant_id: company, product_id: hidden.productId, site_id: 'site-1' })
      .execute();
    const foreign = await product(other);

    const ids = async (siteId: string) =>
      (await listStorefrontProducts(env.appDb, { companyId: company, siteId }, { limit: 50, currency: 'EUR' })).products
        .map((p) => p.id)
        .sort();
    expect(await ids('site-1')).toEqual([shown.productId]);
    // Another site of the company still shows the product hidden only for site-1.
    expect(await ids('site-2')).toEqual([shown.productId, hidden.productId].sort());
    expect((await commerceReadRepository.listProducts(env.appDb, { companyId: company, siteId: 'site-1' })).total).toBe(1);

    // Ordering follows the same view: draft, archived, hidden and foreign variants are unknown.
    for (const v of [draft, archived, hidden, foreign]) {
      await expect(
        resolveOrderLines(env.appDb, { companyId: company, siteId: 'site-1' }, [{ variantId: v.variantId, quantity: 1 }]),
      ).rejects.toBeInstanceOf(UnknownVariantError);
    }
  });

  it("an order records its company and site, and is refused another company's variant", async () => {
    const company = randomUUID();
    const mine = await product(company);
    const theirs = await product(randomUUID());
    const itemFor = async (sku: string) => {
      const item = randomUUID();
      const location = randomUUID();
      await db.insertInto('inventory_item').values({ id: item, sku, updated_at: new Date() }).execute();
      await db.insertInto('stock_location').values({ id: location, name: `WH-${location}`, updated_at: new Date() }).execute();
      await db
        .insertInto('inventory_level')
        .values({ id: randomUUID(), inventory_item_id: item, location_id: location, stocked_quantity: 5, reserved_quantity: 0, updated_at: new Date() })
        .execute();
      return { item, location };
    };
    const a = await itemFor(mine.sku);
    const placed = await createOrder(env.appDb, env.tgId, {
      tenantId: company,
      siteId: 'site-9',
      requestId: `rq-${randomUUID()}`,
      currency: 'EUR',
      taxRegion: 'DE',
      lines: [{ inventoryItemId: a.item, variantId: mine.variantId, quantity: 1, locationId: a.location }],
    });
    expect(placed.ok).toBe(true);
    const row = await db
      .selectFrom('order')
      .select(['tenant_id', 'site_id'])
      .where('id', '=', placed.ok ? placed.orderId : '')
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ tenant_id: company, site_id: 'site-9' });
    const lines = await db
      .selectFrom('order_line_item')
      .select('tenant_id')
      .where('order_id', '=', placed.ok ? placed.orderId : '')
      .execute();
    expect(lines).toEqual([{ tenant_id: company }]);

    const b = await itemFor(theirs.sku);
    await expect(
      createOrder(env.appDb, env.tgId, {
        tenantId: company,
        requestId: `rq-${randomUUID()}`,
        currency: 'EUR',
        taxRegion: 'DE',
        lines: [{ inventoryItemId: b.item, variantId: theirs.variantId, quantity: 1, locationId: b.location }],
      }),
    ).rejects.toBeInstanceOf(UnknownVariantError);
  });

  it('a site not stamped yet falls back to the sole company of the schema; a stamped site keeps its own', async () => {
    // A tenant group of its own: the other tests here fill this schema with several companies.
    const group = await provisionAnotherGroup(env, `sole-${randomUUID().slice(0, 8)}`);
    expect(await soleCompany(group.appDb)).toBeNull();
    expect(await companyForSite(group.appDb, { companyId: null })).toBeNull();
    // Only catalogue rows of one company (the demo shop after its legacy rows were assigned): that company.
    await catalogRepository.createProduct(group.ownerDb, { tenantId: COMPANY_B, title: 'Ring', handle: 'ring', status: 'published' });
    expect(await soleCompany(group.appDb)).toBe(COMPANY_B);
    // A second company appears through the Books: no single company any more.
    await initCompany(booksScope(group.appDb, group.tgId, COMPANY_A, { recipients: new FakeDirectory() }), { taxStatus: 'small_business' });
    expect(await soleCompany(group.appDb)).toBeNull();
    expect(await companyForSite(group.appDb, { companyId: null })).toBeNull();
    expect(await companyForSite(group.appDb, { companyId: COMPANY_A })).toBe(COMPANY_A);
  });
});
