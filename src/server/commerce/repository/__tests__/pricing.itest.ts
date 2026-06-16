// src/server/commerce/repository/__tests__/pricing.itest.ts
//
// Integration test (Dockerized Postgres) for the b5 pricing graph + catalog-side
// tax_class + the CreditNote no-DELETE contract. Like the b4 catalog test it
// boots its OWN throwaway Postgres in beforeAll (testcontainers), applies every
// migration (dt_* init + b2 ledger + b3 guarded reservation + b4 catalog + b5
// pricing/tax) and proves, against a LIVE database, the guarantees that cannot be
// mocked:
//
//   1. CENTS ROUND-TRIP: a price amount written as an integer number of minor
//      units (cents) reads back as the SAME integer, never a float. The Int
//      column physically cannot hold a fractional amount, and addPrice rejects a
//      float at the boundary so a rounding bug never reaches the database.
//   2. PRICE-LIST RESOLUTION: resolvePrice returns integer cents for a variant,
//      prefers an active price-list price over the base price, and falls back to
//      the base price when no list is requested. The result is always an integer.
//   3. TAX_CLASS: the catalog-side tax_class is set and read on both product and
//      product_variant (the ONLY tax surface b5 owns; rate resolution is E8).
//   4. NO-DELETE CONTRACT: a credit_note (Storno / Gutschrift) cannot be UPDATEd
//      or DELETEd by the ordinary application role (commerce_app), only INSERTed
//      and SELECTed, so a German invoice / its corrective note is append-only at
//      the database. The corrective document is therefore a new credit_note, never
//      an edit or erase of the record.
//
// The `.itest.ts` suffix keeps this file OUT of the headless `pnpm test` gate
// (vitest.config.ts matches only *.{test,spec}.{ts,tsx}); it runs only under
// `pnpm test:integration` against Docker. It requires a running Docker daemon.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

import { withTenant } from '../../withTenant';
import { catalogRepository } from '../catalog';
import { pricingRepository } from '../pricing';

let container: StartedTestContainer | undefined;
let prisma: PrismaClient | undefined;
// A second client authenticating as the DML-only application role, used to prove
// the no-DELETE contract bites for ordinary application traffic.
let appPrisma: PrismaClient | undefined;

const APP_ROLE = 'commerce_app';
const APP_PASSWORD = 'commerce_app_pw';

function makeUrl(user: string, password: string, host: string, port: number): string {
  return `postgresql://${user}:${password}@${host}:${port}/framer_clone_test`;
}

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'test',
      POSTGRES_PASSWORD: 'test',
      POSTGRES_DB: 'framer_clone_test',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const url = makeUrl('test', 'test', host, port);

  // Apply dt_* init + b2 ledger + b3 guarded reservation + b4 catalog + b5
  // pricing/tax.
  execSync('pnpm exec prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });

  prisma = new PrismaClient({ datasourceUrl: url });

  // Provision the commerce_app DML-only role and apply the SAME REVOKE the b5
  // migration encodes. In production the role is created out of band (per
  // prisma/sql/commerce-roles.sql) BEFORE migrations run, so the migration's
  // role-guarded REVOKE fires at deploy time. Here the role does not exist when
  // `migrate deploy` runs above, so that guarded REVOKE is skipped; we provision
  // the role and re-issue the identical REVOKE to assert the contract's security
  // OUTCOME against a live database. commerce_app is a non-owner role, so unlike
  // the superuser 'test' it is actually bound by table GRANT/REVOKE.
  await prisma.$executeRawUnsafe(
    `CREATE ROLE "${APP_ROLE}" LOGIN PASSWORD '${APP_PASSWORD}'`,
  );
  await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "commerce" TO "${APP_ROLE}"`);
  await prisma.$executeRawUnsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "commerce" TO "${APP_ROLE}"`,
  );
  // The no-DELETE-on-invoice contract (mirrors the b5 migration's guarded block).
  await prisma.$executeRawUnsafe(
    `REVOKE UPDATE, DELETE ON "commerce"."credit_note" FROM "${APP_ROLE}"`,
  );
  await prisma.$executeRawUnsafe(
    `REVOKE UPDATE, DELETE ON "commerce"."credit_note_ref" FROM "${APP_ROLE}"`,
  );

  appPrisma = new PrismaClient({ datasourceUrl: makeUrl(APP_ROLE, APP_PASSWORD, host, port) });
}, 180_000);

afterAll(async () => {
  await appPrisma?.$disconnect();
  await prisma?.$disconnect();
  await container?.stop();
});

// Flatten a Prisma / Postgres error into one searchable string so a rejection can
// be asserted against the SPECIFIC SQLSTATE / message rather than a bare throw.
function errorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as { message?: unknown; meta?: unknown; code?: unknown };
    const parts: string[] = [];
    if (typeof e.message === 'string') parts.push(e.message);
    if (typeof e.code === 'string') parts.push(e.code);
    if (e.meta) parts.push(JSON.stringify(e.meta));
    return parts.join(' | ');
  }
  return String(error);
}

async function expectRejectionMatching(
  op: () => Promise<unknown>,
  ...patterns: RegExp[]
): Promise<void> {
  let caught: unknown;
  let threw = false;
  try {
    await op();
  } catch (error) {
    threw = true;
    caught = error;
  }
  expect(threw, 'expected the operation to reject, but it resolved').toBe(true);
  const text = errorText(caught);
  for (const pattern of patterns) {
    expect(text, `rejection text did not match ${pattern}: ${text}`).toMatch(pattern);
  }
}

/** Create a product + a single variant, returning the variant id. */
async function makeVariant(db: PrismaClient, handle: string, sku: string): Promise<string> {
  const product = await withTenant(db, (tx) =>
    catalogRepository.createProduct(tx, { title: handle, handle }),
  );
  const variant = await withTenant(db, (tx) =>
    catalogRepository.addVariant(tx, { productId: product.id, sku }),
  );
  return variant.id;
}

describe('b5 pricing graph + tax_class + CreditNote (Dockerized Postgres)', () => {
  it('price amounts round-trip as integer cents and a float amount is rejected', async () => {
    const db = prisma!;
    const variantId = await makeVariant(db, 'tee-cents', 'TEE-CENTS-1');

    const priceSet = await withTenant(db, (tx) =>
      pricingRepository.createPriceSet(tx, { variantId }),
    );

    // 1999 cents (19.99 EUR) written as an integer.
    const created = await withTenant(db, (tx) =>
      pricingRepository.addPrice(tx, { priceSetId: priceSet.id, currency: 'EUR', amount: 1999 }),
    );
    expect(created.amount).toBe(1999);
    expect(Number.isInteger(created.amount)).toBe(true);

    // Re-read straight from the database: still the exact integer, no float drift.
    const reread = await db.price.findUniqueOrThrow({ where: { id: created.id } });
    expect(reread.amount).toBe(1999);
    expect(Number.isInteger(reread.amount)).toBe(true);

    // A float amount (euros instead of cents) is rejected at the boundary, so a
    // rounding bug can never be persisted.
    await expectRejectionMatching(
      () =>
        withTenant(db, (tx) =>
          pricingRepository.addPrice(tx, {
            priceSetId: priceSet.id,
            currency: 'EUR',
            amount: 19.99,
          }),
        ),
      /integer number of minor units|cents/,
    );
  });

  it('resolvePrice returns integer cents and prefers an active price-list price over the base price', async () => {
    const db = prisma!;
    const variantId = await makeVariant(db, 'hoodie-resolve', 'HOOD-RES-1');

    const priceSet = await withTenant(db, (tx) =>
      pricingRepository.createPriceSet(tx, { variantId }),
    );

    // Base price: 2000 cents.
    await withTenant(db, (tx) =>
      pricingRepository.addPrice(tx, { priceSetId: priceSet.id, currency: 'EUR', amount: 2000 }),
    );

    // An active sale price list with a 1500-cent price for the same variant.
    const list = await db.priceList.create({
      data: { title: 'Summer Sale', status: 'active', type: 'sale' },
    });
    await withTenant(db, (tx) =>
      pricingRepository.addPrice(tx, {
        priceSetId: priceSet.id,
        currency: 'EUR',
        amount: 1500,
        priceListId: list.id,
      }),
    );

    // With the list requested, the price-list price wins: 1500 cents (integer).
    const withList = await withTenant(db, (tx) =>
      pricingRepository.resolvePrice(tx, variantId, {
        currency: 'EUR',
        priceListIds: [list.id],
      }),
    );
    expect(withList).toBe(1500);
    expect(Number.isInteger(withList)).toBe(true);

    // Without the list, only the base price applies: 2000 cents.
    const baseOnly = await withTenant(db, (tx) =>
      pricingRepository.resolvePrice(tx, variantId, { currency: 'EUR' }),
    );
    expect(baseOnly).toBe(2000);

    // A draft list is invisible even when requested: a draft override of 1000 is
    // ignored, so the base price stands.
    const draft = await db.priceList.create({
      data: { title: 'Unpublished', status: 'draft', type: 'override' },
    });
    await withTenant(db, (tx) =>
      pricingRepository.addPrice(tx, {
        priceSetId: priceSet.id,
        currency: 'EUR',
        amount: 1000,
        priceListId: draft.id,
      }),
    );
    const draftIgnored = await withTenant(db, (tx) =>
      pricingRepository.resolvePrice(tx, variantId, {
        currency: 'EUR',
        priceListIds: [draft.id],
      }),
    );
    expect(draftIgnored).toBe(2000);

    // A variant with no price_set resolves to null (no price, surfaced honestly).
    const orphanVariantId = await makeVariant(db, 'orphan-resolve', 'ORPH-RES-1');
    const none = await withTenant(db, (tx) =>
      pricingRepository.resolvePrice(tx, orphanVariantId, { currency: 'EUR' }),
    );
    expect(none).toBeNull();
  });

  it('the database CHECK constraints bite: negative amount, inverted/negative band, mis-cased currency are all rejected', async () => {
    const db = prisma!;
    const variantId = await makeVariant(db, 'tee-checks', 'TEE-CHECKS-1');
    const priceSet = await withTenant(db, (tx) =>
      pricingRepository.createPriceSet(tx, { variantId }),
    );

    // The application-level assertIntegerCents would catch a negative amount
    // before the insert, so to prove the DATABASE floor itself we INSERT raw,
    // bypassing the repository guard. price_amount_nonneg_check (SQLSTATE 23514)
    // rejects a negative price.amount, so a money-losing price can never land.
    await expectRejectionMatching(
      () =>
        db.$executeRawUnsafe(
          `INSERT INTO "commerce"."price" ("id", "price_set_id", "currency_code", "amount", "updated_at")
             VALUES (gen_random_uuid(), $1, 'EUR', -1, CURRENT_TIMESTAMP)`,
          priceSet.id,
        ),
      /23514|price_amount_nonneg_check|violates check constraint/,
    );

    // credit_note_amount_nonneg_check: a negative credit-note amount is rejected.
    await expectRejectionMatching(
      () =>
        db.$executeRawUnsafe(
          `INSERT INTO "commerce"."credit_note" ("id", "currency_code", "amount", "created_at")
             VALUES (gen_random_uuid(), 'EUR', -1, CURRENT_TIMESTAMP)`,
        ),
      /23514|credit_note_amount_nonneg_check|violates check constraint/,
    );

    // price_quantity_band_check: an inverted band (min > max) can never match a
    // quantity and would silently drop the price from resolution, so it is
    // rejected loudly instead.
    await expectRejectionMatching(
      () =>
        db.$executeRawUnsafe(
          `INSERT INTO "commerce"."price" ("id", "price_set_id", "currency_code", "amount", "min_quantity", "max_quantity", "updated_at")
             VALUES (gen_random_uuid(), $1, 'EUR', 1000, 5, 3, CURRENT_TIMESTAMP)`,
          priceSet.id,
        ),
      /23514|price_quantity_band_check|violates check constraint/,
    );

    // price_min_quantity_nonneg_check: a negative band edge is rejected.
    await expectRejectionMatching(
      () =>
        db.$executeRawUnsafe(
          `INSERT INTO "commerce"."price" ("id", "price_set_id", "currency_code", "amount", "min_quantity", "updated_at")
             VALUES (gen_random_uuid(), $1, 'EUR', 1000, -1, CURRENT_TIMESTAMP)`,
          priceSet.id,
        ),
      /23514|price_min_quantity_nonneg_check|violates check constraint/,
    );

    // price_currency_code_iso4217_check: a mis-cased 'eur' would silently resolve
    // to NO price (resolvePrice matches currencyCode exactly), so the ISO-4217
    // alpha-3 UPPERCASE shape is enforced at the database.
    await expectRejectionMatching(
      () =>
        db.$executeRawUnsafe(
          `INSERT INTO "commerce"."price" ("id", "price_set_id", "currency_code", "amount", "updated_at")
             VALUES (gen_random_uuid(), $1, 'eur', 1000, CURRENT_TIMESTAMP)`,
          priceSet.id,
        ),
      /23514|price_currency_code_iso4217_check|violates check constraint/,
    );

    // A well-formed row still inserts cleanly: the CHECKs reject only the bad shapes.
    const ok = await withTenant(db, (tx) =>
      pricingRepository.addPrice(tx, {
        priceSetId: priceSet.id,
        currency: 'EUR',
        amount: 1000,
        minQuantity: 1,
        maxQuantity: 10,
      }),
    );
    expect(ok.amount).toBe(1000);
  });

  it('tax_class is set and read on product and variant', async () => {
    const db = prisma!;
    const product = await withTenant(db, (tx) =>
      catalogRepository.createProduct(tx, { title: 'Book', handle: 'book-tax' }),
    );
    const variant = await withTenant(db, (tx) =>
      catalogRepository.addVariant(tx, { productId: product.id, sku: 'BOOK-TAX-1' }),
    );

    // Catalog-side tax classification: a reduced-rate class on the product, a
    // standard-rate override on the variant. b5 stores the classification only;
    // mapping a class to a rate is the bought tax engine's job (E8).
    await db.product.update({
      where: { id: product.id },
      data: { taxClass: 'de_reduced_7' },
    });
    await db.productVariant.update({
      where: { id: variant.id },
      data: { taxClass: 'de_standard_19' },
    });

    const reReadProduct = await db.product.findUniqueOrThrow({ where: { id: product.id } });
    const reReadVariant = await db.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
    expect(reReadProduct.taxClass).toBe('de_reduced_7');
    expect(reReadVariant.taxClass).toBe('de_standard_19');

    // tax_class is nullable: an unset variant reads back null (inherits at E8).
    const bare = await withTenant(db, (tx) =>
      catalogRepository.addVariant(tx, { productId: product.id, sku: 'BOOK-TAX-2' }),
    );
    const reReadBare = await db.productVariant.findUniqueOrThrow({ where: { id: bare.id } });
    expect(reReadBare.taxClass).toBeNull();
  });

  it('a credit note is append-only for commerce_app: INSERT/SELECT allowed, UPDATE/DELETE denied (no-DELETE contract)', async () => {
    const db = prisma!;
    const app = appPrisma!;

    // A credit note created by the owner role, referencing a corrected document
    // via the loose credit_note_ref junction (the hard FK to Order is wired by b6).
    const note = await db.creditNote.create({
      data: {
        currencyCode: 'EUR',
        amount: 1999,
        reason: 'Storno: wrong address',
        correctedRef: 'order-placeholder-id',
        refs: { create: [{ refType: 'order', refId: 'order-placeholder-id' }] },
      },
      include: { refs: true },
    });
    expect(note.amount).toBe(1999);
    expect(note.refs).toHaveLength(1);
    expect(note.refs[0].refType).toBe('order');

    // commerce_app may SELECT the credit note.
    const seen = await app.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "commerce"."credit_note" WHERE "id" = $1`,
      note.id,
    );
    expect(seen).toHaveLength(1);

    // commerce_app may INSERT a new credit note (issuing a correction is allowed).
    const inserted = await app.$executeRawUnsafe(
      `INSERT INTO "commerce"."credit_note" ("id", "currency_code", "amount", "created_at")
         VALUES (gen_random_uuid(), 'EUR', 500, CURRENT_TIMESTAMP)`,
    );
    expect(inserted).toBe(1);

    // commerce_app may NOT UPDATE a credit note: permission denied (SQLSTATE 42501).
    await expectRejectionMatching(
      () =>
        app.$executeRawUnsafe(
          `UPDATE "commerce"."credit_note" SET "reason" = 'tampered' WHERE "id" = $1`,
          note.id,
        ),
      /42501|permission denied/,
    );

    // commerce_app may NOT DELETE a credit note: this is the no-DELETE contract.
    await expectRejectionMatching(
      () =>
        app.$executeRawUnsafe(`DELETE FROM "commerce"."credit_note" WHERE "id" = $1`, note.id),
      /42501|permission denied/,
    );

    // commerce_app may NOT DELETE the junction either.
    await expectRejectionMatching(
      () =>
        app.$executeRawUnsafe(
          `DELETE FROM "commerce"."credit_note_ref" WHERE "credit_note_id" = $1`,
          note.id,
        ),
      /42501|permission denied/,
    );

    // The note and its ref are still there: the corrective document is permanent.
    const survived = await db.creditNote.findUniqueOrThrow({
      where: { id: note.id },
      include: { refs: true },
    });
    expect(survived.refs).toHaveLength(1);
  });
});
